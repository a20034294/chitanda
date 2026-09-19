import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { readSecretFile } from "@chitanda/config";
import {
  createTotpUri,
  decryptSecret,
  encryptSecret,
  generateTotpSecret,
  hashPassword,
  verifyPassword,
  verifyTotp
} from "@chitanda/security";
import {
  ApiError,
  type ApiDependencies,
  type AppVariables,
  type AuthenticatedSession
} from "./context.js";

const SESSION_COOKIE = "chitanda_session";
const CSRF_COOKIE = "chitanda_csrf";

const bootstrapSchema = z
  .object({
    email: z.string().email().max(320),
    displayName: z.string().trim().min(1).max(100),
    password: z.string().min(12).max(1024)
  })
  .strict();

const loginSchema = z
  .object({
    email: z.string().email().max(320),
    password: z.string().min(1).max(1024),
    totp: z
      .string()
      .regex(/^\d{6}$/)
      .optional()
  })
  .strict();

const totpSchema = z.object({ token: z.string().regex(/^\d{6}$/) }).strict();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

async function jsonBody(context: Context): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}

function setSessionCookies(
  context: Context,
  config: ApiDependencies["config"],
  sessionToken: string,
  csrfToken: string,
  expires: Date
): void {
  const common = {
    path: "/",
    sameSite: "Strict" as const,
    secure: config.security.secureCookies,
    expires
  };
  setCookie(context, SESSION_COOKIE, sessionToken, { ...common, httpOnly: true });
  setCookie(context, CSRF_COOKIE, csrfToken, { ...common, httpOnly: false });
}

function clearSessionCookies(context: Context, config: ApiDependencies["config"]): void {
  const options = {
    path: "/",
    sameSite: "Strict" as const,
    secure: config.security.secureCookies
  };
  deleteCookie(context, SESSION_COOKIE, options);
  deleteCookie(context, CSRF_COOKIE, options);
}

async function createSession(
  context: Context,
  dependencies: ApiDependencies,
  userId: string,
  mfaVerified: boolean
): Promise<void> {
  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const expires = new Date(Date.now() + dependencies.config.security.sessionTtlHours * 3_600_000);
  await dependencies.database.pool.query(
    `insert into sessions (user_id, token_hash, csrf_token_hash, mfa_verified, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [userId, hashToken(sessionToken), hashToken(csrfToken), mfaVerified, expires]
  );
  setSessionCookies(context, dependencies.config, sessionToken, csrfToken, expires);
}

async function audit(
  dependencies: ApiDependencies,
  requestId: string,
  action: string,
  actorUserId: string | null,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await dependencies.database.pool.query(
    `insert into audit_logs (actor_user_id, action, request_id, metadata)
     values ($1, $2, $3, $4::jsonb)`,
    [actorUserId, action, requestId, JSON.stringify(metadata)]
  );
}

export async function consumeRateLimit(
  dependencies: ApiDependencies,
  bucket: string,
  subject: string,
  settings = dependencies.config.security.loginRateLimit
): Promise<void> {
  const subjectHash = hashToken(subject.toLowerCase());
  const result = await dependencies.database.pool.query<{ attempts: number }>(
    `insert into rate_limits (bucket, subject_hash, window_started_at, attempts, expires_at)
     values ($1, $2, now(), 1, now() + ($3 * interval '1 second'))
     on conflict (bucket, subject_hash) do update set
       attempts = case when rate_limits.expires_at <= now() then 1 else rate_limits.attempts + 1 end,
       window_started_at = case when rate_limits.expires_at <= now() then now() else rate_limits.window_started_at end,
       expires_at = case when rate_limits.expires_at <= now()
         then now() + ($3 * interval '1 second') else rate_limits.expires_at end
     returning attempts`,
    [bucket, subjectHash, settings.windowSeconds]
  );
  if ((result.rows[0]?.attempts ?? settings.attempts + 1) > settings.attempts) {
    throw new ApiError(429, "rate_limited");
  }
}

async function clearRateLimit(
  dependencies: ApiDependencies,
  bucket: string,
  subject: string
): Promise<void> {
  await dependencies.database.pool.query(
    "delete from rate_limits where bucket = $1 and subject_hash = $2",
    [bucket, hashToken(subject.toLowerCase())]
  );
}

async function authenticate(
  dependencies: ApiDependencies,
  token?: string
): Promise<AuthenticatedSession> {
  if (!token) throw new ApiError(401, "authentication_required");
  const result = await dependencies.database.pool.query<{
    session_id: string;
    user_id: string;
    email: string;
    display_name: string;
    role: string;
    mfa_enabled: boolean;
    mfa_verified: boolean;
    csrf_token_hash: string;
  }>(
    `select s.id as session_id, u.id as user_id, u.email, u.display_name, u.role,
            u.mfa_enabled, s.mfa_verified, s.csrf_token_hash
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now() and u.enabled = true`,
    [hashToken(token)]
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(401, "authentication_required");
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    mfaEnabled: row.mfa_enabled,
    mfaVerified: row.mfa_verified,
    csrfTokenHash: row.csrf_token_hash
  };
}

export function requireAuth(
  dependencies: ApiDependencies,
  options: { requireMfa?: boolean; csrf?: boolean } = {}
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const auth = await authenticate(dependencies, getCookie(context, SESSION_COOKIE));
    if (
      options.requireMfa &&
      dependencies.config.security.requireAdminMfa &&
      auth.role === "admin" &&
      (!auth.mfaEnabled || !auth.mfaVerified)
    ) {
      throw new ApiError(403, "mfa_required");
    }
    if (options.csrf && ["POST", "PUT", "PATCH", "DELETE"].includes(context.req.method)) {
      const header = context.req.header(dependencies.config.security.csrfHeaderName);
      const cookie = getCookie(context, CSRF_COOKIE);
      if (
        !header ||
        !cookie ||
        !constantTimeEqual(header, cookie) ||
        hashToken(header) !== auth.csrfTokenHash
      ) {
        throw new ApiError(403, "invalid_csrf_token");
      }
    }
    context.set("auth", auth);
    await next();
  };
}

export function registerAuthRoutes(
  app: Hono<{ Variables: AppVariables }>,
  dependencies: ApiDependencies
): void {
  app.get("/api/auth/bootstrap/status", async (context) => {
    const result = await dependencies.database.pool.query<{ exists: boolean }>(
      "select exists(select 1 from users) as exists"
    );
    return context.json({ required: !result.rows[0]?.exists });
  });

  app.post("/api/auth/bootstrap", async (context) => {
    const suppliedToken = context.req.header("x-bootstrap-token");
    const expectedToken = await readSecretFile(dependencies.config.security.bootstrapTokenFile);
    if (!suppliedToken || !constantTimeEqual(suppliedToken, expectedToken)) {
      throw new ApiError(403, "invalid_bootstrap_token");
    }
    const input = bootstrapSchema.parse(await jsonBody(context));
    const client = await dependencies.database.pool.connect();
    let userId: string;
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(1129074237)");
      const count = await client.query<{ count: string }>(
        "select count(*)::text as count from users"
      );
      if (count.rows[0]?.count !== "0") throw new ApiError(409, "bootstrap_already_completed");
      const passwordHash = await hashPassword(input.password);
      const created = await client.query<{ id: string }>(
        `insert into users (email, display_name, password_hash, role)
         values ($1, $2, $3, 'admin') returning id`,
        [input.email.toLowerCase(), input.displayName, passwordHash]
      );
      userId = created.rows[0]!.id;
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    await createSession(
      context,
      dependencies,
      userId,
      !dependencies.config.security.requireAdminMfa
    );
    await audit(dependencies, context.get("requestId"), "auth.bootstrap", userId);
    return context.json(
      { user: { id: userId, email: input.email.toLowerCase(), role: "admin" }, mfaRequired: true },
      201
    );
  });

  app.post("/api/auth/login", async (context) => {
    const input = loginSchema.parse(await jsonBody(context));
    await consumeRateLimit(dependencies, "login", input.email);
    const result = await dependencies.database.pool.query<{
      id: string;
      email: string;
      password_hash: string;
      role: string;
      mfa_enabled: boolean;
      mfa_secret_ciphertext: string | null;
      enabled: boolean;
    }>("select * from users where email = $1", [input.email.toLowerCase()]);
    const user = result.rows[0];
    if (!user?.enabled || !(await verifyPassword(user.password_hash, input.password))) {
      throw new ApiError(401, "invalid_credentials");
    }
    let mfaVerified = false;
    if (user.mfa_enabled) {
      if (!input.totp || !user.mfa_secret_ciphertext) throw new ApiError(401, "totp_required");
      const masterKey = await readSecretFile(dependencies.config.security.masterKeyFile);
      const secret = decryptSecret(user.mfa_secret_ciphertext, masterKey);
      if (!verifyTotp(secret, user.email, input.totp)) throw new ApiError(401, "invalid_totp");
      mfaVerified = true;
    }
    await clearRateLimit(dependencies, "login", input.email);
    await createSession(context, dependencies, user.id, mfaVerified);
    await audit(dependencies, context.get("requestId"), "auth.login", user.id);
    return context.json({ mfaRequired: user.role === "admin" && !user.mfa_enabled });
  });

  app.get("/api/auth/me", requireAuth(dependencies), (context) => {
    const auth = context.get("auth");
    return context.json({
      user: {
        id: auth.userId,
        email: auth.email,
        displayName: auth.displayName,
        role: auth.role,
        mfaEnabled: auth.mfaEnabled,
        mfaVerified: auth.mfaVerified,
        mfaRequired:
          dependencies.config.security.requireAdminMfa &&
          auth.role === "admin" &&
          (!auth.mfaEnabled || !auth.mfaVerified)
      }
    });
  });

  app.post("/api/auth/logout", requireAuth(dependencies, { csrf: true }), async (context) => {
    const auth = context.get("auth");
    await dependencies.database.pool.query("delete from sessions where id = $1", [auth.sessionId]);
    clearSessionCookies(context, dependencies.config);
    await audit(dependencies, context.get("requestId"), "auth.logout", auth.userId);
    return context.body(null, 204);
  });

  app.post("/api/auth/mfa/setup", requireAuth(dependencies, { csrf: true }), async (context) => {
    const auth = context.get("auth");
    const secret = generateTotpSecret();
    const masterKey = await readSecretFile(dependencies.config.security.masterKeyFile);
    await dependencies.database.pool.query(
      "update users set mfa_secret_ciphertext = $1, mfa_enabled = false, updated_at = now() where id = $2",
      [encryptSecret(secret, masterKey), auth.userId]
    );
    await audit(dependencies, context.get("requestId"), "auth.mfa.setup", auth.userId);
    return context.json({ secret, uri: createTotpUri(secret, auth.email) });
  });

  app.post("/api/auth/mfa/confirm", requireAuth(dependencies, { csrf: true }), async (context) => {
    const input = totpSchema.parse(await jsonBody(context));
    const auth = context.get("auth");
    const result = await dependencies.database.pool.query<{ mfa_secret_ciphertext: string | null }>(
      "select mfa_secret_ciphertext from users where id = $1",
      [auth.userId]
    );
    const ciphertext = result.rows[0]?.mfa_secret_ciphertext;
    if (!ciphertext) throw new ApiError(409, "mfa_setup_required");
    const masterKey = await readSecretFile(dependencies.config.security.masterKeyFile);
    const secret = decryptSecret(ciphertext, masterKey);
    if (!verifyTotp(secret, auth.email, input.token)) throw new ApiError(400, "invalid_totp");
    const client = await dependencies.database.pool.connect();
    try {
      await client.query("begin");
      await client.query("update users set mfa_enabled = true, updated_at = now() where id = $1", [
        auth.userId
      ]);
      await client.query("update sessions set mfa_verified = true where id = $1", [auth.sessionId]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    await audit(dependencies, context.get("requestId"), "auth.mfa.enabled", auth.userId);
    return context.json({ enabled: true });
  });
}
