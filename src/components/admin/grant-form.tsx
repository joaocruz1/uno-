"use client";

import { useState, type FormEvent } from "react";

/** Admin-only: unlock a paid plan (and the API add-on) for an account, no payment. */
export function GrantForm() {
  const [email, setEmail] = useState("");
  const [planId, setPlanId] = useState("BUSINESS");
  const [days, setDays] = useState("365");
  const [apiAddon, setApiAddon] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [failed, setFailed] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage(undefined); setFailed(false);
    try {
      const response = await fetch("/api/admin/grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), planId, days: Number(days), apiAddon }),
        cache: "no-store",
      });
      const body = await response.json().catch(() => null) as { error?: { message?: string }; prepaidPeriodEnd?: string; organizationId?: string } | null;
      if (!response.ok) { setFailed(true); setMessage(body?.error?.message ?? "Não foi possível liberar."); return; }
      const until = body?.prepaidPeriodEnd ? new Date(body.prepaidPeriodEnd).toLocaleDateString("pt-BR") : "";
      setMessage(`Liberado: ${planId}${apiAddon ? " + API" : ""} até ${until} · org ${body?.organizationId?.slice(0, 8)}…`);
    } catch {
      setFailed(true); setMessage("Sem conexão com o servidor.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-white/10 bg-[#080808] p-5">
      <h2 className="text-sm font-semibold">Liberar plano de teste</h2>
      <p className="mt-1 text-xs text-zinc-500">Destrava um plano pago (e, por padrão, o adicional + API) para uma conta, sem pagamento — para testes. Para um direito pago de verdade, use o Checkout.</p>
      <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
        <label className="text-xs text-zinc-400">E-mail da conta
          <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="voce@exemplo.com"
            className="mt-1 w-full rounded-lg border border-white/10 bg-black px-3 py-2 text-sm text-white outline-none focus:border-uno-red" />
        </label>
        <label className="text-xs text-zinc-400">Plano
          <select value={planId} onChange={(event) => setPlanId(event.target.value)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-black px-3 py-2 text-sm text-white outline-none focus:border-uno-red">
            <option value="STARTER">Starter</option>
            <option value="PRO">Pro</option>
            <option value="BUSINESS">Business</option>
          </select>
        </label>
        <label className="text-xs text-zinc-400">Dias
          <input type="number" min={1} max={3650} value={days} onChange={(event) => setDays(event.target.value)}
            className="mt-1 w-24 rounded-lg border border-white/10 bg-black px-3 py-2 text-sm text-white outline-none focus:border-uno-red" />
        </label>
        <button type="submit" disabled={busy} className="h-[38px] rounded-lg bg-uno-red px-4 text-sm font-semibold text-white transition-colors hover:bg-[#ff334b] disabled:opacity-60">{busy ? "Liberando…" : "Liberar"}</button>
      </form>
      <label className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
        <input type="checkbox" checked={apiAddon} onChange={(event) => setApiAddon(event.target.checked)} className="size-4 accent-[#ef233c]" />
        Incluir adicional + API (chaves de API, API pública e webhooks)
      </label>
      {message ? <p role="status" className={`mt-3 text-sm ${failed ? "text-red-300" : "text-emerald-300"}`}>{message}</p> : null}
    </section>
  );
}
