import type { Database } from "./db.js";
import type { ExtensionContracts, ResolvedGroupCriterion } from "./extension-contracts.js";
import { groupValues } from "./group-values.js";

type Queryable = Pick<Database, "query">;

type DynamicMember = {
  id: string;
  sourceData: Record<string, unknown>;
  profileData: Record<string, unknown>;
  localOverrides: Record<string, unknown>;
  birthDate: string | null;
};

type CriterionField = {
  key: string;
  label: string;
  type: string;
  source: "helloasso" | "calculated";
};

/**
 * Les critères apportés par les modules sont résolus à la demande. `refreshDynamicGroups` est
 * appelé depuis une dizaine d'endroits, y compris par les modules eux-mêmes via `host.core`,
 * et garde donc sa signature d'origine : les contrats sont branchés une fois au démarrage.
 */
let contractAccess: {
  contracts: ExtensionContracts;
  isExtensionEnabled: (extensionId: string) => boolean;
} | null = null;

export function configureDynamicGroups(access: NonNullable<typeof contractAccess>) {
  contractAccess = access;
}

async function contributedCriteria(database: Queryable) {
  if (!contractAccess) return [];
  return contractAccess.contracts.loadGroupCriteria(database, contractAccess.isExtensionEnabled);
}

/** Critères déclarés par un module actuellement inactif : leurs groupes ne sont pas recalculés. */
function unavailableCriterionKeys(available: ResolvedGroupCriterion[]) {
  if (!contractAccess) return new Set<string>();
  const availableKeys = new Set(available.map((entry) => entry.criterion.key));
  return new Set(
    contractAccess.contracts.contributedCriterionKeys().filter((key) => !availableKeys.has(key))
  );
}

export async function getDynamicGroupCriteria(database: Queryable) {
  const [fields, members, contributed] = await Promise.all([
    getCriterionFields(database),
    getActiveMembers(database),
    contributedCriteria(database)
  ]);
  const all = [
    ...fields,
    ...contributed.map((entry) => ({ ...entry.criterion, source: "calculated" as const }))
  ] satisfies CriterionField[];

  return all.map((field) => {
    const provided = contributed.find((entry) => entry.criterion.key === field.key);
    const counts = new Map<string, number>();
    for (const member of members) {
      for (const value of memberCriterionValues(member, field.key, contributed)) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    const values = provided
      ? provided.values.map((value) => ({ value, count: counts.get(value) ?? 0 }))
      : [...counts.entries()]
          .map(([value, count]) => ({ value, count }))
          .sort((left, right) => left.value.localeCompare(right.value, "fr"));
    return { ...field, values };
  });
}

export async function validateDynamicCriterion(database: Queryable, fieldKey: string, values: string[]) {
  const [fields, contributed] = await Promise.all([
    getCriterionFields(database),
    contributedCriteria(database)
  ]);
  const provided = contributed.find((entry) => entry.criterion.key === fieldKey);
  const field = provided
    ? { ...provided.criterion, source: "calculated" as const }
    : fields.find((item) => item.key === fieldKey);
  if (!field) return null;
  const normalizedValues = [...new Set(values.map((value) => normalizeCriterionValue(fieldKey, value)).filter(Boolean))];
  if (provided) {
    const available = new Set(provided.values);
    if (normalizedValues.some((value) => !available.has(value))) return null;
  }
  return normalizedValues.length > 0 ? { field, values: normalizedValues } : null;
}

export async function refreshDynamicGroups(database: Queryable) {
  const [groupsResult, rulesResult, members, contributed] = await Promise.all([
    database.query<{ id: string }>("SELECT id FROM groups WHERE source = 'dynamic'"),
    database.query<{ groupId: string; fieldKey: string; value: string }>(`
      SELECT group_id AS "groupId", field_key AS "fieldKey", match_value AS value
      FROM group_dynamic_rules
      ORDER BY group_id
    `),
    getActiveMembers(database),
    contributedCriteria(database)
  ]);
  const unavailable = unavailableCriterionKeys(contributed);
  const rulesByGroup = new Map<string, Array<{ fieldKey: string; value: string }>>();
  for (const rule of rulesResult.rows) {
    const rules = rulesByGroup.get(rule.groupId) ?? [];
    rules.push({ fieldKey: rule.fieldKey, value: rule.value });
    rulesByGroup.set(rule.groupId, rules);
  }

  for (const { id: groupId } of groupsResult.rows) {
    const rules = rulesByGroup.get(groupId) ?? [];
    // Un groupe bâti sur un critère venu d'un module désactivé est laissé intact : le
    // recalculer viderait sa composition alors que les données doivent être conservées.
    if (rules.some((rule) => unavailable.has(rule.fieldKey))) continue;
    await database.query(
      "DELETE FROM member_groups WHERE group_id = $1 AND source = 'dynamic'",
      [groupId]
    );
    const matchingIds = members
      .filter((member) => rules.some((rule) => memberCriterionValues(member, rule.fieldKey, contributed).includes(rule.value)))
      .map((member) => member.id);
    if (matchingIds.length === 0) continue;
    await database.query(
      `INSERT INTO member_groups (member_id, group_id, source)
       SELECT matched.member_id, $1, 'dynamic'
       FROM unnest($2::uuid[]) AS matched(member_id)
       WHERE NOT EXISTS (
         SELECT 1 FROM member_group_exclusions exclusion
         WHERE exclusion.member_id = matched.member_id AND exclusion.group_id = $1
       )
       ON CONFLICT (member_id, group_id) DO NOTHING`,
      [groupId, matchingIds]
    );
  }
}

async function getCriterionFields(database: Queryable) {
  const result = await database.query<{ key: string; label: string; type: string }>(`
    SELECT field_key AS key, label, field_type AS type
    FROM helloasso_fields
    WHERE selected = true
    ORDER BY label
  `);
  return [
    { key: "tier", label: "Tarif choisi", type: "Tier", source: "helloasso" as const },
    { key: "campaign", label: "Campagne d'adhésion", type: "Campaign", source: "helloasso" as const },
    ...result.rows.map((field) => ({ ...field, source: "helloasso" as const }))
  ] satisfies CriterionField[];
}

async function getActiveMembers(database: Queryable) {
  const result = await database.query<DynamicMember>(`
    SELECT
      id,
      COALESCE(source_data, '{}'::jsonb) AS "sourceData",
      COALESCE(profile_data, '{}'::jsonb) AS "profileData",
      COALESCE(local_overrides, '{}'::jsonb) AS "localOverrides",
      to_char(birth_date, 'YYYY-MM-DD') AS "birthDate"
    FROM members
    WHERE status = 'active' AND locally_deleted_at IS NULL
  `);
  return result.rows;
}

function memberCriterionValues(
  member: DynamicMember,
  fieldKey: string,
  contributed: ResolvedGroupCriterion[]
) {
  if (fieldKey === "tier") return groupValues(member.sourceData.tierName, true);
  if (fieldKey === "campaign") return groupValues(member.sourceData.campaignTitle, false);
  const provided = contributed.find((entry) => entry.criterion.key === fieldKey);
  if (provided) return provided.memberValues(member);
  const profileOverrides = isRecord(member.localOverrides.profileData)
    ? member.localOverrides.profileData
    : {};
  const value = Object.hasOwn(profileOverrides, fieldKey)
    ? profileOverrides[fieldKey]
    : member.profileData[fieldKey];
  return groupValues(value, false);
}

function normalizeCriterionValue(fieldKey: string, value: string) {
  return groupValues(value, fieldKey === "tier")[0] ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
