import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/index.js";

const defaultConfig = `
server:
  host: 0.0.0.0
  port: 3000
  publicBaseUrl: http://localhost:3000
  allowedHosts: [localhost]
  allowedOrigins: [http://localhost:3000]
  trustedProxies: []
worker:
  healthHost: 0.0.0.0
  healthPort: 3001
  concurrency: 4
  pollIntervalMs: 1000
database:
  url: postgresql://localhost/chitanda
  poolMax: 10
  statementTimeoutMs: 30000
security:
  secureCookies: false
  requireAdminMfa: false
  bootstrapTokenFile: .secrets/bootstrap-token
  masterKeyFile: .secrets/master-key
  sessionTtlHours: 168
  csrfHeaderName: x-csrf-token
  loginRateLimit: { attempts: 5, windowSeconds: 900 }
  intentRateLimit: { attempts: 20, windowSeconds: 900 }
logging: { level: info }
llm:
  defaultProvider: ollama
  intentParser: { provider: ollama, model: qwen3 }
  ollama: { baseUrl: http://localhost:11434, model: qwen3 }
  openai:
    baseUrl: https://api.openai.com/v1
    apiKeyFile: .secrets/openai-api-key
    model: gpt-5.6-terra
    store: false
notifications:
  email:
    enabled: false
    from: Chitanda <chitanda@localhost>
    smtp: { host: localhost, port: 1025, secure: false }
`;

async function configFiles(
  override: string
): Promise<{ defaultPath: string; instancePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "chitanda-config-"));
  const defaultPath = join(directory, "default.yaml");
  const instancePath = join(directory, "instance.yaml");
  await Promise.all([
    writeFile(defaultPath, defaultConfig, "utf8"),
    writeFile(instancePath, override, "utf8")
  ]);
  return { defaultPath, instancePath };
}

describe("loadConfig", () => {
  it("deep merges one instance YAML over defaults", async () => {
    const paths = await configFiles("worker:\n  concurrency: 8\n");
    const config = await loadConfig(paths);

    expect(config.worker.concurrency).toBe(8);
    expect(config.worker.healthPort).toBe(3001);
  });

  it("requires secure cookies for a public HTTPS URL", async () => {
    const paths = await configFiles(`
server:
  publicBaseUrl: https://chitanda.example.com
  allowedHosts: [chitanda.example.com]
  allowedOrigins: [https://chitanda.example.com]
`);

    await expect(loadConfig(paths)).rejects.toThrow("secureCookies must be true");
  });
});
