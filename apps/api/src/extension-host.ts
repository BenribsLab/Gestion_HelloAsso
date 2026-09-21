import type { AppConfig } from "./config.js";
import type { ExtensionContracts } from "./extension-contracts.js";

/**
 * Objet remis à un module au chargement. Un paquet n'importe jamais le cœur : tout ce dont il
 * a besoin passe par ici. Les types sont volontairement structurels — ni Fastify, ni pg — afin
 * qu'un paquet reste indépendant des dépendances de l'hôte et de leurs versions.
 */

export interface ExtensionQueryResult<TRow> {
  rows: TRow[];
  rowCount: number | null;
}

export interface ExtensionQueryable {
  query<TRow = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<ExtensionQueryResult<TRow>>;
}

export interface ExtensionClient extends ExtensionQueryable {
  release(): void;
}

export interface ExtensionDatabase extends ExtensionQueryable {
  connect(): Promise<ExtensionClient>;
}

/** Vue d'un adhérent actif telle que le noyau la fournit aux critères de groupe. */
export interface ExtensionMemberView {
  id: string;
  sourceData: Record<string, unknown>;
  profileData: Record<string, unknown>;
  localOverrides: Record<string, unknown>;
  birthDate: string | null;
}

export interface ExtensionRequest {
  body: unknown;
  params: unknown;
  query: unknown;
  url: string;
  authUser?: { id: string | null; email?: string } | null;
}

export interface ExtensionReply {
  code(statusCode: number): ExtensionReply;
  header(name: string, value: string | number): ExtensionReply;
  send(payload?: unknown): ExtensionReply;
}

export type ExtensionRouteHandler = (
  request: ExtensionRequest,
  reply: ExtensionReply
) => Promise<unknown> | unknown;

export type ExtensionRouteMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface ExtensionRouteOptions {
  rateLimit?: { max: number; timeWindow: string };
}

/**
 * Capacités déclarées au manifeste qui donnent réellement accès à quelque chose : sans la
 * capacité, la clé correspondante est absente de `config` / `core`.
 */
export const grantableCapabilities = ["smtp", "dynamic-groups", "helloasso-documents"] as const;
export type GrantableCapability = (typeof grantableCapabilities)[number];

export interface ExtensionHostConfig {
  smtp?: AppConfig["smtp"];
}

export interface ExtensionHostCore {
  refreshDynamicGroups?: (database: ExtensionQueryable) => Promise<void>;
  /**
   * Fonctions pures, sans accès aux données ni implication de sécurité : toujours
   * disponibles, sans capacité à déclarer au manifeste. Elles sont partagées par plusieurs
   * extensions de génération d'archives et de noms de fichiers.
   */
  zipBuffer(files: Array<{ name: string; content: Buffer }>): Promise<Buffer>;
  safeDownloadName(value: string): string;
  /** Téléchargement strictement en lecture seule, avec validation d'URL par le client HelloAsso. */
  getHelloAssoDocument?(url: string): Promise<{
    content: Buffer;
    mediaType: string;
    fileName: string | null;
  }>;
}

export interface ExtensionServerHost {
  readonly id: string;
  readonly version: string;
  readonly database: ExtensionDatabase;
  readonly log: Pick<Console, "info" | "warn" | "error">;
  readonly contracts: ExtensionContracts;
  readonly config: ExtensionHostConfig;
  readonly core: ExtensionHostCore;
  /** Pour les dépendances facultatives : un module peut consulter l'état d'un autre. */
  isExtensionEnabled(extensionId: string): boolean;
  /** Le chemin doit être couvert par un préfixe déclaré dans `routes` du manifeste. */
  route(
    method: ExtensionRouteMethod,
    path: string,
    options: ExtensionRouteOptions,
    handler: ExtensionRouteHandler
  ): void;
}

export type ExtensionServerModule = {
  default: (host: ExtensionServerHost) => void | Promise<void>;
};
