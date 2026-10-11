import Link from "next/link";
import { ArrowRight, BadgeCheck, Braces, Lock, Package, Printer, ScanLine, UploadCloud } from "lucide-react";

import { Footer, Navbar } from "@/components";
import { ButtonLink } from "@/components/ui";
import { ChannelMark, ChannelStrip } from "@/components/marketplace-logos";
import { formatBrlCents, getApiAddon, getPlanCatalog } from "@/lib/plans";

const steps = [
  { icon: UploadCloud, title: "Envie o PDF", text: "A etiqueta do marketplace, do jeito que o pedido baixou." },
  { icon: ScanLine, title: "Validamos os códigos", text: "Decodificamos cada código e conferimos com a chave. Não bateu, não sai." },
  { icon: Printer, title: "Imprima a 10×15", text: "Uma página pronta pra térmica, sem espaço em branco." },
];

const differentials = [
  { icon: BadgeCheck, title: "Valida de verdade", text: "Decodifica os códigos na saída a 203 e 300 dpi e compara com a entrada. Recusa em vez de arriscar." },
  { icon: Package, title: "Lote de marketplace", text: "Vários pedidos num PDF só — uma etiqueta por pedido, numerada." },
  { icon: Braces, title: "API e webhooks", text: "Converta direto do seu ERP, de forma assíncrona, com webhook assinado." },
  { icon: Lock, title: "Seus dados, privados", text: "Arquivos com link assinado e expiração. Nada entra na telemetria." },
];

function LabelPreview() {
  return (
    <div className="card-soft w-full max-w-[320px] rounded-2xl p-4">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-xs font-semibold text-[var(--color-muted)]"><ChannelMark id="mercado-livre" size={22} />Etiqueta de envio</span>
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-ok-surface)] px-2 py-1 text-[10px] font-semibold text-[var(--color-ok)]"><BadgeCheck size={12} />Conferido</span>
      </div>

      <div className="mt-3 h-12 w-full rounded-sm bg-[repeating-linear-gradient(90deg,#0b0b0c_0_2px,transparent_2px_4px,#0b0b0c_4px_5px,transparent_5px_8px)]" aria-hidden />
      <p className="mt-1 text-center text-[9px] tracking-[.3em] text-[var(--color-faint)]">7 8 9 1 2 3 4 5 6 7 8 9 0</p>

      <div className="mt-3 flex items-start justify-between gap-3">
        <div className="text-[10px] leading-4 text-[var(--color-muted)]">
          <p className="font-semibold text-[var(--color-ink)]">Destinatário</p>
          <p>Rua Exemplo, 123</p>
          <p>Bairro · Cidade/UF</p>
          <p>CEP 00000-000</p>
        </div>
        <svg width="46" height="46" viewBox="0 0 10 10" className="shrink-0" aria-hidden>
          <path fill="#0b0b0c" d="M0 0h3v3H0zM4 0h1v1H4zM6 0h1v2H6zM8 0h2v1H8zM0 4h1v1H0zM2 4h2v1H2zM5 4h1v2H5zM7 4h1v1H7zM9 4h1v2H9zM4 6h1v1H4zM6 7h2v1H6zM0 7h3v3H0zM4 8h1v2H4zM7 9h3v1H7z" />
        </svg>
      </div>

      <div className="mt-3 rounded-md bg-[var(--color-surface-2)] p-2.5 ring-1 ring-inset ring-[var(--color-line)]">
        <p className="text-[9px] font-bold tracking-wide text-[var(--color-ink)]">DANFE SIMPLIFICADA</p>
        <p className="mt-1 text-[9px] text-[var(--color-muted)]">NF 000.123 · Série 1 · 10/2026</p>
        <div className="mt-1.5 h-5 w-full rounded-sm bg-[repeating-linear-gradient(90deg,#0b0b0c_0_1px,transparent_1px_3px,#0b0b0c_3px_4px,transparent_4px_7px)]" aria-hidden />
      </div>
    </div>
  );
}

export default function Home() {
  const plans = getPlanCatalog();
  const order = ["FREE", "STARTER", "PRO", "BUSINESS"] as const;
  const addon = getApiAddon();

  return (
    <main className="site-shell">
      <Navbar />

      <section className="site-hero overflow-hidden px-4 pb-16 pt-32 sm:pt-40">
        <div className="mx-auto grid max-w-5xl items-center gap-12 lg:grid-cols-[1.05fr_.95fr]">
          <div>
            <h1 className="font-heading text-[clamp(2.6rem,7vw,4.4rem)] font-extrabold leading-[.98] tracking-[-.045em] text-[var(--color-ink)]">
              Duas páginas.<br />Uma etiqueta.
            </h1>
            <p className="mt-6 max-w-md text-lg leading-7 text-[var(--color-muted)]">
              Solte o PDF do marketplace e receba uma etiqueta 10×15 pronta pra térmica — com os códigos conferidos.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <ButtonLink href="/register" size="lg">Criar conta grátis <ArrowRight size={17} /></ButtonLink>
              <ButtonLink href="/pricing" variant="secondary" size="lg">Ver planos</ButtonLink>
            </div>
            <p className="mt-4 text-sm text-[var(--color-faint)]">Grátis até {plans.FREE.monthlyLimit} etiquetas por mês. Sem cartão.</p>
          </div>
          <div className="flex justify-center lg:justify-end">
            <LabelPreview />
          </div>
        </div>
      </section>

      <section className="px-4 py-12">
        <div className="mx-auto max-w-5xl">
          <h2 className="font-heading text-xl font-bold text-[var(--color-ink)]">Comece pelo Mercado Livre</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">Os outros canais entram em seguida.</p>
          <ChannelStrip className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" />
        </div>
      </section>

      <section className="px-4 py-12">
        <div className="mx-auto grid max-w-5xl gap-5 sm:grid-cols-3">
          {steps.map((step) => (
            <div key={step.title} className="card-soft rounded-2xl p-6">
              <span className="grid size-11 place-items-center rounded-xl bg-uno-red/10 text-uno-red"><step.icon size={22} /></span>
              <h3 className="mt-4 font-heading text-lg font-bold text-[var(--color-ink)]">{step.title}</h3>
              <p className="mt-1.5 text-sm leading-6 text-[var(--color-muted)]">{step.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="px-4 py-12">
        <div className="mx-auto max-w-5xl">
          <h2 className="max-w-xl font-heading text-3xl font-extrabold tracking-tight text-[var(--color-ink)]">Por que a UNO, e não só um conversor.</h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {differentials.map((item) => (
              <div key={item.title} className="card-soft rounded-2xl p-6">
                <item.icon className="text-uno-red" size={22} />
                <h3 className="mt-4 font-heading text-lg font-bold text-[var(--color-ink)]">{item.title}</h3>
                <p className="mt-1.5 text-sm leading-6 text-[var(--color-muted)]">{item.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="precos" className="px-4 py-12">
        <div className="mx-auto max-w-5xl">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="font-heading text-3xl font-extrabold tracking-tight text-[var(--color-ink)]">Planos</h2>
            <p className="text-sm text-[var(--color-muted)]">No cartão ou avulso por PIX. Sem excedente automático.</p>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {order.map((id) => {
              const plan = plans[id];
              const highlight = id === "PRO";
              return (
                <div
                  key={id}
                  className={`card-soft rounded-2xl p-5 ${highlight ? "ring-2 ring-uno-red" : ""}`}
                >
                  <p className="font-heading text-base font-bold text-[var(--color-ink)]">{plan.name}</p>
                  <p className="mt-2 font-heading text-2xl font-extrabold tabular-nums text-[var(--color-ink)]">
                    {plan.priceBrlCents === 0 ? "R$ 0" : formatBrlCents(plan.priceBrlCents)}
                    <span className="ml-1 text-xs font-semibold text-[var(--color-faint)]">/mês</span>
                  </p>
                  <p className="mt-3 text-sm text-[var(--color-muted)]">{plan.monthlyLimit.toLocaleString("pt-BR")} etiquetas/mês</p>
                  <ButtonLink href="/register" variant={highlight ? "primary" : "secondary"} size="sm" className="mt-5 w-full">
                    Começar
                  </ButtonLink>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-sm text-[var(--color-muted)]">
            API, chaves e webhooks são o adicional <span className="font-semibold text-[var(--color-ink)]">+ API, {formatBrlCents(addon.priceBrlCents)}/mês</span>, sobre qualquer plano pago.{" "}
            <Link href="/pricing" className="inline-flex items-center gap-1 font-semibold text-uno-red hover:underline">Comparar planos <ArrowRight size={14} /></Link>
          </p>
        </div>
      </section>

      <section className="px-4 py-16">
        <div className="mx-auto max-w-5xl overflow-hidden rounded-3xl bg-[var(--color-sidebar)] px-6 py-14 text-center sm:px-12">
          <h2 className="font-heading text-3xl font-extrabold tracking-tight text-white sm:text-4xl">Duas páginas esperando pra virar uma?</h2>
          <p className="mx-auto mt-3 max-w-md text-[#b5b5bd]">Crie sua conta e gere as primeiras etiquetas no plano Free.</p>
          <ButtonLink href="/register" size="lg" className="mt-7">Criar conta grátis <ArrowRight size={17} /></ButtonLink>
        </div>
      </section>

      <Footer />
    </main>
  );
}
