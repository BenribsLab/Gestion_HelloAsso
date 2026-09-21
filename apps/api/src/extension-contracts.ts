import type { ExtensionMemberView, ExtensionQueryable } from "./extension-host.js";

export interface ExtensionGate {
  extensionId: string;
}

/**
 * Cache un élément (critère de groupe, cible IRL, ...) tant que l'extension qui le fournit
 * n'est pas active, sans que le noyau ait besoin de connaître l'identifiant de l'extension
 * à l'endroit où l'élément est consommé.
 */
export class FeatureGateRegistry<TKey extends string = string> {
  private readonly gates = new Map<TKey, ExtensionGate>();

  register(key: TKey, gate: ExtensionGate) {
    this.gates.set(key, gate);
  }

  isVisible(key: TKey, isExtensionEnabled: (extensionId: string) => boolean) {
    const gate = this.gates.get(key);
    return Boolean(gate && isExtensionEnabled(gate.extensionId));
  }
}

export interface MemberCategoryFields {
  fencingCategory: string | null;
  categoryError: string | null;
}

export interface MemberCategoryProvider<TContext = unknown> {
  extensionId: string;
  /** `reference` permet de calculer la catégorie à une date donnée (feuille de présence). */
  loadContext(database: ExtensionQueryable, reference?: Date): Promise<TContext>;
  season(context: TContext): string;
  /** Catégories connues pour la saison, pour valider une sélection. */
  values(context: TContext): string[];
  compute(birthDate: string | null, context: TContext): MemberCategoryFields;
}

/** Ce que le noyau manipule une fois le module de catégories interrogé. */
export type MemberCategoryContext = {
  season: string;
  values: string[];
  compute(birthDate: string | null): MemberCategoryFields;
};

export interface GroupCriterionDefinition {
  key: string;
  label: string;
  type: string;
}

/**
 * Critère de constitution de groupe apporté par un module (ex. « Catégorie FFE »). Le noyau
 * ne sait ni le calculer ni énumérer ses valeurs : il délègue entièrement au module.
 */
export interface GroupCriterionProvider<TContext = unknown> {
  extensionId: string;
  criterion: GroupCriterionDefinition;
  loadContext(database: ExtensionQueryable): Promise<TContext>;
  /** Valeurs possibles, dans l'ordre d'affichage. */
  values(context: TContext): string[];
  /** Valeurs de cet adhérent pour ce critère. */
  memberValues(member: ExtensionMemberView, context: TContext): string[];
}

export type ResolvedGroupCriterion = {
  criterion: GroupCriterionDefinition;
  values: string[];
  memberValues(member: ExtensionMemberView): string[];
};

export type GroupTrainingSchedule = { weekday: number; startTime: string; endTime: string };

/**
 * Créneaux d'entraînement d'un groupe, apportés par un module. Le noyau n'interroge plus
 * jamais `group_training_schedules` directement : il demande au module de les fournir pour
 * enrichir `/api/groups`, `[]` quand le module est absent ou désactivé.
 */
export interface GroupScheduleProvider<TContext = unknown> {
  extensionId: string;
  loadContext(database: ExtensionQueryable): Promise<TContext>;
  schedulesByGroup(context: TContext): Map<string, GroupTrainingSchedule[]>;
}

export type HealthDocumentClassification = "certificate" | "attestation" | "questionnaire" | "unknown";
export type HealthDocumentInput = {
  content: Buffer;
  mediaType: "application/pdf" | "image/jpeg" | "image/png";
  fileName: string;
  source: "local" | "helloasso";
};

/** Reconnaissance OCR apportée par Documents Santé FFE, sans dépendance du cœur vers le module. */
export interface HealthDocumentProvider {
  extensionId: string;
  analysisVersion: number;
  analyze(document: HealthDocumentInput, knownHash: string): Promise<{
    classification: HealthDocumentClassification;
    hash: string;
  }>;
}

/**
 * Contrats déclarés par les extensions et consultés par le noyau. Chaque extension
 * s'enregistre ici au démarrage ; le noyau ne référence plus son identifiant en dur.
 */
export class ExtensionContracts {
  readonly irlTargets = new FeatureGateRegistry();
  private memberCategoryProvider: MemberCategoryProvider | null = null;
  private groupScheduleProvider: GroupScheduleProvider | null = null;
  private healthDocumentProvider: HealthDocumentProvider | null = null;
  private readonly groupCriterionProviders = new Map<string, GroupCriterionProvider>();

  registerGroupCriterionProvider<TContext>(provider: GroupCriterionProvider<TContext>) {
    this.groupCriterionProviders.set(provider.criterion.key, provider as GroupCriterionProvider);
  }

  /** Clés apportées par un module, quel que soit son état : sert à repérer un critère indisponible. */
  contributedCriterionKeys() {
    return [...this.groupCriterionProviders.keys()];
  }

  async loadGroupCriteria(
    database: ExtensionQueryable,
    isExtensionEnabled: (extensionId: string) => boolean
  ): Promise<ResolvedGroupCriterion[]> {
    const resolved: ResolvedGroupCriterion[] = [];
    for (const provider of this.groupCriterionProviders.values()) {
      if (!isExtensionEnabled(provider.extensionId)) continue;
      const context = await provider.loadContext(database);
      resolved.push({
        criterion: provider.criterion,
        values: provider.values(context),
        memberValues: (member: ExtensionMemberView) => provider.memberValues(member, context)
      });
    }
    return resolved;
  }

  registerMemberCategoryProvider<TContext>(provider: MemberCategoryProvider<TContext>) {
    this.memberCategoryProvider = provider as MemberCategoryProvider;
  }

  async loadMemberCategoryContext(
    database: ExtensionQueryable,
    isExtensionEnabled: (extensionId: string) => boolean,
    reference?: Date
  ): Promise<MemberCategoryContext | null> {
    const provider = this.memberCategoryProvider;
    if (!provider || !isExtensionEnabled(provider.extensionId)) return null;
    const context = await provider.loadContext(database, reference);
    return {
      season: provider.season(context),
      values: provider.values(context),
      compute: (birthDate: string | null) => provider.compute(birthDate, context)
    };
  }

  registerGroupScheduleProvider<TContext>(provider: GroupScheduleProvider<TContext>) {
    this.groupScheduleProvider = provider as GroupScheduleProvider;
  }

  async loadGroupSchedules(
    database: ExtensionQueryable,
    isExtensionEnabled: (extensionId: string) => boolean
  ): Promise<Map<string, GroupTrainingSchedule[]>> {
    const provider = this.groupScheduleProvider;
    if (!provider || !isExtensionEnabled(provider.extensionId)) return new Map();
    const context = await provider.loadContext(database);
    return provider.schedulesByGroup(context);
  }

  registerHealthDocumentProvider(provider: HealthDocumentProvider) {
    this.healthDocumentProvider = provider;
  }

  healthDocumentAnalysisVersion(isExtensionEnabled: (extensionId: string) => boolean) {
    const provider = this.healthDocumentProvider;
    return provider && isExtensionEnabled(provider.extensionId) ? provider.analysisVersion : null;
  }

  async analyzeHealthDocument(
    document: HealthDocumentInput,
    knownHash: string,
    isExtensionEnabled: (extensionId: string) => boolean
  ) {
    const provider = this.healthDocumentProvider;
    if (!provider || !isExtensionEnabled(provider.extensionId)) return null;
    const result = await provider.analyze(document, knownHash);
    return { ...result, analysisVersion: provider.analysisVersion };
  }
}
