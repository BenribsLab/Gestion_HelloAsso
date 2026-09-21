/**
 * Normalisation de date de naissance, recopiée du noyau plutôt qu'empruntée : un module doit
 * rester autonome. Sert uniquement à afficher un âge/une catégorie sur la feuille de présence
 * quand `fencing-categories` est active ; la validation de la donnée reste dans le noyau.
 */
export function normalizeBirthDate(value: string | null) {
  if (!value) return null;
  const compact = value.trim();
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(compact);
  const frenchMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(compact);
  const normalized = isoMatch
    ? `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`
    : frenchMatch
      ? `${frenchMatch[3]}-${frenchMatch[2]}-${frenchMatch[1]}`
      : null;
  if (!normalized) return null;
  const date = new Date(`${normalized}T12:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized
    ? null
    : normalized;
}
