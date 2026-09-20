import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import { ZodError } from "zod";
import type { AppConfig } from "@chitanda/config";
import type { ServiceStatus } from "@chitanda/contracts";
import type { Database } from "@chitanda/db";
import type { LlmProvider } from "@chitanda/llm";
import type { EmailProvider } from "@chitanda/notifications";
import { registerAuthRoutes } from "./auth.js";
import { registerEventRoutes } from "./events.js";
import { ApiError, type AppVariables } from "./context.js";
import { registerTaskRoutes } from "./tasks.js";
import { registerSettingsRoutes } from "./settings.js";

type AppDependencies = {
  config: AppConfig;
  version: string;
  readinessCheck: () => Promise<void>;
  database?: Database;
  providers?: Map<string, LlmProvider>;
  queueCollectionRun?: (input: { runId: string; taskId: string }) => Promise<void>;
  queueAnalysisRun?: (input: { runId: string; taskId: string }) => Promise<void>;
  emailProvider?: EmailProvider;
  staticRoot?: string;
};

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function requestHostname(request: Request): string | null {
  try {
    return new URL(request.url).hostname;
  } catch {
    return null;
  }
}

export function createApp({
  config,
  version,
  readinessCheck,
  database,
  providers,
  queueCollectionRun,
  queueAnalysisRun,
  emailProvider,
  staticRoot
}: AppDependencies): Hono<{
  Variables: AppVariables;
}> {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use("*", async (context, next) => {
    const requestId = context.req.header("x-request-id") ?? randomUUID();
    context.set("requestId", requestId);
    context.header("x-request-id", requestId);
    await next();
  });
  app.use("*", secureHeaders());

  app.use("*", async (context, next) => {
    const hostname = requestHostname(context.req.raw);
    if (!hostname || !config.server.allowedHosts.includes(hostname)) {
      return context.json({ error: "invalid_host", requestId: context.get("requestId") }, 400);
    }
    await next();
  });

  app.use("/api/*", async (context, next) => {
    if (unsafeMethods.has(context.req.method)) {
      const origin = context.req.header("origin");
      if (origin && !config.server.allowedOrigins.includes(origin)) {
        return context.json({ error: "invalid_origin", requestId: context.get("requestId") }, 403);
      }
    }
    await next();
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (context) =>
        context.json({ error: "request_too_large", requestId: context.get("requestId") }, 413)
    })
  );

  app.get("/health/live", (context) => {
    const status: ServiceStatus = {
      status: "ok",
      service: "api",
      version,
      timestamp: new Date().toISOString()
    };
    return context.json(status);
  });

  app.get("/health/ready", async (context) => {
    try {
      await readinessCheck();
      const status: ServiceStatus = {
        status: "ok",
        service: "api",
        version,
        timestamp: new Date().toISOString(),
        checks: { database: "ok" }
      };
      return context.json(status);
    } catch {
      const status: ServiceStatus = {
        status: "degraded",
        service: "api",
        version,
        timestamp: new Date().toISOString(),
        checks: { database: "failed" }
      };
      return context.json(status, 503);
    }
  });

  app.get("/api", (context) =>
    context.json({
      name: "Chitanda API",
      version,
      requestId: context.get("requestId")
    })
  );

  if (database && providers && queueCollectionRun && queueAnalysisRun) {
    const apiDependencies = {
      config,
      database,
      providers,
      queueCollectionRun,
      queueAnalysisRun,
      ...(emailProvider ? { emailProvider } : {})
    };
    registerAuthRoutes(app, apiDependencies);
    registerTaskRoutes(app, apiDependencies);
    registerEventRoutes(app, apiDependencies);
    registerSettingsRoutes(app, apiDependencies);
  }

  if (staticRoot) {
    app.use("/assets/*", serveStatic({ root: staticRoot }));
    app.get("/", serveStatic({ path: `${staticRoot}/index.html` }));
  }

  app.notFound((context) =>
    context.json({ error: "not_found", requestId: context.get("requestId") }, 404)
  );

  app.onError((error, context) => {
    if (error instanceof ApiError) {
      return context.json({ error: error.code, requestId: context.get("requestId") }, error.status);
    }
    if (error instanceof ZodError) {
      return context.json(
        {
          error: "invalid_request",
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          })),
          requestId: context.get("requestId")
        },
        400
      );
    }
    console.error(error);
    return context.json({ error: "internal_error", requestId: context.get("requestId") }, 500);
  });

  return app;
}
