import { type FormEvent, useCallback, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./styles.css";

/**
 * Bundle navigateur du module. Il ne partage pas le React du cœur : l'élément personnalisé
 * monte sa propre racine. En contrepartie, il ne voit du cœur que `hostApi`.
 */

type HostApi = {
  request<T>(path: string, init?: RequestInit): Promise<T>;
};


type CategoryConfiguration = {
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

const ELEMENT_NAME = "gu-ext-fencing-categories";
const monthNames = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];

function Categories({ host, onChanged }: { host: HostApi; onChanged: () => void }) {
  const [configuration, setConfiguration] = useState<CategoryConfiguration | null>(null);
  const [newName, setNewName] = useState("");
  const [newFrom, setNewFrom] = useState(0);
  const [newTo, setNewTo] = useState(0);
  const [rolloverDate, setRolloverDate] = useState("09-01");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((next: CategoryConfiguration) => {
    setConfiguration(next);
    setRolloverDate(next.rolloverDate);
    setNewFrom((current) => current || next.seasonStartYear - 10);
    setNewTo((current) => current || next.seasonStartYear - 9);
  }, []);

  const reload = useCallback(async () => {
    try {
      apply(await host.request<CategoryConfiguration>("/api/categories"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Impossible de charger les catégories.");
    }
  }, [host, apply]);

  useEffect(() => { void reload(); }, [reload]);

  async function run(key: string, action: () => Promise<unknown>, failure: string) {
    setBusy(key); setError(null);
    try {
      await action();
      await reload();
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : failure);
    } finally { setBusy(null); }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    await run("settings", () => host.request("/api/categories/settings", {
      method: "PUT",
      body: JSON.stringify({ rolloverDate })
    }), "Impossible de modifier la date de changement de saison.");
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    await run("new", async () => {
      await host.request("/api/categories", {
        method: "POST",
        body: JSON.stringify({ name: newName, birthYearFrom: newFrom, birthYearTo: newTo })
      });
      setNewName("");
    }, "Impossible d'ajouter cette catégorie.");
  }

  if (!configuration) {
    return <div className="categories-page">
      {error && <div className="alert error">{error}</div>}
      {!error && <p className="muted">Chargement des catégories…</p>}
    </div>;
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
        <tbody>{configuration.items.map((category) => <CategoryEditorRow
          key={category.id}
          category={category}
          busy={busy === category.id}
          disabled={busy !== null && busy !== category.id}
          onSave={(input) => run(category.id, () => host.request(`/api/categories/${category.id}`, { method: "PUT", body: JSON.stringify(input) }), "Impossible de modifier cette catégorie.")}
          onDelete={() => {
            if (!window.confirm(`Supprimer la catégorie « ${category.name} » pour la saison ${configuration.season} ?\n\nLes groupes automatiques utilisant cette catégorie seront recalculés.`)) return;
            void run(category.id, () => host.request(`/api/categories/${category.id}`, { method: "DELETE" }), "Impossible de supprimer cette catégorie.");
          }}
        />)}</tbody>
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
  onSave: (input: { name: string; birthYearFrom: number; birthYearTo: number }) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(category.name);
  const [birthYearFrom, setBirthYearFrom] = useState(category.birthYearFrom);
  const [birthYearTo, setBirthYearTo] = useState(category.birthYearTo);
  useEffect(() => { setName(category.name); setBirthYearFrom(category.birthYearFrom); setBirthYearTo(category.birthYearTo); }, [category]);
  const changed = name.trim() !== category.name || birthYearFrom !== category.birthYearFrom || birthYearTo !== category.birthYearTo;
  return <tr><td><input aria-label={`Nom de ${category.name}`} value={name} maxLength={50} onChange={(event) => setName(event.target.value)} /></td><td><input aria-label={`Première année de ${category.name}`} type="number" min="1900" max="2200" value={birthYearFrom} onChange={(event) => setBirthYearFrom(Number(event.target.value))} /></td><td><input aria-label={`Dernière année de ${category.name}`} type="number" min={birthYearFrom} max="2200" value={birthYearTo} onChange={(event) => setBirthYearTo(Number(event.target.value))} /></td><td><span className="count-pill">{category.membersCount}</span></td><td className="category-actions"><button className="secondary compact-button" type="button" disabled={disabled || busy || !changed || !name.trim() || birthYearFrom > birthYearTo} onClick={() => onSave({ name: name.trim(), birthYearFrom, birthYearTo })}>{busy ? "…" : "Enregistrer"}</button><button className="danger-link" type="button" disabled={disabled || busy} onClick={onDelete}>Supprimer</button></td></tr>;
}

class FencingCategoriesElement extends HTMLElement {
  hostApi?: HostApi;
  private root: Root | null = null;

  connectedCallback() {
    if (!this.hostApi) throw new Error("hostApi n'a pas été fourni à l'élément du module.");
    this.root = createRoot(this);
    this.root.render(
      <Categories
        host={this.hostApi}
        onChanged={() => this.dispatchEvent(new CustomEvent("gu:data-changed", { bubbles: true }))}
      />
    );
  }

  disconnectedCallback() {
    // Démontage différé : React interdit unmount() pendant le rendu du parent.
    const root = this.root;
    this.root = null;
    queueMicrotask(() => root?.unmount());
  }
}

if (!customElements.get(ELEMENT_NAME)) {
  customElements.define(ELEMENT_NAME, FencingCategoriesElement);
}

window.__GU_HOST__?.registerView({
  extensionId: "fencing-categories",
  label: "Catégories",
  element: ELEMENT_NAME
});
