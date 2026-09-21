import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent, type WheelEvent as ReactWheelEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./styles.css";

const EXTENSION_ID = "ffe-licensing";
const ELEMENT_NAME = "gu-ext-ffe-licensing";

type HostApi = Pick<GuWebHost, "request">;
type ViewPayload = { memberId: string } | null;

type MemberStatus = {
  season: string;
  facts: { knownInFfeDatabase: boolean | null; inStructureLast5Seasons: boolean };
  license: { status: "not_taken" | "in_progress" | "taken" | "failed"; takenAt: string | null };
};
type StartResult = { runId: string; status: "awaiting_login" | "awaiting_confirmation" | "failed"; message?: string };
type Settings = { configured: boolean; username: string | null };

function RemoteBrowserCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/ffe-licensing/relay`);
    wsRef.current = ws;
    ws.addEventListener("open", () => setConnected(true));
    ws.addEventListener("close", () => setConnected(false));
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; data?: string };
      if (message.type !== "frame" || !message.data) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const image = new Image();
      image.onload = () => {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext("2d")?.drawImage(image, 0, 0);
      };
      image.src = `data:image/jpeg;base64,${message.data}`;
    });
    return () => ws.close();
  }, []);

  function send(payload: unknown) {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(payload));
  }

  function coords(event: ReactMouseEvent<HTMLCanvasElement> | ReactWheelEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height)
    };
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLCanvasElement>) {
    event.preventDefault();
    send({ type: "key", kind: "keyDown", key: event.key, code: event.code });
    if (event.key.length === 1) send({ type: "key", kind: "char", key: event.key, code: event.code, text: event.key });
  }

  return (
    <div className="ffe-remote">
      {!connected && <p className="muted">Connexion au navigateur distant…</p>}
      <canvas
        ref={canvasRef}
        className="ffe-remote__canvas"
        tabIndex={0}
        onMouseDown={(event) => send({ type: "mouse", kind: "mousePressed", ...coords(event) })}
        onMouseUp={(event) => send({ type: "mouse", kind: "mouseReleased", ...coords(event) })}
        onMouseMove={(event) => send({ type: "mouse", kind: "mouseMoved", ...coords(event) })}
        onWheel={(event) => send({ type: "wheel", ...coords(event), deltaX: event.deltaX, deltaY: event.deltaY })}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => send({ type: "key", kind: "keyUp", key: event.key, code: event.code })}
      />
    </div>
  );
}

function MemberLicenseFlow({ host, memberId }: { host: HostApi; memberId: string }) {
  const [status, setStatus] = useState<MemberStatus | null>(null);
  const [run, setRun] = useState<StartResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    setStatus(await host.request<MemberStatus>(`/api/ffe-licensing/members/${memberId}`));
  }
  useEffect(() => { void reload(); }, [memberId]);

  async function saveFacts(inStructureLast5Seasons: boolean) {
    await host.request(`/api/ffe-licensing/members/${memberId}/facts`, {
      method: "PUT",
      body: JSON.stringify({ inStructureLast5Seasons })
    });
    await reload();
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setRun(await host.request<StartResult>(`/api/ffe-licensing/members/${memberId}/start-license`, { method: "POST" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Impossible de démarrer la prise de licence.");
    } finally {
      setBusy(false);
    }
  }

  async function resumeAfterLogin() {
    if (!run) return;
    setBusy(true);
    setError(null);
    try {
      setRun(await host.request<StartResult>(`/api/ffe-licensing/runs/${run.runId}/resume-after-login`, { method: "POST" }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "La connexion ne semble pas terminée.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!run) return;
    setBusy(true);
    setError(null);
    try {
      await host.request(`/api/ffe-licensing/runs/${run.runId}/confirm`, { method: "POST" });
      setRun(null);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Impossible d'enregistrer la confirmation.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!run) return;
    await host.request(`/api/ffe-licensing/runs/${run.runId}/cancel`, { method: "POST" }).catch(() => undefined);
    setRun(null);
  }

  if (!status) return <p className="muted">Chargement…</p>;

  return (
    <section className="ffe-member-flow">
      <h2>Licence FFE — saison {status.season}</h2>
      {error && <p className="error">{error}</p>}

      <div className="card">
        <label>
          <input
            type="checkbox"
            checked={status.facts.inStructureLast5Seasons}
            onChange={(event) => void saveFacts(event.target.checked)}
            disabled={busy}
          />
          Présent au club au moins une saison sur les 5 dernières
        </label>
        <p className="muted">
          Statut : <strong>{licenseStatusLabel(status.license.status)}</strong>
          {status.license.takenAt && ` (le ${new Date(status.license.takenAt).toLocaleDateString("fr-FR")})`}
        </p>
      </div>

      {!run && status.license.status !== "taken" && (
        <button type="button" onClick={() => void start()} disabled={busy}>
          {busy ? "Démarrage…" : "Prendre la licence"}
        </button>
      )}

      {run?.status === "awaiting_login" && (
        <div className="card">
          <p>Connectez-vous sur le site FFE ci-dessous, puis cliquez sur « J'ai terminé la connexion ».</p>
          <RemoteBrowserCanvas />
          <div className="ffe-actions">
            <button type="button" onClick={() => void resumeAfterLogin()} disabled={busy}>
              {busy ? "Vérification…" : "J'ai terminé la connexion"}
            </button>
            <button type="button" className="secondary" onClick={() => void cancel()} disabled={busy}>
              Annuler
            </button>
          </div>
        </div>
      )}

      {run?.status === "awaiting_confirmation" && (
        <div className="card">
          <p>Vérifiez les informations et validez vous-même sur le site FFE, puis confirmez ici.</p>
          <RemoteBrowserCanvas />
          <div className="ffe-actions">
            <button type="button" onClick={() => void confirm()} disabled={busy}>
              {busy ? "Enregistrement…" : "J'ai confirmé sur le site FFE"}
            </button>
            <button type="button" className="secondary" onClick={() => void cancel()} disabled={busy}>
              Annuler
            </button>
          </div>
        </div>
      )}

      {run?.status === "failed" && <p className="error">{run.message ?? "La prise de licence a échoué."}</p>}
    </section>
  );
}

function SettingsScreen({ host }: { host: HostApi }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => { void host.request<Settings>("/api/ffe-licensing/settings").then(setSettings); }, []);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      await host.request("/api/ffe-licensing/settings", { method: "PUT", body: JSON.stringify({ username, password }) });
      setPassword("");
      setSettings(await host.request<Settings>("/api/ffe-licensing/settings"));
      setMessage("Identifiants enregistrés.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Échec de l'enregistrement.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="ffe-settings">
      <h2>Licences FFE — identifiants</h2>
      <p className="muted">
        Optionnel : si renseignés, ils sont utilisés pour se connecter automatiquement à
        dirigeant.escrime-ffe.fr. Sinon, la connexion se fait en direct à chaque fois.
      </p>
      {settings?.configured && <p className="muted">Identifiants déjà enregistrés pour « {settings.username} ».</p>}
      {message && <p>{message}</p>}
      <label>
        Identifiant FFE
        <input value={username} onChange={(event) => setUsername(event.target.value)} />
      </label>
      <label>
        Mot de passe
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      <button type="button" onClick={() => void save()} disabled={saving || !username || !password}>
        {saving ? "Enregistrement…" : "Enregistrer"}
      </button>
      <p className="muted">Pour prendre une licence, ouvrez la fiche d'un adhérent puis « Prendre la licence FFE ».</p>
    </section>
  );
}

function licenseStatusLabel(status: MemberStatus["license"]["status"]) {
  switch (status) {
    case "taken": return "Prise";
    case "in_progress": return "En cours";
    case "failed": return "Échec, à réessayer";
    default: return "Non prise";
  }
}

const COLUMN_ELEMENT_NAME = "gu-ext-ffe-licensing-column";

function LicenseBadge({ host, memberId }: { host: HostApi; memberId: string }) {
  const [status, setStatus] = useState<MemberStatus["license"]["status"] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void host.request<MemberStatus>(`/api/ffe-licensing/members/${memberId}`).then((result) => {
      if (!cancelled) setStatus(result.license.status);
    });
    return () => { cancelled = true; };
  }, [memberId]);
  if (!status) return <span className="muted">…</span>;
  return <span className={`ffe-badge ffe-badge--${status}`}>{licenseStatusLabel(status)}</span>;
}

class FfeLicensingColumnElement extends HTMLElement {
  hostApi?: HostApi;
  member?: { id: string };
  private root: Root | null = null;

  connectedCallback() {
    if (!this.hostApi || !this.member) return;
    this.root = createRoot(this);
    this.root.render(<LicenseBadge host={this.hostApi} memberId={this.member.id} />);
  }

  disconnectedCallback() {
    const root = this.root;
    this.root = null;
    queueMicrotask(() => root?.unmount());
  }
}
if (!customElements.get(COLUMN_ELEMENT_NAME)) customElements.define(COLUMN_ELEMENT_NAME, FfeLicensingColumnElement);
window.__GU_HOST__?.registerMemberColumn({
  extensionId: EXTENSION_ID,
  key: "ffe-license-status",
  label: "Licence FFE",
  element: COLUMN_ELEMENT_NAME,
  // Recherche textuelle non supportée ici : le statut est chargé de façon asynchrone par
  // adhérent (pas de donnée noyau à filtrer de façon synchrone).
  filterValue: () => ""
});

class FfeLicensingElement extends HTMLElement {
  hostApi?: HostApi;
  viewPayload?: ViewPayload;
  private root: Root | null = null;

  connectedCallback() {
    if (!this.hostApi) throw new Error("hostApi n'a pas été fourni à l'élément du module.");
    this.root = createRoot(this);
    const payload = this.viewPayload ?? null;
    this.root.render(
      payload?.memberId
        ? <MemberLicenseFlow host={this.hostApi} memberId={payload.memberId} />
        : <SettingsScreen host={this.hostApi} />
    );
  }

  disconnectedCallback() {
    const root = this.root;
    this.root = null;
    queueMicrotask(() => root?.unmount());
  }
}

if (!customElements.get(ELEMENT_NAME)) customElements.define(ELEMENT_NAME, FfeLicensingElement);
window.__GU_HOST__?.registerView({ extensionId: EXTENSION_ID, label: "Licences FFE", element: ELEMENT_NAME });
window.__GU_HOST__?.registerMemberAction({
  extensionId: EXTENSION_ID,
  label: "Prendre la licence FFE",
  payloadFor: (member) => ({ memberId: member.id })
});
