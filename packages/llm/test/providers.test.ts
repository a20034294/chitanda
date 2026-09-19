import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { OllamaProvider, OpenAiProvider } from "../src/index.js";

const outputSchema = z.object({ answer: z.string() }).strict();
const servers: Array<ReturnType<typeof createServer>> = [];

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function mockServer(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
): Promise<string> {
  const server = createServer((request, response) => void handler(request, response));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

describe("LLM structured output providers", () => {
  it("sends a JSON Schema to Ollama and validates its response", async () => {
    const baseUrl = await mockServer(async (request, response) => {
      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      expect(request.url).toBe("/api/chat");
      expect(body.stream).toBe(false);
      expect(body.format).toMatchObject({ type: "object", additionalProperties: false });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          message: { content: '{"answer":"local"}' },
          prompt_eval_count: 8,
          eval_count: 3
        })
      );
    });
    const result = await new OllamaProvider(baseUrl).generateObject({
      model: "qwen3",
      system: "Return an answer",
      input: "test",
      schemaName: "answer",
      schema: outputSchema
    });
    expect(result.value).toEqual({ answer: "local" });
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 3 });
  });

  it("uses Responses structured output with storage disabled", async () => {
    const baseUrl = await mockServer(async (request, response) => {
      const body = JSON.parse(await readBody(request)) as {
        store: boolean;
        text: { format: Record<string, unknown> };
      };
      expect(request.url).toBe("/responses");
      expect(body.store).toBe(false);
      expect(body.text.format).toMatchObject({ type: "json_schema", name: "answer", strict: true });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "resp_test",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-test",
          output: [
            {
              id: "msg_test",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: '{"answer":"cloud"}', annotations: [] }]
            }
          ],
          usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 }
        })
      );
    });
    const directory = await mkdtemp(join(tmpdir(), "chitanda-openai-"));
    const keyFile = join(directory, "key");
    await writeFile(keyFile, "test-key\n", "utf8");
    const result = await new OpenAiProvider({
      apiKeyFile: keyFile,
      baseUrl,
      store: false
    }).generateObject({
      model: "gpt-test",
      system: "Return an answer",
      input: "test",
      schemaName: "answer",
      schema: outputSchema
    });
    expect(result.value).toEqual({ answer: "cloud" });
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  });
});
