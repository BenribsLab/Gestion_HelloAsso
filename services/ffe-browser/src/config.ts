import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  FFE_BROWSER_INTERNAL_TOKEN: z.string().min(32, "FFE_BROWSER_INTERNAL_TOKEN doit faire au moins 32 caractères."),
  SESSIONS_DIRECTORY: z.string().trim().min(1).default("/data/sessions"),
  FFE_BASE_URL: z.url().default("https://dirigeant.escrime-ffe.fr")
});

export interface AppConfig {
  port: number;
  internalToken: string;
  sessionsDirectory: string;
  ffeBaseUrl: string;
}

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);
  return {
    port: parsed.PORT,
    internalToken: parsed.FFE_BROWSER_INTERNAL_TOKEN,
    sessionsDirectory: parsed.SESSIONS_DIRECTORY,
    ffeBaseUrl: parsed.FFE_BASE_URL
  };
}
