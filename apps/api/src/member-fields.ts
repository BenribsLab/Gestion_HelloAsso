import type { Database } from "./db.js";
import type { MemberFieldRequirement } from "./extension-contracts.js";

export type ResolvedModuleField = {
  key: string;
  label: string;
  type: string;
  storage: "profileData" | "moduleData";
  source: "helloasso" | "module";
  inputMode: "text" | "select";
  options: string[];
  selected: boolean;
  sourceRule: MemberFieldRequirement["source"];
  usages: Array<{ extensionId: string; description: string }>;
};

export async function resolveModuleFields(database: Database, requirements: MemberFieldRequirement[]) {
  const helloassoRequirements = requirements.filter(
    (requirement) => requirement.source.kind === "helloasso-field"
  );
  const fields = helloassoRequirements.length === 0 ? [] : (await database.query<{
    key: string;
    label: string;
    type: string;
    selected: boolean;
    inputMode: "auto" | "text" | "select";
    options: unknown;
  }>(`
    SELECT DISTINCT f.field_key AS key, f.label, f.field_type AS type, f.selected,
           f.input_mode AS "inputMode", f.choice_options AS options
    FROM helloasso_fields f
    JOIN helloasso_campaign_fields cf ON cf.field_key = f.field_key
    JOIN helloasso_campaigns c ON c.form_slug = cf.form_slug AND c.selected = true
    ORDER BY f.label
  `)).rows;

  const resolved = new Map<string, ResolvedModuleField>();
  for (const requirement of requirements) {
    if (requirement.source.kind === "payer") {
      const id = `module:${requirement.key}`;
      const existing = resolved.get(id);
      if (existing) {
        existing.usages.push({ extensionId: requirement.extensionId, description: requirement.description });
      } else {
        resolved.set(id, {
          key: requirement.key,
          label: requirement.label,
          type: requirement.type,
          storage: "moduleData",
          source: "module",
          inputMode: "text",
          options: [],
          selected: false,
          sourceRule: requirement.source,
          usages: [{ extensionId: requirement.extensionId, description: requirement.description }]
        });
      }
      continue;
    }
    for (const field of fields) {
      if (!requirement.source.labelPatterns.some((pattern) => safePattern(pattern).test(normalizedLabel(field.label)))) {
        continue;
      }
      const id = `profile:${field.key}`;
      const existing = resolved.get(id);
      if (existing) {
        existing.usages.push({ extensionId: requirement.extensionId, description: requirement.description });
      } else {
        resolved.set(id, {
          key: field.key,
          label: field.label,
          type: field.type,
          storage: "profileData",
          source: "helloasso",
          inputMode: field.inputMode === "select" ? "select" : "text",
          options: stringOptions(field.options),
          selected: field.selected,
          sourceRule: requirement.source,
          usages: [{ extensionId: requirement.extensionId, description: requirement.description }]
        });
      }
    }
  }
  return [...resolved.values()];
}

export function normalizedLabel(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^\p{Letter}\p{Number}]+/gu, " ").trim().toLocaleLowerCase("fr");
}

export function stringOptions(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function ensureMemberFieldInputs(database: Database) {
  const fields = await database.query<{ key: string; type: string }>(`
    SELECT field_key AS key, field_type AS type
    FROM helloasso_fields WHERE input_mode = 'auto' AND field_type <> 'File'
  `);
  for (const field of fields.rows) {
    const answers = await database.query<{ value: unknown }>(`
      SELECT profile_data->$1 AS value
      FROM members
      WHERE locally_deleted_at IS NULL AND profile_data ? $1 AND profile_data->$1 IS NOT NULL
    `, [field.key]);
    const values = answers.rows.flatMap((row) => choiceValues(row.value));
    const options = [...new Map(values.map((value) => [value.normalize("NFC").trim().toLocaleLowerCase("fr"), value.trim()])).values()]
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right, "fr"));
    const declaredChoice = /choice|yesno|oui\s*\/\s*non|boolean/i.test(field.type);
    const recurrentSmallSet = options.length >= 2 && options.length <= 8 && values.length >= Math.max(5, options.length * 2);
    await database.query(
      `UPDATE helloasso_fields SET input_mode = $2, choice_options = $3, updated_at = now()
       WHERE field_key = $1 AND input_mode = 'auto'`,
      [field.key, declaredChoice || recurrentSmallSet ? "select" : "text", JSON.stringify(options)]
    );
  }
}

function choiceValues(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(choiceValues);
  return [];
}

function safePattern(source: string) {
  try { return new RegExp(source, "iu"); }
  catch { return /$a/; }
}
