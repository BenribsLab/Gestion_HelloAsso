import { type FormEvent, useEffect, useState } from "react";
import { api, type ClubAssetKind, type ClubIdentity, type ClubIdentityState } from "./api";

const assetLabels: Record<ClubAssetKind, { title: string; hint: string }> = {
  logo: { title: "Logo du club", hint: "En-tête des attestations." },
  signature: { title: "Signature", hint: "Scan de la signature, idéalement sur fond transparent (PNG)." },
  stamp: { title: "Tampon du club", hint: "Scan du tampon, idéalement sur fond transparent (PNG)." }
};

const headerPresets = [
  { color: "#eef2ea", label: "Sauge clair (par défaut)" },
  { color: "#ffffff", label: "Blanc" },
  { color: "#f1f3f5", label: "Gris perle" },
  { color: "#f5efe4", label: "Sable" },
  { color: "#e8eef7", label: "Bleu pâle" },
  { color: "#10263f", label: "Bleu nuit" },
  { color: "#0b2629", label: "Vert profond" }
];

/** Même règle que le PDF : texte clair sur un fond sombre. */
function isDark(hex: string) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return false;
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(match[1]!.slice(offset, offset + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.45;
}

/**
 * Identité du club (Configuration) : textes et images apposés sur les attestations de licence.
 * Signature et tampon sont facultatifs : seuls ceux déposés apparaissent sur le document.
 */
export function ClubIdentityPanel() {
  const [state, setState] = useState<ClubIdentityState | null>(null);
  const [draft, setDraft] = useState<ClubIdentity | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const next = await api.clubIdentity();
      setState(next); setDraft(next.identity);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Identité du club indisponible.");
    }
  }
  useEffect(() => { void load(); }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy("save"); setError(null); setMessage(null);
    try { await api.saveClubIdentity(draft); await load(); setMessage("Identité du club enregistrée."); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Enregistrement impossible."); }
    finally { setBusy(null); }
  }

  async function upload(kind: ClubAssetKind, file: File | undefined) {
    if (!file) return;
    setBusy(kind); setError(null); setMessage(null);
    try { await api.uploadClubAsset(kind, file); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Image refusée."); }
    finally { setBusy(null); }
  }

  async function remove(kind: ClubAssetKind) {
    if (!window.confirm(`Retirer l’image « ${assetLabels[kind].title} » ?`)) return;
    setBusy(kind); setError(null);
    try { await api.deleteClubAsset(kind); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Suppression impossible."); }
    finally { setBusy(null); }
  }

  if (!draft || !state) return <section className="panel club-identity">{error ? <div className="alert error">{error}</div> : <p className="muted">Chargement…</p>}</section>;
  const field = (key: keyof ClubIdentity) => ({
    value: draft[key],
    onChange: (event: { target: { value: string } }) => setDraft((current) => current ? { ...current, [key]: event.target.value } : current)
  });

  return <section className="panel club-identity">
    <div className="section-heading"><div><p className="eyebrow">Attestations</p><h2>Identité du club</h2><p className="muted">Ces informations et images figurent sur les attestations de licence remises aux adhérents (bouton « Attestation » de la fiche).</p></div></div>
    {error && <div className="alert error">{error}</div>}
    {message && <div className="alert success">{message}</div>}
    <form className="club-identity-form" onSubmit={(event) => void save(event)}>
      <label>Nom du club<input maxLength={150} placeholder="Cercle d’Escrime de Valmont" {...field("clubName")} /></label>
      <label>Ville<input maxLength={100} placeholder="Valmont" {...field("city")} /><small>Pour « Fait à Valmont, le … ».</small></label>
      <label>Signataire<input maxLength={120} placeholder="Madame Claire Martin" {...field("signatoryName")} /><small>Commencez par Madame ou Monsieur pour accorder « Je soussigné(e) ».</small></label>
      <label>Qualité du signataire<input maxLength={200} placeholder="présidente du Cercle d’Escrime de Valmont" {...field("signatoryRole")} /><small>Suit le nom : « …, présidente du Cercle d’Escrime de Valmont, certifie que… ».</small></label>
      <label>Intitulé au-dessus de la signature<input maxLength={80} placeholder="La Présidente" {...field("signatureLabel")} /></label>
      <label>Nom sous la signature<input maxLength={120} placeholder="Claire MARTIN" {...field("signatureName")} /></label>
      <fieldset className="header-color-field">
        <legend>Fond de l’en-tête</legend>
        <div className="header-swatches" role="radiogroup" aria-label="Fond de l’en-tête">
          {headerPresets.map((preset) => <button key={preset.color} type="button" role="radio" aria-checked={draft.headerColor.toLowerCase() === preset.color} title={preset.label}
            className={`header-swatch${draft.headerColor.toLowerCase() === preset.color ? " is-selected" : ""}`} style={{ background: preset.color }}
            onClick={() => setDraft((current) => current ? { ...current, headerColor: preset.color } : current)}><span className="sr-only">{preset.label}</span></button>)}
          <label className="header-custom-color" title="Autre couleur"><input type="color" value={draft.headerColor} onChange={(event) => setDraft((current) => current ? { ...current, headerColor: event.target.value } : current)} /><span>Autre…</span></label>
        </div>
        <div className="header-preview" style={{ background: draft.headerColor, color: isDark(draft.headerColor) ? "#ffffff" : "#0b2629" }}>
          {state.assets.logo && <img src={`/api/club-identity/assets/logo?v=${encodeURIComponent(state.assets.logo)}`} alt="" />}
          <div><strong>{draft.clubName || "Nom du club"}</strong>{draft.city && <small>{draft.city.toUpperCase()}</small>}</div>
          <span>Réf. 2026-0001</span>
        </div>
        <small>Aperçu de l’en-tête. Un logo sur fond transparent (PNG) se pose directement sur cette couleur ; choisissez un fond clair pour un logo noir.</small>
      </fieldset>
      <div className="club-identity-actions"><button className="primary" type="submit" disabled={busy !== null}>{busy === "save" ? "Enregistrement…" : "Enregistrer"}</button></div>
    </form>
    <div className="club-assets">
      {(Object.keys(assetLabels) as ClubAssetKind[]).map((kind) => {
        const updatedAt = state.assets[kind];
        return <article className="club-asset" key={kind}>
          <div className="club-asset-preview">{updatedAt ? <img src={`/api/club-identity/assets/${kind}?v=${encodeURIComponent(updatedAt)}`} alt={assetLabels[kind].title} /> : <span className="muted">Aucune image</span>}</div>
          <div className="club-asset-copy"><strong>{assetLabels[kind].title}</strong><small>{assetLabels[kind].hint}</small></div>
          <div className="club-asset-actions">
            <label className="secondary compact-button file-button">{busy === kind ? "Envoi…" : updatedAt ? "Remplacer" : "Déposer"}<input type="file" accept="image/png,image/jpeg" disabled={busy !== null} onChange={(event) => { void upload(kind, event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label>
            {updatedAt && <button className="danger-link" type="button" disabled={busy !== null} onClick={() => void remove(kind)}>Retirer</button>}
          </div>
        </article>;
      })}
    </div>
    <p className="muted club-identity-note">PNG ou JPEG, 3 Mo maximum. Sans signature ni tampon, l’attestation garde un espace vide pour signer à la main.</p>
  </section>;
}
