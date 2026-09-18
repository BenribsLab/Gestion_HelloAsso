import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { ZipArchive } from "archiver";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { createHelloAssoClient, HelloAssoError } from "./helloasso.js";
import { getAttendanceSheet, getSchoolHolidays, saveAttendance } from "./attendance.js";
import { categoryForBirthDate, getCategoryConfiguration, getCategoryDefinitions, getCategorySeason } from "./categories.js";
import { getDynamicGroupCriteria, refreshDynamicGroups, validateDynamicCriterion } from "./dynamic-groups.js";
import { emailConfiguration, listEmailMessages, previewRecipients, sendEmailMessage, verifyEmailConnection } from "./email.js";
import { fencingCategoryError, normalizeBirthDate } from "./fencing-category.js";
import { installSecurity, prepareAuthentication } from "./security.js";
import {
  documentAsPdf,
  documentHash,
  exportBaseName,
  healthAnalysisVersion,
  maxDocumentBytes,
  recognizeHealthDocument,
  validateDocument,
  type DocumentClassification,
  type DocumentContent
} from "./documents.js";
import {
  discoverCampaigns,
  getSetupState,
  importMembers,
  previewGrouping,
  saveGroupDefinitions,
  selectCampaigns,
  selectFields
} from "./setup.js";

const config = loadConfig();
const database = createDatabase(config);
const helloasso = createHelloAssoClient(config);
const documentExportJobs = new Map<string, DocumentExportJob>();
const server = Fastify({
  logger: true,
  trustProxy: config.trustProxy,
  bodyLimit: 1_048_576,
  requestTimeout: 30_000,
  connectionTimeout: 10_000
});

await server.register(cookie);
await server.register(multipart, {
  limits: { files: 1, fileSize: maxDocumentBytes, fields: 5, parts: 6 }
});
await server.register(rateLimit, {
  global: true,
  max: 300,
  timeWindow: "1 minute",
  errorResponseBuilder: () => ({ statusCode: 429, message: "Trop de requêtes. Réessayez dans quelques instants." })
});
await prepareAuthentication(database, config);
await installSecurity(server, database, config);

const groupInputSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional().default(""),
  criterion: z.object({
    fieldKey: z.string().min(1).max(100),
    values: z.array(z.string().trim().min(1).max(500)).min(1).max(100)
  })
});
const campaignSelectionSchema = z.object({
  formSlugs: z.array(z.string().min(1)).min(1).max(100)
});
const fieldSelectionSchema = z.object({
  fieldKeys: z.array(z.string().min(1)).max(100),
  healthDocumentFieldKey: z.string().min(1).max(100).nullable().optional()
});
const groupingPreviewSchema = z.object({
  fieldKeys: z.array(z.string().min(1)).min(1).max(20)
});
const groupDefinitionsSchema = z.object({
  groups: z.array(z.object({
    id: z.uuid().optional(),
    name: z.string().trim().min(2).max(100),
    rules: z.array(z.object({
      fieldKey: z.string().min(1),
      value: z.string().trim().min(1).max(500)
    })).min(1).max(200)
  })).max(100)
});
const memberIdSchema = z.object({ memberId: z.uuid() });
const groupIdSchema = z.object({ groupId: z.uuid() });
const categoryIdSchema = z.object({ categoryId: z.uuid() });
const categoryInputSchema = z.object({
  name: z.string().trim().min(1).max(50),
  birthYearFrom: z.number().int().min(1900).max(2200),
  birthYearTo: z.number().int().min(1900).max(2200)
}).refine((category) => category.birthYearFrom <= category.birthYearTo, {
  message: "L'année de début doit précéder l'année de fin."
});
const categorySettingsSchema = z.object({
  rolloverDate: z.string().regex(/^\d{2}-\d{2}$/)
}).refine(({ rolloverDate }) => {
  const [month, day] = rolloverDate.split("-").map(Number);
  const value = new Date(Date.UTC(2000, month! - 1, day));
  return value.getUTCMonth() === month! - 1 && value.getUTCDate() === day;
}, { message: "La date de changement de saison est invalide." });
const memberGroupSelectionSchema = z.object({
  groupIds: z.array(z.uuid()).max(100)
});
const memberUpdateSchema = z.object({
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  email: z.union([z.email(), z.literal("")]).optional(),
  phone: z.string().trim().max(40).optional(),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
    (value) => fencingCategoryError(value) === null,
    { message: "La date de naissance est invalide." }
  ).optional(),
  profileData: z.record(z.string(), z.union([z.string().max(2_000), z.boolean(), z.number(), z.null()])).optional(),
  groupIds: z.array(z.uuid()).max(100).optional()
});
const memberOverrideFieldSchema = z.object({
  memberId: z.uuid(),
  fieldKey: z.string().min(1).max(100)
});
const memberDocumentSchema = z.object({ memberId: z.uuid(), fieldKey: z.string().min(1).max(100) });
const documentClassificationSchema = z.object({ classification: z.enum(["certificate", "attestation", "questionnaire", "unknown"]) });
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
const documentExportIdSchema = z.object({ exportId: z.uuid() });
const scheduleSelectionSchema = z.object({
  schedules: z.array(z.object({
    weekday: z.number().int().min(1).max(7),
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  }).refine((schedule) => schedule.endTime > schedule.startTime, {
    message: "L'heure de fin doit suivre l'heure de début."
  })).max(20)
});
const attendanceQuerySchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
}).refine((period) => period.endDate >= period.startDate, {
  message: "La période est invalide."
}).refine((period) => {
  const days = (Date.parse(period.endDate) - Date.parse(period.startDate)) / 86_400_000;
  return days <= 730;
}, { message: "La période ne peut pas dépasser deux ans." });
const attendanceSaveSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  records: z.array(z.object({
    memberId: z.uuid(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    status: z.enum(["present", "absent", "excused"])
  })).max(20_000)
}).refine((input) => input.endDate >= input.startDate && input.records.every(
  (record) => record.date >= input.startDate && record.date <= input.endDate
), { message: "Les présences ne correspondent pas à la période." });
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

server.get("/api/health", async () => {
  await database.query("SELECT 1");
  return { status: "ok" };
});

server.get("/api/dashboard", async () => {
  const [memberResult, groupResult] = await Promise.all([
    database.query<{ count: string }>("SELECT count(*)::text AS count FROM members"),
    database.query<{ count: string }>("SELECT count(*)::text AS count FROM groups")
  ]);

  return {
    membersCount: Number(memberResult.rows[0]?.count ?? 0),
    groupsCount: Number(groupResult.rows[0]?.count ?? 0),
    helloasso: {
      configured: config.helloasso.configured,
      environment: config.helloasso.baseUrl.includes("sandbox") ? "sandbox" : "production",
      organizationSlug: config.helloasso.organizationSlug || null
    },
    smtp: emailConfiguration(config)
  };
});

server.get("/api/email/status", async () => emailConfiguration(config));

server.post("/api/email/verify", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (_request, reply) => {
  if (!config.smtp.configured) {
    return reply.code(409).send({ message: "Renseignez d'abord les paramètres SMTP dans le fichier .env." });
  }
  try {
    await verifyEmailConnection(config);
    return { connected: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 300) : "Erreur inconnue";
    return reply.code(502).send({ message: `Connexion SMTP refusée : ${detail}` });
  }
});

server.post("/api/email/recipients-preview", async (request) => {
  const target = emailTargetSchema.parse(request.body);
  return previewRecipients(database, target);
});

server.get("/api/email/messages", async () => ({
  items: await listEmailMessages(database)
}));

server.post("/api/email/messages", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (request, reply) => {
  if (!config.smtp.configured) {
    return reply.code(409).send({ message: "L'envoi SMTP n'est pas configuré dans le fichier .env." });
  }
  const input = emailMessageSchema.parse(request.body);
  try {
    return await sendEmailMessage(database, config, input);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "L'envoi du message a échoué.";
    return reply.code(400).send({ message: detail });
  }
});

server.get("/api/members", async () => {
  const [result, fieldsResult, documentsResult, categoryDefinitions, categorySeason] = await Promise.all([database.query<{
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    status: string;
    source: string;
    campaignTitle: string | null;
    tierName: string | null;
    birthDate: string | null;
    groups: Array<{ id: string; name: string }>;
    profileData: Record<string, unknown>;
    localOverrides: Record<string, unknown>;
  }>(`
    SELECT
      m.id,
      COALESCE(NULLIF(m.local_overrides->>'firstName', ''), m.first_name) AS "firstName",
      COALESCE(NULLIF(m.local_overrides->>'lastName', ''), m.last_name) AS "lastName",
      CASE WHEN m.local_overrides ? 'email' THEN NULLIF(m.local_overrides->>'email', '') ELSE m.email END AS email,
      CASE WHEN m.local_overrides ? 'phone' THEN NULLIF(m.local_overrides->>'phone', '') ELSE m.phone END AS phone,
      m.status,
      m.source,
      m.source_data->>'campaignTitle' AS "campaignTitle",
      m.source_data->>'tierName' AS "tierName",
      CASE WHEN m.local_overrides ? 'birthDate'
        THEN m.local_overrides->>'birthDate'
        ELSE COALESCE(to_char(m.birth_date, 'YYYY-MM-DD'), birth.value)
      END AS "birthDate",
      COALESCE(m.profile_data, '{}'::jsonb) AS "profileData",
      m.local_overrides AS "localOverrides",
      COALESCE(
        jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name))
          FILTER (WHERE g.id IS NOT NULL),
        '[]'::jsonb
      ) AS groups
    FROM members m
    LEFT JOIN LATERAL (
      SELECT field_value.value #>> '{}' AS value
      FROM jsonb_each(COALESCE(m.profile_data, '{}'::jsonb)) field_value
      JOIN helloasso_fields field ON field.field_key = field_value.key
      WHERE field.field_type = 'Date' AND field.label ILIKE '%naissance%'
      LIMIT 1
    ) birth ON true
    LEFT JOIN member_groups mg ON mg.member_id = m.id
    LEFT JOIN groups g ON g.id = mg.group_id
    GROUP BY m.id, birth.value
    ORDER BY m.last_name, m.first_name
  `), database.query<{ key: string; label: string; type: string; documentRole: "health" | null }>(`
    SELECT field_key AS key, label, field_type AS type, document_role AS "documentRole"
    FROM helloasso_fields WHERE selected = true ORDER BY label
  `), database.query<{
    memberId: string; fieldKey: string; helloassoAvailable: boolean; localAvailable: boolean;
    helloassoName: string | null; localName: string | null; helloassoMediaType: string | null;
    localMediaType: string | null; helloassoSizeBytes: number | null; localSizeBytes: number | null;
    classification: DocumentClassification; classificationSource: "automatic" | "manual"; analyzedAt: Date | null;
  }>(`
    SELECT member_id AS "memberId", field_key AS "fieldKey",
           helloasso_url IS NOT NULL AS "helloassoAvailable",
           local_content IS NOT NULL AS "localAvailable",
           helloasso_name AS "helloassoName", local_name AS "localName",
           helloasso_media_type AS "helloassoMediaType", local_media_type AS "localMediaType",
           helloasso_size_bytes AS "helloassoSizeBytes", local_size_bytes AS "localSizeBytes",
           classification, classification_source AS "classificationSource", analyzed_at AS "analyzedAt"
    FROM member_documents
  `), getCategoryDefinitions(database), getCategorySeason(database)]);
  const documents = new Map(documentsResult.rows.map((document) => [`${document.memberId}\0${document.fieldKey}`, document]));
  return {
    season: categorySeason.label,
    items: result.rows.map((member) => {
      const birthDate = normalizeBirthDate(member.birthDate);
      const profileOverrides = isRecord(member.localOverrides.profileData)
        ? member.localOverrides.profileData
        : {};
      return {
        ...member,
        birthDate,
        fencingCategory: categoryForBirthDate(birthDate, categoryDefinitions),
        categoryError: fencingCategoryError(birthDate),
        overriddenFields: ["firstName", "lastName", "email", "phone", "birthDate"].filter(
          (key) => Object.hasOwn(member.localOverrides, key)
        ),
        customFields: fieldsResult.rows.map((field) => {
          const document = documents.get(`${member.id}\0${field.key}`);
          const linkedField = linkedCoreField(field);
          const linkedOverride = linkedField && Object.hasOwn(member.localOverrides, linkedField);
          return {
            ...field,
            value: Object.hasOwn(profileOverrides, field.key)
              ? profileOverrides[field.key]
              : linkedOverride
                ? member.localOverrides[linkedField]
                : member.profileData[field.key] ?? null,
            overridden: Object.hasOwn(profileOverrides, field.key) || Boolean(linkedOverride),
            document: field.type === "File" ? {
              available: Boolean(document?.localAvailable || document?.helloassoAvailable),
              source: document?.localAvailable ? "local" : document?.helloassoAvailable ? "helloasso" : null,
              fileName: document?.localAvailable ? document.localName : document?.helloassoName ?? null,
              mediaType: document?.localAvailable ? document.localMediaType : document?.helloassoMediaType ?? null,
              sizeBytes: document?.localAvailable ? document.localSizeBytes : document?.helloassoSizeBytes ?? null,
              classification: document?.classification ?? "unknown",
              classificationSource: document?.classificationSource ?? "automatic",
              health: field.documentRole === "health",
              analyzedAt: document?.analyzedAt ?? null,
              hasHelloAssoOriginal: Boolean(document?.helloassoAvailable)
            } : undefined
          };
        }),
        profileData: undefined,
        localOverrides: undefined
      };
    })
  };
});

server.get("/api/groups", async () => {
  await refreshDynamicGroups(database);
  const result = await database.query<{
    id: string;
    name: string;
    description: string | null;
    source: "manual" | "helloasso" | "dynamic";
    membersCount: number;
    createdAt: Date;
    dynamicRule: { fieldKey: string; values: string[] } | null;
    trainingSchedules: Array<{ weekday: number; startTime: string; endTime: string }>;
  }>(`
    SELECT
      g.id,
      g.name,
      g.description,
      g.source,
      g.created_at AS "createdAt",
      CASE WHEN g.source = 'dynamic' THEN (
        SELECT jsonb_build_object(
          'fieldKey', min(rule.field_key),
          'values', jsonb_agg(rule.match_value ORDER BY rule.match_value)
        )
        FROM group_dynamic_rules rule WHERE rule.group_id = g.id
      ) ELSE NULL END AS "dynamicRule",
      (SELECT count(*)::int FROM member_groups mg WHERE mg.group_id = g.id) AS "membersCount",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'weekday', s.weekday,
          'startTime', to_char(s.start_time, 'HH24:MI'),
          'endTime', to_char(s.end_time, 'HH24:MI')
        ) ORDER BY s.weekday, s.start_time)
        FROM group_training_schedules s WHERE s.group_id = g.id
      ), '[]'::jsonb) AS "trainingSchedules"
    FROM groups g
    ORDER BY g.name
  `);
  return { items: result.rows };
});

server.get("/api/group-criteria", async () => ({
  items: await getDynamicGroupCriteria(database)
}));

server.get("/api/categories", async () => getCategoryConfiguration(database));

server.put("/api/categories/settings", async (request) => {
  const input = categorySettingsSchema.parse(request.body);
  const [month, day] = input.rolloverDate.split("-").map(Number);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE fencing_category_settings
       SET rollover_month = $1, rollover_day = $2, updated_at = now()
       WHERE singleton = true`,
      [month, day]
    );
    await refreshDynamicGroups(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return getCategoryConfiguration(database);
});

server.post("/api/categories", async (request, reply) => {
  const input = categoryInputSchema.parse(request.body);
  const season = await getCategorySeason(database);
  await getCategoryDefinitions(database);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const conflict = await client.query(
      `SELECT 1 FROM fencing_categories
       WHERE season_start_year = $1
         AND (lower(name) = lower($2) OR int4range(birth_year_from, birth_year_to, '[]') && int4range($3, $4, '[]'))`,
      [season.startYear, input.name, input.birthYearFrom, input.birthYearTo]
    );
    if (conflict.rowCount) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ message: "Ce nom ou ces années de naissance sont déjà utilisés." });
    }
    const result = await client.query<{ id: string }>(
      `INSERT INTO fencing_categories
         (season_start_year, name, birth_year_from, birth_year_to, sort_order)
       VALUES ($1, $2, $3, $4, COALESCE((
         SELECT max(sort_order) + 1 FROM fencing_categories WHERE season_start_year = $1
       ), 0)) RETURNING id`,
      [season.startYear, input.name, input.birthYearFrom, input.birthYearTo]
    );
    await refreshDynamicGroups(client);
    await client.query("COMMIT");
    return reply.code(201).send({ id: result.rows[0]!.id });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

server.put("/api/categories/:categoryId", async (request, reply) => {
  const { categoryId } = categoryIdSchema.parse(request.params);
  const input = categoryInputSchema.parse(request.body);
  const season = await getCategorySeason(database);
  await getCategoryDefinitions(database);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query<{ name: string }>(
      "SELECT name FROM fencing_categories WHERE id = $1 AND season_start_year = $2 FOR UPDATE",
      [categoryId, season.startYear]
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ message: "Cette catégorie n'existe pas pour la saison actuelle." });
    }
    const conflict = await client.query(
      `SELECT 1 FROM fencing_categories
       WHERE season_start_year = $1 AND id <> $2
         AND (lower(name) = lower($3) OR int4range(birth_year_from, birth_year_to, '[]') && int4range($4, $5, '[]'))`,
      [season.startYear, categoryId, input.name, input.birthYearFrom, input.birthYearTo]
    );
    if (conflict.rowCount) {
      await client.query("ROLLBACK");
      return reply.code(409).send({ message: "Ce nom ou ces années de naissance sont déjà utilisés." });
    }
    await client.query(
      `UPDATE fencing_categories SET
         name = $3, birth_year_from = $4, birth_year_to = $5, updated_at = now()
       WHERE id = $1 AND season_start_year = $2`,
      [categoryId, season.startYear, input.name, input.birthYearFrom, input.birthYearTo]
    );
    if (current.name !== input.name) {
      await client.query(
        `UPDATE group_dynamic_rules SET match_value = $2
         WHERE field_key = 'category' AND match_value = $1`,
        [current.name, input.name]
      );
    }
    await refreshDynamicGroups(client);
    await client.query("COMMIT");
    return { id: categoryId, updated: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

server.delete("/api/categories/:categoryId", async (request, reply) => {
  const { categoryId } = categoryIdSchema.parse(request.params);
  const season = await getCategorySeason(database);
  await getCategoryDefinitions(database);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query<{ name: string }>(
      "SELECT name FROM fencing_categories WHERE id = $1 AND season_start_year = $2 FOR UPDATE",
      [categoryId, season.startYear]
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ message: "Cette catégorie n'existe pas pour la saison actuelle." });
    }
    await client.query(
      "DELETE FROM group_dynamic_rules WHERE field_key = 'category' AND match_value = $1",
      [current.name]
    );
    await client.query("DELETE FROM fencing_categories WHERE id = $1", [categoryId]);
    await refreshDynamicGroups(client);
    await client.query("COMMIT");
    return { id: categoryId, deleted: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

server.post("/api/groups", async (request, reply) => {
  const input = groupInputSchema.parse(request.body);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const criterion = await validateDynamicCriterion(client, input.criterion.fieldKey, input.criterion.values);
    if (!criterion) {
      await client.query("ROLLBACK");
      return reply.code(400).send({ message: "Le critère choisi n'est pas disponible." });
    }
    const result = await client.query<{
      id: string;
      name: string;
      description: string | null;
      createdAt: Date;
    }>(
      `INSERT INTO groups (name, description, source)
       VALUES ($1, NULLIF($2, ''), 'dynamic')
       RETURNING id, name, description, created_at AS "createdAt"`,
      [input.name, input.description]
    );
    const group = result.rows[0]!;
    for (const value of criterion.values) {
      await client.query(
        `INSERT INTO group_dynamic_rules (group_id, field_key, match_value)
         VALUES ($1, $2, $3)`,
        [group.id, criterion.field.key, value]
      );
    }
    await refreshDynamicGroups(client);
    const countResult = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM member_groups WHERE group_id = $1",
      [group.id]
    );
    await client.query("COMMIT");
    return reply.code(201).send({
      ...group,
      source: "dynamic",
      membersCount: countResult.rows[0]?.count ?? 0,
      dynamicRule: { fieldKey: criterion.field.key, values: criterion.values },
      trainingSchedules: []
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      return reply.code(409).send({ message: "Un groupe porte déjà ce nom." });
    }
    throw error;
  } finally {
    client.release();
  }
});

server.delete("/api/groups/:groupId", async (request, reply) => {
  const { groupId } = groupIdSchema.parse(request.params);
  const groupResult = await database.query<{ name: string; source: string }>(
    "SELECT name, source FROM groups WHERE id = $1",
    [groupId]
  );
  const group = groupResult.rows[0];
  if (!group) return reply.code(404).send({ message: "Ce groupe n'existe pas." });
  if (group.source === "helloasso") {
    return reply.code(409).send({
      message: "Ce groupe provient de la configuration HelloAsso et doit être supprimé depuis celle-ci."
    });
  }
  await database.query("DELETE FROM groups WHERE id = $1", [groupId]);
  return { groupId, deleted: true };
});

server.put("/api/groups/:groupId/schedules", async (request, reply) => {
  const { groupId } = groupIdSchema.parse(request.params);
  const input = scheduleSelectionSchema.parse(request.body);
  const schedules = [...new Map(input.schedules.map((schedule) => [
    `${schedule.weekday}:${schedule.startTime}:${schedule.endTime}`,
    schedule
  ])).values()];
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const groupResult = await client.query("SELECT 1 FROM groups WHERE id = $1", [groupId]);
    if (groupResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ message: "Ce groupe n'existe pas." });
    }
    await client.query("DELETE FROM group_training_schedules WHERE group_id = $1", [groupId]);
    for (const schedule of schedules) {
      await client.query(
        `INSERT INTO group_training_schedules (group_id, weekday, start_time, end_time)
         VALUES ($1, $2, $3, $4)`,
        [groupId, schedule.weekday, schedule.startTime, schedule.endTime]
      );
    }
    await client.query("COMMIT");
    return { groupId, schedules };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

server.get("/api/school-holidays", async (request) => {
  const period = attendanceQuerySchema.parse(request.query);
  return { zone: "C", academy: "Versailles", items: await getSchoolHolidays(period.startDate, period.endDate) };
});

server.get("/api/groups/:groupId/attendance-sheet", async (request, reply) => {
  const { groupId } = groupIdSchema.parse(request.params);
  const period = attendanceQuerySchema.parse(request.query);
  const sheet = await getAttendanceSheet(database, groupId, period.startDate, period.endDate);
  if (!sheet) return reply.code(404).send({ message: "Ce groupe n'existe pas." });
  return sheet;
});

server.put("/api/groups/:groupId/attendance", async (request, reply) => {
  const { groupId } = groupIdSchema.parse(request.params);
  const input = attendanceSaveSchema.parse(request.body);
  const saved = await saveAttendance(database, groupId, input.startDate, input.endDate, input.records);
  if (!saved) return reply.code(404).send({ message: "Ce groupe n'existe pas." });
  return { savedCount: input.records.length };
});

server.put("/api/members/:memberId/groups", async (request, reply) => {
  const { memberId } = memberIdSchema.parse(request.params);
  const input = memberGroupSelectionSchema.parse(request.body);
  const groupIds = [...new Set(input.groupIds)];
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const memberResult = await client.query("SELECT 1 FROM members WHERE id = $1", [memberId]);
    if (memberResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ message: "Cet adhérent n'existe pas." });
    }
    if (groupIds.length > 0) {
      const groupsResult = await client.query<{ id: string }>(
        "SELECT id FROM groups WHERE id = ANY($1::uuid[])",
        [groupIds]
      );
      if (groupsResult.rowCount !== groupIds.length) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ message: "Un des groupes choisis n'existe pas." });
      }
    }

    await client.query("DELETE FROM member_groups WHERE member_id = $1", [memberId]);
    if (groupIds.length > 0) {
      await client.query(
        `INSERT INTO member_groups (member_id, group_id, source)
         SELECT $1, id, 'manual' FROM groups WHERE id = ANY($2::uuid[])`,
        [memberId, groupIds]
      );
    }

    await client.query("DELETE FROM member_group_exclusions WHERE member_id = $1", [memberId]);
    await client.query(
      `INSERT INTO member_group_exclusions (member_id, group_id)
       SELECT $1, id
       FROM groups
       WHERE source IN ('helloasso', 'dynamic')
         AND NOT (id = ANY($2::uuid[]))`,
      [memberId, groupIds]
    );
    await client.query("COMMIT");
    return { memberId, groupIds };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

server.put("/api/members/:memberId", async (request, reply) => {
  const { memberId } = memberIdSchema.parse(request.params);
  const input = memberUpdateSchema.parse(request.body);
  const groupIds = input.groupIds ? [...new Set(input.groupIds)] : null;
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    if (groupIds && groupIds.length > 0) {
      const groupsResult = await client.query("SELECT id FROM groups WHERE id = ANY($1::uuid[])", [groupIds]);
      if (groupsResult.rowCount !== groupIds.length) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ message: "Un des groupes choisis n'existe pas." });
      }
    }
    const memberResult = await client.query<{ localOverrides: Record<string, unknown> }>(
      `SELECT local_overrides AS "localOverrides" FROM members WHERE id = $1 FOR UPDATE`,
      [memberId]
    );
    if (!memberResult.rows[0]) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ message: "Cet adhérent n'existe pas." });
    }
    const localOverrides = { ...memberResult.rows[0].localOverrides };
    for (const key of ["firstName", "lastName", "email", "phone", "birthDate"] as const) {
      if (input[key] !== undefined) localOverrides[key] = input[key];
    }
    if (input.profileData && Object.keys(input.profileData).length > 0) {
      const fieldKeys = Object.keys(input.profileData);
      const fieldsResult = await client.query<{ key: string; label: string; type: string }>(
        `SELECT field_key AS key, label, field_type AS type
         FROM helloasso_fields
         WHERE selected = true AND field_type <> 'File' AND field_key = ANY($1::text[])`,
        [fieldKeys]
      );
      if (fieldsResult.rowCount !== fieldKeys.length) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ message: "Un des champs supplémentaires n'est pas modifiable ici." });
      }
      const profileOverrides = isRecord(localOverrides.profileData)
        ? { ...localOverrides.profileData }
        : {};
      for (const field of fieldsResult.rows) {
        const value = input.profileData[field.key] ?? null;
        profileOverrides[field.key] = value;
        const linkedField = linkedCoreField(field);
        if (linkedField === "birthDate") {
          const birthDate = typeof value === "string" ? normalizeBirthDate(value) : null;
          if (!birthDate || fencingCategoryError(birthDate)) {
            await client.query("ROLLBACK");
            return reply.code(400).send({ message: "La date de naissance est invalide." });
          }
          localOverrides.birthDate = birthDate;
        } else if (linkedField) {
          localOverrides[linkedField] = value === null ? "" : String(value);
        }
      }
      localOverrides.profileData = profileOverrides;
    }
    await client.query(
      "UPDATE members SET local_overrides = $2, updated_at = now() WHERE id = $1",
      [memberId, localOverrides]
    );
    if (groupIds) {
      await client.query("DELETE FROM member_groups WHERE member_id = $1", [memberId]);
      if (groupIds.length > 0) {
        await client.query(
          `INSERT INTO member_groups (member_id, group_id, source)
           SELECT $1, id, 'manual' FROM groups WHERE id = ANY($2::uuid[])`,
          [memberId, groupIds]
        );
      }
      await client.query("DELETE FROM member_group_exclusions WHERE member_id = $1", [memberId]);
      await client.query(
        `INSERT INTO member_group_exclusions (member_id, group_id)
         SELECT $1, id FROM groups
         WHERE source IN ('helloasso', 'dynamic') AND NOT (id = ANY($2::uuid[]))`,
        [memberId, groupIds]
      );
    }
    await refreshDynamicGroups(client);
    await client.query("COMMIT");
    return { memberId, protectedLocally: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

server.delete("/api/members/:memberId/overrides/:fieldKey", async (request, reply) => {
  const { memberId, fieldKey } = memberOverrideFieldSchema.parse(request.params);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const memberResult = await client.query<{ localOverrides: Record<string, unknown> }>(
      `SELECT local_overrides AS "localOverrides" FROM members WHERE id = $1 FOR UPDATE`,
      [memberId]
    );
    if (!memberResult.rows[0]) {
      await client.query("ROLLBACK");
      return reply.code(404).send({ message: "Cet adhérent n'existe pas." });
    }
    const localOverrides = { ...memberResult.rows[0].localOverrides };
    if (["firstName", "lastName", "email", "phone", "birthDate"].includes(fieldKey)) {
      delete localOverrides[fieldKey];
    } else {
      const fieldResult = await client.query<{ key: string; label: string; type: string }>(
        `SELECT field_key AS key, label, field_type AS type
         FROM helloasso_fields WHERE selected = true AND field_key = $1`,
        [fieldKey]
      );
      const field = fieldResult.rows[0];
      if (!field) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ message: "Ce champ supplémentaire n'existe pas." });
      }
      const profileOverrides = isRecord(localOverrides.profileData)
        ? { ...localOverrides.profileData }
        : {};
      delete profileOverrides[fieldKey];
      localOverrides.profileData = profileOverrides;
      const linkedField = linkedCoreField(field);
      if (linkedField) delete localOverrides[linkedField];
    }
    await client.query(
      "UPDATE members SET local_overrides = $2, updated_at = now() WHERE id = $1",
      [memberId, localOverrides]
    );
    await refreshDynamicGroups(client);
    await client.query("COMMIT");
    return { memberId, fieldKey, revertedToHelloAsso: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

server.get("/api/documents/config", async () => {
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

server.get("/api/members/:memberId/documents/:fieldKey", async (request, reply) => {
  const input = memberDocumentSchema.parse(request.params);
  const query = z.object({ download: z.enum(["0", "1"]).optional() }).parse(request.query);
  const record = await getDocumentRecord(input.memberId, input.fieldKey);
  if (!record) return reply.code(404).send({ message: "Ce document n'existe pas." });
  const document = await resolveDocument(record);
  await analyzeAndSave(record, document);
  await logDocumentAccess(request.authUser?.id ?? null, input.memberId, input.fieldKey, query.download === "1" ? "download" : "view");
  reply.header("Content-Type", document.mediaType);
  reply.header("Content-Length", document.content.length);
  reply.header("Content-Disposition", `${query.download === "1" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(document.fileName)}`);
  return reply.send(document.content);
});

server.post("/api/members/:memberId/documents/:fieldKey", {
  bodyLimit: 16 * 1024 * 1024,
  config: { rateLimit: { max: 20, timeWindow: "1 hour" } }
}, async (request, reply) => {
  const input = memberDocumentSchema.parse(request.params);
  const field = await database.query<{ health: boolean }>(`
    SELECT document_role = 'health' AS health FROM helloasso_fields
    WHERE field_key = $1 AND selected = true AND field_type = 'File'
      AND EXISTS (SELECT 1 FROM members WHERE id = $2)
  `, [input.fieldKey, input.memberId]);
  if (!field.rows[0]) return reply.code(404).send({ message: "Ce champ document n'existe pas." });
  const part = await request.file();
  if (!part) return reply.code(400).send({ message: "Choisissez un fichier." });
  const content = await part.toBuffer();
  const document = validateDocument(content, part.mimetype, part.filename);
  const hash = documentHash(document);
  const recognition = field.rows[0].health
    ? await recognizeHealthDocument(document, hash)
    : { classification: "unknown" as const, hash };
  await database.query(`
    INSERT INTO member_documents
      (member_id, field_key, local_content, local_name, local_media_type, local_size_bytes,
       classification, classification_source, analyzed_hash, analyzed_at, local_uploaded_at,
       content_hash, analysis_version)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'automatic', $8, now(), now(), $9, $10)
    ON CONFLICT (member_id, field_key) DO UPDATE SET
      local_content = EXCLUDED.local_content, local_name = EXCLUDED.local_name,
      local_media_type = EXCLUDED.local_media_type, local_size_bytes = EXCLUDED.local_size_bytes,
      classification = EXCLUDED.classification, classification_source = 'automatic',
      analyzed_hash = EXCLUDED.analyzed_hash, analyzed_at = now(), local_uploaded_at = now(),
      content_hash = EXCLUDED.content_hash, analysis_version = EXCLUDED.analysis_version, updated_at = now()
  `, [input.memberId, input.fieldKey, document.content, document.fileName, document.mediaType,
    document.content.length, recognition.classification, recognition.hash, hash,
    field.rows[0].health ? healthAnalysisVersion : 0]);
  await logDocumentAccess(request.authUser?.id ?? null, input.memberId, input.fieldKey, "upload");
  return { uploaded: true, classification: recognition.classification };
});

server.delete("/api/members/:memberId/documents/:fieldKey/local", async (request, reply) => {
  const input = memberDocumentSchema.parse(request.params);
  const result = await database.query(`
    UPDATE member_documents SET local_content = NULL, local_name = NULL, local_media_type = NULL,
      local_size_bytes = NULL, local_uploaded_at = NULL, classification = 'unknown',
      classification_source = 'automatic', analyzed_hash = NULL, analyzed_at = NULL,
      content_hash = NULL, analysis_version = 0, updated_at = now()
    WHERE member_id = $1 AND field_key = $2 AND local_content IS NOT NULL
  `, [input.memberId, input.fieldKey]);
  if (!result.rowCount) return reply.code(404).send({ message: "Aucun fichier local à supprimer." });
  await logDocumentAccess(request.authUser?.id ?? null, input.memberId, input.fieldKey, "revert");
  return { revertedToHelloAsso: true };
});

server.put("/api/members/:memberId/documents/:fieldKey/classification", async (request, reply) => {
  const input = memberDocumentSchema.parse(request.params);
  const { classification } = documentClassificationSchema.parse(request.body);
  const result = await database.query(`
    UPDATE member_documents SET classification = $3, classification_source = 'manual', updated_at = now()
    WHERE member_id = $1 AND field_key = $2 AND (local_content IS NOT NULL OR helloasso_url IS NOT NULL)
  `, [input.memberId, input.fieldKey, classification]);
  if (!result.rowCount) return reply.code(404).send({ message: "Ce document n'existe pas." });
  await logDocumentAccess(request.authUser?.id ?? null, input.memberId, input.fieldKey, "classify");
  return { classification, classificationSource: "manual" };
});

server.post("/api/documents/exports", {
  config: { rateLimit: { max: 5, timeWindow: "1 hour" } }
}, async (request, reply) => {
  const input = documentExportSchema.parse(request.body);
  const owner = request.authUser?.id ?? request.authUser?.email ?? "local";
  pruneDocumentExportJobs();
  if ([...documentExportJobs.values()].some((job) => job.owner === owner && job.status === "running")) {
    return reply.code(409).send({ message: "Un export de documents est déjà en cours pour votre compte." });
  }
  const job: DocumentExportJob = {
    id: randomUUID(), owner, status: "running", total: 0, processed: 0,
    certificateCount: 0, attestationCount: 0, questionnaireCount: 0, unknownCount: 0,
    archive: null, fileName: null, error: null, expiresAt: Date.now() + 30 * 60_000
  };
  documentExportJobs.set(job.id, job);
  void buildDocumentExport(input, job, request.authUser?.id ?? null).catch((error: unknown) => {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : "La préparation de l'archive a échoué.";
  });
  return reply.code(202).send({ exportId: job.id });
});

server.get("/api/documents/exports/:exportId", async (request, reply) => {
  const { exportId } = documentExportIdSchema.parse(request.params);
  const job = ownedDocumentExportJob(exportId, request.authUser?.id ?? request.authUser?.email ?? "local");
  if (!job) return reply.code(404).send({ message: "Cet export n'existe plus." });
  return documentExportStatus(job);
});

server.get("/api/documents/exports/:exportId/download", async (request, reply) => {
  const { exportId } = documentExportIdSchema.parse(request.params);
  const job = ownedDocumentExportJob(exportId, request.authUser?.id ?? request.authUser?.email ?? "local");
  if (!job) return reply.code(404).send({ message: "Cet export n'existe plus." });
  if (job.status !== "ready" || !job.archive || !job.fileName) {
    return reply.code(409).send({ message: "L'archive n'est pas encore prête." });
  }
  reply.header("Content-Type", "application/zip");
  reply.header("Content-Disposition", `attachment; filename="${job.fileName}"`);
  return reply.send(job.archive);
});

server.post("/api/helloasso/check", async (_request, reply) => {
  const organization = await helloasso.checkConnection();
  return reply.send({ connected: true, organization });
});

server.get("/api/setup", async () => getSetupState(database));

server.post("/api/helloasso/discover-campaigns", async () =>
  discoverCampaigns(database, helloasso)
);

server.put("/api/setup/campaigns", async (request) => {
  const input = campaignSelectionSchema.parse(request.body);
  return selectCampaigns(database, helloasso, [...new Set(input.formSlugs)]);
});

server.put("/api/setup/fields", async (request) => {
  const input = fieldSelectionSchema.parse(request.body);
  return selectFields(database, [...new Set(input.fieldKeys)], input.healthDocumentFieldKey ?? null);
});

server.post("/api/setup/group-preview", async (request) => {
  const input = groupingPreviewSchema.parse(request.body);
  return previewGrouping(database, helloasso, [...new Set(input.fieldKeys)]);
});

server.put("/api/setup/groups", async (request, reply) => {
  const input = groupDefinitionsSchema.parse(request.body);
  try {
    return await saveGroupDefinitions(database, input.groups);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      return reply.code(409).send({ message: "Chaque groupe doit avoir un nom unique." });
    }
    throw error;
  }
});

server.post("/api/helloasso/import-members", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async () =>
  importMembers(database, helloasso)
);

server.setErrorHandler((error, _request, reply) => {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      message: `Les données envoyées sont invalides : ${error.issues[0]?.message ?? "format incorrect"}`
    });
  }
  if (error instanceof HelloAssoError) {
    return reply.code(error.statusCode).send({ message: error.message });
  }
  if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 429) {
    return reply.code(429).send({ message: "Trop de requêtes. Réessayez dans quelques instants." });
  }
  if (
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  ) {
    return reply.code(error.statusCode).send({ message: "La requête envoyée est invalide." });
  }
  server.log.error(error);
  return reply.code(500).send({ message: "Une erreur interne est survenue." });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedFieldLabel(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .replace(/[^a-z0-9@-]+/g, " ")
    .trim();
}

function linkedCoreField(field: { label: string; type: string }): "birthDate" | "email" | "phone" | null {
  const label = normalizedFieldLabel(field.label);
  if (field.type === "Date" && /date de naissance/.test(label)) return "birthDate";
  if (/e-?mail|courriel/.test(label)) return "email";
  if (field.type === "Phone" && /telephone 1/.test(label)) return "phone";
  return null;
}

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

async function buildDocumentExport(
  input: z.infer<typeof documentExportSchema>,
  job: DocumentExportJob,
  userId: string | null
) {
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

  const records = await Promise.all(members.rows.map(async (member) => ({
    member,
    record: await getDocumentRecord(member.id, input.fieldKey)
  })));
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
  job.archive = await zipBuffer(files);
  job.fileName = `documents-${new Date().toISOString().slice(0, 10)}.zip`;
  job.status = "ready";
  job.expiresAt = Date.now() + 30 * 60_000;
  await logDocumentAccess(userId, null, input.fieldKey, "export");
}

function ownedDocumentExportJob(id: string, owner: string) {
  const job = documentExportJobs.get(id);
  return job?.owner === owner && job.expiresAt > Date.now() ? job : null;
}

function documentExportStatus(job: DocumentExportJob) {
  return {
    exportId: job.id, status: job.status, total: job.total, processed: job.processed,
    certificateCount: job.certificateCount, attestationCount: job.attestationCount,
    questionnaireCount: job.questionnaireCount, unknownCount: job.unknownCount,
    error: job.error
  };
}

function pruneDocumentExportJobs() {
  const now = Date.now();
  for (const [id, job] of documentExportJobs) if (job.expiresAt <= now) documentExportJobs.delete(id);
}

async function getDocumentRecord(memberId: string, fieldKey: string) {
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
}

async function resolveDocument(record: DocumentRecord): Promise<DocumentContent> {
  if (record.localContent) {
    return validateDocument(record.localContent, record.localMediaType ?? "", record.localName ?? "document");
  }
  if (!record.helloassoUrl) throw new Error("Aucun fichier n'est disponible.");
  const remote = await helloasso.getDocument(record.helloassoUrl);
  const checked = validateDocument(remote.content, remote.mediaType, remote.fileName ?? record.helloassoName ?? "document");
  const hash = documentHash(checked);
  await database.query(`
    UPDATE member_documents SET helloasso_name = $3, helloasso_media_type = $4,
      helloasso_size_bytes = $5, content_hash = $6, updated_at = now()
    WHERE member_id = $1 AND field_key = $2
  `, [record.memberId, record.fieldKey, checked.fileName, checked.mediaType, checked.content.length, hash]);
  return { ...checked, source: "helloasso" };
}

async function analyzeAndSave(record: DocumentRecord, document: DocumentContent, force = false) {
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
  if (!force && record.analyzedHash === hash) {
    return record.classification;
  }
  const recognition = await recognizeHealthDocument(document, hash);
  await database.query(`
    UPDATE member_documents SET classification = $3, classification_source = 'automatic',
      analyzed_hash = $4, content_hash = $4, analysis_version = $5, analyzed_at = now(), updated_at = now()
    WHERE member_id = $1 AND field_key = $2
  `, [record.memberId, record.fieldKey, recognition.classification, recognition.hash, healthAnalysisVersion]);
  return recognition.classification;
}

async function logDocumentAccess(
  userId: string | null,
  memberId: string | null,
  fieldKey: string,
  action: "view" | "download" | "upload" | "revert" | "classify" | "export"
) {
  await database.query(
    "INSERT INTO document_access_log (member_id, field_key, user_id, action) VALUES ($1, $2, $3, $4)",
    [memberId, fieldKey, userId, action]
  );
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

async function zipBuffer(files: Array<{ name: string; content: Buffer }>) {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const completed = new Promise<Buffer>((resolve, reject) => {
    output.once("end", () => resolve(Buffer.concat(chunks)));
    output.once("error", reject);
  });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.once("error", (error: Error) => output.destroy(error));
  archive.pipe(output);
  for (const file of files) archive.append(file.content, { name: file.name });
  await archive.finalize();
  return completed;
}

async function shutdown(signal: string) {
  server.log.info({ signal }, "Arrêt du serveur");
  await server.close();
  await database.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await server.listen({ host: "0.0.0.0", port: config.port });
} catch (error) {
  server.log.error(error);
  await database.end();
  process.exit(1);
}
