import type { FastifyInstance } from "fastify";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { z } from "zod";
import type { Database } from "./db.js";
import type { ExtensionContracts } from "./extension-contracts.js";

/**
 * Attestation de cotisation annuelle acquittée (formule de base, sans extension) : un PDF au nom
 * de l'adhérent, mentionnant le payeur et le montant, signé au nom du club avec son logo, sa
 * signature et son tampon. Téléchargeable ou envoyé par e-mail (via Messagerie Mail).
 */

const settingsKey = "club_identity";
export const defaultHeaderColor = "#eef2ea";
const assetKinds = ["logo", "signature", "stamp"] as const;
type AssetKind = (typeof assetKinds)[number];
const maxAssetBytes = 3 * 1024 * 1024;

const identitySchema = z.object({
  clubName: z.string().trim().max(150).default(""),
  city: z.string().trim().max(100).default(""),
  signatoryName: z.string().trim().max(120).default(""),
  signatoryRole: z.string().trim().max(200).default(""),
  signatureLabel: z.string().trim().max(80).default(""),
  signatureName: z.string().trim().max(120).default(""),
  // Fond de l'en-tête des attestations ; clair par défaut (convient à un logo noir).
  headerColor: z.string().regex(/^#[0-9a-f]{6}$/i).default(defaultHeaderColor)
});
export type ClubIdentity = z.infer<typeof identitySchema>;

const civilitySchema = z.enum(["", "M.", "Mme"]);
const attestationSchema = z.object({
  memberCivility: civilitySchema.default(""),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  season: z.string().trim().min(4).max(20),
  amount: z.number().min(0).max(100_000).nullable(),
  payerCivility: civilitySchema.default(""),
  payerFirstName: z.string().trim().max(100).default(""),
  payerLastName: z.string().trim().max(100).default(""),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});
type AttestationInput = z.infer<typeof attestationSchema>;
const emailSchema = attestationSchema.extend({ to: z.email() });
const memberParamsSchema = z.object({ memberId: z.uuid() });
const kindParamsSchema = z.object({ kind: z.enum(assetKinds) });

export function registerAttestationRoutes(options: {
  server: FastifyInstance;
  database: Database;
  contracts: ExtensionContracts;
  isExtensionEnabled: (extensionId: string) => boolean;
}) {
  const { server, database, contracts, isExtensionEnabled } = options;

  // ---------- Identité du club (Configuration) -------------------------------------------

  server.get("/api/club-identity", async () => ({
    identity: await readIdentity(database),
    assets: await assetPresence(database),
    mailAvailable: contracts.canSendMail(isExtensionEnabled)
  }));

  server.put("/api/club-identity", async (request) => {
    const identity = identitySchema.parse(request.body);
    await database.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [settingsKey, JSON.stringify(identity)]
    );
    return { identity };
  });

  server.post("/api/club-identity/assets/:kind", {
    config: { rateLimit: { max: 30, timeWindow: "1 hour" } }
  }, async (request, reply) => {
    const { kind } = kindParamsSchema.parse(request.params);
    const part = await request.file();
    if (!part) return reply.code(400).send({ message: "Choisissez une image." });
    const content = await part.toBuffer();
    const mediaType = imageType(content);
    if (!mediaType) return reply.code(400).send({ message: "Image PNG ou JPEG attendue." });
    if (content.length > maxAssetBytes) return reply.code(400).send({ message: "L'image ne doit pas dépasser 3 Mo." });
    await database.query(
      `INSERT INTO club_assets (kind, media_type, content, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind) DO UPDATE SET media_type = EXCLUDED.media_type, content = EXCLUDED.content,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [kind, mediaType, content, request.authUser?.id ?? null]
    );
    return { kind, uploaded: true };
  });

  server.get("/api/club-identity/assets/:kind", async (request, reply) => {
    const { kind } = kindParamsSchema.parse(request.params);
    const asset = await readAsset(database, kind);
    if (!asset) return reply.code(404).send({ message: "Aucune image." });
    reply.header("Content-Type", asset.mediaType);
    reply.header("Content-Length", asset.content.length);
    return reply.send(asset.content);
  });

  server.delete("/api/club-identity/assets/:kind", async (request) => {
    const { kind } = kindParamsSchema.parse(request.params);
    await database.query("DELETE FROM club_assets WHERE kind = $1", [kind]);
    return { kind, deleted: true };
  });

  // ---------- Attestation d'un adhérent ---------------------------------------------------

  server.get("/api/members/:memberId/attestation", async (request, reply) => {
    const { memberId } = memberParamsSchema.parse(request.params);
    const member = await readMember(database, memberId);
    if (!member) return reply.code(404).send({ message: "Cet adhérent n'existe pas." });
    const identity = await readIdentity(database);
    const history = await database.query(
      `SELECT created_at AS "createdAt", delivery, recipient_email AS "recipientEmail", season, reference
       FROM member_attestations WHERE member_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [memberId]
    );
    return {
      defaults: {
        memberCivility: "",
        firstName: member.firstName,
        lastName: member.lastName,
        // Saison de l'inscription (chaque fiche appartient à une saison).
        season: member.seasonLabel,
        amount: member.amountCents === null ? null : member.amountCents / 100,
        payerCivility: "",
        payerFirstName: member.payerFirstName ?? "",
        payerLastName: member.payerLastName ?? "",
        date: new Date().toISOString().slice(0, 10)
      },
      recipientEmail: member.payerEmail || member.email || "",
      // Détail HelloAsso du montant, pour vérification dans la fenêtre d'attestation.
      payment: {
        detailed: member.hasDetail,
        itemAmount: member.itemAmountCents === null ? null : member.itemAmountCents / 100,
        options: member.options.map((option) => ({ name: option.name, amount: option.amount / 100 })),
        payments: member.payments.map((payment) => ({ ...payment, amount: payment.amount / 100 }))
      },
      missing: missingIdentity(identity),
      mailAvailable: contracts.canSendMail(isExtensionEnabled),
      history: history.rows
    };
  });

  server.post("/api/members/:memberId/attestation/pdf", async (request, reply) => {
    const { memberId } = memberParamsSchema.parse(request.params);
    const input = attestationSchema.parse(request.body);
    if (!(await readMember(database, memberId))) return reply.code(404).send({ message: "Cet adhérent n'existe pas." });
    const reference = await recordAttestation(database, memberId, request.authUser?.id ?? null, "download", null, input);
    const pdf = await buildAttestation(database, input, reference);
    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Length", pdf.length);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(attestationFileName(input))}`);
    return reply.send(pdf);
  });

  server.post("/api/members/:memberId/attestation/email", {
    config: { rateLimit: { max: 60, timeWindow: "1 hour" } }
  }, async (request, reply) => {
    const { memberId } = memberParamsSchema.parse(request.params);
    const input = emailSchema.parse(request.body);
    if (!(await readMember(database, memberId))) return reply.code(404).send({ message: "Cet adhérent n'existe pas." });
    if (!contracts.canSendMail(isExtensionEnabled)) {
      return reply.code(409).send({ message: "L'envoi par e-mail nécessite l'extension Messagerie Mail, active et configurée." });
    }
    const identity = await readIdentity(database);
    const reference = await recordAttestation(database, memberId, request.authUser?.id ?? null, "email", input.to, input);
    const pdf = await buildAttestation(database, input, reference);
    const signer = identity.signatureName || identity.clubName;
    try {
      await contracts.sendMail({
        to: input.to,
        subject: `Attestation de cotisation ${input.season} : ${input.firstName} ${input.lastName}`,
        text: [
          `Bonjour${input.payerFirstName ? ` ${input.payerFirstName}` : ""},`,
          "",
          `Veuillez trouver ci-joint l'attestation de cotisation annuelle acquittée de ${input.firstName} ${input.lastName} pour la saison ${input.season}.`,
          "",
          "Cordialement,",
          signer,
          ...(identity.clubName && identity.clubName !== signer ? [identity.clubName] : [])
        ].join("\n"),
        attachments: [{ filename: attestationFileName(input), content: pdf, contentType: "application/pdf" }]
      }, isExtensionEnabled);
    } catch (error) {
      await database.query("DELETE FROM member_attestations WHERE reference = $1", [reference]);
      return reply.code(502).send({ message: error instanceof Error ? error.message : "L'e-mail n'a pas pu être envoyé." });
    }
    return { sent: true, to: input.to };
  });
}

// ---------- Données ------------------------------------------------------------------------

async function readIdentity(database: Database): Promise<ClubIdentity> {
  const result = await database.query<{ value: unknown }>("SELECT value FROM app_settings WHERE key = $1", [settingsKey]);
  const parsed = identitySchema.safeParse(result.rows[0]?.value ?? {});
  return parsed.success ? parsed.data : identitySchema.parse({});
}

function missingIdentity(identity: ClubIdentity) {
  const labels: Array<[keyof ClubIdentity, string]> = [
    ["clubName", "nom du club"], ["city", "ville"], ["signatoryName", "signataire"],
    ["signatoryRole", "qualité du signataire"], ["signatureName", "nom sous la signature"]
  ];
  return labels.filter(([key]) => !identity[key]).map(([, label]) => label);
}

async function assetPresence(database: Database) {
  const result = await database.query<{ kind: AssetKind; updatedAt: Date }>(
    `SELECT kind, updated_at AS "updatedAt" FROM club_assets`
  );
  const byKind = new Map(result.rows.map((row) => [row.kind, row.updatedAt]));
  return Object.fromEntries(assetKinds.map((kind) => [kind, byKind.get(kind) ?? null]));
}

async function readAsset(database: Database, kind: AssetKind) {
  const result = await database.query<{ mediaType: string; content: Buffer }>(
    `SELECT media_type AS "mediaType", content FROM club_assets WHERE kind = $1`,
    [kind]
  );
  return result.rows[0] ?? null;
}

/** Adhérent avec corrections locales ; payeur comme la fiche (correction, saisie, HelloAsso). */
async function readMember(database: Database, memberId: string) {
  const payer = (key: string) => `
    CASE WHEN m.local_overrides->'moduleData' ? '${key}'
      THEN NULLIF(m.local_overrides->'moduleData'->>'${key}', '')
      ELSE COALESCE(NULLIF(m.module_data->>'${key}', ''), m.source_data->>'${key}')
    END`;
  const result = await database.query<{
    firstName: string; lastName: string; email: string | null; amountCents: number | null;
    itemAmountCents: number | null; hasDetail: boolean;
    options: Array<{ name: string; amount: number }>;
    payments: Array<{ date: string | null; state: string | null; installmentNumber: number | null; amount: number }>;
    payerFirstName: string | null; payerLastName: string | null; payerEmail: string | null;
    seasonLabel: string;
  }>(`
    SELECT
      COALESCE(NULLIF(m.local_overrides->>'firstName', ''), m.first_name) AS "firstName",
      COALESCE(NULLIF(m.local_overrides->>'lastName', ''), m.last_name) AS "lastName",
      CASE WHEN m.local_overrides ? 'email' THEN NULLIF(m.local_overrides->>'email', '') ELSE m.email END AS email,
      CASE
        WHEN jsonb_typeof(m.source_data->'totalAmount') = 'number' THEN (m.source_data->>'totalAmount')::numeric::int
        WHEN jsonb_typeof(m.source_data->'amount') = 'number' THEN (m.source_data->>'amount')::numeric::int
        ELSE NULL
      END AS "amountCents",
      CASE WHEN jsonb_typeof(m.source_data->'amount') = 'number' THEN (m.source_data->>'amount')::numeric::int ELSE NULL END AS "itemAmountCents",
      COALESCE(m.source_data->'options', '[]'::jsonb) AS options,
      COALESCE(m.source_data->'payments', '[]'::jsonb) AS payments,
      m.source_data ? 'totalAmount' AS "hasDetail",
      ${payer("payerFirstName")} AS "payerFirstName",
      ${payer("payerLastName")} AS "payerLastName",
      ${payer("payerEmail")} AS "payerEmail"
      , s.label AS "seasonLabel"
    FROM members m
    JOIN seasons s ON s.id = m.season_id
    WHERE m.id = $1 AND m.locally_deleted_at IS NULL
  `, [memberId]);
  return result.rows[0] ?? null;
}

async function recordAttestation(
  database: Database,
  memberId: string,
  userId: string | null,
  delivery: "download" | "email",
  recipientEmail: string | null,
  input: AttestationInput
): Promise<string> {
  // Référence lisible et unique : année + numéro d'ordre (ex. 2026-0042).
  const result = await database.query<{ reference: string }>(
    `INSERT INTO member_attestations (member_id, issued_by, delivery, recipient_email, season, amount_cents, reference)
     VALUES ($1, $2, $3, $4, $5, $6,
       to_char(now(), 'YYYY') || '-' || lpad(nextval('member_attestation_number')::text, 4, '0'))
     RETURNING reference`,
    [memberId, userId, delivery, recipientEmail, input.season, input.amount === null ? null : Math.round(input.amount * 100)]
  );
  return result.rows[0]!.reference;
}

function imageType(content: Buffer) {
  if (content.length > 8 && content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (content.length > 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
  return null;
}

function attestationFileName(input: AttestationInput) {
  const slug = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  return `attestation-${slug(input.lastName)}-${slug(input.firstName)}-${slug(input.season)}.pdf`;
}

// ---------- PDF ----------------------------------------------------------------------------

async function buildAttestation(database: Database, input: AttestationInput, reference: string) {
  const identity = await readIdentity(database);
  const [logoAsset, signatureAsset, stampAsset] = await Promise.all(assetKinds.map((kind) => readAsset(database, kind)));
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Attestation de cotisation ${input.season} - ${input.firstName} ${input.lastName}`);
  pdf.setCreator(identity.clubName || "Gestion Asso");
  const page = pdf.addPage([595.28, 841.89]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const embed = async (asset: { mediaType: string; content: Buffer } | null | undefined) =>
    !asset ? null : asset.mediaType === "image/png" ? pdf.embedPng(asset.content) : pdf.embedJpg(asset.content);
  const [logo, signature, stamp] = await Promise.all([embed(logoAsset), embed(signatureAsset), embed(stampAsset)]);

  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  const margin = 62;
  const width = pageWidth - margin * 2;
  const ink = rgb(0.07, 0.11, 0.12);
  const muted = rgb(0.42, 0.47, 0.47);
  const line = rgb(0.84, 0.87, 0.85);
  const band = rgb(0.04, 0.15, 0.16);

  // En-tête : bandeau sombre pleine largeur, logo sur pastille blanche, nom du club, référence.
  // En-tête : fond réglable (clair par défaut), logo posé directement dessus, sans cadre.
  // Les textes passent en clair sur un fond sombre, en foncé sur un fond clair.
  const bandHeight = 112;
  const headerColor = hexColor(identity.headerColor);
  const darkHeader = luminance(identity.headerColor) < 0.45;
  const headerText = darkHeader ? rgb(1, 1, 1) : ink;
  const headerMuted = darkHeader ? rgb(0.72, 0.79, 0.77) : muted;
  page.drawRectangle({ x: 0, y: pageHeight - bandHeight, width: pageWidth, height: bandHeight, color: headerColor });
  if (!darkHeader) page.drawLine({ start: { x: 0, y: pageHeight - bandHeight }, end: { x: pageWidth, y: pageHeight - bandHeight }, thickness: 0.8, color: line });
  let nameX = margin;
  if (logo) {
    const size = fit(logo, 120, 76);
    page.drawImage(logo, { x: margin, y: pageHeight - bandHeight / 2 - size.height / 2, ...size });
    nameX = margin + size.width + 22;
  }
  const nameWidth = pageWidth - margin - nameX - 130;
  const clubLines = wrapRuns([{ text: identity.clubName || "Club", font: bold }], nameWidth, 18);
  let nameY = pageHeight - bandHeight / 2 + (clubLines.length - 1) * 11 + (identity.city ? 4 : -4);
  for (const current of clubLines) {
    drawRunLine(page, current, nameX, nameY, 18, headerText);
    nameY -= 22;
  }
  if (identity.city) page.drawText(safeText(identity.city.toUpperCase(), regular), { x: nameX, y: nameY + 4, size: 8.5, font: regular, color: headerMuted });
  const referenceText = `Réf. ${reference}`;
  page.drawText(safeText(referenceText, regular), {
    x: pageWidth - margin - regular.widthOfTextAtSize(referenceText, 9), y: pageHeight - bandHeight / 2 - 3,
    size: 9, font: regular, color: headerMuted
  });

  // Titre
  let y = pageHeight - bandHeight - 66;
  page.drawText("ATTESTATION", { x: margin, y, size: 26, font: bold, color: ink });
  y -= 22;
  page.drawText(safeText(`Cotisation annuelle acquittée · Saison ${input.season}`, regular), { x: margin, y, size: 12, font: regular, color: muted });
  y -= 18;
  page.drawRectangle({ x: margin, y, width: 46, height: 3, color: rgb(0.66, 0.81, 0.11) });
  y -= 44;

  // Corps : une seule phrase, l'adhérent et la saison en gras. Formulation identique pour une
  // fille ou un garçon (« membre », « titulaire »), sans « (e) ».
  const signatoryAgree = /^(madame|mme)\b/i.test(identity.signatoryName) ? "e" : /^(monsieur|m\.)\s/i.test(identity.signatoryName) ? "" : "(e)";
  const memberName = `${input.memberCivility ? `${input.memberCivility} ` : ""}${input.firstName} ${input.lastName.toUpperCase()}`;
  const paragraph: Run[] = [
    { text: `Je soussigné${signatoryAgree}, ${identity.signatoryName}, ${identity.signatoryRole}, certifie que `, font: regular },
    { text: memberName, font: bold },
    { text: " est membre de notre club pour la saison ", font: regular },
    { text: input.season, font: bold },
    { text: ", et à ce titre titulaire d’une licence de la Fédération française d’escrime.", font: regular }
  ];
  for (const current of wrapRuns(paragraph, width, 12.5)) {
    drawRunLine(page, current, margin, y, 12.5, ink);
    y -= 20;
  }
  y -= 18;

  // Encadré récapitulatif
  const payerName = [input.payerCivility, input.payerFirstName, input.payerLastName.toUpperCase()].filter(Boolean).join(" ").trim();
  const amountText = input.amount === null ? "Acquittée" : `${input.amount.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  const rows: Array<[string, string]> = [
    ["Adhérent", memberName],
    ["Saison", input.season],
    ["Cotisation acquittée", amountText],
    ...(payerName ? [["Réglée par", payerName] as [string, string]] : [])
  ];
  const rowHeight = 26;
  const boxHeight = rows.length * rowHeight + 16;
  page.drawRectangle({ x: margin, y: y - boxHeight, width, height: boxHeight, color: rgb(0.965, 0.973, 0.957), borderColor: line, borderWidth: 0.8 });
  page.drawRectangle({ x: margin, y: y - boxHeight, width: 3, height: boxHeight, color: band });
  let rowY = y - 8 - rowHeight / 2 - 4;
  for (const [index, [label, value]] of rows.entries()) {
    page.drawText(safeText(label.toUpperCase(), regular), { x: margin + 20, y: rowY, size: 8.5, font: regular, color: muted });
    page.drawText(safeText(value, bold), { x: margin + 170, y: rowY - 1, size: 12, font: bold, color: ink });
    if (index < rows.length - 1) page.drawLine({ start: { x: margin + 20, y: rowY - 10 }, end: { x: margin + width - 20, y: rowY - 10 }, thickness: 0.5, color: line });
    rowY -= rowHeight;
  }
  y -= boxHeight + 34;

  y = drawWrapped(page, "La présente attestation est établie pour servir et valoir ce que de droit.", { x: margin, y, width, font: regular, size: 12, lineHeight: 18, color: ink }) - 26;
  drawWrapped(page, `Fait ${identity.city ? `à ${identity.city}, ` : ""}le ${frenchDate(input.date)}`, { x: margin, y, width: width / 2, font: regular, size: 12, lineHeight: 18, color: ink });

  // Signature à droite : intitulé, tampon et/ou signature, nom.
  const blockX = margin + width / 2;
  const blockWidth = width / 2;
  if (identity.signatureLabel) y = drawWrapped(page, identity.signatureLabel, { x: blockX, y, width: blockWidth, font: regular, size: 12, lineHeight: 18, color: ink, align: "center" }) - 8;
  // Signature dans la colonne de droite, toujours à sa taille « seule » ; le tampon, s'il
  // existe, dans la colonne de gauche (sous « Fait à… »), à la même hauteur.
  const signatureSize = signature ? fit(signature, Math.min(blockWidth, 190), 96) : null;
  const stampSize = stamp ? fit(stamp, Math.min(width / 2 - 20, 170), 96) : null;
  const imageRowHeight = Math.max(signatureSize?.height ?? 0, stampSize?.height ?? 0);
  if (signature && signatureSize) {
    page.drawImage(signature, { x: blockX + (blockWidth - signatureSize.width) / 2, y: y - imageRowHeight + (imageRowHeight - signatureSize.height) / 2, ...signatureSize });
  }
  if (stamp && stampSize) {
    page.drawImage(stamp, { x: margin + (width / 2 - stampSize.width) / 2, y: y - imageRowHeight + (imageRowHeight - stampSize.height) / 2, ...stampSize });
  }
  y -= imageRowHeight > 0 ? imageRowHeight + 12 : 72;
  if (identity.signatureName) drawWrapped(page, identity.signatureName, { x: blockX, y, width: blockWidth, font: bold, size: 12, lineHeight: 18, color: ink, align: "center" });

  // Pied de page
  page.drawLine({ start: { x: margin, y: 58 }, end: { x: pageWidth - margin, y: 58 }, thickness: 0.5, color: line });
  const footer = [identity.clubName, identity.city].filter(Boolean).join(" · ");
  if (footer) page.drawText(safeText(footer, regular), { x: margin, y: 42, size: 8.5, font: regular, color: muted });
  page.drawText(safeText(`Réf. ${reference}`, regular), { x: pageWidth - margin - regular.widthOfTextAtSize(`Réf. ${reference}`, 8.5), y: 42, size: 8.5, font: regular, color: muted });

  return Buffer.from(await pdf.save());
}

type Run = { text: string; font: PDFFont };
type Piece = Run & { width: number };

/** Découpe un texte mêlant normal et gras en lignes qui tiennent dans la largeur. */
function wrapRuns(runs: Run[], maxWidth: number, size: number) {
  const words: Piece[] = [];
  for (const run of runs) {
    for (const token of safeText(run.text, run.font).split(/(\s+)/).filter(Boolean)) {
      const text = /^\s+$/.test(token) ? " " : token;
      words.push({ text, font: run.font, width: run.font.widthOfTextAtSize(text, size) });
    }
  }
  const lines: Piece[][] = [[]];
  let current = 0;
  for (const word of words) {
    const lineIndex = lines.length - 1;
    if (word.text === " ") {
      if (current > 0) { lines[lineIndex]!.push(word); current += word.width; }
      continue;
    }
    if (current > 0 && current + word.width > maxWidth) {
      const last = lines[lineIndex]!;
      while (last.at(-1)?.text === " ") last.pop();
      lines.push([word]); current = word.width;
    } else {
      lines[lineIndex]!.push(word); current += word.width;
    }
  }
  return lines.filter((entry) => entry.length > 0);
}

function drawRunLine(page: PDFPage, pieces: Piece[], x: number, y: number, size: number, color: ReturnType<typeof rgb>) {
  let cursor = x;
  for (const piece of pieces) {
    if (piece.text !== " ") page.drawText(piece.text, { x: cursor, y, size, font: piece.font, color });
    cursor += piece.width;
  }
}

function hexColor(value: string) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1] ?? defaultHeaderColor.slice(1);
  return rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255);
}

/** Luminance perçue (0 = noir, 1 = blanc) pour choisir la couleur du texte de l'en-tête. */
function luminance(value: string) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1] ?? defaultHeaderColor.slice(1);
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function fit(image: PDFImage, maxWidth: number, maxHeight: number) {
  const ratio = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
  return { width: image.width * ratio, height: image.height * ratio };
}

/** Texte avec retour à la ligne automatique ; renvoie la position sous la dernière ligne. */
function drawWrapped(page: PDFPage, text: string, options: {
  x: number; y: number; width: number; font: PDFFont; size: number; lineHeight: number;
  color: ReturnType<typeof rgb>; align?: "left" | "center";
}) {
  const safe = safeText(text, options.font);
  const lines: string[] = [];
  let line = "";
  for (const word of safe.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && options.font.widthOfTextAtSize(candidate, options.size) > options.width) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line) lines.push(line);
  let y = options.y;
  for (const current of lines) {
    const lineWidth = options.font.widthOfTextAtSize(current, options.size);
    const x = options.align === "center" ? options.x + (options.width - lineWidth) / 2 : options.x;
    page.drawText(current, { x, y, size: options.size, font: options.font, color: options.color });
    y -= options.lineHeight;
  }
  return y;
}

/** Les polices standard du PDF ne couvrent pas tous les caractères : remplacement prudent. */
function safeText(value: string, font: PDFFont) {
  const normalized = value.replace(/[‘’]/g, "’").replace(/[“”]/g, "\"").replace(/ /g, " ");
  let result = "";
  for (const character of normalized) {
    try { font.encodeText(character); result += character; } catch { result += character === "’" ? "'" : "?"; }
  }
  return result;
}

function frenchDate(value: string) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
}
