import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "./config.js";
import { createDatabase } from "./db.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = join(currentDirectory, "..", "migrations");

export async function runMigrations(config: AppConfig) {
  const database = createDatabase(config);
  try {
    await database.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const filenames = (await readdir(migrationsDirectory))
      .filter((filename) => filename.endsWith(".sql"))
      .sort();
    const appliedResult = await database.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations"
    );
    const applied = new Set(appliedResult.rows.map((row) => row.filename));

    for (const filename of filenames) {
      if (applied.has(filename)) continue;
      const migration = await readFile(join(migrationsDirectory, filename), "utf8");
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        await client.query(migration);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
        await client.query("COMMIT");
        console.log(`Migration ${filename} appliquée.`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await database.end();
  }
}
