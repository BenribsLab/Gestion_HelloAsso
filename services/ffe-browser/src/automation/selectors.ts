import type { Page } from "playwright";

// Localisateurs centralisés ici, basés sur le rôle accessible et le texte plutôt que sur des
// classes CSS ou des ID (souvent générés par session côté FFE, voir spike-notes/) — plus stables
// face à une refonte du site, et plus faciles à corriger à l'œil par comparaison avec une
// capture d'écran. Issus de la reconnaissance Phase 0 (services/ffe-browser/spike-notes/) ; à
// revérifier si le site change.
export const ffeSelectors = {
  usernameField: (page: Page) => page.getByRole("textbox", { name: "Nom d'utilisateur /" }),
  passwordField: (page: Page) => page.getByRole("textbox", { name: "Mot de passe" }),
  loginButton: (page: Page) => page.getByRole("button", { name: "Me connecter" }),

  choixDunePersonneButton: (page: Page) => page.getByRole("button", { name: /Choix d'une personne/i }),
  // Composant "switchery" (pas un role="switch" natif) — voir spike-notes/.
  dansLaStructureToggle: (page: Page) => page.locator(".switchery").first(),
  searchField: (page: Page) => page.getByRole("textbox").first(),
  rechercherButton: (page: Page) => page.getByRole("button", { name: /Rechercher/i }),
  addNewPersonButton: (page: Page) => page.getByRole("button", { name: /Ajout d'une nouvelle/i }),

  resultsTable: (page: Page) => page.getByRole("table"),
  // Borner les lignes au tableau de résultats : la page FFE contient d'autres composants qui
  // peuvent eux aussi exposer un rôle "row" et décaler l'index de la personne sélectionnée.
  resultsRows: (page: Page) => page.getByRole("table").getByRole("row")
} as const;

export const ffeUrls = {
  login: (baseUrl: string) => `${baseUrl}/auth/login`,
  etape1: (baseUrl: string) => `${baseUrl}/licence/saisie/etape-1`
} as const;
