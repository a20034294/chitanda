import { describe, expect, it } from "vitest";
import { loadConfig } from "@chitanda/config";
import { createApp } from "../src/app.js";

const defaultPath = new URL("../../../config/default.yaml", import.meta.url).pathname;

describe("API health", () => {
  it("reports liveness without checking dependencies", async () => {
    const config = await loadConfig({ defaultPath });
    const app = createApp({
      config,
      version: "test",
      readinessCheck: async () => {
        throw new Error("must not run");
      }
    });
    const response = await app.request("http://localhost/health/live");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ok", service: "api" });
  });

  it("reports failed readiness when PostgreSQL is unavailable", async () => {
    const config = await loadConfig({ defaultPath });
    const app = createApp({
      config,
      version: "test",
      readinessCheck: async () => {
        throw new Error("database unavailable");
      }
    });
    const response = await app.request("http://localhost/health/ready");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      checks: { database: "failed" }
    });
  });

  it("rejects requests for an unconfigured host", async () => {
    const config = await loadConfig({ defaultPath });
    const app = createApp({ config, version: "test", readinessCheck: async () => undefined });
    const response = await app.request("http://attacker.invalid/health/live");

    expect(response.status).toBe(400);
  });

  it("accepts unsafe local requests from the 127.0.0.1 development origins", async () => {
    const config = await loadConfig({ defaultPath });
    const app = createApp({ config, version: "test", readinessCheck: async () => undefined });
    const response = await app.request("http://127.0.0.1/api", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:5173" }
    });

    expect(response.status).toBe(404);
  });
});
