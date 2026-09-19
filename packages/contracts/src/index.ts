import { z } from "zod";

export const serviceStatusSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.enum(["api", "worker"]),
  version: z.string(),
  timestamp: z.string().datetime(),
  checks: z.record(z.string(), z.enum(["ok", "failed"])).optional()
});

export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

export const conditionSchema = z
  .object({
    field: z.string().min(1),
    operator: z.enum([
      "equals",
      "contains",
      "in",
      "lt",
      "lte",
      "gt",
      "gte",
      "between",
      "before",
      "after",
      "regex"
    ]),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
    unit: z.string().nullable()
  })
  .strict();

export const taskDefinitionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1).max(120),
    intent: z.string().min(1).max(2000),
    locale: z.string().min(2).max(20),
    timezone: z.string().min(1).max(100),
    topics: z.array(z.string().min(1)).max(30),
    entities: z
      .array(
        z
          .object({
            type: z.string().min(1),
            value: z.string().min(1),
            aliases: z.array(z.string()).max(20)
          })
          .strict()
      )
      .max(50),
    sources: z
      .array(
        z
          .object({
            connectorId: z.string().min(1),
            query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          })
          .strict()
      )
      .min(1)
      .max(20),
    filters: z
      .object({
        all: z.array(conditionSchema),
        any: z.array(conditionSchema),
        none: z.array(conditionSchema)
      })
      .strict(),
    monitor: z
      .object({
        schedule: z
          .object({ type: z.enum(["interval", "cron"]), value: z.string().min(1) })
          .strict(),
        eventTypes: z.array(
          z.enum([
            "new_item",
            "content_changed",
            "field_changed",
            "threshold_crossed",
            "back_in_stock"
          ])
        ),
        lookback: z.string().nullable()
      })
      .strict(),
    analysis: z
      .object({
        semanticMatch: z.boolean(),
        minimumScore: z.number().min(0).max(1),
        extractionFields: z.array(z.string().min(1)).max(50)
      })
      .strict(),
    delivery: z
      .array(
        z
          .object({
            channel: z.enum(["in_app", "email", "webhook", "telegram"]),
            mode: z.enum(["immediate", "digest", "store_only"]),
            minimumSeverity: z.enum(["low", "normal", "high"])
          })
          .strict()
      )
      .min(1)
  })
  .strict();

export type TaskDefinitionV1 = z.infer<typeof taskDefinitionV1Schema>;

export const interpretTaskRequestSchema = z
  .object({
    request: z.string().min(10).max(10_000),
    locale: z.string().min(2).max(20).default("zh-TW"),
    timezone: z.string().min(1).max(100).default("Asia/Taipei"),
    provider: z.enum(["ollama", "openai"]).optional(),
    model: z.string().min(1).max(200).optional()
  })
  .strict();

export const interpretedTaskSchema = z
  .object({
    definition: taskDefinitionV1Schema,
    summary: z.string().min(1).max(2000),
    clarificationQuestions: z.array(z.string().min(1)).max(5),
    warnings: z.array(z.string().min(1)).max(10),
    confidence: z.number().min(0).max(1)
  })
  .strict();

export type InterpretedTask = z.infer<typeof interpretedTaskSchema>;

export const taskPreviewSchema = z
  .object({
    interpreted: interpretedTaskSchema,
    originalRequest: z.string().min(10).max(10_000),
    provider: z.string().min(1),
    model: z.string().min(1),
    promptVersion: z.string().min(1),
    requestId: z.string().optional(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional()
      })
      .optional()
  })
  .strict();

export type TaskPreview = z.infer<typeof taskPreviewSchema>;

export const createTaskRequestSchema = z
  .object({
    preview: taskPreviewSchema
  })
  .strict();

export const normalizedSourceRecordSchema = z
  .object({
    externalId: z.string().min(1).max(2000).nullable(),
    canonicalUrl: z.string().url().max(8000).nullable(),
    title: z.string().min(1).max(2000),
    content: z.string().max(500_000),
    author: z.string().max(1000).nullable(),
    publishedAt: z.string().datetime().nullable(),
    language: z.string().max(50).nullable(),
    media: z
      .array(z.object({ url: z.string().url(), type: z.string().nullable() }).strict())
      .max(100),
    metadata: z.record(z.string(), z.unknown()),
    rawPayload: z.unknown()
  })
  .strict();

export type NormalizedSourceRecord = z.infer<typeof normalizedSourceRecordSchema>;

export const manualIngestRequestSchema = z
  .object({
    records: z.array(normalizedSourceRecordSchema).min(1).max(100)
  })
  .strict();

export const collectionRunStatusSchema = z.enum([
  "queued",
  "running",
  "retrying",
  "succeeded",
  "failed",
  "dead_letter"
]);
