import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { loadConfig } from "@chitanda/config";
import {
  createPendingEmailDeliveries,
  deliverEmail,
  dueEmailDeliveryIds,
  type EmailMessage,
  type EmailProvider
} from "../src/index.js";

const databaseUrl = process.env.CHITANDA_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const defaultPath = new URL("../../../config/default.yaml", import.meta.url).pathname;
const userId = randomUUID();
const taskId = randomUUID();
const runId = randomUUID();
const itemId = randomUUID();
const versionId = randomUUID();
const candidateId = randomUUID();
const analysisId = randomUUID();
const eventId = randomUUID();

integration("email delivery pipeline", () => {
  beforeAll(async () => {
    await pool!.query(
      `insert into users (id, email, display_name, password_hash, role)
       values ($1, $2, 'Notification Integration', 'not-used', 'admin')`,
      [userId, `${userId}@example.invalid`]
    );
    await pool!.query(
      "insert into tasks (id, owner_user_id, name, status) values ($1, $2, 'Singapore concerts', 'active')",
      [taskId, userId]
    );
    await pool!.query(
      `insert into task_revisions
        (task_id, revision, original_request, definition, summary, confidence,
         llm_provider, llm_model, prompt_version, created_by_user_id)
       values ($1, 1, 'Singapore concerts', $2::jsonb, 'fixture', '1',
         'test', 'test', 'test-v1', $3)`,
      [
        taskId,
        JSON.stringify({
          schemaVersion: 1,
          name: "Singapore concerts",
          intent: "Notify me about concerts in Singapore",
          locale: "en-SG",
          timezone: "Asia/Singapore",
          topics: ["concert"],
          entities: [],
          sources: [{ connectorId: "manual", query: { fixture: true } }],
          filters: { all: [], any: [], none: [] },
          monitor: {
            schedule: { type: "interval", value: "PT1H" },
            eventTypes: ["new_item"],
            lookback: null
          },
          analysis: { semanticMatch: false, minimumScore: 0.7, extractionFields: [] },
          delivery: [
            { channel: "in_app", mode: "store_only", minimumSeverity: "normal" },
            { channel: "email", mode: "immediate", minimumSeverity: "normal" }
          ]
        }),
        userId
      ]
    );
    await pool!.query(
      `insert into collection_runs (id, task_id, task_revision, trigger, status, dedupe_key)
       values ($1, $2, 1, 'manual', 'succeeded', $3)`,
      [runId, taskId, `notification:${runId}`]
    );
    const record = {
      externalId: "sg-concert",
      canonicalUrl: "https://events.example/sg-concert",
      title: "Singapore Concert",
      content: "Tickets on sale",
      author: null,
      publishedAt: null,
      language: "en-SG",
      media: [],
      metadata: {},
      rawPayload: {}
    };
    await pool!.query(
      `insert into source_items
        (id, connector_id, source_key, external_id, canonical_url, title, content, metadata)
       values ($1, 'manual', 'notification-fixture', 'sg-concert',
         'https://events.example/sg-concert', 'Singapore Concert', 'Tickets on sale', '{}'::jsonb)`,
      [itemId]
    );
    await pool!.query(
      `insert into source_item_versions
        (id, source_item_id, version, content_hash, normalized, raw_payload)
       values ($1, $2, 1, 'notification-v1', $3::jsonb, '{}'::jsonb)`,
      [versionId, itemId, JSON.stringify(record)]
    );
    await pool!.query(
      `insert into task_candidates
        (id, task_id, source_item_id, source_item_version_id, collection_run_id,
         collection_outcome, status, deterministic_matched, effective_matched)
       values ($1, $2, $3, $4, $5, 'new', 'succeeded', true, true)`,
      [candidateId, taskId, itemId, versionId, runId]
    );
    await pool!.query(
      `insert into analysis_results
        (id, candidate_id, matched, score_basis_points, reason, summary, provider, model,
         prompt_version, input_hash)
       values ($1, $2, true, 10000, 'matched', 'Tickets on sale', 'test', 'test',
         'test-v1', 'notification-input')`,
      [analysisId, candidateId]
    );
    await pool!.query(
      `insert into events
        (id, task_id, source_item_id, source_item_version_id, analysis_result_id, event_type,
         fingerprint, title, summary, reason)
       values ($1, $2, $3, $4, $5, 'new_item', $6, 'Singapore Concert',
         'Tickets on sale', 'matched')`,
      [eventId, taskId, itemId, versionId, analysisId, `notification:${eventId}`]
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

  it("creates and sends only one delivery when scheduling and processing are replayed", async () => {
    const base = await loadConfig({ defaultPath });
    const config = {
      ...base,
      notifications: {
        ...base.notifications,
        quietHours: { ...base.notifications.quietHours, enabled: false },
        email: { ...base.notifications.email, enabled: true }
      }
    };
    const now = new Date(Date.now() - 60_000);
    expect(await createPendingEmailDeliveries(pool!, config, now)).toBe(1);
    expect(await createPendingEmailDeliveries(pool!, config, now)).toBe(0);
    const ids = await dueEmailDeliveryIds(pool!, now);
    expect(ids).toHaveLength(1);

    const sent: EmailMessage[] = [];
    let attempts = 0;
    const provider: EmailProvider = {
      async send(message) {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary SMTP failure");
        sent.push(message);
        return { messageId: "test-message" };
      }
    };
    expect(
      await deliverEmail(pool!, provider, {
        deliveryId: ids[0]!,
        attempt: 1,
        maxAttempts: 5,
        publicBaseUrl: "https://chitanda.example"
      })
    ).toBe("retrying");
    expect(
      await deliverEmail(pool!, provider, {
        deliveryId: ids[0]!,
        attempt: 2,
        maxAttempts: 5,
        publicBaseUrl: "https://chitanda.example"
      })
    ).toBe("delivered");
    expect(
      await deliverEmail(pool!, provider, {
        deliveryId: ids[0]!,
        attempt: 2,
        maxAttempts: 5,
        publicBaseUrl: "https://chitanda.example"
      })
    ).toBe("skipped");
    expect(attempts).toBe(2);
    expect(sent).toHaveLength(1);
  });
});
