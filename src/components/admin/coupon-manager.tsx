"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import type { AdminCoupon } from "@/server/admin/coupons";

const PLANS = [["STARTER", "Starter"], ["PRO", "Pro"], ["BUSINESS", "Business"]] as const;
const field = "mt-1 w-full rounded-lg border border-white/10 bg-black px-3 py-2 text-sm text-white outline-none focus:border-uno-red";

type Message = { ok: boolean; text: string };

async function send(url: string, method: "POST" | "PATCH", body: unknown): Promise<{ ok: boolean; message?: string }> {
  try {
    const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    return response.ok ? { ok: true } : { ok: false, message: payload?.error?.message ?? "Não foi possível concluir." };
  } catch {
    return { ok: false, message: "Sem conexão com o servidor." };
  }
}

function durationText(coupon: AdminCoupon): string {
  if (coupon.duration === "forever") return "Recorrente";
  if (coupon.duration === "repeating") return `${coupon.durationInMonths} meses`;
  return "Só o 1º mês";
}

/** Admin-only: create, activate and deactivate discount coupons (Stripe Promotion Codes). */
export function CouponManager({ coupons }: { coupons: AdminCoupon[] }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<"percent" | "amount">("percent");
  const [value, setValue] = useState("");
  const [duration, setDuration] = useState<"once" | "forever" | "repeating">("once");
  const [months, setMonths] = useState("3");
  const [plans, setPlans] = useState<string[]>([]);
  const [maxRedemptions, setMaxRedemptions] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<Message>();

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const amount = Number(value.replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) { setMessage({ ok: false, text: kind === "percent" ? "Informe um percentual entre 1 e 100." : "Informe o valor do desconto em reais." }); return; }
    setBusy("create"); setMessage(undefined);
    const result = await send("/api/admin/coupons", "POST", {
      code: code.trim(),
      kind,
      ...(kind === "percent" ? { percentOff: Math.round(amount) } : { amountOffBrlCents: Math.round(amount * 100) }),
      duration,
      ...(duration === "repeating" ? { durationInMonths: Number(months) } : {}),
      ...(plans.length ? { planIds: plans } : {}),
      ...(maxRedemptions ? { maxRedemptions: Number(maxRedemptions) } : {}),
      // End of the chosen day in São Paulo.
      ...(expiresOn ? { expiresAt: new Date(`${expiresOn}T23:59:59-03:00`).toISOString() } : {}),
    });
    setBusy(undefined);
    if (!result.ok) { setMessage({ ok: false, text: result.message ?? "Não foi possível criar o cupom." }); return; }
    setMessage({ ok: true, text: `Cupom ${code.trim().toUpperCase()} criado.` });
    setCode(""); setValue(""); setMaxRedemptions(""); setExpiresOn(""); setPlans([]);
    router.refresh();
  };

  const toggle = async (coupon: AdminCoupon) => {
    if (busy) return;
    setBusy(coupon.id); setMessage(undefined);
    const result = await send(`/api/admin/coupons/${coupon.id}`, "PATCH", { active: !coupon.active });
    setBusy(undefined);
    if (!result.ok) { setMessage({ ok: false, text: result.message ?? "Não foi possível alterar o cupom." }); return; }
    setMessage({ ok: true, text: `Cupom ${coupon.code} ${coupon.active ? "desativado" : "ativado"}.` });
    router.refresh();
  };

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-white/10 bg-[#080808] p-5">
        <h2 className="text-sm font-semibold">Novo cupom</h2>
        <p className="mt-1 text-xs text-zinc-500">Cria o cupom e o código promocional na Stripe. Na compra, vale o que deixar o primeiro pagamento menor: o cupom ou a promoção do 1º mês.</p>
        <form onSubmit={create} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs text-zinc-400">Código
            <input required value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} pattern="[A-Za-z0-9_\-]{3,40}" placeholder="BEMVINDO10" className={`${field} font-mono uppercase`} />
          </label>
          <label className="text-xs text-zinc-400">Tipo de desconto
            <select value={kind} onChange={(event) => setKind(event.target.value as "percent" | "amount")} className={field}>
              <option value="percent">Percentual (%)</option>
              <option value="amount">Valor fixo (R$)</option>
            </select>
          </label>
          <label className="text-xs text-zinc-400">{kind === "percent" ? "Percentual" : "Valor em R$"}
            <input required inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} placeholder={kind === "percent" ? "10" : "5,00"} className={field} />
          </label>
          <label className="text-xs text-zinc-400">Duração
            <select value={duration} onChange={(event) => setDuration(event.target.value as "once" | "forever" | "repeating")} className={field}>
              <option value="once">Só o 1º mês</option>
              <option value="repeating">Por alguns meses</option>
              <option value="forever">Recorrente (todos os meses)</option>
            </select>
          </label>
          {duration === "repeating" ? (
            <label className="text-xs text-zinc-400">Meses
              <input type="number" min={1} max={36} required value={months} onChange={(event) => setMonths(event.target.value)} className={field} />
            </label>
          ) : null}
          <label className="text-xs text-zinc-400">Limite de usos (opcional)
            <input type="number" min={1} value={maxRedemptions} onChange={(event) => setMaxRedemptions(event.target.value)} placeholder="Sem limite" className={field} />
          </label>
          <label className="text-xs text-zinc-400">Válido até (opcional)
            <input type="date" value={expiresOn} onChange={(event) => setExpiresOn(event.target.value)} className={field} />
          </label>
          <fieldset className="text-xs text-zinc-400">
            <legend>Planos (nenhum marcado = todos)</legend>
            <div className="mt-2 flex flex-wrap gap-3">
              {PLANS.map(([id, name]) => (
                <label key={id} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={plans.includes(id)} onChange={(event) => setPlans((current) => event.target.checked ? [...current, id] : current.filter((plan) => plan !== id))} className="size-4 accent-[#ef233c]" />
                  {name}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex items-end">
            <button type="submit" disabled={Boolean(busy)} className="h-[38px] rounded-lg bg-uno-red px-4 text-sm font-semibold text-white transition-colors hover:bg-[#ff334b] disabled:opacity-60">{busy === "create" ? "Criando…" : "Criar cupom"}</button>
          </div>
        </form>
        {message ? <p role={message.ok ? "status" : "alert"} className={`mt-3 text-sm ${message.ok ? "text-emerald-300" : "text-red-300"}`}>{message.text}</p> : null}
      </section>

      <div className="overflow-x-auto rounded-2xl border border-white/10">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="bg-white/[.03] text-xs text-zinc-500">
            <tr>{["Código", "Desconto", "Duração", "Planos", "Validade", "Usos", "Assinaturas", "Estado", ""].map((column) => <th key={column} className="px-4 py-3 font-medium">{column}</th>)}</tr>
          </thead>
          <tbody>
            {coupons.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-6 text-center text-zinc-500">Nenhum cupom criado.</td></tr>
            ) : coupons.map((coupon) => (
              <tr key={coupon.id} className="border-t border-white/[.06]">
                <td className="px-4 py-3 font-mono text-white">{coupon.code}</td>
                <td className="px-4 py-3 text-zinc-300">{coupon.label}</td>
                <td className="px-4 py-3 text-zinc-400">{durationText(coupon)}</td>
                <td className="px-4 py-3 text-zinc-400">{coupon.planIds.length ? coupon.planIds.join(", ") : "Todos"}</td>
                <td className="px-4 py-3 text-zinc-400">{coupon.expiresAt ? new Date(coupon.expiresAt).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—"}</td>
                <td className="px-4 py-3 tabular-nums text-zinc-300">{coupon.checkoutsCompleted}{coupon.maxRedemptions ? ` / ${coupon.maxRedemptions}` : ""}</td>
                <td className="px-4 py-3 tabular-nums text-zinc-300">{coupon.subscriptions}</td>
                <td className="px-4 py-3"><span className={`rounded-full px-2 py-0.5 text-xs ${coupon.active ? "bg-emerald-500/15 text-emerald-300" : "bg-white/[.06] text-zinc-400"}`}>{coupon.active ? "Ativo" : "Inativo"}</span></td>
                <td className="px-4 py-3 text-right">
                  <button type="button" disabled={Boolean(busy)} onClick={() => void toggle(coupon)} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/[.06] disabled:opacity-60">
                    {busy === coupon.id ? "Salvando…" : coupon.active ? "Desativar" : "Ativar"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
