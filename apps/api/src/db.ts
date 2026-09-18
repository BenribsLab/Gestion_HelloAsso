import pg from "pg";
import type { AppConfig } from "./config.js";

const { Pool } = pg;

export function createDatabase(config: AppConfig) {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000
  });
}

export type Database = ReturnType<typeof createDatabase>;
