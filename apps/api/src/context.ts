import type { AppConfig } from "@chitanda/config";
import type { Database } from "@chitanda/db";
import type { LlmProvider } from "@chitanda/llm";

export type AuthenticatedSession = {
  sessionId: string;
  userId: string;
  email: string;
  displayName: string;
  role: string;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  csrfTokenHash: string;
};

export type AppVariables = {
  requestId: string;
  auth: AuthenticatedSession;
};

export type ApiDependencies = {
  config: AppConfig;
  database: Database;
  providers: Map<string, LlmProvider>;
  queueCollectionRun: (input: { runId: string; taskId: string }) => Promise<void>;
};

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    readonly code: string,
    message = code
  ) {
    super(message);
  }
}
