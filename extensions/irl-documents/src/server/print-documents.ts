import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { ExtensionQueryable } from "@gu/extension-host";

type MemberCategoryContext = {
  season: string;
  values: string[];
  compute(birthDate: string | null): { fencingCategory: string | null; categoryError: string | null };
};

export type PrintDocumentTarget =
  | { type: "all" }
  | { type: "healthMissing" }
  | { type: "groups"; groupIds: string[] }
  | { type: "categories"; categories: string[] }
  | { type: "members"; memberIds: string[] };

export type PrintVariableDefinition = { token: string; label: string; source: "member" | "additional" };

export type PrintDocumentMember = {
  id: string;
  firstName: string;
  lastName: string;
  variables: Record<string, string>;
};

type FieldDefinition = { key: string; label: string; type: string };
type MemberRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  birthDate: string | null;
  campaignTitle: string | null;
  tierName: string | null;
  profileData: Record<string, unknown>;
  localOverrides: Record<string, unknown>;
  groups: Array<{ id: string; name: string }>;
  healthDocumentValid: boolean;
};

type TextStyle = { bold: boolean; italic: boolean; underline: boolean };
type RichRun = TextStyle & { text: string };
type RichBlock = { runs: RichRun[]; size: number; align: "left" | "center" | "right"; spaceAfter: number };
type FontSet = { normal: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont };
type TextPiece = RichRun & { width: number };

const coreVariables: PrintVariableDefinition[] = [
  { token: "{prenom}", label: "Prénom", source: "member" },
  { token: "{nom}", label: "Nom", source: "member" },
  { token: "{nom_complet}", label: "Prénom et nom", source: "member" },
  { token: "{groupe}", label: "Groupe(s)", source: "member" },
  { token: "{groupes}", label: "Groupe(s)", source: "member" },
  { token: "{categorie}", label: "Catégorie FFE", source: "member" },
  { token: "{email}", label: "E-mail", source: "member" },
  { token: "{telephone}", label: "Téléphone", source: "member" },
  { token: "{date_naissance}", label: "Date de naissance", source: "member" },
  { token: "{adresse}", label: "Adresse", source: "member" },
  { token: "{code_postal}", label: "Code postal", source: "member" },
  { token: "{ville}", label: "Ville", source: "member" },
  { token: "{adhesion}", label: "Tarif / adhésion", source: "member" },
  { token: "{campagne}", label: "Campagne HelloAsso", source: "member" },
  { token: "{date_du_jour}", label: "Date du jour", source: "member" }
];

export async function getPrintDocumentVariables(database: ExtensionQueryable) {
  const fields = await selectedFields(database);
  return [...coreVariables, ...additionalVariables(fields)];
}

export async function resolvePrintDocumentMembers(
  database: ExtensionQueryable,
  target: PrintDocumentTarget,
  categoryContext: MemberCategoryContext | null
) {
  const [fields, membersResult] = await Promise.all([
    selectedFields(database),
    database.query<MemberRow>(`
      SELECT
        m.id,
        COALESCE(NULLIF(m.local_overrides->>'firstName', ''), m.first_name) AS "firstName",
        COALESCE(NULLIF(m.local_overrides->>'lastName', ''), m.last_name) AS "lastName",
        CASE WHEN m.local_overrides ? 'email' THEN NULLIF(m.local_overrides->>'email', '') ELSE m.email END AS email,
        CASE WHEN m.local_overrides ? 'phone' THEN NULLIF(m.local_overrides->>'phone', '') ELSE m.phone END AS phone,
        CASE WHEN m.local_overrides ? 'birthDate'
          THEN m.local_overrides->>'birthDate'
          ELSE to_char(m.birth_date, 'YYYY-MM-DD')
        END AS "birthDate",
        m.source_data->>'campaignTitle' AS "campaignTitle",
        m.source_data->>'tierName' AS "tierName",
        COALESCE(m.profile_data, '{}'::jsonb) AS "profileData",
        COALESCE(m.local_overrides, '{}'::jsonb) AS "localOverrides",
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) ORDER BY g.name)
          FROM member_groups mg JOIN groups g ON g.id = mg.group_id
          WHERE mg.member_id = m.id
        ), '[]'::jsonb) AS groups,
        EXISTS (
          SELECT 1 FROM member_documents d
          JOIN helloasso_fields f ON f.field_key = d.field_key
          WHERE d.member_id = m.id AND f.selected = true AND f.document_role = 'health'
            AND (d.local_content IS NOT NULL OR d.helloasso_url IS NOT NULL)
            AND d.classification IN ('certificate', 'attestation')
        ) AS "healthDocumentValid"
      FROM members m
      WHERE m.status = 'active'
      ORDER BY "lastName", "firstName"
      LIMIT 1500
    `)
  ]);

  if (target.type === "groups") {
    const groups = await database.query<{ id: string }>("SELECT id FROM groups WHERE id = ANY($1::uuid[])", [target.groupIds]);
    if (groups.rows.length !== new Set(target.groupIds).size) throw new Error("Un des groupes choisis n'existe pas.");
  }

  const knownCategories = new Set(categoryContext?.values ?? []);
  if (target.type === "categories" && target.categories.some((category) => !knownCategories.has(category))) {
    throw new Error("Une des catégories choisies n'existe pas pour la saison actuelle.");
  }

  const requestedMembers = target.type === "members" ? new Set(target.memberIds) : null;
  const dynamicVariables = additionalVariables(fields);
  const today = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeZone: "Europe/Paris" }).format(new Date());
  const members: PrintDocumentMember[] = [];

  for (const row of membersResult.rows) {
    const birthDate = normalizeBirthDate(row.birthDate);
    const category = categoryContext?.compute(birthDate).fencingCategory ?? null;
    if (target.type === "healthMissing" && row.healthDocumentValid) continue;
    if (target.type === "groups" && !row.groups.some((group) => target.groupIds.includes(group.id))) continue;
    if (target.type === "categories" && (!category || !target.categories.includes(category))) continue;
    if (requestedMembers && !requestedMembers.has(row.id)) continue;

    const profileOverrides = isRecord(row.localOverrides.profileData) ? row.localOverrides.profileData : {};
    const profile = { ...row.profileData, ...profileOverrides };
    const fieldValue = (pattern: RegExp) => {
      const field = fields.find((entry) => pattern.test(normalizedLabel(entry.label)));
      return field ? printableValue(profile[field.key], field.type) : "";
    };
    const groups = row.groups.map((group) => group.name).join(", ");
    const variables: Record<string, string> = {
      "{prenom}": row.firstName,
      "{nom}": row.lastName,
      "{nom_complet}": `${row.firstName} ${row.lastName}`,
      "{groupe}": groups,
      "{groupes}": groups,
      "{categorie}": category ?? "",
      "{email}": row.email ?? "",
      "{telephone}": formatPhoneNumber(row.phone ?? ""),
      "{date_naissance}": formatFrenchDate(birthDate),
      "{adresse}": fieldValue(/adresse( postale)?|numero.*rue/),
      "{code_postal}": fieldValue(/code postal/),
      "{ville}": fieldValue(/^ville$|commune/),
      "{adhesion}": row.tierName ?? "",
      "{campagne}": row.campaignTitle ?? "",
      "{date_du_jour}": today
    };
    for (const [index, field] of fields.entries()) {
      const variable = dynamicVariables[index];
      if (variable) variables[variable.token] = printableValue(profile[field.key], field.type);
    }
    members.push({ id: row.id, firstName: row.firstName, lastName: row.lastName, variables });
  }

  if (requestedMembers && members.length !== requestedMembers.size) {
    throw new Error("Un des adhérents choisis n'existe plus ou n'est plus actif.");
  }
  return members;
}

export function unknownPrintVariables(html: string, definitions: PrintVariableDefinition[]) {
  const known = new Set(definitions.map((definition) => definition.token.toLocaleLowerCase("fr")));
  return [...new Set(html.match(/\{[a-z0-9_:-]+\}/gi) ?? [])]
    .filter((token) => !known.has(token.toLocaleLowerCase("fr")));
}

export function sanitizePrintDocumentHtml(html: string) {
  const source = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object)[^>]*>[\s\S]*?<\/\1>/gi, "");
  const allowed = new Set(["p", "div", "br", "strong", "b", "em", "i", "u", "h1", "h2", "h3", "ul", "ol", "li"]);
  let result = "";
  for (const token of source.match(/<[^>]+>|[^<]+/g) ?? []) {
    if (!token.startsWith("<")) { result += token; continue; }
    const closing = /^<\s*\//.test(token);
    const name = /^<\s*\/?\s*([a-z0-9]+)/i.exec(token)?.[1]?.toLowerCase();
    if (!name || !allowed.has(name)) continue;
    if (closing) { if (name !== "br") result += `</${name}>`; continue; }
    if (name === "br") { result += "<br>"; continue; }
    const alignment = /(?:text-align\s*:\s*|(?:data-)?align\s*=\s*["']?)(left|center|right)/i.exec(token)?.[1]?.toLowerCase();
    result += `<${name}${alignment ? ` data-align="${alignment}"` : ""}>`;
  }
  return result.trim();
}

export async function createCombinedPrintDocument(html: string, members: PrintDocumentMember[], title: string) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator("Gestion club");
  const fonts = await embedFonts(pdf);
  for (const member of members) renderMember(pdf, fonts, html, member.variables);
  return Buffer.from(await pdf.save());
}

export async function createIndividualPrintDocument(html: string, member: PrintDocumentMember, title: string) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${title} — ${member.firstName} ${member.lastName}`);
  pdf.setCreator("Gestion club");
  const fonts = await embedFonts(pdf);
  renderMember(pdf, fonts, html, member.variables);
  return Buffer.from(await pdf.save());
}

export function memberPrintFileName(member: PrintDocumentMember) {
  const value = `${member.lastName.toLocaleUpperCase("fr")}-${member.firstName}`
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${value || "adherent"}.pdf`;
}

function selectedFields(database: ExtensionQueryable) {
  return database.query<FieldDefinition>(`
    SELECT field_key AS key, label, field_type AS type
    FROM helloasso_fields
    WHERE selected = true AND field_type <> 'File'
    ORDER BY label, field_key
  `).then((result) => result.rows);
}

function additionalVariables(fields: FieldDefinition[]) {
  const counts = new Map<string, number>();
  return fields.map((field) => {
    const base = normalizedLabel(field.label).replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "champ";
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    return { token: `{champ_${base}${count > 1 ? `_${count}` : ""}}`, label: field.label, source: "additional" as const };
  });
}

async function embedFonts(pdf: PDFDocument): Promise<FontSet> {
  const [normal, bold, italic, boldItalic] = await Promise.all([
    pdf.embedFont(StandardFonts.Helvetica),
    pdf.embedFont(StandardFonts.HelveticaBold),
    pdf.embedFont(StandardFonts.HelveticaOblique),
    pdf.embedFont(StandardFonts.HelveticaBoldOblique)
  ]);
  return { normal, bold, italic, boldItalic };
}

function renderMember(pdf: PDFDocument, fonts: FontSet, html: string, variables: Record<string, string>) {
  const blocks = richTextBlocks(html, variables);
  let page = pdf.addPage([595.28, 841.89]);
  let y = 785;
  const margin = 56;
  const width = page.getWidth() - margin * 2;
  for (const block of blocks) {
    const lines = wrapBlock(block, fonts, width);
    const lineHeight = block.size * 1.35;
    for (const line of lines) {
      if (y - lineHeight < 48) {
        page = pdf.addPage([595.28, 841.89]);
        y = 785;
      }
      drawLine(page, fonts, line, block, margin, width, y);
      y -= lineHeight;
    }
    y -= block.spaceAfter;
  }
}

function drawLine(page: PDFPage, fonts: FontSet, pieces: TextPiece[], block: RichBlock, margin: number, width: number, y: number) {
  const lineWidth = pieces.reduce((total, piece) => total + piece.width, 0);
  let x = block.align === "center" ? margin + Math.max(0, (width - lineWidth) / 2)
    : block.align === "right" ? margin + Math.max(0, width - lineWidth) : margin;
  for (const piece of pieces) {
    const font = fontFor(fonts, piece);
    page.drawText(piece.text, { x, y, size: block.size, font, color: rgb(0.08, 0.12, 0.12) });
    if (piece.underline && piece.text.trim()) {
      page.drawLine({ start: { x, y: y - 1.5 }, end: { x: x + piece.width, y: y - 1.5 }, thickness: 0.7, color: rgb(0.08, 0.12, 0.12) });
    }
    x += piece.width;
  }
}

function wrapBlock(block: RichBlock, fonts: FontSet, maxWidth: number) {
  const lines: TextPiece[][] = [[]];
  let lineWidth = 0;
  for (const run of block.runs) {
    const font = fontFor(fonts, run);
    const safe = safePdfText(run.text, font);
    for (const token of safe.split(/(\n|\s+)/).filter(Boolean)) {
      if (token === "\n") {
        lines.push([]); lineWidth = 0; continue;
      }
      const text = /^\s+$/.test(token) ? " " : token;
      const width = font.widthOfTextAtSize(text, block.size);
      if (text !== " " && width > maxWidth) {
        for (const character of text) {
          const characterWidth = font.widthOfTextAtSize(character, block.size);
          if (lineWidth > 0 && lineWidth + characterWidth > maxWidth) {
            lines.push([]); lineWidth = 0;
          }
          lines[lines.length - 1]!.push({ ...run, text: character, width: characterWidth });
          lineWidth += characterWidth;
        }
        continue;
      }
      if (text === " " && lineWidth === 0) continue;
      if (lineWidth > 0 && lineWidth + width > maxWidth && text !== " ") {
        lines.push([]); lineWidth = 0;
      }
      if (text === " " && lineWidth + width > maxWidth) continue;
      lines[lines.length - 1]!.push({ ...run, text, width });
      lineWidth += width;
    }
  }
  return lines.length ? lines : [[]];
}

function richTextBlocks(html: string, variables: Record<string, string>) {
  const source = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  const blocks: RichBlock[] = [];
  let runs: RichRun[] = [];
  let bold = 0; let italic = 0; let underline = 0;
  let size = 11; let align: RichBlock["align"] = "left"; let spaceAfter = 7;
  const lists: Array<{ ordered: boolean; index: number }> = [];
  const pushText = (value: string) => {
    if (value === "\n") {
      const previous = runs.at(-1);
      if (previous) previous.text += "\n";
      else runs.push({ text: "\n", bold: bold > 0, italic: italic > 0, underline: underline > 0 });
      return;
    }
    const decoded = decodeEntities(value).replace(/[\t\r\n ]+/g, " ");
    const replaced = replaceVariables(decoded, variables);
    if (!replaced) return;
    const style = { bold: bold > 0, italic: italic > 0, underline: underline > 0 };
    const previous = runs.at(-1);
    if (previous && previous.bold === style.bold && previous.italic === style.italic && previous.underline === style.underline) previous.text += replaced;
    else runs.push({ text: replaced, ...style });
  };
  const flush = () => {
    while (runs.at(-1)?.text.endsWith(" ")) runs[runs.length - 1]!.text = runs.at(-1)!.text.slice(0, -1);
    if (runs.some((run) => run.text.length > 0)) blocks.push({ runs, size, align, spaceAfter });
    runs = []; size = 11; align = "left"; spaceAfter = 7;
  };

  for (const token of source.match(/<[^>]+>|[^<]+/g) ?? []) {
    if (!token.startsWith("<")) { pushText(token); continue; }
    const closing = /^<\s*\//.test(token);
    const name = /^<\s*\/?\s*([a-z0-9]+)/i.exec(token)?.[1]?.toLowerCase();
    if (!name) continue;
    if (name === "br" && !closing) { pushText("\n"); continue; }
    if (["p", "div", "h1", "h2", "h3", "li"].includes(name) && !closing) {
      flush();
      if (name === "h1") { size = 22; spaceAfter = 12; bold += 1; }
      if (name === "h2") { size = 17; spaceAfter = 10; bold += 1; }
      if (name === "h3") { size = 14; spaceAfter = 8; bold += 1; }
      const alignment = /(?:text-align\s*:\s*|(?:data-)?align\s*=\s*["']?)(left|center|right)/i.exec(token)?.[1];
      if (alignment === "center" || alignment === "right" || alignment === "left") align = alignment;
      if (name === "li") {
        const list = lists.at(-1);
        if (list) { list.index += 1; pushText(list.ordered ? `${list.index}. ` : "- "); }
      }
      continue;
    }
    if (["p", "div", "li"].includes(name) && closing) { flush(); continue; }
    if (["h1", "h2", "h3"].includes(name) && closing) { flush(); bold = Math.max(0, bold - 1); continue; }
    if (name === "ul" && !closing) { lists.push({ ordered: false, index: 0 }); continue; }
    if (name === "ol" && !closing) { lists.push({ ordered: true, index: 0 }); continue; }
    if ((name === "ul" || name === "ol") && closing) { lists.pop(); continue; }
    if ((name === "b" || name === "strong") && !closing) bold += 1;
    if ((name === "b" || name === "strong") && closing) bold = Math.max(0, bold - 1);
    if ((name === "i" || name === "em") && !closing) italic += 1;
    if ((name === "i" || name === "em") && closing) italic = Math.max(0, italic - 1);
    if (name === "u" && !closing) underline += 1;
    if (name === "u" && closing) underline = Math.max(0, underline - 1);
  }
  flush();
  const fallback: RichBlock = { runs: [{ text: " ", bold: false, italic: false, underline: false }], size: 11, align: "left", spaceAfter: 7 };
  return blocks.length ? blocks : [fallback];
}

function fontFor(fonts: FontSet, style: Pick<TextStyle, "bold" | "italic">) {
  if (style.bold && style.italic) return fonts.boldItalic;
  if (style.bold) return fonts.bold;
  if (style.italic) return fonts.italic;
  return fonts.normal;
}

function replaceVariables(value: string, variables: Record<string, string>) {
  return value.replace(/\{[a-z0-9_:-]+\}/gi, (token) => variables[token] ?? variables[token.toLocaleLowerCase("fr")] ?? token);
}

function safePdfText(value: string, font: PDFFont) {
  const normalized = value
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-").replace(/\u2026/g, "...").replace(/\u00A0/g, " ");
  let result = "";
  for (const character of normalized) {
    if (character === "\n") { result += character; continue; }
    try { font.encodeText(character); result += character; } catch { result += "?"; }
  }
  return result;
}

function decodeEntities(value: string) {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? "";
  });
}

function normalizedLabel(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").trim();
}

function printableValue(value: unknown, type: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Oui" : "Non";
  if (Array.isArray(value)) return value.map((entry) => printableValue(entry, type)).filter(Boolean).join(", ");
  if (typeof value === "object") return Object.values(value).map((entry) => printableValue(entry, type)).filter(Boolean).join(", ");
  const result = String(value).trim();
  return type === "Date" ? formatFrenchDate(normalizeBirthDate(result)) : result;
}

function formatFrenchDate(value: string | null) {
  if (!value) return "";
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
}

function formatPhoneNumber(value: string) {
  const compact = value.trim().replace(/[\s.-]/g, "");
  if (/^\+33\d{9}$/.test(compact)) return `+33 ${compact.slice(3, 4)} ${compact.slice(4).match(/\d{2}/g)?.join(" ") ?? ""}`.trim();
  if (/^\d{10}$/.test(compact)) return compact.match(/\d{2}/g)?.join(" ") ?? value;
  return value;
}

function normalizeBirthDate(value: string | null) {
  if (!value) return null;
  const compact = value.trim();
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(compact);
  const frenchMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(compact);
  const normalized = isoMatch
    ? `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`
    : frenchMatch
      ? `${frenchMatch[3]}-${frenchMatch[2]}-${frenchMatch[1]}`
      : null;
  if (!normalized) return null;
  const date = new Date(`${normalized}T12:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized
    ? null
    : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
