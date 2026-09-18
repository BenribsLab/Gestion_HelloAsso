export type DashboardData = {
  membersCount: number;
  groupsCount: number;
  helloasso: {
    configured: boolean;
    environment: "sandbox" | "production";
    organizationSlug: string | null;
  };
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
  source: string;
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
  }>;
  groups: Array<{ id: string; name: string }>;
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

export type CategoryConfiguration = {
  season: string;
  seasonStartYear: number;
  rolloverDate: string;
  items: Array<{
    id: string;
    name: string;
    birthYearFrom: number;
    birthYearTo: number;
    sortOrder: number;
    membersCount: number;
  }>;
};

export type TrainingSchedule = {
  weekday: number;
  startTime: string;
  endTime: string;
};

export type SchoolHoliday = {
  name: string;
  startDate: string;
  endDate: string;
};

export type AttendanceSheet = {
  group: { id: string; name: string; createdAt: string };
  schedules: TrainingSchedule[];
  members: Array<{ id: string; firstName: string; lastName: string; birthDate: string | null; fencingCategory: string | null; categoryError: string | null }>;
  fencingSeason: string;
  holidays: SchoolHoliday[];
  sessions: Array<{ date: string; startTime: string; endTime: string }>;
  attendance: AttendanceRecord[];
  startDate: string;
  endDate: string;
};

export type AttendanceRecord = {
  memberId: string;
  date: string;
  startTime: string;
  status: "present" | "absent" | "excused";
};

export type EmailTarget =
  | { type: "all" }
  | { type: "groups"; groupIds: string[] }
  | { type: "single"; email: string };

export type EmailStatus = {
  configured: boolean;
  host: string;
  port: number;
  secure: boolean;
  fromEmail: string | null;
  fromName: string;
  replyTo: string | null;
};

export type EmailMessageHistory = {
  id: string;
  subject: string;
  targetLabel: string;
  status: "sending" | "sent" | "partial" | "failed";
  recipientsCount: number;
  sentCount: number;
  failedCount: number;
  createdAt: string;
  finishedAt: string | null;
};

let csrfToken: string | null = null;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) {
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
      window.dispatchEvent(new Event("cey-auth-required"));
    }
    throw new Error(body?.message ?? "La requête a échoué.");
  }

  return response.json() as Promise<T>;
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
  members: () => request<{ season: string; items: Member[] }>("/api/members"),
  groups: () => request<{ items: Group[] }>("/api/groups"),
  categories: () => request<CategoryConfiguration>("/api/categories"),
  createCategory: (input: { name: string; birthYearFrom: number; birthYearTo: number }) =>
    request<{ id: string }>("/api/categories", { method: "POST", body: JSON.stringify(input) }),
  updateCategory: (categoryId: string, input: { name: string; birthYearFrom: number; birthYearTo: number }) =>
    request<{ id: string; updated: true }>(`/api/categories/${categoryId}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteCategory: (categoryId: string) =>
    request<{ id: string; deleted: true }>(`/api/categories/${categoryId}`, { method: "DELETE" }),
  updateCategorySettings: (rolloverDate: string) =>
    request<CategoryConfiguration>("/api/categories/settings", {
      method: "PUT",
      body: JSON.stringify({ rolloverDate })
    }),
  groupCriteria: () => request<{ items: GroupCriterion[] }>("/api/group-criteria"),
  createGroup: (input: { name: string; description: string; criterion: { fieldKey: string; values: string[] } }) =>
    request<Group>("/api/groups", { method: "POST", body: JSON.stringify(input) }),
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
  setGroupSchedules: (groupId: string, schedules: TrainingSchedule[]) =>
    request<{ groupId: string; schedules: TrainingSchedule[] }>(`/api/groups/${groupId}/schedules`, {
      method: "PUT",
      body: JSON.stringify({ schedules })
    }),
  schoolHolidays: (startDate: string, endDate: string) =>
    request<{ zone: string; academy: string; items: SchoolHoliday[] }>(
      `/api/school-holidays?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
    ),
  attendanceSheet: (groupId: string, startDate: string, endDate: string) =>
    request<AttendanceSheet>(
      `/api/groups/${groupId}/attendance-sheet?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
    ),
  saveAttendance: (groupId: string, startDate: string, endDate: string, records: AttendanceRecord[]) =>
    request<{ savedCount: number }>(`/api/groups/${groupId}/attendance`, {
      method: "PUT",
      body: JSON.stringify({ startDate, endDate, records })
    }),
  emailStatus: () => request<EmailStatus>("/api/email/status"),
  verifyEmail: () => request<{ connected: true }>("/api/email/verify", { method: "POST" }),
  previewEmailRecipients: (target: EmailTarget) =>
    request<{ targetLabel: string; membersCount: number; recipientsCount: number; withoutEmailCount: number }>(
      "/api/email/recipients-preview",
      { method: "POST", body: JSON.stringify(target) }
    ),
  emailMessages: () => request<{ items: EmailMessageHistory[] }>("/api/email/messages"),
  sendEmailMessage: (input: { subject: string; body: string; target: EmailTarget }) =>
    request<{ messageId: string; status: "sent" | "partial" | "failed"; recipientsCount: number; sentCount: number; failedCount: number }>(
      "/api/email/messages",
      { method: "POST", body: JSON.stringify(input) }
    ),
  checkHelloAsso: () =>
    request<{ connected: true; organization: { name: string; slug: string } }>(
      "/api/helloasso/check",
      { method: "POST" }
    ),
  setup: () => request<SetupData>("/api/setup"),
  discoverCampaigns: () =>
    request<SetupData>("/api/helloasso/discover-campaigns", { method: "POST" }),
  selectCampaigns: (formSlugs: string[]) =>
    request<SetupData>("/api/setup/campaigns", {
      method: "PUT",
      body: JSON.stringify({ formSlugs })
    }),
  selectFields: (fieldKeys: string[]) =>
    request<SetupData>("/api/setup/fields", {
      method: "PUT",
      body: JSON.stringify({ fieldKeys })
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
    request<{ importedCount: number }>("/api/helloasso/import-members", { method: "POST" })
};
