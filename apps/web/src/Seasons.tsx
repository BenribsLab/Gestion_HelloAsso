import { type FormEvent, useEffect, useState } from "react";
import { api, setSelectedSeason, type Season, type SeasonFieldCheck, type SeasonsState } from "./api";
import { Modal } from "./App";

type SeasonDraft = { id?: string; label: string; startsOn: string; endsOn: string };

/**
 * Saisons du club. On « entre » dans une saison avec le sélecteur du haut : tous les écrans
 * ne montrent ensuite que ses adhérents. Ici : créer une saison, y rattacher ses campagnes
 * HelloAsso, contrôler que les champs choisis s'y retrouvent, puis importer.
 */
export function Seasons({ state, onOpenSetup, onChanged }: {
  state: SeasonsState;
  onOpenSetup: () => void;
  onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<SeasonDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [check, setCheck] = useState<SeasonFieldCheck | null>(null);
  const selected = state.items.find((season) => season.id === state.selectedId) ?? null;

  useEffect(() => {
    if (!selected) return;
    let active = true;
    void api.seasonFields(selected.id)
      .then((result) => { if (active) setCheck(result); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Contrôle des champs impossible."); });
    return () => { active = false; };
  }, [selected?.id, selected?.campaignsCount]);

  function newSeason() {
    const latest = state.items[0];
    const startYear = latest ? latest.startYear + 1 : new Date().getFullYear();
    setDraft({ label: `${startYear}-${startYear + 1}`, startsOn: `${startYear}-09-01`, endsOn: `${startYear + 1}-08-31` });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy("save"); setError(null); setMessage(null);
    try {
      const input = { label: draft.label.trim(), startsOn: draft.startsOn, endsOn: draft.endsOn };
      if (draft.id) await api.updateSeason(draft.id, input);
      else await api.createSeason(input);
      setDraft(null);
      setMessage(draft.id ? "Saison modifiée." : `Saison ${input.label} créée. Ouvrez-la pour y rattacher ses campagnes HelloAsso.`);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Enregistrement impossible.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(season: Season) {
    if (!window.confirm(`Supprimer la saison ${season.label} ?`)) return;
    setBusy(`delete:${season.id}`); setError(null); setMessage(null);
    try {
      await api.deleteSeason(season.id);
      if (season.id === state.selectedId) openSeason(null);
      else await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Suppression impossible.");
    } finally {
      setBusy(null);
    }
  }

  async function mapField(candidateKey: string, fieldKey: string) {
    if (!selected || !candidateKey) return;
    const [formSlug, sourceFieldId] = candidateKey.split("\u0000");
    setBusy(`map:${fieldKey}`); setError(null);
    try {
      setCheck(await api.mapSeasonField(selected.id, { formSlug: formSlug!, sourceFieldId: sourceFieldId!, fieldKey }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Correspondance impossible.");
    } finally {
      setBusy(null);
    }
  }

  async function importSeason() {
    if (!selected) return;
    setBusy("import"); setError(null); setMessage(null);
    try {
      const result = await api.importMembers();
      setMessage(`${result.importedCount} inscription${result.importedCount > 1 ? "s" : ""} importée${result.importedCount > 1 ? "s" : ""} pour la saison ${selected.label}.`);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Import impossible.");
    } finally {
      setBusy(null);
    }
  }

  return <div className="page-stack">
    {error && <div className="alert error" role="alert">{error}</div>}
    {message && <div className="alert success" role="status">{message}</div>}

    <section className="panel">
      <div className="section-heading toolbar">
        <div><p className="eyebrow">Saisons</p><h2>Saisons du club</h2><p className="muted">Une saison n'existe que lorsque vous la créez. Ouvrez une saison pour ne voir que ses adhérents, ses groupes et son historique.</p></div>
        <button className="primary" type="button" onClick={newSeason}>Nouvelle saison</button>
      </div>
      <div className="list-rows">
        {state.items.map((season) => <div className="list-row" key={season.id}>
          <div>
            <strong>{season.label}</strong>
            {season.id === state.currentId && <span className="badge">Saison du jour</span>}
            {season.id === state.selectedId && <span className="badge ok">Ouverte</span>}
            <small>{formatDate(season.startsOn)} → {formatDate(season.endsOn)} · {season.membersCount} adhérent{season.membersCount > 1 ? "s" : ""} · {season.campaignsCount} campagne{season.campaignsCount > 1 ? "s" : ""} HelloAsso</small>
          </div>
          <div className="toolbar">
            {season.id !== state.selectedId && <button className="secondary" type="button" onClick={() => openSeason(season.id)}>Ouvrir</button>}
            <button className="secondary" type="button" onClick={() => setDraft({ id: season.id, label: season.label, startsOn: season.startsOn, endsOn: season.endsOn })}>Modifier</button>
            {season.membersCount === 0 && state.items.length > 1 && <button className="danger-link" type="button" disabled={busy !== null} onClick={() => void remove(season)}>Supprimer</button>}
          </div>
        </div>)}
      </div>
    </section>

    {selected && <section className="panel">
      <div className="section-heading toolbar">
        <div><p className="eyebrow">Saison {selected.label}</p><h2>Campagnes et champs HelloAsso</h2><p className="muted">Les champs choisis sont communs à toutes les saisons. Si une campagne a renommé un champ ou changé son type, rattachez-le ci-dessous.</p></div>
        <button className="secondary" type="button" onClick={onOpenSetup}>Choisir les campagnes</button>
      </div>
      {!check ? <p className="muted">Contrôle des champs…</p> : check.campaigns.length === 0
        ? <p className="empty-inline">Aucune campagne HelloAsso n'est rattachée à cette saison. Utilisez « Choisir les campagnes » (étape Campagnes de la configuration).</p>
        : <>
          <p className="muted">Campagne{check.campaigns.length > 1 ? "s" : ""} : {check.campaigns.map((campaign) => campaign.title).join(" · ")}</p>
          {check.missing.length === 0
            ? <div className="alert success">Tous les champs choisis se retrouvent dans les campagnes de la saison.</div>
            : <>
              <div className="alert error">{check.missing.length} champ{check.missing.length > 1 ? "s" : ""} choisi{check.missing.length > 1 ? "s" : ""} introuvable{check.missing.length > 1 ? "s" : ""} dans les campagnes de cette saison : nom ou type modifié dans HelloAsso ?</div>
              <div className="list-rows">
                {check.missing.map((field) => <div className="list-row" key={field.key}>
                  <div>
                    <strong>{field.label}</strong>
                    <small>{field.type}{field.sameLabelCandidate ? ` · même nom trouvé avec le type ${field.sameLabelCandidate.type}` : ""}</small>
                  </div>
                  <select aria-label={`Champ de campagne correspondant à ${field.label}`} disabled={busy !== null} value="" onChange={(event) => void mapField(event.target.value, field.key)}>
                    <option value="">Rattacher au champ…</option>
                    {check.candidates.map((candidate) => <option key={`${candidate.formSlug}:${candidate.sourceFieldId}`} value={`${candidate.formSlug}\u0000${candidate.sourceFieldId}`}>
                      {candidate.label} ({candidate.type}){check.campaigns.length > 1 ? ` · ${check.campaigns.find((campaign) => campaign.formSlug === candidate.formSlug)?.title ?? ""}` : ""}
                    </option>)}
                  </select>
                </div>)}
              </div>
            </>}
          {check.mapped.length > 0 && <p className="muted">Correspondances faites à la main : {check.mapped.map((field) => field.label).join(", ")}.</p>}
          <div className="setup-actions">
            <span>Ajoute ou met à jour les inscriptions HelloAsso de la saison {selected.label}.</span>
            <button className="primary" type="button" disabled={busy !== null} onClick={() => void importSeason()}>{busy === "import" ? "Import en cours…" : "Importer les adhérents de la saison"}</button>
          </div>
        </>}
    </section>}

    {draft && <Modal title={draft.id ? "Modifier la saison" : "Nouvelle saison"} eyebrow="Saisons" onClose={() => setDraft(null)}>
      <form className="season-form" onSubmit={(event) => void save(event)}>
        <label>Nom<input required minLength={4} maxLength={40} value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></label>
        <div className="season-dates">
          <label>Début<input required type="date" value={draft.startsOn} onChange={(event) => setDraft({ ...draft, startsOn: event.target.value })} /></label>
          <label>Fin<input required type="date" value={draft.endsOn} onChange={(event) => setDraft({ ...draft, endsOn: event.target.value })} /></label>
        </div>
        <div className="gu-dialog-actions">
          <button className="secondary" type="button" onClick={() => setDraft(null)}>Annuler</button>
          <button className="primary" type="submit" disabled={busy !== null}>{busy === "save" ? "Enregistrement…" : "Enregistrer"}</button>
        </div>
      </form>
    </Modal>}
  </div>;
}

/** Changer de saison recharge l'application : chaque écran et chaque extension repart sur la saison choisie. */
export function openSeason(seasonId: string | null) {
  setSelectedSeason(seasonId);
  window.location.reload();
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${value}T12:00:00`));
}
