# Gestion des adhérents

Pour la mise en production sécurisée sur le VPS, suivre [DEPLOYMENT.md](./DEPLOYMENT.md).

Socle local pour synchroniser à terme les adhésions HelloAsso, organiser les adhérents en groupes et préparer les communications du club.

## Démarrage

Prérequis : Docker Desktop avec Docker Compose.

1. Copier `.env.example` vers `.env`.
2. Renseigner les trois variables `HELLOASSO_*` si vous souhaitez tester la connexion. Elles peuvent rester vides pour découvrir l'application.
3. Lancer `docker compose up --build`.
4. Ouvrir <http://localhost:18473>.

L'API est aussi accessible localement sur <http://localhost:18474/api/health>.

## Services

- `web` : interface React compilée puis servie par nginx ;
- `api` : serveur Node.js/TypeScript ;
- `database` : PostgreSQL avec volume persistant.

Les migrations sont exécutées automatiquement au démarrage de l'API.

## Extensions

Les fonctions spécialisées sont livrées comme extensions précompilées :

- `fencing-categories` : catégories Escrime ;
- `ffe-health-documents` : documents Santé FFE ;
- `attendance-sheets` : feuilles de présence ;
- `irl-documents` : documents papier personnalisés ;
- `email-messaging` : messagerie SMTP.

Le menu **Extensions** permet de les activer ou les désactiver. Une désactivation retire les commandes de l'interface et bloque également les routes correspondantes dans l'API. Elle ne supprime jamais les données déjà enregistrées. **Aucune extension n'est livrée ni activée par défaut** : `docker compose up --build` ne construit que le noyau (`bundled-plugins` est intentionnellement vide dans l'image publique). Chaque extension s'achète et se télécharge signée sur le site de vente, puis s'installe depuis le menu Extensions — voir la section suivante.

Les cinq modules sont physiquement séparés du cœur : bundle serveur, Web Component navigateur et migrations vivent sous `extensions/`. Le menu **Extensions** accepte un paquet `.gu-plugin` sans reconstruire les images. L'archive est bornée, contrôlée contre les traversées de chemins, liens symboliques et bombes ZIP, puis sa compatibilité, ses empreintes et sa signature Ed25519 sont vérifiées avant une bascule atomique. L'ancienne version reste disponible pour un retour arrière. En production, un paquet non signé est toujours refusé ; `EXTENSION_ALLOW_UNSIGNED=true` est strictement réservé au développement.

Les paquets installés et les versions de retour arrière sont conservés dans le volume Docker `plugin_data`. Le journal d'installation ne contient ni fiche d'adhérent ni document personnel. Après une installation ou un retour arrière en production, le conteneur API redémarre automatiquement grâce à sa politique Docker `restart: unless-stopped`.

Pour fabriquer un paquet, construire d'abord les extensions puis utiliser `npm run package:extension -- identifiant`. La clé privée Ed25519 est indiquée uniquement sur la machine de distribution avec `GU_PLUGIN_SIGNING_KEY_FILE`; elle ne doit jamais être copiée chez un club. Le mode `GU_ALLOW_UNSIGNED_PACKAGE=true` sert seulement aux essais locaux.

Le serveur central (clubs, droits par module, catalogue, téléchargement des paquets, jetons Ed25519 liés à une installation) vit **dans un dépôt séparé**, `gestion-utilisateur-licence-server` : le code qui délivre les licences ne doit jamais partir avec ce dépôt-ci chez un club. Il ne reçoit aucune donnée HelloAsso, aucun adhérent et aucun document. Le client conserve un jeton local et tolère une panne du catalogue pendant la période de grâce configurée (`EXTENSION_OFFLINE_GRACE_DAYS`). Un abonnement expiré n'efface jamais les données : il empêche une nouvelle activation ou mise à jour, tandis qu'un module déjà actif reste disponible pour permettre la lecture et l'export. La facturation Stripe reste volontairement hors du socle tant que le modèle commercial n'est pas stabilisé.

Les images sont fixées sur Node.js 24 LTS, PostgreSQL 18 et nginx 1.30 stable. Les dépendances npm sont verrouillées par `package-lock.json` et contrôlées avec `npm audit`. Les images d'exécution sont réduites aux dépendances nécessaires, mises à jour au moment de la construction et prévues pour être contrôlées avec un scanner de conteneurs.

## Commandes utiles

- Démarrer : `docker compose up --build`
- Démarrer en arrière-plan : `docker compose up --build -d`
- Voir les journaux : `docker compose logs -f`
- Arrêter : `docker compose down`
- Arrêter et effacer la base locale : `docker compose down -v`

La dernière commande supprime définitivement les données locales du volume PostgreSQL.

## Configuration HelloAsso

Pour tester sans données réelles, conserver `HELLOASSO_BASE_URL=https://api.helloasso-sandbox.com` et utiliser les identifiants d'une association créée dans le sandbox.

Pour utiliser le compte réel, choisir `HELLOASSO_BASE_URL=https://api.helloasso.com` et renseigner les identifiants obtenus dans **Mon compte → Intégrations et API** ainsi que le slug de l'association.

Les secrets ne sont jamais transmis au navigateur. L'écran d'accueil permet uniquement de demander au serveur de vérifier la connexion.

L'accès à l'API métier HelloAsso est strictement en lecture seule : consultation de l'association, des campagnes et des inscriptions. Le seul appel `POST` envoyé à HelloAsso concerne l'obtention du jeton OAuth et ne modifie aucune donnée de l'association.

### Assistant de création de la base

L'onglet **Configuration** suit ce parcours :

1. vérifier la connexion serveur à HelloAsso ;
2. découvrir les campagnes d'adhésion et identifier celles qui sont en cours ;
3. sélectionner une ou plusieurs campagnes ;
4. analyser et regrouper leurs champs personnalisés ;
5. choisir les données facultatives à conserver ;
6. choisir un ou plusieurs champs servant à composer les groupes ;
7. donner un nom à chaque groupe et lui associer une ou plusieurs valeurs ;
8. importer ou actualiser les adhérents.

Les correspondances d'un groupe fonctionnent avec une logique « OU ». Par exemple, les tarifs `M9 Débutant` et `M11 Débutant` peuvent tous deux alimenter un groupe nommé `M9 M11 débutant`. Les suffixes de paiement en une ou plusieurs fois, ainsi que le paiement par chèque, sont retirés lors de la comparaison : le mode de paiement ne crée donc pas de groupes différents.

Le prénom, le nom, la campagne, le tarif et le statut HelloAsso sont toujours conservés. Les inscriptions `Processed` et `Registered` sont considérées comme valides ; les inscriptions annulées ne deviennent pas des adhérents actifs.

### Affectations manuelles

Dans **Adhérents**, le bouton **Changer** permet de sélectionner précisément les groupes d'une personne. Dans **Groupes**, un clic sur un groupe affiche sa composition exacte et permet de déplacer ou retirer chaque adhérent. Ces choix sont enregistrés uniquement dans PostgreSQL local et restent prioritaires lors des imports HelloAsso suivants.

Le formulaire **Créer un groupe automatique** permet de choisir un critère provenant des données HelloAsso conservées localement — tarif, campagne ou champ supplémentaire sélectionné — ou la catégorie FFE calculée. Une ou plusieurs valeurs du critère peuvent alimenter le même groupe. Sa composition est recalculée après les imports et les corrections locales, sans annuler les exclusions et déplacements manuels.

Les groupes créés hors configuration peuvent être supprimés depuis leur détail, après une confirmation explicite. Cette suppression efface uniquement le groupe et ses données associées dans la base locale ; elle ne supprime aucun adhérent et ne modifie rien dans HelloAsso. Les groupes produits par la configuration restent protégés et doivent être gérés depuis celle-ci.

Un clic sur le nom d'un adhérent ouvre également sa fiche locale. Le prénom, le nom et tous les champs supplémentaires sélectionnés pendant la configuration peuvent y être corrigés. Chaque valeur corrigée porte la mention **Modifié localement** et peut être restaurée individuellement avec **Revenir à HelloAsso**. Les corrections locales sont conservées lors des imports suivants et aucune donnée n'est écrite dans HelloAsso.

### Catégories FFE et feuilles de présence

La catégorie d'escrime est calculée depuis la date de naissance selon un tableau local prérempli avec les catégories M5 à V4. L'onglet **Catégories** permet d'ajouter, renommer ou supprimer une catégorie et de modifier sa plage d'années de naissance pour la saison active. Ce tableau alimente le répertoire, les groupes automatiques et les feuilles de présence.

La date de changement de saison est réglable et vaut par défaut le 1er septembre. À la bascule, l'application recopie automatiquement la configuration de la saison précédente et décale toutes les années de naissance de +1. Les noms et les catégories ajoutées localement sont donc conservés d'une année à l'autre.

Chaque groupe peut recevoir un ou plusieurs créneaux hebdomadaires. L'onglet **Feuilles de présence** permet ensuite de choisir une période de cours proposée entre deux vacances scolaires ou des dates personnalisées. Les séances situées pendant les vacances de l'académie de Versailles, zone C, sont exclues grâce au calendrier officiel du ministère de l'Éducation nationale.

Une feuille peut être imprimée, enregistrée en PDF ou remplie dans l'application. Chaque case passe successivement par les états présent, absent, excusé et non renseigné. Les saisies sont enregistrées dans PostgreSQL local.

### Documents IRL

L'onglet **Documents IRL** produit des courriers papier personnalisés depuis un éditeur de texte mis en forme. Les variables comme `{prenom}`, `{nom}`, `{groupes}`, `{categorie}`, `{email}`, `{telephone}` ou `{adresse}` sont remplacées par les informations locales prioritaires de chaque adhérent. Les champs supplémentaires sélectionnés dans la configuration sont également proposés comme variables.

Les contenus réutilisables peuvent être enregistrés dans la bibliothèque de modèles, puis chargés, modifiés ou supprimés. Un modèle conserve sa mise en forme, son nom de fichier et son mode d'export ; les données des adhérents et les destinataires sont toujours recalculés au moment de la génération.

Les destinataires peuvent être tous les adhérents, les personnes sans certificat ou attestation de santé valide, un ou plusieurs groupes, une ou plusieurs catégories FFE, ou une sélection nominative. L'export produit soit un PDF unique dans lequel chaque adhérent commence sur une nouvelle page, soit une archive ZIP contenant un PDF individuel par adhérent.

### Messages par e-mail

L'onglet **Messages** envoie les e-mails par le compte SMTP configuré dans `.env`. Pour un compte OVH MX Plan européen, la configuration prévue utilise `smtp.mail.ovh.net`, le port `587` et STARTTLS. Le nom d'utilisateur est l'adresse e-mail complète.

```dotenv
SMTP_HOST=smtp.mail.ovh.net
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=no-reply@escrime-cey.fr
SMTP_PASSWORD=mot-de-passe-de-la-boite
SMTP_FROM_EMAIL=no-reply@escrime-cey.fr
SMTP_FROM_NAME=Cercle d'Escrime de Yerres
SMTP_REPLY_TO=
```

Un message peut être envoyé à une adresse unique de test, à un ou plusieurs groupes, ou à tous les adhérents actifs possédant une adresse valide. Chaque adresse reçoit un e-mail individuel et les doublons entre plusieurs groupes sont supprimés. Une confirmation indique le nombre exact d'adresses avant l'envoi. Le résultat de chaque envoi est conservé dans un journal local ; le mot de passe SMTP n'est jamais enregistré dans PostgreSQL ni transmis au navigateur.

## Sécurité et mise en production

En local, l'authentification est désactivée par défaut pour conserver un démarrage simple sur `127.0.0.1`. La configuration de production l'active obligatoirement et ajoute :

- des comptes nominatifs administrables dans l'interface et des mots de passe hachés avec `scrypt` ;
- des sessions courtes dans un cookie `HttpOnly`, `Secure`, `SameSite=Strict`, avec expiration par inactivité ;
- une protection CSRF, un contrôle strict de l'origine et une limitation des tentatives de connexion ;
- des en-têtes CSP/HSTS et l'absence de secrets dans le navigateur ;
- des journaux de sécurité ne contenant ni mot de passe ni contenu des fiches ;
- des secrets Docker montés comme fichiers, des conteneurs non privilégiés et des réseaux séparés ;
- une API conservée sur le même domaine que l'interface, sous `/api`, afin d'éviter une exposition inutile.

Le déploiement HTTPS, le pare-feu du VPS et les sauvegardes sont détaillés dans [DEPLOYMENT.md](./DEPLOYMENT.md). Il n'existe pas encore de webhook public : les données HelloAsso restent récupérées à la demande et exclusivement en lecture.
