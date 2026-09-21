import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import type { Database } from "./db.js";
import {
  ExtensionRegistry,
  extensionForRequest,
  publicExtensionAssetContentType,
  routeMatchesPath,
  verifyEntitlementToken
} from "./extensions.js";

function issueToken(payload: unknown, privateKey: Parameters<typeof sign>[2]) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return `${body.toString("base64url")}.${sign(null, body, privateKey).toString("base64url")}`;
}

describe("jeton d'autorisation du serveur central", () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const payload = {
    version: 1,
    installationId: "11111111-1111-4111-8111-111111111111",
    extensionId: "fencing-categories",
    entitlementKey: "fencing-categories",
    issuedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z"
  };

  it("accepte un jeton correctement signé", () => {
    expect(verifyEntitlementToken(issueToken(payload, keys.privateKey), publicKeyPem)).toEqual(payload);
  });

  it("refuse une charge utile modifiée après signature", () => {
    const token = issueToken(payload, keys.privateKey);
    const [, signature] = token.split(".");
    const altered = Buffer.from(JSON.stringify({ ...payload, entitlementKey: "irl-documents" }), "utf8");
    expect(verifyEntitlementToken(`${altered.toString("base64url")}.${signature}`, publicKeyPem)).toBeNull();
  });

  it("refuse un jeton signé par une autre clé", () => {
    const other = generateKeyPairSync("ed25519");
    expect(verifyEntitlementToken(issueToken(payload, other.privateKey), publicKeyPem)).toBeNull();
  });

  it("refuse un jeton sans clé publique configurée", () => {
    expect(verifyEntitlementToken(issueToken(payload, keys.privateKey), "")).toBeNull();
  });
});

describe("rattachement historique des routes aux extensions", () => {
  it("laisse les fichiers génériques des adhérents dans le noyau", () => {
    expect(extensionForRequest("/api/members/one/documents/file-key")).toBeNull();
    expect(extensionForRequest("/api/members/one/documents/file-key/local")).toBeNull();
    expect(extensionForRequest("/api/members/one/documents/file-key/classification")).toBeNull();
  });
});

describe("correspondance des motifs de route déclarés par un module", () => {
  it("compare un motif statique en préfixe, comme avant", () => {
    expect(routeMatchesPath("/api/categories", "/api/categories")).toBe(true);
    expect(routeMatchesPath("/api/categories", "/api/categories/settings")).toBe(true);
    expect(routeMatchesPath("/api/categories", "/api/categories-other")).toBe(false);
  });

  it("compare un motif avec paramètre en correspondance exacte seulement", () => {
    const route = "/api/groups/:groupId/schedules";
    expect(routeMatchesPath(route, "/api/groups/11111111-1111-1111-1111-111111111111/schedules")).toBe(true);
  });

  it("ne laisse pas un motif avec paramètre déborder sur une route voisine du cœur", () => {
    // C'est le bug réel trouvé en préparant l'extraction d'attendance-sheets : ces routes
    // partagent /api/groups/ avec le CRUD de groupes du cœur (POST /api/groups,
    // DELETE /api/groups/:groupId). Un motif à paramètre ne doit jamais s'étendre en préfixe.
    const route = "/api/groups/:groupId/schedules";
    expect(routeMatchesPath(route, "/api/groups/11111111-1111-1111-1111-111111111111")).toBe(false);
    expect(routeMatchesPath(route, "/api/groups")).toBe(false);
    expect(routeMatchesPath(route, "/api/groups/11111111-1111-1111-1111-111111111111/schedules/extra")).toBe(false);
  });
});

describe("publication des ressources navigateur d'une extension", () => {
  it("sert uniquement les formats web placés sous web/", () => {
    expect(publicExtensionAssetContentType("web/index.js")).toBe("text/javascript; charset=utf-8");
    expect(publicExtensionAssetContentType("web/assets/font.woff2")).toBe("font/woff2");
    expect(publicExtensionAssetContentType("web/image.png")).toBe("image/png");
  });

  it("ne publie ni code serveur, ni migration, ni type arbitraire", () => {
    expect(publicExtensionAssetContentType("server/index.mjs")).toBeNull();
    expect(publicExtensionAssetContentType("migrations/001.sql")).toBeNull();
    expect(publicExtensionAssetContentType("plugin.json")).toBeNull();
    expect(publicExtensionAssetContentType("web/debug.map")).toBeNull();
  });
});

describe("chargement des paquets locaux", () => {
  it("ignore un paquet local non signé en production et conserve le paquet livré", async () => {
    await withPackageRegistries(false, async (registry) => {
      expect(registry.manifest("example-extension")?.version).toBe("1.0.0");
      expect(registry.packageDirectory("example-extension")).toContain("bundled");
    });
  });

  it("autorise explicitement la surcharge locale en mode développement", async () => {
    await withPackageRegistries(true, async (registry) => {
      expect(registry.manifest("example-extension")?.version).toBe("9.0.0");
      expect(registry.packageDirectory("example-extension")).toContain("local");
    });
  });
});

async function withPackageRegistries(
  allowUnsigned: boolean,
  assertion: (registry: ExtensionRegistry) => Promise<void> | void
) {
  const root = await mkdtemp(join(tmpdir(), "gu-extension-registry-"));
  const bundledDirectory = join(root, "bundled");
  const localDirectory = join(root, "local");
  try {
    await Promise.all([
      writeTestManifest(bundledDirectory, "1.0.0"),
      writeTestManifest(localDirectory, "9.0.0")
    ]);
    const database = {
      query: async (sql: string) => ({
        rows: sql.includes("SELECT id FROM installed_extensions") ? [] : [],
        rowCount: 0
      })
    } as unknown as Database;
    const config = {
      extensions: {
        bundledDirectory,
        directory: localDirectory,
        catalogUrl: null,
        licenseToken: null,
        licensePublicKey: null,
        offlineGraceDays: 30,
        allowUnsigned
      }
    } as AppConfig;
    await assertion(await ExtensionRegistry.create(database, config));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeTestManifest(parent: string, version: string) {
  const directory = join(parent, "example-extension");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id: "example-extension",
    name: "Extension de test",
    description: "Manifeste utilisé uniquement par les tests du registre.",
    version,
    core: { minimum: "0.1.0" },
    dependencies: [],
    optionalDependencies: [],
    capabilities: [],
    entitlementKey: "example-extension",
    defaultEnabled: false,
    entrypoints: {},
    migrations: [],
    routes: []
  }), "utf8");
}
