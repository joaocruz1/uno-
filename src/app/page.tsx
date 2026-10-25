import Link from "next/link";
import { ArrowRight, BadgeCheck, Braces, Lock, Package } from "lucide-react";

import { Footer, Navbar } from "@/components";
import { PlanPurchaseButton } from "@/components/checkout/purchase-dialog";
import { ButtonLink } from "@/components/ui";
import { HeroStage } from "@/components/marketing/hero-stage";
import { HowItWorks } from "@/components/marketing/how-it-works";
import { Magnetic, SpotlightCard } from "@/components/marketing/interactive";
import { Reveal } from "@/components/marketing/reveal";
import { TrialStudio } from "@/components/marketing/trial-studio";
import { formatBrlCents, getApiAddon, getPlanCatalog, hasFirstMonthPromo } from "@/lib/plans";
import { publicPlans } from "@/lib/public-plans";

const GUTTER = "px-[clamp(1.25rem,5vw,6rem)]";

const differentials = [
  { icon: BadgeCheck, title: "Valida de verdade", text: "Decodifica os códigos na saída a 203 e 300 dpi e compara com a entrada. Recusa em vez de arriscar." },
  { icon: Package, title: "Lote de marketplace", text: "Vários pedidos num PDF só — uma etiqueta por pedido, numerada." },
  { icon: Braces, title: "API e webhooks", text: "Converta direto do seu ERP, de forma assíncrona, com webhook assinado." },
  { icon: Lock, title: "Seus dados, privados", text: "Arquivos com link assinado e expiração. Nada entra na telemetria." },
];

export default function Home() {
  const plans = getPlanCatalog();
  const order = ["FREE", "STARTER", "PRO", "BUSINESS"] as const;
  const addon = getApiAddon();
  const purchasable = publicPlans().filter((plan) => plan.id !== "FREE");

  return (
    <main className="site-shell">
      <Navbar />

      <section className={`site-hero hero-full relative flex items-center overflow-hidden ${GUTTER} pb-16 pt-28`}>
        <div className="uno-bloom" style={{ top: "6%", right: "6%", width: "34rem", height: "34rem", background: "rgba(239,35,60,.16)" }} aria-hidden />
        <div className="uno-bloom" style={{ bottom: "-6rem", left: "-4rem", width: "26rem", height: "26rem", background: "rgba(239,35,60,.1)", animationDelay: "-9s" }} aria-hidden />

        <div className="relative z-10 mx-auto grid w-full max-w-[1500px] items-center gap-14 lg:grid-cols-[1.05fr_minmax(360px,.82fr)] lg:gap-20">
          <div>
            <h1 className="font-heading text-[clamp(2.9rem,7.2vw,5.4rem)] font-extrabold leading-[.95] tracking-[-.05em] text-[var(--color-ink)]">
              <span className="line-mask"><span>Duas páginas.</span></span>
              <span className="line-mask"><span>Uma etiqueta.</span></span>
            </h1>
            <p className="uno-enter uno-d2 mt-6 max-w-md text-lg leading-7 text-[var(--color-muted)]">
              Solte o PDF do marketplace e receba uma etiqueta 10×15 pronta pra térmica — com cada código conferido antes de sair.
            </p>
            <div className="uno-enter uno-d3 mt-8 flex flex-col gap-3 sm:flex-row">
              <Magnetic><ButtonLink href="#testar" size="lg" className="glow-cta">Testar sem cadastro <ArrowRight size={17} /></ButtonLink></Magnetic>
              <Magnetic><ButtonLink href="/register" variant="secondary" size="lg">Criar conta grátis</ButtonLink></Magnetic>
            </div>
            <p className="uno-enter uno-d3 mt-4 text-sm text-[var(--color-faint)]">Grátis até {plans.FREE.monthlyLimit} etiquetas por mês. Sem cartão.</p>
          </div>

          <div className="uno-enter uno-d4 flex justify-center lg:justify-end">
            <HeroStage />
          </div>
        </div>
      </section>

      <section id="testar" className={`scroll-mt-24 ${GUTTER} py-14`}>
        <div className="mx-auto max-w-6xl">
          <div className="text-center">
            <h2 className="font-heading text-[clamp(1.9rem,4vw,2.6rem)] font-extrabold tracking-tight text-[var(--color-ink)]">Teste agora, sem cadastro</h2>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-[var(--color-muted)]">Escolha o marketplace, jogue uma etiqueta e veja o resultado na hora — Mercado Livre, Shopee ou TikTok.</p>
          </div>
          <div className="mt-8"><TrialStudio /></div>
        </div>
      </section>

      <HowItWorks />

      <section id="produto" className={`scroll-mt-24 ${GUTTER} py-14`}>
        <div className="mx-auto max-w-7xl">
          <h2 className="max-w-2xl font-heading text-[clamp(1.9rem,4vw,2.6rem)] font-extrabold tracking-tight text-[var(--color-ink)]">
            Por que a UNO, e não só um conversor.
          </h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {differentials.map((item, index) => (
              <Reveal key={item.title} delay={index * 70} className={index === 0 ? "sm:col-span-2 lg:row-span-2" : ""}>
                <SpotlightCard className={`card-soft h-full rounded-2xl ${index === 0 ? "flex flex-col justify-between p-7 lg:p-9" : "p-6"}`}>
                  <div>
                    <item.icon className="text-uno-red" size={index === 0 ? 28 : 22} />
                    <h3 className={`mt-4 font-heading font-bold text-[var(--color-ink)] ${index === 0 ? "text-2xl tracking-tight lg:text-3xl" : "text-lg"}`}>{item.title}</h3>
                    <p className={`mt-1.5 leading-6 text-[var(--color-muted)] ${index === 0 ? "max-w-md text-base leading-7" : "text-sm"}`}>{item.text}</p>
                  </div>
                  {index === 0 ? (
                    <dl className="mt-8 grid grid-cols-2 gap-3 text-sm">
                      <div className="rounded-xl bg-[var(--color-surface-2)] p-4 ring-1 ring-inset ring-[var(--color-line)]"><dt className="text-[var(--color-muted)]">Resolução de conferência</dt><dd className="mt-1 font-heading text-xl font-extrabold tabular-nums text-[var(--color-ink)]">203 e 300 dpi</dd></div>
                      <div className="rounded-xl bg-[var(--color-surface-2)] p-4 ring-1 ring-inset ring-[var(--color-line)]"><dt className="text-[var(--color-muted)]">Se o código não bate</dt><dd className="mt-1 font-heading text-xl font-extrabold text-[var(--color-ink)]">A etiqueta não sai</dd></div>
                    </dl>
                  ) : null}
                </SpotlightCard>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section id="precos" className={`scroll-mt-24 ${GUTTER} py-14`}>
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="font-heading text-[clamp(1.9rem,4vw,2.6rem)] font-extrabold tracking-tight text-[var(--color-ink)]">Planos</h2>
            <p className="text-sm text-[var(--color-muted)]">No cartão ou avulso por PIX. Sem excedente automático.</p>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {order.map((id, index) => {
              const plan = plans[id];
              const highlight = id === "PRO";
              return (
                <Reveal key={id} delay={index * 70}>
                <SpotlightCard className={`card-soft h-full rounded-2xl p-5 ${highlight ? "ring-2 ring-uno-red" : ""}`}>
                  <p className="font-heading text-base font-bold text-[var(--color-ink)]">{plan.name}</p>
                  {hasFirstMonthPromo(plan) ? (
                    <>
                      <p className="mt-2 font-heading text-2xl font-extrabold tabular-nums text-[var(--color-ink)]">
                        {formatBrlCents(plan.firstMonthPriceBrlCents)}
                        <span className="ml-1 text-xs font-semibold text-uno-red">no 1º mês</span>
                      </p>
                      <p className="mt-1 text-xs text-[var(--color-faint)]">depois {formatBrlCents(plan.priceBrlCents)}/mês</p>
                    </>
                  ) : (
                    <p className="mt-2 font-heading text-2xl font-extrabold tabular-nums text-[var(--color-ink)]">
                      {plan.priceBrlCents === 0 ? "R$ 0" : formatBrlCents(plan.priceBrlCents)}
                      <span className="ml-1 text-xs font-semibold text-[var(--color-faint)]">/mês</span>
                    </p>
                  )}
                  <p className="mt-3 text-sm text-[var(--color-muted)]">{plan.monthlyLimit.toLocaleString("pt-BR")} etiquetas/mês</p>
                  {id === "FREE"
                    ? <ButtonLink href="/register?plan=free" variant="secondary" size="sm" className="mt-5 w-full">Começar</ButtonLink>
                    : <PlanPurchaseButton planId={id} plans={purchasable} variant={highlight ? "primary" : "secondary"} size="sm" className="mt-5 w-full">{`Assinar ${plan.name}`}</PlanPurchaseButton>}
                </SpotlightCard>
                </Reveal>
              );
            })}
          </div>
          <p className="mt-4 text-sm text-[var(--color-muted)]">
            API, chaves e webhooks são o adicional <span className="font-semibold text-[var(--color-ink)]">+ API, {formatBrlCents(addon.priceBrlCents)}/mês</span>, sobre qualquer plano pago.{" "}
            <Link href="/pricing" className="inline-flex items-center gap-1 font-semibold text-uno-red hover:underline">Comparar planos <ArrowRight size={14} /></Link>
          </p>
        </div>
      </section>

      <section className={`${GUTTER} py-16`}>
        <div className="relative mx-auto max-w-7xl overflow-hidden rounded-[32px] bg-[var(--color-sidebar)] px-6 py-16 text-center sm:px-12 sm:py-20">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_120%_at_50%_120%,rgba(239,35,60,.4),transparent_60%)]" aria-hidden />
          <div className="relative">
            <h2 className="font-heading text-[clamp(2rem,5vw,3.4rem)] font-extrabold tracking-tight text-white">Duas páginas esperando pra virar uma?</h2>
            <p className="mx-auto mt-3 max-w-md text-[#b5b5bd]">Crie sua conta e gere as primeiras etiquetas no plano Free.</p>
            <Magnetic className="mt-7"><ButtonLink href="/register" size="lg" className="glow-cta">Criar conta grátis <ArrowRight size={17} /></ButtonLink></Magnetic>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
