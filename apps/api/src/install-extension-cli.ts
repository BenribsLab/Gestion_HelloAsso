import { stdin } from "node:process";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { installExtensionArchive } from "./extension-installer.js";
import { ExtensionRegistry } from "./extensions.js";
import { runMigrations } from "./migrations.js";

const maxArchiveBytes = 50 * 1024 * 1024;
const chunks: Buffer[] = [];
let size = 0;

for await (const chunk of stdin) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  size += buffer.length;
  if (size > maxArchiveBytes) throw new Error("Le paquet dépasse 50 Mo.");
  chunks.push(buffer);
}
if (size === 0) throw new Error("Aucun paquet n'a été transmis.");

const config = loadConfig();
await runMigrations(config);
const database = createDatabase(config);
try {
  const registry = await ExtensionRegistry.create(database, config);
  const result = await installExtensionArchive(Buffer.concat(chunks), database, config, registry);
  if (result.manifest.defaultEnabled) {
    const refreshedRegistry = await ExtensionRegistry.create(database, config);
    await refreshedRegistry.setEnabled(result.manifest.id, true);
  }
  process.stdout.write(JSON.stringify({
    id: result.manifest.id,
    version: result.manifest.version,
    packageHash: result.packageHash,
    signatureStatus: result.signatureStatus,
    enabled: result.manifest.defaultEnabled
  }) + "\n");
} finally {
  await database.end();
}
