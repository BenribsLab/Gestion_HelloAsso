import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "./config.js";
import { createHelloAssoClient } from "./helloasso.js";

const config: AppConfig = {
  port: 3000,
  databaseUrl: "postgres://example",
  nodeEnv: "test",
  trustProxy: false,
  helloasso: {
    baseUrl: "https://api.helloasso.com",
    clientId: "client",
    clientSecret: "secret",
    organizationSlug: "club-test",
    configured: true
  },
  smtp: {
    host: "smtp.example.test",
    port: 587,
    secure: false,
    user: "",
    password: "",
    fromEmail: "",
    fromName: "Club test",
    replyTo: null,
    configured: false
  },
  auth: {
    enabled: false,
    appOrigin: "http://127.0.0.1:8080",
    secureCookie: false,
    sessionIdleMinutes: 30,
    sessionMaxHours: 12,
    bootstrapAdminEmail: "",
    bootstrapAdminName: "Administrateur",
    bootstrapAdminPassword: ""
  }
};

afterEach(() => vi.unstubAllGlobals());

describe("client HelloAsso en lecture seule", () => {
  it("n'utilise aucune méthode d'écriture sur l'API métier", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/oauth2/token")) {
        return Response.json({ access_token: "token", expires_in: 3600 });
      }
      if (url.includes("/forms?")) return Response.json({ data: [], pagination: {} });
      if (url.includes("/items?")) return Response.json({ data: [], pagination: {} });
      return Response.json({ name: "Club test", organizationSlug: "club-test" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHelloAssoClient(config);
    await client.checkConnection();
    await client.listMembershipCampaigns();
    await client.listMembershipItems("campagne-test");

    const businessCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes("/v5/"));
    expect(businessCalls).toHaveLength(3);
    for (const [, init] of businessCalls) {
      expect(init?.method ?? "GET").toBe("GET");
    }
  });
});
