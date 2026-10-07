import { adminOverview } from "@/server/admin";
import { requireAdminPage } from "@/server/admin/page";

export const dynamic = "force-dynamic";

function Metric({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#080808] p-5">
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-2 font-heading text-3xl font-bold tabular-nums">{value.toLocaleString("pt-BR")}</p>
      {hint ? <p className="mt-2 text-xs text-zinc-500">{hint}</p> : null}
    </div>
  );
}

function Breakdown({ title, values, empty }: { title: string; values: Array<[string, number]>; empty: string }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-[#080808] p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {values.length ? (
        <dl className="mt-4 space-y-2">
          {values.map(([key, value]) => <div key={key} className="flex items-center justify-between gap-4 text-sm"><dt className="font-mono text-xs text-zinc-400">{key}</dt><dd className="tabular-nums text-white">{value.toLocaleString("pt-BR")}</dd></div>)}
        </dl>
      ) : <p className="mt-4 text-sm text-zinc-500">{empty}</p>}
    </section>
  );
}

export default async function AdminOverviewPage() {
  const admin = await requireAdminPage();
  const overview = await adminOverview(admin);
  const entries = (record: Record<string, number>) => Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div>
      <p className="text-sm font-semibold text-uno-red">Somente metadados</p>
      <h1 className="mt-2 font-heading text-3xl font-bold">Visão geral</h1>
      <p className="mt-3 max-w-2xl text-zinc-400">Estados, contadores e códigos de erro. Documentos, prévias e conteúdo dos clientes não aparecem aqui.</p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Organizações" value={overview.organizations} />
        <Metric label="Contas" value={overview.users} />
        <Metric label="Conversões em 24 h" value={overview.conversionsLast24h} />
        <Metric label="Falhas em 24 h" value={overview.failuresLast24h} hint={overview.conversionsLast24h ? `${Math.round((overview.failuresLast24h / overview.conversionsLast24h) * 100)}% das conversões` : undefined} />
        <Metric label="Períodos de uso ativos" value={overview.usage.activePeriods} />
        <Metric label="Etiquetas confirmadas" value={overview.usage.confirmed} hint="Nos períodos ativos" />
        <Metric label="Etiquetas reservadas" value={overview.usage.reserved} hint="Em processamento" />
      </div>
      <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Breakdown title="Assinaturas por plano" values={entries(overview.subscriptionsByPlan)} empty="Nenhuma assinatura." />
        <Breakdown title="Assinaturas por estado" values={entries(overview.subscriptionsByStatus)} empty="Nenhuma assinatura." />
        <Breakdown title="Conversões por estado" values={entries(overview.conversionsByStatus)} empty="Nenhuma conversão registrada." />
        <Breakdown title="Códigos de falha em 24 h" values={overview.failureCodesLast24h.map((item) => [item.code, item.count])} empty="Nenhuma falha nas últimas 24 horas." />
        <Breakdown title="Jobs do outbox" values={entries(overview.outboxByStatus)} empty="Nenhum job registrado." />
        <Breakdown title="Entregas de webhook" values={entries(overview.webhookDeliveriesByStatus)} empty="Nenhuma entrega registrada." />
      </div>
      <p className="mt-6 text-xs text-zinc-500">Gerado em {new Date(overview.generatedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.</p>
    </div>
  );
}
