import { useEffect, useState } from "react";
import { api, type AttestationInput, type MemberAttestationState } from "./api";

/**
 * Attestation de licence annuelle acquittée d'un adhérent : champs préremplis (HelloAsso et
 * fiche), modifiables avant de télécharger le PDF ou de l'envoyer par e-mail.
 */
export function MemberAttestation({ memberId, onClose }: { memberId: string; onClose: () => void }) {
  const [state, setState] = useState<MemberAttestationState | null>(null);
  const [draft, setDraft] = useState<AttestationInput | null>(null);
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState<"pdf" | "email" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.memberAttestation(memberId).then((result) => {
      setState(result); setDraft(result.defaults); setRecipient(result.recipientEmail);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Attestation indisponible."));
  }, [memberId]);

  if (!draft || !state) return error ? <div className="alert error">{error}</div> : <p className="muted">Chargement…</p>;
  const set = (patch: Partial<AttestationInput>) => setDraft((current) => current ? { ...current, ...patch } : current);
  const valid = draft.firstName.trim() && draft.lastName.trim() && draft.season.trim() && draft.date;

  async function download() {
    if (!draft) return;
    setBusy("pdf"); setError(null); setMessage(null);
    try {
      const result = await api.attestationPdf(memberId, draft);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url; link.download = result.fileName ?? "attestation.pdf"; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setMessage("PDF téléchargé : ouvrez-le pour l’imprimer.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Création du PDF impossible.");
    } finally { setBusy(null); }
  }

  async function send() {
    if (!draft) return;
    if (!window.confirm(`Envoyer l’attestation à ${recipient} ?`)) return;
    setBusy("email"); setError(null); setMessage(null);
    try {
      const result = await api.sendAttestation(memberId, { ...draft, to: recipient.trim() });
      setMessage(`Attestation envoyée à ${result.to}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Envoi impossible.");
    } finally { setBusy(null); }
  }

  return <div className="modal-form attestation-form">
    {state.missing.length > 0 && <div className="alert error">À compléter dans Configuration → Identité du club : {state.missing.join(", ")}.</div>}
    {error && <div className="alert error">{error}</div>}
    {message && <div className="alert success">{message}</div>}

    <fieldset>
      <legend>Adhérent</legend>
      <div className="attestation-grid">
        <label>Civilité<select value={draft.memberCivility} onChange={(event) => set({ memberCivility: event.target.value as AttestationInput["memberCivility"] })}><option value="">—</option><option value="M.">M.</option><option value="Mme">Mme</option></select></label>
        <label>Nom<input value={draft.lastName} maxLength={100} onChange={(event) => set({ lastName: event.target.value })} /></label>
        <label>Prénom<input value={draft.firstName} maxLength={100} onChange={(event) => set({ firstName: event.target.value })} /></label>
      </div>
    </fieldset>

    <fieldset>
      <legend>Cotisation</legend>
      <div className="attestation-grid">
        <label>Saison<input value={draft.season} maxLength={20} placeholder="2025/2026" onChange={(event) => set({ season: event.target.value })} /></label>
        <label>Montant (euros)<input type="number" min="0" step="0.01" value={draft.amount ?? ""} placeholder="Non indiqué" onChange={(event) => set({ amount: event.target.value === "" ? null : Number(event.target.value) })} /><small>{state.defaults.amount === null ? "Aucun montant HelloAsso : à saisir." : "Repris de HelloAsso."}</small></label>
        <label>Date de l’attestation<input type="date" value={draft.date} onChange={(event) => set({ date: event.target.value })} /></label>
      </div>
    </fieldset>

    <fieldset>
      <legend>Payeur</legend>
      <div className="attestation-grid">
        <label>Civilité<select value={draft.payerCivility} onChange={(event) => set({ payerCivility: event.target.value as AttestationInput["payerCivility"] })}><option value="">—</option><option value="M.">M.</option><option value="Mme">Mme</option></select></label>
        <label>Nom<input value={draft.payerLastName} maxLength={100} onChange={(event) => set({ payerLastName: event.target.value })} /></label>
        <label>Prénom<input value={draft.payerFirstName} maxLength={100} onChange={(event) => set({ payerFirstName: event.target.value })} /></label>
      </div>
      <small className="muted">Laissez vide pour ne pas mentionner le payeur.</small>
    </fieldset>

    <label>Envoyer à<input type="email" value={recipient} placeholder="adresse@exemple.fr" onChange={(event) => setRecipient(event.target.value)} /><small>{state.mailAvailable ? "E-mail du payeur, à défaut celui de l’adhérent." : "Envoi par e-mail indisponible : activez et configurez l’extension Messagerie Mail."}</small></label>

    {state.history.length > 0 && <details className="attestation-history"><summary>Déjà délivrées ({state.history.length})</summary><ul className="list-rows">{state.history.map((entry) => <li key={`${entry.createdAt}-${entry.delivery}`}>
      <div><strong>{entry.delivery === "email" ? `Envoyée à ${entry.recipientEmail}` : "Téléchargée"}</strong><small>{entry.reference ? `Réf. ${entry.reference} · ` : ""}Saison {entry.season}</small></div>
      <time dateTime={entry.createdAt}>{new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(entry.createdAt))}</time>
    </li>)}</ul></details>}

    <div className="modal-actions">
      <button className="secondary" type="button" onClick={onClose}>Fermer</button>
      <button className="secondary" type="button" disabled={!valid || busy !== null || !state.mailAvailable || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.trim())} onClick={() => void send()}>{busy === "email" ? "Envoi…" : "Envoyer par e-mail"}</button>
      <button className="primary" type="button" disabled={!valid || busy !== null} onClick={() => void download()}>{busy === "pdf" ? "Création…" : "Télécharger le PDF"}</button>
    </div>
  </div>;
}
