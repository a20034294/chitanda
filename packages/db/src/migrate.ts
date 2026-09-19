import { loadConfig } from "@chitanda/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "./index.js";

const instancePath = process.env.CHITANDA_CONFIG_FILE;
const config = await loadConfig(instancePath ? { instancePath } : {});
const database = createDatabase(config.database);

try {
  await migrate(database.db, { migrationsFolder: "packages/db/migrations" });
  process.stdout.write("Database migrations completed\n");
} finally {
  await database.close();
}
