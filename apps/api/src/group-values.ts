export function groupValues(value: unknown, isTier: boolean) {
  const entries = Array.isArray(value) ? value : [value];
  return [...new Set(entries.flatMap((entry) => {
    if (typeof entry === "boolean") return [entry ? "Oui" : "Non"];
    if (typeof entry !== "string" && typeof entry !== "number") return [];
    const normalized = normalizeGroupValue(String(entry), isTier);
    return normalized ? [normalized] : [];
  }))];
}

export function normalizeGroupValue(value: string, isTier: boolean) {
  const compact = value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  if (!isTier) return compact;
  return compact
    .replace(/\s*-\s*paiement(?:(?:\s+en)?\s+\d+\s+fois|\s+par\s+ch[eè]que)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}
