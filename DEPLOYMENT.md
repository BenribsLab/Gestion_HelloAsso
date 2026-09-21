# Déploiement sécurisé sur `cey.benribs.fr`

L'application doit être publiée uniquement sur `https://cey.benribs.fr`. L'API reste accessible par le chemin `/api` du même domaine et ne doit pas être exposée directement. Le fichier `deploy/Caddyfile` renvoie volontairement une réponse 404 sur `cey-api.benribs.fr`.

## 1. Préparer le VPS

- Utiliser une distribution Linux encore maintenue.
- Installer Docker Engine et le plugin Docker Compose depuis le dépôt officiel Docker.
- Administrer le serveur avec un utilisateur nominatif, `sudo` et une clé SSH.
- Désactiver la connexion SSH de `root` et l'authentification SSH par mot de passe.
- N'ouvrir au pare-feu que `80/tcp`, `443/tcp` et le port SSH depuis les adresses nécessaires.
- Installer Caddy sur l'hôte pour la terminaison HTTPS.

Le DNS doit contenir un enregistrement `A` (et éventuellement `AAAA`) pour `cey.benribs.fr` vers le VPS. Le sous-domaine `cey-api.benribs.fr` n'est pas nécessaire.

## 2. Copier l'application

Placer le dépôt dans un répertoire réservé, par exemple `/opt/cey-gestion`, appartenant à l'utilisateur de déploiement. Ne jamais copier le fichier `.env` local sur le serveur.

Créer `/opt/cey-gestion/.env.production` avec les valeurs non secrètes :

```dotenv
POSTGRES_DB=gestion_utilisateurs
POSTGRES_USER=gestion_app
APP_HOST_PORT=18473
API_HOST_PORT=18474

HELLOASSO_BASE_URL=https://api.helloasso.com
HELLOASSO_CLIENT_ID=identifiant-fourni-par-helloasso
HELLOASSO_ORGANIZATION_SLUG=cercle-d-escrime-de-yerres-cey

SMTP_HOST=smtp.mail.ovh.net
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=no-reply@escrime-cey.fr
SMTP_FROM_EMAIL=no-reply@escrime-cey.fr
SMTP_FROM_NAME=Cercle d'Escrime de Yerres
SMTP_REPLY_TO=

BOOTSTRAP_ADMIN_EMAIL=adresse-personnelle-du-responsable@example.fr
BOOTSTRAP_ADMIN_NAME=Nom du responsable
```

Protéger ce fichier avec des droits limités au propriétaire.

## 3. Créer les secrets

Créer le répertoire `/opt/cey-gestion/secrets` et cinq fichiers lisibles uniquement par le propriétaire :

- `postgres_password.txt` : mot de passe aléatoire long et unique ;
- `helloasso_client_secret.txt` : secret fourni par HelloAsso ;
- `smtp_password.txt` : mot de passe de la boîte d'envoi ;
- `bootstrap_admin_password.txt` : premier mot de passe administrateur, avec au moins 14 caractères.
- `settings_encryption_key.txt` : 32 octets aléatoires encodés en base64, par exemple avec
  `openssl rand -base64 32`. Cette clé chiffre les identifiants saisis dans l'interface et doit
  impérativement être conservée avec les sauvegardes.

Ne pas ajouter de saut de ligne inutile, ne jamais versionner ces fichiers et ne pas transmettre leur contenu dans un ticket ou une capture d'écran.

## 4. Démarrer l'application

Depuis le répertoire de l'application :

```sh
docker compose --env-file .env.production \
  -f compose.yaml -f compose.production.yaml \
  up -d --build
```

Au premier démarrage, l'administrateur défini dans `.env.production` est créé. Aux démarrages suivants, le mot de passe d'amorçage n'écrase jamais le mot de passe enregistré dans la base.

Se connecter immédiatement, ouvrir le menu du compte et remplacer le mot de passe initial. Cette opération déconnecte les autres sessions. La connexion HelloAsso se configure ensuite dans l'assistant de l'instance ; le secret y est chiffré et n'est jamais renvoyé au navigateur.

## 5. Activer HTTPS

Copier `deploy/Caddyfile` dans `/etc/caddy/Caddyfile`, vérifier la configuration puis recharger Caddy. Caddy récupère et renouvelle automatiquement le certificat TLS lorsque le DNS pointe vers le VPS et que les ports 80/443 sont accessibles.

Le port applicatif défini par `APP_HOST_PORT` (`18473` par défaut) et le port API défini par `API_HOST_PORT` (`18474` par défaut) restent liés à `127.0.0.1`. PostgreSQL n'est publié sur aucun port de l'hôte. Avec ISPConfig, la directive Apache doit envoyer le trafic vers `http://127.0.0.1:18473`. Prévoir également `ProxyTimeout 300` : la reconnaissance OCR d'un lot de documents peut durer plus d'une minute lors de sa première exécution.

## 6. Sauvegardes

Mettre en place une sauvegarde PostgreSQL quotidienne, chiffrée avant son envoi vers un stockage distinct du VPS. Conserver plusieurs versions et tester régulièrement une restauration. Une copie du volume Docker sur le même disque ne constitue pas une sauvegarde suffisante.

Les éléments à préserver sont :

- un export PostgreSQL cohérent ;
- `.env.production` ;
- les secrets, dans un coffre séparé et chiffré ;
- la version exacte du code ou l'identifiant Git déployé.

## 7. Maintenance

- Installer rapidement les correctifs de sécurité du système.
- Reconstruire régulièrement les images après mise à jour des versions épinglées.
- Contrôler les journaux Docker et le journal `security_audit_log`.
- Tester l'URL `/api/health` uniquement depuis le serveur ou la supervision autorisée.
- Révoquer immédiatement les accès d'un responsable qui quitte ses fonctions.
- Ne jamais publier Docker, PostgreSQL ou l'API sur une adresse publique.
