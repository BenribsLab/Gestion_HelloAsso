import { type Member } from "../api";
import { uiContracts } from "../extension-contracts";

/**
 * Ce qu'il reste du module côté cœur. La vue « Catégories » est désormais un bundle
 * autonome (voir extensions/fencing-categories/src/web), chargé à l'exécution.
 *
 * Subsistent ici les fragments injectés *à l'intérieur* de vues du cœur — la colonne et le
 * badge de catégorie dans les tableaux d'adhérents et de groupes. Les sortir demande un vrai
 * mécanisme d'emplacements de colonnes, prévu pour la manche qui traitera
 * `ffe-health-documents`, qui en dépend bien davantage.
 */

const EXTENSION_ID = "fencing-categories";

uiContracts.memberColumns.register("category", { extensionId: EXTENSION_ID });
uiContracts.irlTargets.register("categories", { extensionId: EXTENSION_ID });

export function memberCategoryLabel(member: Pick<Member, "fencingCategory" | "categoryError">) {
  return member.categoryError || !member.fencingCategory ? "À corriger" : member.fencingCategory;
}

export function CategoryBadge({ member }: { member: Pick<Member, "fencingCategory" | "categoryError"> }) {
  if (member.categoryError) return <span className="category-badge error" title={member.categoryError}>À corriger</span>;
  return member.fencingCategory ? <span className="category-badge">{member.fencingCategory}</span> : <span className="category-badge error">À corriger</span>;
}
