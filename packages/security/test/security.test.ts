import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from "../src/index.js";

describe("password hashing", () => {
  it("verifies the correct password and rejects a wrong password", async () => {
    const encoded = await hashPassword("a-long-test-password");
    await expect(verifyPassword(encoded, "a-long-test-password")).resolves.toBe(true);
    await expect(verifyPassword(encoded, "wrong-password")).resolves.toBe(false);
  });
});

describe("secret encryption", () => {
  it("round trips a secret with authenticated encryption", () => {
    const key = randomBytes(32).toString("base64");
    const encrypted = encryptSecret("smtp-password", key);

    expect(encrypted).not.toContain("smtp-password");
    expect(decryptSecret(encrypted, key)).toBe("smtp-password");
  });
});
