// Helpers for agent-upload: checking the agent's key and the files it sends.

/** The file types the portal accepts (the same list as the storage buckets and the portal pages). */
export const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  csv: "text/csv",
  txt: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
};

/** Content type for a file name, or null if the portal doesn't accept that kind of file. */
export function fileType(name: string): string | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return name.includes(".") ? FILE_TYPES[ext] ?? null : null;
}

/** A file name safe for a storage path: letters, digits, dot, dash and underscore; at most 120 characters. */
export function safeName(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").slice(-120);
}

/** The shortest key accepted, so a guessable value can't switch the function on. */
export const MIN_KEY_LENGTH = 32;

/** Compare the presented key with the configured one, in time that doesn't depend on where they differ. */
export function keyMatches(given: string | null, expected: string | undefined): boolean {
  if (!given || !expected || expected.length < MIN_KEY_LENGTH) return false;
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

/** Decode base64 (standard or URL-safe, with or without padding) to bytes; null if it isn't base64. */
export function fromBase64(s: string): Uint8Array | null {
  const clean = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  try {
    const bin = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, "="));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
