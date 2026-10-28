"use client";

import { Check, Copy, LoaderCircle, QrCode } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui";
import type { PaidPlanId } from "@/lib/billing-model";
import { isValidCpf, maskCpf } from "@/lib/cpf";
import { pixPurchaseViewSchema, type PixPurchaseView } from "@/lib/pix-model";
import { formatBrlCents } from "@/lib/plans";

import { ApiError, NetworkError, postJson, SessionExpiredError } from "./checkout-summary";
import { Notice } from "./payment-flow";

/**
 * PIX inside the plans dialog: the buyer types the CPF, the server prices and
 * creates the charge at the gateway (never the client), and the QR code is
 * paid without leaving the dialog. The days are granted by the gateway webhook
 * or by the server's own re-read of the payment on each poll below; this code
 * only shows what the server reports.
 */

/** idle → creating (button busy) → waiting (QR shown, polling) → approved (the server granted the days). */
export type PixPhase = "idle" | "creating" | "waiting" | "approved";

const FIRST_POLL_MS = 2_500;
const POLL_MS = 3_000;
const OFFLINE_POLL_MS = 6_000;
const COPIED_MS = 2_000;

const inputClass = "mt-2 h-11 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 text-base tabular-nums text-[var(--color-ink)] outline-none transition placeholder:text-[var(--color-faint)] focus:border-uno-red/70 focus:ring-2 focus:ring-uno-red/20 disabled:opacity-60 sm:text-sm";

function failureMessage(cause: unknown): string {
  if (cause instanceof NetworkError || cause instanceof ApiError) return cause.message;
  return "Não foi possível gerar o Pix. Tente novamente.";
}

export function usePixCheckout({ planId, onSessionExpired }: { planId: PaidPlanId; onSessionExpired?(message: string): void }) {
  const [cpf, setCpf] = useState("");
  const [phase, setPhase] = useState<PixPhase>("idle");
  const [charge, setCharge] = useState<PixPurchaseView>();
  const [error, setError] = useState<string>();
  const lock = useRef(false);
  const chargeId = charge?.id;

  const expire = useCallback(() => onSessionExpired?.("Sua sessão expirou. Entre novamente para continuar."), [onSessionExpired]);

  const create = useCallback(async () => {
    if (lock.current) return;
    const digits = cpf.replace(/\D/g, "");
    if (!isValidCpf(digits)) { setError("Informe um CPF válido."); return; }
    lock.current = true;
    setError(undefined);
    setPhase("creating");
    try {
      const view = pixPurchaseViewSchema.parse(await postJson("/api/dashboard/billing/pix", { planId, period: "monthly", cpf: digits }));
      setCharge(view);
      setPhase("waiting");
    } catch (cause) {
      setPhase("idle");
      if (cause instanceof SessionExpiredError) expire();
      else setError(failureMessage(cause));
    } finally {
      lock.current = false;
    }
  }, [cpf, expire, planId]);

  // While the QR is open: ask our server until it reports the charge paid, expired or failed.
  useEffect(() => {
    if (phase !== "waiting" || !chargeId) return;
    let cancelled = false;
    let timer: number | undefined;
    const read = async () => {
      let next = POLL_MS;
      try {
        const response = await fetch(`/api/dashboard/billing/pix/${chargeId}`, { cache: "no-store" });
        if (response.status === 401) { if (!cancelled) expire(); return; }
        const parsed = pixPurchaseViewSchema.safeParse(await response.json());
        if (cancelled) return;
        if (parsed.success) {
          if (parsed.data.status === "APPROVED") { setPhase("approved"); return; }
          if (parsed.data.status === "EXPIRED" || parsed.data.status === "FAILED") {
            setCharge(undefined);
            setPhase("idle");
            setError("O QR Code expirou ou o pagamento não foi concluído. Gere um novo.");
            return;
          }
        }
      } catch {
        next = OFFLINE_POLL_MS; // offline for a moment: keep trying
      }
      if (!cancelled) timer = window.setTimeout(() => void read(), next);
    };
    timer = window.setTimeout(() => void read(), FIRST_POLL_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [chargeId, expire, phase]);

  const restart = useCallback(() => { setCharge(undefined); setError(undefined); setPhase("idle"); }, []);

  return {
    cpf,
    setCpf: useCallback((value: string) => { setCpf(maskCpf(value)); setError(undefined); }, []),
    phase,
    charge,
    error,
    busy: phase === "creating",
    create,
    restart,
  };
}

export type PixCheckout = ReturnType<typeof usePixCheckout>;

/** The CPF field and "Gerar QR Code", or the QR with its copia-e-cola while the payment is awaited. */
export function PixFields({ pix, amountBrlCents, couponNote }: { pix: PixCheckout; amountBrlCents: number; couponNote?: string | null }) {
  const [copied, setCopied] = useState(false);
  const { phase, charge, error } = pix;

  const copy = async () => {
    if (!charge?.qrCode) return;
    try {
      await navigator.clipboard.writeText(charge.qrCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // Clipboard blocked: the code stays selectable in the field.
    }
  };

  if (phase === "waiting" && charge) {
    return (
      <div className="space-y-4" data-testid="pix-waiting">
        <div className="grid items-center gap-4 sm:grid-cols-[11rem_minmax(0,1fr)]">
          <div className="mx-auto grid w-44 place-items-center rounded-xl border border-[var(--color-line)] bg-white p-2.5">
            {charge.qrCodeBase64
              // eslint-disable-next-line @next/next/no-img-element -- a base64 PNG from the gateway, not an optimizable asset
              ? <img src={`data:image/png;base64,${charge.qrCodeBase64}`} alt="QR Code do Pix" width={156} height={156} />
              : <QrCode size={120} className="text-black" aria-hidden="true" />}
          </div>
          <div className="min-w-0">
            <p role="status" className="flex items-center gap-2 text-sm font-semibold text-[var(--color-ink)]">
              <LoaderCircle size={15} className="animate-spin text-uno-red motion-reduce:animate-none" aria-hidden="true" />
              Aguardando o pagamento de {formatBrlCents(charge.amountBrlCents)}…
            </p>
            <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-[var(--color-muted)]">
              <li>Abra o app do seu banco e escolha Pix.</li>
              <li>Escaneie o QR Code ou cole o código abaixo.</li>
              <li>Confirme: o plano é ativado aqui, na hora.</li>
            </ol>
          </div>
        </div>
        <div>
          <label htmlFor="pix-copy-paste" className="block text-xs font-medium text-[var(--color-muted)]">Pix copia e cola</label>
          <div className="mt-1.5 flex gap-2">
            <input id="pix-copy-paste" readOnly value={charge.qrCode ?? ""} onFocus={(event) => event.currentTarget.select()} className="h-10 min-w-0 flex-1 truncate rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 text-xs text-[var(--color-ink)]" />
            <Button type="button" variant="secondary" size="sm" onClick={() => void copy()} aria-live="polite">
              {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied ? "Copiado" : "Copiar"}
            </Button>
          </div>
        </div>
        <p className="text-xs text-[var(--color-muted)]">O código vale por 30 minutos. Já pagou? Esta tela atualiza sozinha em alguns segundos.</p>
        <button type="button" onClick={pix.restart} className="text-sm font-semibold text-uno-red underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-uno-red">Gerar outro QR Code</button>
      </div>
    );
  }

  const creating = phase === "creating";
  return (
    <form className="space-y-4" noValidate onSubmit={(event) => { event.preventDefault(); void pix.create(); }}>
      <div>
        <label htmlFor="pix-cpf" className="block text-sm font-medium text-[var(--color-ink)]">CPF do pagador</label>
        <input
          id="pix-cpf"
          name="cpf"
          inputMode="numeric"
          autoComplete="off"
          placeholder="000.000.000-00"
          value={pix.cpf}
          disabled={creating}
          aria-invalid={error ? true : undefined}
          aria-describedby="pix-cpf-help"
          onChange={(event) => pix.setCpf(event.currentTarget.value)}
          className={inputClass}
          data-testid="pix-cpf"
        />
        <p id="pix-cpf-help" className="mt-1.5 text-xs text-[var(--color-muted)]">Exigido pelo Mercado Pago para gerar o Pix. Não fica guardado na UNO.</p>
      </div>
      {couponNote ? <Notice>{couponNote}</Notice> : null}
      <div aria-live="assertive" className="empty:hidden">{error ? <Notice tone="error">{error}</Notice> : null}</div>
      <Button type="submit" size="lg" className="w-full" disabled={creating} aria-busy={creating} data-testid="pix-generate">
        {creating ? <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <QrCode size={16} aria-hidden="true" />}
        <span>{creating ? "Gerando o QR Code…" : `Gerar QR Code Pix · ${formatBrlCents(amountBrlCents)}`}</span>
      </Button>
    </form>
  );
}
