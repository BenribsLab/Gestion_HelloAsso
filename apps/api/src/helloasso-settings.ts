import type { AppConfig } from "./config.js";
import type { HelloAssoRuntimeConfig } from "./helloasso.js";
import { SecureSettingsStore } from "./secure-settings.js";

const namespace = "core.helloasso";

type PublicSettings = {
  environment: "production" | "sandbox";
  clientId: string;
  organizationSlug: string;
};

type SecretSettings = { clientSecret: string };

export type HelloAssoSettingsInput = PublicSettings & { clientSecret?: string | undefined };

export class HelloAssoSettingsService {
  private cached: { config: HelloAssoRuntimeConfig; source: "database" | "environment"; updatedAt: Date | null } | null = null;

  constructor(
    private readonly store: SecureSettingsStore,
    private readonly environmentFallback: AppConfig["helloasso"]
  ) {}

  async current() {
    if (this.cached) return this.cached;
    const stored = await this.store.read<PublicSettings, SecretSettings>(namespace);
    if (!stored) {
      this.cached = { config: this.environmentFallback, source: "environment", updatedAt: null };
      return this.cached;
    }
    const config = runtimeConfiguration(stored.publicValue, stored.secretValue?.clientSecret ?? "");
    this.cached = { config, source: "database", updatedAt: stored.updatedAt };
    return this.cached;
  }

  async status() {
    const current = await this.current();
    return {
      configured: current.config.configured,
      environment: current.config.baseUrl.includes("sandbox") ? "sandbox" as const : "production" as const,
      clientId: current.config.clientId,
      organizationSlug: current.config.organizationSlug,
      secretConfigured: Boolean(current.config.clientSecret),
      source: current.source,
      storageReady: this.store.canWriteSecrets(),
      updatedAt: current.updatedAt?.toISOString() ?? null
    };
  }

  async save(input: HelloAssoSettingsInput, userId: string | null) {
    const before = await this.current();
    const clientSecret = input.clientSecret && input.clientSecret.length > 0
      ? input.clientSecret
      : before.config.clientSecret;
    if (!clientSecret) throw new HelloAssoSettingsError(400, "Le Client Secret HelloAsso est obligatoire.");
    const publicValue: PublicSettings = {
      environment: input.environment,
      clientId: input.clientId.trim(),
      organizationSlug: normalizedSlug(input.organizationSlug)
    };
    const next = runtimeConfiguration(publicValue, clientSecret);
    const organizationChanged = before.config.configured && (
      before.config.organizationSlug !== next.organizationSlug || before.config.baseUrl !== next.baseUrl
    );
    await this.store.write(namespace, publicValue, { clientSecret }, userId);
    this.cached = { config: next, source: "database", updatedAt: new Date() };
    return { organizationChanged, status: await this.status() };
  }

  async reset() {
    await this.store.delete(namespace);
    this.cached = null;
    return this.status();
  }
}

export class HelloAssoSettingsError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function runtimeConfiguration(publicValue: PublicSettings, clientSecret: string): HelloAssoRuntimeConfig {
  const baseUrl = publicValue.environment === "sandbox"
    ? "https://api.helloasso-sandbox.com"
    : "https://api.helloasso.com";
  return {
    baseUrl,
    clientId: publicValue.clientId,
    clientSecret,
    organizationSlug: publicValue.organizationSlug,
    configured: Boolean(publicValue.clientId && clientSecret && publicValue.organizationSlug)
  };
}

function normalizedSlug(value: string) {
  return value.trim().toLocaleLowerCase("fr").replace(/^\/+|\/+$/g, "");
}
