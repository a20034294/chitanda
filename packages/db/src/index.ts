import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type DatabaseOptions = {
  url: string;
  poolMax: number;
  statementTimeoutMs: number;
};

export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(options: DatabaseOptions) {
  const pool = new Pool({
    connectionString: options.url,
    max: options.poolMax,
    statement_timeout: options.statementTimeoutMs,
    application_name: "chitanda"
  });
  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    async check(): Promise<void> {
      await pool.query("select 1");
    },
    async close(): Promise<void> {
      await pool.end();
    }
  };
}

export * from "./schema.js";
