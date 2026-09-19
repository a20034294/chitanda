import { createHash } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import type { Pool, PoolClient } from "pg";
import {
  taskDefinitionV1Schema,
  type NormalizedSourceRecord,
  type TaskDefinitionV1
} from "@chitanda/contracts";
import {
  ConnectorError,
  connectorSourceKey,
  type ConnectorCursor,
  type ConnectorQuery,
  type SourceConnector
} from "@chitanda/connectors";

export type CollectionOutcome = "new" | "updated" | "unchanged";

export type CollectionStats = {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  rejected: number;
};

type RunRow = {
  id: string;
  task_id: string;
  task_revision: number | null;
  status: string;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function normalizedRecordHash(record: NormalizedSourceRecord): string {
  const content = {
    canonicalUrl: record.canonicalUrl,
    title: record.title,
    content: record.content,
    author: record.author,
    publishedAt: record.publishedAt,
    language: record.language,
    media: record.media,
    metadata: record.metadata
  };
  return createHash("sha256").update(stableJson(content)).digest("base64url");
}

function fallbackExternalId(record: NormalizedSourceRecord): string {
  if (record.externalId) return record.externalId;
  if (record.canonicalUrl) return record.canonicalUrl;
  return createHash("sha256")
    .update(`${record.title}\0${record.publishedAt ?? ""}`)
    .digest("base64url");
}

async function persistRecord(
  client: PoolClient,
  input: {
    runId: string;
    connectorId: string;
    sourceKey: string;
    record: NormalizedSourceRecord;
  }
): Promise<CollectionOutcome> {
  const { runId, connectorId, sourceKey, record } = input;
  const externalId = fallbackExternalId(record);
  const contentHash = normalizedRecordHash(record);
  await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    stableJson([connectorId, sourceKey, externalId])
  ]);
  const existing = await client.query<{ id: string; current_version: number }>(
    `select id, current_version from source_items
      where connector_id = $1 and source_key = $2 and external_id = $3
      for update`,
    [connectorId, sourceKey, externalId]
  );
  let itemId: string;
  let itemVersionId: string;
  let outcome: CollectionOutcome;
  if (!existing.rows[0]) {
    const inserted = await client.query<{ id: string }>(
      `insert into source_items
        (connector_id, source_key, external_id, canonical_url, title, content, author,
         published_at, language, current_version, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10::jsonb)
       returning id`,
      [
        connectorId,
        sourceKey,
        externalId,
        record.canonicalUrl,
        record.title,
        record.content,
        record.author,
        record.publishedAt,
        record.language,
        stableJson(record.metadata)
      ]
    );
    itemId = inserted.rows[0]!.id;
    const version = await client.query<{ id: string }>(
      `insert into source_item_versions
        (source_item_id, version, content_hash, normalized, raw_payload)
       values ($1, 1, $2, $3::jsonb, $4::jsonb) returning id`,
      [itemId, contentHash, stableJson(record), stableJson(record.rawPayload ?? null)]
    );
    itemVersionId = version.rows[0]!.id;
    outcome = "new";
  } else {
    itemId = existing.rows[0].id;
    const seen = await client.query<{ id: string }>(
      "select id from source_item_versions where source_item_id = $1 and content_hash = $2",
      [itemId, contentHash]
    );
    if (seen.rows[0]) {
      itemVersionId = seen.rows[0].id;
      await client.query("update source_items set last_seen_at = now() where id = $1", [itemId]);
      outcome = "unchanged";
    } else {
      const version = existing.rows[0].current_version + 1;
      await client.query(
        `update source_items set canonical_url = $1, title = $2, content = $3, author = $4,
           published_at = $5, language = $6, current_version = $7, metadata = $8::jsonb,
           last_seen_at = now()
         where id = $9`,
        [
          record.canonicalUrl,
          record.title,
          record.content,
          record.author,
          record.publishedAt,
          record.language,
          version,
          stableJson(record.metadata),
          itemId
        ]
      );
      const insertedVersion = await client.query<{ id: string }>(
        `insert into source_item_versions
          (source_item_id, version, content_hash, normalized, raw_payload)
         values ($1, $2, $3, $4::jsonb, $5::jsonb) returning id`,
        [itemId, version, contentHash, stableJson(record), stableJson(record.rawPayload ?? null)]
      );
      itemVersionId = insertedVersion.rows[0]!.id;
      outcome = "updated";
    }
  }
  await client.query(
    `insert into task_run_items (run_id, source_item_id, source_item_version_id, outcome)
     values ($1, $2, $3, $4)
     on conflict (run_id, source_item_id) do update
       set source_item_version_id = excluded.source_item_version_id, outcome = excluded.outcome`,
    [runId, itemId, itemVersionId, outcome]
  );
  return outcome;
}

export async function ingestRecords(
  pool: Pool,
  input: {
    runId: string;
    connectorId: string;
    query: ConnectorQuery;
    records: NormalizedSourceRecord[];
  }
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const sourceKey = connectorSourceKey(input.connectorId, input.query);
    for (const record of input.records) {
      await persistRecord(client, { ...input, sourceKey, record });
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function updateRunCounts(
  pool: Pool,
  runId: string,
  rejectedCount: number
): Promise<CollectionStats> {
  const result = await pool.query<{
    fetched: number;
    created: number;
    updated: number;
    unchanged: number;
  }>(
    `select count(*)::int as fetched,
            count(*) filter (where outcome = 'new')::int as created,
            count(*) filter (where outcome = 'updated')::int as updated,
            count(*) filter (where outcome = 'unchanged')::int as unchanged
       from task_run_items where run_id = $1`,
    [runId]
  );
  const row = result.rows[0] ?? { fetched: 0, created: 0, updated: 0, unchanged: 0 };
  const stats = { ...row, rejected: rejectedCount };
  await pool.query(
    `update collection_runs set fetched_count = $1, new_count = $2, updated_count = $3,
       unchanged_count = $4, rejected_count = $5 where id = $6`,
    [stats.fetched, stats.created, stats.updated, stats.unchanged, stats.rejected, runId]
  );
  return stats;
}

export async function completeIngestRun(
  pool: Pool,
  runId: string,
  rejectedCount = 0
): Promise<CollectionStats> {
  const stats = await updateRunCounts(pool, runId, rejectedCount);
  await pool.query(
    `update collection_runs set status = 'succeeded', finished_at = now(),
       error_code = null, error_message = null where id = $1`,
    [runId]
  );
  return stats;
}

export async function collectTaskRun(
  pool: Pool,
  connectors: Map<string, SourceConnector>,
  input: { runId: string; taskId: string; attempt: number; signal?: AbortSignal }
): Promise<CollectionStats> {
  const run = await pool.query<RunRow>(
    "select id, task_id, task_revision, status from collection_runs where id = $1 and task_id = $2",
    [input.runId, input.taskId]
  );
  if (!run.rows[0]) throw new Error("Collection run not found");
  if (run.rows[0].status === "succeeded") {
    return updateRunCounts(pool, input.runId, 0);
  }
  await pool.query(
    `update collection_runs set status = 'running', attempt = $1,
       started_at = coalesce(started_at, now()), error_code = null, error_message = null
     where id = $2`,
    [input.attempt, input.runId]
  );
  const task = await pool.query<{ definition: unknown }>(
    `select r.definition from tasks t
       join task_revisions r on r.task_id = t.id
         and r.revision = coalesce($2, t.current_revision)
      where t.id = $1`,
    [input.taskId, run.rows[0].task_revision]
  );
  if (!task.rows[0]) throw new Error("Task not found");
  const definition = taskDefinitionV1Schema.parse(task.rows[0].definition);
  let rejectedCount = 0;
  for (const [sourceIndex, source] of definition.sources.entries()) {
    const connector = connectors.get(source.connectorId);
    if (!connector) {
      throw new ConnectorError(
        "unsupported_connector",
        `Connector is not installed: ${source.connectorId}`
      );
    }
    const cursorResult = await pool.query<{
      cursor: Record<string, unknown>;
      etag: string | null;
      last_modified: string | null;
    }>(
      `select cursor, etag, last_modified from connector_cursors
        where task_id = $1 and source_index = $2`,
      [input.taskId, sourceIndex]
    );
    const stored = cursorResult.rows[0];
    const cursor: ConnectorCursor = { data: stored?.cursor ?? {} };
    if (stored?.etag) cursor.etag = stored.etag;
    if (stored?.last_modified) cursor.lastModified = stored.last_modified;
    const collectRequest = { query: source.query, cursor } as {
      query: ConnectorQuery;
      cursor: ConnectorCursor;
      signal?: AbortSignal;
    };
    if (input.signal) collectRequest.signal = input.signal;
    const result = await connector.collect(collectRequest);
    rejectedCount += result.rejectedCount;
    await ingestRecords(pool, {
      runId: input.runId,
      connectorId: source.connectorId,
      query: source.query,
      records: result.records
    });
    await pool.query(
      `insert into connector_cursors
        (task_id, source_index, connector_id, cursor, etag, last_modified, last_succeeded_at)
       values ($1, $2, $3, $4::jsonb, $5, $6, now())
       on conflict (task_id, source_index) do update set connector_id = excluded.connector_id,
         cursor = excluded.cursor, etag = excluded.etag, last_modified = excluded.last_modified,
         last_succeeded_at = now(), updated_at = now()`,
      [
        input.taskId,
        sourceIndex,
        source.connectorId,
        stableJson(result.cursor.data),
        result.cursor.etag ?? null,
        result.cursor.lastModified ?? null
      ]
    );
  }
  return completeIngestRun(pool, input.runId, rejectedCount);
}

export async function markRunFailure(
  pool: Pool,
  input: {
    runId: string;
    error: unknown;
    attempt: number;
    maxAttempts: number;
    terminalStatus?: "failed" | "dead_letter";
  }
): Promise<void> {
  const finalAttempt = input.attempt >= input.maxAttempts;
  const terminalStatus = input.terminalStatus ?? "dead_letter";
  const code = input.error instanceof ConnectorError ? input.error.code : "collection_failed";
  const message = (input.error instanceof Error ? input.error.message : "Collection failed").slice(
    0,
    1000
  );
  await pool.query(
    `update collection_runs set status = $1, attempt = $2, error_code = $3, error_message = $4,
       finished_at = case when $1 in ('failed', 'dead_letter') then now() else null end where id = $5`,
    [finalAttempt ? terminalStatus : "retrying", input.attempt, code, message, input.runId]
  );
}

export function intervalMilliseconds(value: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
  if (!match) throw new Error(`Unsupported ISO 8601 interval: ${value}`);
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  const result =
    Number(days) * 86_400_000 +
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1000;
  if (!Number.isFinite(result) || result < 60_000)
    throw new Error("Schedule interval must be at least one minute");
  return result;
}

export function isScheduleDue(
  schedule: TaskDefinitionV1["monitor"]["schedule"],
  timezone: string,
  lastRunAt: Date | null,
  now = new Date()
): boolean {
  if (!lastRunAt) return true;
  if (schedule.type === "interval") {
    return lastRunAt.getTime() + intervalMilliseconds(schedule.value) <= now.getTime();
  }
  const expression = CronExpressionParser.parse(schedule.value, {
    currentDate: lastRunAt,
    tz: timezone
  });
  return expression.next().toDate().getTime() <= now.getTime();
}
