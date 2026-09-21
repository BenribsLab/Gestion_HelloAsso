import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ExtensionServerHost } from "@gu/extension-host";
import {
  documentAsPdf,
  documentHash,
  exportBaseName,
  healthAnalysisVersion,
  recognizeHealthDocument,
  validateDocument,
  type DocumentClassification,
  type DocumentContent
} from "./documents.js";

const memberDocumentSchema = z.object({ memberId: z.uuid(), fieldKey: z.string().min(1).max(100) });
const documentClassificationSchema = z.object({
  classification: z.enum(["certificate", "attestation", "questionnaire", "unknown"])
});
const documentExportSchema = z.object({
  fieldKey: z.string().min(1).max(100),
  scope: z.enum(["all", "groups"]),
  groupIds: z.array(z.uuid()).max(100).default([]),
  identitySource: z.enum(["member", "payer"]),
  template: z.string().trim().min(1).max(200),
  documentSelection: z.enum(["new", "all"]).default("new"),
  reanalyze: z.boolean().default(false)
}).refine((value) => value.scope === "all" || value.groupIds.length > 0, {
  message: "Choisissez au moins un groupe."
});
const exportIdSchema = z.object({ exportId: z.uuid() });

type DocumentRecord = {
  memberId: string;
  fieldKey: string;
  health: boolean;
  helloassoUrl: string | null;
  helloassoName: string | null;
  localContent: Buffer | null;
  localName: string | null;
  localMediaType: string | null;
  classification: DocumentClassification;
  classificationSource: "automatic" | "manual";
  analyzedHash: string | null;
  contentHash: string | null;
  lastExportedHash: string | null;
  analysisVersion: number;
};

type ExportMember = {
  id: string;
  memberFirstName: string;
  memberLastName: string;
  payerFirstName: string | null;
  payerLastName: string | null;
};

type DocumentExportJob = {
  id: string;
  owner: string;
  status: "running" | "ready" | "failed";
  total: number;
  processed: number;
  certificateCount: number;
  attestationCount: number;
  questionnaireCount: number;
  unknownCount: number;
  archive: Buffer | null;
  fileName: string | null;
  error: string | null;
  expiresAt: number;
};

const jobs = new Map<string, DocumentExportJob>();

export default function register(host: ExtensionServerHost) {
  const database = host.database;
  const getRemote = host.core.getHelloAssoDocument;
  if (!getRemote) throw new Error("La capacité helloasso-documents est requise.");

  host.contracts.registerHealthDocumentProvider({
    extensionId: host.id,
    analysisVersion: healthAnalysisVersion,
    analyze: recognizeHealthDocument
  });
  host.contracts.irlTargets.register("healthMissing", { extensionId: host.id });

  const getDocumentRecord = async (memberId: string, fieldKey: string) => {
    const result = await database.query<DocumentRecord>(`
      SELECT d.member_id AS "memberId", d.field_key AS "fieldKey",
             f.document_role = 'health' AS health,
             d.helloasso_url AS "helloassoUrl", d.helloasso_name AS "helloassoName",
             d.local_content AS "localContent", d.local_name AS "localName",
             d.local_media_type AS "localMediaType", d.classification,
             d.classification_source AS "classificationSource", d.analyzed_hash AS "analyzedHash",
             d.content_hash AS "contentHash", d.last_exported_hash AS "lastExportedHash",
             d.analysis_version AS "analysisVersion"
      FROM member_documents d
      JOIN helloasso_fields f ON f.field_key = d.field_key AND f.selected = true AND f.field_type = 'File'
      WHERE d.member_id = $1 AND d.field_key = $2
        AND (d.local_content IS NOT NULL OR d.helloasso_url IS NOT NULL)
    `, [memberId, fieldKey]);
    return result.rows[0] ?? null;
  };

  const resolveDocument = async (record: DocumentRecord): Promise<DocumentContent> => {
    if (record.localContent) {
      return validateDocument(record.localContent, record.localMediaType ?? "", record.localName ?? "document");
    }
    if (!record.helloassoUrl) throw new Error("Aucun fichier n'est disponible.");
    const remote = await getRemote(record.helloassoUrl);
    const checked = validateDocument(remote.content, remote.mediaType, remote.fileName ?? record.helloassoName ?? "document");
    const hash = documentHash(checked);
    await database.query(`
      UPDATE member_documents SET helloasso_name = $3, helloasso_media_type = $4,
        helloasso_size_bytes = $5, content_hash = $6, updated_at = now()
      WHERE member_id = $1 AND field_key = $2
    `, [record.memberId, record.fieldKey, checked.fileName, checked.mediaType, checked.content.length, hash]);
    return { ...checked, source: "helloasso" };
  };

  const analyzeAndSave = async (record: DocumentRecord, document: DocumentContent, force = false) => {
    const hash = documentHash(document);
    if (!record.health || record.classificationSource === "manual") {
      if (record.contentHash !== hash) {
        await database.query(
          "UPDATE member_documents SET content_hash = $3, updated_at = now() WHERE member_id = $1 AND field_key = $2",
          [record.memberId, record.fieldKey, hash]
        );
      }
      return record.classification;
    }
    if (!force && record.analyzedHash === hash && record.analysisVersion === healthAnalysisVersion) {
      return record.classification;
    }
    const recognition = await recognizeHealthDocument(document, hash);
    await database.query(`
      UPDATE member_documents SET classification = $3, classification_source = 'automatic',
        analyzed_hash = $4, content_hash = $4, analysis_version = $5, analyzed_at = now(), updated_at = now()
      WHERE member_id = $1 AND field_key = $2
    `, [record.memberId, record.fieldKey, recognition.classification, recognition.hash, healthAnalysisVersion]);
    return recognition.classification;
  };

  const logAccess = (userId: string | null, memberId: string | null, fieldKey: string, action: string) =>
    database.query(
      "INSERT INTO document_access_log (member_id, field_key, user_id, action) VALUES ($1, $2, $3, $4)",
      [memberId, fieldKey, userId, action]
    );

  host.route("GET", "/api/documents/config", {}, async () => {
    const [fields, settings] = await Promise.all([
      database.query<{ key: string; label: string; health: boolean; availableCount: number; newCount: number }>(`
        SELECT f.field_key AS key, f.label, f.document_role = 'health' AS health,
               count(d.member_id) FILTER (WHERE d.local_content IS NOT NULL OR d.helloasso_url IS NOT NULL)::int AS "availableCount",
               count(d.member_id) FILTER (
                 WHERE (d.local_content IS NOT NULL OR d.helloasso_url IS NOT NULL)
                   AND (d.content_hash IS NULL OR d.last_exported_hash IS DISTINCT FROM d.content_hash)
               )::int AS "newCount"
        FROM helloasso_fields f
        LEFT JOIN member_documents d ON d.field_key = f.field_key
        WHERE f.selected = true AND f.field_type = 'File'
        GROUP BY f.field_key ORDER BY f.label
      `),
      database.query<{ value: { identitySource?: "member" | "payer"; template?: string; documentSelection?: "new" | "all" } }>(
        "SELECT value FROM app_settings WHERE key = 'document_export'"
      )
    ]);
    return {
      fields: fields.rows,
      identitySource: settings.rows[0]?.value.identitySource ?? "member",
      template: settings.rows[0]?.value.template ?? "{nom}-{prenom} - {type_document}",
      documentSelection: settings.rows[0]?.value.documentSelection ?? "all"
    };
  });

  host.route("PUT", "/api/members/:memberId/documents/:fieldKey/classification", {}, async (request, reply) => {
    const input = memberDocumentSchema.parse(request.params);
    const { classification } = documentClassificationSchema.parse(request.body);
    const result = await database.query(`
      UPDATE member_documents SET classification = $3, classification_source = 'manual', updated_at = now()
      WHERE member_id = $1 AND field_key = $2 AND (local_content IS NOT NULL OR helloasso_url IS NOT NULL)
    `, [input.memberId, input.fieldKey, classification]);
    if (!result.rowCount) return reply.code(404).send({ message: "Ce document n'existe pas." });
    await logAccess(request.authUser?.id ?? null, input.memberId, input.fieldKey, "classify");
    return { classification, classificationSource: "manual" };
  });

  host.route("POST", "/api/documents/exports", { rateLimit: { max: 5, timeWindow: "1 hour" } }, async (request, reply) => {
    const input = documentExportSchema.parse(request.body);
    const owner = request.authUser?.id ?? request.authUser?.email ?? "local";
    pruneJobs();
    if ([...jobs.values()].some((job) => job.owner === owner && job.status === "running")) {
      return reply.code(409).send({ message: "Un export de documents est déjà en cours pour votre compte." });
    }
    const job: DocumentExportJob = {
      id: randomUUID(), owner, status: "running", total: 0, processed: 0,
      certificateCount: 0, attestationCount: 0, questionnaireCount: 0, unknownCount: 0,
      archive: null, fileName: null, error: null, expiresAt: Date.now() + 30 * 60_000
    };
    jobs.set(job.id, job);
    void buildExport(input, job, request.authUser?.id ?? null).catch((error: unknown) => {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "La préparation de l'archive a échoué.";
    });
    return reply.code(202).send({ exportId: job.id });
  });

  host.route("GET", "/api/documents/exports/:exportId", {}, async (request, reply) => {
    const { exportId } = exportIdSchema.parse(request.params);
    const job = ownedJob(exportId, request.authUser?.id ?? request.authUser?.email ?? "local");
    if (!job) return reply.code(404).send({ message: "Cet export n'existe plus." });
    return status(job);
  });

  host.route("GET", "/api/documents/exports/:exportId/download", {}, async (request, reply) => {
    const { exportId } = exportIdSchema.parse(request.params);
    const job = ownedJob(exportId, request.authUser?.id ?? request.authUser?.email ?? "local");
    if (!job) return reply.code(404).send({ message: "Cet export n'existe plus." });
    if (job.status !== "ready" || !job.archive || !job.fileName) {
      return reply.code(409).send({ message: "L'archive n'est pas encore prête." });
    }
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="${job.fileName}"`);
    return reply.send(job.archive);
  });

  async function buildExport(input: z.infer<typeof documentExportSchema>, job: DocumentExportJob, userId: string | null) {
    const field = await database.query<{ health: boolean }>(`
      SELECT document_role = 'health' AS health FROM helloasso_fields
      WHERE field_key = $1 AND selected = true AND field_type = 'File'
    `, [input.fieldKey]);
    if (!field.rows[0]) throw new Error("Ce champ document n'est pas disponible.");
    const members = await database.query<ExportMember>(`
      SELECT m.id, m.first_name AS "memberFirstName", m.last_name AS "memberLastName",
             m.source_data->>'payerFirstName' AS "payerFirstName",
             m.source_data->>'payerLastName' AS "payerLastName"
      FROM members m
      WHERE m.status = 'active'
        AND ($1::text = 'all' OR EXISTS (
          SELECT 1 FROM member_groups mg WHERE mg.member_id = m.id AND mg.group_id = ANY($2::uuid[])
        ))
      ORDER BY m.last_name, m.first_name
      LIMIT 1500
    `, [input.scope, input.groupIds]);
    await database.query(`
      INSERT INTO app_settings (key, value) VALUES ('document_export', $1)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `, [{ identitySource: input.identitySource, template: input.template, documentSelection: input.documentSelection }]);

    const records = await Promise.all(members.rows.map(async (member) => ({ member, record: await getDocumentRecord(member.id, input.fieldKey) })));
    const available = records.filter((entry): entry is { member: ExportMember; record: DocumentRecord } => Boolean(entry.record));
    const candidates = input.reanalyze || input.documentSelection === "all"
      ? available
      : available.filter(({ record }) => !record.contentHash || record.lastExportedHash !== record.contentHash);
    job.total = candidates.length;
    const files: Array<{ name: string; content: Buffer }> = [];
    const report: string[][] = [["Adhérent", "Fichier", "Classement", "Résultat"]];
    for (const { member, record } of records) {
      if (!record) report.push([`${member.memberLastName} ${member.memberFirstName}`, "", "", "Aucun fichier"]);
    }
    if (!input.reanalyze && input.documentSelection === "new") {
      for (const { member } of available.filter((entry) => !candidates.includes(entry))) {
        report.push([`${member.memberLastName} ${member.memberFirstName}`, "", "", "Déjà exporté — non inclus"]);
      }
    }
    const names = new Map<string, number>();
    let aggregateBytes = 0;
    for (const { member, record } of candidates) {
      try {
        const document = await resolveDocument(record);
        const hash = documentHash(document);
        const classification = field.rows[0].health
          ? await analyzeAndSave(record, document, input.reanalyze)
          : record.classification;
        const pdf = await documentAsPdf(document);
        aggregateBytes += pdf.length;
        if (aggregateBytes > 300 * 1024 * 1024) throw new Error("L'archive dépasse la limite de 300 Mo.");
        const base = exportBaseName(input.template, { ...member, identitySource: input.identitySource, classification });
        const count = (names.get(base) ?? 0) + 1;
        names.set(base, count);
        const name = `${base}${count > 1 ? ` (${count})` : ""}.pdf`;
        files.push({ name, content: pdf });
        await database.query(`
          UPDATE member_documents SET content_hash = $3, last_exported_hash = $3,
            last_exported_at = now(), updated_at = now()
          WHERE member_id = $1 AND field_key = $2
        `, [record.memberId, record.fieldKey, hash]);
        report.push([`${member.memberLastName} ${member.memberFirstName}`, name, classificationLabel(classification), "Inclus"]);
        if (classification === "certificate") job.certificateCount += 1;
        else if (classification === "attestation") job.attestationCount += 1;
        else if (classification === "questionnaire") job.questionnaireCount += 1;
        else job.unknownCount += 1;
      } catch (error) {
        job.unknownCount += 1;
        report.push([`${member.memberLastName} ${member.memberFirstName}`, "", "", error instanceof Error ? error.message : "Fichier inaccessible"]);
      } finally {
        job.processed += 1;
      }
    }
    files.push({ name: "rapport.csv", content: Buffer.from(`\uFEFF${report.map(csvRow).join("\r\n")}`, "utf8") });
    job.archive = await host.core.zipBuffer(files);
    job.fileName = `documents-${new Date().toISOString().slice(0, 10)}.zip`;
    job.status = "ready";
    job.expiresAt = Date.now() + 30 * 60_000;
    await logAccess(userId, null, input.fieldKey, "export");
  }
}

function ownedJob(id: string, owner: string) {
  const job = jobs.get(id);
  return job?.owner === owner && job.expiresAt > Date.now() ? job : null;
}

function status(job: DocumentExportJob) {
  return {
    exportId: job.id, status: job.status, total: job.total, processed: job.processed,
    certificateCount: job.certificateCount, attestationCount: job.attestationCount,
    questionnaireCount: job.questionnaireCount, unknownCount: job.unknownCount,
    error: job.error
  };
}

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) if (job.expiresAt <= now) jobs.delete(id);
}

function classificationLabel(value: DocumentClassification) {
  if (value === "certificate") return "Certificat";
  if (value === "attestation") return "Attestation";
  if (value === "questionnaire") return "Questionnaire fourni à la place de l'attestation";
  return "À classer";
}

function csvRow(values: string[]) {
  return values.map((value) => `"${value.replaceAll('"', '""')}"`).join(";");
}
