import { DataTable, dateTime, integer, PageHeader, Pill } from "@/components/admin/insight-ui";
import { adminCustomers } from "@/server/admin";
import { requireAdminPage } from "@/server/admin/page";

export const dynamic = "force-dynamic";

export default async function AdminCustomersPage() {
  const customers = await adminCustomers(await requireAdminPage());
  return (
    <div>
      <PageHeader kicker="Clientes" title="Quem está usando" description="Organizações ordenadas pelas etiquetas concluídas nos últimos 30 dias, com o uso da cota do período atual." />
      <div className="mt-8">
        <DataTable empty="Nenhuma organização cadastrada." columns={["Organização", "Plano", "Cota do período", "Etiquetas em 30 dias", "Canal", "Chaves de API", "Última conversão"]} rows={customers.map((row) => {
          const share = row.periodLimit > 0 ? Math.min(100, Math.round((row.periodConfirmed / row.periodLimit) * 100)) : 0;
          return [
            <div key="o"><p className="font-medium text-white">{row.organizationName}</p><p className="text-xs text-zinc-500">{integer(row.members)} {row.members === 1 ? "membro" : "membros"}</p></div>,
            <Pill key="p" tone={row.planId === "FREE" ? "muted" : "good"}>{row.planId}</Pill>,
            <div key="q" className="min-w-36"><p className="tabular-nums">{integer(row.periodConfirmed)} / {integer(row.periodLimit)}</p><div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[.06]"><div className={`h-full rounded-full ${share >= 90 ? "bg-amber-400" : "bg-uno-red"}`} style={{ width: `${share}%` }} /></div></div>,
            <div key="c"><p className="tabular-nums text-white">{integer(row.completed30d)} concluídas</p><p className="text-xs text-zinc-500">{integer(row.failed30d)} falhas de {integer(row.conversions30d)}</p></div>,
            <p key="s" className="text-xs text-zinc-400">Painel {integer(row.viaDashboard30d)} · API {integer(row.viaApi30d)}</p>,
            integer(row.activeApiKeys),
            dateTime(row.lastConversionAt),
          ];
        })} />
      </div>
    </div>
  );
}
