import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { loadConfig, formatConfigError } from "@chitanda/config";
import { createDatabase } from "@chitanda/db";
import { createLlmProviders } from "@chitanda/llm";
import pino from "pino";
import { createApp } from "./app.js";

const version = "0.0.0";

async function main(): Promise<void> {
  const instancePath = process.env.CHITANDA_CONFIG_FILE;
  const config = await loadConfig(instancePath ? { instancePath } : {});
  const logger = pino({ level: config.logging.level, base: { service: "api" } });
  const database = createDatabase(config.database);
  const providers = createLlmProviders(config);
  const app = createApp({
    config,
    version,
    readinessCheck: database.check,
    database,
    providers,
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
