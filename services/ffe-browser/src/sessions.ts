import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "./config.js";
import { ffeSelectors, ffeUrls } from "./automation/selectors.js";

// Un identifiant de club correspond à une installation de l'extension (un club = une
// installation = un compte FFE) — pas besoin d'un identifiant plus fin, mais on garde un
// identifiant explicite plutôt qu'un singleton pour ne pas coder en dur cette hypothèse ici.
export type ClubSessionId = string;

export interface LoginCheckResult {
  valid: boolean;
  landedUrl: string;
}

export class SessionManager {
  private browser: Browser | undefined;
  private readonly contexts = new Map<ClubSessionId, BrowserContext>();
  // Page unique par club utilisée pour la phase interactive diffusée (connexion, revue finale) —
  // distincte des pages courtes ouvertes pour checkLogin(), créée par l'automatisation silencieuse
  // (automate/select-member) et reprise ensuite par le relais WebSocket.
  private readonly interactivePages = new Map<ClubSessionId, Page>();

  constructor(private readonly config: AppConfig) {}

  async start(): Promise<void> {
    this.browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  }

  async stop(): Promise<void> {
    for (const context of this.contexts.values()) await context.close().catch(() => undefined);
    this.contexts.clear();
    await this.browser?.close();
  }

  private storageStatePath(clubId: ClubSessionId): string {
    // clubId provient toujours de l'API interne (jamais du navigateur client), mais on borne
    // quand même les caractères acceptés pour ne jamais construire un chemin surprenant.
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(clubId)) throw new Error(`Identifiant de club invalide : ${clubId}`);
    return join(this.config.sessionsDirectory, `${clubId}.json`);
  }

  private async loadStoredStorageState(clubId: ClubSessionId): Promise<string | undefined> {
    try {
      return await readFile(this.storageStatePath(clubId), "utf8");
    } catch {
      return undefined;
    }
  }

  async persistStorageState(clubId: ClubSessionId): Promise<void> {
    const context = this.contexts.get(clubId);
    if (!context) return;
    await mkdir(this.config.sessionsDirectory, { recursive: true });
    const state = await context.storageState();
    await writeFile(this.storageStatePath(clubId), JSON.stringify(state), { mode: 0o600 });
  }

  async ensureContext(clubId: ClubSessionId): Promise<BrowserContext> {
    const existing = this.contexts.get(clubId);
    if (existing) return existing;
    if (!this.browser) throw new Error("Le navigateur n'est pas démarré.");
    const storedState = await this.loadStoredStorageState(clubId);
    const context = await this.browser.newContext(
      storedState ? { storageState: JSON.parse(storedState) } : {}
    );
    this.contexts.set(clubId, context);
    return context;
  }

  async closeContext(clubId: ClubSessionId): Promise<void> {
    const context = this.contexts.get(clubId);
    if (!context) return;
    await context.close().catch(() => undefined);
    this.contexts.delete(clubId);
  }

  // Navigue vers une page qui exige d'être connecté et regarde si le site nous redirige vers
  // l'écran de connexion — la manière la moins chère de savoir si la session stockée est encore
  // valide, sans dépendre d'un contenu de page fragile.
  async checkLogin(clubId: ClubSessionId): Promise<LoginCheckResult> {
    const context = await this.ensureContext(clubId);
    const page = await context.newPage();
    try {
      await page.goto(ffeUrls.etape1(this.config.ffeBaseUrl), { waitUntil: "domcontentloaded" });
      const landedUrl = page.url();
      const valid = !landedUrl.includes("/auth/login");
      return { valid, landedUrl };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /**
   * Connexion silencieuse avec des identifiants stockés par le club (approche hybride retenue :
   * priorité à la connexion silencieuse, repli automatique sur la diffusion interactive en cas
   * d'échec — mot de passe changé, 2FA apparue, etc.). N'écrit jamais le mot de passe nulle part
   * ni ne le journalise.
   */
  async loginWithCredentials(clubId: ClubSessionId, username: string, password: string): Promise<LoginCheckResult> {
    const context = await this.ensureContext(clubId);
    const page = await context.newPage();
    try {
      await page.goto(ffeUrls.login(this.config.ffeBaseUrl), { waitUntil: "domcontentloaded" });
      await ffeSelectors.usernameField(page).fill(username);
      await ffeSelectors.passwordField(page).fill(password);
      await ffeSelectors.loginButton(page).click();
      await page.waitForLoadState("domcontentloaded");
      const landedUrl = page.url();
      const valid = !landedUrl.includes("/auth/login");
      if (valid) await this.persistStorageState(clubId);
      return { valid, landedUrl };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async getInteractivePage(clubId: ClubSessionId): Promise<Page> {
    const existing = this.interactivePages.get(clubId);
    if (existing && !existing.isClosed()) return existing;
    const context = await this.ensureContext(clubId);
    const page = await context.newPage();
    this.interactivePages.set(clubId, page);
    return page;
  }

  hasInteractivePage(clubId: ClubSessionId): boolean {
    const page = this.interactivePages.get(clubId);
    return Boolean(page && !page.isClosed());
  }

  async closeInteractivePage(clubId: ClubSessionId): Promise<void> {
    const page = this.interactivePages.get(clubId);
    if (!page) return;
    await page.close().catch(() => undefined);
    this.interactivePages.delete(clubId);
  }
}
