import { z } from "zod";
import type { ExtensionServerHost } from "@gu/extension-host";
import {
  createCombinedPrintDocument,
  createIndividualPrintDocument,
  getPrintDocumentVariables,
  memberPrintFileName,
  resolvePrintDocumentMembers,
  sanitizePrintDocumentHtml,
  unknownPrintVariables,
  type PrintDocumentTarget
} from "./print-documents.js";

const targetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }),
  z.object({ type: z.literal("healthMissing") }),
  z.object({ type: z.literal("groups"), groupIds: z.array(z.uuid()).min(1).max(100) }),
  z.object({ type: z.literal("categories"), categories: z.array(z.string().trim().min(1).max(50)).min(1).max(100) }),
  z.object({ type: z.literal("members"), memberIds: z.array(z.uuid()).min(1).max(1500) })
]);
const exportSchema = z.object({
  title: z.string().trim().min(1).max(120),
  contentHtml: z.string().trim().min(1).max(60_000),
  output: z.enum(["individual", "combined"]),
  target: targetSchema
});
const templateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  documentTitle: z.string().trim().min(1).max(120),
  contentHtml: z.string().trim().min(1).max(60_000),
  output: z.enum(["individual", "combined"])
});
const templateIdSchema = z.object({ templateId: z.uuid() });

type TemplateRow = {
  id: string;
  name: string;
  documentTitle: string;
  contentHtml: string;
  output: "individual" | "combined";
  createdAt: Date;
  updatedAt: Date;
};

export default function register(host: ExtensionServerHost) {
  const database = host.database;

  host.route("GET", "/api/print-documents/config", {}, async () => ({
    variables: await getPrintDocumentVariables(database)
  }));

  host.route("GET", "/api/print-documents/templates", {}, async () => {
    const result = await database.query<TemplateRow>(`
      SELECT id, name, document_title AS "documentTitle", content_html AS "contentHtml",
             output_mode AS output, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM print_document_templates
      ORDER BY lower(name), updated_at DESC
    `);
    return { items: result.rows };
  });

  host.route("POST", "/api/print-documents/templates", {}, async (request, reply) => {
    const input = templateSchema.parse(request.body);
    const contentHtml = sanitizePrintDocumentHtml(input.contentHtml);
    if (!hasText(contentHtml)) return reply.code(400).send({ message: "Le modèle ne peut pas être vide." });
    try {
      const result = await database.query<TemplateRow>(`
        INSERT INTO print_document_templates (name, document_title, content_html, output_mode, created_by)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, document_title AS "documentTitle", content_html AS "contentHtml",
                  output_mode AS output, created_at AS "createdAt", updated_at AS "updatedAt"
      `, [input.name, input.documentTitle, contentHtml, input.output, request.authUser?.id ?? null]);
      return reply.code(201).send(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ message: "Un modèle porte déjà ce nom." });
      throw error;
    }
  });

  host.route("PUT", "/api/print-documents/templates/:templateId", {}, async (request, reply) => {
    const { templateId } = templateIdSchema.parse(request.params);
    const input = templateSchema.parse(request.body);
    const contentHtml = sanitizePrintDocumentHtml(input.contentHtml);
    if (!hasText(contentHtml)) return reply.code(400).send({ message: "Le modèle ne peut pas être vide." });
    try {
      const result = await database.query<TemplateRow>(`
        UPDATE print_document_templates
        SET name = $2, document_title = $3, content_html = $4, output_mode = $5, updated_at = now()
        WHERE id = $1
        RETURNING id, name, document_title AS "documentTitle", content_html AS "contentHtml",
                  output_mode AS output, created_at AS "createdAt", updated_at AS "updatedAt"
      `, [templateId, input.name, input.documentTitle, contentHtml, input.output]);
      if (!result.rows[0]) return reply.code(404).send({ message: "Ce modèle n'existe plus." });
      return result.rows[0];
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ message: "Un modèle porte déjà ce nom." });
      throw error;
    }
  });

  host.route("DELETE", "/api/print-documents/templates/:templateId", {}, async (request, reply) => {
    const { templateId } = templateIdSchema.parse(request.params);
    const result = await database.query("DELETE FROM print_document_templates WHERE id = $1", [templateId]);
    if (!result.rowCount) return reply.code(404).send({ message: "Ce modèle n'existe plus." });
    return { templateId, deleted: true };
  });

  host.route("POST", "/api/print-documents/export", { rateLimit: { max: 10, timeWindow: "1 hour" } }, async (request, reply) => {
    const input = exportSchema.parse(request.body);
    if (input.target.type === "categories" && !host.contracts.irlTargets.isVisible(
      "categories",
      (id) => host.isExtensionEnabled(id)
    )) return reply.code(409).send({ message: "L'extension Catégories Escrime est désactivée." });
    if (input.target.type === "healthMissing" && !host.contracts.irlTargets.isVisible(
      "healthMissing",
      (id) => host.isExtensionEnabled(id)
    )) {
      return reply.code(409).send({ message: "L'extension Documents Santé FFE est désactivée." });
    }
    const contentHtml = sanitizePrintDocumentHtml(input.contentHtml);
    if (!hasText(contentHtml)) return reply.code(400).send({ message: "Le document ne peut pas être vide." });
    const variables = await getPrintDocumentVariables(database);
    const unknown = unknownPrintVariables(contentHtml, variables);
    if (unknown.length > 0) {
      return reply.code(400).send({ message: `Variable inconnue : ${unknown.slice(0, 3).join(", ")}.` });
    }
    const categoryContext = await host.contracts.loadMemberCategoryContext(
      database,
      (id) => host.isExtensionEnabled(id)
    );
    const members = await resolvePrintDocumentMembers(database, input.target as PrintDocumentTarget, categoryContext);
    if (members.length === 0) return reply.code(400).send({ message: "Aucun adhérent ne correspond à cette sélection." });
    const archiveName = host.core.safeDownloadName(input.title);
    if (input.output === "combined") {
      const pdf = await createCombinedPrintDocument(contentHtml, members, input.title);
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Length", pdf.length);
      reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${archiveName}.pdf`)}`);
      return reply.send(pdf);
    }
    const names = new Map<string, number>();
    const files: Array<{ name: string; content: Buffer }> = [];
    for (const member of members) {
      const original = memberPrintFileName(member).replace(/\.pdf$/i, "");
      const count = (names.get(original) ?? 0) + 1;
      names.set(original, count);
      files.push({
        name: `${original}${count > 1 ? `-${count}` : ""}.pdf`,
        content: await createIndividualPrintDocument(contentHtml, member, input.title)
      });
    }
    const archive = await host.core.zipBuffer(files);
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Length", archive.length);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${archiveName}.zip`)}`);
    return reply.send(archive);
  });
}

function hasText(html: string) {
  return html.replace(/<[^>]+>/g, "").replace(/&nbsp;|&#160;/gi, " ").trim().length > 0;
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}
