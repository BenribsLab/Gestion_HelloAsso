import { describe, expect, it } from "vitest";
import { HelloAssoSettingsService } from "./helloasso-settings.js";
import type { SecureSettingsStore } from "./secure-settings.js";

const environmentFallback = {
  baseUrl: "https://api.helloasso-sandbox.com",
  clientId: "env-client",
  clientSecret: "env-secret",
  organizationSlug: "env-association",
  configured: true
};

describe("réglages HelloAsso par association", () => {
  it("utilise l'environnement tant qu'aucun réglage n'est enregistré", async () => {
    const { store } = memoryStore();
    const service = new HelloAssoSettingsService(store, environmentFallback);

    await expect(service.status()).resolves.toMatchObject({
      source: "environment",
      environment: "sandbox",
      clientId: "env-client",
      organizationSlug: "env-association",
      secretConfigured: true
    });
  });

  it("conserve le secret existant lorsqu'il est omis lors d'une modification", async () => {
    const { store, state } = memoryStore();
    const service = new HelloAssoSettingsService(store, environmentFallback);

    await service.save({
      environment: "production",
      clientId: "premier-client",
      clientSecret: "secret-en-base",
      organizationSlug: "premiere-association"
    }, "user-1");
    await service.save({
      environment: "production",
      clientId: "second-client",
      organizationSlug: "premiere-association"
    }, "user-1");

    expect(state.secretValue).toEqual({ clientSecret: "secret-en-base" });
    await expect(service.status()).resolves.toMatchObject({
      source: "database",
      clientId: "second-client",
      secretConfigured: true
    });
  });

  it("revient au repli d'environnement après suppression", async () => {
    const { store } = memoryStore();
    const service = new HelloAssoSettingsService(store, environmentFallback);
    await service.save({
      environment: "production",
      clientId: "db-client",
      clientSecret: "db-secret",
      organizationSlug: "db-association"
    }, null);

    await expect(service.reset()).resolves.toMatchObject({
      source: "environment",
      organizationSlug: "env-association"
    });
  });
});

function memoryStore() {
  const state: {
    publicValue: Record<string, unknown> | null;
    secretValue: Record<string, unknown> | null;
    updatedAt: Date;
  } = { publicValue: null, secretValue: null, updatedAt: new Date("2026-09-21T12:00:00Z") };
  const store = {
    canWriteSecrets: () => true,
    read: async () => state.publicValue ? {
      publicValue: state.publicValue,
      secretValue: state.secretValue,
      updatedAt: state.updatedAt
    } : null,
    write: async (_namespace: string, publicValue: Record<string, unknown>, secretValue: Record<string, unknown>) => {
      state.publicValue = publicValue;
      state.secretValue = secretValue;
      state.updatedAt = new Date();
    },
    delete: async () => {
      state.publicValue = null;
      state.secretValue = null;
    }
  } as unknown as SecureSettingsStore;
  return { store, state };
}
