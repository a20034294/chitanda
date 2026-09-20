import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import type { Pool } from "pg";
import { readSecretFile, type AppConfig } from "@chitanda/config";
import { taskDefinitionV1Schema, type TaskDefinitionV1 } from "@chitanda/contracts";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
};

export type EmailReceipt = { messageId: string | null };

export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailReceipt>;
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number };

function timeMinutes(value: string): number {
  const [hour = "0", minute = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

function localParts(date: Date, timezone: string): LocalParts {
  const fields = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(fields.find((field) => field.type === type)?.value ?? 0);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute")
  };
}

function localDateKey(parts: LocalParts): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function inQuietHours(
  parts: LocalParts,
  quietHours: AppConfig["notifications"]["quietHours"]
): boolean {
  if (!quietHours.enabled) return false;
  const current = parts.hour * 60 + parts.minute;
  const start = timeMinutes(quietHours.start);
  const end = timeMinutes(quietHours.end);
  if (start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function nextMinuteMatching(
  from: Date,
  timezone: string,
  predicate: (parts: LocalParts) => boolean
): Date {
  const cursor = new Date(Math.ceil(from.getTime() / 60_000) * 60_000);
  for (let minute = 0; minute <= 60 * 49; minute += 1) {
    const candidate = new Date(cursor.getTime() + minute * 60_000);
    if (predicate(localParts(candidate, timezone))) return candidate;
  }
  throw new Error(`Unable to calculate a delivery time in timezone ${timezone}`);
}

export function calculateDeliverySchedule(
  mode: "immediate" | "digest",
  timezone: string,
  now: Date,
  settings: Pick<AppConfig["notifications"], "digestTime" | "quietHours">
): { scheduledFor: Date; scheduleBucket: string } {
  let scheduledFor = new Date(now);
  if (mode === "digest") {
    const digestMinute = timeMinutes(settings.digestTime);
    scheduledFor = nextMinuteMatching(
      new Date(now.getTime() + 60_000),
      timezone,
      (parts) => parts.hour * 60 + parts.minute === digestMinute
    );
  }
  if (inQuietHours(localParts(scheduledFor, timezone), settings.quietHours)) {
    scheduledFor = nextMinuteMatching(
      new Date(scheduledFor.getTime() + 60_000),
      timezone,
      (parts) => !inQuietHours(parts, settings.quietHours)
    );
  }
  const scheduleBucket =
    mode === "digest" ? `digest:${localDateKey(localParts(scheduledFor, timezone))}` : "immediate";
  return { scheduledFor, scheduleBucket };
}

const severityRank = { low: 0, normal: 1, high: 2 } as const;

type EventDeliveryRow = {
  event_id: string;
  severity: string;
  user_id: string;
  email: string;
  definition: unknown;
};

export async function createPendingEmailDeliveries(
  pool: Pool,
  config: AppConfig,
  now = new Date()
): Promise<number> {
  if (!config.notifications.email.enabled) return 0;
  await pool.query(
    `update deliveries set status = 'retrying', updated_at = now()
      where status = 'sending' and last_attempt_at < now() - interval '15 minutes'`
  );
  const candidates = await pool.query<EventDeliveryRow>(
    `select e.id as event_id, e.severity, t.owner_user_id as user_id, u.email, tr.definition
       from events e
       join tasks t on t.id = e.task_id
       join users u on u.id = t.owner_user_id and u.enabled
       join analysis_results ar on ar.id = e.analysis_result_id
       join task_candidates tc on tc.id = ar.candidate_id
       join collection_runs cr on cr.id = tc.collection_run_id
       join task_revisions tr on tr.task_id = t.id
         and tr.revision = coalesce(cr.task_revision, t.current_revision)
      where not exists (
        select 1 from deliveries d
         where d.event_id = e.id and d.user_id = t.owner_user_id and d.channel = 'email'
      )
      order by e.created_at
      limit 500`
  );
  let created = 0;
  for (const candidate of candidates.rows) {
    const definition = taskDefinitionV1Schema.parse(candidate.definition);
    const directives = definition.delivery.filter(
      (entry): entry is TaskDefinitionV1["delivery"][number] & { mode: "immediate" | "digest" } =>
        entry.channel === "email" &&
        entry.mode !== "store_only" &&
        severityRank[candidate.severity as keyof typeof severityRank] >=
          severityRank[entry.minimumSeverity]
    );
    for (const directive of directives) {
      const schedule = calculateDeliverySchedule(
        directive.mode,
        definition.timezone,
        now,
        config.notifications
      );
      const idempotencyKey = createHash("sha256")
        .update(`${candidate.event_id}\0${candidate.user_id}\0email\0${schedule.scheduleBucket}`)
        .digest("base64url");
      const result = await pool.query(
        `insert into deliveries
          (event_id, user_id, channel, mode, schedule_bucket, idempotency_key, recipient,
           scheduled_for)
         values ($1, $2, 'email', $3, $4, $5, $6, $7)
         on conflict (event_id, user_id, channel, schedule_bucket) do nothing`,
        [
          candidate.event_id,
          candidate.user_id,
          directive.mode,
          schedule.scheduleBucket,
          idempotencyKey,
          candidate.email,
          schedule.scheduledFor
        ]
      );
      created += result.rowCount ?? 0;
    }
  }
  return created;
}

export async function dueEmailDeliveryIds(pool: Pool, now = new Date()): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `select id from deliveries
      where channel = 'email' and status in ('queued', 'retrying') and scheduled_for <= $1
      order by scheduled_for, created_at limit 200`,
    [now]
  );
  return result.rows.map((row) => row.id);
}

type DeliveryEvent = {
  delivery_id: string;
  idempotency_key: string;
  recipient: string;
  mode: string;
  schedule_bucket: string;
  user_id: string;
  title: string;
  summary: string;
  task_name: string;
  canonical_url: string | null;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMessage(rows: DeliveryEvent[], publicBaseUrl: string): EmailMessage {
  const first = rows[0]!;
  const digest = first.mode === "digest" || rows.length > 1;
  const subject = digest ? `Chitanda 摘要：${rows.length} 則新資訊` : `Chitanda：${first.title}`;
  const textItems = rows.map((row) => {
    const link = row.canonical_url ?? `${publicBaseUrl.replace(/\/$/, "")}/`;
    return `${row.title}\n${row.summary}\n${link}`;
  });
  const htmlItems = rows
    .map((row) => {
      const link = row.canonical_url ?? `${publicBaseUrl.replace(/\/$/, "")}/`;
      return `<article><h2>${escapeHtml(row.title)}</h2><p>${escapeHtml(row.summary)}</p><p><a href="${escapeHtml(link)}">查看來源</a> · ${escapeHtml(row.task_name)}</p></article>`;
    })
    .join("<hr>");
  const groupKey = createHash("sha256")
    .update(
      rows
        .map((row) => row.idempotency_key)
        .sort()
        .join("\0")
    )
    .digest("base64url");
  return {
    to: first.recipient,
    subject,
    text: `${subject}\n\n${textItems.join("\n\n---\n\n")}`,
    html: `<main><h1>${escapeHtml(subject)}</h1>${htmlItems}</main>`,
    idempotencyKey: groupKey
  };
}

export async function deliverEmail(
  pool: Pool,
  provider: EmailProvider,
  input: { deliveryId: string; attempt: number; maxAttempts: number; publicBaseUrl: string }
): Promise<"delivered" | "retrying" | "failed" | "skipped"> {
  const client = await pool.connect();
  let rows: DeliveryEvent[];
  try {
    await client.query("begin");
    const selected = await client.query<DeliveryEvent>(
      `select d.id as delivery_id, d.idempotency_key, d.recipient, d.mode,
              d.schedule_bucket, d.user_id, e.title, e.summary, t.name as task_name,
              si.canonical_url
         from deliveries d
         join events e on e.id = d.event_id
         join tasks t on t.id = e.task_id
         join source_items si on si.id = e.source_item_id
        where d.id = $1 and d.status in ('queued', 'retrying') and d.scheduled_for <= now()
        for update of d skip locked`,
      [input.deliveryId]
    );
    const first = selected.rows[0];
    if (!first) {
      await client.query("rollback");
      return "skipped";
    }
    if (first.mode === "digest") {
      const group = await client.query<DeliveryEvent>(
        `select d.id as delivery_id, d.idempotency_key, d.recipient, d.mode,
                d.schedule_bucket, d.user_id, e.title, e.summary, t.name as task_name,
                si.canonical_url
           from deliveries d
           join events e on e.id = d.event_id
           join tasks t on t.id = e.task_id
           join source_items si on si.id = e.source_item_id
          where d.user_id = $1 and d.channel = 'email' and d.mode = 'digest'
            and d.schedule_bucket = $2 and d.status in ('queued', 'retrying')
            and d.scheduled_for <= now()
          order by e.created_at
          for update of d skip locked`,
        [first.user_id, first.schedule_bucket]
      );
      rows = group.rows;
    } else {
      rows = selected.rows;
    }
    await client.query(
      `update deliveries set status = 'sending', attempt = $1, last_attempt_at = now(),
         error_code = null, error_message = null, updated_at = now()
       where id = any($2::uuid[])`,
      [input.attempt, rows.map((row) => row.delivery_id)]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  try {
    const receipt = await provider.send(renderMessage(rows, input.publicBaseUrl));
    await pool.query(
      `update deliveries set status = 'delivered', delivered_at = now(),
         provider_message_id = $1, updated_at = now()
       where id = any($2::uuid[]) and status = 'sending'`,
      [receipt.messageId, rows.map((row) => row.delivery_id)]
    );
    return "delivered";
  } catch (error) {
    const terminal = input.attempt >= input.maxAttempts;
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code).slice(0, 100)
        : "email_delivery_failed";
    const message = (error instanceof Error ? error.message : "Email delivery failed").slice(
      0,
      1000
    );
    await pool.query(
      `update deliveries set status = $1, error_code = $2, error_message = $3,
         updated_at = now() where id = any($4::uuid[]) and status = 'sending'`,
      [terminal ? "failed" : "retrying", code, message, rows.map((row) => row.delivery_id)]
    );
    return terminal ? "failed" : "retrying";
  }
}

export async function createSmtpEmailProvider(config: AppConfig): Promise<EmailProvider> {
  const smtp = config.notifications.email.smtp;
  const username = smtp.usernameFile ? await readSecretFile(smtp.usernameFile) : undefined;
  const password = smtp.passwordFile ? await readSecretFile(smtp.passwordFile) : undefined;
  if ((username && !password) || (!username && password)) {
    throw new Error("SMTP username and password secret files must be configured together");
  }
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    ...(username && password ? { auth: { user: username, pass: password } } : {})
  });
  return {
    async send(message) {
      const receipt = await transport.sendMail({
        from: config.notifications.email.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        messageId: `<${message.idempotencyKey}@chitanda.local>`
      });
      return { messageId: receipt.messageId || null };
    }
  };
}

export async function sendTestEmail(
  provider: EmailProvider,
  recipient: string
): Promise<EmailReceipt> {
  const idempotencyKey = createHash("sha256")
    .update(`smtp-test\0${recipient}\0${new Date().toISOString()}`)
    .digest("base64url");
  return provider.send({
    to: recipient,
    subject: "Chitanda SMTP 測試",
    text: "Chitanda 已成功使用這組 SMTP 設定寄出測試信。",
    html: "<p>Chitanda 已成功使用這組 SMTP 設定寄出測試信。</p>",
    idempotencyKey
  });
}
