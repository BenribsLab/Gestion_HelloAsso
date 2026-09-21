# Phase 0 — reconnaissance du site `dirigeant.escrime-ffe.fr`

Notes issues d'un enregistrement `playwright codegen` en conditions réelles (aucune licence
validée pendant la reconnaissance). Sert de point de départ à `selectors.ts`/`steps.ts` en
Phase 3 — à vérifier à nouveau à ce moment-là, le site peut avoir changé entre-temps.

## Connexion

- `goto('https://dirigeant.escrime-ffe.fr/auth/login')`
- `getByRole('textbox', { name: "Nom d'utilisateur /" })`
- `getByRole('textbox', { name: 'Mot de passe' })`
- `getByRole('button', { name: 'Me connecter' })`
- Badge « 2FA » visible dans l'en-tête après connexion (observé non activée sur le compte testé) —
  la fédération propose donc potentiellement une double authentification. Pas encore observé à
  quoi ressemble le parcours si elle est activée.
- Pas encore observé précisément à quoi ressemble une redirection "session expirée" (à vérifier en
  Phase 1/3 en vidant le `storageState` stocké).

## Étape 1 — recherche d'une personne

- `goto('https://dirigeant.escrime-ffe.fr/licence/saisie/etape-1')`
- `getByRole('button', { name: " Choix d'une personne" })`
- Toggle « Dans la structure » : composant **switchery**, pas un `role="switch"` natif —
  `page.locator('.switchery').first()`.
- Champ de recherche **unique** : `getByRole('textbox')` (pas de nom accessible distinctif),
  prend `"NOM prénom"` en une seule chaîne (ex. `"GARNIER tom"`), pas deux champs séparés.
- `getByRole('button', { name: ' Rechercher' })`

## Résultats de recherche

Tableau avec colonnes : **Code adhérent / Nom / Année naissance / Dernière licence**.
Important : **l'année de naissance seule est affichée, jamais la date complète** — la
correspondance au stade de la liste ne peut donc se faire que sur nom + année, pas date exacte.
Autre point trouvé en écrivant les tests de `matching.ts` : la colonne Nom contient une civilité
en préfixe (ex. `"M GARNIER Tom"`), absente du nom/prénom connu côté adhérent — à retirer avant
toute comparaison (`normalizeName` le fait désormais).

- Sélectionner une ligne : cliquer directement sur la cellule (ex.
  `getByRole('cell', { name: '1998' })`) → mène à `étape-2`.
- Aucun résultat correspondant : seul le bouton `getByRole('button', { name: " Ajout d'une
  nouvelle" })` (« Ajout d'une nouvelle personne ») reste proposé.

## Étape 2 — « Informations de la personne » (personne existante)

URL `licence/saisie/etape-2`. Affiche nom, **date de naissance complète** (ex. « Né(e) le
27/07/1998 »), e-mail, adresse. Question « Ces informations ont-elles changé ? » avec deux
boutons : « Modifier ces informations » / « Continuer la saisie ». Mène ensuite à `étape-3`
(« Choix de la licence ») puis `étape-4` (« Récapitulatif de la commande »).

**Tout ce sous-parcours (étape-2, 3, 4) est diffusé en direct à l'utilisateur** — l'automatique
silencieux s'arrête à l'atterrissage sur étape-2, ne clique jamais ces boutons lui-même. Pas encore
observé le contenu détaillé d'étape-3/étape-4, ni à quoi ressemble une confirmation réussie (fait
volontairement pas testé pendant la reconnaissance, pour ne déposer aucune vraie licence).

## Étape 2/ajout — « Ajout d'une nouvelle personne »

Sélecteurs observés (formulaire long, type template générique) :

```
input[name="nom"]
input[name="prenom"]
input[name="nom_naissance"]
getByRole('textbox', { name: '__/__/____' })          // Date de naissance
input[name="adresse[mail]"]
input[name="adresse[mail_pro]"]
input[name="adresse[tel]"]
input[name="adresse[mobile]"]
input[name="adresse[tel2]"]
input[name="adresse[mobile2]"]
input[name="adresse[batiment]"]
input[name="adresse[escalier]"]
input[name="adresse[num_voie]"]
input[name="adresse[nom_voie]"]
input[name="adresse[lieu_dit]"]
input[name="adresse[code_postal]"]
input[name="adresse[commune_libre]"]
getByRole('combobox', { name: 'Non' })                 // Situation de handicap
getByTitle('Oui (Déficient Visuel)')                   // option d'exemple du combobox handicap
#representant_legal_nom / #representant_legal_prenom / #representant_legal_telephone / #representant_legal_mail
```

Champs Civilité, Nationalité(s), Lieu/Département/Commune de naissance et Type Voie sont des
listes déroulantes/selectize dont l'**ID contient un hash généré par session**
(`#div__dept_naissance_6ab1a41ecec38`) — **ne jamais cibler ces ID directement**, passer par label
visible ou position structurelle.

Champs « représentant légal » (nom/prénom/téléphone/mail) présents dans le formulaire —
probablement exigés pour un mineur. À vérifier si HelloAsso fournit déjà cette info (parent/tuteur)
avant de décider comment la pré-remplir.

## Ce qu'il reste à observer avant la Phase 3

- Contenu exact d'un écran de session expirée.
- Déroulé complet d'étape-3/étape-4 avec un adhérent réel, jusqu'à un vrai clic de confirmation
  (sur un adhérent de test non critique, conformément au plan de vérification).
- À quoi ressemble une confirmation réussie (URL/marqueur DOM) — nécessaire pour
  `confirm-result` côté sidecar.
