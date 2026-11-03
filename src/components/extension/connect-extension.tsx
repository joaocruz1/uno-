"use client";

import { useRef, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui";

/** Handoff message read by the extension's content script on this route only. */
const CONNECT_MESSAGE = "uno-extension-connect";
const CONNECTED_MESSAGE = "uno-extension-connected";
const ACK_TIMEOUT_MS = 4_000;

function browserLabel(): string {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent) ? "Edge" : /OPR\//.test(agent) ? "Opera" : /Brave/.test(agent) ? "Brave" : "Chrome";
  const system = /Mac OS X/.test(agent) ? "macOS" : /Windows/.test(agent) ? "Windows" : /Linux/.test(agent) ? "Linux" : "computador";
  return `${browser} no ${system}`;
}

/** Waits for the content script to confirm it stored the token for this state. */
function waitForAck(state: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => { window.removeEventListener("message", listener); resolve(false); }, ACK_TIMEOUT_MS);
    function listener(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data as { type?: unknown; state?: unknown } | null;
      if (data?.type !== CONNECTED_MESSAGE || data.state !== state) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", listener);
      resolve(true);
    }
    window.addEventListener("message", listener);
  });
}

export function ConnectExtension({ state, organizationName, userName }: { state: string | null; organizationName: string; userName: string }) {
  const [status, setStatus] = useState<"idle" | "busy" | "done" | "missing">("idle");
  const [error, setError] = useState<string>();
  const lock = useRef(false);

  if (!state) {
    return <p role="alert" className="text-sm text-zinc-300">Abra esta página pelo botão &ldquo;Conectar&rdquo; da extensão UNO.</p>;
  }

  const connect = async () => {
    if (lock.current) return;
    lock.current = true; setStatus("busy"); setError(undefined);
    try {
      const response = await fetch("/api/dashboard/extension-tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: browserLabel() }) });
      const body = await response.json();
      if (!response.ok || typeof body.token !== "string" || typeof body.id !== "string") throw new Error(typeof body.error?.message === "string" ? body.error.message : "Não foi possível conectar.");
      const acknowledged = waitForAck(state);
      window.postMessage({ type: CONNECT_MESSAGE, state, token: body.token }, window.location.origin);
      if (await acknowledged) { setStatus("done"); return; }
      // Nobody received the token: revoke it instead of leaving an orphan session.
      await fetch(`/api/dashboard/extension-tokens/${body.id}`, { method: "DELETE" }).catch(() => undefined);
      setStatus("missing");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível conectar.");
      setStatus("idle");
    } finally {
      lock.current = false;
    }
  };

  if (status === "done") {
    return <div role="status" className="space-y-3"><p className="font-medium">Extensão conectada.</p><p className="text-sm text-zinc-400">Pode fechar esta aba. Baixe as etiquetas no Mercado Livre, Shopee ou TikTok Shop como sempre: a UNO converte sozinha.</p></div>;
  }
  return (
    <div className="space-y-5">
      <p className="text-sm text-zinc-300">A extensão vai converter etiquetas em nome de <strong className="text-white">{userName}</strong>, na organização <strong className="text-white">{organizationName}</strong>. Ela só envia os arquivos de etiqueta que você baixar nos marketplaces.</p>
      {status === "missing" ? <p role="alert" className="text-sm text-red-300">A extensão não respondeu. Confira se ela está instalada e ativa neste navegador e abra esta página de novo pelo botão da extensão.</p> : null}
      {error ? <p role="alert" className="text-sm text-red-300">{error}</p> : null}
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => void connect()} disabled={status === "busy"}>{status === "busy" ? "Conectando…" : "Conectar extensão"}</Button>
        <Link href="/dashboard/extensao" className="self-center text-sm text-zinc-400 underline">Ver navegadores conectados</Link>
      </div>
    </div>
  );
}
