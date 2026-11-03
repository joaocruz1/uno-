// Reads a blob: download for the service worker, which cannot resolve page
// blobs itself. Only answers for blobs of this frame's own origin.
const MAX_BYTES = 30 * 1024 * 1024;

function toBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "uno-read-blob" || sender.id !== chrome.runtime.id || typeof message.url !== "string") return false;
  let origin;
  try { origin = new URL(message.url.slice(5)).origin; } catch { return false; }
  if (!message.url.startsWith("blob:") || origin !== location.origin) return false;
  fetch(message.url)
    .then((response) => response.arrayBuffer())
    .then((buffer) => {
      if (buffer.byteLength > MAX_BYTES) return sendResponse({ ok: false });
      sendResponse({ ok: true, base64: toBase64(new Uint8Array(buffer)) });
    })
    .catch(() => sendResponse({ ok: false }));
  return true;
});
