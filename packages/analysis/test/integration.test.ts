import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { GenerateObjectRequest, LlmProvider, LlmResult } from "@chitanda/llm";
import { analyzeCollectionRun } from "../src/index.js";

const databaseUrl = process.env.CHITANDA_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const userId = randomUUID();
const taskId = randomUUID();
const itemId = randomUUID();
const versionOneId = randomUUID();
const versionTwoId = randomUUID();
const firstRunId = randomUUID();
const secondRunId = randomUUID();
const testProvider: LlmProvider = {
  id: "test",
  async generateObject<T>(request: GenerateObjectRequest<T>): Promise<LlmResult<T>> {
    return {
      value: request.schema.parse({
        matched: true,
        score: 0.95,
        reason: "The ticket price is now below the configured threshold.",
        facts: [{ name: "price", value: "2500 TWD", confidence: 1 }],
        summary: "Concert tickets are available for 2500 TWD.",
        uncertainties: [],
        evidence: [{ sourceField: "content", quote: "Ticket price 2500" }]
      }),
      provider: "test",
      model: request.model
    };
  }
};
const providers = new Map([[testProvider.id, testProvider]]);

function record(price: number) {
  return {
    externalId: "phase3-concert",
    canonicalUrl: "https://events.example/phase3-concert",
    title: "Phase 3 Concert",
    content: `Ticket price ${price}`,
    author: null,
    publishedAt: "2026-09-19T10:00:00.000Z",
    language: "en",
    media: [],
    metadata: { price, currency: "TWD" },
    rawPayload: { price }
  };
}

integration("analysis PostgreSQL event state machine", () => {
  beforeAll(async () => {
    await pool!.query(
      `insert into users (id, email, display_name, password_hash, role)
       values ($1, $2, 'Analysis Integration', 'not-used', 'admin')`,
      [userId, `${userId}@example.invalid`]
    );
    await pool!.query(
      "insert into tasks (id, owner_user_id, name, status) values ($1, $2, 'Analysis', 'active')",
      [taskId, userId]
    );
    await pool!.query(
      `insert into task_revisions
        (task_id, revision, original_request, definition, summary, confidence,
         llm_provider, llm_model, prompt_version, created_by_user_id)
       values ($1, 1, 'tickets below 3000', $2::jsonb, 'fixture', '1',
         'test', 'test', 'test-v1', $3)`,
      [
        taskId,
        JSON.stringify({
          schemaVersion: 1,
          name: "Analysis",
          intent: "Notify when ticket price drops to 3000 TWD or less",
          locale: "en",
          timezone: "UTC",
          topics: ["concert"],
          entities: [],
          sources: [{ connectorId: "manual", query: { fixture: true } }],
          filters: {
            all: [{ field: "price", operator: "lte", value: 3000, unit: "TWD" }],
            any: [],
            none: []
          },
          monitor: {
            schedule: { type: "interval", value: "PT1H" },
            eventTypes: ["content_changed", "threshold_crossed"],
            lookback: null
          },
          analysis: { semanticMatch: true, minimumScore: 0.7, extractionFields: ["price"] },
          delivery: [{ channel: "in_app", mode: "store_only", minimumSeverity: "normal" }]
        }),
        userId
      ]
    );
    await pool!.query(
      `insert into source_items
        (id, connector_id, source_key, external_id, canonical_url, title, content,
         current_version, metadata)
       values ($1, 'manual', 'analysis-fixture', 'phase3-concert',
         'https://events.example/phase3-concert', 'Phase 3 Concert', 'Ticket price 2500', 2,
         '{"price":2500,"currency":"TWD"}'::jsonb)`,
      [itemId]
    );
    await pool!.query(
      `insert into source_item_versions
        (id, source_item_id, version, content_hash, normalized, raw_payload)
       values ($1, $3, 1, 'analysis-v1', $4::jsonb, '{}'::jsonb),
              ($2, $3, 2, 'analysis-v2', $5::jsonb, '{}'::jsonb)`,
      [
        versionOneId,
        versionTwoId,
        itemId,
        JSON.stringify(record(4000)),
        JSON.stringify(record(2500))
      ]
    );
    await pool!.query(
      `insert into collection_runs (id, task_id, task_revision, trigger, status, dedupe_key)
       values ($1, $3, 1, 'manual', 'succeeded', $4),
              ($2, $3, 1, 'manual', 'succeeded', $5)`,
      [firstRunId, secondRunId, taskId, `analysis:${firstRunId}`, `analysis:${secondRunId}`]
    );
    await pool!.query(
      `insert into task_run_items (run_id, source_item_id, source_item_version_id, outcome)
       values ($1, $3, $4, 'new'), ($2, $3, $5, 'updated')`,
      [firstRunId, secondRunId, itemId, versionOneId, versionTwoId]
    );
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      await pool.query("delete from tasks where id = $1", [taskId]);
      await pool.query("delete from source_items where id = $1", [itemId]);
      await pool.query("delete from users where id = $1", [userId]);
    } finally {
      await pool.end();
    }
  });

  it("creates threshold and change events once when a value crosses the filter", async () => {
    const first = await analyzeCollectionRun(pool!, providers, {
      runId: firstRunId,
      taskId
    });
    const second = await analyzeCollectionRun(pool!, providers, {
      runId: secondRunId,
      taskId
    });
    const replay = await analyzeCollectionRun(pool!, providers, {
      runId: secondRunId,
      taskId
    });
    const events = await pool!.query<{ event_type: string }>(
      "select event_type from events where task_id = $1 order by event_type",
      [taskId]
    );

    expect(first).toMatchObject({ candidates: 1, matched: 0, events: 0 });
    expect(second).toMatchObject({ candidates: 1, matched: 1, events: 2 });
    expect(replay).toMatchObject({ candidates: 1, matched: 1, events: 2 });
    expect(events.rows.map((event) => event.event_type)).toEqual([
      "content_changed",
      "threshold_crossed"
    ]);
  });
});
