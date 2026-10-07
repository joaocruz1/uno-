import { Bars, DailyColumns, integer, PageHeader, Panel, Stat } from "@/components/admin/insight-ui";
import { adminActivity } from "@/server/admin";
import { requireAdminPage } from "@/server/admin/page";

export const dynamic = "force-dynamic";

const SOURCE: Record<string, string> = { dashboard: "Painel (upload manual)", api: "API (ERP/integração)" };

export default async function AdminActivityPage() {
  const activity = await adminActivity(await requireAdminPage());
  const rate = activity.total30d > 0 ? Math.round((activity.completed30d / activity.total30d) * 100) : 0;
  const withRate = (row: { key: string; total: number; completed: number }, label = row.key) => ({ label, value: row.total, detail: row.total ? `${Math.round((row.completed / row.total) * 100)}% concluídas` : undefined });
  return (
    <div>
      <PageHeader kicker="Atividade" title="De onde vêm as etiquetas" description="Volume dos últimos 30 dias por canal, marketplace, formato e plano. A origem de cadastro (campanha, anúncio) ainda não é registrada." />
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat accent label="Etiquetas em 30 dias" value={integer(activity.total30d)} hint={`${integer(activity.completed30d)} concluídas (${rate}%)`} />
        <Stat label="Com cabeçalho de produto" value={integer(activity.withProductHeader)} />
        <Stat label="Tempo médio de processamento" value={activity.averageProcessingMs === null ? "—" : `${(activity.averageProcessingMs / 1_000).toFixed(1).replace(".", ",")} s`} />
        <Stat label="Novas organizações em 14 dias" value={integer(activity.signupsByDay.reduce((total, day) => total + day.total, 0))} />
      </div>
      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <Panel title="Etiquetas por dia" note="Últimos 14 dias · vermelho concluídas, cinza falhas"><DailyColumns empty="Nenhuma conversão nos últimos 14 dias." days={activity.days.map((day) => ({ day: day.day, primary: day.completed + day.other, secondary: day.failed }))} /></Panel>
        <Panel title="Novas organizações por dia" note="Últimos 14 dias"><DailyColumns empty="Nenhum cadastro nos últimos 14 dias." days={activity.signupsByDay.map((day) => ({ day: day.day, primary: day.total }))} /></Panel>
        <Panel title="Por canal"><Bars empty="Sem conversões no período." rows={activity.bySource.map((row) => withRate(row, SOURCE[row.key] ?? row.key))} /></Panel>
        <Panel title="Por marketplace (template)"><Bars empty="Sem conversões no período." rows={activity.byTemplate.map((row) => withRate(row))} /></Panel>
        <Panel title="Por plano do cliente"><Bars empty="Sem conversões no período." rows={activity.byPlan.map((row) => withRate(row))} /></Panel>
        <Panel title="Por formato de saída"><Bars empty="Sem conversões no período." rows={activity.bySize.map((row) => ({ label: row.key, value: row.total }))} /></Panel>
      </div>
    </div>
  );
}
