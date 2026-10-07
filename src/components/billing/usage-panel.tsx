"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { z } from "zod";
import { Button, Progress } from "@/components/ui";
import { usageStateSchema } from "@/lib/billing-model";

export function UsagePanel() {
  const [usage, setUsage] = useState<z.infer<typeof usageStateSchema>>();
  const [error, setError] = useState<string>(); const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try { const response = await fetch("/api/dashboard/usage", { signal: controller.signal, cache: "no-store" }); if (!response.ok) throw new Error(); const body = usageStateSchema.parse(await response.json()); if (!controller.signal.aborted) { setUsage(body); setError(undefined); } }
      catch { if (!controller.signal.aborted) setError("Não foi possível consultar o uso. Tente atualizar."); }
    })(); return () => controller.abort();
  }, [refresh]);
  return <section className="mt-8 rounded-2xl border border-white/10 bg-[#080808] p-6 sm:p-8"><div className="flex items-center justify-between gap-3"><h2 className="font-heading text-xl font-semibold">Período atual</h2><Button variant="ghost" size="sm" onClick={() => setRefresh(value => value + 1)}>Atualizar</Button></div>{error ? <p role="alert" className="mt-5 text-red-300">{error}</p> : !usage ? <p role="status" className="mt-5 text-zinc-400">Consultando uso…</p> : <><p className="mt-3 text-sm text-zinc-500">{new Date(usage.current.periodStart).toLocaleDateString("pt-BR", { timeZone: "UTC" })} — {new Date(usage.current.periodEnd).toLocaleDateString("pt-BR", { timeZone: "UTC" })}</p><div className="mt-7 grid gap-6 sm:grid-cols-3">{[["Concluídas", usage.current.confirmed], ["Reservadas", usage.current.reserved], ["Disponíveis", usage.current.remaining]].map(([label, value]) => <div key={label}><p className="text-sm text-zinc-400">{label}</p><p className="mt-2 font-heading text-3xl font-bold tabular-nums">{Number(value).toLocaleString("pt-BR")}</p></div>)}</div><Progress className="mt-7" value={usage.current.limit ? Math.round((usage.current.confirmed + usage.current.reserved) / usage.current.limit * 100) : 100} label="Cota utilizada e reservada"/><p className="mt-4 text-sm leading-6 text-zinc-500">Limite de {usage.current.limit.toLocaleString("pt-BR")} etiquetas. Retentativas internas preservam a mesma reserva; reprocessamentos solicitados criam uma nova conversão.</p>{usage.current.remaining === 0 ? <p className="mt-4 text-sm text-amber-300">A cota deste período foi atingida. Consulte sua <Link className="underline" href="/dashboard/billing">assinatura</Link> para gerenciar o plano.</p> : null}</>}</section>;
}
