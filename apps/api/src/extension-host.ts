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
  /** En-têtes HTTP (noms en minuscules) : utile à une API publique authentifiée par clé. */
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
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
 * Canal WebSocket structurel, jamais le type `ws` brut : un module reste indépendant de la
 * bibliothèque WebSocket réellement utilisée par l'hôte.
 */
export interface ExtensionWebSocket {
  send(data: string | Buffer): void;
  on(event: "message", listener: (data: Buffer) => void): void;
  on(event: "close", listener: () => void): void;
  close(code?: number, reason?: string): void;
}

export type ExtensionStreamHandler = (
  socket: ExtensionWebSocket,
  request: ExtensionRequest
) => void | Promise<void>;

/**
 * Capacités déclarées au manifeste qui donnent réellement accès à quelque chose : sans la
 * capacité, la clé correspondante est absente de `config` / `core`.
 */
export const grantableCapabilities = [
  "smtp",
  "dynamic-groups",
  "helloasso-documents",
  "helloasso-read",
  "remote-browser-relay"
] as const;
export type GrantableCapability = (typeof grantableCapabilities)[number];

export interface ExtensionHostConfig {
  smtp?: AppConfig["smtp"];
}

export interface ExtensionHostSettings {
  read<TPublic extends object, TSecret extends object>(): Promise<{
    publicValue: TPublic;
    secretValue: TSecret | null;
    updatedAt: Date;
  } | null>;
  write<TPublic extends object, TSecret extends object>(
    publicValue: TPublic,
    secretValue: TSecret | null,
    userId?: string | null
  ): Promise<void>;
  delete(): Promise<void>;
  canWriteSecrets(): boolean;
}

export interface ExtensionHostCore {
  refreshDynamicGroups?: (database: ExtensionQueryable) => Promise<void>;
  /**
   * Fonctions pures, sans accès aux données ni implication de sécurité : toujours
   * disponibles, sans capacité à déclarer au manifeste. Elles sont partagées par plusieurs
   * extensions de génération d'archives et de noms de fichiers.
   */
  zipBuffer(files: Array<{ name: string; content: Buffer }>): Promise<Buffer>;
  /**
   * Signe un paramètre de retour OAuth pour le relais du serveur central : HMAC-SHA256 avec une
   * clé dérivée du jeton de licence du club (le serveur central n'en connaît que l'empreinte).
   * Absent si le club n'est pas relié au serveur central.
   */
  signCentralState?(payload: string): string;
  safeDownloadName(value: string): string;
  /**
   * Lecture seule de l'API HelloAsso de l'association du club (capacité « helloasso-read ») :
   * `path` est relatif à /v5/organizations/{association}, par exemple « /forms?formTypes=Shop ».
   */
  helloassoRead?: {
    get(path: string): Promise<unknown>;
    /** Toutes les pages d'une liste paginée (champ `data`). */
    getAllPages(path: string): Promise<unknown[]>;
  };
  /** Téléchargement strictement en lecture seule, avec validation d'URL par le client HelloAsso. */
  getHelloAssoDocument?(url: string): Promise<{
    content: Buffer;
    mediaType: string;
    fileName: string | null;
  }>;
  /**
   * Seul moyen pour un module d'obtenir un canal WebSocket : `route()` ne fait que du HTTP
   * simple. Le chemin est soumis à la même vérification de préfixe que `route()`, et la requête
   * d'upgrade passe par la même chaîne d'authentification (cookie de session) que le reste de
   * l'application avant que ce gestionnaire soit appelé.
   */
  remoteBrowserRelay?: {
    registerStreamRoute(path: string, handler: ExtensionStreamHandler): void;
  };
}

/** Saison sportive : une fiche adhérent (`members`) appartient toujours à une saison. */
export interface ExtensionSeason {
  id: string;
  label: string;
  /** Dates au format AAAA-MM-JJ. */
  startsOn: string;
  endsOn: string;
  startYear: number;
}

export interface ExtensionHostSeasons {
  /** Saison sélectionnée dans l'écran à l'origine de la requête, sinon la saison du jour. */
  fromRequest(request: Pick<ExtensionRequest, "headers">): Promise<ExtensionSeason>;
  /** Saison qui contient la date du jour (API publique, tâches planifiées…). */
  current(): Promise<ExtensionSeason>;
  list(): Promise<ExtensionSeason[]>;
  byId(seasonId: string): Promise<ExtensionSeason | null>;
}

export interface ExtensionServerHost {
  readonly id: string;
  readonly version: string;
  readonly database: ExtensionDatabase;
  readonly log: Pick<Console, "info" | "warn" | "error">;
  readonly contracts: ExtensionContracts;
  readonly config: ExtensionHostConfig;
  /** Stockage chiffré, automatiquement isolé dans l'espace de noms du module. */
  readonly settings: ExtensionHostSettings;
  readonly core: ExtensionHostCore;
  /** Saisons. Absent d'un cœur antérieur aux saisons : prévoir un repli. */
  readonly seasons?: ExtensionHostSeasons;
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
