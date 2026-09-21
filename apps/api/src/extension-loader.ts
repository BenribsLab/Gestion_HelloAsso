import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { Database } from "./db.js";
import type { createHelloAssoClient } from "./helloasso.js";
import type { ExtensionContracts } from "./extension-contracts.js";
import { routeMatchesPath, type ExtensionManifest, type ExtensionRegistry } from "./extensions.js";
import type {
  ExtensionDatabase,
  ExtensionHostConfig,
  ExtensionHostCore,
  ExtensionQueryable,
  ExtensionReply,
  ExtensionRequest,
  ExtensionRouteHandler,
  ExtensionRouteMethod,
  ExtensionRouteOptions,
  ExtensionServerHost,
  ExtensionServerModule,
  ExtensionStreamHandler,
  ExtensionWebSocket
} from "./extension-host.js";
import { refreshDynamicGroups } from "./dynamic-groups.js";
import { safeDownloadName, zipBuffer } from "./archive-utils.js";
import { runExtensionMigrations } from "./migrations.js";
import type { SecureSettingsStore } from "./secure-settings.js";

type LoadOptions = {
  server: FastifyInstance;
  database: Database;
  config: AppConfig;
  contracts: ExtensionContracts;
  registry: ExtensionRegistry;
  helloasso: ReturnType<typeof createHelloAssoClient>;
  settings: SecureSettingsStore;
};

/**
 * Charge les modules présents sur le disque. Les modules désactivés sont chargés eux aussi :
 * leurs routes existent mais restent bloquées par le garde-fou `preHandler`, ce qui permet
 * d'activer un module depuis l'interface sans redémarrer.
 *
 * Un module en échec n'interrompt jamais le démarrage : l'erreur est écrite dans le registre
 * et affichée dans l'écran Extensions.
 */
export async function loadExtensions(options: LoadOptions) {
  for (const { manifest, directory } of options.registry.installed()) {
    if (!manifest.entrypoints.server) continue;
    try {
      await runExtensionMigrations(
        options.database,
        manifest.id,
        join(directory, "migrations"),
        manifest.migrations
      );
      const entrypoint = packageFile(directory, manifest.entrypoints.server);
      const loaded = (await import(pathToFileURL(entrypoint).href)) as ExtensionServerModule;
      if (typeof loaded.default !== "function") {
        throw new Error("le point d'entrée serveur n'exporte pas de fonction par défaut");
      }
      await loaded.default(buildHost(options, manifest));
      await options.database.query(
        "UPDATE installed_extensions SET error_message = NULL WHERE id = $1",
        [manifest.id]
      );
      options.server.log.info({ extension: manifest.id }, "Module chargé");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.server.log.error({ err: error, extension: manifest.id }, "Chargement du module impossible");
      await options.database.query(
        "UPDATE installed_extensions SET error_message = $2 WHERE id = $1",
        [manifest.id, `Chargement impossible : ${message}`]
      );
    }
  }
}

/** Empêche un manifeste de faire sortir la lecture du dossier du paquet. */
export function packageFile(directory: string, relativePath: string) {
  const base = resolve(directory);
  const target = resolve(base, relativePath);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`Le chemin ${relativePath} sort du paquet.`);
  }
  return target;
}

function buildHost(options: LoadOptions, manifest: ExtensionManifest): ExtensionServerHost {
  const capabilities = new Set(manifest.capabilities);
  const config: ExtensionHostConfig = {};
  if (capabilities.has("smtp")) config.smtp = options.config.smtp;
  const core: ExtensionHostCore = {
    zipBuffer,
    safeDownloadName,
    ...(capabilities.has("dynamic-groups")
      ? { refreshDynamicGroups: refreshDynamicGroups as unknown as (database: ExtensionQueryable) => Promise<void> }
      : {}),
    ...(capabilities.has("helloasso-documents")
      ? { getHelloAssoDocument: options.helloasso.getDocument }
      : {}),
    ...(capabilities.has("remote-browser-relay")
      ? {
          remoteBrowserRelay: {
            registerStreamRoute(path: string, handler: ExtensionStreamHandler) {
              if (!manifest.routes.some((route) => routeMatchesPath(route, path))) {
                throw new Error(
                  `Le module ${manifest.id} tente d'enregistrer ${path}, hors des préfixes déclarés.`
                );
              }
              options.server.get(path, { websocket: true }, (socket, request) => {
                void handler(wrapWebSocket(socket), request as unknown as ExtensionRequest);
              });
            }
          }
        }
      : {})
  };

  return {
    id: manifest.id,
    version: manifest.version,
    database: options.database as unknown as ExtensionDatabase,
    log: options.server.log,
    contracts: options.contracts,
    config,
    settings: {
      read: () => options.settings.read(`extension.${manifest.id}`),
      write: (publicValue, secretValue, userId = null) =>
        options.settings.write(`extension.${manifest.id}`, publicValue, secretValue, userId),
      delete: () => options.settings.delete(`extension.${manifest.id}`),
      canWriteSecrets: () => options.settings.canWriteSecrets()
    },
    core,
    isExtensionEnabled: (extensionId: string) => options.registry.isEnabled(extensionId),
    route(
      method: ExtensionRouteMethod,
      path: string,
      routeOptions: ExtensionRouteOptions,
      handler: ExtensionRouteHandler
    ) {
      if (!manifest.routes.some((route) => routeMatchesPath(route, path))) {
        throw new Error(
          `Le module ${manifest.id} tente d'enregistrer ${path}, hors des préfixes déclarés.`
        );
      }
      options.server.route({
        method,
        url: path,
        ...(routeOptions.rateLimit ? { config: { rateLimit: routeOptions.rateLimit } } : {}),
        handler: (request, reply) =>
          handler(request as unknown as ExtensionRequest, reply as unknown as ExtensionReply)
      });
    }
  };
}

/** Adapte le socket `ws` brut au contrat structurel exposé aux modules. */
function wrapWebSocket(socket: import("ws").WebSocket): ExtensionWebSocket {
  function on(event: "message", listener: (data: Buffer) => void): void;
  function on(event: "close", listener: () => void): void;
  function on(event: "message" | "close", listener: ((data: Buffer) => void) | (() => void)): void {
    if (event === "message") {
      socket.on("message", (data) => (listener as (data: Buffer) => void)(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)));
    } else {
      socket.on("close", () => (listener as () => void)());
    }
  }
  return {
    send: (data) => socket.send(data),
    on,
    close: (code, reason) => socket.close(code, reason)
  };
}
