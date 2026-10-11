import { and, count, eq, gt, lte } from "drizzle-orm";
import { ArrowRight, Package } from "lucide-react";
import Link from "next/link";

import { conversions, getDb, usagePeriods } from "@/db";
import { ButtonLink } from "@/components/ui";
import { ChannelStrip } from "@/components/marketplace-logos";
import { getPlanCatalog } from "@/lib/plans";
import { requireActor } from "@/server/http";

export default async function DashboardPage() {
  const actor = await requireActor();
  const database = getDb();
  const currentTime = new Date();
  const [conversionRows, usageRows] = await Promise.all([
    database.select({ total: count() }).from(conversions).where(eq(conversions.organizationId, actor.organizationId)),
    database
      .select({ reserved: usagePeriods.reserved, confirmed: usagePeriods.confirmed, limit: usagePeriods.limit })
      .from(usagePeriods)
      .where(and(eq(usagePeriods.organizationId, actor.organizationId), lte(usagePeriods.periodStart, currentTime), gt(usagePeriods.periodEnd, currentTime)))
      .limit(1),
  ]);
  const configuredPlan = getPlanCatalog()[actor.planId];
  const usage = { reserved: usageRows[0]?.reserved ?? 0, confirmed: usageRows[0]?.confirmed ?? 0, limit: configuredPlan.monthlyLimit };
  const used = usage.reserved + usage.confirmed;
  const remaining = Math.max(0, usage.limit - used);
  const pct = usage.limit > 0 ? Math.min(100, Math.round((used / usage.limit) * 100)) : 0;
  const totalConversions = conversionRows[0]?.total ?? 0;

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="font-heading text-3xl font-extrabold tracking-tight text-[var(--color-ink)] sm:text-[2.1rem]">
        Olá, {actor.name.split(" ")[0]}
      </h1>
      <p className="mt-2 text-[var(--color-muted)]">Da etiqueta do marketplace ao PDF pronto para a térmica, em um lugar só.</p>

      <div className="mt-7 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* Quota meter — the number that actually drives the day. */}
        <section className="card-soft rounded-2xl p-6" aria-label="Uso do período">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-sm font-medium text-[var(--color-muted)]">Uso do período</p>
            <p className="text-xs text-[var(--color-faint)]">Plano {configuredPlan.name}</p>
          </div>
          <p className="mt-3 font-heading text-4xl font-extrabold tabular-nums text-[var(--color-ink)]">
            {remaining}
            <span className="ml-2 align-middle text-base font-semibold text-[var(--color-muted)]">de {usage.limit} disponíveis</span>
          </p>
          <div className="mt-5 h-2.5 overflow-hidden rounded-full bg-[var(--color-surface-2)] ring-1 ring-inset ring-[var(--color-line)]">
            <div className="h-full rounded-full bg-uno-red transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-3 text-xs text-[var(--color-faint)]">
            {usage.confirmed} confirmada{usage.confirmed === 1 ? "" : "s"}
            {usage.reserved > 0 ? ` · ${usage.reserved} reservada${usage.reserved === 1 ? "" : "s"}` : ""} neste período.
          </p>
        </section>

        <section className="card-soft rounded-2xl p-6" aria-label="Conversões">
          <p className="text-sm font-medium text-[var(--color-muted)]">Conversões no total</p>
          <p className="mt-3 font-heading text-4xl font-extrabold tabular-nums text-[var(--color-ink)]">{totalConversions}</p>
          <p className="mt-1 text-xs text-[var(--color-faint)]">Etiquetas geradas pela sua organização.</p>
          <ButtonLink href="/dashboard/history" variant="ghost" size="sm" className="mt-5 -ml-2">
            Ver histórico <ArrowRight size={15} />
          </ButtonLink>
        </section>
      </div>

      {/* Start points — the two real entry actions, with the batch one led by its mark. */}
      <section className="mt-4 grid gap-4 sm:grid-cols-2">
        <Link
          href="/dashboard/marketplace"
          className="card-soft group rounded-2xl p-6 transition hover:border-[var(--color-line-strong)]"
        >
          <span className="grid size-11 place-items-center rounded-xl bg-uno-red/10 text-uno-red"><Package size={22} /></span>
          <h2 className="mt-4 font-heading text-lg font-bold text-[var(--color-ink)]">Lote de marketplace</h2>
          <p className="mt-1.5 text-sm leading-6 text-[var(--color-muted)]">Vários pedidos do Mercado Livre em um PDF só, numerado e validado.</p>
          <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-uno-red">Enviar lote <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" /></span>
        </Link>

        <Link
          href="/dashboard/process"
          className="card-soft group rounded-2xl p-6 transition hover:border-[var(--color-line-strong)]"
        >
          <span className="grid size-11 place-items-center rounded-xl bg-[var(--color-surface-2)] text-[var(--color-ink)] ring-1 ring-inset ring-[var(--color-line)]"><ArrowRight size={22} /></span>
          <h2 className="mt-4 font-heading text-lg font-bold text-[var(--color-ink)]">Conversão individual</h2>
          <p className="mt-1.5 text-sm leading-6 text-[var(--color-muted)]">Uma etiqueta logística + DANFE em uma página pronta para imprimir.</p>
          <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--color-ink)]">Converter <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" /></span>
        </Link>
      </section>

      <section className="mt-8">
        <h2 className="font-heading text-base font-bold text-[var(--color-ink)]">Canais</h2>
        <p className="mt-1 text-sm text-[var(--color-muted)]">O Mercado Livre já está no ar; os demais entram em breve.</p>
        <ChannelStrip className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" />
      </section>
    </div>
  );
}
