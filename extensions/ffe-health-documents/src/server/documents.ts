import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { PDFDocument } from "pdf-lib";

export const maxDocumentBytes = 15 * 1024 * 1024;
export const healthAnalysisVersion = 2;
export type DocumentClassification = "certificate" | "attestation" | "questionnaire" | "unknown";

export type DocumentContent = {
  content: Buffer;
  mediaType: "application/pdf" | "image/jpeg" | "image/png";
  fileName: string;
  source: "local" | "helloasso";
};

export function validateDocument(content: Buffer, suppliedType = "", suppliedName = "document"): DocumentContent {
  if (content.length === 0) throw new Error("Le fichier est vide.");
  if (content.length > maxDocumentBytes) throw new Error("Le document dépasse la limite de 15 Mo.");
  const mediaType = detectedMediaType(content);
  if (!mediaType) throw new Error("Seuls les fichiers PDF, JPEG et PNG sont acceptés.");
  const declaredType = suppliedType.split(";", 1)[0]?.trim().toLowerCase().replace("image/jpg", "image/jpeg") ?? "";
  if (declaredType && !new Set([mediaType, "application/octet-stream"]).has(declaredType)) {
    throw new Error("Le contenu du fichier ne correspond pas à son type déclaré.");
  }
  validateImageDimensions(content, mediaType);
  return { content, mediaType, fileName: safeOriginalName(suppliedName, mediaType), source: "local" };
}

export function documentHash(document: Pick<DocumentContent, "content">) {
  return createHash("sha256").update(document.content).digest("hex");
}

export async function recognizeHealthDocument(document: DocumentContent, knownHash = documentHash(document)) {
  const hash = knownHash;
  let text = "";
  const pageTexts: string[] = [];
  const directory = await mkdtemp(join(tmpdir(), "gu-document-"));
  try {
    const extension = document.mediaType === "application/pdf" ? ".pdf" : document.mediaType === "image/png" ? ".png" : ".jpg";
    const source = join(directory, `source${extension}`);
    await writeFile(source, document.content, { mode: 0o600 });
    if (document.mediaType === "application/pdf") {
      const target = join(directory, "text.txt");
      await runCommand("pdftotext", ["-f", "1", "-l", "3", source, target]).catch(() => undefined);
      text = await readFile(target, "utf8").catch(() => "");
      const initialClassification = classifyHealthText(`${document.fileName} ${text}`);
      if (text.trim().length < 120 || initialClassification === "unknown" || initialClassification === "questionnaire") {
        const imageBase = join(directory, "page");
        await runCommand("pdftoppm", ["-f", "1", "-l", "3", "-scale-to", "3200", "-jpeg", "-jpegopt", "quality=90", source, imageBase]);
        const pages = (await readdir(directory))
          .filter((name) => /^page-\d+\.jpg$/.test(name))
          .sort((left, right) => left.localeCompare(right, "fr", { numeric: true }));
        for (const [index, page] of pages.entries()) {
          const pageText = await ocr(join(directory, page), directory, `page-${index}`);
          pageTexts.push(pageText);
          text += ` ${pageText}`;
        }
      }
    } else {
      text = await ocr(source, directory, "image");
      pageTexts.push(text);
    }
  } catch {
    // Une panne d'OCR ne bloque jamais l'accès au document : il reste à classer manuellement.
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const pageClassifications = pageTexts.map(classifyHealthText);
  const classification = pageClassifications.includes("attestation")
    ? "attestation"
    : pageClassifications.includes("certificate")
      ? "certificate"
      : classifyHealthText(`${document.fileName} ${text}`);
  return { classification, hash };
}

export async function documentAsPdf(document: DocumentContent) {
  if (document.mediaType === "application/pdf") return document.content;
  const pdf = await PDFDocument.create();
  const image = document.mediaType === "image/png"
    ? await pdf.embedPng(document.content)
    : await pdf.embedJpg(document.content);
  const page = pdf.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  return Buffer.from(await pdf.save());
}

export function classifyHealthText(value: string): DocumentClassification {
  const text = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/\s+/g, " ");
  const attestation = score(text, [
    /atteste.{0,30}(sur l.honneur|avoir repondu)/, /certifie.{0,30}honneur/,
    /je soussigne.{0,250}(atteste|certifie|avoir renseigne|avoir repondu)/,
    /repondu.{0,100}(non|par la negative|negativement)/,
    /reponses?.{0,30}negatives?/, /aucune.{0,30}reponse.{0,30}positive/,
    /ensemble.{0,30}(rubriques|questions)/
  ]);
  const questionnaire = score(text, [
    /questionnaire.{0,25}sante/, /qs[\s-]?sport/, /cerfa.{0,15}15699/, /15699[\s*_-]*01/,
    /durant les 12 derniers mois/, /avez[\s-]?vous ressenti/
  ]);
  const certificate = score(text, [
    /certificat.{0,20}medical/, /certifie que/, /non.{0,15}contre[\s-]?indication/,
    /absence.{0,15}contre[\s-]?indication/, /docteur|medecin/
  ]);
  if (certificate >= 2 || /certificat.{0,20}medical|certifie que/.test(text)) return "certificate";
  if (attestation > 0) return "attestation";
  if (questionnaire > 0) return "questionnaire";
  if (/\battestation\b/.test(text)) return "attestation";
  return "unknown";
}

export function exportBaseName(template: string, input: {
  memberFirstName: string; memberLastName: string; payerFirstName?: string | null; payerLastName?: string | null;
  identitySource: "member" | "payer"; classification: DocumentClassification;
}) {
  const usePayer = input.identitySource === "payer" && (input.payerFirstName || input.payerLastName);
  const firstName = usePayer ? input.payerFirstName ?? "" : input.memberFirstName;
  const lastName = usePayer ? input.payerLastName ?? "" : input.memberLastName;
  const kind = input.classification === "certificate" ? "certificat"
    : input.classification === "attestation" ? "attestation" : "document-a-classer";
  const exportKind = input.classification === "questionnaire" ? "questionnaire-a-remplacer" : kind;
  const result = template
    .replaceAll("{nom}", lastName.toLocaleUpperCase("fr"))
    .replaceAll("{prenom}", firstName)
    .replaceAll("{type_document}", exportKind)
    .replaceAll(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replaceAll(/\s+/g, " ").replaceAll(/[- ]+$/g, "").trim();
  return (result || "document").slice(0, 180);
}

function detectedMediaType(content: Buffer): DocumentContent["mediaType"] | null {
  if (content.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
  if (content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  return null;
}

function validateImageDimensions(content: Buffer, mediaType: DocumentContent["mediaType"]) {
  let dimensions: [number, number] | null = null;
  if (mediaType === "image/png" && content.length >= 24) {
    dimensions = [content.readUInt32BE(16), content.readUInt32BE(20)];
  } else if (mediaType === "image/jpeg") {
    for (let offset = 2; offset + 9 < content.length;) {
      if (content[offset] !== 0xff) break;
      const marker = content[offset + 1]!;
      const length = content.readUInt16BE(offset + 2);
      if (new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]).has(marker)) {
        dimensions = [content.readUInt16BE(offset + 7), content.readUInt16BE(offset + 5)];
        break;
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  if (dimensions && (dimensions[0] <= 0 || dimensions[1] <= 0 || dimensions[0] * dimensions[1] > 40_000_000)) {
    throw new Error("L'image est trop grande pour être traitée en sécurité.");
  }
}

function safeOriginalName(name: string, mediaType: DocumentContent["mediaType"]) {
  const extension = mediaType === "application/pdf" ? ".pdf" : mediaType === "image/png" ? ".png" : ".jpg";
  const stem = name.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").replaceAll(/[<>:"/\\|?*\x00-\x1f]/g, "-").trim();
  return `${(stem || "document").slice(0, 180)}${extension}`;
}

function score(text: string, expressions: RegExp[]) {
  return expressions.reduce((total, expression) => total + (expression.test(text) ? 1 : 0), 0);
}

async function ocr(source: string, directory: string, suffix: string) {
  const standard = join(directory, `ocr-${suffix}`);
  const block = join(directory, `ocr-block-${suffix}`);
  await runCommand("tesseract", [source, standard, "-l", "fra+osd", "--psm", "1"]).catch(() => undefined);
  await runCommand("tesseract", [source, block, "-l", "fra", "--psm", "6"]).catch(() => undefined);
  return `${await readFile(`${standard}.txt`, "utf8").catch(() => "")} ${await readFile(`${block}.txt`, "utf8").catch(() => "")}`;
}

function runCommand(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const process = spawn(command, args, { stdio: "ignore" });
    const timeout = setTimeout(() => { process.kill("SIGKILL"); reject(new Error("Délai OCR dépassé.")); }, 30_000);
    process.once("error", (error) => { clearTimeout(timeout); reject(error); });
    process.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(); else reject(new Error(`${command} a échoué.`));
    });
  });
}
