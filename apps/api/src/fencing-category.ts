export function fencingCategoryError(birthDate: string | null, reference = new Date()) {
  if (!birthDate) return "Date de naissance manquante";
  const normalized = normalizeBirthDate(birthDate);
  if (!normalized) return "Date de naissance invalide";
  const value = new Date(`${normalized}T12:00:00Z`);
  const today = new Date(reference.toISOString().slice(0, 10) + "T12:00:00Z");
  if (value > today) return "Date de naissance future";
  const oldest = new Date(today);
  oldest.setUTCFullYear(oldest.getUTCFullYear() - 120);
  if (value < oldest) return "Date de naissance improbable";
  return null;
}

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
