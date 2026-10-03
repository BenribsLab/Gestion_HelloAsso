import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import type {
  HelloAssoCampaign,
  HelloAssoCustomField,
  HelloAssoMembershipItem
} from "./helloasso.js";
import { normalizeBirthDate } from "./fencing-category.js";
import { refreshDynamicGroups } from "./dynamic-groups.js";
import { groupValues, normalizeGroupValue } from "./group-values.js";
import type { MemberFieldRequirement } from "./extension-contracts.js";
import { resolveModuleFields } from "./member-fields.js";
import type { Season } from "./seasons.js";

export { normalizeGroupValue } from "./group-values.js";

type HelloAssoClient = {
  listMembershipCampaigns(): Promise<HelloAssoCampaign[]>;
  listMembershipItems(formSlug: string): Promise<HelloAssoMembershipItem[]>;
};

export const coreFields = [
  { key: "firstName", label: "Prénom" },
  { key: "lastName", label: "Nom" },
  { key: "campaign", label: "Campagne d’adhésion" },
  { key: "tier", label: "Tarif choisi" },
  { key: "helloassoState", label: "Statut HelloAsso" }
];

export function fieldKey(label: string, type: string) {
  return `custom_${createHash("sha256")
    .update(`${type}\0${label.normalize("NFC")}`)
    .digest("hex")
    .slice(0, 16)}`;
}

export function inferMemberFieldInput(type: string, answers: unknown[]) {
  const values = [...new Map(
    answers
      .flatMap(answerChoiceValues)
      .map((value) => [normalizeChoiceValue(value), value.trim()] as const)
      .filter(([normalized]) => normalized.length > 0)
  ).values()].sort((left, right) => left.localeCompare(right, "fr"));
  const declaredChoice = /choice|yesno|oui\s*\/\s*non|boolean/i.test(type);
  const scalarAnswerCount = answers.flatMap(answerChoiceValues).filter((value) => value.trim()).length;
  const recurrentSmallSet = values.length >= 2
    && values.length <= 8
    && scalarAnswerCount >= Math.max(5, values.length * 2);
  return {
    inputMode: declaredChoice || recurrentSmallSet ? "select" as const : "text" as const,
    options: values
  };
}

function answerChoiceValues(answer: unknown): string[] {
  if (typeof answer === "string" || typeof answer === "number" || typeof answer === "boolean") {
    return [String(answer)];
  }
  if (Array.isArray(answer)) return answer.flatMap(answerChoiceValues);
  return [];
}

function normalizeChoiceValue(value: string) {
  return value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("fr");
}

export function isCampaignCurrent(campaign: {
  state: string;
  startDate: string | Date | null;
  endDate: string | Date | null;
}, now = new Date()) {
  if (!new Set(["Public", "Private"]).has(campaign.state)) return false;
  const start = campaign.startDate
    ? campaign.startDate instanceof Date ? campaign.startDate : new Date(campaign.startDate)
    : null;
  const end = campaign.endDate
    ? campaign.endDate instanceof Date ? campaign.endDate : new Date(campaign.endDate)
    : null;
  return (!start || start <= now) && (!end || end >= now);
}

export async function getSetupState(database: Database, seasonId: string) {
  const [
    campaignsResult,
    fieldsResult,
    settingsResult,
    groupSettingsResult,
    groupDefinitionsResult,
    syncResult
  ] = await Promise.all([
    database.query<{
      formSlug: string;
      title: string;
      state: string;
      startDate: Date | null;
      endDate: Date | null;
      selected: boolean;
      seasonId: string | null;
      seasonLabel: string | null;
      fieldsCount: number;
    }>(`
      SELECT c.form_slug AS "formSlug", c.title, c.state,
             c.start_date AS "startDate", c.end_date AS "endDate",
             c.season_id IS NOT DISTINCT FROM $1::uuid AS selected,
             c.season_id AS "seasonId", s.label AS "seasonLabel",
             count(cf.source_field_id)::int AS "fieldsCount"
      FROM helloasso_campaigns c
      LEFT JOIN seasons s ON s.id = c.season_id
      LEFT JOIN helloasso_campaign_fields cf ON cf.form_slug = c.form_slug
      GROUP BY c.form_slug, s.label
      ORDER BY c.start_date DESC NULLS LAST, c.title
    `, [seasonId]),
    database.query<{
      key: string;
      label: string;
      type: string;
      selected: boolean;
      documentRole: "health" | null;
      campaignCount: number;
    }>(`
      SELECT f.field_key AS key, f.label, f.field_type AS type, f.selected,
             f.document_role AS "documentRole",
             count(cf.form_slug)::int AS "campaignCount"
      FROM helloasso_fields f
      JOIN helloasso_campaign_fields cf ON cf.field_key = f.field_key
      JOIN helloasso_campaigns c ON c.form_slug = cf.form_slug AND c.selected = true
      GROUP BY f.field_key
      ORDER BY f.label
    `),
    database.query<{ value: { completedAt?: string } }>(
      "SELECT value FROM app_settings WHERE key = 'helloasso_setup'"
    ),
    database.query<{ value: { configuredAt?: string } }>(
      "SELECT value FROM app_settings WHERE key = 'helloasso_groups'"
    ),
    database.query<{
      id: string;
      name: string;
      rules: Array<{ fieldKey: string; value: string }>;
    }>(`
      SELECT d.id, d.name,
             COALESCE(
               jsonb_agg(
                 jsonb_build_object('fieldKey', r.field_key, 'value', r.match_value)
                 ORDER BY r.field_key, r.match_value
               ) FILTER (WHERE r.field_key IS NOT NULL),
               '[]'::jsonb
             ) AS rules
      FROM helloasso_group_definitions d
      LEFT JOIN helloasso_group_rules r ON r.group_definition_id = d.id
      GROUP BY d.id
      ORDER BY d.name
    `),
    database.query<{
      status: string;
      importedCount: number;
      finishedAt: Date | null;
      errorMessage: string | null;
    }>(`
      SELECT status, imported_count AS "importedCount", finished_at AS "finishedAt",
             error_message AS "errorMessage"
      FROM helloasso_sync_runs ORDER BY started_at DESC LIMIT 1
    `)
  ]);

  return {
    campaigns: campaignsResult.rows.map((campaign) => ({
      ...campaign,
      current: isCampaignCurrent(campaign)
    })),
    fields: fieldsResult.rows,
    coreFields,
    completedAt: settingsResult.rows[0]?.value.completedAt ?? null,
    groupsConfiguredAt: groupSettingsResult.rows[0]?.value.configuredAt ?? null,
    groupDefinitions: groupDefinitionsResult.rows,
    lastSync: syncResult.rows[0] ?? null
  };
}

export async function discoverCampaigns(database: Database, helloasso: HelloAssoClient, seasonId: string) {
  const campaigns = await helloasso.listMembershipCampaigns();
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    for (const campaign of campaigns) {
      await client.query(
        `INSERT INTO helloasso_campaigns
           (form_slug, title, form_type, state, start_date, end_date)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (form_slug) DO UPDATE SET
           title = EXCLUDED.title,
           form_type = EXCLUDED.form_type,
           state = EXCLUDED.state,
           start_date = EXCLUDED.start_date,
           end_date = EXCLUDED.end_date,
           discovered_at = now(),
           updated_at = now()`,
        [
          campaign.formSlug,
          campaign.title,
          campaign.formType,
          campaign.state,
          campaign.startDate,
          campaign.endDate
        ]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return getSetupState(database, seasonId);
}

/**
 * Rattache des campagnes à une saison. Les champs choisis restent communs à toutes les
 * saisons : une campagne dont un champ a changé de nom ou de type est signalée par
 * `seasonFieldCheck`, et la correspondance refaite à la main est conservée ici.
 */
export async function selectCampaigns(
  database: Database,
  helloasso: HelloAssoClient,
  seasonId: string,
  formSlugs: string[]
) {
  const known = await database.query<{ formSlug: string; title: string; seasonId: string | null; seasonLabel: string | null }>(
    `SELECT c.form_slug AS "formSlug", c.title, c.season_id AS "seasonId", s.label AS "seasonLabel"
     FROM helloasso_campaigns c LEFT JOIN seasons s ON s.id = c.season_id
     WHERE c.form_slug = ANY($1::text[])`,
    [formSlugs]
  );
  if (known.rows.length !== new Set(formSlugs).size) {
    throw new Error("Une campagne sélectionnée n'est pas connue.");
  }
  const elsewhere = known.rows.find((campaign) => campaign.seasonId && campaign.seasonId !== seasonId);
  if (elsewhere) {
    throw new Error(`La campagne « ${elsewhere.title} » est déjà rattachée à la saison ${elsewhere.seasonLabel}.`);
  }

  const inspected = await Promise.all(
    formSlugs.map(async (formSlug) => ({
      formSlug,
      items: await helloasso.listMembershipItems(formSlug)
    }))
  );
  const answersByIdentity = new Map<string, unknown[]>();
  for (const answer of inspected.flatMap((campaign) => campaign.items).flatMap((item) => item.customFields)) {
    const identity = `${answer.type}\0${answer.name}`;
    const answers = answersByIdentity.get(identity) ?? [];
    answers.push(answer.answer);
    answersByIdentity.set(identity, answers);
  }

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE helloasso_campaigns SET selected = false, season_id = NULL, updated_at = now()
       WHERE season_id = $1 AND NOT (form_slug = ANY($2::text[]))`,
      [seasonId, formSlugs]
    );
    await client.query(
      "UPDATE helloasso_campaigns SET selected = true, season_id = $2, updated_at = now() WHERE form_slug = ANY($1::text[])",
      [formSlugs, seasonId]
    );

    for (const campaign of inspected) {
      // Correspondances refaites à la main (champ renommé dans HelloAsso) : conservées.
      const manualMappings = await client.query<{ sourceFieldId: string; fieldKey: string }>(
        `SELECT source_field_id AS "sourceFieldId", field_key AS "fieldKey"
         FROM helloasso_campaign_fields WHERE form_slug = $1 AND manual = true`,
        [campaign.formSlug]
      );
      const manualKeyBySource = new Map(manualMappings.rows.map((row) => [row.sourceFieldId, row.fieldKey]));
      await client.query("DELETE FROM helloasso_campaign_fields WHERE form_slug = $1", [campaign.formSlug]);
      const fields = uniqueFields(campaign.items.flatMap((item) => item.customFields));
      for (const field of fields) {
        const manualKey = manualKeyBySource.get(field.id);
        if (manualKey) {
          await client.query(
            `INSERT INTO helloasso_campaign_fields (form_slug, source_field_id, field_key, manual)
             VALUES ($1, $2, $3, true)`,
            [campaign.formSlug, field.id, manualKey]
          );
          continue;
        }
        const localMatch = await client.query<{ key: string }>(
          `SELECT field_key AS key FROM helloasso_fields
           WHERE source = 'local' AND lower(label) = lower($1) AND field_type = $2
           ORDER BY discovered_at LIMIT 1`,
          [field.name, field.type]
        );
        const key = localMatch.rows[0]?.key ?? fieldKey(field.name, field.type);
        const inferred = inferMemberFieldInput(
          field.type,
          answersByIdentity.get(`${field.type}\0${field.name}`) ?? []
        );
        const current = await client.query<{ inputMode: "auto" | "text" | "select"; options: unknown }>(
          `SELECT input_mode AS "inputMode", choice_options AS options
           FROM helloasso_fields WHERE field_key = $1`,
          [key]
        );
        const currentOptions = Array.isArray(current.rows[0]?.options)
          ? current.rows[0]!.options.filter((value): value is string => typeof value === "string")
          : [];
        const options = [...new Map(
          [...currentOptions, ...inferred.options].map((value) => [normalizeChoiceValue(value), value])
        ).values()].sort((left, right) => left.localeCompare(right, "fr"));
        const inputMode = current.rows[0]?.inputMode === "auto" || !current.rows[0]
          ? inferred.inputMode
          : current.rows[0].inputMode;
        await client.query(
          `INSERT INTO helloasso_fields (field_key, label, field_type, input_mode, choice_options)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (field_key) DO UPDATE SET
             label = EXCLUDED.label, field_type = EXCLUDED.field_type,
             input_mode = EXCLUDED.input_mode, choice_options = EXCLUDED.choice_options,
             updated_at = now()`,
          [key, field.name, field.type, inputMode, JSON.stringify(options)]
        );
        await client.query(
          `INSERT INTO helloasso_campaign_fields (form_slug, source_field_id, field_key)
           VALUES ($1, $2, $3)`,
          [campaign.formSlug, field.id, key]
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return getSetupState(database, seasonId);
}

/**
 * Contrôle des champs d'une saison : chaque champ choisi doit se retrouver dans au moins une
 * campagne de la saison. Un champ absent (renommé, type changé dans HelloAsso) est signalé
 * avec les champs des campagnes qui ne correspondent à aucun champ choisi.
 */
export async function seasonFieldCheck(database: Pick<Database, "query">, seasonId: string) {
  const [campaigns, selected, campaignFields] = await Promise.all([
    database.query<{ formSlug: string; title: string }>(
      `SELECT form_slug AS "formSlug", title FROM helloasso_campaigns WHERE season_id = $1 ORDER BY title`,
      [seasonId]
    ),
    database.query<{ key: string; label: string; type: string }>(
      `SELECT field_key AS key, label, field_type AS type FROM helloasso_fields
       WHERE selected = true AND source = 'helloasso' ORDER BY label`
    ),
    database.query<{ formSlug: string; sourceFieldId: string; fieldKey: string; label: string; type: string; manual: boolean }>(
      `SELECT cf.form_slug AS "formSlug", cf.source_field_id AS "sourceFieldId", cf.field_key AS "fieldKey",
              f.label, f.field_type AS type, cf.manual
       FROM helloasso_campaign_fields cf
       JOIN helloasso_campaigns c ON c.form_slug = cf.form_slug AND c.season_id = $1
       JOIN helloasso_fields f ON f.field_key = cf.field_key
       ORDER BY f.label`,
      [seasonId]
    )
  ]);
  const selectedKeys = new Set(selected.rows.map((field) => field.key));
  const presentKeys = new Set(campaignFields.rows.map((field) => field.fieldKey));
  const unmapped = campaignFields.rows.filter((field) => !selectedKeys.has(field.fieldKey));
  return {
    campaigns: campaigns.rows,
    mapped: campaignFields.rows.filter((field) => field.manual),
    missing: campaigns.rows.length === 0 ? [] : selected.rows
      .filter((field) => !presentKeys.has(field.key))
      .map((field) => ({
        ...field,
        // Même nom, autre type : très probablement le même champ dont HelloAsso a changé le type.
        sameLabelCandidate: unmapped.find((candidate) => candidate.label.toLocaleLowerCase("fr") === field.label.toLocaleLowerCase("fr")) ?? null
      })),
    candidates: unmapped
  };
}

/** Associe le champ d'une campagne de la saison à un champ choisi (correspondance manuelle). */
export async function mapSeasonField(
  database: Pick<Database, "query">,
  seasonId: string,
  input: { formSlug: string; sourceFieldId: string; fieldKey: string }
) {
  const field = await database.query(
    "SELECT 1 FROM helloasso_fields WHERE field_key = $1 AND selected = true",
    [input.fieldKey]
  );
  if (!field.rows[0]) throw new Error("Ce champ n'est pas un champ choisi.");
  const result = await database.query(
    `UPDATE helloasso_campaign_fields cf SET field_key = $4, manual = true
     FROM helloasso_campaigns c
     WHERE c.form_slug = cf.form_slug AND c.season_id = $1
       AND cf.form_slug = $2 AND cf.source_field_id = $3`,
    [seasonId, input.formSlug, input.sourceFieldId, input.fieldKey]
  );
  if (!result.rowCount) throw new Error("Ce champ de campagne n'appartient pas à la saison.");
  return seasonFieldCheck(database, seasonId);
}

export async function selectFields(database: Database, seasonId: string, keys: string[], healthDocumentFieldKey: string | null) {
  const known = await database.query<{ key: string }>(
    `SELECT DISTINCT f.field_key AS key
     FROM helloasso_fields f
     JOIN helloasso_campaign_fields cf ON cf.field_key = f.field_key
     JOIN helloasso_campaigns c ON c.form_slug = cf.form_slug AND c.selected = true
     WHERE f.field_key = ANY($1::text[])`,
    [keys]
  );
  if (known.rows.length !== new Set(keys).size) {
    throw new Error("Un champ sélectionné n'est pas connu.");
  }
  let resolvedHealthDocumentFieldKey = healthDocumentFieldKey;
  if (!resolvedHealthDocumentFieldKey && keys.length > 0) {
    const candidates = await database.query<{ key: string; label: string }>(
      `SELECT field_key AS key, label FROM helloasso_fields
       WHERE field_key = ANY($1::text[]) AND field_type = 'File'
       ORDER BY label`,
      [keys]
    );
    const healthCandidates = candidates.rows.filter((field) => isHealthDocumentLabel(field.label));
    if (healthCandidates.length === 1) resolvedHealthDocumentFieldKey = healthCandidates[0]!.key;
  }
  if (resolvedHealthDocumentFieldKey) {
    const healthField = await database.query(
      `SELECT 1 FROM helloasso_fields
       WHERE field_key = $1 AND field_type = 'File' AND field_key = ANY($2::text[])`,
      [resolvedHealthDocumentFieldKey, keys]
    );
    if (!healthField.rows[0]) {
      throw new Error("Le champ santé doit être un document sélectionné.");
    }
  }

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE helloasso_fields
       SET selected = false, document_role = NULL, updated_at = now()
       WHERE source = 'helloasso'`
    );
    if (keys.length > 0) {
      await client.query(
        "UPDATE helloasso_fields SET selected = true, updated_at = now() WHERE field_key = ANY($1::text[])",
        [keys]
      );
    }
    if (resolvedHealthDocumentFieldKey) {
      await client.query(
        "UPDATE helloasso_fields SET document_role = 'health', updated_at = now() WHERE field_key = $1",
        [resolvedHealthDocumentFieldKey]
      );
    }
    await client.query(
      `INSERT INTO app_settings (key, value)
       VALUES ('helloasso_setup', jsonb_build_object('completedAt', now()))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return getSetupState(database, seasonId);
}

export async function previewGrouping(
  database: Database,
  helloasso: HelloAssoClient,
  fieldKeys: string[]
) {
  const availableFields = await getAvailableGroupingFields(database);
  const availableByKey = new Map(availableFields.map((field) => [field.key, field]));
  for (const key of fieldKeys) {
    if (!availableByKey.has(key)) throw new Error("Un champ de regroupement n'est pas connu.");
  }

  const campaigns = await database.query<{ formSlug: string }>(
    `SELECT form_slug AS "formSlug" FROM helloasso_campaigns WHERE selected = true`
  );
  const inspected = await Promise.all(
    campaigns.rows.map(async (campaign) =>
      helloasso.listMembershipItems(campaign.formSlug)
    )
  );
  const customKeyByIdentity = new Map(
    availableFields
      .filter((field) => field.key !== "tier")
      .map((field) => [`${field.type}\0${field.label}`, field.key])
  );
  const requested = new Set(fieldKeys);
  const counts = new Map<string, Map<string, Set<number>>>();
  const validStates = new Set(["Processed", "Registered"]);

  for (const item of inspected.flat()) {
    if (!validStates.has(item.state ?? "")) continue;
    if (requested.has("tier")) {
      addPreviewValues(counts, "tier", groupValues(item.name ?? item.priceCategory, true), item.id);
    }
    for (const answer of item.customFields) {
      const key = customKeyByIdentity.get(`${answer.type}\0${answer.name}`);
      if (!key || !requested.has(key)) continue;
      addPreviewValues(counts, key, groupValues(answer.answer, false), item.id);
    }
  }

  return {
    sources: fieldKeys.map((key) => {
      const field = availableByKey.get(key)!;
      return {
        ...field,
        values: [...(counts.get(key) ?? new Map())]
          .map(([value, memberIds]) => ({ value, count: memberIds.size }))
          .sort((left, right) => left.value.localeCompare(right.value, "fr"))
      };
    })
  };
}

export async function saveGroupDefinitions(
  database: Database,
  seasonId: string,
  groups: Array<{
    id?: string | undefined;
    name: string;
    rules: Array<{ fieldKey: string; value: string }>;
  }>
) {
  const availableFields = await getAvailableGroupingFields(database);
  const availableKeys = new Set(availableFields.map((field) => field.key));
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const keptIds: string[] = [];
    for (const group of groups) {
      const normalizedRules = [...new Map(
        group.rules.map((rule) => {
          if (!availableKeys.has(rule.fieldKey)) {
            throw new Error("Une règle utilise un champ inconnu.");
          }
          const value = normalizeGroupValue(rule.value, rule.fieldKey === "tier");
          return [`${rule.fieldKey}\0${value}`, { fieldKey: rule.fieldKey, value }];
        })
      ).values()].filter((rule) => rule.value.length > 0);
      if (normalizedRules.length === 0) {
        throw new Error(`Le groupe « ${group.name} » ne possède aucune valeur.`);
      }

      const result = group.id
        ? await client.query<{ id: string }>(
            `UPDATE helloasso_group_definitions
             SET name = $2, updated_at = now()
             WHERE id = $1 RETURNING id`,
            [group.id, group.name.trim()]
          )
        : await client.query<{ id: string }>(
            `INSERT INTO helloasso_group_definitions (name)
             VALUES ($1) RETURNING id`,
            [group.name.trim()]
          );
      if (!result.rows[0]) throw new Error("Un groupe configuré n'existe plus.");
      const definitionId = result.rows[0].id;
      keptIds.push(definitionId);
      await client.query(
        "DELETE FROM helloasso_group_rules WHERE group_definition_id = $1",
        [definitionId]
      );
      for (const rule of normalizedRules) {
        await client.query(
          `INSERT INTO helloasso_group_rules (group_definition_id, field_key, match_value)
           VALUES ($1, $2, $3)`,
          [definitionId, rule.fieldKey, rule.value]
        );
      }
    }

    if (keptIds.length > 0) {
      await client.query(
        "DELETE FROM helloasso_group_definitions WHERE NOT (id = ANY($1::uuid[]))",
        [keptIds]
      );
    } else {
      await client.query("DELETE FROM helloasso_group_definitions");
    }
    await client.query(
      `INSERT INTO app_settings (key, value)
       VALUES ('helloasso_groups', jsonb_build_object('configuredAt', now()))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return getSetupState(database, seasonId);
}

/** Importe les adhérents des campagnes HelloAsso de la saison. */
export async function importMembers(
  database: Database,
  helloasso: HelloAssoClient,
  season: Season,
  requirements: MemberFieldRequirement[] = []
) {
  const campaignsResult = await database.query<{ formSlug: string; title: string }>(
    `SELECT form_slug AS "formSlug", title FROM helloasso_campaigns WHERE season_id = $1`,
    [season.id]
  );
  if (campaignsResult.rows.length === 0) {
    throw new Error(`Aucune campagne HelloAsso n'est rattachée à la saison ${season.label}.`);
  }
  const fieldsResult = await database.query<{
    key: string;
    label: string;
    type: string;
    documentRole: "health" | null;
  }>(`
    SELECT field_key AS key, label, field_type AS type, document_role AS "documentRole"
    FROM helloasso_fields WHERE selected = true
  `);
  const selectedFields = new Map(
    fieldsResult.rows.map((field) => [`${field.type}\0${field.label}`, field])
  );
  const moduleFields = await resolveModuleFields(database, requirements);
  const retainedFields = new Map(selectedFields);
  for (const field of moduleFields.filter((candidate) => candidate.storage === "profileData")) {
    retainedFields.set(`${field.type}\0${field.label}`, {
      key: field.key,
      label: field.label,
      type: field.type,
      documentRole: null
    });
  }
  const payerRequirements = requirements.filter((requirement) => requirement.source.kind === "payer");
  const allFieldsResult = await database.query<{ key: string; label: string; type: string }>(`
    SELECT DISTINCT f.field_key AS key, f.label, f.field_type AS type
    FROM helloasso_fields f
    JOIN helloasso_campaign_fields cf ON cf.field_key = f.field_key
    JOIN helloasso_campaigns c ON c.form_slug = cf.form_slug AND c.selected = true
  `);
  const customFieldKeyByIdentity = new Map(
    allFieldsResult.rows.map((field) => [`${field.type}\0${field.label}`, field.key])
  );
  // Correspondance propre à chaque campagne (identifiant du champ HelloAsso -> champ choisi) :
  // un champ renommé d'une saison à l'autre reste rattaché au même champ de l'application.
  const campaignFieldsResult = await database.query<{ formSlug: string; sourceFieldId: string; fieldKey: string }>(
    `SELECT form_slug AS "formSlug", source_field_id AS "sourceFieldId", field_key AS "fieldKey"
     FROM helloasso_campaign_fields WHERE form_slug = ANY($1::text[])`,
    [campaignsResult.rows.map((campaign) => campaign.formSlug)]
  );
  const campaignFieldKey = new Map(
    campaignFieldsResult.rows.map((row) => [`${row.formSlug}\0${row.sourceFieldId}`, row.fieldKey])
  );
  const groupRulesResult = await database.query<{
    id: string;
    name: string;
    fieldKey: string;
    value: string;
  }>(`
    SELECT d.id, d.name, r.field_key AS "fieldKey", r.match_value AS value
    FROM helloasso_group_definitions d
    JOIN helloasso_group_rules r ON r.group_definition_id = d.id
    ORDER BY d.name
  `);
  const groupDefinitions = new Map<
    string,
    { id: string; name: string; rules: Array<{ fieldKey: string; value: string }> }
  >();
  for (const rule of groupRulesResult.rows) {
    const definition = groupDefinitions.get(rule.id) ?? {
      id: rule.id,
      name: rule.name,
      rules: []
    };
    definition.rules.push({ fieldKey: rule.fieldKey, value: rule.value });
    groupDefinitions.set(rule.id, definition);
  }

  const retainedByKey = new Map([...retainedFields.values()].map((field) => [field.key, field]));
  const syncResult = await database.query<{ id: string }>(
    "INSERT INTO helloasso_sync_runs (status) VALUES ('running') RETURNING id"
  );
  const syncId = syncResult.rows[0]!.id;

  try {
    const campaignItems = await Promise.all(
      campaignsResult.rows.map(async (campaign) => ({
        ...campaign,
        items: await helloasso.listMembershipItems(campaign.formSlug)
      }))
    );
    const validStates = new Set(["Processed", "Registered"]);
    const client = await database.connect();
    let importedCount = 0;
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE members SET status = 'inactive', updated_at = now()
         WHERE source = 'helloasso' AND source_data->>'formSlug' = ANY($1::text[])`,
        [campaignsResult.rows.map((campaign) => campaign.formSlug)]
      );
      await client.query(
        `DELETE FROM member_groups mg
         USING members m
         WHERE mg.member_id = m.id
           AND mg.source = 'helloasso'
           AND m.source = 'helloasso'
           AND m.source_data->>'formSlug' = ANY($1::text[])`,
        [campaignsResult.rows.map((campaign) => campaign.formSlug)]
      );

      for (const campaign of campaignItems) {
        for (const item of campaign.items) {
          if (!validStates.has(item.state ?? "") || !item.user?.firstName || !item.user.lastName) {
            continue;
          }
          const profileData: Record<string, unknown> = {};
          const moduleData: Record<string, unknown> = {};
          for (const requirement of payerRequirements) {
            if (requirement.source.kind !== "payer") continue;
            const value = item.payer?.[requirement.source.property];
            if (value !== undefined && value !== null && value !== "") moduleData[requirement.key] = value;
          }
          const groupingValues = new Map<string, Set<string>>();
          groupingValues.set(
            "tier",
            new Set(groupValues(item.name ?? item.priceCategory, true))
          );
          let email: string | null = null;
          let phone: string | null = null;
          let birthDate: string | null = null;
          const documentAnswers: Array<{ fieldKey: string; url: string }> = [];
          for (const answer of item.customFields) {
            const mappedKey = campaignFieldKey.get(`${campaign.formSlug}\0${answer.id}`);
            const groupingFieldKey = mappedKey ?? customFieldKeyByIdentity.get(
              `${answer.type}\0${answer.name}`
            );
            if (groupingFieldKey) {
              groupingValues.set(
                groupingFieldKey,
                new Set(groupValues(answer.answer, false))
              );
            }
            const normalizedLabel = normalizeLabel(answer.name);
            if (answer.type === "Date" && /date de naissance/.test(normalizedLabel)) {
              birthDate = dateAnswerToString(answer.answer);
            }
            const retained = (mappedKey ? retainedByKey.get(mappedKey) : undefined)
              ?? retainedFields.get(`${answer.type}\0${answer.name}`);
            if (!retained) continue;
            if (retained.type === "File") {
              const url = documentAnswerUrl(answer.answer);
              if (url) documentAnswers.push({ fieldKey: retained.key, url });
              continue;
            }
            profileData[retained.key] = answer.answer;
            if (/e-?mail|courriel/.test(normalizedLabel)) email = answerToString(answer.answer);
            if (answer.type === "Phone" && /telephone 1/.test(normalizedLabel)) {
              phone = answerToString(answer.answer);
            }
          }
          const firstName = item.user.firstName.trim();
          const lastName = item.user.lastName.trim();
          const personId = await findPersonId(client, season.id, firstName, lastName, birthDate);
          const memberResult = await client.query<{ id: string; locallyDeletedAt: Date | null }>(
            `INSERT INTO members
               (helloasso_item_id, first_name, last_name, email, phone, birth_date, status, source, source_data, profile_data, module_data,
                season_id, person_id)
             VALUES ($1, $2, $3, $4, $5, $6, 'active', 'helloasso', $7, $8, $9, $10, COALESCE($11::uuid, gen_random_uuid()))
             ON CONFLICT (helloasso_item_id) DO UPDATE SET
               first_name = EXCLUDED.first_name,
               last_name = EXCLUDED.last_name,
               email = EXCLUDED.email,
               phone = EXCLUDED.phone,
               birth_date = EXCLUDED.birth_date,
               status = CASE WHEN members.locally_deleted_at IS NULL THEN 'active' ELSE 'inactive' END,
               source_data = EXCLUDED.source_data,
               profile_data = EXCLUDED.profile_data,
               module_data = members.module_data || EXCLUDED.module_data,
               updated_at = now()
             RETURNING id, locally_deleted_at AS "locallyDeletedAt"`,
            [
              item.id,
              firstName,
              lastName,
              email,
              phone,
              birthDate,
              {
                formSlug: campaign.formSlug,
                campaignTitle: campaign.title,
                tierName: item.name ?? item.priceCategory ?? null,
                tierId: item.tierId ?? null,
                helloassoState: item.state,
                amount: item.amount ?? null,
                options: item.options ?? [],
                payments: item.payments ?? [],
                totalAmount: membershipTotalAmount(item),
                orderId: item.order?.id ?? null,
                orderDate: item.order?.date ?? null,
                payerFirstName: item.payer?.firstName ?? null,
                payerLastName: item.payer?.lastName ?? null,
                payerEmail: item.payer?.email ?? null,
                payerPhone: item.payer?.phone ?? null
              },
              profileData,
              moduleData,
              season.id,
              personId
            ]
          );
          if (memberResult.rows[0]!.locallyDeletedAt) continue;
          for (const fileField of fieldsResult.rows.filter((field) => field.type === "File")) {
            const document = documentAnswers.find((answer) => answer.fieldKey === fileField.key);
            await client.query(
              `INSERT INTO member_documents (member_id, field_key, helloasso_url)
               VALUES ($1, $2, $3)
               ON CONFLICT (member_id, field_key) DO UPDATE SET
                 helloasso_url = EXCLUDED.helloasso_url,
                 helloasso_name = CASE
                   WHEN member_documents.helloasso_url IS NOT DISTINCT FROM EXCLUDED.helloasso_url
                   THEN member_documents.helloasso_name ELSE NULL END,
                 helloasso_media_type = CASE
                   WHEN member_documents.helloasso_url IS NOT DISTINCT FROM EXCLUDED.helloasso_url
                   THEN member_documents.helloasso_media_type ELSE NULL END,
                 helloasso_size_bytes = CASE
                   WHEN member_documents.helloasso_url IS NOT DISTINCT FROM EXCLUDED.helloasso_url
                   THEN member_documents.helloasso_size_bytes ELSE NULL END,
                 classification = CASE
                   WHEN member_documents.local_content IS NOT NULL
                     OR member_documents.helloasso_url IS NOT DISTINCT FROM EXCLUDED.helloasso_url
                   THEN member_documents.classification ELSE 'unknown' END,
                 classification_source = CASE
                   WHEN member_documents.local_content IS NOT NULL
                     OR member_documents.helloasso_url IS NOT DISTINCT FROM EXCLUDED.helloasso_url
                   THEN member_documents.classification_source ELSE 'automatic' END,
                 analyzed_hash = CASE
                   WHEN member_documents.local_content IS NOT NULL
                     OR member_documents.helloasso_url IS NOT DISTINCT FROM EXCLUDED.helloasso_url
                   THEN member_documents.analyzed_hash ELSE NULL END,
                 analyzed_at = CASE
                   WHEN member_documents.local_content IS NOT NULL
                     OR member_documents.helloasso_url IS NOT DISTINCT FROM EXCLUDED.helloasso_url
                   THEN member_documents.analyzed_at ELSE NULL END,
                 content_hash = CASE
                   WHEN member_documents.local_content IS NOT NULL
                     OR member_documents.helloasso_url IS NOT DISTINCT FROM EXCLUDED.helloasso_url
                   THEN member_documents.content_hash ELSE NULL END,
                 analysis_version = CASE
                   WHEN member_documents.local_content IS NOT NULL
                     OR member_documents.helloasso_url IS NOT DISTINCT FROM EXCLUDED.helloasso_url
                   THEN member_documents.analysis_version ELSE 0 END,
                 updated_at = now()`,
              [memberResult.rows[0]!.id, fileField.key, document?.url ?? null]
            );
          }
          for (const definition of groupDefinitions.values()) {
            const matches = definition.rules.some((rule) =>
              groupingValues.get(rule.fieldKey)?.has(rule.value)
            );
            if (!matches) continue;
            const groupResult = await client.query<{ id: string }>(
              `INSERT INTO groups (name, description, source, source_key)
               VALUES ($1, 'Groupe configuré depuis les données HelloAsso', 'helloasso', $2)
               ON CONFLICT (name) DO UPDATE SET
                 source_key = CASE
                   WHEN groups.source = 'helloasso' THEN EXCLUDED.source_key
                   ELSE groups.source_key
                 END
               RETURNING id`,
              [definition.name, definition.id]
            );
            await client.query(
              `INSERT INTO member_groups (member_id, group_id, source)
               SELECT $1, $2, 'helloasso'
               WHERE NOT EXISTS (
                 SELECT 1 FROM member_group_exclusions
                 WHERE member_id = $1 AND group_id = $2
               )
               ON CONFLICT (member_id, group_id) DO NOTHING`,
              [memberResult.rows[0]!.id, groupResult.rows[0]!.id]
            );
          }
          importedCount += 1;
        }
      }
      await refreshDynamicGroups(client);
      await client.query(`
        DELETE FROM groups g
        WHERE g.source = 'helloasso'
          AND NOT EXISTS (SELECT 1 FROM member_groups mg WHERE mg.group_id = g.id)
      `);
      await client.query(
        `UPDATE helloasso_sync_runs
         SET status = 'succeeded', finished_at = now(), imported_count = $2
         WHERE id = $1`,
        [syncId, importedCount]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { importedCount };
  } catch (error) {
    await database.query(
      `UPDATE helloasso_sync_runs SET status = 'failed', finished_at = now(), error_message = $2
       WHERE id = $1`,
      [syncId, error instanceof Error ? error.message.slice(0, 500) : "Erreur inconnue"]
    );
    throw error;
  }
}

/**
 * Personne déjà connue d'une autre saison : même nom, même prénom et même date de naissance
 * (sans tenir compte des accents ni de la casse). Sans date de naissance, pas de rapprochement.
 */
export async function findPersonId(
  database: Pick<Database, "query">,
  seasonId: string,
  firstName: string,
  lastName: string,
  birthDate: string | null
) {
  if (!birthDate) return null;
  const result = await database.query<{ personId: string; firstName: string; lastName: string }>(
    `SELECT person_id AS "personId",
            COALESCE(NULLIF(local_overrides->>'firstName', ''), first_name) AS "firstName",
            COALESCE(NULLIF(local_overrides->>'lastName', ''), last_name) AS "lastName"
     FROM members
     WHERE season_id <> $1
       AND COALESCE(NULLIF(local_overrides->>'birthDate', '')::date, birth_date) = $2::date
     ORDER BY created_at DESC`,
    [seasonId, birthDate]
  );
  const wanted = `${personName(firstName)}\0${personName(lastName)}`;
  return result.rows.find((row) => `${personName(row.firstName)}\0${personName(row.lastName)}` === wanted)?.personId ?? null;
}

function personName(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("fr").replace(/[^a-z0-9]+/g, " ").trim();
}

function uniqueFields(fields: HelloAssoCustomField[]) {
  const unique = new Map<string, HelloAssoCustomField>();
  for (const field of fields) unique.set(field.id, field);
  return [...unique.values()];
}

function normalizeLabel(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .replace(/[^a-z0-9-]+/g, " ")
    .trim();
}

function isHealthDocumentLabel(value: string) {
  const label = normalizeLabel(value);
  return /certificat|attestation|questionnaire.*sante/.test(label);
}

function answerToString(answer: unknown) {
  if (typeof answer === "string") return answer.trim() || null;
  if (typeof answer === "number") return String(answer);
  return null;
}

function dateAnswerToString(answer: unknown) {
  if (typeof answer !== "string") return null;
  return normalizeBirthDate(answer);
}

async function getAvailableGroupingFields(database: Database) {
  const result = await database.query<{ key: string; label: string; type: string }>(`
    SELECT DISTINCT f.field_key AS key, f.label, f.field_type AS type
    FROM helloasso_fields f
    JOIN helloasso_campaign_fields cf ON cf.field_key = f.field_key
    JOIN helloasso_campaigns c ON c.form_slug = cf.form_slug AND c.selected = true
    WHERE f.field_type <> 'File'
    ORDER BY f.label
  `);
  return [{ key: "tier", label: "Tarif choisi", type: "Tier" }, ...result.rows];
}

function documentAnswerUrl(answer: unknown) {
  if (typeof answer === "string" && /^https:\/\//i.test(answer.trim())) return answer.trim();
  if (answer && typeof answer === "object") {
    for (const key of ["url", "fileUrl", "downloadUrl"]) {
      const value = (answer as Record<string, unknown>)[key];
      if (typeof value === "string" && /^https:\/\//i.test(value.trim())) return value.trim();
    }
  }
  return null;
}

function addPreviewValues(
  counts: Map<string, Map<string, Set<number>>>,
  fieldKey: string,
  values: string[],
  memberId: number
) {
  const fieldCounts = counts.get(fieldKey) ?? new Map<string, Set<number>>();
  for (const value of values) {
    const members = fieldCounts.get(value) ?? new Set<number>();
    members.add(memberId);
    fieldCounts.set(value, members);
  }
  counts.set(fieldKey, fieldCounts);
}

const ignoredPaymentStates = new Set(["refused", "refunded", "refunding", "canceled", "cancelled", "abandoned"]);

/**
 * Somme réellement due pour l'adhésion, en centimes : toutes les échéances de la commande
 * affectées à cet adhérent (paiement en plusieurs fois, licence et location comprises),
 * hors paiements refusés ou remboursés. À défaut de détail des paiements : tarif + options.
 */
function membershipTotalAmount(item: { amount?: number | undefined; options?: Array<{ amount: number }>; payments?: Array<{ amount: number; state: string | null }> }) {
  const payments = (item.payments ?? []).filter((payment) => !ignoredPaymentStates.has((payment.state ?? "").toLowerCase()));
  if (payments.length > 0) return payments.reduce((sum, payment) => sum + payment.amount, 0);
  if (typeof item.amount !== "number") return null;
  return item.amount + (item.options ?? []).reduce((sum, option) => sum + option.amount, 0);
}
