import { useEffect, useMemo, useState } from "react";
import { api, type GroupRule, type GroupingPreview, type SetupData } from "./api";

type GroupDraft = { localId: string; id?: string; name: string; rules: GroupRule[] };

export function Setup({ helloassoConfigured, onImported }: { helloassoConfigured: boolean; onImported: () => void }) {
  const [data, setData] = useState<SetupData | null>(null);
  const [campaignSelection, setCampaignSelection] = useState<Set<string>>(new Set());
  const [fieldSelection, setFieldSelection] = useState<Set<string>>(new Set());
  const [healthDocumentFieldKey, setHealthDocumentFieldKey] = useState<string>("");
  const [groupingSourceSelection, setGroupingSourceSelection] = useState<Set<string>>(new Set(["tier"]));
  const [groupingPreview, setGroupingPreview] = useState<GroupingPreview | null>(null);
  const [groupDrafts, setGroupDrafts] = useState<GroupDraft[]>([]);
  const [showArchives, setShowArchives] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void api.setup().then(applyData).catch(showError); }, []);

  const selectedCampaignCount = data?.campaigns.filter((campaign) => campaign.selected).length ?? 0;
  const visibleCampaigns = useMemo(
    () => data?.campaigns.filter((campaign) => showArchives || campaign.current) ?? [],
    [data, showArchives]
  );
  const groupingSources = useMemo(() => [
    { key: "tier", label: "Tarif choisi", type: "Tarif" },
    ...(data?.fields.filter((field) => field.type !== "File").map((field) => ({ key: field.key, label: field.label, type: field.type })) ?? [])
  ], [data]);
  const groupsAreValid = groupDrafts.length > 0
    && groupDrafts.every((group) => group.name.trim().length >= 2 && group.rules.length > 0)
    && new Set(groupDrafts.map((group) => group.name.trim().toLocaleLowerCase("fr"))).size === groupDrafts.length;

  function applyData(nextData: SetupData, suggestCurrent = false) {
    setData(nextData);
    const persistedCampaigns = nextData.campaigns.filter((campaign) => campaign.selected).map((campaign) => campaign.formSlug);
    setCampaignSelection(new Set(
      persistedCampaigns.length > 0 || !suggestCurrent
        ? persistedCampaigns
        : nextData.campaigns.filter((campaign) => campaign.current).map((campaign) => campaign.formSlug)
    ));
    setFieldSelection(new Set(nextData.fields.filter((field) => field.selected).map((field) => field.key)));
    setHealthDocumentFieldKey(nextData.fields.find((field) => field.documentRole === "health")?.key ?? "");
    setGroupDrafts(nextData.groupDefinitions.map((group) => ({
      localId: group.id, id: group.id, name: group.name, rules: group.rules
    })));
    const persistedSources = nextData.groupDefinitions.flatMap((group) => group.rules.map((rule) => rule.fieldKey));
    setGroupingSourceSelection(new Set(persistedSources.length > 0 ? persistedSources : ["tier"]));
  }

  function showError(reason: unknown) {
    setError(reason instanceof Error ? reason.message : "Une erreur est survenue.");
    setBusy(null);
  }

  async function discover() {
    setBusy("discover"); setError(null); setMessage(null);
    try {
      applyData(await api.discoverCampaigns(), true);
      setGroupingPreview(null);
      setMessage("Les campagnes HelloAsso ont été actualisées.");
    } catch (reason) { showError(reason); } finally { setBusy(null); }
  }

  async function analyzeCampaigns() {
    setBusy("campaigns"); setError(null); setMessage(null);
    try {
      const nextData = await api.selectCampaigns([...campaignSelection]);
      applyData(nextData);
      setGroupingPreview(null);
      setMessage(`${nextData.fields.length} champs distincts trouvés dans les inscriptions.`);
    } catch (reason) { showError(reason); } finally { setBusy(null); }
  }

  async function saveFields() {
    setBusy("fields"); setError(null); setMessage(null);
    try {
      applyData(await api.selectFields([...fieldSelection], healthDocumentFieldKey || null));
      setMessage("Le modèle de données des adhérents est enregistré.");
    } catch (reason) { showError(reason); } finally { setBusy(null); }
  }

  async function analyzeGrouping() {
    setBusy("group-preview"); setError(null); setMessage(null);
    try {
      setGroupingPreview(await api.previewGrouping([...groupingSourceSelection]));
      setMessage("Les valeurs utilisées dans les inscriptions ont été regroupées.");
    } catch (reason) { showError(reason); } finally { setBusy(null); }
  }

  async function saveGroups() {
    setBusy("groups"); setError(null); setMessage(null);
    try {
      applyData(await api.saveGroupDefinitions(groupDrafts.map((group) => ({
        ...(group.id ? { id: group.id } : {}), name: group.name.trim(), rules: group.rules
      }))));
      setMessage("Les règles de création des groupes sont enregistrées.");
    } catch (reason) { showError(reason); } finally { setBusy(null); }
  }

  async function runImport() {
    setBusy("import"); setError(null); setMessage(null);
    try {
      const result = await api.importMembers();
      applyData(await api.setup());
      onImported();
      setMessage(`${result.importedCount} adhérents valides ont été importés ou actualisés.`);
    } catch (reason) { showError(reason); } finally { setBusy(null); }
  }

  function toggleCampaign(value: string) { setCampaignSelection((current) => toggled(current, value)); }
  function toggleField(value: string) {
    setFieldSelection((current) => {
      const next = toggled(current, value);
      if (!next.has(value) && healthDocumentFieldKey === value) setHealthDocumentFieldKey("");
      if (next.has(value) && !healthDocumentFieldKey) {
        const field = data?.fields.find((candidate) => candidate.key === value);
        if (field?.type === "File" && /certificat|attestation|questionnaire.*sant[eé]/i.test(field.label)) {
          setHealthDocumentFieldKey(value);
        }
      }
      return next;
    });
  }
  function toggleGroupingSource(value: string) {
    setGroupingSourceSelection((current) => toggled(current, value));
    setGroupingPreview(null);
  }
  function addGroup() {
    setGroupDrafts((current) => [...current, { localId: crypto.randomUUID(), name: "", rules: [] }]);
  }
  function removeGroup(localId: string) {
    setGroupDrafts((current) => current.filter((group) => group.localId !== localId));
  }
  function renameGroup(localId: string, name: string) {
    setGroupDrafts((current) => current.map((group) => group.localId === localId ? { ...group, name } : group));
  }
  function toggleGroupRule(localId: string, rule: GroupRule) {
    setGroupDrafts((current) => current.map((group) => {
      if (group.localId !== localId) return group;
      return {
        ...group,
        rules: hasRule(group.rules, rule)
          ? group.rules.filter((candidate) => candidate.fieldKey !== rule.fieldKey || candidate.value !== rule.value)
          : [...group.rules, rule]
      };
    }));
  }

  return <div className="setup-stack">
    <section className="setup-progress" aria-label="Étapes de configuration">
      <ProgressStep number="1" label="Connexion" done={helloassoConfigured} />
      <ProgressStep number="2" label="Campagnes" done={selectedCampaignCount > 0} />
      <ProgressStep number="3" label="Champs" done={Boolean(data?.completedAt)} />
      <ProgressStep number="4" label="Groupes" done={Boolean(data?.groupsConfiguredAt)} />
      <ProgressStep number="5" label="Import" done={data?.lastSync?.status === "succeeded"} />
    </section>

    {error && <div className="alert error">{error}</div>}
    {message && <div className="alert success">{message}</div>}

    <section className="panel setup-section">
      <StepHeading number="1" title="Connexion à HelloAsso" />
      <div className="connection-line">
        <span className={helloassoConfigured ? "status-dot ok" : "status-dot"} />
        <div><strong>{helloassoConfigured ? "Identifiants configurés" : "Configuration incomplète"}</strong><p>Les appels sont réalisés exclusivement par le serveur local.</p></div>
      </div>
    </section>

    <section className="panel setup-section">
      <div className="setup-section-header">
        <StepHeading number="2" title="Choisir les campagnes d’adhésion" />
        <button className="secondary" disabled={!helloassoConfigured || busy !== null} onClick={() => void discover()} type="button">
          {busy === "discover" ? "Recherche…" : data?.campaigns.length ? "Actualiser" : "Rechercher sur HelloAsso"}
        </button>
      </div>
      {!data?.campaigns.length ? <p className="muted setup-hint">Lancez la recherche pour afficher les campagnes disponibles.</p> : <>
        <div className="campaign-list">{visibleCampaigns.map((campaign) => <label className="choice-card" key={campaign.formSlug}>
          <input type="checkbox" checked={campaignSelection.has(campaign.formSlug)} onChange={() => toggleCampaign(campaign.formSlug)} />
          <span className="choice-copy"><span className="choice-title-row"><strong>{campaign.title}</strong><span className={campaign.current ? "state-pill current" : "state-pill"}>{campaign.current ? "En cours" : campaign.state}</span></span><span>{formatPeriod(campaign.startDate, campaign.endDate)}</span></span>
        </label>)}</div>
        <button className="link-button" type="button" onClick={() => setShowArchives((value) => !value)}>{showArchives ? "Masquer les anciennes campagnes" : `Voir les campagnes archivées (${data.campaigns.filter((campaign) => !campaign.current).length})`}</button>
        <div className="setup-actions"><span>{campaignSelection.size} campagne{campaignSelection.size > 1 ? "s" : ""} sélectionnée{campaignSelection.size > 1 ? "s" : ""}</span><button className="primary" disabled={campaignSelection.size === 0 || busy !== null} onClick={() => void analyzeCampaigns()} type="button">{busy === "campaigns" ? "Analyse des inscriptions…" : "Valider et analyser les champs"}</button></div>
      </>}
    </section>

    <section className={`panel setup-section ${selectedCampaignCount === 0 ? "disabled-section" : ""}`}>
      <StepHeading number="3" title="Choisir les données à conserver" />
      <p className="muted setup-hint">Les champs de base sont indispensables. Les champs supplémentaires ne seront enregistrés que si vous les sélectionnez.</p>
      <div className="core-fields">{data?.coreFields.map((field) => <span key={field.key}>✓ {field.label}</span>)}</div>
      {data?.fields.length ? <>
        <div className="field-toolbar"><strong>{data.fields.length} champs supplémentaires proposés</strong><div><button className="link-button" type="button" onClick={() => setFieldSelection(new Set(data.fields.map((field) => field.key)))}>Tout sélectionner</button><button className="link-button" type="button" onClick={() => { setFieldSelection(new Set()); setHealthDocumentFieldKey(""); }}>Tout désélectionner</button></div></div>
        <div className="field-list">{data.fields.map((field) => <label className="field-row" key={field.key}><input type="checkbox" checked={fieldSelection.has(field.key)} onChange={() => toggleField(field.key)} /><span><strong>{field.label}</strong><small>{fieldTypeLabel(field.type)} · présent dans {field.campaignCount}/{selectedCampaignCount} campagne{selectedCampaignCount > 1 ? "s" : ""}</small></span></label>)}</div>
        {data.fields.some((field) => field.type === "File" && fieldSelection.has(field.key)) && <label className="health-document-choice">Champ contenant le certificat médical ou l’attestation de santé<select value={healthDocumentFieldKey} onChange={(event) => setHealthDocumentFieldKey(event.target.value)}><option value="">Documents génériques uniquement (aucune reconnaissance)</option>{data.fields.filter((field) => field.type === "File" && fieldSelection.has(field.key)).map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}</select><small>Le champ santé détecté par son intitulé est sélectionné automatiquement. Vous pouvez modifier ce choix.</small></label>}
        <div className="setup-actions"><span>{fieldSelection.size} champ{fieldSelection.size > 1 ? "s" : ""} supplémentaire{fieldSelection.size > 1 ? "s" : ""}</span><button className="primary" disabled={busy !== null} onClick={() => void saveFields()} type="button">{busy === "fields" ? "Enregistrement…" : "Enregistrer ce modèle"}</button></div>
      </> : selectedCampaignCount > 0 ? <p className="empty-inline">Aucun champ n’a été trouvé. Une campagne doit contenir au moins une inscription pour permettre cette analyse.</p> : null}
    </section>

    <section className={`panel setup-section ${!data?.completedAt ? "disabled-section" : ""}`}>
      <StepHeading number="4" title="Composer les groupes" />
      <p className="muted setup-hint">Choisissez une ou plusieurs sources, puis associez autant de valeurs que nécessaire à un nom de groupe. Une correspondance suffit pour intégrer l’adhérent au groupe.</p>
      <div className="grouping-example">Exemple : « M9 Débutant » ou « M11 Débutant » → groupe « M9 M11 débutant ». Les variantes de paiement en 1 ou 3 fois sont automatiquement réunies.</div>
      <div className="grouping-source-list">{groupingSources.map((source) => <label className="source-chip" key={source.key}><input type="checkbox" checked={groupingSourceSelection.has(source.key)} onChange={() => toggleGroupingSource(source.key)} /><span><strong>{source.label}</strong><small>{fieldTypeLabel(source.type)}</small></span></label>)}</div>
      <div className="setup-actions"><span>{groupingSourceSelection.size} source{groupingSourceSelection.size > 1 ? "s" : ""} choisie{groupingSourceSelection.size > 1 ? "s" : ""}</span><button className="secondary" disabled={!data?.completedAt || groupingSourceSelection.size === 0 || busy !== null} onClick={() => void analyzeGrouping()} type="button">{busy === "group-preview" ? "Lecture des inscriptions…" : "Afficher les valeurs disponibles"}</button></div>

      {groupingPreview && <div className="rule-builder">
        <div className="rule-builder-header"><div><h3>Règles de groupes</h3><p className="muted">Cochez toutes les valeurs qui doivent rejoindre chaque groupe.</p></div><button className="secondary" type="button" onClick={addGroup}>Ajouter un groupe</button></div>
        {groupDrafts.length === 0 ? <p className="empty-inline">Ajoutez votre premier groupe, puis donnez-lui un nom et choisissez ses valeurs.</p> : <div className="group-draft-list">{groupDrafts.map((group) => <article className="rule-card" key={group.localId}>
          <div className="rule-card-header"><label>Nom du groupe<input value={group.name} maxLength={100} placeholder="Ex. M9 M11 débutant" onChange={(event) => renameGroup(group.localId, event.target.value)} /></label><button className="danger-link" type="button" onClick={() => removeGroup(group.localId)}>Supprimer</button></div>
          <p className="rule-count">{group.rules.length} valeur{group.rules.length > 1 ? "s" : ""} associée{group.rules.length > 1 ? "s" : ""}</p>
          <div className="rule-sources">{groupingPreview.sources.map((source) => <fieldset className="rule-source" key={source.key}><legend>{source.label}</legend>{source.values.length === 0 ? <p className="muted">Aucune valeur renseignée.</p> : <div className="value-grid">{source.values.map((entry) => {
            const rule = { fieldKey: source.key, value: entry.value };
            return <label className="value-option" key={`${source.key}:${entry.value}`}><input type="checkbox" checked={hasRule(group.rules, rule)} onChange={() => toggleGroupRule(group.localId, rule)} /><span>{entry.value}<small>{entry.count} adhérent{entry.count > 1 ? "s" : ""}</small></span></label>;
          })}</div>}</fieldset>)}</div>
        </article>)}</div>}
        <div className="setup-actions"><span>{groupDrafts.length} groupe{groupDrafts.length > 1 ? "s" : ""} préparé{groupDrafts.length > 1 ? "s" : ""}</span><button className="primary" disabled={!groupsAreValid || busy !== null} onClick={() => void saveGroups()} type="button">{busy === "groups" ? "Enregistrement…" : "Enregistrer les groupes"}</button></div>
      </div>}
    </section>

    <section className={`panel setup-section import-section ${!data?.completedAt || !data?.groupsConfiguredAt ? "disabled-section" : ""}`}>
      <div><StepHeading number="5" title="Créer ou actualiser la base" /><p className="muted setup-hint">Les inscriptions valides seront ajoutées ou mises à jour et placées dans les groupes configurés. Les inscriptions annulées ne deviennent pas des adhérents actifs.</p>{data?.lastSync && <p className="last-sync">Dernier import : {data.lastSync.importedCount} adhérents · {data.lastSync.finishedAt ? formatDateTime(data.lastSync.finishedAt) : data.lastSync.status}</p>}</div>
      <button className="primary import-button" disabled={!data?.completedAt || !data?.groupsConfiguredAt || busy !== null} onClick={() => void runImport()} type="button">{busy === "import" ? "Import en cours…" : "Importer les adhérents"}</button>
    </section>
  </div>;
}

function ProgressStep({ number, label, done }: { number: string; label: string; done: boolean }) {
  return <div className={done ? "progress-step done" : "progress-step"}><span>{done ? "✓" : number}</span><strong>{label}</strong></div>;
}
function StepHeading({ number, title }: { number: string; title: string }) {
  return <div className="step-heading"><span>{number}</span><div><p className="eyebrow">Étape {number}</p><h2>{title}</h2></div></div>;
}
function hasRule(rules: GroupRule[], target: GroupRule) {
  return rules.some((rule) => rule.fieldKey === target.fieldKey && rule.value === target.value);
}
function toggled(current: Set<string>, value: string) {
  const next = new Set(current);
  if (next.has(value)) next.delete(value); else next.add(value);
  return next;
}
function formatPeriod(start: string | null, end: string | null) {
  if (!start && !end) return "Période non renseignée";
  const formatter = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });
  return `${start ? formatter.format(new Date(start)) : "—"} → ${end ? formatter.format(new Date(end)) : "—"}`;
}
function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
function fieldTypeLabel(type: string) {
  const labels: Record<string, string> = { ChoiceList: "Choix", Date: "Date", File: "Document", Phone: "Téléphone", TextInput: "Texte", YesNo: "Oui / Non", Zipcode: "Code postal", Tarif: "Tarif" };
  return labels[type] ?? type;
}
