import { createServer } from "node:http";
import { analyzeCollectionRun, markAnalysisFailure } from "@chitanda/analysis";
import { loadConfig, formatConfigError, readSecretFile } from "@chitanda/config";
import { taskDefinitionV1Schema, type ServiceStatus } from "@chitanda/contracts";
import { createDatabase } from "@chitanda/db";
import { createLlmProviders } from "@chitanda/llm";
import { collectTaskRun, isScheduleDue, markRunFailure } from "@chitanda/collection";
import { createBuiltinConnectors } from "@chitanda/connectors";
import {
  createPendingEmailDeliveries,
  createSmtpEmailProvider,
  deliverEmail,
  dueEmailDeliveryIds
} from "@chitanda/notifications";
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
  const searchApiKey =
    config.acquisition.search.enabled && config.acquisition.search.apiKeyFile
      ? await readSecretFile(config.acquisition.search.apiKeyFile)
      : undefined;
  const connectors = createBuiltinConnectors({
    userAgent: config.acquisition.userAgent,
    ...(config.acquisition.search.enabled
      ? {
          search: {
            endpoint: config.acquisition.search.endpoint,
            ...(searchApiKey ? { apiKey: searchApiKey } : {})
          }
        }
      : {})
  });
  const providers = createLlmProviders(config);
  const emailProvider = config.notifications.email.enabled
    ? await createSmtpEmailProvider(config)
    : null;
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
        current_revision: number;
        definition: unknown;
        last_run_at: Date | null;
      }>(
        `select t.id, t.current_revision, r.definition, max(cr.created_at) as last_run_at
           from tasks t
           join task_revisions r on r.task_id = t.id and r.revision = t.current_revision
           left join collection_runs cr on cr.task_id = t.id
          where t.status = 'active'
          group by t.id, t.current_revision, r.definition`
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
              (task_id, task_revision, trigger, status, dedupe_key, scheduled_for)
             values ($1, $2, 'scheduled', 'queued', $3, $4)
             on conflict (dedupe_key) do nothing returning id`,
            [task.id, task.current_revision, `scheduled:${task.id}:${bucket}`, now]
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
        try {
          await helpers.query(
            "update collection_runs set analysis_status = 'queued' where id = $1",
            [runId]
          );
          await helpers.addJob(
            "analyze_run",
            { runId, taskId },
            { jobKey: `analysis:${runId}`, jobKeyMode: "unsafe_dedupe", maxAttempts: 3 }
          );
        } catch (queueError) {
          await helpers.query(
            "update collection_runs set analysis_status = 'pending' where id = $1",
            [runId]
          );
          helpers.logger.error(
            `Analysis queueing for run ${runId} will be recovered: ${queueError instanceof Error ? queueError.message : String(queueError)}`
          );
        }
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
    analyze_run: async (payload, helpers) => {
      if (
        !payload ||
        typeof payload !== "object" ||
        typeof (payload as Record<string, unknown>).runId !== "string" ||
        typeof (payload as Record<string, unknown>).taskId !== "string"
      ) {
        throw new Error("Invalid analyze_run payload");
      }
      const { runId, taskId } = payload as { runId: string; taskId: string };
      try {
        const stats = await analyzeCollectionRun(database.pool, providers, { runId, taskId });
        await helpers.addJob(
          "schedule_deliveries",
          {},
          { jobKey: `deliveries:${runId}`, jobKeyMode: "unsafe_dedupe", maxAttempts: 3 }
        );
        helpers.logger.info(`Analysis run ${runId} completed: ${JSON.stringify(stats)}`);
      } catch (error) {
        await markAnalysisFailure(database.pool, {
          runId,
          error,
          attempt: helpers.job.attempts,
          maxAttempts: helpers.job.max_attempts
        });
        throw error;
      }
    },
    schedule_analysis: async (_payload, helpers) => {
      const pending = await helpers.query<{ id: string; task_id: string }>(
        `select id, task_id from collection_runs
          where status = 'succeeded' and analysis_status in ('pending', 'queued')
          order by created_at limit 100`
      );
      for (const pendingRun of pending.rows) {
        await helpers.query("update collection_runs set analysis_status = 'queued' where id = $1", [
          pendingRun.id
        ]);
        await helpers.addJob(
          "analyze_run",
          { runId: pendingRun.id, taskId: pendingRun.task_id },
          {
            jobKey: `analysis:${pendingRun.id}`,
            jobKeyMode: "unsafe_dedupe",
            maxAttempts: 3
          }
        );
      }
    },
    schedule_deliveries: async (_payload, helpers) => {
      if (!emailProvider) return;
      const created = await createPendingEmailDeliveries(database.pool, config);
      const dueIds = await dueEmailDeliveryIds(database.pool);
      for (const deliveryId of dueIds) {
        await helpers.addJob(
          "send_email_delivery",
          { deliveryId },
          {
            jobKey: `email-delivery:${deliveryId}`,
            jobKeyMode: "unsafe_dedupe",
            maxAttempts: 5
          }
        );
      }
      if (created > 0 || dueIds.length > 0) {
        helpers.logger.info(`Email deliveries: ${created} created, ${dueIds.length} due`);
      }
    },
    send_email_delivery: async (payload, helpers) => {
      if (!emailProvider) throw new Error("Email provider is disabled");
      if (
        !payload ||
        typeof payload !== "object" ||
        typeof (payload as Record<string, unknown>).deliveryId !== "string"
      ) {
        throw new Error("Invalid send_email_delivery payload");
      }
      const deliveryId = (payload as { deliveryId: string }).deliveryId;
      const status = await deliverEmail(database.pool, emailProvider, {
        deliveryId,
        attempt: helpers.job.attempts,
        maxAttempts: helpers.job.max_attempts,
        publicBaseUrl: config.server.publicBaseUrl
      });
      if (status === "retrying") throw new Error(`Email delivery ${deliveryId} will retry`);
      helpers.logger.info(`Email delivery ${deliveryId}: ${status}`);
    },
    heartbeat: async (_payload, helpers) => {
      helpers.logger.info("Worker heartbeat job completed");
    }
  };

  runner = await run({
    connectionString: config.database.url,
    concurrency: config.worker.concurrency,
    pollInterval: config.worker.pollIntervalMs,
    crontab:
      "* * * * * schedule_due_tasks\n* * * * * schedule_analysis\n* * * * * schedule_deliveries",
    noHandleSignals: true,
    taskList
  });
  await runner.addJob("schedule_due_tasks", {}, { jobKey: "schedule-startup", maxAttempts: 3 });
  await runner.addJob("schedule_analysis", {}, { jobKey: "analysis-startup", maxAttempts: 3 });
  await runner.addJob("schedule_deliveries", {}, { jobKey: "deliveries-startup", maxAttempts: 3 });
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
