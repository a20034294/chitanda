import { createServer } from "node:http";
import { loadConfig, formatConfigError } from "@chitanda/config";
import { taskDefinitionV1Schema, type ServiceStatus } from "@chitanda/contracts";
import { createDatabase } from "@chitanda/db";
import { collectTaskRun, isScheduleDue, markRunFailure } from "@chitanda/collection";
import { createBuiltinConnectors } from "@chitanda/connectors";
import { run, type Runner, type TaskList } from "graphile-worker";
import pino from "pino";

const version = "0.0.0";

async function main(): Promise<void> {
  const instancePath = process.env.CHITANDA_CONFIG_FILE;
  const config = await loadConfig(instancePath ? { instancePath } : {});
  const logger = pino({ level: config.logging.level, base: { service: "worker" } });
  const database = createDatabase(config.database);
  database.pool.on("error", (error) => {
    logger.error({ error }, "Unexpected idle PostgreSQL client error");
  });
  database.pool.on("connect", (client) => {
    client.on("error", (error) => {
      logger.error({ error }, "Unexpected PostgreSQL client error");
    });
  });
  const connectors = createBuiltinConnectors();
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

  const taskList: TaskList = {
    schedule_due_tasks: async (_payload, helpers) => {
      const now = new Date();
      const tasks = await helpers.query<{
        id: string;
        definition: unknown;
        last_run_at: Date | null;
      }>(
        `select t.id, r.definition, max(cr.created_at) as last_run_at
           from tasks t
           join task_revisions r on r.task_id = t.id and r.revision = t.current_revision
           left join collection_runs cr on cr.task_id = t.id
          where t.status = 'active'
          group by t.id, r.definition`
      );
      for (const task of tasks.rows) {
        try {
          const definition = taskDefinitionV1Schema.parse(task.definition);
          const isPushOnly = definition.sources.every(
            (source) => connectors.get(source.connectorId)?.mode === "push"
          );
          if (isPushOnly) continue;
          if (
            !isScheduleDue(definition.monitor.schedule, definition.timezone, task.last_run_at, now)
          ) {
            continue;
          }
          const bucket = Math.floor(now.getTime() / 60_000);
          const inserted = await helpers.query<{ id: string }>(
            `insert into collection_runs
              (task_id, trigger, status, dedupe_key, scheduled_for)
             values ($1, 'scheduled', 'queued', $2, $3)
             on conflict (dedupe_key) do nothing returning id`,
            [task.id, `scheduled:${task.id}:${bucket}`, now]
          );
          const runId = inserted.rows[0]?.id;
          if (runId) {
            await helpers.addJob(
              "collect_task",
              { runId, taskId: task.id },
              { jobKey: `collection:${runId}`, jobKeyMode: "unsafe_dedupe", maxAttempts: 5 }
            );
          }
        } catch (error) {
          helpers.logger.error(
            `Unable to schedule task ${task.id}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    },
    collect_task: async (payload, helpers) => {
      if (
        !payload ||
        typeof payload !== "object" ||
        typeof (payload as Record<string, unknown>).runId !== "string" ||
        typeof (payload as Record<string, unknown>).taskId !== "string"
      ) {
        throw new Error("Invalid collect_task payload");
      }
      const { runId, taskId } = payload as { runId: string; taskId: string };
      try {
        const stats = await collectTaskRun(database.pool, connectors, {
          runId,
          taskId,
          attempt: helpers.job.attempts,
          signal: helpers.abortSignal
        });
        helpers.logger.info(`Collection run ${runId} completed: ${JSON.stringify(stats)}`);
      } catch (error) {
        await markRunFailure(database.pool, {
          runId,
          error,
          attempt: helpers.job.attempts,
          maxAttempts: helpers.job.max_attempts
        });
        throw error;
      }
    },
    heartbeat: async (_payload, helpers) => {
      helpers.logger.info("Worker heartbeat job completed");
    }
  };

  runner = await run({
    connectionString: config.database.url,
    concurrency: config.worker.concurrency,
    pollInterval: config.worker.pollIntervalMs,
    crontab: "* * * * * schedule_due_tasks",
    noHandleSignals: true,
    taskList
  });
  await runner.addJob("schedule_due_tasks", {}, { jobKey: "schedule-startup", maxAttempts: 3 });
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
