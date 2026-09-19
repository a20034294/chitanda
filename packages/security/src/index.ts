import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { hash, verify, argon2id } from "argon2";
import * as OTPAuth from "otpauth";

const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1
} as const;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new Error("Password must contain at least 12 characters");
  }
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(encodedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(encodedHash, password);
  } catch {
    return false;
  }
}

export function generateTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

function createTotp(secret: string, accountName: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: "Chitanda",
    label: accountName,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret)
  });
}

export function createTotpUri(secret: string, accountName: string): string {
  return createTotp(secret, accountName).toString();
}

export function verifyTotp(secret: string, accountName: string, token: string): boolean {
  return createTotp(secret, accountName).validate({ token, window: 1 }) !== null;
}

export function encryptSecret(plaintext: string, base64Key: string): string {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new Error("Master key must be 32 bytes encoded as base64");
  }

  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    nonce.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url")
  ].join(".");
}

export function decryptSecret(payload: string, base64Key: string): string {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) {
    throw new Error("Master key must be 32 bytes encoded as base64");
  }

  const [version, nonceValue, tagValue, ciphertextValue] = payload.split(".");
  if (version !== "v1" || !nonceValue || !tagValue || !ciphertextValue) {
    throw new Error("Unsupported encrypted secret payload");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonceValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}
