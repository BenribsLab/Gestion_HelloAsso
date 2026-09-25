export type DashboardData = {
  membersCount: number;
  groupsCount: number;
  helloasso: {
    configured: boolean;
    environment: "sandbox" | "production";
    organizationSlug: string | null;
  };
};

export type HelloAssoSettings = {
  configured: boolean;
  environment: "sandbox" | "production";
  clientId: string;
  organizationSlug: string;
  secretConfigured: boolean;
  source: "database" | "environment";
  storageReady: boolean;
  updatedAt: string | null;
};

export type Extension = {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  version: string;
  core: { minimum: string; maximum?: string };
  dependencies: string[];
  optionalDependencies: string[];
  capabilities: string[];
  entitlementKey: string;
  defaultEnabled: boolean;
  entrypoints: { server?: string; web?: string; styles?: string };
  migrations: string[];
  routes: string[];
  enabled: boolean;
  source: "bundled" | "local" | "central";
  signatureStatus: "bundled" | "verified" | "unsigned" | "invalid";
  licenseStatus: "local" | "valid" | "grace" | "expired" | "unavailable";
  installedAt: string;
  updatedAt: string;
  errorMessage: string | null;
};

export type ExtensionConfiguration = {
  centralServerConfigured: boolean;
  catalogUrl: string | null;
  offlineGraceDays: number;
  allowUnsigned: boolean;
};

export type ExtensionInstallation = {
  id: string;
  extensionId: string | null;
  version: string | null;
  outcome: "installed" | "failed" | "rolled_back";
  source: "signed" | "developer";
  packageHash: string | null;
  message: string | null;
  createdAt: string;
};

export type AuthUser = {
  id: string | null;
  email: string;
  displayName: string;
  role: "admin";
};

export type AuthSession = {
  user: AuthUser;
  csrfToken: string;
  authEnabled: boolean;
};

export type ManagedUser = {
  id: string;
  email: string;
  displayName: string;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
};

export type Member = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  status: string;
  source: "manual" | "helloasso";
  campaignTitle: string | null;
  tierName: string | null;
  birthDate: string | null;
  fencingCategory: string | null;
  categoryError: string | null;
  overriddenFields: string[];
  customFields: Array<{
    key: string;
    label: string;
    type: string;
    value: unknown;
    overridden: boolean;
    inputMode: "auto" | "text" | "select";
    options: string[];
    document?: {
      available: boolean;
      source: "local" | "helloasso" | null;
      fileName: string | null;
      mediaType: string | null;
      sizeBytes: number | null;
      classification: "certificate" | "attestation" | "questionnaire" | "unknown";
      classificationSource: "automatic" | "manual";
      health: boolean;
      analyzedAt: string | null;
      hasHelloAssoOriginal: boolean;
    };
  }>;
  moduleFields: ModuleField[];
  groups: Array<{ id: string; name: string }>;
};

export type MemberField = {
  key: string;
  label: string;
  type: "Text" | "Email" | "Phone" | "Date" | "YesNo" | "File" | string;
  source: "local" | "helloasso";
  documentRole: "health" | null;
  inputMode: "auto" | "text" | "select";
  options: string[];
};

export type ModuleField = {
  key: string;
  label: string;
  type: string;
  storage: "profileData" | "moduleData";
  source: "helloasso" | "module";
  inputMode: "text" | "select";
  options: string[];
  usages: Array<{ extensionId: string; description: string }>;
  value?: unknown;
  overridden?: boolean;
};

export type SetupData = {
  campaigns: Array<{
    formSlug: string;
    title: string;
    state: string;
    startDate: string | null;
    endDate: string | null;
    selected: boolean;
    current: boolean;
    fieldsCount: number;
  }>;
  fields: Array<{
    key: string;
    label: string;
    type: string;
    selected: boolean;
    documentRole: "health" | null;
    campaignCount: number;
  }>;
  coreFields: Array<{ key: string; label: string }>;
  completedAt: string | null;
  groupsConfiguredAt: string | null;
  groupDefinitions: GroupDefinition[];
  lastSync: {
    status: "running" | "succeeded" | "failed";
    importedCount: number;
    finishedAt: string | null;
    errorMessage: string | null;
  } | null;
};

export type GroupRule = {
  fieldKey: string;
  value: string;
};

export type GroupDefinition = {
  id: string;
  name: string;
  rules: GroupRule[];
};

export type GroupingPreview = {
  sources: Array<{
    key: string;
    label: string;
    type: string;
    values: Array<{ value: string; count: number }>;
  }>;
};

export type Group = {
  id: string;
  name: string;
  description: string | null;
  source: "manual" | "helloasso" | "dynamic";
  membersCount: number;
  createdAt: string;
  dynamicRule: { fieldKey: string; values: string[] } | null;
  trainingSchedules: TrainingSchedule[];
};

export type GroupCriterion = {
  key: string;
  label: string;
  type: string;
  source: "helloasso" | "calculated";
  values: Array<{ value: string; count: number }>;
};

export type TrainingSchedule = {
  weekday: number;
  startTime: string;
  endTime: string;
};

let csrfToken: string | null = null;

/** Exporté pour que les bundles de modules réutilisent la session et le jeton CSRF du cœur. */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }
  const method = (init?.method ?? "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken && path !== "/api/auth/login") {
    headers.set("x-csrf-token", csrfToken);
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin"
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    if (response.status === 401 && path !== "/api/auth/login" && path !== "/api/auth/session") {
      csrfToken = null;
      window.dispatchEvent(new Event("gu-auth-required"));
    }
    throw new Error(body?.message ?? "La requête a échoué.");
  }

  return response.json() as Promise<T>;
}

/** Exporté pour que les bundles de modules puissent télécharger un fichier binaire produit par le serveur. */
export async function requestBlob(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  const method = (init?.method ?? "GET").toUpperCase();
  if (init?.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) headers.set("x-csrf-token", csrfToken);
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? (response.status === 502 || response.status === 504
      ? "Le proxy a interrompu le traitement avant la fin."
      : `La requête a échoué (erreur ${response.status}).`));
  }
  return {
    blob: await response.blob(),
    fileName: dispositionFileName(response.headers.get("content-disposition"))
  };
}

export const api = {
  session: async () => {
    const result = await request<AuthSession>("/api/auth/session");
    csrfToken = result.csrfToken;
    return result;
  },
  login: async (email: string, password: string) => {
    const result = await request<{ user: AuthUser; csrfToken: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    csrfToken = result.csrfToken;
    return result;
  },
  logout: async () => {
    const result = await request<{ loggedOut: true }>("/api/auth/logout", { method: "POST" });
    csrfToken = null;
    return result;
  },
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ changed: true }>("/api/auth/password", {
      method: "PUT",
      body: JSON.stringify({ currentPassword, newPassword })
    }),
  users: () => request<{ items: ManagedUser[] }>("/api/auth/users"),
  createUser: (input: { email: string; displayName: string; password: string }) =>
    request<{ id: string }>("/api/auth/users", { method: "POST", body: JSON.stringify(input) }),
  disableUser: (userId: string) =>
    request<{ id: string; disabled: true }>(`/api/auth/users/${userId}`, { method: "DELETE" }),
  dashboard: () => request<DashboardData>("/api/dashboard"),
  extensions: () => request<{ items: Extension[]; configuration: ExtensionConfiguration }>("/api/extensions"),
  setExtensionEnabled: (extensionId: string, enabled: boolean) =>
    request<Extension>(`/api/extensions/${encodeURIComponent(extensionId)}`, {
      method: "PUT",
      body: JSON.stringify({ enabled })
    }),
  installExtension: (file: File) => {
    const body = new FormData(); body.append("file", file);
    return request<{ id: string; version: string; signatureStatus: string; restartScheduled: boolean }>(
      "/api/extensions/install", { method: "POST", body }
    );
  },
  extensionInstallations: () => request<{ items: ExtensionInstallation[] }>("/api/extensions/installations"),
  extensionRollbacks: (extensionId: string) => request<{ items: Array<{ directory: string; version: string }> }>(`/api/extensions/${extensionId}/rollbacks`),
  rollbackExtension: (extensionId: string, directory: string) => request<{ id: string; version: string; restartScheduled: boolean }>(`/api/extensions/${extensionId}/rollback`, { method: "POST", body: JSON.stringify({ directory }) }),
  members: () => request<{ items: Member[]; fields: MemberField[]; moduleFields: ModuleField[] }>("/api/members"),
  createMember: (input: {
    firstName: string;
    lastName: string;
    email: string;
    profileData?: Record<string, string | number | boolean | null>;
    moduleData?: Record<string, string | number | boolean | null>;
    groupIds?: string[];
  }) => request<{ memberId: string; source: "manual" }>("/api/members", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  deleteMember: (memberId: string) =>
    request<{ memberId: string; deleted: true; source: "manual" | "helloasso" }>(`/api/members/${memberId}`, {
      method: "DELETE"
    }),
  createMemberField: (input: { label: string; type: "Text" | "Email" | "Phone" | "Date" | "YesNo" | "ChoiceList" | "File"; options?: string[] }) =>
    request<MemberField>("/api/member-fields", { method: "POST", body: JSON.stringify(input) }),
  updateMemberFieldInput: (fieldKey: string, input: { inputMode: "text" | "select"; options: string[] }) =>
    request<MemberField>(`/api/member-fields/${encodeURIComponent(fieldKey)}/input`, { method: "PUT", body: JSON.stringify(input) }),
  groups: () => request<{ items: Group[] }>("/api/groups"),
  groupCriteria: () => request<{ items: GroupCriterion[] }>("/api/group-criteria"),
  createGroup: (input: { name: string; description: string; criterion: { fieldKey: string; values: string[] } | null }) =>
    request<Group>("/api/groups", { method: "POST", body: JSON.stringify(input) }),
  addGroupMembers: (groupId: string, memberIds: string[]) =>
    request<{ groupId: string; added: number }>(`/api/groups/${groupId}/members`, { method: "POST", body: JSON.stringify({ memberIds }) }),
  deleteGroup: (groupId: string) =>
    request<{ groupId: string; deleted: true }>(`/api/groups/${groupId}`, { method: "DELETE" }),
  setMemberGroups: (memberId: string, groupIds: string[]) =>
    request<{ memberId: string; groupIds: string[] }>(`/api/members/${memberId}/groups`, {
      method: "PUT",
      body: JSON.stringify({ groupIds })
    }),
  updateMember: (memberId: string, input: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    birthDate?: string;
    profileData?: Record<string, string | number | boolean | null>;
    moduleData?: Record<string, string | number | boolean | null>;
    groupIds?: string[];
  }) => request<{ memberId: string; protectedLocally: true }>(`/api/members/${memberId}`, {
    method: "PUT",
    body: JSON.stringify(input)
  }),
  revertMemberField: (memberId: string, fieldKey: string) =>
    request<{ memberId: string; fieldKey: string; revertedToHelloAsso: true }>(
      `/api/members/${memberId}/overrides/${encodeURIComponent(fieldKey)}`,
      { method: "DELETE" }
    ),
  checkHelloAsso: () =>
    request<{ connected: true; organization: { name: string; slug: string } }>(
      "/api/helloasso/check",
      { method: "POST" }
    ),
  helloassoSettings: () => request<HelloAssoSettings>("/api/settings/helloasso"),
  saveHelloAssoSettings: (input: {
    environment: "sandbox" | "production";
    clientId: string;
    clientSecret?: string;
    organizationSlug: string;
    confirmOrganizationChange?: boolean;
  }) => request<HelloAssoSettings>("/api/settings/helloasso", {
    method: "PUT",
    body: JSON.stringify(input)
  }),
  resetHelloAssoSettings: () => request<HelloAssoSettings>("/api/settings/helloasso", {
    method: "DELETE",
    body: JSON.stringify({ confirm: true })
  }),
  setup: () => request<SetupData>("/api/setup"),
  discoverCampaigns: () =>
    request<SetupData>("/api/helloasso/discover-campaigns", { method: "POST" }),
  selectCampaigns: (formSlugs: string[]) =>
    request<SetupData>("/api/setup/campaigns", {
      method: "PUT",
      body: JSON.stringify({ formSlugs })
    }),
  selectFields: (fieldKeys: string[], healthDocumentFieldKey: string | null) =>
    request<SetupData>("/api/setup/fields", {
      method: "PUT",
      body: JSON.stringify({ fieldKeys, healthDocumentFieldKey })
    }),
  previewGrouping: (fieldKeys: string[]) =>
    request<GroupingPreview>("/api/setup/group-preview", {
      method: "POST",
      body: JSON.stringify({ fieldKeys })
    }),
  saveGroupDefinitions: (
    groups: Array<{ id?: string; name: string; rules: GroupRule[] }>
  ) =>
    request<SetupData>("/api/setup/groups", {
      method: "PUT",
      body: JSON.stringify({ groups })
    }),
  importMembers: () =>
    request<{ importedCount: number }>("/api/helloasso/import-members", { method: "POST" }),
  uploadMemberDocument: (memberId: string, fieldKey: string, file: File) => {
    const body = new FormData(); body.append("file", file);
    return request<{ uploaded: true; classification: "certificate" | "attestation" | "questionnaire" | "unknown" }>(
      `/api/members/${memberId}/documents/${encodeURIComponent(fieldKey)}`,
      { method: "POST", body }
    );
  },
  revertMemberDocument: (memberId: string, fieldKey: string) =>
    request<{ revertedToHelloAsso: true }>(
      `/api/members/${memberId}/documents/${encodeURIComponent(fieldKey)}/local`, { method: "DELETE" }
    ),
  memberDocumentUrl: (memberId: string, fieldKey: string, download = false) =>
    `/api/members/${memberId}/documents/${encodeURIComponent(fieldKey)}${download ? "?download=1" : ""}`
};

function dispositionFileName(value: string | null) {
  if (!value) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (encoded) try { return decodeURIComponent(encoded); } catch { /* repli */ }
  return /filename="?([^";]+)"?/i.exec(value)?.[1] ?? null;
}
