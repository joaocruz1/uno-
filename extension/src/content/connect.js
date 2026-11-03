// Runs only on UNO's /extensao/conectar. Hands the token the page just created
// to the service worker, which accepts it only for the pending connect state,
// and tells the page it was received (otherwise the page revokes it).
window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.type !== "uno-extension-connect" || typeof data.state !== "string" || typeof data.token !== "string") return;
  chrome.runtime.sendMessage({ type: "uno-connect", state: data.state, token: data.token }).then((response) => {
    if (response?.ok) window.postMessage({ type: "uno-extension-connected", state: data.state }, location.origin);
  }).catch(() => undefined);
});
