export type DetectedType = { mime: "application/pdf" | "image/png" | "image/jpeg" | "image/gif"; ext: "pdf" | "png" | "jpg" | "gif" };

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87A = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]; // GIF87a
const GIF89A = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]; // GIF89a

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  return sig.every((b, i) => bytes[i] === b);
}

/** Identifies a file by its leading magic bytes only; never trusts a declared content-type or extension. */
export function detectType(bytes: Uint8Array): DetectedType | undefined {
  if (startsWith(bytes, PDF)) return { mime: "application/pdf", ext: "pdf" };
  if (startsWith(bytes, PNG)) return { mime: "image/png", ext: "png" };
  if (startsWith(bytes, JPEG)) return { mime: "image/jpeg", ext: "jpg" };
  if (startsWith(bytes, GIF87A) || startsWith(bytes, GIF89A)) return { mime: "image/gif", ext: "gif" };
  return undefined;
}

const MAX_LENGTH = 80;

/** Basename only, `[A-Za-z0-9._-]` only, the detected extension always wins over whatever the name claimed. */
export function safeFilename(name: string, ext: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const sanitized = base.replace(/[^A-Za-z0-9._-]/g, "");
  const dot = sanitized.lastIndexOf(".");
  const stem = dot > 0 ? sanitized.slice(0, dot) : sanitized;
  const finalStem = stem.length > 0 ? stem : "receipt";
  const suffix = `.${ext}`;
  const maxStemLength = Math.max(1, MAX_LENGTH - suffix.length);
  return `${finalStem.slice(0, maxStemLength)}${suffix}`;
}
