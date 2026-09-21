import { createHash, createPrivateKey, sign } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZipArchive } from "archiver";

const here = dirname(fileURLToPath(import.meta.url));
const id = process.argv[2];
if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error("Usage : npm run package:extension -- <identifiant>");
const source = resolve(here, "..", "apps", "api", "bundled-plugins", id);
const manifest = JSON.parse(await readFile(join(source, "plugin.json"), "utf8"));
if (manifest.id !== id) throw new Error("Le manifeste ne correspond pas à l'identifiant demandé.");
const files = await collect(source);
const hashes = Object.fromEntries(files.map(({ path, content }) => [path, createHash("sha256").update(content).digest("hex")]));
const keyPath = process.env.GU_PLUGIN_SIGNING_KEY_FILE;
const allowUnsigned = process.env.GU_ALLOW_UNSIGNED_PACKAGE === "true";
if (!keyPath && !allowUnsigned) throw new Error("Configurez GU_PLUGIN_SIGNING_KEY_FILE pour signer le paquet.");
let signature = null;
if (keyPath) {
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, id, version: manifest.version, files: hashes }), "utf8");
  signature = {
    schemaVersion: 1,
    algorithm: "Ed25519",
    signature: sign(null, payload, createPrivateKey(await readFile(keyPath, "utf8"))).toString("base64"),
    files: hashes
  };
}
const outputDirectory = resolve(here, "..", "artifacts");
await mkdir(outputDirectory, { recursive: true });
const output = join(outputDirectory, `${id}-${manifest.version}.gu-plugin`);
await new Promise((resolvePromise, reject) => {
  const stream = createWriteStream(output, { mode: 0o600 });
  const archive = new ZipArchive({ zlib: { level: 9 } });
  stream.on("close", resolvePromise); stream.on("error", reject); archive.on("error", reject);
  archive.pipe(stream);
  for (const file of files) archive.append(file.content, { name: file.path, mode: 0o600 });
  if (signature) archive.append(JSON.stringify(signature), { name: "signature.json", mode: 0o600 });
  void archive.finalize();
});
console.log(output);

async function collect(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Les liens symboliques sont interdits.");
    if (entry.isDirectory()) result.push(...await collect(root, absolute));
    else if (entry.isFile()) result.push({ path: absolute.slice(root.length + 1).replaceAll("\\", "/"), content: await readFile(absolute) });
  }
  return result;
}
