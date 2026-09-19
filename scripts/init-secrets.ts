import { constants } from "node:fs";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const secretDirectory = resolve(".secrets");

async function createSecret(name: string, value: string): Promise<boolean> {
  const path = resolve(secretDirectory, name);
  try {
    await access(path, constants.F_OK);
    return false;
  } catch {
    await writeFile(path, `${value}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
    return true;
  }
}

await mkdir(secretDirectory, { recursive: true, mode: 0o700 });
const bootstrapCreated = await createSecret(
  "bootstrap-token",
  randomBytes(32).toString("base64url")
);
const masterCreated = await createSecret("master-key", randomBytes(32).toString("base64"));

process.stdout.write(
  `${bootstrapCreated ? "Created" : "Kept"} .secrets/bootstrap-token\n` +
    `${masterCreated ? "Created" : "Kept"} .secrets/master-key\n`
);
