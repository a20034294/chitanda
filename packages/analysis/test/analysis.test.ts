import { describe, expect, it } from "vitest";
import { changedRecordFields, evaluateCondition, evaluateFilters } from "../src/index.js";

const record = {
  externalId: "concert-1",
  canonicalUrl: "https://events.example/concert-1",
  title: "Tokyo Band 台北演唱會",
  content: "門票現正發售",
  author: null,
  publishedAt: "2026-09-19T10:00:00.000Z",
  language: "zh-TW",
  media: [],
  metadata: { city: "台北", price: 2500, currency: "TWD", availability: "in_stock" },
  rawPayload: {}
};

describe("deterministic filters", () => {
  it("evaluates numeric thresholds, units, any, and exclusions", () => {
    const result = evaluateFilters(
      {
        all: [{ field: "price", operator: "lte", value: 3000, unit: "TWD" }],
        any: [
          { field: "title", operator: "contains", value: "台北", unit: null },
          { field: "city", operator: "equals", value: "新北", unit: null }
        ],
        none: [{ field: "title", operator: "contains", value: "取消", unit: null }]
      },
      record
    );

    expect(result.matched).toBe(true);
    expect(result.all[0]).toMatchObject({ actual: 2500, matched: true });
  });

  it("supports date comparisons and rejects unsafe regular expressions", () => {
    expect(
      evaluateCondition(
        { field: "publishedAt", operator: "after", value: "2026-09-01", unit: null },
        record
      ).matched
    ).toBe(true);
    expect(
      evaluateCondition({ field: "title", operator: "regex", value: "(a+)+$", unit: null }, record)
    ).toMatchObject({ matched: false, reason: "unsafe_or_invalid_regex" });
  });

  it("reports exact normalized fields that changed", () => {
    expect(
      changedRecordFields({ ...record, metadata: { ...record.metadata, price: 4000 } }, record)
    ).toEqual(["metadata.price"]);
  });
});
