import { ZipArchive } from "archiver";
import { PassThrough } from "node:stream";

/**
 * Utilitaires purs partagés entre le noyau (export de documents santé) et les modules
 * (Documents IRL) : aucun accès aux données, rien à auditer, donc exposés à `host.core` sans
 * capacité à déclarer au manifeste.
 */

export function safeDownloadName(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
    .slice(0, 100) || "documents-irl";
}

export async function zipBuffer(files: Array<{ name: string; content: Buffer }>) {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const completed = new Promise<Buffer>((resolve, reject) => {
    output.once("end", () => resolve(Buffer.concat(chunks)));
    output.once("error", reject);
  });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.once("error", (error: Error) => output.destroy(error));
  archive.pipe(output);
  for (const file of files) archive.append(file.content, { name: file.name });
  await archive.finalize();
  return completed;
}
