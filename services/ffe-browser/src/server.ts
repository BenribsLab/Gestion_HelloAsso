import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { SessionManager } from "./sessions.js";
import { attachScreencastRelay } from "./automation/relay.js";
import { fillNewPersonForm, goToLogin, selectPerson } from "./automation/steps.js";

const config = loadConfig();
const sessions = new SessionManager(config);
await sessions.start();

const server = Fastify({ logger: true, bodyLimit: 16 * 1024 });
await server.register(websocket);

server.addHook("onSend", async (_request, reply) => {
  reply.header("Cache-Control", "no-store");
});

// Seul apps/api (sur le réseau interne) parle à ce service — jamais exposé publiquement, jamais
// sur le réseau frontend. Le secret partagé est la seule défense en profondeur nécessaire ici,
// pas une authentification par utilisateur final.
server.addHook("preHandler", async (request, reply) => {
  if (request.url.startsWith("/health")) return;
  // Repli par paramètre de requête, uniquement pour la route de diffusion WebSocket : le
  // `WebSocket` natif de Node (utilisé côté extension pour rester autonome, sans dépendance
  // externe à bundler) ne permet pas de personnaliser les en-têtes d'une connexion sortante.
  // Compromis assumé : ce jeton apparaît alors en clair dans les journaux de ce conteneur —
  // acceptable ici puisque ce service n'est jamais exposé au-delà du réseau interne, et que
  // quiconque a accès à ces journaux a de toute façon accès au secret réel (même .env).
  const isStreamRoute = request.url.startsWith("/sessions/") && request.url.includes("/stream");
  const headerToken = request.headers["x-ffe-browser-token"];
  const queryToken = isStreamRoute ? (request.query as Record<string, unknown>)?.token : undefined;
  const supplied = typeof headerToken === "string" ? headerToken : typeof queryToken === "string" ? queryToken : undefined;
  if (!supplied || supplied.length !== config.internalToken.length || supplied !== config.internalToken) {
    return reply.code(401).send({ message: "Jeton interne absent ou invalide." });
  }
});

server.setErrorHandler((error, request, reply) => {
  if (error instanceof z.ZodError) return reply.code(400).send({ message: "Données invalides." });
  request.log.error(error);
  return reply.code(500).send({ message: error instanceof Error ? error.message.slice(0, 1000) : "Erreur interne." });
});

const clubIdParamsSchema = z.object({ clubId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) });
const loginSchema = z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(200) });
const selectMemberSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  birthYear: z.number().int().min(1900).max(2100),
  licensePath: z.enum(["renewal", "transfer", "new"]),
  // Utilisé uniquement si aucune correspondance n'est trouvée (bascule "+ Ajout d'une nouvelle
  // personne") : pré-remplissage au mieux, le reste est laissé à l'utilisateur (voir steps.ts).
  newPerson: z.object({
    birthDateDisplay: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/),
    email: z.string().email().optional(),
    phone: z.string().max(30).optional(),
    mobile: z.string().max(30).optional(),
    address: z.object({
      numero: z.string().max(20).optional(),
      nomVoie: z.string().max(200).optional(),
      codePostal: z.string().max(10).optional(),
      commune: z.string().max(200).optional()
    }).optional()
  }).optional()
});

server.get("/health", async () => ({ status: "ok" }));

server.post("/sessions/:clubId/ensure", async (request) => {
  const { clubId } = clubIdParamsSchema.parse(request.params);
  await sessions.ensureContext(clubId);
  return { clubId };
});

server.get("/sessions/:clubId/check-login", async (request) => {
  const { clubId } = clubIdParamsSchema.parse(request.params);
  return sessions.checkLogin(clubId);
});

server.post("/sessions/:clubId/login", async (request) => {
  const { clubId } = clubIdParamsSchema.parse(request.params);
  const input = loginSchema.parse(request.body);
  return sessions.loginWithCredentials(clubId, input.username, input.password);
});

// Prépare la page interactive sur l'écran de connexion, pour le repli diffusé lorsque la
// connexion silencieuse (avec ou sans identifiants stockés) a échoué.
server.post("/sessions/:clubId/interactive-login/start", async (request) => {
  const { clubId } = clubIdParamsSchema.parse(request.params);
  const page = await sessions.getInteractivePage(clubId);
  await goToLogin(page, config.ffeBaseUrl);
  return { started: true };
});

server.post("/sessions/:clubId/automate/select-member", async (request, reply) => {
  const { clubId } = clubIdParamsSchema.parse(request.params);
  const input = selectMemberSchema.parse(request.body);
  const page = await sessions.getInteractivePage(clubId);

  const result = await selectPerson(page, config.ffeBaseUrl, input);

  if (result.landed === "ambiguous") {
    return reply.code(409).send({
      message: "Plusieurs correspondances possibles, aucune ne peut être choisie automatiquement.",
      candidates: result.candidates
    });
  }

  if (result.landed === "etape-2-ajout" && input.newPerson) {
    await fillNewPersonForm(page, {
      firstName: input.firstName,
      lastName: input.lastName,
      birthDateDisplay: input.newPerson.birthDateDisplay,
      email: input.newPerson.email,
      phone: input.newPerson.phone,
      mobile: input.newPerson.mobile,
      address: input.newPerson.address
    });
  }

  return result.landed === "etape-2"
    ? { landed: result.landed, matchedAdherentCode: result.match.adherentCode, matchMode: result.mode }
    : { landed: result.landed };
});

// Vérification légère : l'appelant (l'extension) décide du sens exact du résultat (URL/état
// attendu selon l'étape) — ce service se contente de renvoyer l'état brut de la page interactive,
// sans logique métier sur ce qu'est une "confirmation réussie" (jamais observé pendant la
// reconnaissance, voir spike-notes/).
server.get("/sessions/:clubId/page-state", async (request, reply) => {
  const { clubId } = clubIdParamsSchema.parse(request.params);
  if (!sessions.hasInteractivePage(clubId)) return reply.code(404).send({ message: "Aucune page interactive active." });
  const page = await sessions.getInteractivePage(clubId);
  return { url: page.url() };
});

server.post("/sessions/:clubId/close", async (request) => {
  const { clubId } = clubIdParamsSchema.parse(request.params);
  await sessions.closeInteractivePage(clubId);
  await sessions.closeContext(clubId);
  return { closed: true };
});

// Diffusion écran + relais clics/clavier vers la page interactive du club (connexion ou revue
// finale). apps/api s'y connecte en passe-plat depuis le canal WebSocket exposé à l'extension —
// jamais atteint directement par le navigateur de l'utilisateur.
server.get("/sessions/:clubId/stream", { websocket: true }, async (socket, request) => {
  const parsed = clubIdParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    socket.close(1008, "Identifiant de club invalide.");
    return;
  }
  try {
    const page = await sessions.getInteractivePage(parsed.data.clubId);
    await attachScreencastRelay(page, socket);
  } catch (error) {
    request.log.error(error, "Impossible d'attacher le relais de diffusion.");
    socket.close(1011, "Relais indisponible.");
  }
});

const shutdown = async () => {
  await sessions.stop();
  await server.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

try {
  await server.listen({ host: "0.0.0.0", port: config.port });
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
