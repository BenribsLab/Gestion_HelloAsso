import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type AuthUser, type DashboardData, type Extension, type ExtensionConfiguration, type ExtensionInstallation, type Group, type GroupCriterion, type ManagedUser, type Member } from "./api";
import { Setup } from "./Setup";
import { uiContracts, type RegisteredDocumentPanel, type RegisteredGroupPanel, type RegisteredMemberAction, type RegisteredMemberColumn, type RegisteredMemberDetailPanel } from "./extension-contracts";
import { CategoryBadge, memberCategoryLabel } from "./extensions/fencing-categories";
import { loadExtensionBundles } from "./extension-runtime";

type CoreView = "dashboard" | "members" | "groups" | "setup" | "extensions";
/** Une vue apportée par un module est identifiée par son identifiant d'extension. */
type View = CoreView | `ext:${string}`;
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
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [extensionConfiguration, setExtensionConfiguration] = useState<ExtensionConfiguration | null>(null);
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
  const [extensionPayload, setExtensionPayload] = useState<{ extensionId: string; payload: unknown } | null>(null);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(true);
  const [accountOpen, setAccountOpen] = useState(false);

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const extensionData = await api.extensions();
      // Les bundles des modules actifs s'enregistrent (menu, vue) avant le premier rendu.
      await loadExtensionBundles(extensionData.items);
      const [dashboardData, memberData, groupData, criteriaData] = await Promise.all([
        api.dashboard(),
        api.members(),
        api.groups(),
        api.groupCriteria()
      ]);
      setExtensions(extensionData.items);
      setExtensionConfiguration(extensionData.configuration);
      setDashboard(dashboardData);
      setMembers(memberData.items);
      setGroups(groupData.items);
      setGroupCriteria(criteriaData.items);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Impossible de charger l'application.");
    } finally {
      setLoading(false);
    }
  }, []);

  const extensionEnabled = (extensionId: string) => extensions.some(
    (extension) => extension.id === extensionId && extension.enabled
  );
  const memberActions = uiContracts.listMemberActions(extensionEnabled);
  const groupPanels = uiContracts.listGroupPanels(extensionEnabled);
  const memberColumns = uiContracts.listMemberColumns(extensionEnabled);
  const documentPanels = uiContracts.listDocumentPanels(extensionEnabled);
  const memberDetailPanels = uiContracts.listMemberDetailPanels(extensionEnabled);

  useEffect(() => {
    let active = true;
    const requireAuthentication = () => {
      if (!active) return;
      setAuthUser(null);
      setAuthReady(true);
      setLoading(false);
      setAccountOpen(false);
    };
    window.addEventListener("gu-auth-required", requireAuthentication);
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
      window.removeEventListener("gu-auth-required", requireAuthentication);
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

  function navigate(nextView: View) {
    setSelectedGroupId(null);
    setExtensionPayload(null);
    setView(nextView);
  }

  function openExtensionAction(extensionId: string, payload: unknown) {
    setExtensionPayload({ extensionId, payload });
    setSelectedGroupId(null);
    setView(`ext:${extensionId}`);
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
          {uiContracts.listViews(extensionEnabled).map((registration) => (
            <NavButton
              key={registration.extensionId}
              active={view === `ext:${registration.extensionId}`}
              onClick={() => navigate(`ext:${registration.extensionId}`)}
            >
              {registration.label}
            </NavButton>
          ))}
          <NavButton active={view === "groups"} onClick={() => navigate("groups")}>
            Groupes
          </NavButton>
          <NavButton active={view === "setup"} onClick={() => navigate("setup")}>
            Configuration
          </NavButton>
          <NavButton active={view === "extensions"} onClick={() => navigate("extensions")}>
            Extensions
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
            {view === "members" && <Members members={members} groups={groups} savingMemberId={savingMemberId} onSaveMember={updateMember} onRevertField={revertMemberField} onDocumentsChanged={loadData} onMemberAction={openExtensionAction} memberActions={memberActions} memberColumns={memberColumns} documentPanels={documentPanels} memberDetailPanels={memberDetailPanels} categoriesEnabled={uiContracts.memberColumns.isVisible("category", extensionEnabled)} />}
            {uiContracts.listViews(extensionEnabled)
              .filter((registration) => view === `ext:${registration.extensionId}`)
              .map((registration) => (
                <ExtensionView
                  key={registration.extensionId}
                  element={registration.element}
                  onChanged={loadData}
                  payload={extensionPayload?.extensionId === registration.extensionId ? extensionPayload.payload : null}
                />
              ))}
            {view === "groups" && (
              <Groups
                groups={groups}
                groupCriteria={groupCriteria}
                members={members}
                selectedGroupId={selectedGroupId}
                savingMemberId={savingMemberId}
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
                onMemberAction={openExtensionAction}
                categoriesEnabled={uiContracts.memberColumns.isVisible("category", extensionEnabled)}
                memberColumns={memberColumns}
                documentPanels={documentPanels}
                memberActions={memberActions}
                groupPanels={groupPanels}
                memberDetailPanels={memberDetailPanels}
              />
            )}
            {view === "setup" && dashboard && (
              <Setup
                helloassoConfigured={dashboard.helloasso.configured}
                onImported={() => void loadData()}
                onConfigurationChanged={() => void loadData()}
              />
            )}
            {view === "extensions" && extensionConfiguration && <Extensions items={extensions} configuration={extensionConfiguration} onChanged={loadData} />}
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

function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange, fixedPageSize = false }: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  fixedPageSize?: boolean;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return <div className="pagination">
    <span>{start}–{end} sur {total}</span>
    {!fixedPageSize && <label>Afficher<select value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}>{[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>}
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

/**
 * Monte l'élément personnalisé défini par le bundle d'un module. Le module gère sa propre
 * racine React : le cœur ne lui passe que l'API hôte et écoute ses annonces de changement.
 */
function ExtensionView({ element, onChanged, payload }: {
  element: string;
  onChanged: () => Promise<void>;
  payload: unknown;
}) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const parent = container.current;
    const host = window.__GU_HOST__;
    if (!parent || !host) return;
    const node = document.createElement(element) as HTMLElement & { hostApi?: unknown; viewPayload?: unknown };
    node.hostApi = { request: host.request, requestBlob: host.requestBlob };
    node.viewPayload = payload;
    const changed = () => void onChanged();
    node.addEventListener("gu:data-changed", changed);
    parent.appendChild(node);
    return () => {
      node.removeEventListener("gu:data-changed", changed);
      node.remove();
    };
  }, [element, onChanged, payload]);

  return <div className="extension-view" ref={container} />;
}

function memberContactLabel(member: Pick<Member, "email" | "phone">) {
  return member.email ?? (member.phone ? formatPhoneNumber(member.phone) : "Sans contact");
}

function ExtensionMemberCell({ column, member }: { column: RegisteredMemberColumn; member: Member }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const parent = container.current;
    const host = window.__GU_HOST__;
    if (!parent || !host) return;
    const node = document.createElement(column.element) as HTMLElement & { hostApi?: unknown; member?: unknown };
    node.hostApi = { request: host.request, requestBlob: host.requestBlob };
    node.member = member;
    parent.appendChild(node);
    return () => node.remove();
  }, [column, member]);
  return <div ref={container} />;
}

function ExtensionMemberDetailPanel({ panel, member, onChanged }: {
  panel: RegisteredMemberDetailPanel;
  member: Member;
  onChanged: () => Promise<void>;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const parent = container.current;
    const host = window.__GU_HOST__;
    if (!parent || !host) return;
    const node = document.createElement(panel.element) as HTMLElement & { hostApi?: unknown; member?: unknown };
    node.hostApi = { request: host.request, requestBlob: host.requestBlob };
    node.member = member;
    const changed = () => void onChanged();
    node.addEventListener("gu:data-changed", changed);
    parent.appendChild(node);
    return () => {
      node.removeEventListener("gu:data-changed", changed);
      node.remove();
    };
  }, [panel, member, onChanged]);
  return <div className="member-detail-panel" ref={container} />;
}

function ExtensionDocumentPanel({ panel, member, field, onChanged }: {
  panel: RegisteredDocumentPanel;
  member: Member;
  field: Member["customFields"][number];
  onChanged: () => Promise<void>;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const parent = container.current;
    const host = window.__GU_HOST__;
    if (!parent || !host) return;
    const node = document.createElement(panel.element) as HTMLElement & { hostApi?: unknown; member?: unknown; field?: unknown };
    node.hostApi = { request: host.request, requestBlob: host.requestBlob };
    node.member = member; node.field = field;
    const changed = () => void onChanged();
    node.addEventListener("gu:data-changed", changed);
    parent.appendChild(node);
    return () => { node.removeEventListener("gu:data-changed", changed); node.remove(); };
  }, [field, member, onChanged, panel]);
  return <div ref={container} />;
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

function Extensions({ items, configuration, onChanged }: {
  items: Extension[];
  configuration: ExtensionConfiguration;
  onChanged: () => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installationMessage, setInstallationMessage] = useState<string | null>(null);
  const [installations, setInstallations] = useState<ExtensionInstallation[]>([]);
  const [rollbacks, setRollbacks] = useState<Record<string, Array<{ directory: string; version: string }>>>({});

  useEffect(() => {
    void Promise.all([
      api.extensionInstallations(),
      Promise.all(items.map(async (extension) => [extension.id, (await api.extensionRollbacks(extension.id)).items] as const))
    ]).then(([history, available]) => {
      setInstallations(history.items); setRollbacks(Object.fromEntries(available));
    }).catch(() => undefined);
  }, [items]);

  async function toggle(extension: Extension) {
    if (extension.enabled && !window.confirm(
      `Désactiver « ${extension.name} » ?\n\nSon menu et son API seront coupés, mais toutes ses données locales seront conservées.`
    )) return;
    setBusyId(extension.id);
    setError(null);
    try {
      await api.setExtensionEnabled(extension.id, !extension.enabled);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible de modifier cette extension.");
    } finally {
      setBusyId(null);
    }
  }

  async function install(file: File | undefined) {
    if (!file) return;
    setBusyId("install"); setError(null); setInstallationMessage(null);
    try {
      const result = await api.installExtension(file);
      setInstallationMessage(`${result.id} v${result.version} installé. Redémarrage du serveur…`);
      if (result.restartScheduled) window.setTimeout(() => window.location.reload(), 3_000);
      else await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Installation impossible."); }
    finally { setBusyId(null); }
  }

  async function rollback(extension: Extension) {
    const candidate = rollbacks[extension.id]?.[0];
    if (!candidate || !window.confirm(`Revenir à ${extension.name} v${candidate.version} ?`)) return;
    setBusyId(extension.id); setError(null);
    try {
      const result = await api.rollbackExtension(extension.id, candidate.directory);
      setInstallationMessage(`${extension.name} restauré en v${result.version}. Redémarrage du serveur…`);
      if (result.restartScheduled) window.setTimeout(() => window.location.reload(), 3_000); else await onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Retour arrière impossible."); }
    finally { setBusyId(null); }
  }

  return <div className="extensions-page page-stack">
    <section className="panel extension-intro">
      <div><p className="eyebrow">Architecture modulaire</p><h2>Extensions installées</h2><p className="muted">Chaque fonctionnalité peut être coupée sans supprimer ses données. Les modules actuellement livrés avec l’application sont autorisés localement.</p></div>
      <div className={`central-server-status ${configuration.centralServerConfigured ? "configured" : "planned"}`}><strong>{configuration.centralServerConfigured ? "Serveur central configuré" : "Serveur central prévu"}</strong><span>{configuration.centralServerConfigured ? "Catalogue et licence disponibles" : `Mode local · grâce hors ligne prévue : ${configuration.offlineGraceDays} jours`}</span></div>
    </section>
    {configuration.allowUnsigned && <div className="alert error">Le mode développeur autorisant les paquets non signés est actif. Ne l’utilisez jamais en production.</div>}
    {error && <div className="alert error">{error}</div>}
    {installationMessage && <div className="alert success-message">{installationMessage}</div>}
    <section className="extension-grid" aria-label="Extensions installées">
      {items.map((extension) => <article className={`panel extension-card ${extension.enabled ? "enabled" : "disabled"}`} key={extension.id}>
        <div className="extension-card-heading"><div><span className="extension-state-dot" /><span>{extension.enabled ? "Active" : "Inactive"}</span></div><small>v{extension.version}</small></div>
        <div><h2>{extension.name}</h2><p>{extension.description}</p></div>
        <dl><div><dt>Origine</dt><dd>{extension.source === "bundled" ? "Livrée avec l’application" : extension.source === "central" ? "Catalogue central" : "Paquet local"}</dd></div><div><dt>Licence</dt><dd>{extension.licenseStatus === "local" ? "Locale" : extension.licenseStatus}</dd></div></dl>
        {extension.optionalDependencies.length > 0 && <small className="extension-dependencies">Intégrations facultatives : {extension.optionalDependencies.join(", ")}</small>}
        <div className="template-actions"><button className={extension.enabled ? "secondary" : "primary"} type="button" disabled={busyId !== null} onClick={() => void toggle(extension)}>{busyId === extension.id ? "Mise à jour…" : extension.enabled ? "Désactiver" : "Activer"}</button>{(rollbacks[extension.id]?.length ?? 0) > 0 && <button className="secondary" type="button" disabled={busyId !== null} onClick={() => void rollback(extension)}>Revenir à v{rollbacks[extension.id]![0]!.version}</button>}</div>
      </article>)}
    </section>
    <section className="panel extension-catalog-placeholder"><div><p className="eyebrow">Paquet autonome</p><h2>Installer un fichier .gu-plugin</h2><p className="muted">Le paquet est contrôlé, signé, installé atomiquement puis chargé après le redémarrage automatique de l’API.</p></div><label className="primary file-button">{busyId === "install" ? "Vérification…" : "Choisir et installer"}<input type="file" accept=".gu-plugin,application/zip" disabled={busyId !== null} onChange={(event) => void install(event.currentTarget.files?.[0])} /></label></section>
    {installations.length > 0 && <section className="panel"><div className="section-heading"><div><p className="eyebrow">Audit technique</p><h2>Dernières installations</h2></div></div><div className="message-history-list">{installations.slice(0, 20).map((entry) => <article key={entry.id}><div><strong>{entry.extensionId ?? "Paquet refusé"}{entry.version ? ` · v${entry.version}` : ""}</strong><p>{entry.outcome === "installed" ? "Installation réussie" : entry.outcome === "rolled_back" ? "Retour arrière" : entry.message ?? "Échec de l’installation"}</p></div><time>{formatDateTime(entry.createdAt)}</time></article>)}</div></section>}
  </div>;
}

function Members({
  members,
  groups,
  savingMemberId,
  onSaveMember,
  onRevertField,
  onDocumentsChanged,
  onMemberAction,
  categoriesEnabled,
  memberActions,
  memberColumns,
  documentPanels,
  memberDetailPanels
}: {
  members: Member[];
  groups: Group[];
  savingMemberId: string | null;
  onSaveMember: (memberId: string, draft: MemberDraft, groupIds: string[]) => Promise<void>;
  onRevertField: (memberId: string, fieldKey: string) => Promise<void>;
  onDocumentsChanged: () => Promise<void>;
  onMemberAction: (extensionId: string, payload: unknown) => void;
  categoriesEnabled: boolean;
  memberActions: RegisteredMemberAction[];
  memberColumns: RegisteredMemberColumn[];
  documentPanels: RegisteredDocumentPanel[];
  memberDetailPanels: RegisteredMemberDetailPanel[];
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
    extensions: {} as Record<string, Set<string>>,
    groups: new Set<string>()
  });
  const editingMember = members.find((member) => member.id === editingMemberId) ?? null;
  const filterOptions = useMemo(() => ({
    category: uniqueSorted(members.map(memberCategoryLabel)),
    extensions: Object.fromEntries(memberColumns.map((column) => [column.key, uniqueSorted(members.map((member) => column.filterValue(member as never)))])),
    groups: uniqueSorted(members.flatMap((member) => member.groups.length ? member.groups.map((group) => group.name) : ["Aucun groupe"]))
  }), [memberColumns, members]);
  const filteredMembers = useMemo(() => members.filter((member) => {
    const values = {
      name: `${member.lastName} ${member.firstName}`,
      category: memberCategoryLabel(member),
      contact: memberContactLabel(member),
      extensions: Object.fromEntries(memberColumns.map((column) => [column.key, column.filterValue(member as never)])),
      groups: member.groups.length ? member.groups.map((group) => group.name) : ["Aucun groupe"]
    };
    return includesText([values.name, values.category, values.contact, ...Object.values(values.extensions), ...values.groups].join(" "), search)
      && includesText(values.name, filters.name)
      && matchesSelected([values.category], filters.category)
      && memberColumns.every((column) => matchesSelected([values.extensions[column.key] ?? ""], filters.extensions[column.key] ?? new Set()))
      && matchesSelected(values.groups, filters.groups);
  }), [members, search, filters, memberColumns]);
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
              <tr><th>Nom</th>{categoriesEnabled && <th>Catégorie FFE</th>}<th>Contact</th>{memberColumns.map((column) => <th key={column.key} style={column.width ? { width: column.width } : undefined}>{column.label}</th>)}<th>Groupes</th><th /></tr>
              <tr className="filter-row">
                <th><FilterInput label="Filtrer par nom" value={filters.name} onChange={(name) => setFilters((current) => ({ ...current, name }))} /></th>
                {categoriesEnabled && <th><ChoiceFilter label="Catégorie" options={filterOptions.category} selection={filters.category} onToggle={(value) => setFilters((current) => ({ ...current, category: toggledSet(current.category, value) }))} onClear={() => setFilters((current) => ({ ...current, category: new Set() }))} /></th>}
                <th />
                {memberColumns.map((column) => <th key={column.key}><ChoiceFilter label={column.label} options={filterOptions.extensions[column.key] ?? []} selection={filters.extensions[column.key] ?? new Set()} onToggle={(value) => setFilters((current) => ({ ...current, extensions: { ...current.extensions, [column.key]: toggledSet(current.extensions[column.key] ?? new Set(), value) } }))} onClear={() => setFilters((current) => ({ ...current, extensions: { ...current.extensions, [column.key]: new Set() } }))} /></th>)}
                <th><ChoiceFilter label="Groupes" options={filterOptions.groups} selection={filters.groups} onToggle={(value) => setFilters((current) => ({ ...current, groups: toggledSet(current.groups, value) }))} onClear={() => setFilters((current) => ({ ...current, groups: new Set() }))} /></th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleMembers.map((member) => <tr className="clickable-row" key={member.id} onClick={() => edit(member)}>
                <td><button className="member-name-button" type="button" onClick={() => edit(member)}><strong>{member.lastName} {member.firstName}</strong></button></td>
                {categoriesEnabled && <td><CategoryBadge member={member} /></td>}
                <td>{member.email ?? (member.phone ? formatPhoneNumber(member.phone) : "—")}</td>
                {memberColumns.map((column) => <td key={column.key}><ExtensionMemberCell column={column} member={member} /></td>)}
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
          onMemberAction={onMemberAction}
          memberActions={memberActions}
          documentPanels={documentPanels}
          memberDetailPanels={memberDetailPanels}
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
  onMemberAction,
  memberActions,
  documentPanels,
  memberDetailPanels
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
  onMemberAction: (extensionId: string, payload: unknown) => void;
  memberActions: RegisteredMemberAction[];
  documentPanels: RegisteredDocumentPanel[];
  memberDetailPanels: RegisteredMemberDetailPanel[];
}) {
  const change = (patch: Partial<MemberDraft>) => onDraftChange({ ...draft, ...patch });
  const changeCustom = (key: string, value: string) => change({
    customValues: { ...draft.customValues, [key]: value }
  });
  return <div className="member-group-editor">
    <div className="member-editor-intro"><div><strong>Modifier {member.firstName} {member.lastName}</strong><p>Ces corrections sont locales et prioritaires : un nouvel import HelloAsso ne les écrasera pas.</p></div>{memberActions.map((action) => {
      const payload = action.payloadFor(member);
      return <button
        key={`${action.extensionId}/${action.label}`}
        className="secondary email-member-button"
        type="button"
        disabled={payload === null}
        onClick={() => onMemberAction(action.extensionId, payload)}
      >{action.label}</button>;
    })}</div>
    {memberDetailPanels.map((panel) => <ExtensionMemberDetailPanel key={panel.extensionId} panel={panel} member={member} onChanged={onDocumentsChanged} />)}
    <div className="member-fields">
      <label><FieldLabel label="Prénom" overridden={member.overriddenFields.includes("firstName")} saving={saving} onRevert={() => onRevert("firstName")} /><input required value={draft.firstName} onChange={(event) => change({ firstName: event.target.value })} /></label>
      <label><FieldLabel label="Nom" overridden={member.overriddenFields.includes("lastName")} saving={saving} onRevert={() => onRevert("lastName")} /><input required value={draft.lastName} onChange={(event) => change({ lastName: event.target.value })} /></label>
    </div>
    <div className="custom-fields-section">
      <div><strong>Champs supplémentaires sélectionnés</strong><p>{member.customFields.length} champ{member.customFields.length > 1 ? "s" : ""} conservé{member.customFields.length > 1 ? "s" : ""} depuis la configuration.</p></div>
      {member.customFields.length === 0 ? <p className="empty-inline">Aucun champ supplémentaire n'est sélectionné dans la configuration.</p> : <div className="custom-fields-grid">
        {member.customFields.map((field) => field.type === "File"
          ? <MemberDocument key={field.key} member={member} field={field} onChanged={onDocumentsChanged} documentPanels={documentPanels} />
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

function MemberDocument({ member, field, onChanged, documentPanels }: {
  member: Member;
  field: Member["customFields"][number];
  onChanged: () => Promise<void>;
  documentPanels: RegisteredDocumentPanel[];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const document = field.document;

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
    <div className="field-label-row"><span>{field.label}</span></div>
    {document?.available ? <div className="document-current">
      <div><strong>{document.fileName || "Document fourni"}</strong><small>{document.source === "local" ? "Fichier local prioritaire" : "Fichier HelloAsso"}{document.sizeBytes ? ` · ${formatBytes(document.sizeBytes)}` : ""}</small></div>
      <div className="document-actions"><a className="secondary compact-button" href={api.memberDocumentUrl(member.id, field.key)} target="_blank" rel="noreferrer">Voir</a><a className="secondary compact-button" href={api.memberDocumentUrl(member.id, field.key, true)}>Télécharger</a></div>
    </div> : <p className="empty-inline">Aucun fichier fourni.</p>}
    {documentPanels.map((panel) => <ExtensionDocumentPanel key={panel.extensionId} panel={panel} member={member} field={field} onChanged={onChanged} />)}
    <div className="document-local-actions"><label className="secondary compact-button file-button">{busy ? "Traitement…" : document?.available ? "Ajouter / remplacer localement" : "Ajouter localement"}<input type="file" accept="application/pdf,image/jpeg,image/png" disabled={busy} onChange={(event) => void upload(event.currentTarget.files?.[0])} /></label>{document?.source === "local" && <button className="revert-button" type="button" disabled={busy} onClick={() => void revert()}>{document.hasHelloAssoOriginal ? "Revenir à HelloAsso" : "Supprimer le fichier local"}</button>}</div>
    {error && <small className="field-error">{error}</small>}
  </div>;
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
  onMemberAction,
  categoriesEnabled,
  memberColumns,
  documentPanels,
  memberActions,
  groupPanels,
  memberDetailPanels
}: {
  groups: Group[];
  groupCriteria: GroupCriterion[];
  members: Member[];
  selectedGroupId: string | null;
  savingMemberId: string | null;
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
  onMemberAction: (extensionId: string, payload: unknown) => void;
  categoriesEnabled: boolean;
  memberColumns: RegisteredMemberColumn[];
  documentPanels: RegisteredDocumentPanel[];
  memberActions: RegisteredMemberAction[];
  groupPanels: RegisteredGroupPanel[];
  memberDetailPanels: RegisteredMemberDetailPanel[];
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
    extensions: {} as Record<string, Set<string>>,
    groups: new Set<string>()
  });
  const selectedCriterion = groupCriteria.find((criterion) => criterion.key === groupCriterionKey) ?? null;
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? null;
  const groupMembers = selectedGroup
    ? members.filter((member) => member.groups.some((group) => group.id === selectedGroup.id))
    : [];
  const groupMemberFilterOptions = {
    category: uniqueSorted(groupMembers.map(memberCategoryLabel)),
    extensions: Object.fromEntries(memberColumns.map((column) => [column.key, uniqueSorted(groupMembers.map((member) => column.filterValue(member as never)))])),
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
      extensions: Object.fromEntries(memberColumns.map((column) => [column.key, column.filterValue(member as never)])),
      groups: otherGroups.length ? otherGroups.map((group) => group.name) : ["Aucun autre groupe"]
    };
    return includesText([values.name, values.category, ...Object.values(values.extensions), ...values.groups].join(" "), memberSearch)
      && includesText(values.name, memberFilters.name)
      && matchesSelected([values.category], memberFilters.category)
      && memberColumns.every((column) => matchesSelected([values.extensions[column.key] ?? ""], memberFilters.extensions[column.key] ?? new Set()))
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
    setMemberFilters({ name: "", category: new Set(), extensions: {}, groups: new Set() });
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
                <div className="group-tile-footer"><strong>{group.membersCount}</strong><span>adhérent{group.membersCount > 1 ? "s" : ""}</span>{groupPanels.length > 0 && <small>{group.trainingSchedules.length} créneau{group.trainingSchedules.length > 1 ? "x" : ""}</small>}</div>
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
        <div className="tabs" role="tablist"><button className={groupTab === "members" ? "active" : ""} type="button" onClick={() => setGroupTab("members")}>Membres <span>{groupMembers.length}</span></button><button className={groupTab === "settings" ? "active" : ""} type="button" onClick={() => setGroupTab("settings")}>{groupPanels.length > 0 ? "Créneaux et réglages" : "Réglages"}</button></div>

        {groupTab === "members" && <div className="group-members-view">
          {groupMembers.length === 0 ? <EmptyState title="Groupe vide" text="Aucun adhérent n'appartient actuellement à ce groupe." /> : <>
            <ListSearch value={memberSearch} onChange={setMemberSearch} placeholder="Rechercher dans ce groupe…" />
            <Pagination page={memberPage} pageSize={memberPageSize} total={filteredGroupMembers.length} onPageChange={setMemberPage} onPageSizeChange={setMemberPageSize} />
            <div className="table-wrap modal-table-wrap"><table className="data-table">
              <thead><tr><th>Adhérent</th>{categoriesEnabled && <th>Catégorie</th>}{memberColumns.map((column) => <th key={column.key} style={column.width ? { width: column.width } : undefined}>{column.label}</th>)}<th>Autres groupes</th><th>Destination</th><th /></tr><tr className="filter-row">
                <th><FilterInput label="Filtrer par nom" value={memberFilters.name} onChange={(name) => setMemberFilters((current) => ({ ...current, name }))} /></th>
                {categoriesEnabled && <th><ChoiceFilter label="Catégorie" options={groupMemberFilterOptions.category} selection={memberFilters.category} onToggle={(value) => setMemberFilters((current) => ({ ...current, category: toggledSet(current.category, value) }))} onClear={() => setMemberFilters((current) => ({ ...current, category: new Set() }))} /></th>}
                {memberColumns.map((column) => <th key={column.key}><ChoiceFilter label={column.label} options={groupMemberFilterOptions.extensions[column.key] ?? []} selection={memberFilters.extensions[column.key] ?? new Set()} onToggle={(value) => setMemberFilters((current) => ({ ...current, extensions: { ...current.extensions, [column.key]: toggledSet(current.extensions[column.key] ?? new Set(), value) } }))} onClear={() => setMemberFilters((current) => ({ ...current, extensions: { ...current.extensions, [column.key]: new Set() } }))} /></th>)}
                <th><ChoiceFilter label="Autres groupes" options={groupMemberFilterOptions.groups} selection={memberFilters.groups} onToggle={(value) => setMemberFilters((current) => ({ ...current, groups: toggledSet(current.groups, value) }))} onClear={() => setMemberFilters((current) => ({ ...current, groups: new Set() }))} /></th><th /><th />
              </tr></thead>
              <tbody>{visibleGroupMembers.map((member) => {
                const targetId = targets[member.id] ?? "";
                return <tr key={member.id}>
                  <td><button className="member-name-button" type="button" onClick={() => editMember(member)}><strong>{member.lastName} {member.firstName}</strong></button><small className="member-contact">{member.email ?? (member.phone ? formatPhoneNumber(member.phone) : "Sans contact")}</small></td>
                  {categoriesEnabled && <td><CategoryBadge member={member} /></td>}
                  {memberColumns.map((column) => <td key={column.key}><ExtensionMemberCell column={column} member={member} /></td>)}
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
          {groupPanels.map((panel) => (
            <ExtensionView key={panel.extensionId} element={panel.element} onChanged={onDocumentsChanged} payload={selectedGroup} />
          ))}
          {selectedGroup.source !== "helloasso" && <div className="danger-zone"><div><strong>Supprimer ce groupe</strong><p>Les adhérents et HelloAsso ne seront pas modifiés.</p></div><button className="danger-button" type="button" disabled={deletingGroupId === selectedGroup.id} onClick={() => onDeleteGroup(selectedGroup)}>{deletingGroupId === selectedGroup.id ? "Suppression…" : "Supprimer le groupe"}</button></div>}
        </div>}
      </Modal>}

      {editingMemberId && editingDraft && (() => {
        const member = members.find((item) => item.id === editingMemberId);
        return member ? <Modal title={`${member.firstName} ${member.lastName}`} eyebrow="Fiche adhérent" onClose={() => setEditingMemberId(null)} size="large"><MemberEditor member={member} draft={editingDraft} groups={groups} selection={editingGroups} saving={savingMemberId === member.id} onDraftChange={setEditingDraft} onToggle={(groupId) => setEditingGroups((current) => toggledSet(current, groupId))} onCancel={() => setEditingMemberId(null)} onSave={() => void saveMember(member.id)} onRevert={(fieldKey) => void revertMember(member.id, fieldKey)} onDocumentsChanged={onDocumentsChanged} onMemberAction={onMemberAction} memberActions={memberActions} documentPanels={documentPanels} memberDetailPanels={memberDetailPanels} /></Modal> : null;
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

function formatDateTime(date: string) {
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" }).format(new Date(date));
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><div className="empty-icon">+</div><h3>{title}</h3><p>{text}</p></div>;
}

function registeredViewLabel(extensionId: string) {
  return uiContracts.listViews(() => true)
    .find((registration) => registration.extensionId === extensionId)?.label;
}

function viewTitle(view: View) {
  if (view.startsWith("ext:")) {
    const extensionId = view.slice(4);
    return registeredViewLabel(extensionId) ?? "Module";
  }
  if (view === "members") return "Adhérents";
  if (view === "groups") return "Groupes";
  if (view === "setup") return "Configuration HelloAsso";
  if (view === "extensions") return "Extensions";
  return "Vue d'ensemble";
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} o`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} Ko`;
  return `${(value / (1024 * 1024)).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`;
}
