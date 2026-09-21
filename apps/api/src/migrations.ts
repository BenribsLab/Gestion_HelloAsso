import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "./config.js";
import { createDatabase, type Database } from "./db.js";

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

/**
 * Migrations appartenant à un module, suivies dans `extension_migrations` avec leur empreinte.
 * Réutilise la connexion du serveur : contrairement à `runMigrations`, n'ouvre pas de pool.
 */
export async function runExtensionMigrations(
  database: Database,
  extensionId: string,
  directory: string,
  filenames: string[]
) {
  if (filenames.length === 0) return;
  const appliedResult = await database.query<{ filename: string; checksum: string }>(
    "SELECT filename, checksum FROM extension_migrations WHERE extension_id = $1",
    [extensionId]
  );
  const applied = new Map(appliedResult.rows.map((row) => [row.filename, row.checksum]));

  for (const filename of [...filenames].sort()) {
    const migration = await readFile(join(directory, filename), "utf8");
    const checksum = createHash("sha256").update(migration).digest("hex");
    const previousChecksum = applied.get(filename);
    if (previousChecksum) {
      if (previousChecksum !== checksum) {
        throw new Error(
          `La migration ${filename} du module ${extensionId} a changé après son application.`
        );
      }
      continue;
    }
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query(migration);
      await client.query(
        "INSERT INTO extension_migrations (extension_id, filename, checksum) VALUES ($1, $2, $3)",
        [extensionId, filename, checksum]
      );
      await client.query("COMMIT");
      console.log(`Migration ${filename} du module ${extensionId} appliquée.`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
