import { createServer } from "node:http";
import { loadConfig, formatConfigError } from "@chitanda/config";
import type { ServiceStatus } from "@chitanda/contracts";
import { createDatabase } from "@chitanda/db";
import { run, type Runner } from "graphile-worker";
import pino from "pino";

const version = "0.0.0";

async function main(): Promise<void> {
  const instancePath = process.env.CHITANDA_CONFIG_FILE;
  const config = await loadConfig(instancePath ? { instancePath } : {});
  const logger = pino({ level: config.logging.level, base: { service: "worker" } });
  const database = createDatabase(config.database);
  let runner: Runner | null = null;

  const healthServer = createServer((request, response) => {
    const send = (code: number, status: ServiceStatus): void => {
      response.writeHead(code, { "content-type": "application/json" });
      response.end(JSON.stringify(status));
    };

    if (request.url === "/health/live") {
      send(200, {
        status: "ok",
        service: "worker",
        version,
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (request.url === "/health/ready") {
      void database
        .check()
        .then(() =>
          send(runner ? 200 : 503, {
            status: runner ? "ok" : "degraded",
            service: "worker",
            version,
            timestamp: new Date().toISOString(),
            checks: { database: "ok", queue: runner ? "ok" : "failed" }
          })
        )
        .catch(() =>
          send(503, {
            status: "degraded",
            service: "worker",
            version,
            timestamp: new Date().toISOString(),
            checks: { database: "failed", queue: "failed" }
          })
        );
      return;
    }

    response.writeHead(404).end();
  });

  healthServer.listen(config.worker.healthPort, config.worker.healthHost, () => {
    logger.info({ port: config.worker.healthPort }, "Worker health server listening");
  });

  runner = await run({
    connectionString: config.database.url,
    concurrency: config.worker.concurrency,
    pollInterval: config.worker.pollIntervalMs,
    parsedCronItems: [],
    noHandleSignals: true,
    taskList: {
      heartbeat: async (_payload, helpers) => {
        helpers.logger.info("Worker heartbeat job completed");
      }
    }
  });
  logger.info({ concurrency: config.worker.concurrency }, "Job worker started");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Stopping worker");
    healthServer.close();
    await runner?.stop();
    await database.close();
    logger.info("Worker stopped");
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  process.stderr.write(`${formatConfigError(error)}\n`);
  process.exitCode = 1;
});
