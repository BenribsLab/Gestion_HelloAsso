import { createHash } from "node:crypto";

export const maxDocumentBytes = 15 * 1024 * 1024;
export type DocumentClassification = "certificate" | "attestation" | "questionnaire" | "unknown";

export type DocumentContent = {
  content: Buffer;
  mediaType: "application/pdf" | "image/jpeg" | "image/png";
  fileName: string;
  source: "local" | "helloasso";
};

/** Validation générique des fichiers : elle reste disponible même sans extension Santé. */
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
