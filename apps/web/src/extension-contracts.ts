export type ExtensionEnabledLookup = (extensionId: string) => boolean;

interface UiGate {
  extensionId: string;
}

/**
 * Cache un élément (colonne de liste, cible Documents IRL, vue de navigation, ...) tant
 * que l'extension qui le fournit n'est pas active, sans que App.tsx ait besoin de connaître
 * l'identifiant de l'extension à l'endroit où l'élément est consommé.
 */
class UiFeatureGateRegistry {
  private readonly gates = new Map<string, UiGate>();

  register(key: string, gate: UiGate) {
    this.gates.set(key, gate);
  }

  isVisible(key: string, isExtensionEnabled: ExtensionEnabledLookup) {
    const gate = this.gates.get(key);
    return !gate || isExtensionEnabled(gate.extensionId);
  }
}

/** Vue de premier niveau apportée par un bundle de module chargé à l'exécution. */
export type RegisteredExtensionView = {
  extensionId: string;
  label: string;
  /** Nom de l'élément personnalisé que le bundle a défini. */
  element: string;
};

/** Adhérent tel qu'il est présenté aux actions contribuées par un module. */
export type MemberActionSubject = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
};

/**
 * Bouton ajouté par un module dans la fiche adhérent. Cliquer dessus ouvre la vue du module
 * en lui transmettant la charge utile renvoyée par `payloadFor`.
 */
export type RegisteredMemberAction = {
  extensionId: string;
  label: string;
  /** `null` quand l'action n'a pas de sens pour cet adhérent (le bouton est alors désactivé). */
  payloadFor(member: MemberActionSubject): unknown | null;
};

/**
 * Panneau qu'un module ajoute à l'intérieur d'une vue du cœur — ici l'onglet réglages de la
 * fenêtre Groupe. Contrairement à `registerView` (une page entière derrière un seul point de
 * montage), c'est un fragment injecté au milieu d'une vue que le cœur continue de dessiner.
 */
export type RegisteredGroupPanel = {
  extensionId: string;
  label: string;
  element: string;
};

export type ExtensionMemberSubject = {
  id: string;
  firstName: string;
  lastName: string;
  customFields: Array<Record<string, unknown>>;
};

export type RegisteredMemberColumn = {
  extensionId: string;
  key: string;
  label: string;
  element: string;
  filterValue(member: ExtensionMemberSubject): string;
};

export type RegisteredDocumentPanel = {
  extensionId: string;
  element: string;
};

/**
 * Panneau qu'un module ajoute directement dans la fiche adhérent (l'écran "Modifier
 * <adhérent>"), à côté des champs du noyau — pas un bouton qui ouvre une vue séparée
 * (`registerMemberAction`), un fragment affiché en permanence sur place.
 */
export type RegisteredMemberDetailPanel = {
  extensionId: string;
  label: string;
  element: string;
};

const registeredViews: RegisteredExtensionView[] = [];
const registeredMemberActions: RegisteredMemberAction[] = [];
const registeredGroupPanels: RegisteredGroupPanel[] = [];
const registeredMemberColumns: RegisteredMemberColumn[] = [];
const registeredDocumentPanels: RegisteredDocumentPanel[] = [];
const registeredMemberDetailPanels: RegisteredMemberDetailPanel[] = [];

/**
 * Contrats déclarés par les extensions et consultés par App.tsx à la place des identifiants
 * d'extension écrits en dur.
 */
export const uiContracts = {
  views: new UiFeatureGateRegistry(),
  memberColumns: new UiFeatureGateRegistry(),
  irlTargets: new UiFeatureGateRegistry(),

  registerView(view: RegisteredExtensionView) {
    const existing = registeredViews.findIndex((entry) => entry.extensionId === view.extensionId);
    if (existing >= 0) registeredViews.splice(existing, 1, view);
    else registeredViews.push(view);
  },

  /**
   * Un bundle déjà importé ne peut pas être déchargé : on filtre donc sur l'état courant,
   * ce qui permet aussi de réactiver un module sans recharger la page.
   */
  listViews(isExtensionEnabled: ExtensionEnabledLookup) {
    return registeredViews.filter((view) => isExtensionEnabled(view.extensionId));
  },

  registerMemberAction(action: RegisteredMemberAction) {
    const existing = registeredMemberActions.findIndex(
      (entry) => entry.extensionId === action.extensionId && entry.label === action.label
    );
    if (existing >= 0) registeredMemberActions.splice(existing, 1, action);
    else registeredMemberActions.push(action);
  },

  listMemberActions(isExtensionEnabled: ExtensionEnabledLookup) {
    return registeredMemberActions.filter((action) => isExtensionEnabled(action.extensionId));
  },

  registerGroupPanel(panel: RegisteredGroupPanel) {
    const existing = registeredGroupPanels.findIndex((entry) => entry.extensionId === panel.extensionId);
    if (existing >= 0) registeredGroupPanels.splice(existing, 1, panel);
    else registeredGroupPanels.push(panel);
  },

  listGroupPanels(isExtensionEnabled: ExtensionEnabledLookup) {
    return registeredGroupPanels.filter((panel) => isExtensionEnabled(panel.extensionId));
  },

  registerMemberColumn(column: RegisteredMemberColumn) {
    const index = registeredMemberColumns.findIndex((entry) => entry.extensionId === column.extensionId && entry.key === column.key);
    if (index >= 0) registeredMemberColumns.splice(index, 1, column); else registeredMemberColumns.push(column);
  },

  listMemberColumns(isExtensionEnabled: ExtensionEnabledLookup) {
    return registeredMemberColumns.filter((column) => isExtensionEnabled(column.extensionId));
  },

  registerDocumentPanel(panel: RegisteredDocumentPanel) {
    const index = registeredDocumentPanels.findIndex((entry) => entry.extensionId === panel.extensionId);
    if (index >= 0) registeredDocumentPanels.splice(index, 1, panel); else registeredDocumentPanels.push(panel);
  },

  listDocumentPanels(isExtensionEnabled: ExtensionEnabledLookup) {
    return registeredDocumentPanels.filter((panel) => isExtensionEnabled(panel.extensionId));
  },

  registerMemberDetailPanel(panel: RegisteredMemberDetailPanel) {
    const index = registeredMemberDetailPanels.findIndex((entry) => entry.extensionId === panel.extensionId);
    if (index >= 0) registeredMemberDetailPanels.splice(index, 1, panel); else registeredMemberDetailPanels.push(panel);
  },

  listMemberDetailPanels(isExtensionEnabled: ExtensionEnabledLookup) {
    return registeredMemberDetailPanels.filter((panel) => isExtensionEnabled(panel.extensionId));
  }
};
