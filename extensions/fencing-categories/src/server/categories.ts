import type { ExtensionQueryable } from "@gu/extension-host";
import { fencingCategoryError, normalizeBirthDate } from "./birth-date.js";

export type CategoryDefinition = {
  id: string;
  name: string;
  birthYearFrom: number;
  birthYearTo: number;
  sortOrder: number;
};

const seasonInitializations = new Map<number, Promise<void>>();

export async function getCategorySeason(database: ExtensionQueryable, reference = new Date()) {
  const settingsResult = await database.query<{ month: number; day: number }>(`
    SELECT rollover_month::int AS month, rollover_day::int AS day
    FROM fencing_category_settings WHERE singleton = true
  `);
  const settings = settingsResult.rows[0] ?? { month: 9, day: 1 };
  const paris = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(reference);
  const year = Number(paris.find((part) => part.type === "year")!.value);
  const month = Number(paris.find((part) => part.type === "month")!.value);
  const day = Number(paris.find((part) => part.type === "day")!.value);
  const afterRollover = month > settings.month || (month === settings.month && day >= settings.day);
  const startYear = afterRollover ? year : year - 1;
  return {
    startYear,
    endYear: startYear + 1,
    label: `${startYear}-${startYear + 1}`,
    rolloverDate: `${String(settings.month).padStart(2, "0")}-${String(settings.day).padStart(2, "0")}`
  };
}

export async function getCategoryDefinitions(database: ExtensionQueryable, reference = new Date()) {
  const season = await getCategorySeason(database, reference);
  await ensureSeasonCategories(database, season.startYear, season.endYear);
  const result = await database.query<CategoryDefinition>(`
    SELECT
      id,
      name,
      birth_year_from AS "birthYearFrom",
      birth_year_to AS "birthYearTo",
      sort_order AS "sortOrder"
    FROM fencing_categories
    WHERE season_start_year = $1
    ORDER BY sort_order, birth_year_to DESC, name
  `, [season.startYear]);
  return result.rows;
}

export async function getCategoryConfiguration(database: ExtensionQueryable, reference = new Date()) {
  const season = await getCategorySeason(database, reference);
  const definitions = await getCategoryDefinitions(database, reference);
  const membersResult = await database.query<{ birthDate: string | null }>(`
    SELECT CASE WHEN local_overrides ? 'birthDate'
      THEN local_overrides->>'birthDate'
      ELSE to_char(birth_date, 'YYYY-MM-DD')
    END AS "birthDate"
    FROM members
    WHERE status = 'active'
  `);
  const counts = new Map<string, number>();
  for (const member of membersResult.rows) {
    const category = categoryForBirthDate(member.birthDate, definitions, reference);
    if (category) counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return {
    season: season.label,
    seasonStartYear: season.startYear,
    rolloverDate: season.rolloverDate,
    items: definitions.map((definition) => ({
      ...definition,
      membersCount: counts.get(definition.name) ?? 0
    }))
  };
}

export function categoryForBirthDate(
  birthDate: string | null,
  definitions: CategoryDefinition[],
  reference = new Date()
) {
  const normalized = normalizeBirthDate(birthDate);
  if (!normalized || fencingCategoryError(normalized, reference)) return null;
  const birthYear = Number(normalized.slice(0, 4));
  return definitions.find(
    (definition) => birthYear >= definition.birthYearFrom && birthYear <= definition.birthYearTo
  )?.name ?? null;
}

async function ensureSeasonCategories(database: ExtensionQueryable, startYear: number, endYear: number) {
  const existing = seasonInitializations.get(startYear);
  if (existing) return existing;
  const initialization = initializeSeasonCategories(database, startYear, endYear);
  seasonInitializations.set(startYear, initialization);
  try {
    await initialization;
  } catch (error) {
    seasonInitializations.delete(startYear);
    throw error;
  }
}

async function initializeSeasonCategories(database: ExtensionQueryable, startYear: number, endYear: number) {
  const seasonResult = await database.query<{ seasonStartYear: number }>(
    `INSERT INTO fencing_category_seasons (season_start_year)
     VALUES ($1)
     ON CONFLICT (season_start_year) DO NOTHING
     RETURNING season_start_year AS "seasonStartYear"`,
    [startYear]
  );
  if (!seasonResult.rows[0]) return;
  const previousSeasonResult = await database.query<{ startYear: number }>(
    `SELECT max(season_start_year)::int AS "startYear"
     FROM fencing_category_seasons
     WHERE season_start_year < $1`,
    [startYear]
  );
  const previousStartYear = previousSeasonResult.rows[0]?.startYear;
  if (previousStartYear) {
    const shift = startYear - previousStartYear;
    await database.query(
      `INSERT INTO fencing_categories
         (season_start_year, name, birth_year_from, birth_year_to, sort_order)
       SELECT $1, name, birth_year_from + $3, birth_year_to + $3, sort_order
       FROM fencing_categories
       WHERE season_start_year = $2`,
      [startYear, previousStartYear, shift]
    );
    return;
  }
  const defaults = defaultCategories(endYear);
  for (const [index, category] of defaults.entries()) {
    await database.query(
      `INSERT INTO fencing_categories
         (season_start_year, name, birth_year_from, birth_year_to, sort_order)
       VALUES ($1, $2, $3, $4, $5)`,
      [startYear, category.name, category.birthYearFrom, category.birthYearTo, index]
    );
  }
}

function defaultCategories(endYear: number) {
  return [
    { name: "M5", birthYearFrom: endYear - 5, birthYearTo: endYear },
    { name: "M7", birthYearFrom: endYear - 7, birthYearTo: endYear - 6 },
    { name: "M9", birthYearFrom: endYear - 9, birthYearTo: endYear - 8 },
    { name: "M11", birthYearFrom: endYear - 11, birthYearTo: endYear - 10 },
    { name: "M13", birthYearFrom: endYear - 13, birthYearTo: endYear - 12 },
    { name: "M15", birthYearFrom: endYear - 15, birthYearTo: endYear - 14 },
    { name: "M17", birthYearFrom: endYear - 17, birthYearTo: endYear - 16 },
    { name: "M20", birthYearFrom: endYear - 20, birthYearTo: endYear - 18 },
    { name: "Senior", birthYearFrom: endYear - 39, birthYearTo: endYear - 21 },
    { name: "V1", birthYearFrom: endYear - 49, birthYearTo: endYear - 40 },
    { name: "V2", birthYearFrom: endYear - 59, birthYearTo: endYear - 50 },
    { name: "V3", birthYearFrom: endYear - 69, birthYearTo: endYear - 60 },
    { name: "V4", birthYearFrom: endYear - 120, birthYearTo: endYear - 70 }
  ];
}
