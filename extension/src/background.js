import { UNO_URL } from "./config.js";
import { bytesToBase64, base64ToBytes, conversionFor, dataUrlBytes, looksConvertible, MAX_CAPTURE_BYTES, outputName, sniffKind } from "./files.js";
import { MARKETPLACE_IDS, MARKETPLACES, marketplaceFor } from "./marketplaces.js";

const API = `${UNO_URL}/api/extension/v1`;
const CONNECT_STATE_TTL_MS = 10 * 60_000;
const LOTE_POLL_MS = 2_000;
const LOTE_TIMEOUT_MS = 5 * 60_000;
const HISTORY_LIMIT = 8;

// ---------------------------------------------------------------- settings

async function settings() {
  const stored = await chrome.storage.local.get(["token", "enabled", "history"]);
  const enabled = Object.fromEntries(MARKETPLACE_IDS.map((id) => [id, stored.enabled?.[id] ?? true]));
  return { token: stored.token ?? null, enabled, history: stored.history ?? [] };
}

async function remember(entry) {
  const { history } = await settings();
  await chrome.storage.local.set({ history: [{ ...entry, at: Date.now() }, ...history].slice(0, HISTORY_LIMIT) });
}

async function disconnectLocally() {
  await chrome.storage.local.remove(["token"]);
  await chrome.action.setBadgeText({ text: "!" });
}

// --------------------------------------------------------------------- api

class UnoError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function api(path, { token, method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, { method, body, headers: { authorization: `Bearer ${token}` }, credentials: "omit", cache: "no-store" });
  } catch {
    throw new UnoError("network", "Sem conexão com a UNO.", 0);
  }
  if (response.status === 401) {
    await disconnectLocally();
    throw new UnoError("unauthorized", "A extensão foi desconectada. Conecte de novo pelo ícone da UNO.", 401);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new UnoError(payload.error?.code ?? "error", payload.error?.message ?? "A UNO não conseguiu converter este arquivo.", response.status);
  }
  return response;
}

// ------------------------------------------------------------ notification

function notify(title, message) {
  chrome.notifications.create({ type: "basic", iconUrl: "icons/icon-128.png", title, message, priority: 1 }).catch(() => undefined);
}

// ----------------------------------------------------------------- capture

/** Reads a blob: URL through the content script of a tab on the blob's origin. */
async function readBlob(url) {
  const origin = new URL(url.slice(5)).origin;
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  for (const tab of tabs) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "uno-read-blob", url });
      if (response?.ok) return base64ToBytes(response.base64);
    } catch {
      // No content script in that tab (opened before install): try the next one.
    }
  }
  return null;
}

async function readDownload(item) {
  const url = item.finalUrl || item.url;
  if (url.startsWith("data:")) return dataUrlBytes(url);
  if (url.startsWith("blob:")) return readBlob(url);
  if (!/^https?:/.test(url)) return null;
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!response.ok) return null;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_CAPTURE_BYTES) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > MAX_CAPTURE_BYTES ? null : bytes;
  } catch {
    return null;
  }
}

async function download(url, filename) {
  await chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
}

function pdfDataUrl(bytes) {
  return `data:application/pdf;base64,${bytesToBase64(bytes)}`;
}

async function waitForLote(token, loteId) {
  const deadline = Date.now() + LOTE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LOTE_POLL_MS));
    const lote = await (await api(`/lotes/${loteId}`, { token })).json();
    if (lote.downloadAvailable) {
      const signed = await (await api(`/lotes/${loteId}/download`, { token })).json();
      return { url: signed.url, orders: lote.completedCount, failed: lote.failedCount };
    }
    if (lote.status === "failed" || lote.status === "cancelled") {
      throw new UnoError(lote.error?.code ?? "lote_failed", lote.error?.message ?? "A UNO não conseguiu converter as etiquetas deste arquivo.", 422);
    }
  }
  throw new UnoError("timeout", "A conversão demorou demais. Confira o lote no painel da UNO.", 504);
}

async function convert(token, conversion, bytes, originalName) {
  const form = new FormData();
  const type = conversion === "mercado-livre-full" ? "text/plain" : "application/pdf";
  form.append("file", new Blob([bytes], { type }), originalName || (conversion === "mercado-livre-full" ? "etiquetas.zpl" : "etiquetas.pdf"));
  const response = await api(`/convert?marketplace=${conversion}`, { token, method: "POST", body: form });
  if (response.status === 202) {
    const accepted = await response.json();
    return { kind: "url", ...(await waitForLote(token, accepted.loteId)) };
  }
  return { kind: "bytes", bytes: new Uint8Array(await response.arrayBuffer()), orders: Number(response.headers.get("x-uno-orders")) || null };
}

const inFlight = new Set();

async function handleDownload(item) {
  if (item.byExtensionId === chrome.runtime.id || inFlight.has(item.id)) return;
  const marketplace = marketplaceFor(item.url, item.finalUrl, item.referrer);
  if (!marketplace || !looksConvertible(item)) return;
  const { token, enabled } = await settings();
  if (!token || !enabled[marketplace]) return;

  inFlight.add(item.id);
  // Hold the original while we look at it; if anything below cannot finish, it resumes untouched.
  const paused = await chrome.downloads.pause(item.id).then(() => true, () => false);
  const resume = () => (paused ? chrome.downloads.resume(item.id).catch(() => undefined) : undefined);
  try {
    const bytes = await readDownload(item);
    const kind = bytes ? sniffKind(bytes) : null;
    const conversion = conversionFor(marketplace, kind);
    if (!bytes || !conversion) return void (await resume());

    if (paused) {
      await chrome.downloads.cancel(item.id).catch(() => undefined);
      await chrome.downloads.erase({ id: item.id }).catch(() => undefined);
    }
    const label = MARKETPLACES[marketplace].label;
    const originalName = item.filename ? item.filename.split(/[\\/]/).pop() : undefined;
    await chrome.action.setBadgeText({ text: "…" });
    try {
      const result = await convert(token, conversion, bytes, originalName);
      const name = outputName(marketplace);
      await download(result.kind === "url" ? result.url : pdfDataUrl(result.bytes), name);
      await remember({ marketplace, ok: true, name, orders: result.orders ?? null });
    } catch (error) {
      // The seller never ends up without a label: give the original back.
      if (paused) await download(kind === "pdf" ? pdfDataUrl(bytes) : `data:text/plain;base64,${bytesToBase64(bytes)}`, originalName || `etiquetas-${marketplace}.${kind === "pdf" ? "pdf" : "zpl"}`).catch(() => undefined);
      const message = error instanceof UnoError ? error.message : "Não foi possível converter.";
      await remember({ marketplace, ok: false, message });
      notify(`UNO · ${label}`, `${message} ${paused ? "Baixamos o arquivo original." : "O arquivo original foi mantido."}`);
    } finally {
      const current = await settings();
      await chrome.action.setBadgeText({ text: current.token ? "" : "!" });
    }
  } finally {
    inFlight.delete(item.id);
  }
}

chrome.downloads.onCreated.addListener((item) => {
  handleDownload(item).catch(() => undefined);
});

// ----------------------------------------------------------------- connect

async function startConnect() {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const state = bytesToBase64(random).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await chrome.storage.local.set({ connectState: { state, expiresAt: Date.now() + CONNECT_STATE_TTL_MS } });
  await chrome.tabs.create({ url: `${UNO_URL}/extensao/conectar?state=${state}` });
}

async function finishConnect(message, sender) {
  if (!sender.url || new URL(sender.url).origin !== new URL(UNO_URL).origin) return { ok: false };
  const { connectState } = await chrome.storage.local.get("connectState");
  if (!connectState || connectState.state !== message.state || connectState.expiresAt < Date.now()) return { ok: false };
  if (typeof message.token !== "string" || !/^unoext_[A-Za-z0-9_-]{40,64}$/.test(message.token)) return { ok: false };
  await chrome.storage.local.remove("connectState");
  await chrome.storage.local.set({ token: message.token });
  await chrome.action.setBadgeText({ text: "" });
  return { ok: true };
}

async function status() {
  const { token, enabled, history } = await settings();
  if (!token) return { connected: false, enabled, history, unoUrl: UNO_URL };
  try {
    const me = await (await api("/me", { token })).json();
    return { connected: true, me, enabled, history, unoUrl: UNO_URL };
  } catch (error) {
    const { token: still } = await settings();
    return { connected: Boolean(still), offline: Boolean(still), error: error.message, enabled, history, unoUrl: UNO_URL };
  }
}

async function disconnect() {
  const { token } = await settings();
  if (token) await api("/session", { token, method: "DELETE" }).catch(() => undefined);
  await chrome.storage.local.remove(["token"]);
  await chrome.action.setBadgeText({ text: "" });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    "uno-connect": () => finishConnect(message, sender),
    "uno-start-connect": () => startConnect().then(() => ({ ok: true })),
    "uno-status": () => status(),
    "uno-disconnect": () => disconnect().then(() => ({ ok: true })),
    "uno-toggle": async () => {
      if (!MARKETPLACE_IDS.includes(message.marketplace)) return { ok: false };
      const { enabled } = await settings();
      await chrome.storage.local.set({ enabled: { ...enabled, [message.marketplace]: Boolean(message.enabled) } });
      return { ok: true };
    },
  };
  const handler = handlers[message?.type];
  if (!handler) return false;
  // Only the popup (an extension page) may drive the extension; content scripts may only finish a connect.
  if (message.type !== "uno-connect" && sender.id !== chrome.runtime.id) return false;
  if (message.type !== "uno-connect" && sender.tab) return false;
  handler().then(sendResponse, () => sendResponse({ ok: false }));
  return true;
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.action.setBadgeBackgroundColor({ color: "#ef233c" });
  const { token } = await settings();
  if (!token) await chrome.action.setBadgeText({ text: "!" });
  if (details.reason === "install") await startConnect();
});
