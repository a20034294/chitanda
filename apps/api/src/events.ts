import type { Hono } from "hono";
import { z } from "zod";
import {
  eventFeedbackRequestSchema,
  eventStateSchema,
  updateEventStateRequestSchema
} from "@chitanda/contracts";
import { requireAuth } from "./auth.js";
import { ApiError, type ApiDependencies, type AppVariables } from "./context.js";

const eventIdSchema = z.string().uuid();

async function jsonBody(context: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}

export function registerEventRoutes(
  app: Hono<{ Variables: AppVariables }>,
  dependencies: ApiDependencies
): void {
  const authentication = requireAuth(dependencies, { requireMfa: true, csrf: true });
  app.use("/api/events/*", authentication);
  app.use("/api/events", authentication);

  app.get("/api/events", async (context) => {
    const auth = context.get("auth");
    const stateInput = context.req.query("state");
    const state = stateInput ? eventStateSchema.parse(stateInput) : null;
    const beforeInput = context.req.query("before");
    const before = beforeInput ? z.string().datetime().parse(beforeInput) : null;
    const limit = Math.min(Math.max(Number(context.req.query("limit") ?? 30) || 30, 1), 100);
    const result = await dependencies.database.pool.query(
      `select e.id, e.event_type as "eventType", e.state, e.severity, e.title, e.summary,
              e.reason, e.evidence, e.occurred_at as "occurredAt", e.created_at as "createdAt",
              t.id as "taskId", t.name as "taskName", si.canonical_url as "canonicalUrl",
              ar.score_basis_points / 10000.0 as score, ar.provider, ar.model,
              uf.rating as "feedbackRating"
         from events e
         join tasks t on t.id = e.task_id
         join source_items si on si.id = e.source_item_id
         join analysis_results ar on ar.id = e.analysis_result_id
         left join user_feedback uf on uf.event_id = e.id and uf.user_id = $1
        where t.owner_user_id = $1
          and ($2::text is null or e.state = $2)
          and ($3::timestamptz is null or e.created_at < $3)
        order by e.created_at desc, e.id desc limit $4`,
      [auth.userId, state, before, limit + 1]
    );
    const hasMore = result.rows.length > limit;
    const events = result.rows.slice(0, limit);
    const last = events.at(-1) as { createdAt?: Date | string } | undefined;
    return context.json({
      events,
      nextCursor: hasMore && last?.createdAt ? new Date(last.createdAt).toISOString() : null
    });
  });

  app.get("/api/events/:id", async (context) => {
    const id = eventIdSchema.parse(context.req.param("id"));
    const auth = context.get("auth");
    const result = await dependencies.database.pool.query(
      `select e.id, e.event_type as "eventType", e.state, e.severity, e.title, e.summary,
              e.reason, e.evidence, e.occurred_at as "occurredAt", e.created_at as "createdAt",
              t.id as "taskId", t.name as "taskName", si.canonical_url as "canonicalUrl",
              si.author, si.published_at as "publishedAt", siv.normalized,
              ar.matched, ar.score_basis_points / 10000.0 as score, ar.facts,
              ar.uncertainties, ar.provider, ar.model, ar.prompt_version as "promptVersion",
              uf.rating as "feedbackRating", uf.note as "feedbackNote"
         from events e
         join tasks t on t.id = e.task_id
         join source_items si on si.id = e.source_item_id
         join source_item_versions siv on siv.id = e.source_item_version_id
         join analysis_results ar on ar.id = e.analysis_result_id
         left join user_feedback uf on uf.event_id = e.id and uf.user_id = $2
        where e.id = $1 and t.owner_user_id = $2`,
      [id, auth.userId]
    );
    if (!result.rows[0]) throw new ApiError(404, "event_not_found");
    return context.json({ event: result.rows[0] });
  });

  app.post("/api/events/:id/state", async (context) => {
    const id = eventIdSchema.parse(context.req.param("id"));
    const auth = context.get("auth");
    const input = updateEventStateRequestSchema.parse(await jsonBody(context));
    const result = await dependencies.database.pool.query(
      `update events e set state = $1, updated_at = now()
        from tasks t where e.task_id = t.id and e.id = $2 and t.owner_user_id = $3
        returning e.id, e.state`,
      [input.state, id, auth.userId]
    );
    if (!result.rows[0]) throw new ApiError(404, "event_not_found");
    return context.json(result.rows[0]);
  });

  app.post("/api/events/:id/feedback", async (context) => {
    const id = eventIdSchema.parse(context.req.param("id"));
    const auth = context.get("auth");
    const input = eventFeedbackRequestSchema.parse(await jsonBody(context));
    const owned = await dependencies.database.pool.query(
      `select 1 from events e join tasks t on t.id = e.task_id
        where e.id = $1 and t.owner_user_id = $2`,
      [id, auth.userId]
    );
    if (!owned.rows[0]) throw new ApiError(404, "event_not_found");
    const feedback = await dependencies.database.pool.query(
      `insert into user_feedback (event_id, user_id, rating, note)
       values ($1, $2, $3, $4)
       on conflict (event_id, user_id) do update set rating = excluded.rating,
         note = excluded.note, updated_at = now()
       returning event_id as "eventId", rating, note, updated_at as "updatedAt"`,
      [id, auth.userId, input.rating, input.note]
    );
    return context.json({ feedback: feedback.rows[0] });
  });
}
