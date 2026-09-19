import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const hostSchema = z.string().trim().min(1);
const urlSchema = z.string().url();

const configSchema = z
  .object({
    server: z.object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65_535),
      publicBaseUrl: urlSchema,
      allowedHosts: z.array(hostSchema).min(1),
      allowedOrigins: z.array(urlSchema).min(1),
      trustedProxies: z.array(z.string().min(1))
    }),
    worker: z.object({
      healthHost: z.string().min(1),
      healthPort: z.number().int().min(1).max(65_535),
      concurrency: z.number().int().min(1).max(100),
      pollIntervalMs: z.number().int().min(100).max(60_000)
    }),
    database: z.object({
      url: z.string().min(1),
      poolMax: z.number().int().min(1).max(100),
      statementTimeoutMs: z.number().int().min(100).max(300_000)
    }),
    security: z.object({
      secureCookies: z.boolean(),
      requireAdminMfa: z.boolean(),
      bootstrapTokenFile: z.string().min(1),
      masterKeyFile: z.string().min(1),
      sessionTtlHours: z
        .number()
        .int()
        .min(1)
        .max(24 * 365),
      csrfHeaderName: z.string().regex(/^[a-z0-9-]+$/),
      loginRateLimit: z.object({
        attempts: z.number().int().min(1).max(100),
        windowSeconds: z.number().int().min(1).max(86_400)
      }),
      intentRateLimit: z.object({
        attempts: z.number().int().min(1).max(1000),
        windowSeconds: z.number().int().min(1).max(86_400)
      })
    }),
    logging: z.object({
      level: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    }),
    llm: z.object({
      defaultProvider: z.string().min(1),
      intentParser: z.object({
        provider: z.enum(["ollama", "openai"]),
        model: z.string().min(1)
      }),
      ollama: z.object({
        baseUrl: urlSchema,
        model: z.string().min(1)
      }),
      openai: z.object({
        baseUrl: urlSchema,
        apiKeyFile: z.string().min(1),
        model: z.string().min(1),
        store: z.boolean()
      })
    }),
    notifications: z.object({
      email: z.object({
        enabled: z.boolean(),
        from: z.string().min(1),
        smtp: z.object({
          host: z.string().min(1),
          port: z.number().int().min(1).max(65_535),
          secure: z.boolean(),
          usernameFile: z.string().min(1).optional(),
          passwordFile: z.string().min(1).optional()
        })
      })
    })
  })
  .superRefine((config, context) => {
    const publicUrl = new URL(config.server.publicBaseUrl);
    if (publicUrl.protocol === "https:" && !config.security.secureCookies) {
      context.addIssue({
        code: "custom",
        path: ["security", "secureCookies"],
        message: "secureCookies must be true when publicBaseUrl uses HTTPS"
      });
    }

    if (!config.server.allowedHosts.includes(publicUrl.hostname)) {
      context.addIssue({
        code: "custom",
        path: ["server", "allowedHosts"],
        message: "allowedHosts must include the publicBaseUrl hostname"
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

export type LoadConfigOptions = {
  defaultPath?: string;
  instancePath?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const previous = merged[key];
    merged[key] = isRecord(previous) && isRecord(value) ? deepMerge(previous, value) : value;
  }

  return merged;
}

async function readYaml(path: string): Promise<Record<string, unknown>> {
  const content = await readFile(path, "utf8");
  const parsed: unknown = parse(content);
  if (!isRecord(parsed)) {
    throw new Error(`Configuration file must contain a YAML object: ${path}`);
  }
  return parsed;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<AppConfig> {
  const defaultPath = resolve(options.defaultPath ?? "config/default.yaml");
  const base = await readYaml(defaultPath);
  const merged = options.instancePath
    ? deepMerge(base, await readYaml(resolve(options.instancePath)))
    : base;

  return configSchema.parse(merged);
}

export async function readSecretFile(path: string): Promise<string> {
  const value = (await readFile(resolve(path), "utf8")).trim();
  if (!value) throw new Error(`Secret file is empty: ${path}`);
  return value;
}

export function formatConfigError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}
