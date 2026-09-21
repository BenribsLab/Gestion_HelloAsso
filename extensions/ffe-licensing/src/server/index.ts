import { z } from "zod";
import type { ExtensionServerHost } from "@gu/extension-host";

// Une installation de gestion-utilisateurs = un club = une seule session FFE : pas besoin d'un
// identifiant plus fin côté ffe-browser (voir services/ffe-browser/src/sessions.ts).
const CLUB_ID = "club";
const ffeBrowserUrl = process.env.FFE_BROWSER_URL ?? "http://ffe-browser:4000";
const ffeBrowserToken = process.env.FFE_BROWSER_INTERNAL_TOKEN ?? "";

class BrowserCallError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

async function callBrowser<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${ffeBrowserUrl}${path}`, {
    ...init,
    headers: {
      // ffe-browser refuse un corps vide avec ce type de contenu déclaré : ne l'envoyer que
      // lorsqu'il y a réellement un corps (les appels "ensure"/"close" n'en ont pas).
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      "X-Ffe-Browser-Token": ffeBrowserToken,
      ...(init.headers as Record<string, string> ?? {})
    }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (payload as { message?: string } | null)?.message ?? `ffe-browser a répondu ${response.status}.`;
    throw new BrowserCallError(response.status, message);
  }
  return payload as T;
}

// Approximation volontairement simple (juillet -> nouvelle saison) : aucune notion de saison
// n'existe dans le noyau, et la FFE ne l'expose pas ailleurs qu'affichée dans son propre bandeau.
function currentSeason(date = new Date()): string {
  const year = date.getUTCFullYear();
  return date.getUTCMonth() >= 6 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

function formatBirthDateForFfe(isoDate: string): { display: string; year: number } {
  const date = new Date(isoDate);
  const display = `${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${date.getUTCFullYear()}`;
  return { display, year: date.getUTCFullYear() };
}

const memberIdParamsSchema = z.object({ memberId: z.uuid() });
const runIdParamsSchema = z.object({ runId: z.uuid() });
const factsSchema = z.object({
  knownInFfeDatabase: z.boolean().nullable().optional(),
  inStructureLast5Seasons: z.boolean().optional()
});
const credentialsSchema = z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(200) });

export default function register(host: ExtensionServerHost) {
  host.route("GET", "/api/ffe-licensing/members/:memberId", {}, async (request) => {
    const { memberId } = memberIdParamsSchema.parse(request.params);
    const season = currentSeason();
    const factsResult = await host.database.query<{
      knownInFfeDatabase: boolean | null;
      inStructureLast5Seasons: boolean;
    }>(
      `SELECT known_in_ffe_database AS "knownInFfeDatabase", in_structure_last_5_seasons AS "inStructureLast5Seasons"
       FROM ffe_member_facts WHERE member_id = $1`,
      [memberId]
    );
    const licenseResult = await host.database.query<{ status: string; takenAt: string | null }>(
      `SELECT status, taken_at AS "takenAt" FROM ffe_licenses WHERE member_id = $1 AND season = $2`,
      [memberId, season]
    );
    return {
      season,
      facts: factsResult.rows[0] ?? { knownInFfeDatabase: null, inStructureLast5Seasons: true },
      license: licenseResult.rows[0] ?? { status: "not_taken", takenAt: null }
    };
  });

  host.route("PUT", "/api/ffe-licensing/members/:memberId/facts", {}, async (request) => {
    const { memberId } = memberIdParamsSchema.parse(request.params);
    const input = factsSchema.parse(request.body);
    await host.database.query(
      `INSERT INTO ffe_member_facts (member_id, known_in_ffe_database, in_structure_last_5_seasons, updated_by)
       VALUES ($1, $2, COALESCE($3, true), $4)
       ON CONFLICT (member_id) DO UPDATE SET
         known_in_ffe_database = COALESCE($2, ffe_member_facts.known_in_ffe_database),
         in_structure_last_5_seasons = COALESCE($3, ffe_member_facts.in_structure_last_5_seasons),
         updated_by = $4, updated_at = now()`,
      [memberId, input.knownInFfeDatabase ?? null, input.inStructureLast5Seasons ?? null, request.authUser?.id ?? null]
    );
    return { updated: true };
  });

  host.route("GET", "/api/ffe-licensing/settings", {}, async () => {
    const stored = await host.settings.read<{ configured: boolean; username: string | null }, { username: string; password: string }>();
    return stored?.publicValue ?? { configured: false, username: null };
  });

  host.route("PUT", "/api/ffe-licensing/settings", {}, async (request, reply) => {
    if (!host.settings.canWriteSecrets()) {
      return reply.code(409).send({ message: "Le stockage sécurisé n'est pas configuré sur cette instance (SETTINGS_ENCRYPTION_KEY)." });
    }
    const input = credentialsSchema.parse(request.body);
    await host.settings.write(
      { configured: true, username: input.username },
      { username: input.username, password: input.password },
      request.authUser?.id ?? null
    );
    return { saved: true };
  });

  host.route("DELETE", "/api/ffe-licensing/settings", {}, async (request) => {
    void request;
    await host.settings.delete();
    return { deleted: true };
  });

  host.route("POST", "/api/ffe-licensing/members/:memberId/start-license", {
    rateLimit: { max: 20, timeWindow: "1 hour" }
  }, async (request, reply) => {
    const { memberId } = memberIdParamsSchema.parse(request.params);
    const season = currentSeason();

    const memberResult = await host.database.query<{
      firstName: string; lastName: string; birthDate: string | null; email: string | null;
    }>(
      `SELECT first_name AS "firstName", last_name AS "lastName", birth_date AS "birthDate", email FROM members WHERE id = $1`,
      [memberId]
    );
    const member = memberResult.rows[0];
    if (!member) return reply.code(404).send({ message: "Adhérent inconnu." });
    if (!member.birthDate) return reply.code(400).send({ message: "Date de naissance manquante pour cet adhérent : à compléter avant de prendre la licence." });

    const runResult = await host.database.query<{ id: string }>(
      `INSERT INTO ffe_automation_runs (member_id, season, status, step, started_by)
       VALUES ($1, $2, 'running', 'ensure-session', $3) RETURNING id`,
      [memberId, season, request.authUser?.id ?? null]
    );
    const runId = runResult.rows[0]!.id;

    try {
      await callBrowser(`/sessions/${CLUB_ID}/ensure`, { method: "POST" });
      let loginValid = (await callBrowser<{ valid: boolean }>(`/sessions/${CLUB_ID}/check-login`)).valid;

      if (!loginValid) {
        const stored = await host.settings.read<{ configured: boolean }, { username: string; password: string }>();
        if (stored?.secretValue) {
          loginValid = (await callBrowser<{ valid: boolean }>(`/sessions/${CLUB_ID}/login`, {
            method: "POST",
            body: JSON.stringify(stored.secretValue)
          })).valid;
        }
      }

      if (!loginValid) {
        await callBrowser(`/sessions/${CLUB_ID}/interactive-login/start`, { method: "POST" });
        await setRunStatus(host, runId, "awaiting_login", "login");
        return { runId, status: "awaiting_login" };
      }

      return await runSelectMember(host, runId, memberId, member, season);
    } catch (error) {
      await failRun(host, runId, error);
      throw error;
    }
  });

  // Déclenché par l'utilisateur une fois la connexion diffusée terminée en direct (voir
  // AccountScreen équivalent côté web) : reprend l'automatisation silencieuse là où elle
  // s'était arrêtée.
  host.route("POST", "/api/ffe-licensing/runs/:runId/resume-after-login", {}, async (request, reply) => {
    const { runId } = runIdParamsSchema.parse(request.params);
    const runResult = await host.database.query<{ memberId: string; season: string }>(
      `SELECT member_id AS "memberId", season FROM ffe_automation_runs WHERE id = $1`,
      [runId]
    );
    const run = runResult.rows[0];
    if (!run) return reply.code(404).send({ message: "Suivi introuvable." });

    const memberResult = await host.database.query<{
      firstName: string; lastName: string; birthDate: string | null; email: string | null;
    }>(
      `SELECT first_name AS "firstName", last_name AS "lastName", birth_date AS "birthDate", email FROM members WHERE id = $1`,
      [run.memberId]
    );
    const member = memberResult.rows[0];
    if (!member?.birthDate) return reply.code(400).send({ message: "Adhérent introuvable ou date de naissance manquante." });

    try {
      const loginValid = (await callBrowser<{ valid: boolean }>(`/sessions/${CLUB_ID}/check-login`)).valid;
      if (!loginValid) {
        return reply.code(409).send({ message: "La connexion FFE ne semble toujours pas active — réessayez de vous connecter." });
      }
      return await runSelectMember(host, runId, run.memberId, member, run.season);
    } catch (error) {
      await failRun(host, runId, error);
      throw error;
    }
  });

  host.route("POST", "/api/ffe-licensing/runs/:runId/confirm", {}, async (request, reply) => {
    const { runId } = runIdParamsSchema.parse(request.params);
    const runResult = await host.database.query<{ memberId: string; season: string }>(
      `SELECT member_id AS "memberId", season FROM ffe_automation_runs WHERE id = $1`,
      [runId]
    );
    const run = runResult.rows[0];
    if (!run) return reply.code(404).send({ message: "Suivi de prise de licence introuvable." });

    // La confirmation est déclarée par l'utilisateur lui-même (il vient de cliquer le vrai
    // bouton de validation sur le site FFE, dans la vue diffusée) : le contenu exact d'une
    // confirmation réussie côté FFE n'a pas encore été observé pendant la reconnaissance
    // (voir services/ffe-browser/spike-notes/) pour être détecté automatiquement de façon fiable.
    await host.database.query(
      `INSERT INTO ffe_licenses (member_id, season, status, taken_at, automation_run_id)
       VALUES ($1, $2, 'taken', now(), $3)
       ON CONFLICT (member_id, season) DO UPDATE SET status = 'taken', taken_at = now(), automation_run_id = $3, updated_at = now()`,
      [run.memberId, run.season, runId]
    );
    await setRunStatus(host, runId, "succeeded", "confirmed");
    await callBrowser(`/sessions/${CLUB_ID}/close`, { method: "POST" }).catch(() => undefined);
    return { confirmed: true };
  });

  host.route("POST", "/api/ffe-licensing/runs/:runId/cancel", {}, async (request) => {
    const { runId } = runIdParamsSchema.parse(request.params);
    await setRunStatus(host, runId, "abandoned", "cancelled");
    await callBrowser(`/sessions/${CLUB_ID}/close`, { method: "POST" }).catch(() => undefined);
    return { cancelled: true };
  });

  // Relais passe-plat vers le canal de diffusion de ffe-browser (connexion ou revue finale) —
  // jamais atteint directement par le navigateur de l'utilisateur, qui ne parle qu'à ce serveur.
  // WebSocket natif de Node (pas le paquet "ws") : un paquet d'extension ne doit dépendre que du
  // Node embarqué, jamais du node_modules de l'hôte — mais l'API native ne permet pas d'en-têtes
  // personnalisés sur une connexion sortante, d'où le jeton passé en paramètre de requête (voir
  // le commentaire correspondant dans services/ffe-browser/src/server.ts).
  host.core.remoteBrowserRelay?.registerStreamRoute("/api/ffe-licensing/relay", (socket) => {
    const upstream = new globalThis.WebSocket(
      `${ffeBrowserUrl.replace(/^http/, "ws")}/sessions/${CLUB_ID}/stream?token=${encodeURIComponent(ffeBrowserToken)}`
    );
    upstream.addEventListener("message", (event) => socket.send(String(event.data)));
    upstream.addEventListener("close", () => socket.close());
    upstream.addEventListener("error", () => socket.close());
    socket.on("message", (data) => {
      if (upstream.readyState === globalThis.WebSocket.OPEN) upstream.send(data.toString());
    });
    socket.on("close", () => upstream.close());
  });
}

async function runSelectMember(
  host: ExtensionServerHost,
  runId: string,
  memberId: string,
  member: { firstName: string; lastName: string; birthDate: string | null; email: string | null },
  season: string
) {
  void season;
  const factsResult = await host.database.query<{ inStructureLast5Seasons: boolean }>(
    `SELECT in_structure_last_5_seasons AS "inStructureLast5Seasons" FROM ffe_member_facts WHERE member_id = $1`,
    [memberId]
  );
  const inStructure = factsResult.rows[0]?.inStructureLast5Seasons ?? true;
  const { display: birthDateDisplay, year: birthYear } = formatBirthDateForFfe(member.birthDate!);

  const selectResult = await callBrowser<{ landed: string; matchedAdherentCode?: string; matchMode?: string; candidates?: unknown }>(
    `/sessions/${CLUB_ID}/automate/select-member`,
    {
      method: "POST",
      body: JSON.stringify({
        firstName: member.firstName,
        lastName: member.lastName,
        birthYear,
        inStructureLast5Seasons: inStructure,
        newPerson: { birthDateDisplay, ...(member.email ? { email: member.email } : {}) }
      })
    }
  );

  if (selectResult.landed === "ambiguous") {
    await setRunStatus(host, runId, "failed", "select-member", "Plusieurs correspondances possibles côté FFE : vérification manuelle nécessaire.");
    return { runId, status: "failed" as const, message: "Plusieurs correspondances possibles côté FFE — vérifiez manuellement sur le site." };
  }

  const matchedFfePersonId = selectResult.matchedAdherentCode ?? null;
  if (matchedFfePersonId) {
    await host.database.query(
      `INSERT INTO ffe_member_facts (member_id, known_in_ffe_database, ffe_person_id, updated_by)
       VALUES ($1, true, $2, NULL)
       ON CONFLICT (member_id) DO UPDATE SET known_in_ffe_database = true, ffe_person_id = $2, updated_at = now()`,
      [memberId, matchedFfePersonId]
    );
  }

  await setRunStatus(host, runId, "awaiting_confirmation", selectResult.landed);
  return { runId, status: "awaiting_confirmation" as const };
}

async function setRunStatus(host: ExtensionServerHost, runId: string, status: string, step: string, errorMessage: string | null = null) {
  await host.database.query(
    `UPDATE ffe_automation_runs SET
       status = $2, step = $3, error_message = $4,
       finished_at = CASE WHEN $2 IN ('succeeded', 'failed', 'abandoned') THEN now() ELSE finished_at END
     WHERE id = $1`,
    [runId, status, step, errorMessage]
  );
}

async function failRun(host: ExtensionServerHost, runId: string, error: unknown) {
  const message = error instanceof BrowserCallError ? error.message : error instanceof Error ? error.message : "Erreur inconnue.";
  await setRunStatus(host, runId, "failed", "error", message);
}
