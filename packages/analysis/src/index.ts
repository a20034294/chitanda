import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  contentAnalysisSchema,
  normalizedSourceRecordSchema,
  taskDefinitionV1Schema,
  type ContentAnalysis,
  type NormalizedSourceRecord,
  type TaskDefinitionV1
} from "@chitanda/contracts";
import {
  analyzeContent,
  CONTENT_ANALYSIS_PROMPT_VERSION,
  type LlmProvider,
  type LlmResult
} from "@chitanda/llm";

type Condition = TaskDefinitionV1["filters"]["all"][number];

export type ConditionEvaluation = {
  field: string;
  operator: Condition["operator"];
  expected: Condition["value"];
  actual: unknown;
  matched: boolean;
  reason: string;
};

export type FilterEvaluation = {
  matched: boolean;
  all: ConditionEvaluation[];
  any: ConditionEvaluation[];
  none: ConditionEvaluation[];
};

export type AnalysisStats = { candidates: number; matched: number; events: number };

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

function lookupField(record: NormalizedSourceRecord, field: string): unknown {
  const topLevel = record as unknown as Record<string, unknown>;
  if (field in topLevel) return topLevel[field];
  const path = field.startsWith("metadata.") ? field.slice(9) : field;
  return path.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, record.metadata);
}

function normalizedText(value: unknown): string {
  if (typeof value === "string") return value.trim().toLocaleLowerCase();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function values(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function epoch(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeRegex(pattern: string): RegExp | null {
  if (
    pattern.length > 200 ||
    /\\[1-9]/.test(pattern) ||
    /\(\?<([=!])/.test(pattern) ||
    /\([^)]*[+*][^)]*\)[+*{]/.test(pattern)
  ) {
    return null;
  }
  try {
    return new RegExp(pattern, "iu");
  } catch {
    return null;
  }
}

function unitMatches(record: NormalizedSourceRecord, condition: Condition): boolean {
  if (!condition.unit) return true;
  const metadata = record.metadata;
  const candidates = [
    metadata[`${condition.field}Unit`],
    metadata.unit,
    metadata.currency,
    metadata.priceCurrency
  ].filter((value) => value !== undefined);
  return (
    candidates.length === 0 ||
    candidates.some((value) => normalizedText(value) === normalizedText(condition.unit))
  );
}

export function evaluateCondition(
  condition: Condition,
  record: NormalizedSourceRecord
): ConditionEvaluation {
  const actual = lookupField(record, condition.field);
  const expected = condition.value;
  let matched = false;
  let reason = "condition_not_met";
  if (!unitMatches(record, condition)) {
    reason = "unit_mismatch";
  } else if (actual === undefined || actual === null) {
    reason = "field_missing";
  } else {
    const actualValues = values(actual);
    switch (condition.operator) {
      case "equals":
        matched = actualValues.some((value) => normalizedText(value) === normalizedText(expected));
        break;
      case "contains":
        matched = actualValues.some((value) =>
          normalizedText(value).includes(normalizedText(expected))
        );
        break;
      case "in": {
        const expectedValues = values(expected).map(normalizedText);
        matched = actualValues.some((value) => expectedValues.includes(normalizedText(value)));
        break;
      }
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        const left = numeric(actualValues[0]);
        const right = numeric(expected);
        if (left !== null && right !== null) {
          if (condition.operator === "lt") matched = left < right;
          if (condition.operator === "lte") matched = left <= right;
          if (condition.operator === "gt") matched = left > right;
          if (condition.operator === "gte") matched = left >= right;
        } else reason = "not_numeric";
        break;
      }
      case "between": {
        const range = Array.isArray(expected) ? expected : [];
        const left = numeric(actualValues[0]);
        const minimum = numeric(range[0]);
        const maximum = numeric(range[1]);
        if (left !== null && minimum !== null && maximum !== null) {
          matched = left >= minimum && left <= maximum;
        } else reason = "invalid_range";
        break;
      }
      case "before":
      case "after": {
        const left = epoch(actualValues[0]);
        const right = epoch(expected);
        if (left !== null && right !== null) {
          matched = condition.operator === "before" ? left < right : left > right;
        } else reason = "invalid_date";
        break;
      }
      case "regex": {
        const regex = safeRegex(String(expected));
        if (regex) matched = actualValues.some((value) => regex.test(String(value)));
        else reason = "unsafe_or_invalid_regex";
        break;
      }
    }
    if (matched) reason = "condition_met";
  }
  return {
    field: condition.field,
    operator: condition.operator,
    expected,
    actual: actual ?? null,
    matched,
    reason
  };
}

export function evaluateFilters(
  filters: TaskDefinitionV1["filters"],
  record: NormalizedSourceRecord
): FilterEvaluation {
  const all = filters.all.map((condition) => evaluateCondition(condition, record));
  const any = filters.any.map((condition) => evaluateCondition(condition, record));
  const none = filters.none.map((condition) => evaluateCondition(condition, record));
  return {
    matched:
      all.every((result) => result.matched) &&
      (any.length === 0 || any.some((result) => result.matched)) &&
      none.every((result) => !result.matched),
    all,
    any,
    none
  };
}

function flattenedRecord(record: NormalizedSourceRecord): Record<string, unknown> {
  return {
    canonicalUrl: record.canonicalUrl,
    title: record.title,
    content: record.content,
    author: record.author,
    publishedAt: record.publishedAt,
    language: record.language,
    ...Object.fromEntries(
      Object.entries(record.metadata).map(([key, value]) => [`metadata.${key}`, value])
    )
  };
}

export function changedRecordFields(
  previous: NormalizedSourceRecord | null,
  current: NormalizedSourceRecord
): string[] {
  if (!previous) return [];
  const before = flattenedRecord(previous);
  const after = flattenedRecord(current);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => stableJson(before[key]) !== stableJson(after[key]))
    .sort();
}

function deterministicAnalysis(
  matched: boolean,
  evaluation: FilterEvaluation,
  record: NormalizedSourceRecord
): ContentAnalysis {
  const evidence = [...evaluation.all, ...evaluation.any]
    .filter((entry) => entry.matched && entry.actual !== null)
    .slice(0, 20)
    .map((entry) => ({ sourceField: entry.field, quote: String(entry.actual).slice(0, 500) }));
  const facts = Object.entries(record.metadata)
    .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 50)
    .map(([name, value]) => ({ name, value: String(value), confidence: 1 }));
  return contentAnalysisSchema.parse({
    matched,
    score: matched ? 1 : 0,
    reason: matched
      ? "All deterministic filter groups passed."
      : "One or more deterministic filter groups did not pass.",
    facts,
    summary: (record.content || record.title).slice(0, 4000),
    uncertainties: [],
    evidence
  });
}

function eventTypesFor(input: {
  definition: TaskDefinitionV1;
  outcome: string;
  effectiveMatched: boolean;
  previousMatched: boolean | null;
  changedFields: string[];
}): string[] {
  if (!input.effectiveMatched) return [];
  const configured = new Set(input.definition.monitor.eventTypes);
  const output: string[] = [];
  if (input.outcome === "new" && configured.has("new_item")) output.push("new_item");
  if (input.outcome === "updated" && configured.has("content_changed")) {
    output.push("content_changed");
  }
  if (
    input.outcome === "updated" &&
    input.changedFields.length > 0 &&
    configured.has("field_changed")
  ) {
    output.push("field_changed");
  }
  if (input.previousMatched === false && configured.has("threshold_crossed")) {
    output.push("threshold_crossed");
  }
  if (
    input.previousMatched === false &&
    configured.has("back_in_stock") &&
    input.changedFields.some((field) => /stock|availability/i.test(field))
  ) {
    output.push("back_in_stock");
  }
  return output;
}

type RunItemRow = {
  source_item_id: string;
  source_item_version_id: string;
  version: number;
  outcome: string;
  normalized: unknown;
  content_hash: string;
};

async function previousRecord(pool: Pool, row: RunItemRow): Promise<NormalizedSourceRecord | null> {
  const result = await pool.query<{ normalized: unknown }>(
    `select normalized from source_item_versions
      where source_item_id = $1 and version < $2 order by version desc limit 1`,
    [row.source_item_id, row.version]
  );
  return result.rows[0] ? normalizedSourceRecordSchema.parse(result.rows[0].normalized) : null;
}

async function persistAnalysis(
  client: PoolClient,
  input: {
    candidateId: string;
    taskId: string;
    itemId: string;
    itemVersionId: string;
    record: NormalizedSourceRecord;
    outcome: string;
    definition: TaskDefinitionV1;
    filterEvaluation: FilterEvaluation;
    changedFields: string[];
    result: LlmResult<ContentAnalysis>;
    promptVersion: string;
    inputHash: string;
  }
): Promise<number> {
  const effectiveMatched =
    input.result.value.matched &&
    input.result.value.score >= input.definition.analysis.minimumScore;
  const previous = await client.query<{ effective_matched: boolean }>(
    `select effective_matched from task_candidates
      where task_id = $1 and source_item_id = $2 and id <> $3
        and status = 'succeeded' and effective_matched is not null
      order by analyzed_at desc limit 1`,
    [input.taskId, input.itemId, input.candidateId]
  );
  const previousMatched = previous.rows[0]?.effective_matched ?? null;
  const analysis = await client.query<{ id: string }>(
    `insert into analysis_results
      (candidate_id, matched, score_basis_points, reason, facts, summary, uncertainties,
       evidence, provider, model, prompt_version, request_id, usage, input_hash)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12,
       $13::jsonb, $14)
     on conflict (candidate_id) do update set matched = excluded.matched,
       score_basis_points = excluded.score_basis_points, reason = excluded.reason,
       facts = excluded.facts, summary = excluded.summary, uncertainties = excluded.uncertainties,
       evidence = excluded.evidence, provider = excluded.provider, model = excluded.model,
       prompt_version = excluded.prompt_version, request_id = excluded.request_id,
       usage = excluded.usage, input_hash = excluded.input_hash
     returning id`,
    [
      input.candidateId,
      effectiveMatched,
      Math.round(input.result.value.score * 10_000),
      input.result.value.reason,
      stableJson(input.result.value.facts),
      input.result.value.summary,
      stableJson(input.result.value.uncertainties),
      stableJson(input.result.value.evidence),
      input.result.provider,
      input.result.model,
      input.promptVersion,
      input.result.requestId ?? null,
      stableJson(input.result.usage ?? {}),
      input.inputHash
    ]
  );
  await client.query(
    `update task_candidates set status = 'succeeded', deterministic_matched = $1,
       effective_matched = $2, filter_details = $3::jsonb, changed_fields = $4::jsonb,
       error_code = null, error_message = null, analyzed_at = now() where id = $5`,
    [
      input.filterEvaluation.matched,
      effectiveMatched,
      stableJson(input.filterEvaluation),
      stableJson(input.changedFields),
      input.candidateId
    ]
  );
  const eventTypes = eventTypesFor({
    definition: input.definition,
    outcome: input.outcome,
    effectiveMatched,
    previousMatched,
    changedFields: input.changedFields
  });
  let created = 0;
  for (const eventType of eventTypes) {
    const fingerprint = createHash("sha256")
      .update(stableJson([input.taskId, input.itemVersionId, eventType]))
      .digest("base64url");
    const event = await client.query(
      `insert into events
        (task_id, source_item_id, source_item_version_id, analysis_result_id, event_type,
         fingerprint, title, summary, reason, evidence, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, coalesce($11::timestamptz, now()))
       on conflict (fingerprint) do nothing`,
      [
        input.taskId,
        input.itemId,
        input.itemVersionId,
        analysis.rows[0]!.id,
        eventType,
        fingerprint,
        input.record.title,
        input.result.value.summary,
        input.result.value.reason,
        stableJson(input.result.value.evidence),
        input.record.publishedAt
      ]
    );
    created += event.rowCount ?? 0;
  }
  return created;
}

export async function analyzeCollectionRun(
  pool: Pool,
  providers: Map<string, LlmProvider>,
  input: { runId: string; taskId: string }
): Promise<AnalysisStats> {
  await pool.query(
    `update collection_runs set analysis_status = 'running', analysis_error_code = null,
       analysis_error_message = null where id = $1 and task_id = $2 and status = 'succeeded'`,
    [input.runId, input.taskId]
  );
  const task = await pool.query<{
    definition: unknown;
    llm_provider: string;
    llm_model: string;
  }>(
    `select r.definition, r.llm_provider, r.llm_model from tasks t
       join collection_runs cr on cr.task_id = t.id and cr.id = $2
       join task_revisions r on r.task_id = t.id
         and r.revision = coalesce(cr.task_revision, t.current_revision)
      where t.id = $1`,
    [input.taskId, input.runId]
  );
  if (!task.rows[0]) throw new Error("Task not found");
  const definition = taskDefinitionV1Schema.parse(task.rows[0].definition);
  const runItems = await pool.query<RunItemRow>(
    `select tri.source_item_id, tri.source_item_version_id, siv.version, tri.outcome,
            siv.normalized, siv.content_hash
       from task_run_items tri
       join source_item_versions siv on siv.id = tri.source_item_version_id
      where tri.run_id = $1 and tri.source_item_version_id is not null`,
    [input.runId]
  );
  let createdEvents = 0;
  for (const row of runItems.rows) {
    const candidateResult = await pool.query<{ id: string; status: string }>(
      `insert into task_candidates
        (task_id, source_item_id, source_item_version_id, collection_run_id, collection_outcome)
       values ($1, $2, $3, $4, $5)
       on conflict (task_id, source_item_version_id) do nothing returning id, status`,
      [input.taskId, row.source_item_id, row.source_item_version_id, input.runId, row.outcome]
    );
    const candidate =
      candidateResult.rows[0] ??
      (
        await pool.query<{ id: string; status: string }>(
          `select id, status from task_candidates
            where task_id = $1 and source_item_version_id = $2`,
          [input.taskId, row.source_item_version_id]
        )
      ).rows[0];
    if (!candidate || candidate.status === "succeeded") continue;
    const record = normalizedSourceRecordSchema.parse(row.normalized);
    const filterEvaluation = evaluateFilters(definition.filters, record);
    const changedFields = changedRecordFields(await previousRecord(pool, row), record);
    let result: LlmResult<ContentAnalysis>;
    let promptVersion = "deterministic-v1";
    if (!filterEvaluation.matched || !definition.analysis.semanticMatch) {
      result = {
        value: deterministicAnalysis(filterEvaluation.matched, filterEvaluation, record),
        provider: "deterministic",
        model: "rules-v1"
      };
    } else {
      const provider = providers.get(task.rows[0].llm_provider);
      if (!provider) throw new Error(`LLM provider is not available: ${task.rows[0].llm_provider}`);
      result = await analyzeContent(provider, {
        definition,
        record,
        model: task.rows[0].llm_model
      });
      promptVersion = CONTENT_ANALYSIS_PROMPT_VERSION;
    }
    const client = await pool.connect();
    try {
      await client.query("begin");
      createdEvents += await persistAnalysis(client, {
        candidateId: candidate.id,
        taskId: input.taskId,
        itemId: row.source_item_id,
        itemVersionId: row.source_item_version_id,
        record,
        outcome: row.outcome,
        definition,
        filterEvaluation,
        changedFields,
        result,
        promptVersion,
        inputHash: createHash("sha256")
          .update(stableJson([row.content_hash, definition.filters, definition.analysis]))
          .digest("base64url")
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  const counts = await pool.query<{ candidates: number; matched: number }>(
    `select count(*)::int as candidates,
            count(*) filter (where effective_matched)::int as matched
       from task_candidates where collection_run_id = $1`,
    [input.runId]
  );
  const stats = {
    candidates: counts.rows[0]?.candidates ?? 0,
    matched: counts.rows[0]?.matched ?? 0,
    events: createdEvents
  };
  await pool.query(
    `update collection_runs set analysis_status = 'succeeded', candidate_count = $1,
       event_count = (select count(*)::int from events e join analysis_results ar
         on ar.id = e.analysis_result_id join task_candidates tc on tc.id = ar.candidate_id
         where tc.collection_run_id = $2), analysis_error_code = null,
       analysis_error_message = null where id = $2`,
    [stats.candidates, input.runId]
  );
  const final = await pool.query<{ event_count: number }>(
    "select event_count from collection_runs where id = $1",
    [input.runId]
  );
  stats.events = final.rows[0]?.event_count ?? stats.events;
  return stats;
}

export async function markAnalysisFailure(
  pool: Pool,
  input: { runId: string; error: unknown; attempt: number; maxAttempts: number }
): Promise<void> {
  const terminal = input.attempt >= input.maxAttempts;
  const message = (input.error instanceof Error ? input.error.message : "Analysis failed").slice(
    0,
    1000
  );
  await pool.query(
    `update collection_runs set analysis_status = $1, analysis_error_code = 'analysis_failed',
       analysis_error_message = $2 where id = $3`,
    [terminal ? "dead_letter" : "retrying", message, input.runId]
  );
}
