"use client";

import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui";
import { ConsentAnalytics } from "@/lib/telemetry";

const CONSENT_KEY = "uno_analytics_consent_v1";
let consent = false;
let initialized = false;
const listeners = new Set<() => void>();
const analytics = new ConsentAnalytics({ key: process.env.NEXT_PUBLIC_POSTHOG_KEY, host: process.env.NEXT_PUBLIC_POSTHOG_HOST, fetch: (...args) => fetch(...args), randomId: () => crypto.randomUUID() });
function setConsent(allowed: boolean) {
  consent = allowed;
  analytics.setConsent(allowed);
  try { localStorage.setItem(CONSENT_KEY, allowed ? "allowed" : "denied"); } catch { /* memory-only consent */ }
  for (const listener of listeners) listener();
  if (allowed) void analytics.capture({ code: "analytics_enabled", stage: "dashboard" });
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!initialized) {
    initialized = true;
    try { consent = localStorage.getItem(CONSENT_KEY) === "allowed"; } catch { consent = false; }
    analytics.setConsent(consent);
  }
  const synchronize = (event: StorageEvent) => {
    if (event.key !== CONSENT_KEY) return;
    consent = event.newValue === "allowed";
    analytics.setConsent(consent);
    for (const item of listeners) item();
  };
  window.addEventListener("storage", synchronize);
  return () => { listeners.delete(listener); window.removeEventListener("storage", synchronize); };
}
export function AnalyticsConsent() {
  const allowed = useSyncExternalStore(subscribe, () => consent, () => false);
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return null;
  return <section className="mt-8 rounded-xl border border-white/10 p-5"><h2 className="text-sm font-semibold">Métricas opcionais de uso</h2><p className="mt-2 max-w-2xl text-sm text-zinc-400">Você decide se a UNO pode enviar eventos anônimos para melhorar o produto. PDFs, dados fiscais e conteúdo da tela não são enviados.</p><div className="mt-4 flex items-center gap-4"><Button size="sm" variant="secondary" onClick={() => setConsent(!allowed)}>{allowed ? "Desativar métricas" : "Permitir métricas"}</Button><span role="status" className="text-xs text-zinc-500">{allowed ? "Permitidas" : "Desativadas"}</span></div></section>;
}
