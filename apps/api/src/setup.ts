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

export async function getSetupState(database: Database) {
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
      fieldsCount: number;
    }>(`
      SELECT c.form_slug AS "formSlug", c.title, c.state,
             c.start_date AS "startDate", c.end_date AS "endDate", c.selected,
             count(cf.source_field_id)::int AS "fieldsCount"
      FROM helloasso_campaigns c
      LEFT JOIN helloasso_campaign_fields cf ON cf.form_slug = c.form_slug
      GROUP BY c.form_slug
      ORDER BY c.start_date DESC NULLS LAST, c.title
    `),
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

export async function discoverCampaigns(database: Database, helloasso: HelloAssoClient) {
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
  return getSetupState(database);
}

export async function selectCampaigns(
  database: Database,
  helloasso: HelloAssoClient,
  formSlugs: string[]
) {
  const known = await database.query<{ formSlug: string }>(
    "SELECT form_slug AS \"formSlug\" FROM helloasso_campaigns WHERE form_slug = ANY($1::text[])",
    [formSlugs]
  );
  if (known.rows.length !== new Set(formSlugs).size) {
    throw new Error("Une campagne sélectionnée n'est pas connue.");
  }

  const inspected = await Promise.all(
    formSlugs.map(async (formSlug) => ({
      formSlug,
      items: await helloasso.listMembershipItems(formSlug)
    }))
  );

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE helloasso_campaigns SET selected = false");
    await client.query(
      "UPDATE helloasso_campaigns SET selected = true, updated_at = now() WHERE form_slug = ANY($1::text[])",
      [formSlugs]
    );
    await client.query("DELETE FROM app_settings WHERE key = 'helloasso_setup'");
    await client.query("DELETE FROM app_settings WHERE key = 'helloasso_groups'");

    for (const campaign of inspected) {
      await client.query("DELETE FROM helloasso_campaign_fields WHERE form_slug = $1", [campaign.formSlug]);
      const fields = uniqueFields(campaign.items.flatMap((item) => item.customFields));
      for (const field of fields) {
        const localMatch = await client.query<{ key: string }>(
          `SELECT field_key AS key FROM helloasso_fields
           WHERE source = 'local' AND lower(label) = lower($1) AND field_type = $2
           ORDER BY discovered_at LIMIT 1`,
          [field.name, field.type]
        );
        const key = localMatch.rows[0]?.key ?? fieldKey(field.name, field.type);
        await client.query(
          `INSERT INTO helloasso_fields (field_key, label, field_type)
           VALUES ($1, $2, $3)
           ON CONFLICT (field_key) DO UPDATE SET
             label = EXCLUDED.label, field_type = EXCLUDED.field_type, updated_at = now()`,
          [key, field.name, field.type]
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

  return getSetupState(database);
}

export async function selectFields(database: Database, keys: string[], healthDocumentFieldKey: string | null) {
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
  return getSetupState(database);
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
  return getSetupState(database);
}

export async function importMembers(database: Database, helloasso: HelloAssoClient) {
  const campaignsResult = await database.query<{ formSlug: string; title: string }>(
    `SELECT form_slug AS "formSlug", title FROM helloasso_campaigns WHERE selected = true`
  );
  if (campaignsResult.rows.length === 0) {
    throw new Error("Aucune campagne n'est sélectionnée.");
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
  const allFieldsResult = await database.query<{ key: string; label: string; type: string }>(`
    SELECT DISTINCT f.field_key AS key, f.label, f.field_type AS type
    FROM helloasso_fields f
    JOIN helloasso_campaign_fields cf ON cf.field_key = f.field_key
    JOIN helloasso_campaigns c ON c.form_slug = cf.form_slug AND c.selected = true
  `);
  const customFieldKeyByIdentity = new Map(
    allFieldsResult.rows.map((field) => [`${field.type}\0${field.label}`, field.key])
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
            const groupingFieldKey = customFieldKeyByIdentity.get(
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
            const selected = selectedFields.get(`${answer.type}\0${answer.name}`);
            if (!selected) continue;
            if (selected.type === "File") {
              const url = documentAnswerUrl(answer.answer);
              if (url) documentAnswers.push({ fieldKey: selected.key, url });
              continue;
            }
            profileData[selected.key] = answer.answer;
            if (/e-?mail|courriel/.test(normalizedLabel)) email = answerToString(answer.answer);
            if (answer.type === "Phone" && /telephone 1/.test(normalizedLabel)) {
              phone = answerToString(answer.answer);
            }
          }
          const memberResult = await client.query<{ id: string; locallyDeletedAt: Date | null }>(
            `INSERT INTO members
               (helloasso_item_id, first_name, last_name, email, phone, birth_date, status, source, source_data, profile_data)
             VALUES ($1, $2, $3, $4, $5, $6, 'active', 'helloasso', $7, $8)
             ON CONFLICT (helloasso_item_id) DO UPDATE SET
               first_name = EXCLUDED.first_name,
               last_name = EXCLUDED.last_name,
               email = EXCLUDED.email,
               phone = EXCLUDED.phone,
               birth_date = EXCLUDED.birth_date,
               status = CASE WHEN members.locally_deleted_at IS NULL THEN 'active' ELSE 'inactive' END,
               source_data = EXCLUDED.source_data,
               profile_data = EXCLUDED.profile_data,
               updated_at = now()
             RETURNING id, locally_deleted_at AS "locallyDeletedAt"`,
            [
              item.id,
              item.user.firstName.trim(),
              item.user.lastName.trim(),
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
                orderId: item.order?.id ?? null,
                orderDate: item.order?.date ?? null,
                payerFirstName: item.payer?.firstName ?? null,
                payerLastName: item.payer?.lastName ?? null
              },
              profileData
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
