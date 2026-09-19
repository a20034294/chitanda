import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { connectorSourceKey, type SourceConnector } from "@chitanda/connectors";
import { collectTaskRun } from "../src/index.js";

const databaseUrl = process.env.CHITANDA_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const userId = randomUUID();
const taskId = randomUUID();
const externalId = `integration-${randomUUID()}`;
const query = { fixture: externalId };
const record = {
  externalId,
  canonicalUrl: `https://events.example/${externalId}`,
  title: "Fixture concert",
  content: "Tickets available",
  author: null,
  publishedAt: "2026-09-19T10:00:00.000Z",
  language: "en",
  media: [],
  metadata: {},
  rawPayload: { source: "fixture" }
};
const fixtureConnector: SourceConnector = {
  id: "json_api",
  mode: "pull",
  collect: async ({ cursor }) => ({
    records: [record],
    cursor: { ...cursor, data: { page: 1 } },
    notModified: false,
    rejectedCount: 0
  })
};
const connectors = new Map([[fixtureConnector.id, fixtureConnector]]);

async function createRun(): Promise<string> {
  const runId = randomUUID();
  await pool!.query(
    `insert into collection_runs (id, task_id, trigger, status, dedupe_key)
     values ($1, $2, 'manual', 'queued', $3)`,
    [runId, taskId, `integration:${runId}`]
  );
  return runId;
}

integration("collection PostgreSQL idempotency", () => {
  beforeAll(async () => {
    await pool!.query(
      `insert into users (id, email, display_name, password_hash, role)
       values ($1, $2, 'Integration', 'not-used', 'admin')`,
      [userId, `${userId}@example.invalid`]
    );
    await pool!.query(
      "insert into tasks (id, owner_user_id, name, status) values ($1, $2, 'Integration', 'active')",
      [taskId, userId]
    );
    await pool!.query(
      `insert into task_revisions
        (task_id, revision, original_request, definition, summary, confidence,
         llm_provider, llm_model, prompt_version, created_by_user_id)
       values ($1, 1, 'integration fixture', $2::jsonb, 'fixture', '1',
         'test', 'test', 'test-v1', $3)`,
      [
        taskId,
        JSON.stringify({
          schemaVersion: 1,
          name: "Integration",
          intent: "Test idempotent JSON collection",
          locale: "en",
          timezone: "UTC",
          topics: ["test"],
          entities: [],
          sources: [{ connectorId: "json_api", query }],
          filters: { all: [], any: [], none: [] },
          monitor: {
            schedule: { type: "interval", value: "PT1H" },
            eventTypes: ["new_item"],
            lookback: null
          },
          analysis: { semanticMatch: false, minimumScore: 0, extractionFields: [] },
          delivery: [{ channel: "in_app", mode: "store_only", minimumSeverity: "normal" }]
        }),
        userId
      ]
    );
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      // Delete the task explicitly before its creator because the creator FK is RESTRICT.
      await pool.query("delete from tasks where id = $1", [taskId]);
      await pool.query(
        "delete from source_items where connector_id = 'json_api' and source_key = $1 and external_id = $2",
        [connectorSourceKey("json_api", query), externalId]
      );
      await pool.query("delete from users where id = $1", [userId]);
    } finally {
      await pool.end();
    }
  });

  it("does not duplicate an item or version when the same fixture is ingested twice", async () => {
    const firstRun = await createRun();
    const firstStats = await collectTaskRun(pool!, connectors, {
      runId: firstRun,
      taskId,
      attempt: 1
    });

    const secondRun = await createRun();
    const secondStats = await collectTaskRun(pool!, connectors, {
      runId: secondRun,
      taskId,
      attempt: 1
    });

    const counts = await pool!.query<{ items: number; versions: number }>(
      `select count(distinct si.id)::int as items, count(siv.id)::int as versions
         from source_items si join source_item_versions siv on siv.source_item_id = si.id
        where si.connector_id = 'json_api' and si.source_key = $1 and si.external_id = $2`,
      [connectorSourceKey("json_api", query), externalId]
    );
    expect(firstStats).toMatchObject({ created: 1, updated: 0, unchanged: 0 });
    expect(secondStats).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    expect(counts.rows[0]).toEqual({ items: 1, versions: 1 });
  });
});
