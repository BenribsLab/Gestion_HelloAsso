import nodemailer from "nodemailer";
import { z } from "zod";
import type { ExtensionQueryable } from "@gu/extension-host";

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
  configured: boolean;
};

export type EmailTarget =
  | { type: "all" }
  | { type: "groups"; groupIds: string[] }
  | { type: "single"; email: string };

type Recipient = { email: string; memberNames: string[] };

const emailSchema = z.email();

export function emailConfiguration(smtp: SmtpConfig) {
  return {
    configured: smtp.configured,
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    fromEmail: smtp.fromEmail || null,
    fromName: smtp.fromName,
    replyTo: smtp.replyTo
  };
}

export async function verifyEmailConnection(smtp: SmtpConfig) {
  const transporter = createTransporter(smtp);
  try {
    await transporter.verify();
  } finally {
    transporter.close();
  }
}

export async function previewRecipients(database: ExtensionQueryable, target: EmailTarget) {
  const result = await resolveRecipients(database, target);
  return {
    targetLabel: result.targetLabel,
    membersCount: result.membersCount,
    recipientsCount: result.recipients.length,
    withoutEmailCount: result.withoutEmailCount
  };
}

export async function sendEmailMessage(
  database: ExtensionQueryable,
  smtp: SmtpConfig,
  input: { subject: string; body: string; target: EmailTarget }
) {
  if (!smtp.configured) throw new Error("L'envoi SMTP n'est pas configuré dans le fichier .env.");
  const resolved = await resolveRecipients(database, input.target);
  if (resolved.recipients.length === 0) throw new Error("Aucune adresse e-mail valide ne correspond à cette sélection.");
  const messageResult = await database.query<{ id: string }>(
    `INSERT INTO email_messages
       (subject, body, target_type, target_group_id, target_label, status, recipients_count)
     VALUES ($1, $2, $3, $4, $5, 'sending', $6)
     RETURNING id`,
    [input.subject, input.body, input.target.type, null, resolved.targetLabel, resolved.recipients.length]
  );
  const messageId = messageResult.rows[0]!.id;
  for (const recipient of resolved.recipients) {
    await database.query(
      `INSERT INTO email_deliveries (message_id, email, member_names, status)
       VALUES ($1, $2, $3, 'pending')`,
      [messageId, recipient.email, recipient.memberNames]
    );
  }

  const transporter = createTransporter(smtp);
  let sentCount = 0;
  let failedCount = 0;
  try {
    for (const recipient of resolved.recipients) {
      try {
        await transporter.sendMail({
          from: { name: smtp.fromName, address: smtp.fromEmail },
          to: recipient.email,
          replyTo: smtp.replyTo ?? undefined,
          subject: input.subject,
          text: input.body,
          headers: { "X-GU-Message-ID": messageId }
        });
        sentCount += 1;
        await database.query(
          `UPDATE email_deliveries SET status = 'sent', sent_at = now()
           WHERE message_id = $1 AND email = $2`,
          [messageId, recipient.email]
        );
      } catch (error) {
        failedCount += 1;
        await database.query(
          `UPDATE email_deliveries SET status = 'failed', error_message = $3
           WHERE message_id = $1 AND email = $2`,
          [messageId, recipient.email, safeErrorMessage(error)]
        );
      }
    }
  } finally {
    transporter.close();
  }
  const status = failedCount === 0 ? "sent" : sentCount === 0 ? "failed" : "partial";
  await database.query(
    `UPDATE email_messages
     SET status = $2, sent_count = $3, failed_count = $4, finished_at = now()
     WHERE id = $1`,
    [messageId, status, sentCount, failedCount]
  );
  return { messageId, status, recipientsCount: resolved.recipients.length, sentCount, failedCount };
}

export async function listEmailMessages(database: ExtensionQueryable) {
  const result = await database.query<{
    id: string;
    subject: string;
    targetLabel: string;
    status: "sending" | "sent" | "partial" | "failed";
    recipientsCount: number;
    sentCount: number;
    failedCount: number;
    createdAt: Date;
    finishedAt: Date | null;
  }>(`
    SELECT
      id, subject, target_label AS "targetLabel", status,
      recipients_count AS "recipientsCount", sent_count AS "sentCount",
      failed_count AS "failedCount", created_at AS "createdAt", finished_at AS "finishedAt"
    FROM email_messages
    ORDER BY created_at DESC
    LIMIT 30
  `);
  return result.rows;
}

function createTransporter(smtp: SmtpConfig) {
  if (!smtp.configured) throw new Error("L'envoi SMTP n'est pas configuré dans le fichier .env.");
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    auth: { user: smtp.user, pass: smtp.password },
    tls: { minVersion: "TLSv1.2" },
    pool: true,
    maxConnections: 1,
    maxMessages: 100,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000
  });
}

async function resolveRecipients(database: ExtensionQueryable, target: EmailTarget) {
  if (target.type === "single") {
    const email = emailSchema.parse(target.email.trim().toLocaleLowerCase("fr"));
    return {
      targetLabel: `Test · ${email}`,
      membersCount: 1,
      withoutEmailCount: 0,
      recipients: [{ email, memberNames: ["Destinataire de test"] }]
    };
  }
  let targetLabel = "Tous les adhérents";
  if (target.type === "groups") {
    const groupResult = await database.query<{ id: string; name: string }>(
      "SELECT id, name FROM groups WHERE id = ANY($1::uuid[]) ORDER BY name",
      [target.groupIds]
    );
    if (groupResult.rows.length !== new Set(target.groupIds).size) throw new Error("Un des groupes choisis n'existe pas.");
    targetLabel = `Groupes · ${groupResult.rows.map((group) => group.name).join(", ")}`;
  }
  const result = await database.query<{ firstName: string; lastName: string; email: string | null }>(`
    SELECT DISTINCT
      COALESCE(NULLIF(m.local_overrides->>'firstName', ''), m.first_name) AS "firstName",
      COALESCE(NULLIF(m.local_overrides->>'lastName', ''), m.last_name) AS "lastName",
      CASE WHEN m.local_overrides ? 'email'
        THEN NULLIF(m.local_overrides->>'email', '')
        ELSE m.email
      END AS email
    FROM members m
    ${target.type === "groups" ? "JOIN member_groups mg ON mg.member_id = m.id AND mg.group_id = ANY($1::uuid[])" : ""}
    WHERE m.status = 'active'
    ORDER BY "lastName", "firstName"
  `, target.type === "groups" ? [target.groupIds] : []);
  const byEmail = new Map<string, Recipient>();
  let withoutEmailCount = 0;
  for (const member of result.rows) {
    const email = member.email?.trim().toLocaleLowerCase("fr") ?? "";
    if (!emailSchema.safeParse(email).success) {
      withoutEmailCount += 1;
      continue;
    }
    const recipient = byEmail.get(email) ?? { email, memberNames: [] };
    recipient.memberNames.push(`${member.firstName} ${member.lastName}`);
    byEmail.set(email, recipient);
  }
  return {
    targetLabel,
    membersCount: result.rows.length,
    withoutEmailCount,
    recipients: [...byEmail.values()]
  };
}

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Erreur SMTP inconnue";
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}
