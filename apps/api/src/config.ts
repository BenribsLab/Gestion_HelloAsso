import { z } from "zod";
import { readFileSync } from "node:fs";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().optional().default(""),
  DATABASE_HOST: z.string().trim().default("database"),
  DATABASE_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DATABASE_NAME: z.string().trim().default("gestion_utilisateurs"),
  DATABASE_USER: z.string().trim().default("gestion_app"),
  DATABASE_PASSWORD_FILE: z.string().trim().optional().default(""),
  HELLOASSO_BASE_URL: z.url().default("https://api.helloasso-sandbox.com"),
  HELLOASSO_CLIENT_ID: z.string().optional().default(""),
  HELLOASSO_CLIENT_SECRET: z.string().optional().default(""),
  HELLOASSO_CLIENT_SECRET_FILE: z.string().trim().optional().default(""),
  HELLOASSO_ORGANIZATION_SLUG: z.string().optional().default(""),
  SMTP_HOST: z.string().trim().min(1).default("smtp.mail.ovh.net"),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: z.enum(["true", "false"]).default("false"),
  SMTP_USER: z.string().trim().optional().default(""),
  SMTP_PASSWORD: z.string().optional().default(""),
  SMTP_PASSWORD_FILE: z.string().trim().optional().default(""),
  SMTP_FROM_EMAIL: z.union([z.email(), z.literal("")]).optional().default(""),
  SMTP_FROM_NAME: z.string().trim().max(100).default("Cercle d'Escrime de Yerres"),
  SMTP_REPLY_TO: z.union([z.email(), z.literal("")]).optional().default(""),
  AUTH_ENABLED: z.enum(["true", "false"]).default("false"),
  APP_ORIGIN: z.url().default("http://localhost:18473"),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(480).default(30),
  SESSION_MAX_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  BOOTSTRAP_ADMIN_EMAIL: z.union([z.email(), z.literal("")]).optional().default(""),
  BOOTSTRAP_ADMIN_NAME: z.string().trim().max(100).default("Administrateur"),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional().default(""),
  BOOTSTRAP_ADMIN_PASSWORD_FILE: z.string().trim().optional().default(""),
  EXTENSIONS_BUNDLED_DIRECTORY: z.string().trim().min(1).default("bundled-plugins"),
  EXTENSIONS_DIRECTORY: z.string().trim().min(1).default("plugins"),
  EXTENSION_CATALOG_URL: z.union([z.url(), z.literal("")]).optional().default(""),
  EXTENSION_LICENSE_TOKEN: z.string().trim().optional().default(""),
  EXTENSION_LICENSE_PUBLIC_KEY: z.string().trim().optional().default(""),
  EXTENSION_LICENSE_PUBLIC_KEY_FILE: z.string().trim().optional().default(""),
  EXTENSION_OFFLINE_GRACE_DAYS: z.coerce.number().int().min(0).max(365).default(30),
  EXTENSION_ALLOW_UNSIGNED: z.enum(["true", "false"]).default("false")
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.parse(environment);
  const databasePassword = secretValue("mot de passe PostgreSQL", "", parsed.DATABASE_PASSWORD_FILE);
  const databaseUrl = parsed.DATABASE_URL || (databasePassword
    ? `postgresql://${encodeURIComponent(parsed.DATABASE_USER)}:${encodeURIComponent(databasePassword)}@${parsed.DATABASE_HOST}:${parsed.DATABASE_PORT}/${encodeURIComponent(parsed.DATABASE_NAME)}`
    : "");
  if (!databaseUrl) throw new Error("La configuration PostgreSQL est incomplète.");
  const helloAssoSecret = secretValue("secret HelloAsso", parsed.HELLOASSO_CLIENT_SECRET, parsed.HELLOASSO_CLIENT_SECRET_FILE);
  const smtpPassword = secretValue("mot de passe SMTP", parsed.SMTP_PASSWORD, parsed.SMTP_PASSWORD_FILE);
  const bootstrapPassword = secretValue("mot de passe administrateur", parsed.BOOTSTRAP_ADMIN_PASSWORD, parsed.BOOTSTRAP_ADMIN_PASSWORD_FILE);
  const extensionLicensePublicKey = secretValue("clé publique des extensions", parsed.EXTENSION_LICENSE_PUBLIC_KEY, parsed.EXTENSION_LICENSE_PUBLIC_KEY_FILE);
  const helloassoValues = [
    parsed.HELLOASSO_CLIENT_ID,
    helloAssoSecret,
    parsed.HELLOASSO_ORGANIZATION_SLUG
  ];
  const providedCount = helloassoValues.filter(Boolean).length;

  if (providedCount > 0 && providedCount < helloassoValues.length) {
    throw new Error(
      "La configuration HelloAsso est incomplète : renseignez CLIENT_ID, CLIENT_SECRET et ORGANIZATION_SLUG."
    );
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    databaseUrl,
    trustProxy: parsed.TRUST_PROXY === "true",
    helloasso: {
      baseUrl: parsed.HELLOASSO_BASE_URL.replace(/\/$/, ""),
      clientId: parsed.HELLOASSO_CLIENT_ID,
      clientSecret: helloAssoSecret,
      organizationSlug: parsed.HELLOASSO_ORGANIZATION_SLUG,
      configured: providedCount === helloassoValues.length
    },
    smtp: {
      host: parsed.SMTP_HOST,
      port: parsed.SMTP_PORT,
      secure: parsed.SMTP_SECURE === "true",
      user: parsed.SMTP_USER,
      password: smtpPassword,
      fromEmail: parsed.SMTP_FROM_EMAIL,
      fromName: parsed.SMTP_FROM_NAME,
      replyTo: parsed.SMTP_REPLY_TO || null,
      configured: Boolean(parsed.SMTP_USER && smtpPassword && parsed.SMTP_FROM_EMAIL)
    },
    auth: {
      enabled: parsed.AUTH_ENABLED === "true",
      appOrigin: new URL(parsed.APP_ORIGIN).origin,
      secureCookie: new URL(parsed.APP_ORIGIN).protocol === "https:",
      sessionIdleMinutes: parsed.SESSION_IDLE_MINUTES,
      sessionMaxHours: parsed.SESSION_MAX_HOURS,
      bootstrapAdminEmail: parsed.BOOTSTRAP_ADMIN_EMAIL.toLocaleLowerCase("fr"),
      bootstrapAdminName: parsed.BOOTSTRAP_ADMIN_NAME,
      bootstrapAdminPassword: bootstrapPassword
    },
    extensions: {
      bundledDirectory: parsed.EXTENSIONS_BUNDLED_DIRECTORY,
      directory: parsed.EXTENSIONS_DIRECTORY,
      catalogUrl: parsed.EXTENSION_CATALOG_URL || null,
      licenseToken: parsed.EXTENSION_LICENSE_TOKEN || null,
      licensePublicKey: extensionLicensePublicKey || null,
      offlineGraceDays: parsed.EXTENSION_OFFLINE_GRACE_DAYS,
      allowUnsigned: parsed.EXTENSION_ALLOW_UNSIGNED === "true"
    }
  };
}

function secretValue(label: string, directValue: string, filePath: string) {
  if (directValue && filePath) throw new Error(`Configurez ${label} directement ou par fichier secret, pas les deux.`);
  if (!filePath) return directValue;
  try {
    return readFileSync(filePath, "utf8").replace(/[\r\n]+$/, "");
  } catch {
    throw new Error(`Impossible de lire le fichier secret pour ${label}.`);
  }
}
