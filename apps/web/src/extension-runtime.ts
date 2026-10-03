import { request, requestBlob, type Extension } from "./api";
import {
  uiContracts,
  type RegisteredExtensionView,
  type RegisteredGroupPanel,
  type RegisteredMemberAction,
  type RegisteredMemberColumn,
  type RegisteredDocumentPanel,
  type RegisteredMemberDetailPanel
} from "./extension-contracts";

/**
 * API mise à disposition des bundles de modules. Elle est volontairement minuscule : un
 * module ne voit ni React, ni le client d'API complet, seulement de quoi appeler le serveur
 * avec la session en cours et se déclarer auprès du cœur.
 */
export type ExtensionWebHostSeason = { id: string; label: string; startsOn: string; endsOn: string; startYear: number };

export type ExtensionWebHost = {
  /** Saison ouverte dans l'application (changer de saison recharge la page). */
  season: ExtensionWebHostSeason | null;
  request: typeof request;
  requestBlob: typeof requestBlob;
  registerView(view: RegisteredExtensionView): void;
  registerMemberAction(action: RegisteredMemberAction): void;
  registerGroupPanel(panel: RegisteredGroupPanel): void;
  registerMemberColumn(column: RegisteredMemberColumn): void;
  registerDocumentPanel(panel: RegisteredDocumentPanel): void;
  registerMemberDetailPanel(panel: RegisteredMemberDetailPanel): void;
};

declare global {
  interface Window {
    __GU_HOST__?: ExtensionWebHost;
  }
}

const importedBundles = new Set<string>();

export function installExtensionHost() {
  window.__GU_HOST__ ??= {
    season: null,
    request,
    requestBlob,
    registerView: (view) => uiContracts.registerView(view),
    registerMemberAction: (action) => uiContracts.registerMemberAction(action),
    registerGroupPanel: (panel) => uiContracts.registerGroupPanel(panel),
    registerMemberColumn: (column) => uiContracts.registerMemberColumn(column),
    registerDocumentPanel: (panel) => uiContracts.registerDocumentPanel(panel),
    registerMemberDetailPanel: (panel) => uiContracts.registerMemberDetailPanel(panel)
  };
}

export function setHostSeason(season: ExtensionWebHostSeason | null) {
  installExtensionHost();
  window.__GU_HOST__!.season = season;
}

/**
 * Importe le bundle navigateur de chaque module actif. Un module déjà importé n'est pas
 * réimporté : les modules ESM ne se déchargent pas, l'affichage est ensuite filtré selon
 * l'état d'activation.
 */
export async function loadExtensionBundles(extensions: Extension[]) {
  installExtensionHost();
  await Promise.all(extensions.map(async (extension) => {
    const entry = extension.entrypoints?.web;
    if (!entry || !extension.enabled || importedBundles.has(extension.id)) return;
    importedBundles.add(extension.id);
    const base = `/api/extensions/${encodeURIComponent(extension.id)}/assets`;
    try {
      if (extension.entrypoints.styles) {
        loadStylesheet(`${base}/${extension.entrypoints.styles}?v=${extension.version}`);
      }
      await import(/* @vite-ignore */ `${base}/${entry}?v=${extension.version}`);
    } catch (error) {
      // Un module cassé ne doit pas empêcher le reste de l'application de fonctionner.
      importedBundles.delete(extension.id);
      console.error(`Chargement du module ${extension.id} impossible`, error);
    }
  }));
}

function loadStylesheet(href: string) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}
