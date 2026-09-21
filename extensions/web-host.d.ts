/**
 * API hôte exposée aux bundles navigateur des modules. Déclarée une seule fois ici : deux
 * modules qui la redéclareraient chacun de leur côté entreraient en conflit.
 *
 * Le pendant côté cœur est `apps/web/src/extension-runtime.ts`.
 */

interface GuMemberActionSubject {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
}

interface GuWebHost {
  request<T>(path: string, init?: RequestInit): Promise<T>;
  requestBlob(path: string, init?: RequestInit): Promise<{ blob: Blob; fileName: string | null }>;
  registerView(view: { extensionId: string; label: string; element: string }): void;
  registerMemberAction(action: {
    extensionId: string;
    label: string;
    payloadFor(member: GuMemberActionSubject): unknown | null;
  }): void;
  registerGroupPanel(panel: { extensionId: string; label: string; element: string }): void;
  registerMemberColumn(column: {
    extensionId: string;
    key: string;
    label: string;
    element: string;
    filterValue(member: { id: string; firstName: string; lastName: string; customFields: Array<Record<string, unknown>> }): string;
  }): void;
  registerDocumentPanel(panel: { extensionId: string; element: string }): void;
}

interface Window {
  __GU_HOST__?: GuWebHost;
}

/**
 * Chaque module importe son propre `styles.css` en effet de bord (Vite l'extrait en fichier
 * séparé à la construction) : sans cette déclaration, `tsc` ne sait pas typer cet import.
 */
declare module "*.css";
