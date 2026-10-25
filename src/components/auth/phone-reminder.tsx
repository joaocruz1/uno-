"use client";

import { Phone, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";
import { normalizeBrPhone, PHONE_INVALID_MESSAGE } from "@/lib/phone";
import { useHydrated } from "@/lib/use-hydrated";

import { PhoneInput } from "./phone-input";

const DISMISSED_KEY = "uno:phone-reminder-dismissed";

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Non-blocking request for the phone of accounts created before it became
 * mandatory (NEX-51), or through Google. Shown once per browser session;
 * "Agora não" hides it until the next one.
 */
export function PhoneReminder() {
  const router = useRouter();
  const hydrated = useHydrated();
  const [dismissedNow, setDismissed] = useState(false);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  // Browser storage is only read after hydration, so server and client first render match.
  if (!hydrated || dismissedNow || readDismissed()) return null;

  const dismiss = () => {
    try { window.sessionStorage.setItem(DISMISSED_KEY, "1"); } catch { /* private mode: hide for this page only */ }
    setDismissed(true);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const normalized = normalizeBrPhone(phone);
    if (!normalized) { setError(PHONE_INVALID_MESSAGE); return; }
    setBusy(true); setError(undefined);
    const { error: failure } = await authClient.updateUser({ phone: normalized }).catch(() => ({ error: { message: "" } }));
    setBusy(false);
    if (failure) { setError("Não foi possível salvar o telefone. Tente novamente."); return; }
    setSaved(true);
    router.refresh();
  };

  if (saved) {
    return <p role="status" className="mb-6 rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-ink)]">Telefone salvo. Obrigado!</p>;
  }

  return (
    <section aria-labelledby="phone-reminder-title" className="mb-6 rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden="true" className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-uno-red/10 text-uno-red"><Phone size={16} /></span>
          <div className="min-w-0">
            <h2 id="phone-reminder-title" className="text-sm font-semibold text-[var(--color-ink)]">Complete seu cadastro com um telefone</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">Usamos só para falar com você sobre a sua conta e a cobrança. Você pode continuar usando a UNO normalmente.</p>
          </div>
        </div>
        <button type="button" onClick={dismiss} aria-label="Fechar aviso do telefone" className="rounded-full p-1.5 text-[var(--color-muted)] hover:bg-[var(--hover-ink)] hover:text-[var(--color-ink)] focus-visible:outline-2 focus-visible:outline-uno-red"><X size={16} /></button>
      </div>
      <form onSubmit={save} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="min-w-0 flex-1 text-sm text-[var(--color-muted)]">
          Telefone (com DDD)
          <PhoneInput
            value={phone}
            onValueChange={setPhone}
            required
            disabled={busy}
            aria-invalid={error ? true : undefined}
            className="mt-2 h-11 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 text-base text-[var(--color-ink)] outline-none placeholder:text-[var(--color-faint)] focus:border-uno-red/70 focus:ring-2 focus:ring-uno-red/20 sm:text-sm"
          />
        </label>
        <div className="flex gap-2">
          <button type="submit" disabled={busy} className="h-11 rounded-full bg-uno-red px-5 text-sm font-semibold text-white hover:bg-[#ff334b] disabled:opacity-60">{busy ? "Salvando…" : "Salvar telefone"}</button>
          <button type="button" onClick={dismiss} className="h-11 rounded-full px-4 text-sm font-semibold text-[var(--color-muted)] hover:bg-[var(--hover-ink)] hover:text-[var(--color-ink)]">Agora não</button>
        </div>
      </form>
      {error ? <p role="alert" className="mt-3 text-sm text-uno-red">{error}</p> : null}
    </section>
  );
}
