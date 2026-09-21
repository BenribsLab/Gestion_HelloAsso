import { z } from "zod";
import type { ExtensionServerHost } from "@gu/extension-host";
import {
  emailConfiguration,
  listEmailMessages,
  previewRecipients,
  sendEmailMessage,
  verifyEmailConnection,
  type SmtpConfig
} from "./email.js";

const emailTargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }),
  z.object({ type: z.literal("groups"), groupIds: z.array(z.uuid()).min(1).max(100) }),
  z.object({ type: z.literal("single"), email: z.email() })
]);
const emailMessageSchema = z.object({
  subject: z.string().trim().min(1).max(200).refine((value) => !/[\r\n]/.test(value)),
  body: z.string().trim().min(1).max(50_000),
  target: emailTargetSchema
});

export default function register(host: ExtensionServerHost) {
  const smtp = host.config.smtp as SmtpConfig | undefined;
  if (!smtp) throw new Error("La capacité smtp est requise par ce module.");
  const database = host.database;

  host.route("GET", "/api/email/status", {}, async () => emailConfiguration(smtp));

  host.route(
    "POST",
    "/api/email/verify",
    { rateLimit: { max: 5, timeWindow: "15 minutes" } },
    async (_request, reply) => {
      if (!smtp.configured) {
        return reply.code(409).send({ message: "Renseignez d'abord les paramètres SMTP dans le fichier .env." });
      }
      try {
        await verifyEmailConnection(smtp);
        return { connected: true };
      } catch (error) {
        const detail = error instanceof Error
          ? error.message.replace(/[\r\n]+/g, " ").slice(0, 300)
          : "Erreur inconnue";
        return reply.code(502).send({ message: `Connexion SMTP refusée : ${detail}` });
      }
    }
  );

  host.route("POST", "/api/email/recipients-preview", {}, async (request) => {
    const target = emailTargetSchema.parse(request.body);
    return previewRecipients(database, target);
  });

  host.route("GET", "/api/email/messages", {}, async () => ({
    items: await listEmailMessages(database)
  }));

  host.route(
    "POST",
    "/api/email/messages",
    { rateLimit: { max: 10, timeWindow: "1 hour" } },
    async (request, reply) => {
      if (!smtp.configured) {
        return reply.code(409).send({ message: "L'envoi SMTP n'est pas configuré dans le fichier .env." });
      }
      const input = emailMessageSchema.parse(request.body);
      try {
        return await sendEmailMessage(database, smtp, input);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "L'envoi du message a échoué.";
        return reply.code(400).send({ message: detail });
      }
    }
  );
}
