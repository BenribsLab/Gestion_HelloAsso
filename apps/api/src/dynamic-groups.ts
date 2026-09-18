import type { Database } from "./db.js";
import { categoryForBirthDate, getCategoryDefinitions, type CategoryDefinition } from "./categories.js";
import { normalizeBirthDate } from "./fencing-category.js";
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

export async function getDynamicGroupCriteria(database: Queryable) {
  const [fields, members, categoryDefinitions] = await Promise.all([
    getCriterionFields(database),
    getActiveMembers(database),
    getCategoryDefinitions(database)
  ]);
  return fields.map((field) => {
    const counts = new Map<string, number>();
    for (const member of members) {
      for (const value of memberCriterionValues(member, field.key, categoryDefinitions)) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    const values = field.key === "category"
      ? categoryDefinitions.map((category) => ({ value: category.name, count: counts.get(category.name) ?? 0 }))
      : [...counts.entries()]
          .map(([value, count]) => ({ value, count }))
          .sort((left, right) => left.value.localeCompare(right.value, "fr"));
    return { ...field, values };
  });
}

export async function validateDynamicCriterion(database: Queryable, fieldKey: string, values: string[]) {
  const [fields, categoryDefinitions] = await Promise.all([
    getCriterionFields(database),
    getCategoryDefinitions(database)
  ]);
  const field = fields.find((item) => item.key === fieldKey);
  if (!field) return null;
  const normalizedValues = [...new Set(values.map((value) => normalizeCriterionValue(fieldKey, value)).filter(Boolean))];
  if (fieldKey === "category") {
    const available = new Set(categoryDefinitions.map((category) => category.name));
    if (normalizedValues.some((value) => !available.has(value))) return null;
  }
  return normalizedValues.length > 0 ? { field, values: normalizedValues } : null;
}

export async function refreshDynamicGroups(database: Queryable) {
  const [groupsResult, rulesResult, members, categoryDefinitions] = await Promise.all([
    database.query<{ id: string }>("SELECT id FROM groups WHERE source = 'dynamic'"),
    database.query<{ groupId: string; fieldKey: string; value: string }>(`
      SELECT group_id AS "groupId", field_key AS "fieldKey", match_value AS value
      FROM group_dynamic_rules
      ORDER BY group_id
    `),
    getActiveMembers(database),
    getCategoryDefinitions(database)
  ]);
  const rulesByGroup = new Map<string, Array<{ fieldKey: string; value: string }>>();
  for (const rule of rulesResult.rows) {
    const rules = rulesByGroup.get(rule.groupId) ?? [];
    rules.push({ fieldKey: rule.fieldKey, value: rule.value });
    rulesByGroup.set(rule.groupId, rules);
  }

  for (const { id: groupId } of groupsResult.rows) {
    const rules = rulesByGroup.get(groupId) ?? [];
    await database.query(
      "DELETE FROM member_groups WHERE group_id = $1 AND source = 'dynamic'",
      [groupId]
    );
    const matchingIds = members
      .filter((member) => rules.some((rule) => memberCriterionValues(member, rule.fieldKey, categoryDefinitions).includes(rule.value)))
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
    ...result.rows.map((field) => ({ ...field, source: "helloasso" as const })),
    { key: "category", label: "Catégorie FFE", type: "Category", source: "calculated" as const }
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
    WHERE status = 'active'
  `);
  return result.rows;
}

function memberCriterionValues(member: DynamicMember, fieldKey: string, categoryDefinitions: CategoryDefinition[]) {
  if (fieldKey === "tier") return groupValues(member.sourceData.tierName, true);
  if (fieldKey === "campaign") return groupValues(member.sourceData.campaignTitle, false);
  if (fieldKey === "category") {
    const overridden = Object.hasOwn(member.localOverrides, "birthDate")
      ? member.localOverrides.birthDate
      : member.birthDate;
    const category = categoryForBirthDate(
      typeof overridden === "string" ? normalizeBirthDate(overridden) : null,
      categoryDefinitions
    );
    return category ? [category] : [];
  }
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
