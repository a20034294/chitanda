import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import type { TaskDefinitionV1 } from "@chitanda/contracts";

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull().unique(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("member"),
    enabled: boolean("enabled").notNull().default(true),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    mfaSecretCiphertext: text("mfa_secret_ciphertext"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("users_email_idx").on(table.email)]
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    mfaVerified: boolean("mfa_verified").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt)
  ]
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").notNull().default("draft"),
    currentRevision: integer("current_revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("tasks_owner_user_id_idx").on(table.ownerUserId),
    index("tasks_status_idx").on(table.status)
  ]
);

export const taskRevisions = pgTable(
  "task_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    originalRequest: text("original_request").notNull(),
    definition: jsonb("definition").$type<TaskDefinitionV1>().notNull(),
    summary: text("summary").notNull(),
    clarificationQuestions: jsonb("clarification_questions")
      .$type<string[]>()
      .notNull()
      .default([]),
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    confidence: text("confidence").notNull(),
    llmProvider: text("llm_provider").notNull(),
    llmModel: text("llm_model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("task_revisions_task_revision_idx").on(table.taskId, table.revision),
    index("task_revisions_task_id_idx").on(table.taskId)
  ]
);

export const collectionRuns = pgTable(
  "collection_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    taskRevision: integer("task_revision"),
    trigger: text("trigger").notNull(),
    status: text("status").notNull().default("queued"),
    dedupeKey: text("dedupe_key").notNull().unique(),
    attempt: integer("attempt").notNull().default(0),
    fetchedCount: integer("fetched_count").notNull().default(0),
    newCount: integer("new_count").notNull().default(0),
    updatedCount: integer("updated_count").notNull().default(0),
    unchangedCount: integer("unchanged_count").notNull().default(0),
    rejectedCount: integer("rejected_count").notNull().default(0),
    analysisStatus: text("analysis_status").notNull().default("pending"),
    candidateCount: integer("candidate_count").notNull().default(0),
    eventCount: integer("event_count").notNull().default(0),
    analysisErrorCode: text("analysis_error_code"),
    analysisErrorMessage: text("analysis_error_message"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("collection_runs_task_id_idx").on(table.taskId),
    index("collection_runs_status_idx").on(table.status),
    index("collection_runs_created_at_idx").on(table.createdAt)
  ]
);

export const sourceItems = pgTable(
  "source_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectorId: text("connector_id").notNull(),
    sourceKey: text("source_key").notNull(),
    externalId: text("external_id").notNull(),
    canonicalUrl: text("canonical_url"),
    title: text("title").notNull(),
    content: text("content").notNull(),
    author: text("author"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    language: text("language"),
    currentVersion: integer("current_version").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({})
  },
  (table) => [
    uniqueIndex("source_items_identity_idx").on(
      table.connectorId,
      table.sourceKey,
      table.externalId
    ),
    index("source_items_canonical_url_idx").on(table.canonicalUrl),
    index("source_items_last_seen_at_idx").on(table.lastSeenAt)
  ]
);

export const sourceItemVersions = pgTable(
  "source_item_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    contentHash: text("content_hash").notNull(),
    normalized: jsonb("normalized").$type<Record<string, unknown>>().notNull(),
    rawPayload: jsonb("raw_payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("source_item_versions_hash_idx").on(table.sourceItemId, table.contentHash),
    uniqueIndex("source_item_versions_number_idx").on(table.sourceItemId, table.version)
  ]
);

export const taskRunItems = pgTable(
  "task_run_items",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => collectionRuns.id, { onDelete: "cascade" }),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    sourceItemVersionId: uuid("source_item_version_id").references(() => sourceItemVersions.id, {
      onDelete: "cascade"
    }),
    outcome: text("outcome").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.sourceItemId] }),
    index("task_run_items_source_item_id_idx").on(table.sourceItemId)
  ]
);

export const taskCandidates = pgTable(
  "task_candidates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    sourceItemVersionId: uuid("source_item_version_id")
      .notNull()
      .references(() => sourceItemVersions.id, { onDelete: "cascade" }),
    collectionRunId: uuid("collection_run_id")
      .notNull()
      .references(() => collectionRuns.id, { onDelete: "cascade" }),
    collectionOutcome: text("collection_outcome").notNull(),
    status: text("status").notNull().default("pending"),
    deterministicMatched: boolean("deterministic_matched").notNull().default(false),
    effectiveMatched: boolean("effective_matched"),
    filterDetails: jsonb("filter_details").$type<Record<string, unknown>>().notNull().default({}),
    changedFields: jsonb("changed_fields").$type<string[]>().notNull().default([]),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("task_candidates_task_version_idx").on(table.taskId, table.sourceItemVersionId),
    index("task_candidates_task_id_idx").on(table.taskId),
    index("task_candidates_status_idx").on(table.status)
  ]
);

export const analysisResults = pgTable(
  "analysis_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => taskCandidates.id, { onDelete: "cascade" }),
    matched: boolean("matched").notNull(),
    scoreBasisPoints: integer("score_basis_points").notNull(),
    reason: text("reason").notNull(),
    facts: jsonb("facts").$type<Record<string, unknown>[]>().notNull().default([]),
    summary: text("summary").notNull(),
    uncertainties: jsonb("uncertainties").$type<string[]>().notNull().default([]),
    evidence: jsonb("evidence").$type<Record<string, unknown>[]>().notNull().default([]),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    requestId: text("request_id"),
    usage: jsonb("usage").$type<Record<string, unknown>>().notNull().default({}),
    inputHash: text("input_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("analysis_results_candidate_idx").on(table.candidateId)]
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    sourceItemId: uuid("source_item_id")
      .notNull()
      .references(() => sourceItems.id, { onDelete: "cascade" }),
    sourceItemVersionId: uuid("source_item_version_id")
      .notNull()
      .references(() => sourceItemVersions.id, { onDelete: "cascade" }),
    analysisResultId: uuid("analysis_result_id")
      .notNull()
      .references(() => analysisResults.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    fingerprint: text("fingerprint").notNull().unique(),
    state: text("state").notNull().default("unread"),
    severity: text("severity").notNull().default("normal"),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>[]>().notNull().default([]),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("events_task_id_idx").on(table.taskId),
    index("events_state_created_at_idx").on(table.state, table.createdAt)
  ]
);

export const userFeedback = pgTable(
  "user_feedback",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rating: text("rating").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("user_feedback_event_user_idx").on(table.eventId, table.userId)]
);

export const connectorCursors = pgTable(
  "connector_cursors",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    sourceIndex: integer("source_index").notNull(),
    connectorId: text("connector_id").notNull(),
    cursor: jsonb("cursor").$type<Record<string, unknown>>().notNull().default({}),
    etag: text("etag"),
    lastModified: text("last_modified"),
    lastSucceededAt: timestamp("last_succeeded_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.taskId, table.sourceIndex] })]
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    requestId: text("request_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("audit_logs_created_at_idx").on(table.createdAt)]
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    bucket: text("bucket").notNull(),
    subjectHash: text("subject_hash").notNull(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({ columns: [table.bucket, table.subjectHash] }),
    index("rate_limits_expires_at_idx").on(table.expiresAt)
  ]
);
