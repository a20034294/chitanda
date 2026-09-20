import { describe, expect, it } from "vitest";
import { calculateDeliverySchedule } from "../src/index.js";

const settings = {
  digestTime: "18:00",
  quietHours: { enabled: true, start: "22:00", end: "08:00" }
} as const;

describe("delivery schedule", () => {
  it("moves an immediate notification to the end of Singapore quiet hours", () => {
    const result = calculateDeliverySchedule(
      "immediate",
      "Asia/Singapore",
      new Date("2026-09-20T15:15:00.000Z"),
      settings
    );
    expect(result.scheduledFor.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(result.scheduleBucket).toBe("immediate");
  });

  it("schedules a digest for the next local digest time", () => {
    const result = calculateDeliverySchedule(
      "digest",
      "Asia/Singapore",
      new Date("2026-09-20T08:00:00.000Z"),
      settings
    );
    expect(result.scheduledFor.toISOString()).toBe("2026-09-20T10:00:00.000Z");
    expect(result.scheduleBucket).toBe("digest:2026-09-20");
  });
});
