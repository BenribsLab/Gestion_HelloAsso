import { build } from "vite";
import react from "@vitejs/plugin-react";
import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outputRoot = resolve(here, "..", "apps", "api", "bundled-plugins");

const requested = process.argv.slice(2);
const identifiers = requested.length > 0 ? requested : await discover();

for (const id of identifiers) {
  const source = join(here, id);
  const manifest = JSON.parse(await readFile(join(source, "plugin.json"), "utf8"));
  const output = join(outputRoot, id);

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  if (manifest.entrypoints?.server) {
    // Tout est embarqué sauf les modules natifs : un paquet ne doit jamais dépendre du
    // node_modules de l'hôte, donc ni de ses versions.
    await build({
      configFile: false,
      root: source,
      logLevel: "warn",
      build: {
        target: "node24",
        outDir: join(output, "server"),
        emptyOutDir: true,
        minify: false,
        lib: { entry: join(source, "src/server/index.ts"), formats: ["es"] },
        rollupOptions: {
          external: (id) => id.startsWith("node:"),
          output: { entryFileNames: "index.mjs" }
        }
      },
      ssr: { noExternal: true },
      resolve: { conditions: ["node", "import", "default"] }
    });
  }

  if (manifest.entrypoints?.web) {
    await build({
      configFile: false,
      root: source,
      logLevel: "warn",
      plugins: [react()],
      // Sans cela, React embarque sa version de développement et référence `process`,
      // qui n'existe pas dans le navigateur.
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      build: {
        target: "es2022",
        outDir: join(output, "web"),
        emptyOutDir: true,
        minify: true,
        cssCodeSplit: false,
        lib: { entry: join(source, "src/web/index.tsx"), formats: ["es"] },
        rollupOptions: {
          output: { entryFileNames: "index.js", assetFileNames: "styles.css" }
        }
      }
    });
  }

  await cp(join(source, "plugin.json"), join(output, "plugin.json"));
  if (await exists(join(source, "migrations"))) {
    await cp(join(source, "migrations"), join(output, "migrations"), { recursive: true });
  }
  console.log(`Module ${id} v${manifest.version} construit dans ${output}`);
}

async function discover() {
  const entries = await readdir(here, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("."))
    .sort();
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
