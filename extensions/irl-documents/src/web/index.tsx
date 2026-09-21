import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./styles.css";

type HostApi = Pick<GuWebHost, "request" | "requestBlob">;
type Target =
  | { type: "all" }
  | { type: "healthMissing" }
  | { type: "groups"; groupIds: string[] }
  | { type: "categories"; categories: string[] }
  | { type: "members"; memberIds: string[] };
type Variable = { token: string; label: string; source: "member" | "additional" };
type Template = {
  id: string; name: string; documentTitle: string; contentHtml: string;
  output: "individual" | "combined"; createdAt: string; updatedAt: string;
};
type DocumentInfo = {
  available: boolean;
  classification: "certificate" | "attestation" | "questionnaire" | "unknown";
  health: boolean;
};
type Member = {
  id: string; firstName: string; lastName: string; email: string | null;
  fencingCategory: string | null; categoryError: string | null;
  groups: Array<{ id: string; name: string }>;
  customFields: Array<{ document?: DocumentInfo }>;
};
type Group = { id: string; name: string; membersCount: number };
type ExtensionState = { id: string; enabled: boolean };

const EXTENSION_ID = "irl-documents";
const ELEMENT_NAME = "gu-ext-irl-documents";
const defaultDocument = `<h1 data-align="center">Convocation</h1><p>Bonjour <strong>{prenom} {nom}</strong>,</p><p>Nous vous invitons à participer à notre prochain événement.</p><p>Groupe : {groupes}<br>Catégorie : {categorie}</p><p>Fait le {date_du_jour}.</p>`;

function PrintDocuments({ host }: { host: HostApi }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [variables, setVariables] = useState<Variable[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [categoriesEnabled, setCategoriesEnabled] = useState(false);
  const [healthEnabled, setHealthEnabled] = useState(false);
  const [activeTemplateId, setActiveTemplateId] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateMessage, setTemplateMessage] = useState<string | null>(null);
  const [targetType, setTargetType] = useState<Target["type"]>("all");
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());
  const [memberSearch, setMemberSearch] = useState("");
  const [memberPage, setMemberPage] = useState(1);
  const [title, setTitle] = useState("courrier-adherents");
  const [output, setOutput] = useState<"individual" | "combined">("combined");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<Range | null>(null);
  const initialHtml = useRef(sanitizeHtml(window.localStorage.getItem("gu-print-document-draft") ?? defaultDocument));
  const [hasContent, setHasContent] = useState(Boolean(textFromHtml(initialHtml.current)));
  const categories = useMemo(
    () => uniqueSorted(members.map(categoryLabel).filter((category) => category !== "À corriger")),
    [members]
  );
  const matchingMembers = useMemo(() => members.filter((member) => {
    if (targetType === "healthMissing") return healthState(member) !== "valid";
    if (targetType === "groups") return member.groups.some((group) => selectedGroups.has(group.id));
    if (targetType === "categories") return selectedCategories.has(categoryLabel(member));
    if (targetType === "members") return selectedMembers.has(member.id);
    return true;
  }), [members, selectedCategories, selectedGroups, selectedMembers, targetType]);
  const searchableMembers = useMemo(() => members.filter((member) => includesText(
    `${member.lastName} ${member.firstName} ${member.email ?? ""} ${categoryLabel(member)}`,
    memberSearch
  )), [memberSearch, members]);
  const pageCount = Math.max(1, Math.ceil(searchableMembers.length / 10));
  const visibleMembers = searchableMembers.slice((memberPage - 1) * 10, memberPage * 10);

  useEffect(() => {
    void Promise.all([
      host.request<{ items: Member[] }>("/api/members"),
      host.request<{ items: Group[] }>("/api/groups"),
      host.request<{ items: ExtensionState[] }>("/api/extensions"),
      host.request<{ variables: Variable[] }>("/api/print-documents/config"),
      host.request<{ items: Template[] }>("/api/print-documents/templates")
    ]).then(([memberData, groupData, extensionData, config, savedTemplates]) => {
      setMembers(memberData.items);
      setGroups(groupData.items);
      setVariables(config.variables);
      setTemplates(savedTemplates.items);
      setCategoriesEnabled(extensionData.items.some((item) => item.id === "fencing-categories" && item.enabled));
      setHealthEnabled(extensionData.items.some((item) => item.id === "ffe-health-documents" && item.enabled));
    }).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Impossible de charger Documents IRL.");
    });
  }, [host]);
  useEffect(() => { if (editorRef.current) editorRef.current.innerHTML = initialHtml.current; }, []);
  useEffect(() => setMemberPage(1), [memberSearch]);
  useEffect(() => { if (memberPage > pageCount) setMemberPage(pageCount); }, [memberPage, pageCount]);

  function currentHtml() { return editorRef.current?.innerHTML ?? ""; }
  function setEditorHtml(value: string) {
    const sanitized = sanitizeHtml(value);
    if (editorRef.current) editorRef.current.innerHTML = sanitized;
    window.localStorage.setItem("gu-print-document-draft", sanitized);
    setHasContent(Boolean(textFromHtml(sanitized)));
    selectionRef.current = null;
  }
  function editorChanged() {
    normalizeAlignment(editorRef.current);
    const html = currentHtml();
    window.localStorage.setItem("gu-print-document-draft", sanitizeHtml(html));
    setHasContent(Boolean(textFromHtml(html)));
    rememberSelection();
  }
  function rememberSelection() {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (range && editorRef.current?.contains(range.commonAncestorContainer)) selectionRef.current = range.cloneRange();
  }
  function restoreSelection() {
    editorRef.current?.focus();
    const selection = window.getSelection();
    if (!selection || !selectionRef.current) return;
    selection.removeAllRanges(); selection.addRange(selectionRef.current);
  }
  function format(command: string, value?: string) {
    restoreSelection(); window.document.execCommand(command, false, value); editorChanged();
  }
  function insertVariable(token: string) {
    restoreSelection(); window.document.execCommand("insertText", false, token); editorChanged();
  }
  function selectedTarget(): Target | null {
    if (targetType === "groups") return selectedGroups.size ? { type: "groups", groupIds: [...selectedGroups] } : null;
    if (targetType === "categories") return selectedCategories.size ? { type: "categories", categories: [...selectedCategories] } : null;
    if (targetType === "members") return selectedMembers.size ? { type: "members", memberIds: [...selectedMembers] } : null;
    return { type: targetType };
  }
  function loadTemplate(templateId: string) {
    setActiveTemplateId(templateId); setTemplateMessage(null);
    if (!templateId) return;
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;
    setTemplateName(template.name); setTitle(template.documentTitle); setOutput(template.output);
    setEditorHtml(template.contentHtml); setTemplateMessage(`Modèle « ${template.name} » chargé.`);
  }
  async function saveTemplate() {
    if (!templateName.trim() || !title.trim() || !hasContent) return;
    setTemplateBusy(true); setTemplateMessage(null); setError(null);
    const input = { name: templateName.trim(), documentTitle: title.trim(), contentHtml: sanitizeHtml(currentHtml()), output };
    try {
      const saved = activeTemplateId
        ? await host.request<Template>(`/api/print-documents/templates/${activeTemplateId}`, { method: "PUT", body: JSON.stringify(input) })
        : await host.request<Template>("/api/print-documents/templates", { method: "POST", body: JSON.stringify(input) });
      const result = await host.request<{ items: Template[] }>("/api/print-documents/templates");
      setTemplates(result.items); setActiveTemplateId(saved.id); setTemplateName(saved.name);
      setTemplateMessage(activeTemplateId ? "Modèle mis à jour." : "Nouveau modèle enregistré.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible d'enregistrer le modèle.");
    } finally { setTemplateBusy(false); }
  }
  async function deleteTemplate() {
    const template = templates.find((item) => item.id === activeTemplateId);
    if (!template || !window.confirm(`Supprimer le modèle « ${template.name} » ?\n\nLes PDF déjà produits ne seront pas affectés.`)) return;
    setTemplateBusy(true); setTemplateMessage(null); setError(null);
    try {
      await host.request(`/api/print-documents/templates/${template.id}`, { method: "DELETE" });
      setTemplates((current) => current.filter((item) => item.id !== template.id));
      setActiveTemplateId(""); setTemplateName(""); setTemplateMessage("Modèle supprimé. Le contenu reste dans l'éditeur.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible de supprimer le modèle.");
    } finally { setTemplateBusy(false); }
  }
  async function generate(event: FormEvent) {
    event.preventDefault();
    const target = selectedTarget();
    if (!target || !editorRef.current) return;
    setBusy(true); setError(null);
    try {
      const result = await host.requestBlob("/api/print-documents/export", {
        method: "POST",
        body: JSON.stringify({ title, contentHtml: sanitizeHtml(currentHtml()), output, target })
      });
      const url = URL.createObjectURL(result.blob);
      const link = window.document.createElement("a");
      link.href = url; link.download = result.fileName ?? `${title}.${output === "combined" ? "pdf" : "zip"}`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible de produire les documents.");
    } finally { setBusy(false); }
  }

  const target = selectedTarget();
  return <form className="print-documents-page" onSubmit={(event) => void generate(event)}>
    {error && <div className="alert error">{error}</div>}
    <section className="panel print-template-panel">
      <div className="section-heading"><div><p className="eyebrow">Bibliothèque</p><h2>Modèles de documents</h2><p className="muted">Enregistrez le contenu, le nom du fichier et le format d’export pour les réutiliser plus tard.</p></div><span className="count-pill">{templates.length}</span></div>
      <div className="print-template-controls"><label>Modèle enregistré<select value={activeTemplateId} disabled={templateBusy} onChange={(event) => loadTemplate(event.target.value)}><option value="">Aucun modèle chargé</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label><label>Nom du modèle<input value={templateName} disabled={templateBusy} maxLength={100} placeholder="Ex. Convocation AG annuelle" onChange={(event) => setTemplateName(event.target.value)} /></label></div>
      <div className="template-actions"><button className="secondary" type="button" disabled={templateBusy} onClick={() => { setActiveTemplateId(""); setTemplateName(""); setTemplateMessage("Le document courant peut maintenant être enregistré comme nouveau modèle."); }}>Nouveau modèle</button><button className="primary" type="button" disabled={templateBusy || !templateName.trim() || !title.trim() || !hasContent} onClick={() => void saveTemplate()}>{templateBusy ? "Enregistrement…" : activeTemplateId ? "Mettre à jour le modèle" : "Enregistrer comme modèle"}</button>{activeTemplateId && <button className="danger-link" type="button" disabled={templateBusy} onClick={() => void deleteTemplate()}>Supprimer le modèle</button>}</div>
      {templateMessage && <p className="success-message">{templateMessage}</p>}
    </section>
    <section className="panel print-recipient-panel">
      <div className="section-heading"><div><p className="eyebrow">Destinataires papier</p><h2>À qui créer un document ?</h2><p className="muted">Un document personnalisé sera produit pour chaque adhérent correspondant.</p></div><span className="count-pill">{matchingMembers.length}</span></div>
      <div className="print-target-grid">
        <TargetChoice selected={targetType === "all"} onSelect={() => setTargetType("all")} title="Tous les adhérents" hint={`${members.length} personnes actives`} />
        {healthEnabled && <TargetChoice selected={targetType === "healthMissing"} onSelect={() => setTargetType("healthMissing")} title="Document santé manquant" hint="Sans certificat ou attestation valide" />}
        <TargetChoice selected={targetType === "groups"} onSelect={() => setTargetType("groups")} title="Par groupe" hint="Un ou plusieurs groupes" />
        {categoriesEnabled && <TargetChoice selected={targetType === "categories"} onSelect={() => setTargetType("categories")} title="Par catégorie" hint="M9, M11, Senior…" />}
        <TargetChoice selected={targetType === "members"} onSelect={() => setTargetType("members")} title="Choix individuel" hint="Sélection nominative" />
      </div>
      {targetType === "groups" && <div className="print-choice-list"><strong>Groupes à inclure</strong><div className="group-checkboxes">{groups.map((group) => <label key={group.id}><input type="checkbox" checked={selectedGroups.has(group.id)} onChange={() => setSelectedGroups((current) => toggled(current, group.id))} /><span>{group.name}<small>{group.membersCount} adhérent{group.membersCount > 1 ? "s" : ""}</small></span></label>)}</div></div>}
      {targetType === "categories" && <div className="print-choice-list"><strong>Catégories à inclure</strong><div className="group-checkboxes">{categories.map((category) => <label key={category}><input type="checkbox" checked={selectedCategories.has(category)} onChange={() => setSelectedCategories((current) => toggled(current, category))} /><span>{category}<small>{members.filter((member) => categoryLabel(member) === category).length} adhérent(s)</small></span></label>)}</div></div>}
      {targetType === "members" && <div className="print-member-picker"><div className="print-member-picker-heading"><strong>Adhérents choisis</strong><span>{selectedMembers.size} sélectionné{selectedMembers.size > 1 ? "s" : ""}</span></div><ListSearch value={memberSearch} onChange={setMemberSearch} /><div className="print-member-actions"><button type="button" className="link-button" onClick={() => setSelectedMembers((current) => new Set([...current, ...searchableMembers.map((member) => member.id)]))}>Sélectionner les résultats</button><button type="button" className="link-button" onClick={() => setSelectedMembers(new Set())}>Tout désélectionner</button></div><div className="print-member-list">{visibleMembers.map((member) => <label key={member.id}><input type="checkbox" checked={selectedMembers.has(member.id)} onChange={() => setSelectedMembers((current) => toggled(current, member.id))} /><span><strong>{member.lastName} {member.firstName}</strong><small>{categoryLabel(member)} · {member.groups.map((group) => group.name).join(", ") || "Aucun groupe"}</small></span></label>)}</div><Pagination page={memberPage} total={searchableMembers.length} onPageChange={setMemberPage} /></div>}
    </section>
    <section className="panel print-editor-panel">
      <div className="section-heading"><div><p className="eyebrow">Contenu imprimé</p><h2>Rédiger le document</h2><p className="muted">Cliquez sur une variable pour l’insérer à la position du curseur.</p></div></div>
      <div className="variable-library"><div><strong>Informations principales</strong><div>{variables.filter((item) => item.source === "member").map((item) => <button key={item.token} type="button" title={item.token} onMouseDown={(event) => { event.preventDefault(); insertVariable(item.token); }}>{item.label}</button>)}</div></div>{variables.some((item) => item.source === "additional") && <details><summary>Champs supplémentaires</summary><div>{variables.filter((item) => item.source === "additional").map((item) => <button key={item.token} type="button" title={item.token} onMouseDown={(event) => { event.preventDefault(); insertVariable(item.token); }}>{item.label}</button>)}</div></details>}</div>
      <div className="rich-editor-shell"><div className="rich-editor-toolbar" role="toolbar" aria-label="Mise en forme"><select aria-label="Style du paragraphe" defaultValue="p" onMouseDown={rememberSelection} onChange={(event) => format("formatBlock", event.target.value)}><option value="p">Paragraphe</option><option value="h1">Grand titre</option><option value="h2">Sous-titre</option><option value="h3">Petit titre</option></select><span className="toolbar-separator" /><ToolbarButton label="Gras" onFormat={() => format("bold")}><strong>G</strong></ToolbarButton><ToolbarButton label="Italique" onFormat={() => format("italic")}><em>I</em></ToolbarButton><ToolbarButton label="Souligné" onFormat={() => format("underline")}><u>S</u></ToolbarButton><span className="toolbar-separator" /><ToolbarButton label="Aligner à gauche" onFormat={() => format("justifyLeft")}>≡</ToolbarButton><ToolbarButton label="Centrer" onFormat={() => format("justifyCenter")}>≣</ToolbarButton><ToolbarButton label="Aligner à droite" onFormat={() => format("justifyRight")}>≡</ToolbarButton><span className="toolbar-separator" /><ToolbarButton label="Liste à puces" onFormat={() => format("insertUnorderedList")}>• Liste</ToolbarButton><ToolbarButton label="Liste numérotée" onFormat={() => format("insertOrderedList")}>1. Liste</ToolbarButton></div><div ref={editorRef} className="rich-editor-page" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" data-placeholder="Rédigez votre courrier…" onInput={editorChanged} onKeyUp={rememberSelection} onMouseUp={rememberSelection} onBlur={rememberSelection} onPaste={(event) => { event.preventDefault(); window.document.execCommand("insertText", false, event.clipboardData.getData("text/plain")); editorChanged(); }} /></div>
    </section>
    <section className="panel print-output-panel"><div className="section-heading"><div><p className="eyebrow">Export</p><h2>Préparer l’impression</h2></div></div><div className="document-naming"><label>Nom du fichier<input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label><fieldset><legend>Format produit</legend><label className="radio-line"><input type="radio" checked={output === "combined"} onChange={() => setOutput("combined")} /> Un seul PDF regroupant toutes les pages</label><label className="radio-line"><input type="radio" checked={output === "individual"} onChange={() => setOutput("individual")} /> Un PDF par adhérent, regroupés dans un ZIP</label></fieldset></div><div className="print-export-summary"><strong>{matchingMembers.length} document{matchingMembers.length > 1 ? "s" : ""} à produire</strong><span>{output === "combined" ? "Un fichier PDF prêt à imprimer" : "Une archive ZIP de fichiers individuels"}</span></div><div className="editor-actions"><button className="primary" type="submit" disabled={busy || !title.trim() || !hasContent || !target || matchingMembers.length === 0}>{busy ? "Création des PDF…" : output === "combined" ? "Télécharger le PDF" : "Télécharger le ZIP"}</button></div></section>
  </form>;
}

function TargetChoice({ selected, onSelect, title, hint }: { selected: boolean; onSelect: () => void; title: string; hint: string }) {
  return <label className={selected ? "selected" : ""}><input type="radio" checked={selected} onChange={onSelect} /><strong>{title}</strong><small>{hint}</small></label>;
}
function ToolbarButton({ label, onFormat, children }: { label: string; onFormat: () => void; children: React.ReactNode }) {
  return <button type="button" title={label} aria-label={label} onMouseDown={(event) => { event.preventDefault(); onFormat(); }}>{children}</button>;
}
function ListSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <div className="list-search"><span aria-hidden="true">⌕</span><input aria-label="Recherche rapide" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Rechercher un nom ou un prénom…" />{value && <button type="button" aria-label="Effacer la recherche" onClick={() => onChange("")}>×</button>}</div>;
}
function Pagination({ page, total, onPageChange }: { page: number; total: number; onPageChange: (page: number) => void }) {
  const count = Math.max(1, Math.ceil(total / 10));
  const start = total === 0 ? 0 : (page - 1) * 10 + 1;
  return <div className="pagination"><span>{start}–{Math.min(page * 10, total)} sur {total}</span><div className="pagination-nav"><button className="secondary compact-button" type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>‹ Précédente</button><strong>Page {page} / {count}</strong><button className="secondary compact-button" type="button" disabled={page >= count} onClick={() => onPageChange(page + 1)}>Suivante ›</button></div></div>;
}
function categoryLabel(member: Member) { return member.categoryError || !member.fencingCategory ? "À corriger" : member.fencingCategory; }
function healthState(member: Member) {
  const available = member.customFields.map((field) => field.document).filter((document) => document?.health && document.available);
  return available.some((document) => document?.classification === "certificate" || document?.classification === "attestation") ? "valid" : "missing";
}
function toggled(current: Set<string>, value: string) { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; }
function uniqueSorted(values: string[]) { return [...new Set(values)].sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" })); }
function includesText(value: string, query: string) { return !query.trim() || normalize(value).includes(normalize(query)); }
function normalize(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr"); }
function textFromHtml(value: string) { return new DOMParser().parseFromString(value, "text/html").body.textContent?.trim() ?? ""; }
function sanitizeHtml(value: string) {
  const parsed = new DOMParser().parseFromString(value, "text/html");
  const allowed = new Set(["P", "DIV", "BR", "STRONG", "B", "EM", "I", "U", "H1", "H2", "H3", "UL", "OL", "LI"]);
  const clean = window.document.createElement("div");
  const copy = (source: Node, destination: Node) => {
    for (const child of source.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) { destination.appendChild(window.document.createTextNode(child.textContent ?? "")); continue; }
      if (!(child instanceof HTMLElement) || new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT"]).has(child.tagName)) continue;
      if (!allowed.has(child.tagName)) { copy(child, destination); continue; }
      const element = window.document.createElement(child.tagName.toLowerCase());
      const alignment = child.dataset.align || child.style.textAlign || child.getAttribute("align") || "";
      if (["left", "center", "right"].includes(alignment)) element.dataset.align = alignment;
      destination.appendChild(element); copy(child, element);
    }
  };
  copy(parsed.body, clean); return clean.innerHTML;
}
function normalizeAlignment(editor: HTMLElement | null) {
  if (!editor) return;
  for (const element of editor.querySelectorAll<HTMLElement>("[style*='text-align'], [align], [data-align]")) {
    const alignment = element.dataset.align || element.style.textAlign || element.getAttribute("align") || "";
    if (["left", "center", "right"].includes(alignment)) element.dataset.align = alignment;
    element.style.removeProperty("text-align"); element.removeAttribute("style"); element.removeAttribute("align");
  }
}

class IrlDocumentsElement extends HTMLElement {
  hostApi?: HostApi;
  private root: Root | null = null;
  connectedCallback() {
    if (!this.hostApi) throw new Error("hostApi n'a pas été fourni à l'élément du module.");
    this.root = createRoot(this); this.root.render(<PrintDocuments host={this.hostApi} />);
  }
  disconnectedCallback() { const root = this.root; this.root = null; queueMicrotask(() => root?.unmount()); }
}

if (!customElements.get(ELEMENT_NAME)) customElements.define(ELEMENT_NAME, IrlDocumentsElement);
window.__GU_HOST__?.registerView({ extensionId: EXTENSION_ID, label: "Documents IRL", element: ELEMENT_NAME });
