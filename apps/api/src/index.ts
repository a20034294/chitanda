import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { loadConfig, formatConfigError } from "@chitanda/config";
import { createDatabase } from "@chitanda/db";
import { createLlmProviders } from "@chitanda/llm";
import { makeWorkerUtils } from "graphile-worker";
import pino from "pino";
import { createApp } from "./app.js";

const version = "0.0.0";

async function main(): Promise<void> {
  const instancePath = process.env.CHITANDA_CONFIG_FILE;
  const config = await loadConfig(instancePath ? { instancePath } : {});
  const logger = pino({ level: config.logging.level, base: { service: "api" } });
  const database = createDatabase(config.database);
  database.pool.on("error", (error) => {
    logger.error({ error }, "Unexpected idle PostgreSQL client error");
  });
  database.pool.on("connect", (client) => {
    client.on("error", (error) => {
      logger.error({ error }, "Unexpected PostgreSQL client error");
    });
  });
  const providers = createLlmProviders(config);
  const workerUtils = await makeWorkerUtils({ pgPool: database.pool });
  await workerUtils.migrate();
  const app = createApp({
    config,
    version,
    readinessCheck: database.check,
    database,
    providers,
    queueCollectionRun: async ({ runId, taskId }) => {
      await workerUtils.addJob(
        "collect_task",
        { runId, taskId },
        { jobKey: `collection:${runId}`, jobKeyMode: "unsafe_dedupe", maxAttempts: 5 }
      );
    },
    staticRoot: resolve("apps/web/dist")
  });

  const server = serve(
    {
      fetch: app.fetch,
      hostname: config.server.host,
      port: config.server.port
    },
    (address) => logger.info({ address }, "API listening")
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Stopping API");
    server.close();
    await workerUtils.release();
    await database.close();
    logger.info("API stopped");
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  process.stderr.write(`${formatConfigError(error)}\n`);
  process.exitCode = 1;
});
