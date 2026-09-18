import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AttendanceRecord, type AttendanceSheet, type AuthUser, type CategoryConfiguration, type DashboardData, type EmailMessageHistory, type EmailStatus, type EmailTarget, type Group, type GroupCriterion, type ManagedUser, type Member, type SchoolHoliday, type TrainingSchedule } from "./api";
import { Setup } from "./Setup";

type View = "dashboard" | "members" | "categories" | "groups" | "documents" | "messages" | "attendance" | "setup";
type MemberDraft = {
  firstName: string;
  lastName: string;
  customValues: Record<string, string>;
};

export function App() {
  const [view, setView] = useState<View>("dashboard");
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupCriteria, setGroupCriteria] = useState<GroupCriterion[]>([]);
  const [categoryConfiguration, setCategoryConfiguration] = useState<CategoryConfiguration | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [groupCriterionKey, setGroupCriterionKey] = useState("");
  const [groupCriterionValues, setGroupCriterionValues] = useState<Set<string>>(new Set());
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [deletingGroupId, setDeletingGroupId] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [savingMemberId, setSavingMemberId] = useState<string | null>(null);
  const [savingScheduleGroupId, setSavingScheduleGroupId] = useState<string | null>(null);
  const [messageRecipient, setMessageRecipient] = useState<{ email: string; name: string } | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(true);
  const [accountOpen, setAccountOpen] = useState(false);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [dashboardData, memberData, groupData, criteriaData, categoryData] = await Promise.all([
        api.dashboard(),
        api.members(),
        api.groups(),
        api.groupCriteria(),
        api.categories()
      ]);
      setDashboard(dashboardData);
      setMembers(memberData.items);
      setGroups(groupData.items);
      setGroupCriteria(criteriaData.items);
      setCategoryConfiguration(categoryData);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Impossible de charger l'application.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const requireAuthentication = () => {
      if (!active) return;
      setAuthUser(null);
      setAuthReady(true);
      setLoading(false);
      setAccountOpen(false);
    };
    window.addEventListener("cey-auth-required", requireAuthentication);
    void api.session()
      .then(async (session) => {
        if (!active) return;
        setAuthUser(session.user);
        setAuthEnabled(session.authEnabled);
        setAuthReady(true);
        await loadData();
      })
      .catch(requireAuthentication);
    return () => {
      active = false;
      window.removeEventListener("cey-auth-required", requireAuthentication);
    };
  }, [loadData]);

  async function checkConnection() {
    setCheckingConnection(true);
    setConnectionMessage(null);
    try {
      const result = await api.checkHelloAsso();
      setConnectionMessage(`Connexion réussie avec ${result.organization.name}.`);
    } catch (connectionError) {
      setConnectionMessage(
        connectionError instanceof Error ? connectionError.message : "La connexion a échoué."
      );
    } finally {
      setCheckingConnection(false);
    }
  }

  async function createGroup(event: FormEvent) {
    event.preventDefault();
    setCreatingGroup(true);
    setError(null);
    try {
      await api.createGroup({
        name: groupName,
        description: groupDescription,
        criterion: { fieldKey: groupCriterionKey, values: [...groupCriterionValues] }
      });
      setGroupName("");
      setGroupDescription("");
      setGroupCriterionKey("");
      setGroupCriterionValues(new Set());
      await loadData();
      return true;
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Impossible de créer le groupe.");
      return false;
    } finally {
      setCreatingGroup(false);
    }
  }

  async function deleteGroup(group: Group) {
    const confirmed = window.confirm(
      `Supprimer le groupe « ${group.name} » ?\n\nSes affectations, ses créneaux et ses présences enregistrées seront supprimés localement. Cette action est irréversible.`
    );
    if (!confirmed) return;
    setDeletingGroupId(group.id);
    setError(null);
    try {
      await api.deleteGroup(group.id);
      setSelectedGroupId(null);
      await loadData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Impossible de supprimer ce groupe.");
    } finally {
      setDeletingGroupId(null);
    }
  }

  async function updateMemberGroups(memberId: string, groupIds: string[]) {
    setSavingMemberId(memberId);
    setError(null);
    try {
      await api.setMemberGroups(memberId, groupIds);
      await loadData();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Impossible de modifier les groupes de cet adhérent.");
    } finally {
      setSavingMemberId(null);
    }
  }

  async function updateMember(memberId: string, draft: MemberDraft, groupIds: string[]) {
    setSavingMemberId(memberId);
    setError(null);
    try {
      const member = members.find((item) => item.id === memberId);
      if (!member) throw new Error("Cet adhérent n'existe plus.");
      const currentGroupIds = member.groups.map((group) => group.id).sort();
      const selectedGroupIds = [...groupIds].sort();
      const groupsChanged = currentGroupIds.length !== selectedGroupIds.length || currentGroupIds.some(
        (groupId, index) => groupId !== selectedGroupIds[index]
      );
      await api.updateMember(memberId, {
        ...memberChanges(member, draft),
        ...(groupsChanged ? { groupIds } : {})
      });
      await loadData();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Impossible de modifier cet adhérent.");
      throw updateError;
    } finally {
      setSavingMemberId(null);
    }
  }

  async function revertMemberField(memberId: string, fieldKey: string) {
    setSavingMemberId(memberId);
    setError(null);
    try {
      await api.revertMemberField(memberId, fieldKey);
      await loadData();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Impossible de restaurer la valeur HelloAsso.");
      throw updateError;
    } finally {
      setSavingMemberId(null);
    }
  }

  async function updateGroupSchedules(groupId: string, schedules: TrainingSchedule[]) {
    setSavingScheduleGroupId(groupId);
    setError(null);
    try {
      await api.setGroupSchedules(groupId, schedules);
      await loadData();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Impossible d'enregistrer les créneaux.");
    } finally {
      setSavingScheduleGroupId(null);
    }
  }

  function navigate(nextView: View) {
    setSelectedGroupId(null);
    if (nextView === "messages") setMessageRecipient(null);
    setView(nextView);
  }

  function composeEmail(member: Member) {
    if (!member.email) return;
    setMessageRecipient({ email: member.email, name: `${member.firstName} ${member.lastName}` });
    setSelectedGroupId(null);
    setView("messages");
  }

  async function login(email: string, password: string) {
    const result = await api.login(email, password);
    setAuthUser(result.user);
    setAuthEnabled(true);
    setAuthReady(true);
    setLoading(true);
    await loadData();
  }

  async function logout() {
    try {
      await api.logout();
    } finally {
      setAuthUser(null);
      setAccountOpen(false);
      setDashboard(null);
      setMembers([]);
      setGroups([]);
    }
  }

  if (!authReady) return <div className="app-loading-screen"><span className="brand-mark">GU</span><p>Ouverture sécurisée…</p></div>;
  if (!authUser) return <LoginScreen onLogin={login} />;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">GU</span>
          <div>
            <strong>Gestion club</strong>
            <small>Adhérents & groupes</small>
          </div>
        </div>
        <nav aria-label="Navigation principale">
          <NavButton active={view === "dashboard"} onClick={() => navigate("dashboard")}>
            Vue d'ensemble
          </NavButton>
          <NavButton active={view === "members"} onClick={() => navigate("members")}>
            Adhérents
          </NavButton>
          <NavButton active={view === "categories"} onClick={() => navigate("categories")}>
            Catégories
          </NavButton>
          <NavButton active={view === "groups"} onClick={() => navigate("groups")}>
            Groupes
          </NavButton>
          <NavButton active={view === "documents"} onClick={() => navigate("documents")}>
            Documents
          </NavButton>
          <NavButton active={view === "messages"} onClick={() => navigate("messages")}>
            Messages
          </NavButton>
          <NavButton active={view === "attendance"} onClick={() => navigate("attendance")}>
            Feuilles de présence
          </NavButton>
          <NavButton active={view === "setup"} onClick={() => navigate("setup")}>
            Configuration
          </NavButton>
        </nav>
        <div className="local-badge"><span /> {authEnabled ? "Accès protégé" : "Mode local"}</div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">Saison en préparation</p>
            <h1>{viewTitle(view)}</h1>
          </div>
          {authEnabled ? <button className="initials account-button" type="button" aria-label="Ouvrir mon compte" title={authUser.email} onClick={() => setAccountOpen(true)}>{userInitials(authUser)}</button> : <div className="initials" aria-label="Compte administrateur local">AD</div>}
        </header>

        {error && <div className="alert error">{error}</div>}
        {loading ? (
          <div className="loading">Chargement du serveur local…</div>
        ) : (
          <>
            {view === "dashboard" && dashboard && (
              <Dashboard
                data={dashboard}
                checkingConnection={checkingConnection}
                connectionMessage={connectionMessage}
                onCheckConnection={() => void checkConnection()}
              />
            )}
            {view === "members" && <Members members={members} groups={groups} savingMemberId={savingMemberId} onSaveMember={updateMember} onRevertField={revertMemberField} onDocumentsChanged={loadData} onComposeEmail={composeEmail} />}
            {view === "categories" && categoryConfiguration && <Categories configuration={categoryConfiguration} onChanged={loadData} />}
            {view === "groups" && (
              <Groups
                groups={groups}
                groupCriteria={groupCriteria}
                members={members}
                selectedGroupId={selectedGroupId}
                savingMemberId={savingMemberId}
                savingScheduleGroupId={savingScheduleGroupId}
                groupName={groupName}
                groupDescription={groupDescription}
                groupCriterionKey={groupCriterionKey}
                groupCriterionValues={groupCriterionValues}
                creating={creatingGroup}
                deletingGroupId={deletingGroupId}
                onNameChange={setGroupName}
                onDescriptionChange={setGroupDescription}
                onCriterionChange={(key) => { setGroupCriterionKey(key); setGroupCriterionValues(new Set()); }}
                onCriterionValueToggle={(value) => setGroupCriterionValues((current) => toggledSet(current, value))}
                onSubmit={createGroup}
                onDeleteGroup={(group) => void deleteGroup(group)}
                onSelectGroup={setSelectedGroupId}
                onMoveMember={updateMemberGroups}
                onSaveMember={updateMember}
                onRevertField={revertMemberField}
                onDocumentsChanged={loadData}
                onSaveSchedules={updateGroupSchedules}
                onComposeEmail={composeEmail}
              />
            )}
            {view === "documents" && <Documents groups={groups} />}
            {view === "messages" && <Messages groups={groups} initialRecipient={messageRecipient} />}
            {view === "attendance" && <Attendance groups={groups} />}
            {view === "setup" && dashboard && (
              <Setup
                helloassoConfigured={dashboard.helloasso.configured}
                onImported={() => void loadData()}
              />
            )}
          </>
        )}
        {accountOpen && <Modal title="Mon compte" eyebrow="Sécurité" size="large" onClose={() => setAccountOpen(false)}><AccountPanel user={authUser} onLogout={() => void logout()} /></Modal>}
      </main>
    </div>
  );
}

function NavButton({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button className={active ? "active" : ""} onClick={onClick} type="button">
      {children}
    </button>
  );
}

function LoginScreen({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      await onLogin(email, password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Connexion impossible.");
    } finally {
      setBusy(false);
    }
  }

  return <main className="login-screen">
    <section className="login-card">
      <div className="login-brand"><span className="brand-mark">GU</span><div><strong>Gestion club</strong><small>Cercle d'Escrime de Yerres</small></div></div>
      <div><p className="eyebrow">Espace privé</p><h1>Connexion</h1><p className="muted">Accès réservé aux responsables autorisés du club.</p></div>
      {error && <div className="alert error" role="alert">{error}</div>}
      <form onSubmit={submit}>
        <label>Adresse e-mail<input autoFocus required type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Mot de passe<input required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <button className="primary" type="submit" disabled={busy || !email || !password}>{busy ? "Connexion…" : "Se connecter"}</button>
      </form>
      <p className="login-security">Connexion chiffrée · Session privée · Accès journalisé</p>
    </section>
  </main>;
}

function AccountPanel({ user, onLogout }: { user: AuthUser; onLogout: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [newUserName, setNewUserName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");

  const loadUsers = useCallback(async () => {
    try { setUsers((await api.users()).items); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Impossible de charger les comptes."); }
  }, []);
  useEffect(() => { void loadUsers(); }, [loadUsers]);

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmation) { setError("Les deux nouveaux mots de passe sont différents."); return; }
    setBusy(true); setError(null); setMessage(null);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword(""); setNewPassword(""); setConfirmation("");
      setMessage("Mot de passe modifié. Les autres sessions ont été déconnectées.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible de modifier le mot de passe.");
    } finally { setBusy(false); }
  }

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null); setMessage(null);
    try {
      await api.createUser({ email: newUserEmail, displayName: newUserName, password: newUserPassword });
      setNewUserName(""); setNewUserEmail(""); setNewUserPassword("");
      setMessage("Compte administrateur créé.");
      await loadUsers();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible de créer ce compte.");
    } finally { setBusy(false); }
  }

  async function disableUser(managedUser: ManagedUser) {
    if (!window.confirm(`Désactiver le compte de ${managedUser.displayName} ?\n\nToutes ses sessions seront immédiatement fermées.`)) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await api.disableUser(managedUser.id);
      setMessage("Compte désactivé et sessions révoquées.");
      await loadUsers();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible de désactiver ce compte.");
    } finally { setBusy(false); }
  }

  return <div className="account-panel">
    <div className="account-identity"><span className="initials">{userInitials(user)}</span><div><strong>{user.displayName}</strong><p>{user.email}</p></div><button className="secondary" type="button" onClick={onLogout}>Se déconnecter</button></div>
    {error && <div className="alert error">{error}</div>}
    {message && <div className="alert success">{message}</div>}
    <form onSubmit={changePassword}>
      <h3>Changer le mot de passe</h3>
      <p className="muted">Utilisez au moins 14 caractères et un mot de passe unique.</p>
      <label>Mot de passe actuel<input required type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
      <label>Nouveau mot de passe<input required minLength={14} maxLength={256} type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
      <label>Confirmer le nouveau mot de passe<input required minLength={14} maxLength={256} type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
      <div className="editor-actions"><button className="primary" type="submit" disabled={busy || newPassword.length < 14 || newPassword !== confirmation}>{busy ? "Modification…" : "Modifier le mot de passe"}</button></div>
    </form>
    <section className="user-management">
      <div><h3>Administrateurs</h3><p className="muted">Chaque responsable doit utiliser son propre compte.</p></div>
      <div className="managed-user-list">{users.map((managedUser) => <article key={managedUser.id} className={!managedUser.active ? "disabled" : ""}><div><strong>{managedUser.displayName}{managedUser.id === user.id ? " · vous" : ""}</strong><span>{managedUser.email}</span><small>{managedUser.lastLoginAt ? `Dernière connexion : ${formatDateTime(managedUser.lastLoginAt)}` : "Jamais connecté"}</small></div>{managedUser.active && managedUser.id !== user.id && <button className="danger-link" type="button" disabled={busy} onClick={() => void disableUser(managedUser)}>Désactiver</button>}</article>)}</div>
      <form onSubmit={createUser}>
        <h3>Ajouter un responsable</h3>
        <label>Nom affiché<input required minLength={2} maxLength={100} value={newUserName} onChange={(event) => setNewUserName(event.target.value)} /></label>
        <label>Adresse e-mail<input required type="email" autoComplete="off" value={newUserEmail} onChange={(event) => setNewUserEmail(event.target.value)} /></label>
        <label>Mot de passe initial<input required type="password" minLength={14} maxLength={256} autoComplete="new-password" value={newUserPassword} onChange={(event) => setNewUserPassword(event.target.value)} /></label>
        <div className="editor-actions"><button className="primary" type="submit" disabled={busy || newUserPassword.length < 14}>{busy ? "Création…" : "Créer le compte"}</button></div>
      </form>
    </section>
  </div>;
}

function userInitials(user: AuthUser) {
  const parts = user.displayName.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}` : user.displayName.slice(0, 2)).toLocaleUpperCase("fr");
}

function Modal({
  title,
  eyebrow,
  size = "medium",
  onClose,
  children
}: {
  title: string;
  eyebrow?: string;
  size?: "medium" | "large" | "wide";
  onClose: () => void;
  children: ReactNode;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  useEffect(() => overlay.current?.focus(), []);

  return <div
    className="modal-overlay"
    role="presentation"
    tabIndex={-1}
    ref={overlay}
    onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
  >
    <section className={`modal-window modal-${size}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="modal-header">
        <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2></div>
        <button className="modal-close" type="button" aria-label="Fermer" onClick={onClose}>×</button>
      </header>
      <div className="modal-body">{children}</div>
    </section>
  </div>;
}

function ListSearch({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <div className="list-search"><span aria-hidden="true">⌕</span><input aria-label="Recherche rapide" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />{value && <button type="button" aria-label="Effacer la recherche" onClick={() => onChange("")}>×</button>}</div>;
}

function FilterInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <input className="column-filter" aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} placeholder="Filtrer…" />;
}

function ChoiceFilter({ label, options, selection, onToggle, onClear }: {
  label: string;
  options: string[];
  selection: Set<string>;
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  return <details className="choice-filter">
    <summary title={`Filtrer : ${label}`}><span>{selection.size === 0 ? "Tous" : `${selection.size} choisi${selection.size > 1 ? "s" : ""}`}</span><span aria-hidden="true">⌄</span></summary>
    <div className="choice-filter-menu">
      <div className="choice-filter-heading"><strong>{label}</strong>{selection.size > 0 && <button type="button" onClick={onClear}>Tout effacer</button>}</div>
      <div className="choice-filter-options">{options.map((option) => <label key={option}><input type="checkbox" checked={selection.has(option)} onChange={() => onToggle(option)} /><span>{option}</span></label>)}</div>
    </div>
  </details>;
}

function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange }: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return <div className="pagination">
    <span>{start}–{end} sur {total}</span>
    <label>Afficher<select value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}>{[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
    <div className="pagination-nav"><button className="secondary compact-button" type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>‹ Précédente</button><strong>Page {page} / {pageCount}</strong><button className="secondary compact-button" type="button" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}>Suivante ›</button></div>
  </div>;
}

function includesText(value: string, query: string) {
  if (!query.trim()) return true;
  return normalizeText(value).includes(normalizeText(query));
}

function normalizeText(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").trim();
}

function matchesSelected(values: string[], selection: Set<string>) {
  return selection.size === 0 || values.some((value) => selection.has(value));
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "fr", { sensitivity: "base" }));
}

function memberCategoryLabel(member: Pick<Member, "fencingCategory" | "categoryError">) {
  return member.categoryError || !member.fencingCategory ? "À corriger" : member.fencingCategory;
}

function memberContactLabel(member: Pick<Member, "email" | "phone">) {
  return member.email ?? (member.phone ? formatPhoneNumber(member.phone) : "Sans contact");
}

type HealthDocumentState = {
  label: string;
  tone: "valid" | "warning" | "unknown" | "missing";
};

function memberHealthDocumentState(member: Pick<Member, "customFields">): HealthDocumentState {
  const configured = member.customFields
    .map((field) => field.document)
    .filter((document) => document?.health);
  const available = configured.filter((document) => document?.available);
  if (available.some((document) => document?.classification === "certificate")) {
    return { label: "Certificat", tone: "valid" };
  }
  if (available.some((document) => document?.classification === "attestation")) {
    return { label: "Attestation", tone: "valid" };
  }
  if (available.some((document) => document?.classification === "questionnaire")) {
    return { label: "Questionnaire à remplacer", tone: "warning" };
  }
  if (available.length > 0) return { label: "Document à classer", tone: "unknown" };
  return { label: configured.length > 0 ? "Non fourni" : "Non configuré", tone: "missing" };
}

function HealthDocumentBadge({ member }: { member: Pick<Member, "customFields"> }) {
  const state = memberHealthDocumentState(member);
  return <span className={`health-document-badge ${state.tone}`}>{state.label}</span>;
}

function formatPhoneNumber(value: string) {
  const compact = value.trim().replace(/[\s.-]/g, "");
  if (/^\+33\d{9}$/.test(compact)) {
    const national = compact.slice(3);
    return `+33 ${national[0]} ${national.slice(1).match(/\d{2}/g)?.join(" ") ?? ""}`.trim();
  }
  if (/^\d{10}$/.test(compact)) return compact.match(/\d{2}/g)?.join(" ") ?? value;
  if (/^\d+$/.test(compact)) return compact.match(/.{1,2}/g)?.join(" ") ?? value;
  return value;
}

function groupInitials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toLocaleUpperCase("fr")).join("") || "G";
}

function Dashboard({
  data,
  checkingConnection,
  connectionMessage,
  onCheckConnection
}: {
  data: DashboardData;
  checkingConnection: boolean;
  connectionMessage: string | null;
  onCheckConnection: () => void;
}) {
  return (
    <div className="page-stack">
      <section className="stat-grid" aria-label="Résumé">
        <StatCard value={data.membersCount} label="Adhérents" hint="Enregistrés localement" />
        <StatCard value={data.groupsCount} label="Groupes" hint="Organisation du club" />
        <StatCard
          value={data.helloasso.configured ? "Prêt" : "À configurer"}
          label="HelloAsso"
          hint={data.helloasso.environment === "sandbox" ? "Environnement de test" : "Production"}
        />
      </section>

      <section className="panel connection-panel">
        <div>
          <p className="eyebrow">Connexion externe</p>
          <h2>HelloAsso</h2>
          <p className="muted">
            Les identifiants restent dans le conteneur serveur et ne sont jamais envoyés à ce navigateur.
          </p>
          {data.helloasso.organizationSlug && (
            <p className="slug">Association : {data.helloasso.organizationSlug}</p>
          )}
          {connectionMessage && <p className="connection-message">{connectionMessage}</p>}
        </div>
        <button
          className="primary"
          type="button"
          disabled={!data.helloasso.configured || checkingConnection}
          onClick={onCheckConnection}
        >
          {checkingConnection ? "Vérification…" : "Tester la connexion"}
        </button>
      </section>

      <section className="panel next-step">
        <span className="step-number">01</span>
        <div>
          <h2>Prochaine étape</h2>
          <p>
            Connecter le formulaire d'adhésion réel, examiner ses tarifs et ses champs, puis définir précisément
            comment une participation HelloAsso devient une fiche adhérent.
          </p>
        </div>
      </section>
    </div>
  );
}

function StatCard({ value, label, hint }: { value: number | string; label: string; hint: string }) {
  return (
    <article className="stat-card">
      <strong>{value}</strong>
      <h2>{label}</h2>
      <p>{hint}</p>
    </article>
  );
}

function Categories({ configuration, onChanged }: { configuration: CategoryConfiguration; onChanged: () => Promise<void> }) {
  const [newName, setNewName] = useState("");
  const [newFrom, setNewFrom] = useState(configuration.seasonStartYear - 10);
  const [newTo, setNewTo] = useState(configuration.seasonStartYear - 9);
  const [rolloverDate, setRolloverDate] = useState(configuration.rolloverDate);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setRolloverDate(configuration.rolloverDate), [configuration.rolloverDate]);

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setBusy("settings"); setError(null);
    try {
      await api.updateCategorySettings(rolloverDate);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible de modifier la date de changement de saison.");
    } finally { setBusy(null); }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy("new"); setError(null);
    try {
      await api.createCategory({ name: newName, birthYearFrom: newFrom, birthYearTo: newTo });
      setNewName("");
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible d'ajouter cette catégorie.");
    } finally { setBusy(null); }
  }

  async function update(category: CategoryConfiguration["items"][number], input: { name: string; birthYearFrom: number; birthYearTo: number }) {
    setBusy(category.id); setError(null);
    try {
      await api.updateCategory(category.id, input);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible de modifier cette catégorie.");
      throw reason;
    } finally { setBusy(null); }
  }

  async function remove(category: CategoryConfiguration["items"][number]) {
    if (!window.confirm(`Supprimer la catégorie « ${category.name} » pour la saison ${configuration.season} ?\n\nLes groupes automatiques utilisant cette catégorie seront recalculés.`)) return;
    setBusy(category.id); setError(null);
    try {
      await api.deleteCategory(category.id);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible de supprimer cette catégorie.");
    } finally { setBusy(null); }
  }

  const [rolloverMonth = 9, rolloverDay = 1] = rolloverDate.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(2000, rolloverMonth, 0)).getUTCDate();

  return <div className="categories-page">
    {error && <div className="alert error">{error}</div>}
    <section className="panel category-settings">
      <div><p className="eyebrow">Saison active</p><h2>{configuration.season}</h2><p className="muted">La nouvelle saison reprend automatiquement ce tableau et décale toutes les années de naissance de +1.</p></div>
      <form onSubmit={saveSettings}>
        <label>Changement de saison<div className="rollover-fields"><select value={rolloverDay} onChange={(event) => setRolloverDate(`${String(rolloverMonth).padStart(2, "0")}-${String(Number(event.target.value)).padStart(2, "0")}`)}>{Array.from({ length: daysInMonth }, (_, index) => index + 1).map((day) => <option key={day} value={day}>{day}</option>)}</select><select value={rolloverMonth} onChange={(event) => { const month = Number(event.target.value); const maxDay = new Date(Date.UTC(2000, month, 0)).getUTCDate(); setRolloverDate(`${String(month).padStart(2, "0")}-${String(Math.min(rolloverDay, maxDay)).padStart(2, "0")}`); }}>{monthNames.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}</select></div></label>
        <button className="secondary" type="submit" disabled={busy !== null || rolloverDate === configuration.rolloverDate}>{busy === "settings" ? "Enregistrement…" : "Enregistrer la date"}</button>
      </form>
    </section>

    <section className="panel">
      <div className="section-heading"><div><p className="eyebrow">Correspondances</p><h2>Catégories de la saison</h2></div><span className="count-pill">{configuration.items.length}</span></div>
      <div className="table-wrap"><table className="category-table">
        <thead><tr><th>Nom</th><th>Première année de naissance</th><th>Dernière année de naissance</th><th>Adhérents</th><th /></tr></thead>
        <tbody>{configuration.items.map((category) => <CategoryEditorRow key={category.id} category={category} busy={busy === category.id} disabled={busy !== null && busy !== category.id} onSave={(input) => update(category, input)} onDelete={() => void remove(category)} />)}</tbody>
      </table></div>
    </section>

    <section className="panel category-create">
      <div><p className="eyebrow">Nouvelle</p><h2>Ajouter une catégorie</h2></div>
      <form onSubmit={create}>
        <label>Nom<input required maxLength={50} value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="Ex. Loisirs jeunes" /></label>
        <label>Première année<input required type="number" min="1900" max="2200" value={newFrom} onChange={(event) => setNewFrom(Number(event.target.value))} /></label>
        <label>Dernière année<input required type="number" min={newFrom} max="2200" value={newTo} onChange={(event) => setNewTo(Number(event.target.value))} /></label>
        <button className="primary" type="submit" disabled={busy !== null || !newName.trim() || newFrom > newTo}>{busy === "new" ? "Ajout…" : "Ajouter la catégorie"}</button>
      </form>
    </section>
  </div>;
}

function CategoryEditorRow({ category, busy, disabled, onSave, onDelete }: {
  category: CategoryConfiguration["items"][number];
  busy: boolean;
  disabled: boolean;
  onSave: (input: { name: string; birthYearFrom: number; birthYearTo: number }) => Promise<void>;
  onDelete: () => void;
}) {
  const [name, setName] = useState(category.name);
  const [birthYearFrom, setBirthYearFrom] = useState(category.birthYearFrom);
  const [birthYearTo, setBirthYearTo] = useState(category.birthYearTo);
  useEffect(() => { setName(category.name); setBirthYearFrom(category.birthYearFrom); setBirthYearTo(category.birthYearTo); }, [category]);
  const changed = name.trim() !== category.name || birthYearFrom !== category.birthYearFrom || birthYearTo !== category.birthYearTo;
  return <tr><td><input aria-label={`Nom de ${category.name}`} value={name} maxLength={50} onChange={(event) => setName(event.target.value)} /></td><td><input aria-label={`Première année de ${category.name}`} type="number" min="1900" max="2200" value={birthYearFrom} onChange={(event) => setBirthYearFrom(Number(event.target.value))} /></td><td><input aria-label={`Dernière année de ${category.name}`} type="number" min={birthYearFrom} max="2200" value={birthYearTo} onChange={(event) => setBirthYearTo(Number(event.target.value))} /></td><td><span className="count-pill">{category.membersCount}</span></td><td className="category-actions"><button className="secondary compact-button" type="button" disabled={disabled || busy || !changed || !name.trim() || birthYearFrom > birthYearTo} onClick={() => void onSave({ name: name.trim(), birthYearFrom, birthYearTo })}>{busy ? "…" : "Enregistrer"}</button><button className="danger-link" type="button" disabled={disabled || busy} onClick={onDelete}>Supprimer</button></td></tr>;
}

function Members({
  members,
  groups,
  savingMemberId,
  onSaveMember,
  onRevertField,
  onDocumentsChanged,
  onComposeEmail
}: {
  members: Member[];
  groups: Group[];
  savingMemberId: string | null;
  onSaveMember: (memberId: string, draft: MemberDraft, groupIds: string[]) => Promise<void>;
  onRevertField: (memberId: string, fieldKey: string) => Promise<void>;
  onDocumentsChanged: () => Promise<void>;
  onComposeEmail: (member: Member) => void;
}) {
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<MemberDraft | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [filters, setFilters] = useState({
    name: "",
    category: new Set<string>(),
    healthDocument: new Set<string>(),
    groups: new Set<string>()
  });
  const editingMember = members.find((member) => member.id === editingMemberId) ?? null;
  const filterOptions = useMemo(() => ({
    category: uniqueSorted(members.map(memberCategoryLabel)),
    healthDocument: uniqueSorted(members.map((member) => memberHealthDocumentState(member).label)),
    groups: uniqueSorted(members.flatMap((member) => member.groups.length ? member.groups.map((group) => group.name) : ["Aucun groupe"]))
  }), [members]);
  const filteredMembers = useMemo(() => members.filter((member) => {
    const values = {
      name: `${member.lastName} ${member.firstName}`,
      category: memberCategoryLabel(member),
      contact: memberContactLabel(member),
      healthDocument: memberHealthDocumentState(member).label,
      groups: member.groups.length ? member.groups.map((group) => group.name) : ["Aucun groupe"]
    };
    return includesText([values.name, values.category, values.contact, values.healthDocument, ...values.groups].join(" "), search)
      && includesText(values.name, filters.name)
      && matchesSelected([values.category], filters.category)
      && matchesSelected([values.healthDocument], filters.healthDocument)
      && matchesSelected(values.groups, filters.groups);
  }), [members, search, filters]);
  const pageCount = Math.max(1, Math.ceil(filteredMembers.length / pageSize));
  const visibleMembers = filteredMembers.slice((page - 1) * pageSize, page * pageSize);

  useEffect(() => setPage(1), [search, filters, pageSize]);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);

  useEffect(() => {
    if (!editingMember) return;
    setSelection(new Set(editingMember.groups.map((group) => group.id)));
    setDraft(memberDraft(editingMember));
  }, [editingMember]);

  function edit(member: Member) {
    setEditingMemberId(member.id);
    setSelection(new Set(member.groups.map((group) => group.id)));
    setDraft(memberDraft(member));
  }

  async function save(memberId: string) {
    if (!draft) return;
    try {
      await onSaveMember(memberId, draft, [...selection]);
      setEditingMemberId(null);
    } catch {
      // L'erreur est affichée au niveau de l'application, l'éditeur reste ouvert.
    }
  }

  async function revert(memberId: string, fieldKey: string) {
    try {
      await onRevertField(memberId, fieldKey);
    } catch {
      // L'erreur est affichée au niveau de l'application, l'éditeur reste ouvert.
    }
  }

  return (
    <section className="panel directory-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Répertoire</p>
          <h2>Liste des adhérents</h2>
        </div>
        <span className="count-pill">{filteredMembers.length} / {members.length}</span>
      </div>
      {members.length === 0 ? (
        <EmptyState
          title="Aucun adhérent pour le moment"
          text="La liste sera alimentée lors de la première synchronisation du formulaire d'adhésion HelloAsso."
        />
      ) : (
        <>
          <ListSearch value={search} onChange={setSearch} placeholder="Rechercher un nom, un prénom, un groupe…" />
          <Pagination page={page} pageSize={pageSize} total={filteredMembers.length} onPageChange={setPage} onPageSizeChange={setPageSize} />
          <div className="table-wrap data-table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Nom</th><th>Catégorie FFE</th><th>Contact</th><th>Document santé</th><th>Groupes</th><th /></tr>
              <tr className="filter-row">
                <th><FilterInput label="Filtrer par nom" value={filters.name} onChange={(name) => setFilters((current) => ({ ...current, name }))} /></th>
                <th><ChoiceFilter label="Catégorie" options={filterOptions.category} selection={filters.category} onToggle={(value) => setFilters((current) => ({ ...current, category: toggledSet(current.category, value) }))} onClear={() => setFilters((current) => ({ ...current, category: new Set() }))} /></th>
                <th />
                <th><ChoiceFilter label="Document santé" options={filterOptions.healthDocument} selection={filters.healthDocument} onToggle={(value) => setFilters((current) => ({ ...current, healthDocument: toggledSet(current.healthDocument, value) }))} onClear={() => setFilters((current) => ({ ...current, healthDocument: new Set() }))} /></th>
                <th><ChoiceFilter label="Groupes" options={filterOptions.groups} selection={filters.groups} onToggle={(value) => setFilters((current) => ({ ...current, groups: toggledSet(current.groups, value) }))} onClear={() => setFilters((current) => ({ ...current, groups: new Set() }))} /></th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleMembers.map((member) => <tr className="clickable-row" key={member.id} onClick={() => edit(member)}>
                <td><button className="member-name-button" type="button" onClick={() => edit(member)}><strong>{member.lastName} {member.firstName}</strong></button></td>
                <td><CategoryBadge member={member} /></td>
                <td>{member.email ?? (member.phone ? formatPhoneNumber(member.phone) : "—")}</td>
                <td><HealthDocumentBadge member={member} /></td>
                <td><GroupBadges groups={member.groups} /></td>
                <td className="row-action"><span className="row-chevron" aria-hidden="true">›</span></td>
              </tr>)}
            </tbody>
          </table>
          {filteredMembers.length === 0 && <EmptyState title="Aucun résultat" text="Modifiez ou effacez un filtre pour retrouver des adhérents." />}
        </div>
          <Pagination page={page} pageSize={pageSize} total={filteredMembers.length} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </>
      )}
      {editingMember && draft && <Modal
        title={`${editingMember.firstName} ${editingMember.lastName}`}
        eyebrow="Fiche adhérent"
        onClose={() => setEditingMemberId(null)}
        size="large"
      >
        <MemberEditor
          member={editingMember}
          draft={draft}
          groups={groups}
          selection={selection}
          saving={savingMemberId === editingMember.id}
          onDraftChange={setDraft}
          onToggle={(groupId) => setSelection((current) => toggledSet(current, groupId))}
          onCancel={() => setEditingMemberId(null)}
          onSave={() => void save(editingMember.id)}
          onRevert={(fieldKey) => void revert(editingMember.id, fieldKey)}
          onDocumentsChanged={onDocumentsChanged}
          onComposeEmail={() => onComposeEmail(editingMember)}
        />
      </Modal>}
    </section>
  );
}

function MemberEditor({
  member,
  draft,
  groups,
  selection,
  saving,
  onDraftChange,
  onToggle,
  onCancel,
  onSave,
  onRevert,
  onDocumentsChanged,
  onComposeEmail
}: {
  member: Member;
  draft: MemberDraft;
  groups: Group[];
  selection: Set<string>;
  saving: boolean;
  onDraftChange: (draft: MemberDraft) => void;
  onToggle: (groupId: string) => void;
  onCancel: () => void;
  onSave: () => void;
  onRevert: (fieldKey: string) => void;
  onDocumentsChanged: () => Promise<void>;
  onComposeEmail: () => void;
}) {
  const change = (patch: Partial<MemberDraft>) => onDraftChange({ ...draft, ...patch });
  const changeCustom = (key: string, value: string) => change({
    customValues: { ...draft.customValues, [key]: value }
  });
  return <div className="member-group-editor">
    <div className="member-editor-intro"><div><strong>Modifier {member.firstName} {member.lastName}</strong><p>Ces corrections sont locales et prioritaires : un nouvel import HelloAsso ne les écrasera pas.</p></div><button className="secondary email-member-button" type="button" disabled={!member.email} title={member.email ? `Écrire à ${member.email}` : "Aucune adresse e-mail disponible"} onClick={onComposeEmail}>✉ Envoyer un message</button></div>
    <div className="member-fields">
      <label><FieldLabel label="Prénom" overridden={member.overriddenFields.includes("firstName")} saving={saving} onRevert={() => onRevert("firstName")} /><input required value={draft.firstName} onChange={(event) => change({ firstName: event.target.value })} /></label>
      <label><FieldLabel label="Nom" overridden={member.overriddenFields.includes("lastName")} saving={saving} onRevert={() => onRevert("lastName")} /><input required value={draft.lastName} onChange={(event) => change({ lastName: event.target.value })} /></label>
    </div>
    <div className="custom-fields-section">
      <div><strong>Champs supplémentaires sélectionnés</strong><p>{member.customFields.length} champ{member.customFields.length > 1 ? "s" : ""} conservé{member.customFields.length > 1 ? "s" : ""} depuis la configuration.</p></div>
      {member.customFields.length === 0 ? <p className="empty-inline">Aucun champ supplémentaire n'est sélectionné dans la configuration.</p> : <div className="custom-fields-grid">
        {member.customFields.map((field) => field.type === "File"
          ? <MemberDocument key={field.key} member={member} field={field} onChanged={onDocumentsChanged} />
          : <label key={field.key}>
            <FieldLabel label={field.label} overridden={field.overridden} saving={saving} onRevert={() => onRevert(field.key)} />
            <CustomFieldInput field={field} value={draft.customValues[field.key] ?? ""} onChange={(value) => changeCustom(field.key, value)} />
          </label>)}
      </div>}
    </div>
    <div><strong>Groupes</strong><GroupCheckboxes groups={groups} selection={selection} onToggle={onToggle} /></div>
    <div className="editor-actions"><button className="link-button" type="button" disabled={saving} onClick={onCancel}>Annuler</button><button className="primary" type="button" disabled={saving || !draft.firstName.trim() || !draft.lastName.trim()} onClick={onSave}>{saving ? "Enregistrement…" : "Enregistrer localement"}</button></div>
  </div>;
}

function FieldLabel({ label, overridden, saving, onRevert }: { label: string; overridden: boolean; saving: boolean; onRevert: () => void }) {
  return <span className="field-label-row"><span>{label}</span>{overridden && <span className="local-override-actions"><small>Modifié localement</small><button className="revert-button" type="button" disabled={saving} onClick={onRevert}>Revenir à HelloAsso</button></span>}</span>;
}

function CustomFieldInput({ field, value, onChange }: { field: Member["customFields"][number]; value: string; onChange: (value: string) => void }) {
  const type = field.type.toLocaleLowerCase("fr");
  if (type.includes("yesno") || type.includes("oui/non") || type.includes("boolean")) {
    return <select value={value} onChange={(event) => onChange(event.target.value)}><option value="">Non renseigné</option><option value="true">Oui</option><option value="false">Non</option></select>;
  }
  if (type === "date") {
    return <input type="date" max={new Date().toISOString().slice(0, 10)} value={value} onChange={(event) => onChange(event.target.value)} />;
  }
  if (type.includes("phone") || type.includes("téléphone")) {
    return <input type="tel" inputMode="tel" value={formatPhoneNumber(value)} onChange={(event) => onChange(formatPhoneNumber(event.target.value))} placeholder="01 23 45 67 89" />;
  }
  return <input value={value} onChange={(event) => onChange(event.target.value)} />;
}

function MemberDocument({ member, field, onChanged }: {
  member: Member;
  field: Member["customFields"][number];
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const document = field.document;
  const classification = document?.classification ?? "unknown";

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      await api.uploadMemberDocument(member.id, field.key, file);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible d'ajouter le document.");
    } finally { setBusy(false); }
  }

  async function classify(value: "certificate" | "attestation" | "questionnaire" | "unknown") {
    setBusy(true); setError(null);
    try { await api.classifyMemberDocument(member.id, field.key, value); await onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Classement impossible."); }
    finally { setBusy(false); }
  }

  async function revert() {
    if (!document?.source || document.source !== "local") return;
    const text = document.hasHelloAssoOriginal
      ? "Supprimer le fichier local et revenir au document HelloAsso ?"
      : "Supprimer ce fichier local ? Aucun document HelloAsso n'est disponible derrière.";
    if (!window.confirm(text)) return;
    setBusy(true); setError(null);
    try { await api.revertMemberDocument(member.id, field.key); await onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Suppression impossible."); }
    finally { setBusy(false); }
  }

  return <div className="member-document-field">
    <div className="field-label-row"><span>{field.label}</span>{document?.health && <span className="document-role">Document santé</span>}</div>
    {document?.available ? <div className="document-current">
      <div><strong>{document.fileName || "Document fourni"}</strong><small>{document.source === "local" ? "Fichier local prioritaire" : "Fichier HelloAsso"}{document.sizeBytes ? ` · ${formatBytes(document.sizeBytes)}` : ""}</small></div>
      <div className="document-actions"><a className="secondary compact-button" href={api.memberDocumentUrl(member.id, field.key)} target="_blank" rel="noreferrer">Voir</a><a className="secondary compact-button" href={api.memberDocumentUrl(member.id, field.key, true)}>Télécharger</a></div>
    </div> : <p className="empty-inline">Aucun fichier fourni.</p>}
    {document?.health && document.available && <label className={`document-classification ${classification === "questionnaire" ? "document-warning" : ""}`}>Type reconnu<select disabled={busy} value={classification} onChange={(event) => void classify(event.target.value as "certificate" | "attestation" | "questionnaire" | "unknown")}><option value="unknown">À classer</option><option value="certificate">Certificat médical</option><option value="attestation">Attestation de santé valide</option><option value="questionnaire">Erreur : questionnaire fourni à la place de l’attestation</option></select><small>{classification === "questionnaire" ? "Le questionnaire contient des données de santé et ne remplace pas l’attestation demandée." : document.classificationSource === "manual" ? "Classement corrigé manuellement" : "Reconnaissance automatique, modifiable"}</small></label>}
    <div className="document-local-actions"><label className="secondary compact-button file-button">{busy ? "Traitement…" : document?.available ? "Ajouter / remplacer localement" : "Ajouter localement"}<input type="file" accept="application/pdf,image/jpeg,image/png" disabled={busy} onChange={(event) => void upload(event.currentTarget.files?.[0])} /></label>{document?.source === "local" && <button className="revert-button" type="button" disabled={busy} onClick={() => void revert()}>{document.hasHelloAssoOriginal ? "Revenir à HelloAsso" : "Supprimer le fichier local"}</button>}</div>
    {error && <small className="field-error">{error}</small>}
  </div>;
}

function CategoryBadge({ member }: { member: Pick<Member, "fencingCategory" | "categoryError"> }) {
  if (member.categoryError) return <span className="category-badge error" title={member.categoryError}>À corriger</span>;
  return member.fencingCategory ? <span className="category-badge">{member.fencingCategory}</span> : <span className="category-badge error">À corriger</span>;
}

function memberDraft(member: Member): MemberDraft {
  return {
    firstName: member.firstName,
    lastName: member.lastName,
    customValues: Object.fromEntries(member.customFields.map((field) => [field.key, customFieldInputValue(field)]))
  };
}

function memberChanges(member: Member, draft: MemberDraft) {
  const changes: {
    firstName?: string;
    lastName?: string;
    profileData?: Record<string, string | number | boolean | null>;
  } = {};
  if (draft.firstName.trim() !== member.firstName) changes.firstName = draft.firstName.trim();
  if (draft.lastName.trim() !== member.lastName) changes.lastName = draft.lastName.trim();
  const profileData: Record<string, string | number | boolean | null> = {};
  for (const field of member.customFields) {
    if (field.type === "File") continue;
    const value = draft.customValues[field.key] ?? "";
    if (value === customFieldInputValue(field)) continue;
    const type = field.type.toLocaleLowerCase("fr");
    profileData[field.key] = type.includes("yesno") || type.includes("oui/non") || type.includes("boolean")
      ? value === "" ? null : value === "true"
      : value;
  }
  if (Object.keys(profileData).length > 0) changes.profileData = profileData;
  return changes;
}

function customFieldInputValue(field: Member["customFields"][number]) {
  if (field.value === null || field.value === undefined) return "";
  if (field.type.toLocaleLowerCase("fr") === "date" && typeof field.value === "string") {
    const frenchDate = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(field.value);
    if (frenchDate) return `${frenchDate[3]}-${frenchDate[2]}-${frenchDate[1]}`;
  }
  if (typeof field.value === "boolean") return field.value ? "true" : "false";
  if (typeof field.value === "object") return JSON.stringify(field.value);
  return String(field.value);
}

function Groups({
  groups,
  groupCriteria,
  members,
  selectedGroupId,
  savingMemberId,
  savingScheduleGroupId,
  groupName,
  groupDescription,
  groupCriterionKey,
  groupCriterionValues,
  creating,
  deletingGroupId,
  onNameChange,
  onDescriptionChange,
  onCriterionChange,
  onCriterionValueToggle,
  onSubmit,
  onDeleteGroup,
  onSelectGroup,
  onMoveMember,
  onSaveMember,
  onRevertField,
  onDocumentsChanged,
  onSaveSchedules,
  onComposeEmail
}: {
  groups: Group[];
  groupCriteria: GroupCriterion[];
  members: Member[];
  selectedGroupId: string | null;
  savingMemberId: string | null;
  savingScheduleGroupId: string | null;
  groupName: string;
  groupDescription: string;
  groupCriterionKey: string;
  groupCriterionValues: Set<string>;
  creating: boolean;
  deletingGroupId: string | null;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onCriterionChange: (value: string) => void;
  onCriterionValueToggle: (value: string) => void;
  onSubmit: (event: FormEvent) => Promise<boolean>;
  onDeleteGroup: (group: Group) => void;
  onSelectGroup: (groupId: string) => void;
  onMoveMember: (memberId: string, groupIds: string[]) => Promise<void>;
  onSaveMember: (memberId: string, draft: MemberDraft, groupIds: string[]) => Promise<void>;
  onRevertField: (memberId: string, fieldKey: string) => Promise<void>;
  onDocumentsChanged: () => Promise<void>;
  onSaveSchedules: (groupId: string, schedules: TrainingSchedule[]) => Promise<void>;
  onComposeEmail: (member: Member) => void;
}) {
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<MemberDraft | null>(null);
  const [editingGroups, setEditingGroups] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [groupTab, setGroupTab] = useState<"members" | "settings">("members");
  const [memberSearch, setMemberSearch] = useState("");
  const [memberPage, setMemberPage] = useState(1);
  const [memberPageSize, setMemberPageSize] = useState(10);
  const [memberFilters, setMemberFilters] = useState({
    name: "",
    category: new Set<string>(),
    healthDocument: new Set<string>(),
    groups: new Set<string>()
  });
  const selectedCriterion = groupCriteria.find((criterion) => criterion.key === groupCriterionKey) ?? null;
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? null;
  const groupMembers = selectedGroup
    ? members.filter((member) => member.groups.some((group) => group.id === selectedGroup.id))
    : [];
  const groupMemberFilterOptions = {
    category: uniqueSorted(groupMembers.map(memberCategoryLabel)),
    healthDocument: uniqueSorted(groupMembers.map((member) => memberHealthDocumentState(member).label)),
    groups: uniqueSorted(groupMembers.flatMap((member) => {
      const others = member.groups.filter((group) => group.id !== selectedGroup?.id);
      return others.length ? others.map((group) => group.name) : ["Aucun autre groupe"];
    }))
  };
  const filteredGroupMembers = groupMembers.filter((member) => {
    const otherGroups = member.groups.filter((group) => group.id !== selectedGroup?.id);
    const values = {
      name: `${member.lastName} ${member.firstName} ${member.email ?? ""} ${member.phone ?? ""}`,
      category: memberCategoryLabel(member),
      healthDocument: memberHealthDocumentState(member).label,
      groups: otherGroups.length ? otherGroups.map((group) => group.name) : ["Aucun autre groupe"]
    };
    return includesText([values.name, values.category, values.healthDocument, ...values.groups].join(" "), memberSearch)
      && includesText(values.name, memberFilters.name)
      && matchesSelected([values.category], memberFilters.category)
      && matchesSelected([values.healthDocument], memberFilters.healthDocument)
      && matchesSelected(values.groups, memberFilters.groups);
  });
  const groupMemberPageCount = Math.max(1, Math.ceil(filteredGroupMembers.length / memberPageSize));
  const visibleGroupMembers = filteredGroupMembers.slice((memberPage - 1) * memberPageSize, memberPage * memberPageSize);

  useEffect(() => setMemberPage(1), [memberSearch, memberFilters, memberPageSize]);
  useEffect(() => { if (memberPage > groupMemberPageCount) setMemberPage(groupMemberPageCount); }, [memberPage, groupMemberPageCount]);

  useEffect(() => {
    setGroupTab("members");
    setMemberSearch("");
    setMemberPage(1);
    setMemberFilters({ name: "", category: new Set(), healthDocument: new Set(), groups: new Set() });
    setEditingMemberId(null);
  }, [selectedGroupId]);

  async function submitNewGroup(event: FormEvent) {
    const created = await onSubmit(event);
    if (created) setCreateOpen(false);
  }

  async function moveMember(member: Member) {
    if (!selectedGroup) return;
    const targetId = targets[member.id] ?? "";
    const retainedGroups = member.groups
      .map((group) => group.id)
      .filter((groupId) => groupId !== selectedGroup.id && groupId !== targetId);
    await onMoveMember(member.id, targetId ? [...retainedGroups, targetId] : retainedGroups);
    setTargets((current) => ({ ...current, [member.id]: "" }));
  }

  function editMember(member: Member) {
    setEditingMemberId(member.id);
    setEditingDraft(memberDraft(member));
    setEditingGroups(new Set(member.groups.map((group) => group.id)));
  }

  async function saveMember(memberId: string) {
    if (!editingDraft) return;
    try {
      await onSaveMember(memberId, editingDraft, [...editingGroups]);
      setEditingMemberId(null);
    } catch {
      // L'erreur globale reste visible et l'éditeur reste ouvert.
    }
  }

  async function revertMember(memberId: string, fieldKey: string) {
    try {
      await onRevertField(memberId, fieldKey);
      setEditingMemberId(null);
    } catch {
      // L'erreur globale reste visible et l'éditeur reste ouvert.
    }
  }

  return (
    <div className="groups-page">
      <section className="panel groups-overview">
        <div className="section-heading">
          <div><p className="eyebrow">Organisation</p><h2>Groupes du club</h2></div>
          <div className="heading-actions"><span className="count-pill">{groups.length}</span><button className="primary" type="button" onClick={() => setCreateOpen(true)}>Créer un groupe</button></div>
        </div>
        {groups.length === 0 ? (
          <EmptyState title="Aucun groupe" text="Créez par exemple Débutants, Compétition ou Adultes loisirs." />
        ) : (
          <div className="group-card-grid">
            {groups.map((group) => (
              <button className="group-tile" key={group.id} type="button" onClick={() => onSelectGroup(group.id)}>
                <div className="group-tile-top"><span className="group-avatar">{groupInitials(group.name)}</span><span className="row-chevron" aria-hidden="true">›</span></div>
                <div><h3>{group.name}</h3><p>{group.description || dynamicGroupDescription(group, groupCriteria) || "Sans description"}</p></div>
                <div className="group-tile-footer"><strong>{group.membersCount}</strong><span>adhérent{group.membersCount > 1 ? "s" : ""}</span><small>{group.trainingSchedules.length} créneau{group.trainingSchedules.length > 1 ? "x" : ""}</small></div>
              </button>
            ))}
          </div>
        )}
      </section>

      {createOpen && <Modal title="Créer un groupe" eyebrow="Nouveau groupe automatique" onClose={() => setCreateOpen(false)}>
        <form className="modal-form" onSubmit={(event) => void submitNewGroup(event)}>
          <label>Nom<input autoFocus required minLength={2} maxLength={80} value={groupName} onChange={(e) => onNameChange(e.target.value)} placeholder="Ex. M15 compétition" /></label>
          <label>Description<textarea maxLength={500} rows={3} value={groupDescription} onChange={(e) => onDescriptionChange(e.target.value)} placeholder="Créneaux, niveau ou remarques…" /></label>
          <label>Critère<select required value={groupCriterionKey} onChange={(event) => onCriterionChange(event.target.value)}><option value="">Choisir un critère…</option><optgroup label="Données HelloAsso">{groupCriteria.filter((criterion) => criterion.source === "helloasso").map((criterion) => <option key={criterion.key} value={criterion.key}>{criterion.label}</option>)}</optgroup><optgroup label="Donnée calculée localement">{groupCriteria.filter((criterion) => criterion.source === "calculated").map((criterion) => <option key={criterion.key} value={criterion.key}>{criterion.label}</option>)}</optgroup></select></label>
          {selectedCriterion && <fieldset className="criterion-values"><legend>Valeur{selectedCriterion.values.length > 1 ? "s" : ""} à inclure</legend>{selectedCriterion.values.length === 0 ? <p className="empty-inline">Aucune valeur disponible pour ce critère.</p> : <div>{selectedCriterion.values.map((entry) => <label key={entry.value}><input type="checkbox" checked={groupCriterionValues.has(entry.value)} onChange={() => onCriterionValueToggle(entry.value)} /><span>{entry.value}<small>{entry.count} adhérent{entry.count > 1 ? "s" : ""}</small></span></label>)}</div>}</fieldset>}
          <p className="group-rule-hint">La composition sera recalculée après chaque import ou correction locale. Les déplacements manuels resteront prioritaires.</p>
          <div className="modal-actions"><button className="secondary" type="button" onClick={() => setCreateOpen(false)}>Annuler</button><button className="primary" disabled={creating || !groupName.trim() || !groupCriterionKey || groupCriterionValues.size === 0} type="submit">{creating ? "Création…" : "Créer et remplir"}</button></div>
        </form>
      </Modal>}

      {selectedGroup && <Modal title={selectedGroup.name} eyebrow="Groupe" onClose={() => onSelectGroup("")} size="wide">
        <div className="group-modal-summary">
          <div><span className="group-avatar large">{groupInitials(selectedGroup.name)}</span><div><strong>{groupMembers.length} adhérent{groupMembers.length > 1 ? "s" : ""}</strong><p>{selectedGroup.description || dynamicGroupDescription(selectedGroup, groupCriteria) || "Sans description"}</p></div></div>
          {selectedGroup.dynamicRule && <span className="rule-chip">{dynamicGroupDescription(selectedGroup, groupCriteria)}</span>}
        </div>
        <div className="tabs" role="tablist"><button className={groupTab === "members" ? "active" : ""} type="button" onClick={() => setGroupTab("members")}>Membres <span>{groupMembers.length}</span></button><button className={groupTab === "settings" ? "active" : ""} type="button" onClick={() => setGroupTab("settings")}>Créneaux et réglages</button></div>

        {groupTab === "members" && <div className="group-members-view">
          {groupMembers.length === 0 ? <EmptyState title="Groupe vide" text="Aucun adhérent n'appartient actuellement à ce groupe." /> : <>
            <ListSearch value={memberSearch} onChange={setMemberSearch} placeholder="Rechercher dans ce groupe…" />
            <Pagination page={memberPage} pageSize={memberPageSize} total={filteredGroupMembers.length} onPageChange={setMemberPage} onPageSizeChange={setMemberPageSize} />
            <div className="table-wrap modal-table-wrap"><table className="data-table">
              <thead><tr><th>Adhérent</th><th>Catégorie</th><th>Document santé</th><th>Autres groupes</th><th>Destination</th><th /></tr><tr className="filter-row">
                <th><FilterInput label="Filtrer par nom" value={memberFilters.name} onChange={(name) => setMemberFilters((current) => ({ ...current, name }))} /></th>
                <th><ChoiceFilter label="Catégorie" options={groupMemberFilterOptions.category} selection={memberFilters.category} onToggle={(value) => setMemberFilters((current) => ({ ...current, category: toggledSet(current.category, value) }))} onClear={() => setMemberFilters((current) => ({ ...current, category: new Set() }))} /></th>
                <th><ChoiceFilter label="Document santé" options={groupMemberFilterOptions.healthDocument} selection={memberFilters.healthDocument} onToggle={(value) => setMemberFilters((current) => ({ ...current, healthDocument: toggledSet(current.healthDocument, value) }))} onClear={() => setMemberFilters((current) => ({ ...current, healthDocument: new Set() }))} /></th>
                <th><ChoiceFilter label="Autres groupes" options={groupMemberFilterOptions.groups} selection={memberFilters.groups} onToggle={(value) => setMemberFilters((current) => ({ ...current, groups: toggledSet(current.groups, value) }))} onClear={() => setMemberFilters((current) => ({ ...current, groups: new Set() }))} /></th><th /><th />
              </tr></thead>
              <tbody>{visibleGroupMembers.map((member) => {
                const targetId = targets[member.id] ?? "";
                return <tr key={member.id}>
                  <td><button className="member-name-button" type="button" onClick={() => editMember(member)}><strong>{member.lastName} {member.firstName}</strong></button><small className="member-contact">{member.email ?? (member.phone ? formatPhoneNumber(member.phone) : "Sans contact")}</small></td>
                  <td><CategoryBadge member={member} /></td>
                  <td><HealthDocumentBadge member={member} /></td>
                  <td><GroupBadges groups={member.groups.filter((group) => group.id !== selectedGroup.id)} /></td>
                  <td><select value={targetId} onChange={(event) => setTargets((current) => ({ ...current, [member.id]: event.target.value }))}><option value="">Retirer du groupe</option>{groups.filter((group) => group.id !== selectedGroup.id).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></td>
                  <td className="row-action"><button className="secondary compact-button" type="button" disabled={savingMemberId === member.id} onClick={() => void moveMember(member)}>{savingMemberId === member.id ? "…" : targetId ? "Déplacer" : "Retirer"}</button></td>
                </tr>;
              })}</tbody>
            </table>{filteredGroupMembers.length === 0 && <EmptyState title="Aucun résultat" text="Aucun membre ne correspond aux filtres saisis." />}</div>
            <Pagination page={memberPage} pageSize={memberPageSize} total={filteredGroupMembers.length} onPageChange={setMemberPage} onPageSizeChange={setMemberPageSize} />
          </>}
        </div>}

        {groupTab === "settings" && <div className="group-settings-view">
          <TrainingSchedules key={selectedGroup.id} group={selectedGroup} saving={savingScheduleGroupId === selectedGroup.id} onSave={(schedules) => onSaveSchedules(selectedGroup.id, schedules)} />
          {selectedGroup.source !== "helloasso" && <div className="danger-zone"><div><strong>Supprimer ce groupe</strong><p>Les adhérents et HelloAsso ne seront pas modifiés.</p></div><button className="danger-button" type="button" disabled={deletingGroupId === selectedGroup.id} onClick={() => onDeleteGroup(selectedGroup)}>{deletingGroupId === selectedGroup.id ? "Suppression…" : "Supprimer le groupe"}</button></div>}
        </div>}
      </Modal>}

      {editingMemberId && editingDraft && (() => {
        const member = members.find((item) => item.id === editingMemberId);
        return member ? <Modal title={`${member.firstName} ${member.lastName}`} eyebrow="Fiche adhérent" onClose={() => setEditingMemberId(null)} size="large"><MemberEditor member={member} draft={editingDraft} groups={groups} selection={editingGroups} saving={savingMemberId === member.id} onDraftChange={setEditingDraft} onToggle={(groupId) => setEditingGroups((current) => toggledSet(current, groupId))} onCancel={() => setEditingMemberId(null)} onSave={() => void saveMember(member.id)} onRevert={(fieldKey) => void revertMember(member.id, fieldKey)} onDocumentsChanged={onDocumentsChanged} onComposeEmail={() => onComposeEmail(member)} /></Modal> : null;
      })()}
    </div>
  );
}

function GroupBadges({ groups }: { groups: Array<{ id: string; name: string }> }) {
  if (groups.length === 0) return <span className="muted">—</span>;
  return <span className="group-badges">{groups.map((group) => <span key={group.id}>{group.name}</span>)}</span>;
}

function dynamicGroupDescription(group: Group, criteria: GroupCriterion[]) {
  if (!group.dynamicRule) return null;
  const criterion = criteria.find((item) => item.key === group.dynamicRule?.fieldKey);
  return `${criterion?.label ?? "Critère"} : ${group.dynamicRule.values.join(", ")}`;
}

function GroupCheckboxes({ groups, selection, onToggle }: { groups: Group[]; selection: Set<string>; onToggle: (groupId: string) => void }) {
  if (groups.length === 0) return <p className="empty-inline">Créez d'abord un groupe.</p>;
  return <div className="group-checkboxes">{groups.map((group) => <label key={group.id}><input type="checkbox" checked={selection.has(group.id)} onChange={() => onToggle(group.id)} /><span>{group.name}</span></label>)}</div>;
}

function toggledSet(current: Set<string>, value: string) {
  const next = new Set(current);
  if (next.has(value)) next.delete(value); else next.add(value);
  return next;
}

function TrainingSchedules({ group, saving, onSave }: { group: Group; saving: boolean; onSave: (schedules: TrainingSchedule[]) => Promise<void> }) {
  const [schedules, setSchedules] = useState<TrainingSchedule[]>(group.trainingSchedules);
  const invalid = schedules.some((schedule) => schedule.endTime <= schedule.startTime);

  function change(index: number, patch: Partial<TrainingSchedule>) {
    setSchedules((current) => current.map((schedule, position) => position === index ? { ...schedule, ...patch } : schedule));
  }

  return <div className="training-schedules">
    <div className="subsection-heading"><div><h3>Jours et heures d’entraînement</h3><p>Ajoutez tous les créneaux hebdomadaires de ce groupe.</p></div><button className="secondary" type="button" onClick={() => setSchedules((current) => [...current, { weekday: 3, startTime: "18:00", endTime: "19:30" }])}>Ajouter un créneau</button></div>
    {schedules.length === 0 ? <p className="empty-inline">Aucun créneau configuré.</p> : <div className="schedule-list">{schedules.map((schedule, index) => <div className="schedule-row" key={`${index}:${schedule.weekday}:${schedule.startTime}`}>
      <label>Jour<select value={schedule.weekday} onChange={(event) => change(index, { weekday: Number(event.target.value) })}>{weekdays.map((day, dayIndex) => <option key={day} value={dayIndex + 1}>{day}</option>)}</select></label>
      <label>Début<input type="time" value={schedule.startTime} onChange={(event) => change(index, { startTime: event.target.value })} /></label>
      <label>Fin<input type="time" value={schedule.endTime} onChange={(event) => change(index, { endTime: event.target.value })} /></label>
      <button className="danger-link" type="button" onClick={() => setSchedules((current) => current.filter((_, position) => position !== index))}>Supprimer</button>
    </div>)}</div>}
    <div className="editor-actions"><button className="primary" type="button" disabled={saving || invalid} onClick={() => void onSave(schedules)}>{saving ? "Enregistrement…" : "Enregistrer les créneaux"}</button></div>
  </div>;
}

function Documents({ groups }: { groups: Group[] }) {
  const [config, setConfig] = useState<Awaited<ReturnType<typeof api.documentConfig>> | null>(null);
  const [fieldKey, setFieldKey] = useState("");
  const [scope, setScope] = useState<"all" | "groups">("all");
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set());
  const [documentSelection, setDocumentSelection] = useState<"new" | "all">("all");
  const [reanalyze, setReanalyze] = useState(false);
  const [identitySource, setIdentitySource] = useState<"member" | "payer">("member");
  const [template, setTemplate] = useState("{nom}-{prenom} - {type_document}");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Awaited<ReturnType<typeof api.documentExportStatus>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.documentConfig().then((result) => {
      setConfig(result); setFieldKey(result.fields[0]?.key ?? "");
      setIdentitySource(result.identitySource); setTemplate(result.template);
      setDocumentSelection(result.documentSelection);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Configuration indisponible."));
  }, []);

  async function download(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(null); setProgress(null);
    try {
      const started = await api.startDocumentExport({ fieldKey, scope, groupIds: [...groupIds], identitySource, template, documentSelection, reanalyze });
      let status: Awaited<ReturnType<typeof api.documentExportStatus>>;
      do {
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        status = await api.documentExportStatus(started.exportId);
        setProgress(status);
        if (status.status === "failed") throw new Error(status.error ?? "La préparation de l'archive a échoué.");
      } while (status.status !== "ready");
      const result = await api.downloadDocumentExport(started.exportId);
      const url = URL.createObjectURL(result.blob);
      const link = window.document.createElement("a");
      link.href = url; link.download = result.fileName ?? "documents.zip"; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setConfig(await api.documentConfig());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible de créer l'archive.");
    } finally { setBusy(false); }
  }

  if (!config) return <section className="panel"><p>{error ?? "Chargement des documents…"}</p></section>;
  return <div className="documents-page">
    {error && <div className="alert error">{error}</div>}
    <section className="panel">
      <div className="section-heading"><div><p className="eyebrow">Fichiers des adhérents</p><h2>Télécharger les documents</h2><p className="muted">Les images sont converties en PDF. L’archive contient aussi un rapport des fichiers absents ou inaccessibles.</p></div></div>
      {config.fields.length === 0 ? <EmptyState title="Aucun champ document" text="Dans Configuration, sélectionnez d’abord un champ HelloAsso de type Document." /> : <form className="document-export-form" onSubmit={(event) => void download(event)}>
        <label>Document à exporter<select required value={fieldKey} onChange={(event) => setFieldKey(event.target.value)}>{config.fields.map((field) => <option key={field.key} value={field.key}>{field.label} · {field.availableCount} fichier{field.availableCount > 1 ? "s" : ""} · {field.newCount} nouveau{field.newCount !== 1 ? "x" : ""}{field.health ? " · santé" : ""}</option>)}</select></label>
        <fieldset><legend>Adhérents concernés</legend><label className="radio-line"><input type="radio" checked={scope === "all"} onChange={() => setScope("all")} /> Tous les adhérents actifs</label><label className="radio-line"><input type="radio" checked={scope === "groups"} onChange={() => setScope("groups")} /> Un ou plusieurs groupes</label>{scope === "groups" && <div className="group-checkboxes">{groups.map((group) => <label key={group.id}><input type="checkbox" checked={groupIds.has(group.id)} onChange={() => setGroupIds((current) => toggledSet(current, group.id))} /><span>{group.name} <small>({group.membersCount})</small></span></label>)}</div>}</fieldset>
        <fieldset><legend>Fichiers à inclure</legend><label className="radio-line"><input type="radio" checked={documentSelection === "new" && !reanalyze} onChange={() => { setDocumentSelection("new"); setReanalyze(false); }} /> Seulement les nouveaux fichiers jamais exportés</label><label className="radio-line"><input type="radio" checked={documentSelection === "all" && !reanalyze} onChange={() => { setDocumentSelection("all"); setReanalyze(false); }} /> Tous les fichiers, sans recommencer les reconnaissances déjà faites</label><label className="radio-line reanalyze-option"><input type="checkbox" checked={reanalyze} onChange={(event) => { setReanalyze(event.target.checked); if (event.target.checked) setDocumentSelection("all"); }} /> Tout retraiter avec l’OCR <small>(les corrections manuelles sont conservées)</small></label></fieldset>
        <div className="document-naming"><label>Nom utilisé<select value={identitySource} onChange={(event) => setIdentitySource(event.target.value as "member" | "payer")}><option value="member">Nom de l’adhérent</option><option value="payer">Nom du payeur (sinon adhérent)</option></select></label><label>Nomenclature<input required value={template} onChange={(event) => setTemplate(event.target.value)} /><small>Variables : {"{nom}"}, {"{prenom}"}, {"{type_document}"}. L’extension .pdf est ajoutée automatiquement.</small></label></div>
        <div className="document-name-example">Exemple : <strong>{template.replaceAll("{nom}", "BONNARDEL").replaceAll("{prenom}", "Noah").replaceAll("{type_document}", "certificat")}.pdf</strong></div>
        {progress && <div className="document-export-progress" aria-live="polite"><div><strong>{progress.total > 0 ? `Documents traités : ${progress.processed} / ${progress.total}` : progress.status === "ready" ? "Aucun nouveau document à exporter" : "Recherche des documents…"}</strong><span>{progress.status === "ready" ? "Archive prête" : "Reconnaissance et préparation en cours"}</span></div><progress max={Math.max(1, progress.total)} value={progress.processed} /><div className="recognition-counts"><span>{progress.certificateCount} certificat{progress.certificateCount > 1 ? "s" : ""}</span><span>{progress.attestationCount} attestation{progress.attestationCount > 1 ? "s" : ""}</span>{progress.questionnaireCount > 0 && <span className="warning-count">{progress.questionnaireCount} questionnaire{progress.questionnaireCount > 1 ? "s" : ""} à remplacer</span>}<span>{progress.unknownCount} à classer</span></div></div>}
        <div className="editor-actions"><button className="primary" type="submit" disabled={busy || !fieldKey || !template.trim() || (scope === "groups" && groupIds.size === 0)}>{busy ? progress?.total ? `${progress.processed} / ${progress.total}…` : "Préparation…" : "Télécharger l’archive ZIP"}</button></div>
      </form>}
    </section>
  </div>;
}

function Messages({ groups, initialRecipient }: { groups: Group[]; initialRecipient: { email: string; name: string } | null }) {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [history, setHistory] = useState<EmailMessageHistory[]>([]);
  const [targetType, setTargetType] = useState<EmailTarget["type"]>("single");
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [testEmail, setTestEmail] = useState(initialRecipient?.email ?? "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<{ targetLabel: string; membersCount: number; recipientsCount: number; withoutEmailCount: number } | null>(null);
  const [busy, setBusy] = useState<"verify" | "send" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedGroupsKey = [...selectedGroups].sort().join(",");

  const loadMailData = useCallback(async () => {
    try {
      const [statusResult, historyResult] = await Promise.all([api.emailStatus(), api.emailMessages()]);
      setStatus(statusResult);
      setHistory(historyResult.items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible de charger la messagerie.");
    }
  }, []);

  useEffect(() => { void loadMailData(); }, [loadMailData]);

  useEffect(() => {
    const target = emailTargetForSelection(targetType, selectedGroups, testEmail);
    setPreview(null);
    if (!target) return;
    const timeout = window.setTimeout(() => {
      void api.previewEmailRecipients(target)
        .then(setPreview)
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Destinataires indisponibles."));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [targetType, selectedGroupsKey, testEmail]);

  async function verify() {
    setBusy("verify"); setError(null); setMessage(null);
    try {
      await api.verifyEmail();
      setMessage("Connexion SMTP OVH réussie. Aucun message n'a été envoyé.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Connexion SMTP impossible.");
    } finally { setBusy(null); }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const target = emailTargetForSelection(targetType, selectedGroups, testEmail);
    if (!target || !preview) return;
    const confirmed = window.confirm(`Envoyer « ${subject.trim()} » à ${preview.recipientsCount} adresse${preview.recipientsCount > 1 ? "s" : ""} unique${preview.recipientsCount > 1 ? "s" : ""} ?\n\nChaque destinataire recevra un message individuel.`);
    if (!confirmed) return;
    setBusy("send"); setError(null); setMessage(null);
    try {
      const result = await api.sendEmailMessage({ subject: subject.trim(), body: body.trim(), target });
      setMessage(`${result.sentCount} message${result.sentCount > 1 ? "s" : ""} envoyé${result.sentCount > 1 ? "s" : ""}${result.failedCount ? ` · ${result.failedCount} échec${result.failedCount > 1 ? "s" : ""}` : ""}.`);
      if (result.sentCount > 0) { setSubject(""); setBody(""); }
      await loadMailData();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "L'envoi a échoué.");
      await loadMailData();
    } finally { setBusy(null); }
  }

  return <div className="messages-page">
    {error && <div className="alert error">{error}</div>}
    {message && <div className="alert success">{message}</div>}
    <section className={`panel smtp-status ${status?.configured ? "configured" : ""}`}>
      <div><p className="eyebrow">Serveur d'envoi</p><h2>{status?.configured ? "SMTP OVH configuré" : "SMTP à configurer"}</h2>{status && <p className="muted">{status.host}:{status.port} · {status.secure ? "TLS direct" : "STARTTLS"}{status.fromEmail ? ` · ${status.fromName} <${status.fromEmail}>` : ""}</p>}</div>
      <button className="secondary" type="button" disabled={!status?.configured || busy !== null} onClick={() => void verify()}>{busy === "verify" ? "Vérification…" : "Vérifier la connexion"}</button>
    </section>

    <section className="panel message-composer">
      <div><p className="eyebrow">Nouveau message</p><h2>Rédiger et envoyer</h2><p className="muted">Les adresses sont dédupliquées et ne sont jamais visibles par les autres destinataires.</p>{initialRecipient && <p className="direct-recipient">Message destiné à <strong>{initialRecipient.name}</strong> · {initialRecipient.email}</p>}</div>
      <form onSubmit={send}>
        <fieldset className="message-targets"><legend>Destinataires</legend><div className="target-mode">
          <label><input type="radio" name="target" checked={targetType === "single"} onChange={() => setTargetType("single")} /> Destinataire unique / test</label>
          <label><input type="radio" name="target" checked={targetType === "groups"} onChange={() => setTargetType("groups")} /> Un ou plusieurs groupes</label>
          <label><input type="radio" name="target" checked={targetType === "all"} onChange={() => setTargetType("all")} /> Tous les adhérents</label>
        </div></fieldset>
        {targetType === "single" && <label>Adresse du destinataire<input type="email" required value={testEmail} onChange={(event) => setTestEmail(event.target.value)} placeholder="destinataire@exemple.fr" /></label>}
        {targetType === "groups" && <div><strong>Groupes à inclure</strong><GroupCheckboxes groups={groups} selection={selectedGroups} onToggle={(groupId) => setSelectedGroups((current) => toggledSet(current, groupId))} /></div>}
        {preview && <div className="recipient-preview"><strong>{preview.recipientsCount} adresse{preview.recipientsCount > 1 ? "s" : ""} unique{preview.recipientsCount > 1 ? "s" : ""}</strong><span>{preview.membersCount} adhérent{preview.membersCount > 1 ? "s" : ""}{preview.withoutEmailCount > 0 ? ` · ${preview.withoutEmailCount} sans adresse valide` : ""}</span></div>}
        <label>Objet<input required maxLength={200} value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Objet du message" /></label>
        <label>Message<textarea required maxLength={50_000} rows={12} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Votre message…" /></label>
        <div className="editor-actions"><button className="primary" type="submit" disabled={!status?.configured || busy !== null || !preview || preview.recipientsCount === 0 || !subject.trim() || !body.trim()}>{busy === "send" ? "Envoi en cours…" : "Vérifier et envoyer"}</button></div>
      </form>
    </section>

    <section className="panel message-history">
      <div className="section-heading"><div><p className="eyebrow">Journal local</p><h2>Derniers envois</h2></div><span className="count-pill">{history.length}</span></div>
      {history.length === 0 ? <p className="empty-inline">Aucun message envoyé pour le moment.</p> : <div className="table-wrap"><table><thead><tr><th>Date</th><th>Objet</th><th>Destinataires</th><th>Résultat</th></tr></thead><tbody>{history.map((entry) => <tr key={entry.id}><td>{formatDateTime(entry.createdAt)}</td><td><strong>{entry.subject}</strong></td><td>{entry.targetLabel}<small className="member-contact">{entry.recipientsCount} adresse{entry.recipientsCount > 1 ? "s" : ""}</small></td><td><EmailHistoryStatus entry={entry} /></td></tr>)}</tbody></table></div>}
    </section>
  </div>;
}

function EmailHistoryStatus({ entry }: { entry: EmailMessageHistory }) {
  const label = entry.status === "sent" ? "Envoyé" : entry.status === "partial" ? "Partiel" : entry.status === "failed" ? "Échec" : "En cours";
  return <span className={`email-status ${entry.status}`}>{label} · {entry.sentCount}/{entry.recipientsCount}{entry.failedCount > 0 ? ` · ${entry.failedCount} échec${entry.failedCount > 1 ? "s" : ""}` : ""}</span>;
}

function emailTargetForSelection(type: EmailTarget["type"], selectedGroups: Set<string>, testEmail: string): EmailTarget | null {
  if (type === "all") return { type: "all" };
  if (type === "groups") return selectedGroups.size > 0 ? { type: "groups", groupIds: [...selectedGroups] } : null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail.trim()) ? { type: "single", email: testEmail.trim() } : null;
}

function Attendance({ groups }: { groups: Group[] }) {
  const today = new Date().toISOString().slice(0, 10);
  const schoolStartYear = Number(today.slice(5, 7)) >= 8 ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1;
  const schoolStart = `${schoolStartYear}-09-01`;
  const schoolEnd = `${schoolStartYear + 1}-08-31`;
  const [selectedGroupId, setSelectedGroupId] = useState(groups[0]?.id ?? "");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(addDateDays(today, 42));
  const [holidays, setHolidays] = useState<SchoolHoliday[]>([]);
  const [sheet, setSheet] = useState<AttendanceSheet | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? null;
  const coursePeriods = useMemo(() => buildCoursePeriods(schoolStart, schoolEnd, holidays), [schoolStart, schoolEnd, holidays]);

  useEffect(() => {
    if (!selectedGroupId && groups[0]) setSelectedGroupId(groups[0].id);
  }, [groups, selectedGroupId]);

  useEffect(() => {
    void api.schoolHolidays(schoolStart, schoolEnd).then((result) => setHolidays(result.items)).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Calendrier indisponible."));
  }, [schoolStart, schoolEnd]);

  useEffect(() => {
    if (!selectedGroup || holidays.length === 0) return;
    const period = defaultCoursePeriod(selectedGroup, coursePeriods, today);
    if (period) { setStartDate(period.startDate); setEndDate(period.endDate); }
    setSheet(null);
  }, [selectedGroupId, holidays.length]);

  async function generate() {
    if (!selectedGroupId) return;
    setBusy(true); setError(null); setSheet(null);
    try { setSheet(await api.attendanceSheet(selectedGroupId, startDate, endDate)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Impossible de générer la feuille."); }
    finally { setBusy(false); }
  }

  return <div className="attendance-page">
    <section className="panel attendance-controls no-print">
      <div><p className="eyebrow">Préparation</p><h2>Générer une feuille</h2><p className="muted">Les dates situées pendant les vacances scolaires de la zone C sont automatiquement retirées.</p></div>
      {groups.length === 0 ? <p className="empty-inline">Créez d’abord un groupe.</p> : <div className="attendance-form">
        <label>Groupe<select value={selectedGroupId} onChange={(event) => { setSelectedGroupId(event.target.value); setSheet(null); }}>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
        <label>Période entre deux vacances<select value="" onChange={(event) => { const [start, end] = event.target.value.split("|"); if (start && end) { setStartDate(start); setEndDate(end); setSheet(null); } }}><option value="">Choisir une période…</option>{coursePeriods.map((period) => <option key={`${period.startDate}:${period.endDate}`} value={`${period.startDate}|${period.endDate}`}>{formatShortDate(period.startDate)} → {formatShortDate(period.endDate)}</option>)}</select></label>
        <label>Du<input type="date" value={startDate} onChange={(event) => { setStartDate(event.target.value); setSheet(null); }} /></label>
        <label>Au<input type="date" value={endDate} min={startDate} onChange={(event) => { setEndDate(event.target.value); setSheet(null); }} /></label>
        <button className="primary" type="button" disabled={busy || !selectedGroupId || endDate < startDate} onClick={() => void generate()}>{busy ? "Génération…" : "Générer"}</button>
      </div>}
      {error && <div className="alert error">{error}</div>}
    </section>

    <section className="panel holiday-calendar no-print">
      <div className="section-heading"><div><p className="eyebrow">Calendrier officiel</p><h2>Vacances scolaires — Zone C</h2></div><span className="count-pill">Versailles</span></div>
      <div className="holiday-list">{holidays.map((holiday) => <article key={`${holiday.name}:${holiday.startDate}`}><strong>{holiday.name}</strong><span>{formatShortDate(holiday.startDate)} → {formatShortDate(addDateDays(holiday.endDate, -1))}</span></article>)}</div>
    </section>

    {sheet && <AttendancePrintout sheet={sheet} />}
  </div>;
}

function AttendancePrintout({ sheet }: { sheet: AttendanceSheet }) {
  const chunks = chunked(sheet.sessions, 9);
  const [records, setRecords] = useState<Map<string, AttendanceRecord>>(
    new Map(sheet.attendance.map((record) => [attendanceKey(record.memberId, record.date, record.startTime), record]))
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function cycle(memberId: string, date: string, startTime: string) {
    const key = attendanceKey(memberId, date, startTime);
    setRecords((current) => {
      const next = new Map(current);
      const status = current.get(key)?.status;
      if (!status) next.set(key, { memberId, date, startTime, status: "present" });
      else if (status === "present") next.set(key, { memberId, date, startTime, status: "absent" });
      else if (status === "absent") next.set(key, { memberId, date, startTime, status: "excused" });
      else next.delete(key);
      return next;
    });
    setMessage(null);
  }

  async function save() {
    setSaving(true); setMessage(null);
    try {
      await api.saveAttendance(sheet.group.id, sheet.startDate, sheet.endDate, [...records.values()]);
      setMessage("Présences enregistrées localement.");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Enregistrement impossible.");
    } finally { setSaving(false); }
  }

  return <section className="attendance-result">
    <div className="print-toolbar no-print"><div><strong>{sheet.sessions.length} séance{sheet.sessions.length > 1 ? "s" : ""}</strong><span> · {sheet.members.length} adhérent{sheet.members.length > 1 ? "s" : ""}</span><p>Cliquez sur une case : <b>✓ présent</b> → <b>✕ absent</b> → <b>E excusé</b> → vide.</p>{message && <p className="attendance-message">{message}</p>}</div><div><button className="secondary" type="button" disabled={saving} onClick={() => void save()}>{saving ? "Enregistrement…" : "Enregistrer les présences"}</button><button className="primary" type="button" onClick={() => window.print()}>Imprimer / enregistrer en PDF</button></div></div>
    {sheet.sessions.length === 0 ? <div className="panel empty-inline no-print">Aucune séance dans cette période. Vérifiez les créneaux du groupe.</div> : chunks.map((sessions, pageIndex) => <article className="panel attendance-sheet" key={pageIndex}>
      <header><div><p className="eyebrow">Feuille de présence · catégories FFE {sheet.fencingSeason}</p><h2>{sheet.group.name}</h2></div><div className="sheet-period">Du {formatShortDate(sheet.startDate)} au {formatShortDate(sheet.endDate)}</div></header>
      <table><thead><tr><th className="name-column">Adhérent</th>{sessions.map((session) => <th key={`${session.date}:${session.startTime}`}><span>{formatWeekday(session.date)}</span><strong>{formatDayMonth(session.date)}</strong><small>{session.startTime}</small></th>)}</tr></thead>
      <tbody>{sheet.members.map((member) => <tr key={member.id}><td>{member.lastName} {member.firstName}{member.fencingCategory && <small className="sheet-category">{member.fencingCategory}</small>}</td>{sessions.map((session) => {
        const record = records.get(attendanceKey(member.id, session.date, session.startTime));
        return <td className={`attendance-cell ${record?.status ?? ""}`} key={`${member.id}:${session.date}:${session.startTime}`}><button type="button" aria-label={`${member.firstName} ${member.lastName}, ${formatShortDate(session.date)} : ${attendanceStatusLabel(record?.status)}`} onClick={() => cycle(member.id, session.date, session.startTime)}>{attendanceStatusSymbol(record?.status)}</button></td>;
      })}</tr>)}</tbody></table>
      <footer>CEY · {pageIndex + 1}/{chunks.length}</footer>
    </article>)}
  </section>;
}

function attendanceKey(memberId: string, date: string, startTime: string) {
  return `${memberId}:${date}:${startTime}`;
}

function attendanceStatusSymbol(status?: AttendanceRecord["status"]) {
  if (status === "present") return "✓";
  if (status === "absent") return "✕";
  if (status === "excused") return "E";
  return "";
}

function attendanceStatusLabel(status?: AttendanceRecord["status"]) {
  if (status === "present") return "présent";
  if (status === "absent") return "absent";
  if (status === "excused") return "excusé";
  return "non renseigné";
}

const weekdays = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const monthNames = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];

function buildCoursePeriods(schoolStart: string, schoolEnd: string, holidays: SchoolHoliday[]) {
  const periods: Array<{ startDate: string; endDate: string }> = [];
  let cursor = schoolStart;
  for (const holiday of holidays) {
    const end = addDateDays(holiday.startDate, -1);
    if (end >= cursor) periods.push({ startDate: cursor, endDate: end });
    if (holiday.endDate > cursor) cursor = holiday.endDate;
  }
  if (cursor <= schoolEnd) periods.push({ startDate: cursor, endDate: schoolEnd });
  return periods;
}

function defaultCoursePeriod(group: Group, periods: Array<{ startDate: string; endDate: string }>, today: string) {
  const createdAt = group.createdAt.slice(0, 10);
  const currentOrNext = periods.find((period) => period.endDate >= today);
  if (!currentOrNext) return null;
  return { startDate: createdAt > currentOrNext.startDate ? createdAt : currentOrNext.startDate, endDate: currentOrNext.endDate };
}

function chunked<T>(items: T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

function addDateDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function formatShortDate(date: string) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

function formatWeekday(date: string) {
  return new Intl.DateTimeFormat("fr-FR", { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

function formatDayMonth(date: string) {
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

function formatDateTime(date: string) {
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(date));
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><div className="empty-icon">+</div><h3>{title}</h3><p>{text}</p></div>;
}

function viewTitle(view: View) {
  if (view === "members") return "Adhérents";
  if (view === "categories") return "Catégories";
  if (view === "groups") return "Groupes";
  if (view === "documents") return "Documents";
  if (view === "messages") return "Messages";
  if (view === "attendance") return "Feuilles de présence";
  if (view === "setup") return "Configuration HelloAsso";
  return "Vue d'ensemble";
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} o`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} Ko`;
  return `${(value / (1024 * 1024)).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`;
}
