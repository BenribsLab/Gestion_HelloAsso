export interface FfeSearchCandidate {
  adherentCode: string;
  name: string;
  birthYear: number;
  rowIndex: number;
}

export interface MemberToMatch {
  firstName: string;
  lastName: string;
  birthYear: number;
}

export type MatchResult =
  | { outcome: "matched"; candidate: FfeSearchCandidate; mode: "exact" | "fuzzy_name_exact_year" }
  | { outcome: "no_match" }
  | { outcome: "ambiguous"; candidates: FfeSearchCandidate[] };

// Le tableau de résultats FFE n'affiche que l'année de naissance, jamais la date complète (voir
// spike-notes/phase-0-reconnaissance.md) — la correspondance ne peut donc se faire qu'à ce
// niveau de précision à ce stade. La date complète n'est vérifiable qu'après sélection, par
// l'utilisateur, sur étape-2.
// Le tableau de résultats FFE préfixe le nom par une civilité ("M GARNIER Tom", vu pendant la
// reconnaissance) — absente du nom/prénom connu côté adhérent, donc à retirer avant comparaison.
const civilityPrefixPattern = /^(M|MME|MLLE)\s+/;

export function normalizeName(value: string): string {
  const upper = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z\s-]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleUpperCase("fr");
  return upper.replace(civilityPrefixPattern, "");
}

export function findBestMatch(member: MemberToMatch, candidates: FfeSearchCandidate[]): MatchResult {
  const targetName = normalizeName(`${member.lastName} ${member.firstName}`);
  const sameYear = candidates.filter((candidate) => candidate.birthYear === member.birthYear);
  if (sameYear.length === 0) return { outcome: "no_match" };

  const exact = sameYear.filter((candidate) => normalizeName(candidate.name) === targetName);
  if (exact.length === 1) return { outcome: "matched", candidate: exact[0]!, mode: "exact" };
  if (exact.length > 1) return { outcome: "ambiguous", candidates: exact };

  // Tolérance d'orthographe bornée, uniquement combinée à une année de naissance exacte —
  // jamais sur le nom seul, pour ne pas risquer de faire correspondre deux personnes distinctes.
  const fuzzy = sameYear.filter(
    (candidate) => levenshteinDistance(normalizeName(candidate.name), targetName) <= 2
  );
  if (fuzzy.length === 1) return { outcome: "matched", candidate: fuzzy[0]!, mode: "fuzzy_name_exact_year" };
  if (fuzzy.length > 1) return { outcome: "ambiguous", candidates: fuzzy };

  return { outcome: "no_match" };
}

function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const distances: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) distances[i]![0] = i;
  for (let j = 0; j < cols; j += 1) distances[0]![j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      distances[i]![j] = Math.min(
        distances[i - 1]![j]! + 1,
        distances[i]![j - 1]! + 1,
        distances[i - 1]![j - 1]! + cost
      );
    }
  }
  return distances[rows - 1]![cols - 1]!;
}
