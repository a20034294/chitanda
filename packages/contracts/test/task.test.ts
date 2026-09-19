import { describe, expect, it } from "vitest";
import {
  interpretedTaskSchema,
  normalizedSourceRecordSchema,
  taskDefinitionV1Schema
} from "../src/index.js";

export const validDefinition = {
  schemaVersion: 1 as const,
  name: "台北平價演唱會",
  intent: "追蹤台北未來六個月票價低於新台幣 3000 元的演唱會",
  locale: "zh-TW",
  timezone: "Asia/Taipei",
  topics: ["演唱會"],
  entities: [{ type: "location", value: "台北", aliases: ["臺北"] }],
  sources: [{ connectorId: "search", query: { q: "台北 演唱會" } }],
  filters: {
    all: [{ field: "price", operator: "lte" as const, value: 3000, unit: "TWD" }],
    any: [],
    none: []
  },
  monitor: {
    schedule: { type: "interval" as const, value: "PT6H" },
    eventTypes: ["new_item" as const],
    lookback: "P6M"
  },
  analysis: {
    semanticMatch: true,
    minimumScore: 0.75,
    extractionFields: ["artist", "date", "price"]
  },
  delivery: [
    { channel: "in_app" as const, mode: "immediate" as const, minimumSeverity: "normal" as const }
  ]
};

describe("TaskDefinitionV1", () => {
  it("accepts a concert monitoring definition", () => {
    expect(taskDefinitionV1Schema.parse(validDefinition)).toEqual(validDefinition);
  });

  it("rejects unknown fields at every strict boundary", () => {
    expect(() => taskDefinitionV1Schema.parse({ ...validDefinition, executeNow: true })).toThrow();
  });

  it("requires at least one information source", () => {
    expect(() => taskDefinitionV1Schema.parse({ ...validDefinition, sources: [] })).toThrow();
  });

  it("requires clarification questions to be explicit", () => {
    expect(
      interpretedTaskSchema.parse({
        definition: validDefinition,
        summary: "監測台北演唱會",
        clarificationQuestions: ["通知是否也要寄 Email？"],
        warnings: [],
        confidence: 0.8
      }).clarificationQuestions
    ).toHaveLength(1);
  });
});

describe("NormalizedSourceRecord", () => {
  it("rejects non-HTTP source and media URLs", () => {
    const base = {
      externalId: "1",
      title: "Item",
      content: "",
      author: null,
      publishedAt: null,
      language: null,
      metadata: {},
      rawPayload: null
    };
    expect(() =>
      normalizedSourceRecordSchema.parse({
        ...base,
        canonicalUrl: "javascript:alert(1)",
        media: []
      })
    ).toThrow();
    expect(() =>
      normalizedSourceRecordSchema.parse({
        ...base,
        canonicalUrl: null,
        media: [{ url: "data:text/html,test", type: "text/html" }]
      })
    ).toThrow();
  });
});
