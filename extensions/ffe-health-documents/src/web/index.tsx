import { type FormEvent, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./styles.css";

type HostApi = Pick<GuWebHost, "request" | "requestBlob">;

type Group = { id: string; name: string; membersCount: number };
type Config = {
  fields: Array<{ key: string; label: string; health: boolean; availableCount: number; newCount: number }>;
  identitySource: "member" | "payer";
  template: string;
  documentSelection: "new" | "all";
};
type Progress = {
  exportId: string;
  status: "running" | "ready" | "failed";
  total: number;
  processed: number;
  certificateCount: number;
  attestationCount: number;
  questionnaireCount: number;
  unknownCount: number;
  error: string | null;
};
type DocumentInfo = {
  available: boolean;
  health: boolean;
  classification: "certificate" | "attestation" | "questionnaire" | "unknown";
  classificationSource: "automatic" | "manual";
};
type MemberSubject = { id: string; customFields: Array<{ key: string; document?: DocumentInfo }> };
type DocumentField = { key: string; document?: DocumentInfo };

function healthState(member: MemberSubject) {
  const configured = member.customFields.map((field) => field.document).filter((document) => document?.health);
  const available = configured.filter((document) => document?.available);
  if (available.some((document) => document?.classification === "certificate")) return { label: "Certificat", tone: "valid" };
  if (available.some((document) => document?.classification === "attestation")) return { label: "Attestation", tone: "valid" };
  if (available.some((document) => document?.classification === "questionnaire")) return { label: "Questionnaire à remplacer", tone: "warning" };
  if (available.length > 0) return { label: "Document à classer", tone: "unknown" };
  return { label: configured.length > 0 ? "Non fourni" : "Non configuré", tone: "missing" };
}

function HealthBadge({ member }: { member: MemberSubject }) {
  const state = healthState(member);
  return <span className={`health-document-badge ${state.tone}`}>{state.label}</span>;
}

function HealthClassifier({ host, member, field, changed }: {
  host: HostApi; member: MemberSubject; field: DocumentField; changed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const document = field.document;
  if (!document?.health || !document.available) return null;
  async function classify(classification: DocumentInfo["classification"]) {
    setBusy(true); setError(null);
    try {
      await host.request(`/api/members/${member.id}/documents/${encodeURIComponent(field.key)}/classification`, {
        method: "PUT", body: JSON.stringify({ classification })
      });
      changed();
    } catch (reason) { setError(message(reason, "Classement impossible.")); }
    finally { setBusy(false); }
  }
  return <>
    <div className="field-label-row"><span className="document-role">Document santé</span></div>
    <label className={`document-classification ${document.classification === "questionnaire" ? "document-warning" : ""}`}>Type reconnu<select disabled={busy} value={document.classification} onChange={(event) => void classify(event.target.value as DocumentInfo["classification"])}><option value="unknown">À classer</option><option value="certificate">Certificat médical</option><option value="attestation">Attestation de santé valide</option><option value="questionnaire">Erreur : questionnaire fourni à la place de l’attestation</option></select><small>{document.classification === "questionnaire" ? "Le questionnaire contient des données de santé et ne remplace pas l’attestation demandée." : document.classificationSource === "manual" ? "Classement corrigé manuellement" : "Reconnaissance automatique, modifiable"}</small></label>
    {error && <small className="field-error">{error}</small>}
  </>;
}

function Documents({ host }: { host: HostApi }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [fieldKey, setFieldKey] = useState("");
  const [scope, setScope] = useState<"all" | "groups">("all");
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set());
  const [documentSelection, setDocumentSelection] = useState<"new" | "all">("all");
  const [reanalyze, setReanalyze] = useState(false);
  const [identitySource, setIdentitySource] = useState<"member" | "payer">("member");
  const [template, setTemplate] = useState("{nom}-{prenom} - {type_document}");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [result, groupResult] = await Promise.all([
      host.request<Config>("/api/documents/config"),
      host.request<{ items: Group[] }>("/api/groups")
    ]);
    setConfig(result);
    setGroups(groupResult.items);
    setFieldKey(result.fields[0]?.key ?? "");
    setIdentitySource(result.identitySource);
    setTemplate(result.template);
    setDocumentSelection(result.documentSelection);
  }

  useEffect(() => { void load().catch((reason: unknown) => setError(message(reason, "Configuration indisponible."))); }, []);

  async function download(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null); setProgress(null);
    try {
      const started = await host.request<{ exportId: string }>("/api/documents/exports", {
        method: "POST",
        body: JSON.stringify({ fieldKey, scope, groupIds: [...groupIds], identitySource, template, documentSelection, reanalyze })
      });
      let current: Progress;
      do {
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        current = await host.request<Progress>(`/api/documents/exports/${started.exportId}`);
        setProgress(current);
        if (current.status === "failed") throw new Error(current.error ?? "La préparation de l'archive a échoué.");
      } while (current.status !== "ready");
      const result = await host.requestBlob(`/api/documents/exports/${started.exportId}/download`);
      const url = URL.createObjectURL(result.blob);
      const link = window.document.createElement("a");
      link.href = url; link.download = result.fileName ?? "documents.zip"; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      await load();
    } catch (reason) {
      setError(message(reason, "Impossible de créer l'archive."));
    } finally { setBusy(false); }
  }

  if (!config) return <section className="panel"><p>{error ?? "Chargement des documents…"}</p></section>;
  return <div className="documents-page">
    {error && <div className="alert error">{error}</div>}
    <section className="panel">
      <div className="section-heading"><div><p className="eyebrow">Fichiers des adhérents</p><h2>Télécharger les documents</h2><p className="muted">Les images sont converties en PDF. L’archive contient aussi un rapport des fichiers absents ou inaccessibles.</p></div></div>
      {config.fields.length === 0 ? <EmptyState /> : <form className="document-export-form" onSubmit={(event) => void download(event)}>
        <label>Document à exporter<select required value={fieldKey} onChange={(event) => setFieldKey(event.target.value)}>{config.fields.map((field) => <option key={field.key} value={field.key}>{field.label} · {field.availableCount} fichier{field.availableCount > 1 ? "s" : ""} · {field.newCount} nouveau{field.newCount !== 1 ? "x" : ""}{field.health ? " · santé" : ""}</option>)}</select></label>
        <fieldset><legend>Adhérents concernés</legend><label className="radio-line"><input type="radio" checked={scope === "all"} onChange={() => setScope("all")} /> Tous les adhérents actifs</label><label className="radio-line"><input type="radio" checked={scope === "groups"} onChange={() => setScope("groups")} /> Un ou plusieurs groupes</label>{scope === "groups" && <div className="group-checkboxes">{groups.map((group) => <label key={group.id}><input type="checkbox" checked={groupIds.has(group.id)} onChange={() => setGroupIds((current) => toggledSet(current, group.id))} /><span>{group.name} <small>({group.membersCount})</small></span></label>)}</div>}</fieldset>
        <fieldset><legend>Fichiers à inclure</legend><label className="radio-line"><input type="radio" checked={documentSelection === "new" && !reanalyze} onChange={() => { setDocumentSelection("new"); setReanalyze(false); }} /> Seulement les nouveaux fichiers jamais exportés</label><label className="radio-line"><input type="radio" checked={documentSelection === "all" && !reanalyze} onChange={() => { setDocumentSelection("all"); setReanalyze(false); }} /> Tous les fichiers, sans recommencer les reconnaissances déjà faites</label><label className="radio-line reanalyze-option"><input type="checkbox" checked={reanalyze} onChange={(event) => { setReanalyze(event.target.checked); if (event.target.checked) setDocumentSelection("all"); }} /> Tout retraiter avec l’OCR <small>(les corrections manuelles sont conservées)</small></label></fieldset>
        <div className="document-naming"><label>Nom utilisé<select value={identitySource} onChange={(event) => setIdentitySource(event.target.value as "member" | "payer")}><option value="member">Nom de l’adhérent</option><option value="payer">Nom du payeur (sinon adhérent)</option></select></label><label>Nomenclature<input required value={template} onChange={(event) => setTemplate(event.target.value)} /><small>Variables : {"{nom}"}, {"{prenom}"}, {"{type_document}"}. L’extension .pdf est ajoutée automatiquement.</small></label></div>
        <div className="document-name-example">Exemple : <strong>{template.replaceAll("{nom}", "BONNARDEL").replaceAll("{prenom}", "Noah").replaceAll("{type_document}", "certificat")}.pdf</strong></div>
        {progress && <div className="document-export-progress" aria-live="polite"><div><strong>{progress.total > 0 ? `Documents traités : ${progress.processed} / ${progress.total}` : progress.status === "ready" ? "Aucun nouveau document à exporter" : "Recherche des documents…"}</strong><span>{progress.status === "ready" ? "Archive prête" : "Reconnaissance et préparation en cours"}</span></div><progress max={Math.max(1, progress.total)} value={progress.processed} /><div className="recognition-counts"><span>{progress.certificateCount} certificat{progress.certificateCount > 1 ? "s" : ""}</span><span>{progress.attestationCount} attestation{progress.attestationCount > 1 ? "s" : ""}</span>{progress.questionnaireCount > 0 && <span className="warning-count">{progress.questionnaireCount} questionnaire{progress.questionnaireCount > 1 ? "s" : ""} à remplacer</span>}<span>{progress.unknownCount} à classer</span></div></div>}
        <div className="editor-actions"><button className="primary" type="submit" disabled={busy || !fieldKey || !template.trim() || (scope === "groups" && groupIds.size === 0)}>{busy ? progress?.total ? `${progress.processed} / ${progress.total}…` : "Préparation…" : "Télécharger l’archive ZIP"}</button></div>
      </form>}
    </section>
  </div>;
}

function EmptyState() {
  return <div className="empty-state"><div className="empty-icon">+</div><h3>Aucun champ document</h3><p>Dans Configuration, sélectionnez d’abord un champ HelloAsso de type Document.</p></div>;
}

function toggledSet(current: Set<string>, value: string) {
  const next = new Set(current);
  if (next.has(value)) next.delete(value); else next.add(value);
  return next;
}

function message(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

class HealthDocumentsElement extends HTMLElement {
  private root: Root | null = null;
  hostApi?: HostApi;
  connectedCallback() {
    if (!this.hostApi) throw new Error("hostApi n'a pas été fourni à l'élément du module.");
    this.root ??= createRoot(this);
    this.root.render(<Documents host={this.hostApi} />);
  }
  disconnectedCallback() { window.setTimeout(() => { if (!this.isConnected) { this.root?.unmount(); this.root = null; } }, 0); }
}

class HealthBadgeElement extends HTMLElement {
  private root: Root | null = null;
  member?: MemberSubject;
  connectedCallback() {
    if (!this.member) return;
    this.root ??= createRoot(this); this.root.render(<HealthBadge member={this.member} />);
  }
  disconnectedCallback() { window.setTimeout(() => { if (!this.isConnected) { this.root?.unmount(); this.root = null; } }, 0); }
}

class HealthClassifierElement extends HTMLElement {
  private root: Root | null = null;
  hostApi?: HostApi;
  member?: MemberSubject;
  field?: DocumentField;
  connectedCallback() {
    if (!this.hostApi || !this.member || !this.field) return;
    this.root ??= createRoot(this);
    this.root.render(<HealthClassifier host={this.hostApi} member={this.member} field={this.field} changed={() => this.dispatchEvent(new CustomEvent("gu:data-changed", { bubbles: true }))} />);
  }
  disconnectedCallback() { window.setTimeout(() => { if (!this.isConnected) { this.root?.unmount(); this.root = null; } }, 0); }
}

if (!customElements.get("gu-ext-health-documents")) {
  customElements.define("gu-ext-health-documents", HealthDocumentsElement);
}
if (!customElements.get("gu-ext-health-badge")) customElements.define("gu-ext-health-badge", HealthBadgeElement);
if (!customElements.get("gu-ext-health-classifier")) customElements.define("gu-ext-health-classifier", HealthClassifierElement);
window.__GU_HOST__?.registerView({ extensionId: "ffe-health-documents", label: "Documents", element: "gu-ext-health-documents" });
window.__GU_HOST__?.registerMemberColumn({
  extensionId: "ffe-health-documents",
  key: "health-document",
  label: "Document santé",
  element: "gu-ext-health-badge",
  filterValue: (member) => healthState(member as unknown as MemberSubject).label
});
window.__GU_HOST__?.registerDocumentPanel({ extensionId: "ffe-health-documents", element: "gu-ext-health-classifier" });
