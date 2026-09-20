import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import {
  createTaskRequestSchema,
  interpretTaskRequestSchema,
  manualIngestRequestSchema,
  taskDefinitionV1Schema,
  type TaskPreview
} from "@chitanda/contracts";
import { completeIngestRun, ingestRecords, markRunFailure } from "@chitanda/collection";
import { INTENT_PROMPT_VERSION, interpretTask } from "@chitanda/llm";
import { consumeRateLimit, requireAuth } from "./auth.js";
import { ApiError, type ApiDependencies, type AppVariables } from "./context.js";

const taskIdSchema = z.string().uuid();

function defaultModel(dependencies: ApiDependencies, provider: string): string {
  if (provider === "openai") return dependencies.config.llm.openai.model;
  if (provider === "ollama") return dependencies.config.llm.ollama.model;
  throw new ApiError(400, "unsupported_llm_provider");
}

export function registerTaskRoutes(
  app: Hono<{ Variables: AppVariables }>,
  dependencies: ApiDependencies
): void {
  const taskAuthentication = requireAuth(dependencies, { requireMfa: true, csrf: true });
  app.use("/api/tasks/*", taskAuthentication);
  app.use("/api/tasks", taskAuthentication);

  app.get("/api/connectors", requireAuth(dependencies, { requireMfa: true }), (context) =>
    context.json({
      connectors: [
        { id: "rss", name: "RSS / Atom", mode: "pull" },
        { id: "json_api", name: "Generic JSON API", mode: "pull" },
        {
          id: "search",
          name: "Brave Search API",
          mode: "pull",
          enabled: dependencies.config.acquisition.search.enabled
        },
        { id: "webpage", name: "Static webpage", mode: "pull", enabled: true },
        { id: "manual", name: "Manual ingest", mode: "push" },
        { id: "webhook", name: "Authenticated webhook ingest", mode: "push" }
      ]
    })
  );

  app.get("/api/tasks/templates/singapore-concerts", (context) => {
    const requestedProvider =
      context.req.query("provider") ?? dependencies.config.llm.defaultProvider;
    if (requestedProvider !== "ollama" && requestedProvider !== "openai") {
      throw new ApiError(400, "unsupported_llm_provider");
    }
    const definition = taskDefinitionV1Schema.parse({
      schemaVersion: 1,
      name: "新加坡演唱會",
      intent: "持續追蹤新加坡新公布的演唱會與售票資訊，發現新場次時通知我。",
      locale: "zh-TW",
      timezone: "Asia/Singapore",
      topics: ["concert", "live music", "ticket sales", "Singapore"],
      entities: [
        {
          type: "location",
          value: "Singapore",
          aliases: ["新加坡", "SG"]
        }
      ],
      sources: [
        {
          connectorId: "webpage",
          query: {
            url: "https://www.livenation.sg/",
            itemSelector: "a[href^='/event/']:not([href='/event/allevents'])",
            titleSelector: "h2, h3, h4",
            linkSelector: "a[href]",
            maxItems: 100
          }
        }
      ],
      filters: { all: [], any: [], none: [] },
      monitor: {
        schedule: { type: "interval", value: "PT6H" },
        eventTypes: ["new_item", "content_changed", "field_changed"],
        lookback: "P1Y"
      },
      analysis: {
        semanticMatch: true,
        minimumScore: 0.6,
        extractionFields: [
          "artist",
          "eventDate",
          "venue",
          "ticketPrice",
          "currency",
          "ticketStatus"
        ]
      },
      delivery: [
        { channel: "in_app", mode: "store_only", minimumSeverity: "normal" },
        { channel: "email", mode: "immediate", minimumSeverity: "normal" }
      ]
    });
    const preview: TaskPreview = {
      interpreted: {
        definition,
        summary:
          "每六小時檢查 Live Nation Singapore，發現新的新加坡演唱會時保存至 Inbox 並寄送 Email。",
        clarificationQuestions: [],
        warnings: dependencies.config.notifications.email.enabled
          ? ["靜態網頁版面變更時可能需要更新 CSS selector。"]
          : [
              "Email 目前未啟用；事件仍會保存在 Inbox。",
              "靜態網頁版面變更時可能需要更新 CSS selector。"
            ],
        confidence: 0.9
      },
      originalRequest: "追蹤新加坡演唱會；公布新場次時透過 Email 通知我。",
      provider: requestedProvider,
      model: defaultModel(dependencies, requestedProvider),
      promptVersion: "reference-template-sg-concert-v1"
    };
    return context.json(preview);
  });

  app.post("/api/tasks/interpret", async (context) => {
    let raw: unknown;
    try {
      raw = await context.req.json();
    } catch {
      throw new ApiError(400, "invalid_json");
    }
    const input = interpretTaskRequestSchema.parse(raw);
    const auth = context.get("auth");
    await consumeRateLimit(
      dependencies,
      "intent",
      auth.userId,
      dependencies.config.security.intentRateLimit
    );
    const providerId = input.provider ?? dependencies.config.llm.intentParser.provider;
    const provider = dependencies.providers.get(providerId);
    if (!provider) throw new ApiError(400, "unsupported_llm_provider");
    const model =
      input.model ??
      (input.provider
        ? defaultModel(dependencies, providerId)
        : dependencies.config.llm.intentParser.model);
    let result;
    try {
      result = await interpretTask(provider, {
        request: input.request,
        locale: input.locale,
        timezone: input.timezone,
        model
      });
    } catch (error) {
      console.error("Intent parsing failed", error);
      throw new ApiError(503, "llm_unavailable");
    }
    const preview: TaskPreview = {
      interpreted: result.value,
      originalRequest: input.request,
      provider: result.provider,
      model: result.model,
      promptVersion: INTENT_PROMPT_VERSION
    };
    if (result.requestId) preview.requestId = result.requestId;
    if (result.usage) preview.usage = result.usage;
    return context.json(preview);
  });

  app.post("/api/tasks", async (context) => {
    let raw: unknown;
    try {
      raw = await context.req.json();
    } catch {
      throw new ApiError(400, "invalid_json");
    }
    const input = createTaskRequestSchema.parse(raw);
    const auth = context.get("auth");
    const preview = input.preview;
    const definition = taskDefinitionV1Schema.parse(preview.interpreted.definition);
    const client = await dependencies.database.pool.connect();
    try {
      await client.query("begin");
      const taskResult = await client.query<{ id: string }>(
        `insert into tasks (owner_user_id, name, status, current_revision)
         values ($1, $2, 'draft', 1) returning id`,
        [auth.userId, definition.name]
      );
      const taskId = taskResult.rows[0]!.id;
      await client.query(
        `insert into task_revisions
          (task_id, revision, original_request, definition, summary, clarification_questions,
           warnings, confidence, llm_provider, llm_model, prompt_version, created_by_user_id)
         values ($1, 1, $2, $3::jsonb, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11)`,
        [
          taskId,
          preview.originalRequest,
          JSON.stringify(definition),
          preview.interpreted.summary,
          JSON.stringify(preview.interpreted.clarificationQuestions),
          JSON.stringify(preview.interpreted.warnings),
          String(preview.interpreted.confidence),
          preview.provider,
          preview.model,
          preview.promptVersion,
          auth.userId
        ]
      );
      await client.query(
        `insert into audit_logs (actor_user_id, action, target_type, target_id, request_id, metadata)
         values ($1, 'task.created', 'task', $2, $3, $4::jsonb)`,
        [auth.userId, taskId, context.get("requestId"), JSON.stringify({ revision: 1 })]
      );
      await client.query("commit");
      return context.json({ id: taskId, status: "draft", revision: 1 }, 201);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/api/tasks", async (context) => {
    const auth = context.get("auth");
    const result = await dependencies.database.pool.query(
      `select t.id, t.name, t.status, t.current_revision as "currentRevision",
              t.created_at as "createdAt", t.updated_at as "updatedAt",
              r.summary, r.clarification_questions as "clarificationQuestions",
              r.warnings, r.confidence, r.llm_provider as provider, r.llm_model as model,
              r.prompt_version as "promptVersion", r.definition
         from tasks t
         join task_revisions r on r.task_id = t.id and r.revision = t.current_revision
        where t.owner_user_id = $1
        order by t.updated_at desc`,
      [auth.userId]
    );
    return context.json({ tasks: result.rows });
  });

  app.put("/api/tasks/:id", async (context) => {
    const id = taskIdSchema.parse(context.req.param("id"));
    let raw: unknown;
    try {
      raw = await context.req.json();
    } catch {
      throw new ApiError(400, "invalid_json");
    }
    const input = createTaskRequestSchema.parse(raw);
    const auth = context.get("auth");
    const preview = input.preview;
    const definition = taskDefinitionV1Schema.parse(preview.interpreted.definition);
    const client = await dependencies.database.pool.connect();
    try {
      await client.query("begin");
      const current = await client.query<{ current_revision: number }>(
        "select current_revision from tasks where id = $1 and owner_user_id = $2 for update",
        [id, auth.userId]
      );
      const row = current.rows[0];
      if (!row) throw new ApiError(404, "task_not_found");
      const revision = row.current_revision + 1;
      await client.query(
        `insert into task_revisions
          (task_id, revision, original_request, definition, summary, clarification_questions,
           warnings, confidence, llm_provider, llm_model, prompt_version, created_by_user_id)
         values ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12)`,
        [
          id,
          revision,
          preview.originalRequest,
          JSON.stringify(definition),
          preview.interpreted.summary,
          JSON.stringify(preview.interpreted.clarificationQuestions),
          JSON.stringify(preview.interpreted.warnings),
          String(preview.interpreted.confidence),
          preview.provider,
          preview.model,
          preview.promptVersion,
          auth.userId
        ]
      );
      await client.query(
        `update tasks set name = $1, status = 'draft', current_revision = $2, updated_at = now()
          where id = $3`,
        [definition.name, revision, id]
      );
      await client.query(
        `insert into audit_logs (actor_user_id, action, target_type, target_id, request_id, metadata)
         values ($1, 'task.revised', 'task', $2, $3, $4::jsonb)`,
        [auth.userId, id, context.get("requestId"), JSON.stringify({ revision })]
      );
      await client.query("commit");
      return context.json({ id, status: "draft", revision });
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });

  app.post("/api/tasks/:id/activate", async (context) => {
    const id = taskIdSchema.parse(context.req.param("id"));
    const auth = context.get("auth");
    const result = await dependencies.database.pool.query<{
      id: string;
      clarification_questions: string[];
    }>(
      `select t.id, r.clarification_questions
         from tasks t join task_revisions r
           on r.task_id = t.id and r.revision = t.current_revision
        where t.id = $1 and t.owner_user_id = $2`,
      [id, auth.userId]
    );
    const task = result.rows[0];
    if (!task) throw new ApiError(404, "task_not_found");
    if (task.clarification_questions.length > 0) {
      throw new ApiError(409, "task_has_unresolved_questions");
    }
    await dependencies.database.pool.query(
      "update tasks set status = 'active', updated_at = now() where id = $1",
      [id]
    );
    await dependencies.database.pool.query(
      `insert into audit_logs (actor_user_id, action, target_type, target_id, request_id)
       values ($1, 'task.activated', 'task', $2, $3)`,
      [auth.userId, id, context.get("requestId")]
    );
    return context.json({ id, status: "active" });
  });

  app.post("/api/tasks/:id/pause", async (context) => {
    const id = taskIdSchema.parse(context.req.param("id"));
    const auth = context.get("auth");
    const result = await dependencies.database.pool.query(
      `update tasks set status = 'paused', updated_at = now()
        where id = $1 and owner_user_id = $2 returning id`,
      [id, auth.userId]
    );
    if (!result.rows[0]) throw new ApiError(404, "task_not_found");
    await dependencies.database.pool.query(
      `insert into audit_logs (actor_user_id, action, target_type, target_id, request_id)
       values ($1, 'task.paused', 'task', $2, $3)`,
      [auth.userId, id, context.get("requestId")]
    );
    return context.json({ id, status: "paused" });
  });

  app.post("/api/tasks/:id/run", async (context) => {
    const id = taskIdSchema.parse(context.req.param("id"));
    const auth = context.get("auth");
    const task = await dependencies.database.pool.query<{
      status: string;
      current_revision: number;
    }>("select status, current_revision from tasks where id = $1 and owner_user_id = $2", [
      id,
      auth.userId
    ]);
    if (!task.rows[0]) throw new ApiError(404, "task_not_found");
    if (task.rows[0].status !== "active") throw new ApiError(409, "task_not_active");
    const dedupeKey = `manual:${id}:${randomUUID()}`;
    const created = await dependencies.database.pool.query<{ id: string }>(
      `insert into collection_runs (task_id, task_revision, trigger, status, dedupe_key)
       values ($1, $2, 'manual', 'queued', $3) returning id`,
      [id, task.rows[0].current_revision, dedupeKey]
    );
    const runId = created.rows[0]!.id;
    try {
      await dependencies.queueCollectionRun({ runId, taskId: id });
    } catch (error) {
      await markRunFailure(dependencies.database.pool, {
        runId,
        error,
        attempt: 1,
        maxAttempts: 1,
        terminalStatus: "failed"
      });
      throw new ApiError(503, "job_queue_unavailable");
    }
    return context.json({ id: runId, taskId: id, status: "queued" }, 202);
  });

  app.get("/api/tasks/:id/runs", async (context) => {
    const id = taskIdSchema.parse(context.req.param("id"));
    const auth = context.get("auth");
    const task = await dependencies.database.pool.query(
      "select 1 from tasks where id = $1 and owner_user_id = $2",
      [id, auth.userId]
    );
    if (!task.rows[0]) throw new ApiError(404, "task_not_found");
    const limit = Math.min(Number(context.req.query("limit") ?? 30) || 30, 100);
    const runs = await dependencies.database.pool.query(
      `select id, task_revision as "taskRevision", trigger, status, attempt,
              fetched_count as "fetchedCount",
              new_count as "newCount", updated_count as "updatedCount",
              unchanged_count as "unchangedCount", rejected_count as "rejectedCount",
              analysis_status as "analysisStatus", candidate_count as "candidateCount",
              event_count as "eventCount", analysis_error_code as "analysisErrorCode",
              analysis_error_message as "analysisErrorMessage",
              error_code as "errorCode", error_message as "errorMessage",
              scheduled_for as "scheduledFor", started_at as "startedAt",
              finished_at as "finishedAt", created_at as "createdAt"
         from collection_runs where task_id = $1 order by created_at desc limit $2`,
      [id, limit]
    );
    return context.json({ runs: runs.rows });
  });

  app.post("/api/tasks/:id/runs/:runId/retry", async (context) => {
    const id = taskIdSchema.parse(context.req.param("id"));
    const runId = taskIdSchema.parse(context.req.param("runId"));
    const auth = context.get("auth");
    const original = await dependencies.database.pool.query<{
      status: string;
      task_revision: number | null;
      current_revision: number;
    }>(
      `select cr.status, cr.task_revision, t.current_revision from collection_runs cr
         join tasks t on t.id = cr.task_id
        where cr.id = $1 and cr.task_id = $2 and t.owner_user_id = $3 and t.status = 'active'`,
      [runId, id, auth.userId]
    );
    if (!original.rows[0]) throw new ApiError(404, "run_not_found");
    if (!new Set(["failed", "dead_letter"]).has(original.rows[0].status)) {
      throw new ApiError(409, "run_not_retryable");
    }
    const created = await dependencies.database.pool.query<{ id: string }>(
      `insert into collection_runs (task_id, task_revision, trigger, status, dedupe_key)
       values ($1, $2, 'retry', 'queued', $3) returning id`,
      [
        id,
        original.rows[0].task_revision ?? original.rows[0].current_revision,
        `retry:${runId}:${randomUUID()}`
      ]
    );
    const retryRunId = created.rows[0]!.id;
    try {
      await dependencies.queueCollectionRun({ runId: retryRunId, taskId: id });
    } catch (error) {
      await markRunFailure(dependencies.database.pool, {
        runId: retryRunId,
        error,
        attempt: 1,
        maxAttempts: 1,
        terminalStatus: "failed"
      });
      throw new ApiError(503, "job_queue_unavailable");
    }
    return context.json({ id: retryRunId, taskId: id, status: "queued" }, 202);
  });

  app.post("/api/tasks/:id/ingest", async (context) => {
    const id = taskIdSchema.parse(context.req.param("id"));
    const auth = context.get("auth");
    const task = await dependencies.database.pool.query<{
      status: string;
      current_revision: number;
    }>("select status, current_revision from tasks where id = $1 and owner_user_id = $2", [
      id,
      auth.userId
    ]);
    if (!task.rows[0]) throw new ApiError(404, "task_not_found");
    if (task.rows[0].status !== "active") throw new ApiError(409, "task_not_active");
    let raw: unknown;
    try {
      raw = await context.req.json();
    } catch {
      throw new ApiError(400, "invalid_json");
    }
    const input = manualIngestRequestSchema.parse(raw);
    const created = await dependencies.database.pool.query<{ id: string }>(
      `insert into collection_runs
        (task_id, task_revision, trigger, status, dedupe_key, attempt, started_at)
       values ($1, $2, 'webhook', 'running', $3, 1, now()) returning id`,
      [id, task.rows[0].current_revision, `webhook:${id}:${randomUUID()}`]
    );
    const runId = created.rows[0]!.id;
    try {
      await ingestRecords(dependencies.database.pool, {
        runId,
        connectorId: "webhook",
        query: { taskId: id },
        records: input.records
      });
      const stats = await completeIngestRun(dependencies.database.pool, runId);
      let analysisStatus = "queued";
      try {
        await dependencies.queueAnalysisRun({ runId, taskId: id });
      } catch (error) {
        console.error("Unable to queue analysis; scheduler will recover it", error);
        analysisStatus = "pending";
      }
      return context.json(
        { id: runId, taskId: id, status: "succeeded", analysisStatus, stats },
        201
      );
    } catch (error) {
      await markRunFailure(dependencies.database.pool, {
        runId,
        error,
        attempt: 1,
        maxAttempts: 1,
        terminalStatus: "failed"
      });
      throw error;
    }
  });
}
