import { type FormEvent, useCallback, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./styles.css";

type HostApi = {
  request<T>(path: string, init?: RequestInit): Promise<T>;
};


type EmailTarget =
  | { type: "all" }
  | { type: "groups"; groupIds: string[] }
  | { type: "single"; email: string };

type EmailStatus = {
  configured: boolean;
  host: string;
  port: number;
  secure: boolean;
  fromEmail: string | null;
  fromName: string;
  replyTo: string | null;
};

type EmailMessageHistory = {
  id: string;
  subject: string;
  targetLabel: string;
  status: "sending" | "sent" | "partial" | "failed";
  recipientsCount: number;
  sentCount: number;
  failedCount: number;
  createdAt: string;
  finishedAt: string | null;
};

type Group = { id: string; name: string; membersCount: number };
type Recipient = { email: string; name: string };

const EXTENSION_ID = "email-messaging";
const ELEMENT_NAME = "gu-ext-email-messaging";

function toggled(current: Set<string>, value: string) {
  const next = new Set(current);
  if (next.has(value)) next.delete(value); else next.add(value);
  return next;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" })
    .format(new Date(value));
}

function targetForSelection(type: EmailTarget["type"], selectedGroups: Set<string>, testEmail: string): EmailTarget | null {
  if (type === "all") return { type: "all" };
  if (type === "groups") return selectedGroups.size > 0 ? { type: "groups", groupIds: [...selectedGroups] } : null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail.trim()) ? { type: "single", email: testEmail.trim() } : null;
}

function Messages({ host, recipient, onChanged }: {
  host: HostApi;
  recipient: Recipient | null;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [history, setHistory] = useState<EmailMessageHistory[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [targetType, setTargetType] = useState<EmailTarget["type"]>("single");
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [testEmail, setTestEmail] = useState(recipient?.email ?? "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<{ targetLabel: string; membersCount: number; recipientsCount: number; withoutEmailCount: number } | null>(null);
  const [busy, setBusy] = useState<"verify" | "send" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedGroupsKey = [...selectedGroups].sort().join(",");

  const loadMailData = useCallback(async () => {
    try {
      const [statusResult, historyResult, groupsResult] = await Promise.all([
        host.request<EmailStatus>("/api/email/status"),
        host.request<{ items: EmailMessageHistory[] }>("/api/email/messages"),
        host.request<{ items: Group[] }>("/api/groups")
      ]);
      setStatus(statusResult);
      setHistory(historyResult.items);
      setGroups(groupsResult.items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible de charger la messagerie.");
    }
  }, [host]);

  useEffect(() => { void loadMailData(); }, [loadMailData]);

  useEffect(() => {
    const target = targetForSelection(targetType, selectedGroups, testEmail);
    setPreview(null);
    if (!target) return;
    const timeout = window.setTimeout(() => {
      void host.request<typeof preview>("/api/email/recipients-preview", {
        method: "POST",
        body: JSON.stringify(target)
      })
        .then(setPreview)
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Destinataires indisponibles."));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [host, targetType, selectedGroupsKey, testEmail]);

  async function verify() {
    setBusy("verify"); setError(null); setMessage(null);
    try {
      await host.request("/api/email/verify", { method: "POST" });
      setMessage("Connexion SMTP réussie. Aucun message n'a été envoyé.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Connexion SMTP impossible.");
    } finally { setBusy(null); }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const target = targetForSelection(targetType, selectedGroups, testEmail);
    if (!target || !preview) return;
    const plural = preview.recipientsCount > 1 ? "s" : "";
    if (!window.confirm(`Envoyer « ${subject.trim()} » à ${preview.recipientsCount} adresse${plural} unique${plural} ?\n\nChaque destinataire recevra un message individuel.`)) return;
    setBusy("send"); setError(null); setMessage(null);
    try {
      const result = await host.request<{ sentCount: number; failedCount: number }>("/api/email/messages", {
        method: "POST",
        body: JSON.stringify({ subject: subject.trim(), body: body.trim(), target })
      });
      setMessage(`${result.sentCount} message${result.sentCount > 1 ? "s" : ""} envoyé${result.sentCount > 1 ? "s" : ""}${result.failedCount ? ` · ${result.failedCount} échec${result.failedCount > 1 ? "s" : ""}` : ""}.`);
      if (result.sentCount > 0) { setSubject(""); setBody(""); }
      await loadMailData();
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "L'envoi a échoué.");
      await loadMailData();
    } finally { setBusy(null); }
  }

  return <div className="messages-page">
    {error && <div className="alert error">{error}</div>}
    {message && <div className="alert success">{message}</div>}
    <section className={`panel smtp-status ${status?.configured ? "configured" : ""}`}>
      <div><p className="eyebrow">Serveur d'envoi</p><h2>{status?.configured ? "SMTP configuré" : "SMTP à configurer"}</h2>{status && <p className="muted">{status.host}:{status.port} · {status.secure ? "TLS direct" : "STARTTLS"}{status.fromEmail ? ` · ${status.fromName} <${status.fromEmail}>` : ""}</p>}</div>
      <button className="secondary" type="button" disabled={!status?.configured || busy !== null} onClick={() => void verify()}>{busy === "verify" ? "Vérification…" : "Vérifier la connexion"}</button>
    </section>

    <section className="panel message-composer">
      <div><p className="eyebrow">Nouveau message</p><h2>Rédiger et envoyer</h2><p className="muted">Les adresses sont dédupliquées et ne sont jamais visibles par les autres destinataires.</p>{recipient && <p className="direct-recipient">Message destiné à <strong>{recipient.name}</strong> · {recipient.email}</p>}</div>
      <form onSubmit={send}>
        <fieldset className="message-targets"><legend>Destinataires</legend><div className="target-mode">
          <label><input type="radio" name="target" checked={targetType === "single"} onChange={() => setTargetType("single")} /> Destinataire unique / test</label>
          <label><input type="radio" name="target" checked={targetType === "groups"} onChange={() => setTargetType("groups")} /> Un ou plusieurs groupes</label>
          <label><input type="radio" name="target" checked={targetType === "all"} onChange={() => setTargetType("all")} /> Tous les adhérents</label>
        </div></fieldset>
        {targetType === "single" && <label>Adresse du destinataire<input type="email" required value={testEmail} onChange={(event) => setTestEmail(event.target.value)} placeholder="destinataire@exemple.fr" /></label>}
        {targetType === "groups" && <div><strong>Groupes à inclure</strong><div className="group-checkboxes">{groups.map((group) => <label key={group.id}><input type="checkbox" checked={selectedGroups.has(group.id)} onChange={() => setSelectedGroups((current) => toggled(current, group.id))} /><span>{group.name}<small>{group.membersCount} adhérent(s)</small></span></label>)}</div></div>}
        {preview && <div className="recipient-preview"><strong>{preview.recipientsCount} adresse{preview.recipientsCount > 1 ? "s" : ""} unique{preview.recipientsCount > 1 ? "s" : ""}</strong><span>{preview.membersCount} adhérent{preview.membersCount > 1 ? "s" : ""}{preview.withoutEmailCount > 0 ? ` · ${preview.withoutEmailCount} sans adresse valide` : ""}</span></div>}
        <label>Objet<input required maxLength={200} value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Objet du message" /></label>
        <label>Message<textarea required maxLength={50_000} rows={12} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Votre message…" /></label>
        <div className="editor-actions"><button className="primary" type="submit" disabled={!status?.configured || busy !== null || !preview || preview.recipientsCount === 0 || !subject.trim() || !body.trim()}>{busy === "send" ? "Envoi en cours…" : "Vérifier et envoyer"}</button></div>
      </form>
    </section>

    <section className="panel message-history">
      <div className="section-heading"><div><p className="eyebrow">Journal local</p><h2>Derniers envois</h2></div><span className="count-pill">{history.length}</span></div>
      {history.length === 0 ? <p className="empty-inline">Aucun message envoyé pour le moment.</p> : <div className="table-wrap"><table><thead><tr><th>Date</th><th>Objet</th><th>Destinataires</th><th>Résultat</th></tr></thead><tbody>{history.map((entry) => <tr key={entry.id}><td>{formatDateTime(entry.createdAt)}</td><td><strong>{entry.subject}</strong></td><td>{entry.targetLabel}<small className="member-contact">{entry.recipientsCount} adresse{entry.recipientsCount > 1 ? "s" : ""}</small></td><td><HistoryStatus entry={entry} /></td></tr>)}</tbody></table></div>}
    </section>
  </div>;
}

function HistoryStatus({ entry }: { entry: EmailMessageHistory }) {
  const label = entry.status === "sent" ? "Envoyé" : entry.status === "partial" ? "Partiel" : entry.status === "failed" ? "Échec" : "En cours";
  return <span className={`email-status ${entry.status}`}>{label} · {entry.sentCount}/{entry.recipientsCount}{entry.failedCount > 0 ? ` · ${entry.failedCount} échec${entry.failedCount > 1 ? "s" : ""}` : ""}</span>;
}

class EmailMessagingElement extends HTMLElement {
  hostApi?: HostApi;
  viewPayload?: unknown;
  private root: Root | null = null;

  connectedCallback() {
    if (!this.hostApi) throw new Error("hostApi n'a pas été fourni à l'élément du module.");
    const payload = this.viewPayload as Recipient | null;
    this.root = createRoot(this);
    this.root.render(
      <Messages
        host={this.hostApi}
        recipient={payload && typeof payload.email === "string" ? payload : null}
        onChanged={() => this.dispatchEvent(new CustomEvent("gu:data-changed", { bubbles: true }))}
      />
    );
  }

  disconnectedCallback() {
    const root = this.root;
    this.root = null;
    queueMicrotask(() => root?.unmount());
  }
}

if (!customElements.get(ELEMENT_NAME)) {
  customElements.define(ELEMENT_NAME, EmailMessagingElement);
}

window.__GU_HOST__?.registerView({
  extensionId: EXTENSION_ID,
  label: "Messages",
  element: ELEMENT_NAME
});

window.__GU_HOST__?.registerMemberAction({
  extensionId: EXTENSION_ID,
  label: "✉ Envoyer un message",
  payloadFor: (member) => member.email
    ? { email: member.email, name: `${member.firstName} ${member.lastName}` }
    : null
});
