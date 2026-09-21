import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { createHelloAssoClient, HelloAssoError } from "./helloasso.js";
import { HelloAssoSettingsError, HelloAssoSettingsService } from "./helloasso-settings.js";
import { SecureSettingsError, SecureSettingsStore } from "./secure-settings.js";
import { configureDynamicGroups, getDynamicGroupCriteria, refreshDynamicGroups, validateDynamicCriterion } from "./dynamic-groups.js";
import { fencingCategoryError, normalizeBirthDate } from "./fencing-category.js";
import { installSecurity, prepareAuthentication } from "./security.js";
import { ExtensionRegistry, ExtensionRegistryError, publicExtensionAssetContentType } from "./extensions.js";
import { ExtensionContracts } from "./extension-contracts.js";
import { loadExtensions, packageFile } from "./extension-loader.js";
import { registerExtensionInstaller } from "./extension-installer.js";
import {
  documentHash,
  maxDocumentBytes,
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
const secureSettings = new SecureSettingsStore(database, config.settingsEncryptionKey);
const helloassoSettings = new HelloAssoSettingsService(secureSettings, config.helloasso);
const helloasso = createHelloAssoClient(async () => (await helloassoSettings.current()).config);
const server = Fastify({
  logger: true,
  trustProxy: config.trustProxy,
  bodyLimit: 15 * 1024 * 1024,
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
// Uniquement pour les modules déclarant la capacité "remote-browser-relay" (voir
// extension-loader.ts) : aucune route WebSocket n'est enregistrée par le noyau lui-même.
await server.register(websocket);
await prepareAuthentication(database, config);
await installSecurity(server, database, config);
const extensions = await ExtensionRegistry.create(database, config);
const contracts = new ExtensionContracts();
configureDynamicGroups({ contracts, isExtensionEnabled: (id) => extensions.isEnabled(id) });
await loadExtensions({ server, database, config, contracts, registry: extensions, helloasso, settings: secureSettings });
registerExtensionInstaller(server, database, config, extensions);

server.addHook("preHandler", async (request, reply) => {
  const path = request.url.split("?", 1)[0] ?? request.url;
  const extensionId = extensions.extensionForPath(path);
  if (extensionId && !extensions.isEnabled(extensionId)) {
    return reply.code(404).send({ message: "Cette fonctionnalité est désactivée dans Extensions." });
  }
});

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
const extensionIdSchema = z.object({ extensionId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80) });
const extensionStateSchema = z.object({ enabled: z.boolean() });
const helloassoSettingsSchema = z.object({
  environment: z.enum(["production", "sandbox"]),
  clientId: z.string().trim().min(3).max(300),
  clientSecret: z.string().max(500).optional(),
  organizationSlug: z.string().trim().min(2).max(200).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  confirmOrganizationChange: z.boolean().optional().default(false)
});
const settingsResetSchema = z.object({ confirm: z.literal(true) });

server.get("/api/health", async () => {
  await database.query("SELECT 1");
  return { status: "ok" };
});

server.get("/api/extensions", async () => ({
  items: await extensions.list(),
  configuration: extensions.configuration()
}));

server.put("/api/extensions/:extensionId", async (request) => {
  const { extensionId } = extensionIdSchema.parse(request.params);
  const { enabled } = extensionStateSchema.parse(request.body);
  return extensions.setEnabled(extensionId, enabled);
});

// Sert le bundle navigateur d'un module depuis la même origine, pour que la CSP du SPA
// (`script-src 'self'`) reste intacte. Le chemin demandé ne peut pas sortir du paquet.
server.get("/api/extensions/:extensionId/assets/*", async (request, reply) => {
  const { extensionId } = extensionIdSchema.parse(request.params);
  if (!extensions.isEnabled(extensionId)) {
    return reply.code(404).send({ message: "Cette fonctionnalité est désactivée dans Extensions." });
  }
  const directory = extensions.packageDirectory(extensionId);
  if (!directory) return reply.code(404).send({ message: "Ce module n'est pas installé." });

  const requested = (request.params as Record<string, string>)["*"] ?? "";
  const contentType = publicExtensionAssetContentType(requested);
  if (!contentType) {
    return reply.code(404).send({ message: "Cette ressource du module n'est pas publique." });
  }
  let file: string;
  try {
    file = packageFile(directory, requested);
  } catch {
    return reply.code(400).send({ message: "Chemin de ressource invalide." });
  }
  let content: Buffer;
  try {
    content = await readFile(file);
  } catch {
    return reply.code(404).send({ message: "Ressource introuvable." });
  }
  // Empreinte du contenu plutôt que le numéro de version du manifeste : un module dont le
  // code change sans que quelqu'un pense à incrémenter sa version ne doit jamais rester
  // servi depuis le cache d'un navigateur qui l'a visité avant le changement.
  const etag = `"${createHash("sha256").update(content).digest("hex")}"`;
  reply.header("ETag", etag);
  if (request.headers["if-none-match"] === etag) return reply.code(304).send();
  reply.header("Content-Type", contentType);
  reply.header("Content-Length", content.length);
  return reply.send(content);
});

server.get("/api/dashboard", async () => {
  const [memberResult, groupResult, helloassoStatus] = await Promise.all([
    database.query<{ count: string }>("SELECT count(*)::text AS count FROM members"),
    database.query<{ count: string }>("SELECT count(*)::text AS count FROM groups"),
    helloassoSettings.status()
  ]);

  return {
    membersCount: Number(memberResult.rows[0]?.count ?? 0),
    groupsCount: Number(groupResult.rows[0]?.count ?? 0),
    helloasso: {
      configured: helloassoStatus.configured,
      environment: helloassoStatus.environment,
      organizationSlug: helloassoStatus.organizationSlug || null
    }
  };
});

server.get("/api/members", async () => {
  const categoryContext = await contracts.loadMemberCategoryContext(database, (id) => extensions.isEnabled(id));
  const [result, fieldsResult, documentsResult] = await Promise.all([database.query<{
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
  `)]);
  const documents = new Map(documentsResult.rows.map((document) => [`${document.memberId}\0${document.fieldKey}`, document]));
  return {
    items: result.rows.map((member) => {
      const birthDate = normalizeBirthDate(member.birthDate);
      const profileOverrides = isRecord(member.localOverrides.profileData)
        ? member.localOverrides.profileData
        : {};
      return {
        ...member,
        birthDate,
        ...(categoryContext?.compute(birthDate) ?? { fencingCategory: null, categoryError: null }),
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
  const [result, schedulesByGroup] = await Promise.all([
    database.query<{
      id: string;
      name: string;
      description: string | null;
      source: "manual" | "helloasso" | "dynamic";
      membersCount: number;
      createdAt: Date;
      dynamicRule: { fieldKey: string; values: string[] } | null;
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
        (SELECT count(*)::int FROM member_groups mg WHERE mg.group_id = g.id) AS "membersCount"
      FROM groups g
      ORDER BY g.name
    `),
    contracts.loadGroupSchedules(database, (id) => extensions.isEnabled(id))
  ]);
  return {
    items: result.rows.map((group) => ({
      ...group,
      trainingSchedules: schedulesByGroup.get(group.id) ?? []
    }))
  };
});

server.get("/api/group-criteria", async () => ({ items: await getDynamicGroupCriteria(database) }));

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
    ? await contracts.analyzeHealthDocument(document, hash, (id) => extensions.isEnabled(id))
    : null;
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
    document.content.length, recognition?.classification ?? "unknown", recognition?.hash ?? hash, hash,
    recognition?.analysisVersion ?? 0]);
  await logDocumentAccess(request.authUser?.id ?? null, input.memberId, input.fieldKey, "upload");
  return { uploaded: true, classification: recognition?.classification ?? "unknown" };
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

server.get("/api/settings/helloasso", async () => helloassoSettings.status());

server.put("/api/settings/helloasso", {
  config: { rateLimit: { max: 10, timeWindow: "1 hour" } }
}, async (request, reply) => {
  const input = helloassoSettingsSchema.parse(request.body);
  const before = await helloassoSettings.current();
  const nextBaseUrl = input.environment === "sandbox"
    ? "https://api.helloasso-sandbox.com"
    : "https://api.helloasso.com";
  const organizationChanged = before.config.configured && (
    before.config.organizationSlug !== input.organizationSlug || before.config.baseUrl !== nextBaseUrl
  );
  if (organizationChanged && !input.confirmOrganizationChange) {
    return reply.code(409).send({
      message: "Changer d'association ou d'environnement désactivera la sélection actuelle des campagnes. Confirmez ce changement."
    });
  }
  const result = await helloassoSettings.save(input, request.authUser?.id ?? null);
  if (result.organizationChanged) await resetHelloAssoSetup();
  return result.status;
});

server.delete("/api/settings/helloasso", async (request) => {
  settingsResetSchema.parse(request.body);
  const before = await helloassoSettings.current();
  const status = await helloassoSettings.reset();
  const after = await helloassoSettings.current();
  if (before.config.organizationSlug !== after.config.organizationSlug || before.config.baseUrl !== after.config.baseUrl) {
    await resetHelloAssoSetup();
  }
  return status;
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
  if (error instanceof HelloAssoSettingsError || error instanceof SecureSettingsError) {
    return reply.code(error.statusCode).send({ message: error.message });
  }
  if (error instanceof ExtensionRegistryError) {
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

async function resetHelloAssoSetup() {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE helloasso_campaigns SET selected = false, updated_at = now() WHERE selected = true");
    await client.query("DELETE FROM app_settings WHERE key IN ('helloasso_setup', 'helloasso_groups')");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
  analysisVersion: number;
};

async function getDocumentRecord(memberId: string, fieldKey: string) {
  const result = await database.query<DocumentRecord>(`
    SELECT d.member_id AS "memberId", d.field_key AS "fieldKey",
           f.document_role = 'health' AS health,
           d.helloasso_url AS "helloassoUrl", d.helloasso_name AS "helloassoName",
           d.local_content AS "localContent", d.local_name AS "localName",
           d.local_media_type AS "localMediaType", d.classification,
           d.classification_source AS "classificationSource", d.analyzed_hash AS "analyzedHash",
           d.content_hash AS "contentHash",
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

async function analyzeAndSave(record: DocumentRecord, document: DocumentContent) {
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
  const analysisVersion = contracts.healthDocumentAnalysisVersion((id) => extensions.isEnabled(id));
  if (!analysisVersion || record.analyzedHash === hash && record.analysisVersion === analysisVersion) {
    return record.classification;
  }
  const recognition = await contracts.analyzeHealthDocument(document, hash, (id) => extensions.isEnabled(id));
  if (!recognition) return record.classification;
  await database.query(`
    UPDATE member_documents SET classification = $3, classification_source = 'automatic',
      analyzed_hash = $4, content_hash = $4, analysis_version = $5, analyzed_at = now(), updated_at = now()
    WHERE member_id = $1 AND field_key = $2
  `, [record.memberId, record.fieldKey, recognition.classification, recognition.hash, recognition.analysisVersion]);
  return recognition.classification;
}

async function logDocumentAccess(
  userId: string | null,
  memberId: string | null,
  fieldKey: string,
  action: "view" | "download" | "upload" | "revert"
) {
  await database.query(
    "INSERT INTO document_access_log (member_id, field_key, user_id, action) VALUES ($1, $2, $3, $4)",
    [memberId, fieldKey, userId, action]
  );
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
