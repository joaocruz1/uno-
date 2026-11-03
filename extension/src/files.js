// Pure helpers shared by the service worker and the tests (no chrome.* here).

/** Largest file the extension will read into memory. */
export const MAX_CAPTURE_BYTES = 30 * 1024 * 1024;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** "pdf", "zpl" or null, from the leading bytes. */
export function sniffKind(bytes) {
  const head = bytes.subarray(0, 1024);
  for (let index = 0; index + PDF_MAGIC.length <= head.length; index += 1) {
    if (PDF_MAGIC.every((value, offset) => head[index + offset] === value)) return "pdf";
  }
  const text = new TextDecoder("latin1").decode(head).trimStart();
  if (/^(\^|~)[A-Z]{2}/.test(text) && text.includes("^XA")) return "zpl";
  return null;
}

/**
 * Whether a download is worth pausing to inspect: PDFs, ZPL text, and the
 * generic types marketplaces use when they stream a file. Spreadsheets, ZIPs
 * and images pass straight through.
 */
export function looksConvertible(item) {
  const mime = (item.mime || "").toLowerCase();
  const name = (item.filename || item.finalUrl || item.url || "").toLowerCase().split(/[?#]/)[0];
  if (/\.(xlsx?|csv|zip|png|jpe?g|gif|webp|html?)$/.test(name)) return false;
  if (mime === "application/pdf" || name.endsWith(".pdf")) return true;
  if (name.endsWith(".zpl") || name.endsWith(".txt")) return true;
  return mime === "" || mime === "application/octet-stream" || mime === "binary/octet-stream" || mime === "text/plain";
}

/** Which UNO conversion handles this file. */
export function conversionFor(marketplace, kind) {
  if (kind === "zpl") return marketplace === "mercado-livre" ? "mercado-livre-full" : null;
  if (kind === "pdf") return marketplace;
  return null;
}

export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Bytes of a `data:` URL, or null when it is not base64/percent encoded data. */
export function dataUrlBytes(url) {
  const match = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  if (match[2]) return base64ToBytes(match[3]);
  return new TextEncoder().encode(decodeURIComponent(match[3]));
}

/** uno-shopee-2026-11-03-1432.pdf */
export function outputName(marketplace, now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `uno-${marketplace}-${stamp}.pdf`;
}
