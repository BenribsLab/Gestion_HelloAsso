import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
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
const server = Fastify({
  logger: true,
  trustProxy: config.trustProxy,
  bodyLimit: 1_048_576,
  requestTimeout: 30_000,
  connectionTimeout: 10_000
});

await server.register(cookie);
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
  fieldKeys: z.array(z.string().min(1)).max(100)
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
  const [result, fieldsResult, categoryDefinitions, categorySeason] = await Promise.all([database.query<{
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
  `), database.query<{ key: string; label: string; type: string }>(`
    SELECT field_key AS key, label, field_type AS type
    FROM helloasso_fields WHERE selected = true ORDER BY label
  `), getCategoryDefinitions(database), getCategorySeason(database)]);
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
          const linkedField = linkedCoreField(field);
          const linkedOverride = linkedField && Object.hasOwn(member.localOverrides, linkedField);
          return {
            ...field,
            value: Object.hasOwn(profileOverrides, field.key)
              ? profileOverrides[field.key]
              : linkedOverride
                ? member.localOverrides[linkedField]
                : member.profileData[field.key] ?? null,
            overridden: Object.hasOwn(profileOverrides, field.key) || Boolean(linkedOverride)
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
         FROM helloasso_fields WHERE selected = true AND field_key = ANY($1::text[])`,
        [fieldKeys]
      );
      if (fieldsResult.rowCount !== fieldKeys.length) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ message: "Un des champs facultatifs n'est pas disponible." });
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
        return reply.code(404).send({ message: "Ce champ facultatif n'existe pas." });
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
  return selectFields(database, [...new Set(input.fieldKeys)]);
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
