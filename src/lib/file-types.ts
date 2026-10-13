/**
 * What a file really is, from its first bytes (magic numbers), whatever its name or the browser's MIME type say.
 * PURE. Payment proofs are stored under the extension and type found here, so a page or script renamed to
 * "receipt.png" is refused instead of being stored and served back to the team.
 */

export type SniffedType = { ext: "png" | "jpg" | "gif" | "webp" | "heic" | "pdf"; mime: string };

function ascii(b: Uint8Array, from: number, len: number): string {
  let s = "";
  for (let i = from; i < from + len && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);

export function sniffFileType(b: Uint8Array): SniffedType | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return { ext: "png", mime: "image/png" };
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return { ext: "gif", mime: "image/gif" };
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return { ext: "webp", mime: "image/webp" };
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp" && HEIF_BRANDS.has(ascii(b, 8, 4))) return { ext: "heic", mime: "image/heic" };
  // a PDF header may follow a little junk, but must come within the first 1 KB
  if (ascii(b, 0, Math.min(b.length, 1024)).includes("%PDF-")) return { ext: "pdf", mime: "application/pdf" };
  return null;
}

/** Extensions a browser may show inline (everything else is served as a download). */
export const INLINE_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
