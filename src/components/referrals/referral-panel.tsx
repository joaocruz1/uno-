"use client";

import { Check, Copy, Gift, LoaderCircle, Share2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import { Button } from "@/components/ui";
import { referralProgressSchema, type ReferralProgress } from "@/lib/referral-model";

function safeMessage(value: unknown, fallback: string): string {
  const body = value as { error?: { message?: unknown } } | null;
  return typeof body?.error?.message === "string" ? body.error.message : fallback;
}

export function ReferralPanel() {
  const [progress, setProgress] = useState<ReferralProgress>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const claimed = useRef(false);

  const load = async () => {
    try {
      const response = await fetch("/api/dashboard/referrals", { cache: "no-store" });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(safeMessage(body, "Não foi possível carregar suas indicações."));
      setProgress(referralProgressSchema.parse(body));
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error && !(cause instanceof z.ZodError) ? cause.message : "Não foi possível carregar suas indicações.");
    }
  };

  useEffect(() => {
    void (async () => {
      // Link a referral remembered from /r/<code> before showing progress.
      if (!claimed.current) {
        claimed.current = true;
        await fetch("/api/dashboard/referrals/claim", { method: "POST", cache: "no-store" }).catch(() => undefined);
      }
      await load();
    })();
  }, []);

  const link = progress ? `${window.location.origin}/r/${progress.code}` : "";

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch { /* clipboard blocked */ }
  };

  const reward = async () => {
    setClaiming(true);
    try {
      const response = await fetch("/api/dashboard/referrals/reward", { method: "POST", cache: "no-store" });
      if (!response.ok) throw new Error(safeMessage(await response.json(), "Não foi possível resgatar a recompensa."));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível resgatar a recompensa.");
    } finally {
      setClaiming(false);
    }
  };

  if (error && !progress) {
    return <section className="rounded-2xl border border-amber-300/20 p-6"><p role="alert" className="text-sm text-amber-200">{error}</p><Button className="mt-4" variant="secondary" onClick={() => void load()}>Tentar de novo</Button></section>;
  }
  if (!progress) {
    return <section className="rounded-2xl border border-white/10 bg-[#080808] p-6"><p className="flex items-center gap-2 text-sm text-zinc-400"><LoaderCircle size={16} className="animate-spin text-uno-red motion-reduce:animate-none" />Carregando suas indicações…</p></section>;
  }

  const remaining = Math.max(0, progress.goal - progress.active);
  const whatsapp = `https://wa.me/?text=${encodeURIComponent(`Converto minhas etiquetas de marketplace no UNO — vários pedidos num PDF só. Cria a conta pelo meu link: ${link}`)}`;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-white/10 bg-[#080808] p-6">
        <p className="flex items-center gap-2 text-sm font-semibold text-uno-red"><Gift size={16} />Seu link de indicação</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <input readOnly value={link} className="min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-black px-3 py-2 text-sm text-zinc-300" />
          <Button variant="secondary" onClick={() => void copy()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "Copiado" : "Copiar"}</Button>
          <a href={whatsapp} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-4 py-2 text-sm text-zinc-200 transition hover:border-white/20 hover:bg-white/[.04]"><Share2 size={16} />WhatsApp</a>
        </div>
        <p className="mt-3 text-xs leading-5 text-zinc-500">Conta como indicação ativa quem se cadastra pelo seu link <strong className="text-zinc-300">e</strong> converte pelo menos uma etiqueta. Só criar a conta não basta.</p>
      </section>

      <section className="rounded-2xl border border-white/10 bg-[#080808] p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex gap-8">
            <div><p className="font-heading text-3xl font-bold">{progress.signups}</p><p className="mt-1 text-xs text-zinc-500">cadastros pelo link</p></div>
            <div><p className="font-heading text-3xl font-bold text-uno-red">{progress.active}</p><p className="mt-1 text-xs text-zinc-500">indicações ativas</p></div>
            <div><p className="font-heading text-3xl font-bold">{progress.goal}</p><p className="mt-1 text-xs text-zinc-500">meta pro bônus</p></div>
          </div>
        </div>
        <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/[.07]">
          <div className="h-full rounded-full bg-uno-red transition-all" style={{ width: `${Math.min(100, Math.round((progress.active / progress.goal) * 100))}%` }} />
        </div>
        {progress.rewarded ? (
          <p className="mt-5 flex items-center gap-2 text-sm text-emerald-400"><Check size={16} />Bônus resgatado — 5 dias de acesso completo creditados.</p>
        ) : progress.eligible ? (
          <div className="mt-5"><Button onClick={() => void reward()} disabled={claiming}>{claiming ? <LoaderCircle size={17} className="animate-spin motion-reduce:animate-none" /> : <Gift size={17} />}Resgatar 5 dias grátis</Button></div>
        ) : (
          <p className="mt-5 text-sm text-zinc-400">{remaining === 0 ? "Quase lá." : `Faltam ${remaining} indicação${remaining === 1 ? "" : "ões"} ativa${remaining === 1 ? "" : "s"}`} para ganhar 5 dias de acesso completo, uma única vez.</p>
        )}
        {error ? <p role="alert" className="mt-4 text-sm text-red-300">{error}</p> : null}
      </section>
    </div>
  );
}
