import { readFile, readdir } from "node:fs/promises";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import type { Dirent } from "node:fs";
import { resolve, join } from "node:path";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Database } from "./db.js";

const extensionIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80);

// Chemin relatif strict : chaque segment doit commencer par un caractère alphanumérique,
// ce qui exclut « .. », les chemins absolus et les segments cachés.
const packagePathSchema = z.string()
  .regex(/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i)
  .max(200);
const routePrefixSchema = z.string().regex(/^\/api\/[a-z0-9-]+(?:\/[a-z0-9:-]+)*$/i).max(200);

export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: extensionIdSchema,
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(500),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i),
  core: z.object({
    minimum: z.string().regex(/^\d+\.\d+\.\d+$/),
    maximum: z.string().regex(/^\d+\.\d+\.\d+$/).optional()
  }).strict(),
  dependencies: z.array(extensionIdSchema).max(20).default([]),
  optionalDependencies: z.array(extensionIdSchema).max(20).default([]),
  capabilities: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).max(30).default([]),
  entitlementKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  defaultEnabled: z.boolean().default(false),
  // Facultatifs : un module encore compilé dans le noyau n'a qu'un manifeste.
  entrypoints: z.object({
    server: packagePathSchema.optional(),
    web: packagePathSchema.optional(),
    styles: packagePathSchema.optional()
  }).strict().default({}),
  migrations: z.array(packagePathSchema).max(100).default([]),
  routes: z.array(routePrefixSchema).max(50).default([])
}).strict();

export type ExtensionManifest = z.infer<typeof manifestSchema>;
export const coreVersion = "0.1.0";

export function parseExtensionManifest(value: unknown) {
  return manifestSchema.parse(value);
}

export type ExtensionState = ExtensionManifest & {
  enabled: boolean;
  source: "bundled" | "local" | "central";
  signatureStatus: "bundled" | "verified" | "unsigned" | "invalid";
  licenseStatus: "local" | "valid" | "grace" | "expired" | "unavailable";
  installedAt: Date;
  updatedAt: Date;
  errorMessage: string | null;
};

type StoredExtension = {
  id: string;
  version: string;
  enabled: boolean;
  source: ExtensionState["source"];
  manifest: unknown;
  signatureStatus: ExtensionState["signatureStatus"];
  licenseStatus: ExtensionState["licenseStatus"];
  installedAt: Date;
  updatedAt: Date;
  errorMessage: string | null;
};

export type EntitlementDecision = {
  allowed: boolean;
  status: ExtensionState["licenseStatus"];
  reason?: string;
};

export interface EntitlementProvider {
  check(manifest: ExtensionManifest): Promise<EntitlementDecision>;
}

class LocalEntitlementProvider implements EntitlementProvider {
  async check(_manifest: ExtensionManifest): Promise<EntitlementDecision> {
    return { allowed: true, status: "local" };
  }
}

type CachedEntitlement = { token: string; refreshedAt: string };

/**
 * Vérifie le droit d'usage auprès du serveur central, avec cache et période de grâce : une
 * panne réseau ne doit jamais couper une fonctionnalité déjà payée.
 *
 * N'est utilisé que si EXTENSION_CATALOG_URL et EXTENSION_LICENSE_PUBLIC_KEY sont renseignés.
 */
class CentralEntitlementProvider implements EntitlementProvider {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig
  ) {}

  async check(manifest: ExtensionManifest): Promise<EntitlementDecision> {
    const cached = await this.readCache(manifest.id);
    const fresh = await this.fetchToken(manifest).catch(() => null);
    const token = fresh ?? cached?.token ?? null;
    if (!token) {
      return { allowed: false, status: "unavailable", reason: "Aucun droit d'usage n'a pu être obtenu pour ce module." };
    }
    if (fresh) await this.writeCache(manifest.id, fresh);

    const payload = verifyEntitlementToken(token, this.config.extensions.licensePublicKey ?? "");
    const installationId = await this.installationId();
    if (!payload
      || payload.entitlementKey !== manifest.entitlementKey
      || payload.extensionId !== manifest.id
      || payload.installationId !== installationId) {
      return { allowed: false, status: "expired", reason: "Le droit d'usage de ce module est invalide." };
    }

    const now = Date.now();
    if (Date.parse(payload.expiresAt) >= now) return { allowed: true, status: fresh ? "valid" : "grace" };

    // Jeton expiré : on tolère la période de grâce à partir du dernier contact réussi.
    const graceMs = this.config.extensions.offlineGraceDays * 86_400_000;
    const lastContact = Date.parse(cached?.refreshedAt ?? payload.issuedAt);
    if (now - lastContact <= graceMs) return { allowed: true, status: "grace" };
    return { allowed: false, status: "expired", reason: "L'abonnement de ce module a expiré." };
  }

  private async fetchToken(manifest: ExtensionManifest) {
    const catalogUrl = this.config.extensions.catalogUrl;
    const licenseToken = this.config.extensions.licenseToken;
    if (!catalogUrl || !licenseToken) return null;
    const response = await fetch(new URL("/entitlements/check", catalogUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${licenseToken}` },
      body: JSON.stringify({
        installationId: await this.installationId(),
        coreVersion: "0.1.0",
        extensions: [{ id: manifest.id, version: manifest.version, entitlementKey: manifest.entitlementKey }]
      }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return null;
    const body = await response.json() as { tokens?: Record<string, string> };
    return body.tokens?.[manifest.id] ?? null;
  }

  /** Identifiant d'installation anonyme, généré une fois et conservé localement. */
  private async installationId() {
    const result = await this.database.query<{ value: string }>(
      "SELECT value #>> '{}' AS value FROM app_settings WHERE key = 'installation_id'"
    );
    const existing = result.rows[0]?.value;
    if (existing) return existing;
    const generated = randomUUID();
    await this.database.query(
      `INSERT INTO app_settings (key, value) VALUES ('installation_id', $1::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [JSON.stringify(generated)]
    );
    return generated;
  }

  private async readCache(extensionId: string): Promise<CachedEntitlement | null> {
    const result = await this.database.query<{ value: Record<string, CachedEntitlement> }>(
      "SELECT value FROM app_settings WHERE key = 'extension_entitlements'"
    );
    return result.rows[0]?.value?.[extensionId] ?? null;
  }

  private async writeCache(extensionId: string, token: string) {
    await this.database.query(
      `INSERT INTO app_settings (key, value)
       VALUES ('extension_entitlements', jsonb_build_object($1::text, $2::jsonb))
       ON CONFLICT (key) DO UPDATE
       SET value = app_settings.value || jsonb_build_object($1::text, $2::jsonb), updated_at = now()`,
      [extensionId, JSON.stringify({ token, refreshedAt: new Date().toISOString() })]
    );
  }
}

type EntitlementTokenPayload = {
  version: number;
  installationId: string;
  extensionId: string;
  entitlementKey: string;
  issuedAt: string;
  expiresAt: string;
};

/** Vérification hors ligne du jeton Ed25519 émis par le serveur central. */
export function verifyEntitlementToken(token: string, publicKeyPem: string): EntitlementTokenPayload | null {
  if (!publicKeyPem) return null;
  const separator = token.indexOf(".");
  if (separator <= 0) return null;
  try {
    const body = Buffer.from(token.slice(0, separator), "base64url");
    const signature = Buffer.from(token.slice(separator + 1), "base64url");
    if (!verify(null, body, createPublicKey(publicKeyPem), signature)) return null;
    const payload = JSON.parse(body.toString("utf8")) as EntitlementTokenPayload;
    return payload.version === 1 ? payload : null;
  } catch {
    return null;
  }
}

export class ExtensionRegistry {
  private readonly enabledIds = new Set<string>();
  private readonly manifests = new Map<string, ExtensionManifest>();
  private readonly directories = new Map<string, string>();

  private constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly entitlements: EntitlementProvider
  ) {}

  static async create(database: Database, config: AppConfig) {
    // Le serveur central n'est interrogé que s'il est configuré : sinon, fonctionnement local.
    const entitlements = config.extensions.catalogUrl && config.extensions.licensePublicKey
      ? new CentralEntitlementProvider(database, config)
      : new LocalEntitlementProvider();
    const registry = new ExtensionRegistry(database, config, entitlements);
    await registry.synchronizeBundledExtensions();
    await registry.refreshEnabledIds();
    return registry;
  }

  isEnabled(extensionId: string) {
    return this.enabledIds.has(extensionId);
  }

  /** Modules présents sur le disque, avec le dossier d'où ils ont été lus. */
  installed() {
    return [...this.manifests.values()].map((manifest) => ({
      manifest,
      directory: this.directories.get(manifest.id)!,
      enabled: this.isEnabled(manifest.id)
    }));
  }

  packageDirectory(extensionId: string) {
    return this.directories.get(extensionId) ?? null;
  }

  manifest(extensionId: string) {
    return this.manifests.get(extensionId) ?? null;
  }

  /** Vérifie un droit avant d'installer ou de mettre à jour un paquet. */
  async authorizeInstallation(manifest: ExtensionManifest) {
    const entitlement = await this.entitlements.check(manifest);
    if (!entitlement.allowed) {
      throw new ExtensionRegistryError(403, entitlement.reason ?? "La licence de cette extension n'est pas valide.");
    }
    return entitlement.status;
  }

  /**
   * Module propriétaire d'un chemin : d'abord les motifs déclarés au manifeste, puis la
   * table historique pour les modules encore compilés dans le noyau.
   */
  extensionForPath(path: string) {
    for (const manifest of this.manifests.values()) {
      for (const route of manifest.routes) {
        if (routeMatchesPath(route, path)) return manifest.id;
      }
    }
    return extensionForRequest(path);
  }

  async list(): Promise<ExtensionState[]> {
    const result = await this.database.query<StoredExtension>(`
      SELECT id, version, enabled, source, manifest_json AS manifest,
             signature_status AS "signatureStatus", license_status AS "licenseStatus",
             installed_at AS "installedAt", updated_at AS "updatedAt",
             error_message AS "errorMessage"
      FROM installed_extensions
      ORDER BY lower(manifest_json->>'name'), id
    `);
    return result.rows.map((row) => ({
      ...manifestSchema.parse(row.manifest),
      enabled: row.enabled,
      source: row.source,
      signatureStatus: row.signatureStatus,
      licenseStatus: row.licenseStatus,
      installedAt: row.installedAt,
      updatedAt: row.updatedAt,
      errorMessage: row.errorMessage
    }));
  }

  async setEnabled(extensionId: string, enabled: boolean) {
    const manifest = this.manifests.get(extensionId);
    if (!manifest) throw new ExtensionRegistryError(404, "Cette extension n'est pas installée.");

    if (enabled) {
      const missingDependencies = manifest.dependencies.filter((dependency) => !this.isEnabled(dependency));
      if (missingDependencies.length > 0) {
        throw new ExtensionRegistryError(409, `Activez d'abord : ${missingDependencies.join(", ")}.`);
      }
      const entitlement = await this.entitlements.check(manifest);
      if (!entitlement.allowed) {
        throw new ExtensionRegistryError(403, entitlement.reason ?? "La licence de cette extension n'est pas valide.");
      }
      await this.database.query(`
        UPDATE installed_extensions
        SET enabled = true, license_status = $2, last_checked_at = now(),
            error_message = NULL, updated_at = now()
        WHERE id = $1
      `, [extensionId, entitlement.status]);
    } else {
      const dependent = [...this.manifests.values()].find(
        (candidate) => this.isEnabled(candidate.id) && candidate.dependencies.includes(extensionId)
      );
      if (dependent) {
        throw new ExtensionRegistryError(409, `Désactivez d'abord l'extension « ${dependent.name} ».`);
      }
      await this.database.query(
        "UPDATE installed_extensions SET enabled = false, updated_at = now() WHERE id = $1",
        [extensionId]
      );
    }
    await this.refreshEnabledIds();
    return (await this.list()).find((extension) => extension.id === extensionId)!;
  }

  configuration() {
    return {
      centralServerConfigured: Boolean(this.config.extensions.catalogUrl && this.config.extensions.licenseToken),
      catalogUrl: this.config.extensions.catalogUrl,
      offlineGraceDays: this.config.extensions.offlineGraceDays,
      allowUnsigned: this.config.extensions.allowUnsigned
    };
  }

  private async synchronizeBundledExtensions() {
    // Un paquet déposé dans le volume persistant est du code exécutable. Tant qu'une
    // signature de paquet n'a pas été vérifiée, il ne doit être chargé que dans le mode de
    // développement explicitement prévu à cet effet.
    const localIds = await this.readManifestDirectory(
      resolve(this.config.extensions.directory),
      "local",
      undefined,
      !this.config.extensions.allowUnsigned
    );

    // Le dossier bundled est livré en lecture seule avec l'image. En mode développeur, un
    // manifeste local du même identifiant est prioritaire ; en production il est ignoré.
    await this.readManifestDirectory(
      resolve(this.config.extensions.bundledDirectory),
      "bundled",
      localIds
    );

    if (!this.config.extensions.allowUnsigned) {
      await this.database.query(`
        UPDATE installed_extensions
        SET enabled = false,
            error_message = 'Extension locale non signée refusée. Activez explicitement le mode développement pour la charger.',
            updated_at = now()
        WHERE source = 'local' AND signature_status = 'unsigned'
      `);
    }
  }

  private async readManifestDirectory(
    directory: string,
    source: "bundled" | "local",
    skipIds?: ReadonlySet<string>,
    requireVerified = false
  ) {
    const ids = new Set<string>();
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (source === "bundled") {
        throw new Error(`Impossible de lire le dossier d'extensions ${directory}.`, { cause: error });
      }
      return ids;
    }

    for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const manifestPath = join(directory, entry.name, "plugin.json");
      let raw: string;
      try {
        raw = await readFile(manifestPath, "utf8");
      } catch {
        continue;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch (error) {
        throw new Error(`Le manifeste ${manifestPath} n'est pas un JSON valide.`, { cause: error });
      }
      const manifest = manifestSchema.parse(decoded);
      if (manifest.id !== entry.name) {
        throw new Error(`L'identifiant ${manifest.id} ne correspond pas au dossier ${entry.name}.`);
      }
      let effectiveSource: "bundled" | "local" | "central" = source;
      let signatureStatus: "bundled" | "verified" | "unsigned" = source === "bundled" ? "bundled" : "unsigned";
      if (source === "local") {
        const marker = await readInstallMarker(join(directory, entry.name));
        if (marker?.signatureStatus === "verified") {
          effectiveSource = "central";
          signatureStatus = "verified";
        } else if (requireVerified) {
          await this.database.query(
            "UPDATE installed_extensions SET enabled = false, error_message = $2, updated_at = now() WHERE id = $1",
            [manifest.id, "Extension locale non signée refusée."]
          );
          continue;
        }
      }
      ids.add(manifest.id);
      if (skipIds?.has(manifest.id)) continue;

      this.manifests.set(manifest.id, manifest);
      this.directories.set(manifest.id, join(directory, entry.name));
      await this.database.query(`
        INSERT INTO installed_extensions
          (id, version, enabled, source, manifest_json, signature_status, entitlement_key, license_status)
        VALUES ($1, $2, $3, $6, $4::jsonb, $7, $5, 'local')
        ON CONFLICT (id) DO UPDATE SET
          version = EXCLUDED.version,
          source = EXCLUDED.source,
          manifest_json = EXCLUDED.manifest_json,
          entitlement_key = EXCLUDED.entitlement_key,
          signature_status = EXCLUDED.signature_status,
          updated_at = CASE
            WHEN installed_extensions.version <> EXCLUDED.version THEN now()
            ELSE installed_extensions.updated_at
          END,
          error_message = NULL
      `, [
        manifest.id,
        manifest.version,
        manifest.defaultEnabled,
        JSON.stringify(manifest),
        manifest.entitlementKey,
        effectiveSource,
        signatureStatus
      ]);
    }
    return ids;
  }

  private async refreshEnabledIds() {
    const result = await this.database.query<{ id: string }>(
      "SELECT id FROM installed_extensions WHERE enabled = true"
    );
    this.enabledIds.clear();
    for (const row of result.rows) this.enabledIds.add(row.id);
  }
}

async function readInstallMarker(directory: string) {
  try {
    return z.object({ signatureStatus: z.enum(["verified", "unsigned"]), packageHash: z.string() }).parse(
      JSON.parse(await readFile(join(directory, ".gu-install.json"), "utf8"))
    );
  } catch {
    return null;
  }
}

export class ExtensionRegistryError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

/**
 * Un motif contenant un paramètre (`:groupId`) n'est comparé qu'en correspondance exacte :
 * il peut partager un segment d'URL avec le cœur (`/api/groups/:groupId/schedules` à côté de
 * `/api/groups/:groupId` en DELETE), donc l'étendre en préfixe capturerait des routes qui
 * n'appartiennent pas au module. Un motif entièrement statique (`/api/categories`) reste
 * comparé en préfixe : il ne partage son segment avec personne.
 */
export function routeMatchesPath(route: string, path: string) {
  if (!route.includes(":")) return path === route || path.startsWith(`${route}/`);
  const pattern = route.split("/").map((segment) => segment.startsWith(":") ? "[^/]+" : escapeRegExp(segment)).join("/");
  return new RegExp(`^${pattern}$`).test(path);
}

/** Types de fichiers qu'un paquet a le droit d'exposer au navigateur. */
export function publicExtensionAssetContentType(relativePath: string) {
  // Les migrations, le manifeste et le bundle Node ne doivent jamais être téléchargeables.
  // Seul le répertoire navigateur conventionnel d'un paquet est publié.
  if (!relativePath.startsWith("web/")) return null;
  const file = relativePath.toLocaleLowerCase("en");
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".gif")) return "image/gif";
  if (file.endsWith(".woff")) return "font/woff";
  if (file.endsWith(".woff2")) return "font/woff2";
  return null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extensionForRequest(path: string) {
  void path;
  return null;
}
