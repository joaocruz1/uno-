import { and, count, eq, gt, lte } from "drizzle-orm";

import { conversions, getDb, usagePeriods } from "@/db";
import { PLANS } from "@/lib/plans";
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
  const configuredPlan = PLANS[actor.planId];
  const usage = usageRows[0] ?? { reserved: 0, confirmed: 0, limit: configuredPlan.monthlyLimit };
  const remaining = Math.max(0, usage.limit - usage.reserved - usage.confirmed);

  const cards = [
    { label: "Conversões", value: conversionRows[0]?.total ?? 0, detail: "Total registrado" },
    { label: "Uso do período", value: usage.confirmed, detail: `${usage.reserved} reservadas` },
    { label: "Disponíveis", value: remaining, detail: `de ${usage.limit} no plano ${configuredPlan.name}` },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <div>
        <p className="text-sm font-semibold text-uno-red">Visão geral</p>
        <h1 className="mt-2 font-heading text-3xl font-bold tracking-tight sm:text-4xl">Olá, {actor.name.split(" ")[0]}</h1>
        <p className="mt-2 text-zinc-400">Os números abaixo vêm dos registros da sua organização.</p>
      </div>
      <section className="mt-8 grid gap-4 sm:grid-cols-3" aria-label="Resumo da organização">
        {cards.map((card) => (
          <article key={card.label} className="rounded-xl border border-white/[.07] bg-white/[.025] p-5">
            <p className="text-sm text-zinc-400">{card.label}</p>
            <p className="mt-3 font-heading text-3xl font-bold tabular-nums">{card.value}</p>
            <p className="mt-1 text-xs text-zinc-500">{card.detail}</p>
          </article>
        ))}
      </section>
      <section className="mt-8 rounded-xl border border-dashed border-white/10 bg-[#050505] p-8 text-center">
        <h2 className="font-heading text-xl font-semibold">Sua próxima etiqueta começa aqui</h2>
        <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-zinc-500">Envie uma etiqueta logística com a DANFE para criar uma página pronta para impressão.</p>
      </section>
    </div>
  );
}
