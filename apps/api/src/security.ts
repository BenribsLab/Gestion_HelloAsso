import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Database } from "./db.js";

const sessionCookieFallback = "cey_session";
const loginSchema = z.object({
  email: z.email().max(254).transform((value) => value.trim().toLocaleLowerCase("fr")),
  password: z.string().min(1).max(256)
});
const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(14).max(256)
});
const newUserSchema = z.object({
  email: z.email().max(254).transform((value) => value.trim().toLocaleLowerCase("fr")),
  displayName: z.string().trim().min(2).max(100),
  password: z.string().min(14).max(256)
});
const userIdSchema = z.object({ userId: z.uuid() });

export type AuthUser = {
  id: string | null;
  email: string;
  displayName: string;
  role: "admin";
};

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthUser | null;
    authSessionId: string | null;
    csrfToken: string | null;
  }
}

export async function prepareAuthentication(database: Database, config: AppConfig) {
  if (!config.auth.enabled) return;
  const countResult = await database.query<{ count: string }>("SELECT count(*)::text AS count FROM app_users");
  if (Number(countResult.rows[0]?.count ?? 0) > 0) return;
  if (!config.auth.bootstrapAdminEmail || config.auth.bootstrapAdminPassword.length < 14) {
    throw new Error(
      "Aucun administrateur n'existe. Configurez BOOTSTRAP_ADMIN_EMAIL et un mot de passe d'au moins 14 caractères via BOOTSTRAP_ADMIN_PASSWORD_FILE."
    );
  }
  const passwordHash = await hashPassword(config.auth.bootstrapAdminPassword);
  await database.query(
    `INSERT INTO app_users (email, display_name, password_hash)
     VALUES ($1, $2, $3)`,
    [config.auth.bootstrapAdminEmail, config.auth.bootstrapAdminName, passwordHash]
  );
}

export async function installSecurity(server: FastifyInstance, database: Database, config: AppConfig) {
  server.decorateRequest("authUser", null);
  server.decorateRequest("authSessionId", null);
  server.decorateRequest("csrfToken", null);
  const cookieName = config.auth.secureCookie ? "__Host-cey_session" : sessionCookieFallback;
  const dummyHash = config.auth.enabled ? await hashPassword(randomBytes(24).toString("base64url")) : "";

  server.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
  });

  server.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?", 1)[0] ?? request.url;
    if (path === "/api/health") return;
    if (!config.auth.enabled) {
      request.authUser = { id: null, email: "local@localhost", displayName: "Administrateur local", role: "admin" };
      request.csrfToken = "local-development";
      return;
    }

    if (isUnsafeMethod(request.method)) {
      const origin = request.headers.origin;
      if (origin !== config.auth.appOrigin) {
        return reply.code(403).send({ message: "Origine de la requête refusée." });
      }
    }
    if (path === "/api/auth/login") return;

    const rawToken = request.cookies[cookieName];
    if (!rawToken || rawToken.length > 200) return unauthorized(reply);
    const tokenHash = digest(rawToken);
    const sessionResult = await database.query<{
      sessionId: string;
      csrfHash: string;
      lastSeenAt: Date;
      userId: string;
      email: string;
      displayName: string;
      role: "admin";
    }>(
      `SELECT s.id AS "sessionId", s.csrf_hash AS "csrfHash", s.last_seen_at AS "lastSeenAt",
              u.id AS "userId", u.email, u.display_name AS "displayName", u.role
       FROM app_sessions s
       JOIN app_users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.expires_at > now()
         AND s.last_seen_at > now() - ($2::int * interval '1 minute')
         AND u.active = true`,
      [tokenHash, config.auth.sessionIdleMinutes]
    );
    const session = sessionResult.rows[0];
    if (!session) {
      reply.clearCookie(cookieName, cookieOptions(config));
      return unauthorized(reply);
    }
    request.authUser = {
      id: session.userId,
      email: session.email,
      displayName: session.displayName,
      role: session.role
    };
    request.authSessionId = session.sessionId;
    request.csrfToken = session.csrfHash;

    if (isUnsafeMethod(request.method) && path !== "/api/auth/session") {
      const supplied = request.headers["x-csrf-token"];
      if (typeof supplied !== "string" || !safeEqual(supplied, session.csrfHash)) {
        return reply.code(403).send({ message: "Jeton de sécurité absent ou invalide. Rechargez la page." });
      }
    }

    if (Date.now() - new Date(session.lastSeenAt).getTime() > 5 * 60_000) {
      await database.query("UPDATE app_sessions SET last_seen_at = now() WHERE id = $1", [session.sessionId]);
    }
  });

  server.post("/api/auth/login", {
    config: { rateLimit: { max: 5, timeWindow: "15 minutes", ban: 3 } }
  }, async (request, reply) => {
    if (!config.auth.enabled) {
      return {
        user: { id: null, email: "local@localhost", displayName: "Administrateur local", role: "admin" },
        csrfToken: "local-development"
      };
    }
    const input = loginSchema.parse(request.body);
    const userResult = await database.query<{
      id: string;
      email: string;
      displayName: string;
      passwordHash: string;
      role: "admin";
    }>(
      `SELECT id, email, display_name AS "displayName", password_hash AS "passwordHash", role
       FROM app_users WHERE lower(email) = lower($1) AND active = true`,
      [input.email]
    );
    const user = userResult.rows[0];
    const passwordMatches = await verifyPassword(input.password, user?.passwordHash ?? dummyHash);
    if (!user || !passwordMatches) {
      await audit(database, request, null, "auth.login.failed", 401, { email: input.email });
      return reply.code(401).send({ message: "Adresse e-mail ou mot de passe incorrect." });
    }

    const rawToken = randomBytes(32).toString("base64url");
    const csrfHash = digest(randomBytes(32).toString("base64url"));
    const sessionResult = await database.query<{ id: string }>(
      `INSERT INTO app_sessions
         (user_id, token_hash, csrf_hash, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, now() + ($4::int * interval '1 hour'), $5, $6)
       RETURNING id`,
      [user.id, digest(rawToken), csrfHash, config.auth.sessionMaxHours, validIp(request.ip), userAgent(request)]
    );
    await database.query("UPDATE app_users SET last_login_at = now() WHERE id = $1", [user.id]);
    request.authUser = { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
    request.authSessionId = sessionResult.rows[0]!.id;
    request.csrfToken = csrfHash;
    reply.setCookie(cookieName, rawToken, {
      ...cookieOptions(config),
      maxAge: config.auth.sessionMaxHours * 3600
    });
    await audit(database, request, user.id, "auth.login.succeeded", 200);
    return { user: request.authUser, csrfToken: csrfHash };
  });

  server.get("/api/auth/session", async (request) => ({
    user: request.authUser,
    csrfToken: request.csrfToken,
    authEnabled: config.auth.enabled
  }));

  server.post("/api/auth/logout", async (request, reply) => {
    if (request.authSessionId) {
      await database.query("DELETE FROM app_sessions WHERE id = $1", [request.authSessionId]);
    }
    reply.clearCookie(cookieName, cookieOptions(config));
    return { loggedOut: true };
  });

  server.put("/api/auth/password", {
    config: { rateLimit: { max: 5, timeWindow: "1 hour" } }
  }, async (request, reply) => {
    if (!request.authUser?.id) return reply.code(409).send({ message: "Authentification désactivée en mode local." });
    const input = passwordChangeSchema.parse(request.body);
    const userResult = await database.query<{ passwordHash: string }>(
      `SELECT password_hash AS "passwordHash" FROM app_users WHERE id = $1`,
      [request.authUser.id]
    );
    if (!await verifyPassword(input.currentPassword, userResult.rows[0]?.passwordHash ?? dummyHash)) {
      return reply.code(400).send({ message: "Le mot de passe actuel est incorrect." });
    }
    const passwordHash = await hashPassword(input.newPassword);
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE app_users SET password_hash = $2, updated_at = now() WHERE id = $1",
        [request.authUser.id, passwordHash]
      );
      await client.query(
        "DELETE FROM app_sessions WHERE user_id = $1 AND id <> $2",
        [request.authUser.id, request.authSessionId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { changed: true };
  });

  server.get("/api/auth/users", async () => {
    const result = await database.query<{
      id: string;
      email: string;
      displayName: string;
      active: boolean;
      createdAt: Date;
      lastLoginAt: Date | null;
    }>(
      `SELECT id, email, display_name AS "displayName", active,
              created_at AS "createdAt", last_login_at AS "lastLoginAt"
       FROM app_users ORDER BY active DESC, lower(display_name), lower(email)`
    );
    return { items: result.rows };
  });

  server.post("/api/auth/users", {
    config: { rateLimit: { max: 10, timeWindow: "1 hour" } }
  }, async (request, reply) => {
    const input = newUserSchema.parse(request.body);
    try {
      const result = await database.query<{ id: string }>(
        `INSERT INTO app_users (email, display_name, password_hash)
         VALUES ($1, $2, $3) RETURNING id`,
        [input.email, input.displayName, await hashPassword(input.password)]
      );
      return reply.code(201).send({ id: result.rows[0]!.id });
    } catch (error) {
      if (isDatabaseConflict(error)) return reply.code(409).send({ message: "Cette adresse possède déjà un compte." });
      throw error;
    }
  });

  server.delete("/api/auth/users/:userId", async (request, reply) => {
    const { userId } = userIdSchema.parse(request.params);
    if (userId === request.authUser?.id) {
      return reply.code(400).send({ message: "Vous ne pouvez pas désactiver votre propre compte." });
    }
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      const activeResult = await client.query<{ id: string }>(
        "SELECT id FROM app_users WHERE active = true FOR UPDATE"
      );
      if (activeResult.rows.length <= 1) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ message: "Le dernier compte administrateur actif ne peut pas être désactivé." });
      }
      const result = await client.query(
        "UPDATE app_users SET active = false, updated_at = now() WHERE id = $1 AND active = true",
        [userId]
      );
      if (result.rowCount === 0) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ message: "Ce compte n'existe pas ou est déjà désactivé." });
      }
      await client.query("DELETE FROM app_sessions WHERE user_id = $1", [userId]);
      await client.query("COMMIT");
      return { id: userId, disabled: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  server.addHook("onResponse", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD" || request.url.startsWith("/api/health")) return;
    if (request.url.startsWith("/api/auth/login")) return;
    await audit(
      database,
      request,
      request.authUser?.id ?? null,
      `${request.method.toLocaleLowerCase("en")}.${request.routeOptions.url ?? request.url.split("?", 1)[0]}`,
      reply.statusCode
    ).catch((error: unknown) => request.log.error(error, "Impossible d'écrire le journal de sécurité"));
  });

  await database.query("DELETE FROM app_sessions WHERE expires_at <= now()");
}

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const parameters = { N: 131_072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
  const derived = await deriveKey(password, salt, 64, parameters);
  return `scrypt$${parameters.N}$${parameters.r}$${parameters.p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

async function verifyPassword(password: string, encoded: string) {
  const [algorithm, n, r, p, saltValue, hashValue] = encoded.split("$");
  if (algorithm !== "scrypt" || !n || !r || !p || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, "base64");
  const actual = await deriveKey(password, Buffer.from(saltValue, "base64"), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function deriveKey(password: string, salt: Buffer, length: number, options: { N: number; r: number; p: number; maxmem: number }) {
  return new Promise<Buffer>((resolve, reject) => {
    nodeScrypt(password, salt, length, options, (error, derivedKey) => {
      if (error) reject(error); else resolve(derivedKey);
    });
  });
}

function cookieOptions(config: AppConfig) {
  return {
    path: "/",
    httpOnly: true,
    secure: config.auth.secureCookie,
    sameSite: "strict" as const
  };
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isUnsafeMethod(method: string) {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toLocaleUpperCase("en"));
}

function unauthorized(reply: { code: (statusCode: number) => { send: (payload: object) => unknown } }) {
  return reply.code(401).send({ message: "Votre session a expiré. Reconnectez-vous." });
}

async function audit(
  database: Database,
  request: FastifyRequest,
  userId: string | null,
  action: string,
  statusCode: number,
  metadata: Record<string, unknown> = {}
) {
  await database.query(
    `INSERT INTO security_audit_log
       (user_id, action, method, route, status_code, ip_address, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [userId, action, request.method, request.routeOptions.url ?? request.url.split("?", 1)[0], statusCode, validIp(request.ip), userAgent(request), metadata]
  );
}

function validIp(value: string) {
  return isIP(value) ? value : null;
}

function userAgent(request: FastifyRequest) {
  return request.headers["user-agent"]?.slice(0, 500) ?? null;
}

function isDatabaseConflict(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}
