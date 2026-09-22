import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { loadConfig } from "./config.js";

// Retire uniquement le code sur disque (dossier "local", celui alimenté par
// /api/extensions/install) — ne touche jamais bundled-plugins (livré en lecture seule avec
// l'image). Au prochain démarrage, synchronizeBundledExtensions() constate l'absence du paquet
// et désactive l'entrée existante d'elle-même ("Paquet absent : réinstallez..."), sans qu'il soit
// nécessaire de manipuler la base ici — une réinstallation ultérieure (ex. fin d'essai gratuit)
// écrasera proprement cette même ligne.
const extensionId = process.argv[2];
if (!extensionId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(extensionId)) {
  throw new Error("Usage : node uninstall-extension-cli.js <extensionId>");
}

const config = loadConfig();
const base = resolve(config.extensions.directory);
const target = resolve(base, extensionId);
if (target !== base && !target.startsWith(base + sep)) {
  throw new Error("Identifiant d'extension invalide.");
}

await rm(target, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ uninstalled: true, id: extensionId }) + "\n");
