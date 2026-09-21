import type { Page } from "playwright";
import { ffeSelectors, ffeUrls } from "./selectors.js";
import { findBestMatch, type FfeSearchCandidate, type MemberToMatch } from "./matching.js";

export class FfeSelectorNotFoundError extends Error {}
export class FfeUnexpectedPageError extends Error {}

export interface SelectPersonInput extends MemberToMatch {
  inStructureLast5Seasons: boolean;
}

export type SelectPersonResult =
  | { landed: "etape-2"; match: FfeSearchCandidate; mode: "exact" | "fuzzy_name_exact_year" }
  | { landed: "etape-2-ajout" }
  | { landed: "ambiguous"; candidates: FfeSearchCandidate[] };

export async function parseResultsList(page: Page): Promise<FfeSearchCandidate[]> {
  const rows = await ffeSelectors.resultsRows(page).all();
  const candidates: FfeSearchCandidate[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const cells = await rows[index]!.getByRole("cell").allTextContents();
    // Une ligne d'en-tête n'a pas de role "cell" (des "columnheader") : count() serait 0, elle
    // est donc naturellement ignorée ici plutôt que détectée explicitement.
    if (cells.length < 3) continue;
    const [adherentCode, name, birthYearText] = cells;
    const birthYear = Number.parseInt(birthYearText ?? "", 10);
    if (!adherentCode?.trim() || !name?.trim() || Number.isNaN(birthYear)) continue;
    candidates.push({ adherentCode: adherentCode.trim(), name: name.trim(), birthYear, rowIndex: index });
  }
  return candidates;
}

/**
 * Déroulé silencieux (jamais montré à l'utilisateur) : recherche, correspondance, puis
 * sélection ou création. S'arrête dès l'atterrissage sur étape-2 (ou étape-2/ajout) — tout ce
 * qui suit est diffusé en direct, voir server.ts.
 */
export async function selectPerson(page: Page, baseUrl: string, input: SelectPersonInput): Promise<SelectPersonResult> {
  await page.goto(ffeUrls.etape1(baseUrl), { waitUntil: "domcontentloaded" });
  await ffeSelectors.choixDunePersonneButton(page).click();

  const toggle = ffeSelectors.dansLaStructureToggle(page);
  if (input.inStructureLast5Seasons) await toggle.check();
  else await toggle.uncheck();

  await ffeSelectors.searchField(page).fill(`${input.lastName} ${input.firstName}`);
  await ffeSelectors.rechercherButton(page).click();
  await page.waitForLoadState("networkidle");

  const candidates = await parseResultsList(page);
  const match = findBestMatch(input, candidates);

  if (match.outcome === "ambiguous") return { landed: "ambiguous", candidates: match.candidates };

  if (match.outcome === "no_match") {
    await ffeSelectors.addNewPersonButton(page).click();
    await page.waitForURL(/etape-2\/ajout/);
    return { landed: "etape-2-ajout" };
  }

  const rows = await ffeSelectors.resultsRows(page).all();
  const row = rows[match.candidate.rowIndex];
  if (!row) throw new FfeSelectorNotFoundError("Ligne de résultat introuvable après correspondance.");
  await row.getByRole("cell", { name: String(match.candidate.birthYear) }).click();
  await page.waitForURL(/etape-2$/);
  return { landed: "etape-2", match: match.candidate, mode: match.mode };
}

export interface NewPersonInput {
  firstName: string;
  lastName: string;
  /** Format JJ/MM/AAAA attendu par le champ FFE — déjà formaté par l'appelant. */
  birthDateDisplay: string;
  email?: string | undefined;
  phone?: string | undefined;
  mobile?: string | undefined;
  address?: {
    numero?: string | undefined;
    nomVoie?: string | undefined;
    codePostal?: string | undefined;
    commune?: string | undefined;
  } | undefined;
}

/**
 * Pré-remplit ce qui est identifié de façon fiable. Civilité, nationalité, lieu de naissance
 * (listes déroulantes à identifiants générés par session, voir spike-notes/) et représentant
 * légal (mineurs) sont volontairement laissés à l'utilisateur : aucun sélecteur stable identifié
 * pendant la reconnaissance, et cette page est de toute façon revue en direct avant validation.
 */
export async function fillNewPersonForm(page: Page, input: NewPersonInput): Promise<void> {
  await page.locator('input[name="nom"]').fill(input.lastName);
  await page.locator('input[name="prenom"]').fill(input.firstName);
  await page.getByRole("textbox", { name: "__/__/____" }).fill(input.birthDateDisplay);
  if (input.email) await page.locator('input[name="adresse[mail]"]').fill(input.email);
  if (input.phone) await page.locator('input[name="adresse[tel]"]').fill(input.phone);
  if (input.mobile) await page.locator('input[name="adresse[mobile]"]').fill(input.mobile);
  if (input.address?.numero) await page.locator('input[name="adresse[num_voie]"]').fill(input.address.numero);
  if (input.address?.nomVoie) await page.locator('input[name="adresse[nom_voie]"]').fill(input.address.nomVoie);
  if (input.address?.codePostal) await page.locator('input[name="adresse[code_postal]"]').fill(input.address.codePostal);
  if (input.address?.commune) await page.locator('input[name="adresse[commune_libre]"]').fill(input.address.commune);
}

/** Navigue vers l'écran de connexion FFE — utilisé pour démarrer une connexion diffusée. */
export async function goToLogin(page: Page, baseUrl: string): Promise<void> {
  await page.goto(ffeUrls.login(baseUrl), { waitUntil: "domcontentloaded" });
}
