import { MARKETPLACES } from "../marketplaces.js";

const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);

function show(section) {
  for (const id of ["loading", "disconnected", "connected"]) $(id).hidden = id !== section;
}

function formatTime(at) {
  return new Date(at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function renderToggles(enabled) {
  const list = $("toggles");
  list.replaceChildren();
  for (const [id, marketplace] of Object.entries(MARKETPLACES)) {
    const item = document.createElement("li");
    const label = document.createElement("label");
    label.htmlFor = `toggle-${id}`;
    label.textContent = marketplace.label;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `toggle-${id}`;
    input.checked = enabled[id];
    input.addEventListener("change", () => send({ type: "uno-toggle", marketplace: id, enabled: input.checked }));
    item.append(label, input);
    list.append(item);
  }
}

function renderHistory(history) {
  if (!history.length) return;
  const list = $("history");
  list.replaceChildren(...history.map((entry) => {
    const item = document.createElement("li");
    const label = MARKETPLACES[entry.marketplace]?.label ?? entry.marketplace;
    item.textContent = entry.ok
      ? `${formatTime(entry.at)} · ${label}${entry.orders ? ` · ${entry.orders} pedido(s)` : ""}`
      : `${formatTime(entry.at)} · ${label} · ${entry.message}`;
    if (!entry.ok) item.className = "fail";
    return item;
  }));
}

async function render() {
  const state = await send({ type: "uno-status" });
  if (!state?.connected) return show("disconnected");
  $("dashboard").href = `${state.unoUrl}/dashboard`;
  if (state.me) {
    $("org").textContent = state.me.organizationName;
    $("usage").textContent = `${state.me.usage.used} de ${state.me.usage.limit} etiquetas do Mercado Livre este mês`;
  }
  $("offline").hidden = !state.offline;
  $("offline").textContent = state.error ?? "";
  renderToggles(state.enabled);
  renderHistory(state.history);
  show("connected");
}

$("connect").addEventListener("click", async () => { await send({ type: "uno-start-connect" }); window.close(); });
$("disconnect").addEventListener("click", async () => { await send({ type: "uno-disconnect" }); await render(); });
render();
