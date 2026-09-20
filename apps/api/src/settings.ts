import type { Hono } from "hono";
import { sendTestEmail } from "@chitanda/notifications";
import { requireAuth } from "./auth.js";
import { ApiError, type ApiDependencies, type AppVariables } from "./context.js";

export function registerSettingsRoutes(
  app: Hono<{ Variables: AppVariables }>,
  dependencies: ApiDependencies
): void {
  const authentication = requireAuth(dependencies, { requireMfa: true, csrf: true });
  app.use("/api/settings/*", authentication);

  app.get("/api/settings/notifications", (context) =>
    context.json({
      email: {
        enabled: dependencies.config.notifications.email.enabled,
        from: dependencies.config.notifications.email.from
      },
      digestTime: dependencies.config.notifications.digestTime,
      quietHours: dependencies.config.notifications.quietHours
    })
  );

  app.post("/api/settings/notifications/email/test", async (context) => {
    if (!dependencies.config.notifications.email.enabled || !dependencies.emailProvider) {
      throw new ApiError(409, "email_notifications_disabled");
    }
    const auth = context.get("auth");
    try {
      const receipt = await sendTestEmail(dependencies.emailProvider, auth.email);
      await dependencies.database.pool.query(
        `insert into audit_logs (actor_user_id, action, target_type, target_id, request_id, metadata)
         values ($1, 'notification.email_test', 'user', $1, $2, $3::jsonb)`,
        [auth.userId, context.get("requestId"), JSON.stringify({ messageId: receipt.messageId })]
      );
      return context.json({ delivered: true, recipient: auth.email });
    } catch (error) {
      console.error("SMTP test failed", error);
      throw new ApiError(503, "email_delivery_failed");
    }
  });
}
