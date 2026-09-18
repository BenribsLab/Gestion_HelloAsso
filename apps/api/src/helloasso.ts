import { z } from "zod";
import type { AppConfig } from "./config.js";

export type HelloAssoCampaign = {
  title: string;
  formSlug: string;
  formType: string;
  state: string;
  startDate: string | null;
  endDate: string | null;
};

export type HelloAssoCustomField = {
  id: string;
  name: string;
  type: string;
  answer?: unknown;
};

export type HelloAssoMembershipItem = {
  id: number;
  name?: string | undefined;
  state?: string | undefined;
  amount?: number | undefined;
  priceCategory?: string | undefined;
  tierId?: number | undefined;
  user?: { firstName?: string | undefined; lastName?: string | undefined } | undefined;
  order?: { id?: number | undefined; date?: string | undefined } | undefined;
  customFields: HelloAssoCustomField[];
};

const tokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().positive()
});

export class HelloAssoError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
  }
}

export function createHelloAssoClient(config: AppConfig) {
  let accessToken: string | undefined;
  let refreshToken: string | undefined;
  let expiresAt = 0;

  async function requestToken() {
    if (!config.helloasso.configured) {
      throw new HelloAssoError("HelloAsso n'est pas encore configuré.", 409);
    }

    const body = new URLSearchParams();
    if (refreshToken) {
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", refreshToken);
    } else {
      body.set("grant_type", "client_credentials");
      body.set("client_id", config.helloasso.clientId);
      body.set("client_secret", config.helloasso.clientSecret);
    }

    const response = await fetch(`${config.helloasso.baseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      refreshToken = undefined;
      throw new HelloAssoError(
        response.status === 401
          ? "Identifiants HelloAsso refusés."
          : `HelloAsso a répondu avec le statut ${response.status}.`,
        502
      );
    }

    const token = tokenSchema.parse(await response.json());
    accessToken = token.access_token;
    refreshToken = token.refresh_token;
    expiresAt = Date.now() + token.expires_in * 1_000;
    return accessToken;
  }

  async function getAccessToken() {
    if (accessToken && expiresAt > Date.now() + 30_000) {
      return accessToken;
    }
    return requestToken();
  }

  async function getJson(path: string, retry = true): Promise<unknown> {
    const token = await getAccessToken();
    const response = await fetch(`${config.helloasso.baseUrl}/v5${path}`, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`
      },
      signal: AbortSignal.timeout(20_000)
    });

    if (response.status === 401 && retry) {
      accessToken = undefined;
      expiresAt = 0;
      return getJson(path, false);
    }
    if (!response.ok) {
      throw new HelloAssoError(
        `HelloAsso a refusé la lecture demandée (statut ${response.status}).`,
        502
      );
    }
    return response.json();
  }

  async function getAllPages(path: string) {
    const items: unknown[] = [];
    let continuationToken: string | undefined;

    for (let page = 0; page < 100; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const pagination = continuationToken
        ? `${separator}pageSize=100&continuationToken=${encodeURIComponent(continuationToken)}`
        : `${separator}pageSize=100`;
      const response = z
        .object({
          data: z.array(z.unknown()).default([]),
          pagination: z
            .object({ continuationToken: z.string().nullish() })
            .optional()
        })
        .parse(await getJson(`${path}${pagination}`));
      items.push(...response.data);
      continuationToken = response.pagination?.continuationToken ?? undefined;
      if (!continuationToken || response.data.length === 0) break;
    }

    return items;
  }

  function parseMembershipItem(value: unknown): HelloAssoMembershipItem | null {
    const result = z
      .object({
        id: z.number(),
        name: z.string().optional(),
        state: z.string().optional(),
        amount: z.number().optional(),
        priceCategory: z.string().optional(),
        tierId: z.number().optional(),
        user: z
          .object({ firstName: z.string().optional(), lastName: z.string().optional() })
          .optional(),
        order: z.object({ id: z.number().optional(), date: z.string().optional() }).optional(),
        customFields: z
          .array(
            z.object({
              id: z.union([z.string(), z.number()]).transform(String),
              name: z.string(),
              type: z.string(),
              answer: z.unknown()
            })
          )
          .default([])
      })
      .safeParse(value);
    return result.success ? result.data : null;
  }

  return {
    async checkConnection() {
      const token = await getAccessToken();
      const response = await fetch(
        `${config.helloasso.baseUrl}/v5/organizations/${encodeURIComponent(config.helloasso.organizationSlug)}`,
        {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`
          },
          signal: AbortSignal.timeout(10_000)
        }
      );

      if (!response.ok) {
        if (response.status === 401) {
          accessToken = undefined;
        }
        throw new HelloAssoError(
          response.status === 404
            ? "Association introuvable : vérifiez son slug."
            : `Impossible de lire l'association (statut ${response.status}).`,
          502
        );
      }

      const organization = z
        .object({
          name: z.string().optional(),
          organizationSlug: z.string().optional(),
          slug: z.string().optional()
        })
        .passthrough()
        .parse(await response.json());

      return {
        name: organization.name ?? config.helloasso.organizationSlug,
        slug:
          organization.organizationSlug ??
          organization.slug ??
          config.helloasso.organizationSlug
      };
    },

    async listMembershipCampaigns(): Promise<HelloAssoCampaign[]> {
      const values = await getAllPages(
        `/organizations/${encodeURIComponent(config.helloasso.organizationSlug)}/forms?formTypes=Membership`
      );
      return values.flatMap((value) => {
        const result = z
          .object({
            title: z.string(),
            formSlug: z.string(),
            formType: z.string().default("Membership"),
            state: z.string(),
            startDate: z.string().nullish(),
            endDate: z.string().nullish()
          })
          .safeParse(value);
        if (!result.success) return [];
        return [{
          ...result.data,
          startDate: result.data.startDate ?? null,
          endDate: result.data.endDate ?? null
        }];
      });
    },

    async listMembershipItems(formSlug: string): Promise<HelloAssoMembershipItem[]> {
      const values = await getAllPages(
        `/organizations/${encodeURIComponent(config.helloasso.organizationSlug)}` +
          `/forms/Membership/${encodeURIComponent(formSlug)}/items?withDetails=true`
      );
      return values.flatMap((value) => {
        const item = parseMembershipItem(value);
        return item ? [item] : [];
      });
    }
  };
}
