"use client";

import { Check, Copy, LoaderCircle, QrCode } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import { Button } from "@/components/ui";
import { pixPurchaseViewSchema, type PixPurchaseView } from "@/lib/pix-model";
import { formatBrlCents, PLANS } from "@/lib/plans";

type PaidPlan = "STARTER" | "PRO" | "BUSINESS";
type Period = "monthly" | "annual";
type Phase = "idle" | "creating" | "pending" | "approved" | "error";

function safeMessage(value: unknown, fallback: string): string {
  const body = value as { error?: { message?: unknown } } | null;
  return typeof body?.error?.message === "string" ? body.error.message : fallback;
}

function maskCpf(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  return digits
    .replace(/^(\d{3})(\d)/, "$1.$2")
    .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1-$2");
}

function priceCents(plan: PaidPlan, period: Period): number {
  const monthly = PLANS[plan].priceBrlCents;
  return period === "annual" ? monthly * 12 : monthly;
}

export function PixPurchase() {
  const [plan, setPlan] = useState<PaidPlan>("PRO");
  const [period, setPeriod] = useState<Period>("monthly");
  const [cpf, setCpf] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [purchase, setPurchase] = useState<PixPurchaseView>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => { if (pollRef.current) clearTimeout(pollRef.current); }, []);

  const cpfDigits = cpf.replace(/\D/g, "");

  const create = async () => {
    if (cpfDigits.length !== 11) { setError("Informe um CPF válido (11 dígitos)."); return; }
    setPhase("creating"); setError(undefined); setPurchase(undefined);
    try {
      const response = await fetch("/api/dashboard/billing/pix", {
        method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ planId: plan, period, cpf: cpfDigits }),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(safeMessage(body, "Não foi possível gerar a cobrança PIX."));
      const view = pixPurchaseViewSchema.parse(body);
      setPurchase(view);
      setPhase("pending");
      poll(view.id);
    } catch (cause) {
      setPhase("error");
      setError(cause instanceof Error && !(cause instanceof z.ZodError) ? cause.message : "Não foi possível gerar a cobrança PIX.");
    }
  };

  const poll = (id: string) => {
    const read = async () => {
      try {
        const response = await fetch(`/api/dashboard/billing/pix/${id}`, { cache: "no-store" });
        const body: unknown = await response.json();
        if (!response.ok) throw new Error(safeMessage(body, "Não foi possível consultar o pagamento."));
        const view = pixPurchaseViewSchema.parse(body);
        setPurchase(view);
        if (view.status === "APPROVED") { setPhase("approved"); return; }
        if (view.status === "EXPIRED" || view.status === "FAILED") { setPhase("error"); setError("A cobrança expirou ou não foi paga. Gere uma nova."); return; }
        pollRef.current = setTimeout(() => void read(), 4_000);
      } catch {
        pollRef.current = setTimeout(() => void read(), 6_000);
      }
    };
    pollRef.current = setTimeout(() => void read(), 4_000);
  };

  const copy = async () => {
    if (!purchase?.qrCode) return;
    try {
      await navigator.clipboard.writeText(purchase.qrCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch { /* clipboard blocked */ }
  };

  const reset = () => {
    if (pollRef.current) clearTimeout(pollRef.current);
    setPhase("idle"); setPurchase(undefined); setError(undefined);
  };

  return (
    <section aria-label="Comprar com PIX" className="rounded-2xl border border-white/10 bg-[#080808] p-6">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold text-uno-red">Pagamento avulso</p>
          <h2 className="mt-2 font-heading text-xl font-bold">Comprar com PIX</h2>
          <p className="mt-3 text-sm text-zinc-400">Pague uma vez e use por 30 dias (mensal) ou 1 ano (anual), sem renovação automática. Os dias somam ao que você já tiver.</p>
        </div>
        <p className="font-heading text-3xl font-bold">{formatBrlCents(priceCents(plan, period))}<span className="text-sm font-normal text-zinc-500"> {period === "annual" ? "/ano" : "/30 dias"}</span></p>
      </div>

      {phase === "approved" ? (
        <div className="mt-6 rounded-xl border border-emerald-400/20 bg-emerald-400/[.04] p-5">
          <p className="flex items-center gap-2 font-heading font-semibold"><Check size={18} className="text-emerald-400" />Pagamento aprovado</p>
          <p className="mt-2 text-sm text-zinc-400">Seus dias foram creditados. Atualize a página para ver o plano em vigor.</p>
          <Button className="mt-4" variant="secondary" onClick={() => location.reload()}>Atualizar</Button>
        </div>
      ) : phase === "pending" && purchase ? (
        <div className="mt-6 grid gap-6 sm:grid-cols-[180px_minmax(0,1fr)]">
          <div className="grid place-items-center rounded-xl border border-white/10 bg-white p-3">
            {purchase.qrCodeBase64 ? <img src={`data:image/png;base64,${purchase.qrCodeBase64}`} alt="QR Code do PIX" width={160} height={160} /> : <QrCode size={120} className="text-black" />}
          </div>
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-medium"><LoaderCircle size={15} className="animate-spin text-uno-red motion-reduce:animate-none" />Aguardando o pagamento…</p>
            <p className="mt-3 text-xs text-zinc-500">Abra o app do seu banco, escaneie o QR ou use o copia-e-cola. A liberação é automática.</p>
            <label className="mt-4 block text-xs text-zinc-500">Copia-e-cola
              <div className="mt-2 flex gap-2">
                <input readOnly value={purchase.qrCode ?? ""} className="min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-black px-3 py-2 text-xs text-zinc-300" />
                <Button variant="secondary" size="sm" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "Copiado" : "Copiar"}</Button>
              </div>
            </label>
            <Button className="mt-5" variant="ghost" size="sm" onClick={reset}>Cancelar</Button>
          </div>
        </div>
      ) : (
        <div className="mt-6 space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <fieldset>
              <legend className="text-xs text-zinc-500">Plano</legend>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {(["STARTER", "PRO", "BUSINESS"] as const).map((value) => (
                  <label key={value} className={`cursor-pointer rounded-lg border p-2.5 text-center text-sm transition-colors ${plan === value ? "border-uno-red/60 bg-uno-red/[.07] text-white" : "border-white/[.08] bg-black text-zinc-300 hover:border-white/20"}`}>
                    <input type="radio" name="pix-plan" value={value} checked={plan === value} onChange={() => setPlan(value)} className="sr-only" />
                    {PLANS[value].name}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="text-xs text-zinc-500">Período</legend>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {([["monthly", "30 dias"], ["annual", "1 ano"]] as const).map(([value, label]) => (
                  <label key={value} className={`cursor-pointer rounded-lg border p-2.5 text-center text-sm transition-colors ${period === value ? "border-uno-red/60 bg-uno-red/[.07] text-white" : "border-white/[.08] bg-black text-zinc-300 hover:border-white/20"}`}>
                    <input type="radio" name="pix-period" value={value} checked={period === value} onChange={() => setPeriod(value)} className="sr-only" />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          <label className="block max-w-xs text-xs text-zinc-500">CPF do pagador
            <input inputMode="numeric" value={cpf} onChange={(event) => setCpf(maskCpf(event.currentTarget.value))} placeholder="000.000.000-00"
              className="mt-2 w-full rounded-lg border border-white/10 bg-black px-3 py-2 text-sm text-white outline-none focus:border-uno-red" />
          </label>
          {error ? <p role="alert" className="text-sm text-red-300">{error}</p> : null}
          <Button onClick={() => void create()} disabled={phase === "creating"}>{phase === "creating" ? <LoaderCircle size={17} className="animate-spin motion-reduce:animate-none" /> : <QrCode size={17} />}Gerar cobrança PIX</Button>
          <p className="text-xs leading-5 text-zinc-500">Processado pelo Mercado Pago. O cartão (assinatura recorrente) continua em “Escolher plano”, acima.</p>
        </div>
      )}
    </section>
  );
}
