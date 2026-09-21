import { z } from "zod";
import type { ExtensionServerHost } from "@gu/extension-host";
import { fencingCategoryError, normalizeBirthDate } from "./birth-date.js";
import {
  categoryForBirthDate,
  getCategoryConfiguration,
  getCategoryDefinitions,
  getCategorySeason
} from "./categories.js";

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

export default function register(host: ExtensionServerHost) {
  const database = host.database;
  const refreshDynamicGroups = host.core.refreshDynamicGroups;
  if (!refreshDynamicGroups) {
    throw new Error("La capacité dynamic-groups est requise par ce module.");
  }

  host.contracts.irlTargets.register("categories", { extensionId: host.id });
  host.contracts.registerGroupCriterionProvider({
    extensionId: host.id,
    criterion: { key: "category", label: "Catégorie FFE", type: "Category" },
    loadContext: async (db) => ({ definitions: await getCategoryDefinitions(db) }),
    values: (context) => context.definitions.map((definition) => definition.name),
    memberValues: (member, context) => {
      const overridden = Object.hasOwn(member.localOverrides, "birthDate")
        ? member.localOverrides.birthDate
        : member.birthDate;
      const category = categoryForBirthDate(
        typeof overridden === "string" ? normalizeBirthDate(overridden) : null,
        context.definitions
      );
      return category ? [category] : [];
    }
  });
  host.contracts.registerMemberCategoryProvider({
    extensionId: host.id,
    loadContext: async (db, reference) => ({
      definitions: await getCategoryDefinitions(db, reference),
      season: await getCategorySeason(db, reference)
    }),
    season: (context) => context.season.label,
    values: (context) => context.definitions.map((definition) => definition.name),
    compute: (birthDate, context) => {
      const normalized = normalizeBirthDate(birthDate);
      return {
        fencingCategory: categoryForBirthDate(normalized, context.definitions),
        categoryError: fencingCategoryError(normalized)
      };
    }
  });

  host.route("GET", "/api/categories", {}, async () => getCategoryConfiguration(database));

  host.route("PUT", "/api/categories/settings", {}, async (request) => {
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

  host.route("POST", "/api/categories", {}, async (request, reply) => {
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

  host.route("PUT", "/api/categories/:categoryId", {}, async (request, reply) => {
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

  host.route("DELETE", "/api/categories/:categoryId", {}, async (request, reply) => {
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
}
