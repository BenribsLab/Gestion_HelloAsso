import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database } from "./db.js";

type Queryable = Pick<Database, "query">;

/** Saison sportive telle que le cœur la transmet aux écrans et aux extensions. */
export type Season = {
  id: string;
  label: string;
  /** Dates au format AAAA-MM-JJ. */
  startsOn: string;
  endsOn: string;
  startYear: number;
};

/** En-tête envoyé par le navigateur avec chaque requête : la saison sélectionnée. */
export const seasonHeader = "x-gu-season";

const seasonInputSchema = z.object({
  label: z.string().trim().min(4).max(40),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
}).refine((value) => value.endsOn > value.startsOn, {
  message: "La date de fin doit être après la date de début.",
  path: ["endsOn"]
});
const seasonIdSchema = z.object({ seasonId: z.uuid() });

const seasonColumns = `
  id, label, to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(ends_on, 'YYYY-MM-DD') AS "endsOn",
  extract(year FROM starts_on)::int AS "startYear"
`;

export async function listSeasons(database: Queryable) {
  const result = await database.query<Season>(`SELECT ${seasonColumns} FROM seasons ORDER BY starts_on DESC`);
  return result.rows;
}

export async function seasonById(database: Queryable, seasonId: string) {
  const result = await database.query<Season>(`SELECT ${seasonColumns} FROM seasons WHERE id = $1`, [seasonId]);
  return result.rows[0] ?? null;
}

/**
 * Saison du jour : celle qui contient la date du jour (heure de Paris). Entre deux saisons
 * créées, la plus récente déjà commencée ; à défaut, la plus ancienne.
 */
export async function currentSeason(database: Queryable, now = new Date()) {
  const today = parisDate(now);
  const result = await database.query<Season>(`
    SELECT ${seasonColumns} FROM seasons
    ORDER BY (starts_on <= $1::date AND ends_on >= $1::date) DESC,
             (starts_on <= $1::date) DESC,
             CASE WHEN starts_on <= $1::date THEN starts_on END DESC NULLS LAST,
             starts_on
    LIMIT 1
  `, [today]);
  const season = result.rows[0];
  if (!season) throw new Error("Aucune saison n'est créée.");
  return season;
}

/** Saison sélectionnée par l'écran (en-tête), sinon la saison du jour. */
export async function requestSeason(database: Queryable, request: { headers: Record<string, string | string[] | undefined> }) {
  const raw = request.headers[seasonHeader];
  const requested = Array.isArray(raw) ? raw[0] : raw;
  if (requested && z.uuid().safeParse(requested).success) {
    const season = await seasonById(database, requested);
    if (season) return season;
  }
  return currentSeason(database);
}

/** Date à l'intérieur de la saison servant de référence aux calculs dépendant de l'âge. */
export function seasonReference(season: Season) {
  return new Date(`${season.startsOn}T12:00:00Z`);
}

export function parisDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function registerSeasonRoutes(server: FastifyInstance, database: Database) {
  server.get("/api/seasons", async (request: FastifyRequest) => {
    const [items, current, selected] = await Promise.all([
      listSeasons(database),
      currentSeason(database),
      requestSeason(database, request)
    ]);
    const counts = await database.query<{ seasonId: string; members: number; campaigns: number }>(`
      SELECT s.id AS "seasonId",
             (SELECT count(*)::int FROM members m WHERE m.season_id = s.id AND m.locally_deleted_at IS NULL) AS members,
             (SELECT count(*)::int FROM helloasso_campaigns c WHERE c.season_id = s.id) AS campaigns
      FROM seasons s
    `);
    const countBySeason = new Map(counts.rows.map((row) => [row.seasonId, row]));
    return {
      currentId: current.id,
      selectedId: selected.id,
      items: items.map((season) => ({
        ...season,
        membersCount: countBySeason.get(season.id)?.members ?? 0,
        campaignsCount: countBySeason.get(season.id)?.campaigns ?? 0
      }))
    };
  });

  server.post("/api/seasons", async (request, reply) => {
    const input = seasonInputSchema.parse(request.body);
    const overlap = await database.query(
      "SELECT label FROM seasons WHERE starts_on <= $2::date AND ends_on >= $1::date",
      [input.startsOn, input.endsOn]
    );
    if (overlap.rows[0]) {
      return reply.code(409).send({ message: `Ces dates chevauchent la saison ${(overlap.rows[0] as { label: string }).label}.` });
    }
    try {
      const result = await database.query<Season>(
        `INSERT INTO seasons (label, starts_on, ends_on) VALUES ($1, $2, $3) RETURNING ${seasonColumns}`,
        [input.label, input.startsOn, input.endsOn]
      );
      return reply.code(201).send(result.rows[0]);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        return reply.code(409).send({ message: "Une saison porte déjà ce nom." });
      }
      throw error;
    }
  });

  server.put("/api/seasons/:seasonId", async (request, reply) => {
    const { seasonId } = seasonIdSchema.parse(request.params);
    const input = seasonInputSchema.parse(request.body);
    const overlap = await database.query<{ label: string }>(
      "SELECT label FROM seasons WHERE id <> $3 AND starts_on <= $2::date AND ends_on >= $1::date",
      [input.startsOn, input.endsOn, seasonId]
    );
    if (overlap.rows[0]) {
      return reply.code(409).send({ message: `Ces dates chevauchent la saison ${overlap.rows[0].label}.` });
    }
    try {
      const result = await database.query<Season>(
        `UPDATE seasons SET label = $2, starts_on = $3, ends_on = $4, updated_at = now()
         WHERE id = $1 RETURNING ${seasonColumns}`,
        [seasonId, input.label, input.startsOn, input.endsOn]
      );
      if (!result.rows[0]) return reply.code(404).send({ message: "Cette saison n'existe pas." });
      return result.rows[0];
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505") {
        return reply.code(409).send({ message: "Une saison porte déjà ce nom." });
      }
      throw error;
    }
  });

  server.delete("/api/seasons/:seasonId", async (request, reply) => {
    const { seasonId } = seasonIdSchema.parse(request.params);
    const used = await database.query("SELECT 1 FROM members WHERE season_id = $1 LIMIT 1", [seasonId]);
    if (used.rows[0]) {
      return reply.code(409).send({ message: "Cette saison contient des adhérents : elle ne peut pas être supprimée." });
    }
    const total = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM seasons");
    if ((total.rows[0]?.count ?? 0) <= 1) {
      return reply.code(409).send({ message: "Il faut garder au moins une saison." });
    }
    await database.query(
      "UPDATE helloasso_campaigns SET selected = false, season_id = NULL, updated_at = now() WHERE season_id = $1",
      [seasonId]
    );
    await database.query("DELETE FROM seasons WHERE id = $1", [seasonId]);
    return { seasonId, deleted: true };
  });
}
