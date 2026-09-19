import { describe, expect, it } from "vitest";
import { intervalMilliseconds, isScheduleDue, normalizedRecordHash } from "../src/index.js";

const record = {
  externalId: "1",
  canonicalUrl: "https://example.com/1",
  title: "Concert",
  content: "Tickets available",
  author: null,
  publishedAt: "2026-09-19T10:00:00.000Z",
  language: "en",
  media: [],
  metadata: { venue: "Arena", price: 1000 },
  rawPayload: { ignored: "raw representation" }
};

describe("collection identity", () => {
  it("hashes normalized content deterministically and ignores raw payload formatting", () => {
    expect(normalizedRecordHash(record)).toBe(
      normalizedRecordHash({
        ...record,
        metadata: { price: 1000, venue: "Arena" },
        rawPayload: "different"
      })
    );
    expect(normalizedRecordHash({ ...record, content: "Sold out" })).not.toBe(
      normalizedRecordHash(record)
    );
  });
});

describe("task schedules", () => {
  it("supports ISO duration intervals", () => {
    expect(intervalMilliseconds("PT6H")).toBe(21_600_000);
    expect(
      isScheduleDue(
        { type: "interval", value: "PT6H" },
        "Asia/Taipei",
        new Date("2026-09-19T00:00:00Z"),
        new Date("2026-09-19T06:00:00Z")
      )
    ).toBe(true);
  });

  it("supports cron schedules in the task timezone", () => {
    expect(
      isScheduleDue(
        { type: "cron", value: "0 9 * * *" },
        "Asia/Taipei",
        new Date("2026-09-18T01:01:00Z"),
        new Date("2026-09-19T01:00:00Z")
      )
    ).toBe(true);
  });
});
