import { z } from "zod";
import { createHash } from "node:crypto";
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
  payer?: {
    firstName?: string | undefined;
    lastName?: string | undefined;
    email?: string | undefined;
    phone?: string | undefined;
  } | undefined;
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

export type HelloAssoRuntimeConfig = AppConfig["helloasso"];
type HelloAssoConfigSource = AppConfig | (() => Promise<HelloAssoRuntimeConfig> | HelloAssoRuntimeConfig);

export function createHelloAssoClient(source: HelloAssoConfigSource) {
  let accessToken: string | undefined;
  let refreshToken: string | undefined;
  let expiresAt = 0;
  let activeConfigurationHash = "";

  async function configuration() {
    const value = typeof source === "function" ? await source() : source.helloasso;
    const fingerprint = createHash("sha256").update(JSON.stringify(value)).digest("hex");
    if (activeConfigurationHash && activeConfigurationHash !== fingerprint) {
      accessToken = undefined;
      refreshToken = undefined;
      expiresAt = 0;
    }
    activeConfigurationHash = fingerprint;
    return value;
  }

  async function requestToken(current: HelloAssoRuntimeConfig) {
    if (!current.configured) {
      throw new HelloAssoError("HelloAsso n'est pas encore configuré.", 409);
    }

    const body = new URLSearchParams();
    if (refreshToken) {
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", refreshToken);
    } else {
      body.set("grant_type", "client_credentials");
      body.set("client_id", current.clientId);
      body.set("client_secret", current.clientSecret);
    }

    const response = await fetch(`${current.baseUrl}/oauth2/token`, {
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

  async function getAccessToken(current: HelloAssoRuntimeConfig) {
    if (accessToken && expiresAt > Date.now() + 30_000) {
      return accessToken;
    }
    return requestToken(current);
  }

  async function getJson(path: string, retry = true): Promise<unknown> {
    const current = await configuration();
    const token = await getAccessToken(current);
    const response = await fetch(`${current.baseUrl}/v5${path}`, {
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

  function parseMembershipItem(
    value: unknown,
    order?: {
      id?: number | undefined;
      date?: string | undefined;
      payer?: {
        firstName?: string | undefined;
        lastName?: string | undefined;
        email?: string | undefined;
        phone?: string | undefined;
      } | undefined;
    }
  ): HelloAssoMembershipItem | null {
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
    return result.success ? {
      ...result.data,
      ...(order ? {
        order: { id: order.id, date: order.date },
        payer: order.payer
      } : {})
    } : null;
  }

  async function getDocument(urlValue: string) {
    let url = validatedDocumentUrl(urlValue);
    for (let redirect = 0; redirect < 3; redirect += 1) {
      const current = await configuration();
      const token = await getAccessToken(current);
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000)
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new HelloAssoError("Redirection de document HelloAsso invalide.", 502);
        url = validatedDocumentUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) {
        throw new HelloAssoError(
          response.status === 403
            ? "HelloAsso refuse l'accès à ce document. Vérifiez les droits OrganizationAdmin de la clé API."
            : `Impossible de récupérer le document HelloAsso (statut ${response.status}).`,
          502
        );
      }
      const declaredSize = Number(response.headers.get("content-length") ?? 0);
      if (declaredSize > 15 * 1024 * 1024) {
        throw new HelloAssoError("Ce document dépasse la limite de 15 Mo.", 413);
      }
      if (!response.body) throw new HelloAssoError("HelloAsso a renvoyé un document vide.", 502);
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of response.body) {
        const value = Buffer.from(chunk);
        received += value.length;
        if (received > 15 * 1024 * 1024) {
          await response.body.cancel().catch(() => undefined);
          throw new HelloAssoError("Ce document dépasse la limite de 15 Mo.", 413);
        }
        chunks.push(value);
      }
      const content = Buffer.concat(chunks, received);
      return {
        content,
        mediaType: response.headers.get("content-type")?.split(";", 1)[0] ?? "application/octet-stream",
        fileName: contentDispositionFileName(response.headers.get("content-disposition"))
      };
    }
    throw new HelloAssoError("Trop de redirections pour ce document HelloAsso.", 502);
  }

  return {
    configuration,
    async checkConnection() {
      const current = await configuration();
      const token = await getAccessToken(current);
      const response = await fetch(
        `${current.baseUrl}/v5/organizations/${encodeURIComponent(current.organizationSlug)}`,
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
        name: organization.name ?? current.organizationSlug,
        slug:
          organization.organizationSlug ??
          organization.slug ??
          current.organizationSlug
      };
    },

    async listMembershipCampaigns(): Promise<HelloAssoCampaign[]> {
      const current = await configuration();
      const values = await getAllPages(
        `/organizations/${encodeURIComponent(current.organizationSlug)}/forms?formTypes=Membership`
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
      const current = await configuration();
      const [orderValues, itemValues] = await Promise.all([getAllPages(
        `/organizations/${encodeURIComponent(current.organizationSlug)}` +
          `/forms/Membership/${encodeURIComponent(formSlug)}/orders?withDetails=true`
      ), getAllPages(
        `/organizations/${encodeURIComponent(current.organizationSlug)}` +
          `/forms/Membership/${encodeURIComponent(formSlug)}/items?withDetails=true`
      )]);
      const items = new Map<number, HelloAssoMembershipItem>();
      for (const value of orderValues) {
        const order = z.object({
          id: z.number().optional(),
          date: z.string().optional(),
          payer: z.object({
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            email: z.string().optional(),
            phone: z.string().optional()
          }).optional(),
          items: z.array(z.unknown()).default([])
        }).safeParse(value);
        if (!order.success) continue;
        for (const rawItem of order.data.items) {
          const item = parseMembershipItem(rawItem, order.data);
          if (item) items.set(item.id, item);
        }
      }
      for (const value of itemValues) {
        const item = parseMembershipItem(value);
        if (item && !items.has(item.id)) items.set(item.id, item);
      }
      return [...items.values()];
    },

    getDocument
  };
}

function validatedDocumentUrl(value: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new HelloAssoError("La référence du document HelloAsso est invalide.", 502); }
  const allowedHosts = new Set(["docs.helloasso.com", "docs.helloasso-sandbox.com"]);
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) || !/^\/customFieldsAnswer\/\d+\/?$/.test(url.pathname)) {
    throw new HelloAssoError("L'adresse du document HelloAsso a été refusée.", 502);
  }
  url.search = "";
  url.hash = "";
  return url;
}

function contentDispositionFileName(value: string | null) {
  if (!value) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { /* valeur de repli ci-dessous */ }
  }
  return /filename="?([^";]+)"?/i.exec(value)?.[1]?.trim() ?? null;
}
