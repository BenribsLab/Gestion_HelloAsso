import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import semver from "semver";
import * as yauzl from "yauzl";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Database } from "./db.js";
import { coreVersion, ExtensionRegistryError, parseExtensionManifest, type ExtensionManifest, type ExtensionRegistry } from "./extensions.js";

const maxArchiveBytes = 50 * 1024 * 1024;
const maxExpandedBytes = 150 * 1024 * 1024;
const maxEntryBytes = 30 * 1024 * 1024;
const maxFiles = 500;
const signatureSchema = z.object({
  schemaVersion: z.literal(1),
  algorithm: z.literal("Ed25519"),
  signature: z.string().min(40).max(500),
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).refine((files) => Object.keys(files).length <= maxFiles)
}).strict();
const idSchema = z.object({ extensionId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80) });

type InstallMarker = { signatureStatus: "verified" | "unsigned"; packageHash: string; installedAt: string };

export function registerExtensionInstaller(server: FastifyInstance, database: Database, config: AppConfig, registry: ExtensionRegistry) {
  server.post("/api/extensions/install", {
    bodyLimit: maxArchiveBytes + 1024 * 1024,
    config: { rateLimit: { max: 5, timeWindow: "1 hour" } }
  }, async (request, reply) => {
    const part = await request.file({ limits: { files: 1, fileSize: maxArchiveBytes, parts: 2 } });
    if (!part) return reply.code(400).send({ message: "Choisissez un paquet .gu-plugin." });
    if (!part.filename.toLocaleLowerCase("fr").endsWith(".gu-plugin")) {
      return reply.code(400).send({ message: "Le fichier doit porter l'extension .gu-plugin." });
    }
    const archive = await part.toBuffer();
    const packageHash = createHash("sha256").update(archive).digest("hex");
    let result: Awaited<ReturnType<typeof installPackage>>;
    try {
      result = await installPackage(archive, packageHash, database, config, registry);
      await audit(database, result.manifest.id, result.manifest.version, "installed", result.signatureStatus === "verified" ? "signed" : "developer", packageHash, null);
    } catch (error) {
      const message = safeError(error);
      await audit(database, null, null, "failed", config.extensions.allowUnsigned ? "developer" : "signed", packageHash, message);
      const status = error instanceof ExtensionRegistryError
        ? error.statusCode
        : /sign|cl[eé] publique/i.test(message)
        ? 403
        : /d[eé]pendance|version du c(?:œ|oe)ur|migration.+chang/i.test(message)
          ? 409
          : 400;
      return reply.code(status).send({ message });
    }
    reply.code(201).send({
      id: result.manifest.id,
      version: result.manifest.version,
      signatureStatus: result.signatureStatus,
      restartScheduled: config.nodeEnv === "production"
    });
    scheduleRestart(config);
  });

  server.get("/api/extensions/installations", async () => {
    const result = await database.query(`
      SELECT id, extension_id AS "extensionId", version, outcome, source,
             package_hash AS "packageHash", message, created_at AS "createdAt"
      FROM extension_installations ORDER BY created_at DESC LIMIT 100
    `);
    return { items: result.rows };
  });

  server.get("/api/extensions/:extensionId/rollbacks", async (request) => {
    const { extensionId } = idSchema.parse(request.params);
    return { items: await rollbackVersions(config, extensionId) };
  });

  server.post("/api/extensions/:extensionId/rollback", async (request, reply) => {
    const { extensionId } = idSchema.parse(request.params);
    const input = z.object({ directory: z.string().regex(/^[a-zA-Z0-9._-]+$/).max(150) }).parse(request.body);
    const rollbackRoot = join(resolve(config.extensions.directory), ".rollback", extensionId);
    const source = containedPath(rollbackRoot, input.directory);
    const manifest = parseExtensionManifest(JSON.parse(await readFile(join(source, "plugin.json"), "utf8")));
    if (manifest.id !== extensionId) throw new Error("Le paquet de retour arrière ne correspond pas à cette extension.");
    const target = join(resolve(config.extensions.directory), extensionId);
    const displaced = join(rollbackRoot, `${Date.now()}-${safeSegment(registry.manifest(extensionId)?.version ?? "current")}`);
    await mkdir(rollbackRoot, { recursive: true });
    if (await exists(target)) await rename(target, displaced);
    try { await rename(source, target); }
    catch (error) { if (await exists(displaced)) await rename(displaced, target); throw error; }
    await database.query(
      "UPDATE installed_extensions SET version = $2, source = 'local', manifest_json = $3::jsonb, updated_at = now(), error_message = NULL WHERE id = $1",
      [extensionId, manifest.version, JSON.stringify(manifest)]
    );
    await audit(database, extensionId, manifest.version, "rolled_back", "signed", null, null);
    await pruneRollbackVersions(config, extensionId, 3);
    reply.send({ id: extensionId, version: manifest.version, restartScheduled: config.nodeEnv === "production" });
    scheduleRestart(config);
  });
}

async function installPackage(archive: Buffer, packageHash: string, database: Database, config: AppConfig, registry: ExtensionRegistry) {
  const root = resolve(config.extensions.directory);
  await mkdir(root, { recursive: true });
  const staging = join(root, `.staging-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    const hashes = await extractArchive(archive, staging);
    const manifest = parseExtensionManifest(JSON.parse(await readFile(join(staging, "plugin.json"), "utf8")));
    validateCompatibility(manifest, registry);
    const signatureStatus = await verifyPackageSignature(staging, manifest, hashes, config);
    const licenseStatus = await registry.authorizeInstallation(manifest);
    const marker: InstallMarker = { signatureStatus, packageHash, installedAt: new Date().toISOString() };
    await writeFile(join(staging, ".gu-install.json"), JSON.stringify(marker), { encoding: "utf8", mode: 0o600 });
    await applyAndActivate(staging, manifest, packageHash, signatureStatus, licenseStatus, database, config);
    await pruneRollbackVersions(config, manifest.id, 3);
    return { manifest, signatureStatus };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function extractArchive(archive: Buffer, destination: string) {
  const zip = await openZip(archive);
  const hashes = new Map<string, string>();
  let expanded = 0;
  let files = 0;
  return new Promise<Map<string, string>>((resolvePromise, reject) => {
    let settled = false;
    const fail = (error: unknown) => { if (!settled) { settled = true; zip.close(); reject(error); } };
    zip.on("error", fail);
    zip.on("end", () => { if (!settled) { settled = true; resolvePromise(hashes); } });
    zip.on("entry", (entry) => {
      void (async () => {
        const path = validateEntry(entry);
        expanded += entry.uncompressedSize;
        if (expanded > maxExpandedBytes) throw new Error("Le paquet décompressé dépasse 150 Mo.");
        if (path.endsWith("/")) { await mkdir(containedPath(destination, path), { recursive: true }); zip.readEntry(); return; }
        files += 1;
        if (files > maxFiles) throw new Error("Le paquet contient trop de fichiers.");
        const content = await readEntry(zip, entry);
        const target = containedPath(destination, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, { mode: 0o600 });
        hashes.set(path, createHash("sha256").update(content).digest("hex"));
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}

function validateEntry(entry: yauzl.Entry) {
  const path = entry.fileName;
  if (!path || path.includes("\\") || path.includes("\0") || isAbsolute(path) || /^[a-z]:/i.test(path)) throw new Error("Le paquet contient un chemin interdit.");
  if (path.split("/").some((segment) => segment === ".." || segment === "" && !path.endsWith("/"))) throw new Error("Le paquet contient une traversée de chemin.");
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if ((unixMode & 0o170000) === 0o120000) throw new Error("Les liens symboliques sont interdits dans un paquet.");
  if (entry.uncompressedSize > maxEntryBytes) throw new Error(`Le fichier ${path} dépasse 30 Mo.`);
  if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 200) throw new Error(`Le fichier ${path} a un taux de compression dangereux.`);
  return path;
}

async function verifyPackageSignature(destination: string, manifest: ExtensionManifest, hashes: Map<string, string>, config: AppConfig) {
  const signaturePath = join(destination, "signature.json");
  if (!await exists(signaturePath)) {
    if (!config.extensions.allowUnsigned) throw new Error("Ce paquet n'est pas signé par une clé autorisée.");
    return "unsigned" as const;
  }
  if (!config.extensions.licensePublicKey) throw new Error("Aucune clé publique n'est configurée pour vérifier ce paquet.");
  const signature = signatureSchema.parse(JSON.parse(await readFile(signaturePath, "utf8")));
  const actual = Object.fromEntries([...hashes.entries()].filter(([path]) => path !== "signature.json").sort(([left], [right]) => left.localeCompare(right)));
  if (JSON.stringify(actual) !== JSON.stringify(Object.fromEntries(Object.entries(signature.files).sort(([left], [right]) => left.localeCompare(right))))) {
    throw new Error("La liste ou l'empreinte des fichiers du paquet ne correspond pas à la signature.");
  }
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, id: manifest.id, version: manifest.version, files: actual }), "utf8");
  if (!verify(null, payload, createPublicKey(config.extensions.licensePublicKey), Buffer.from(signature.signature, "base64"))) {
    throw new Error("La signature Ed25519 du paquet est invalide.");
  }
  return "verified" as const;
}

function validateCompatibility(manifest: ExtensionManifest, registry: ExtensionRegistry) {
  if (!semver.satisfies(coreVersion, `>=${manifest.core.minimum}${manifest.core.maximum ? ` <=${manifest.core.maximum}` : ""}`)) {
    throw new Error(`Le module requiert une version du cœur comprise entre ${manifest.core.minimum} et ${manifest.core.maximum ?? "la dernière version"}.`);
  }
  const missing = manifest.dependencies.filter((dependency) => !registry.manifest(dependency));
  if (missing.length > 0) throw new Error(`Dépendances absentes : ${missing.join(", ")}.`);
  for (const migration of manifest.migrations) {
    if (migration.includes("/") || migration.includes("\\") || !migration.endsWith(".sql")) throw new Error("Nom de migration invalide.");
  }
}

async function applyAndActivate(staging: string, manifest: ExtensionManifest, packageHash: string, signatureStatus: "verified" | "unsigned", licenseStatus: "local" | "valid" | "grace" | "expired" | "unavailable", database: Database, config: AppConfig) {
  const root = resolve(config.extensions.directory);
  const target = join(root, manifest.id);
  const rollbackRoot = join(root, ".rollback", manifest.id);
  const backup = join(rollbackRoot, `${Date.now()}-${safeSegment(manifest.version)}`);
  await mkdir(rollbackRoot, { recursive: true });
  const client = await database.connect();
  let displaced = false;
  let activated = false;
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO installed_extensions (id, version, enabled, source, manifest_json, package_hash, signature_status, entitlement_key, license_status)
      VALUES ($1, $2, false, $3, $4::jsonb, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, source = EXCLUDED.source,
        manifest_json = EXCLUDED.manifest_json, package_hash = EXCLUDED.package_hash,
        signature_status = EXCLUDED.signature_status, entitlement_key = EXCLUDED.entitlement_key,
        license_status = EXCLUDED.license_status,
        error_message = NULL, updated_at = now()
    `, [manifest.id, manifest.version, signatureStatus === "verified" ? "central" : "local", JSON.stringify(manifest), packageHash, signatureStatus, manifest.entitlementKey, licenseStatus]);
    const applied = await client.query<{ filename: string; checksum: string }>("SELECT filename, checksum FROM extension_migrations WHERE extension_id = $1", [manifest.id]);
    const previous = new Map(applied.rows.map((row) => [row.filename, row.checksum]));
    for (const filename of [...manifest.migrations].sort()) {
      const sql = await readFile(join(staging, "migrations", filename), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      if (previous.has(filename) && previous.get(filename) !== checksum) throw new Error(`La migration ${filename} a changé après son application.`);
      if (!previous.has(filename)) {
        await client.query(sql);
        await client.query("INSERT INTO extension_migrations (extension_id, filename, checksum) VALUES ($1, $2, $3)", [manifest.id, filename, checksum]);
      }
    }
    if (await exists(target)) { await rename(target, backup); displaced = true; }
    await rename(staging, target); activated = true;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (activated) await rm(target, { recursive: true, force: true });
    if (displaced && await exists(backup)) await rename(backup, target);
    throw error;
  } finally { client.release(); }
}

async function rollbackVersions(config: AppConfig, extensionId: string) {
  const root = join(resolve(config.extensions.directory), ".rollback", extensionId);
  if (!await exists(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const manifest = parseExtensionManifest(JSON.parse(await readFile(join(root, entry.name, "plugin.json"), "utf8")));
    return { directory: entry.name, version: manifest.version };
  }));
}

async function pruneRollbackVersions(config: AppConfig, extensionId: string, keep: number) {
  const root = join(resolve(config.extensions.directory), ".rollback", extensionId);
  if (!await exists(root)) return;
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => right.name.localeCompare(left.name));
  for (const entry of entries.slice(keep)) {
    await rm(containedPath(root, entry.name), { recursive: true, force: true });
  }
}

function openZip(buffer: Buffer) {
  return new Promise<yauzl.ZipFile>((resolvePromise, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => error || !zip ? reject(error ?? new Error("Archive illisible.")) : resolvePromise(zip)));
}

function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry) {
  return new Promise<Buffer>((resolvePromise, reject) => zip.openReadStream(entry, (error, stream) => {
    if (error || !stream) { reject(error ?? new Error("Fichier illisible.")); return; }
    const chunks: Buffer[] = []; let size = 0;
    stream.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxEntryBytes) stream.destroy(new Error("Fichier trop volumineux.")); else chunks.push(chunk); });
    stream.on("error", reject); stream.on("end", () => resolvePromise(Buffer.concat(chunks)));
  }));
}

function containedPath(baseValue: string, child: string) {
  const base = resolve(baseValue); const target = resolve(base, child);
  if (target !== base && !target.startsWith(base + sep)) throw new Error("Chemin hors du dossier autorisé.");
  return target;
}

async function exists(path: string) { try { await stat(path); return true; } catch { return false; } }
function safeSegment(value: string) { return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80); }
function safeError(error: unknown) { return (error instanceof Error ? error.message : "Installation impossible.").slice(0, 500); }
function scheduleRestart(config: AppConfig) { if (config.nodeEnv === "production") setTimeout(() => process.exit(75), 1200).unref(); }
async function audit(database: Database, extensionId: string | null, version: string | null, outcome: string, source: string, packageHash: string | null, message: string | null) {
  await database.query("INSERT INTO extension_installations (extension_id, version, outcome, source, package_hash, message) VALUES ($1, $2, $3, $4, $5, $6)", [extensionId, version, outcome, source, packageHash, message]);
}
