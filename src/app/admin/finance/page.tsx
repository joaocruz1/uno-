import { brl, DataTable, date, integer, PageHeader, Panel, Pill, Stat, Bars } from "@/components/admin/insight-ui";
import { adminFinance } from "@/server/admin";
import { requireAdminPage } from "@/server/admin/page";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { ACTIVE: "Ativa", TRIALING: "Em teste", PAST_DUE: "Pagamento atrasado", CANCELED: "Cancelada", INCOMPLETE: "Incompleta", INCOMPLETE_EXPIRED: "Expirada", UNPAID: "Não paga", PAUSED: "Pausada" };

export default async function AdminFinancePage() {
  const finance = await adminFinance(await requireAdminPage());
  return (
    <div>
      <PageHeader kicker="Financeiro" title="Receita e assinaturas" description="Receita recorrente estimada pelo preço de catálogo das assinaturas vinculadas à Stripe. Planos pagos sem vínculo de cobrança (cortesia ou dados de teste) não entram na receita. O valor efetivamente cobrado (descontos, impostos, estornos) está no painel da Stripe." />
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat accent label="MRR estimado" value={brl(finance.estimatedMrrBrlCents)} hint={`ARR estimado ${brl(finance.estimatedMrrBrlCents * 12)}`} />
        <Stat label="Organizações pagantes" value={integer(finance.payingOrganizations)} hint={`${integer(finance.freeOrganizations)} no plano Free · ${integer(finance.unbilledPaidOrganizations)} com plano pago sem cobrança`} />
        <Stat label="Pagantes novas ou alteradas em 30 dias" value={integer(finance.newPaidLast30Days)} />
        <Stat label="Em risco" value={integer(finance.cancelingAtPeriodEnd + finance.pastDue)} hint={`${integer(finance.cancelingAtPeriodEnd)} cancelam no fim do período · ${integer(finance.pastDue)} com pagamento atrasado`} />
      </div>
      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <Panel title="Receita por plano" note="Assinaturas pagantes × preço mensal">
          <Bars empty="Nenhuma assinatura paga ainda." rows={finance.byPlan.filter((plan) => plan.subscriptions > 0).map((plan) => ({ label: `${plan.name} · ${brl(plan.priceBrlCents)}/mês`, value: plan.subscriptions, detail: brl(plan.mrrBrlCents) }))} />
        </Panel>
        <Panel title="Conversão para pago">
          <p className="font-heading text-3xl font-bold tabular-nums">{finance.payingOrganizations + finance.freeOrganizations > 0 ? `${((finance.payingOrganizations / (finance.payingOrganizations + finance.freeOrganizations)) * 100).toFixed(1).replace(".", ",")}%` : "—"}</p>
          <p className="mt-2 text-sm text-zinc-500">{integer(finance.payingOrganizations)} de {integer(finance.payingOrganizations + finance.freeOrganizations)} organizações têm plano pago ativo.</p>
        </Panel>
      </div>
      <h2 className="mt-10 font-heading text-lg font-semibold">Assinaturas pagas</h2>
      <div className="mt-4">
        <DataTable empty="Nenhuma assinatura paga registrada." columns={["Organização", "Plano", "Estado", "Cobrança", "Renova em", "Atualizada"]} rows={finance.recentPaid.map((row) => [
          <span key="o" className="font-medium text-white">{row.organizationName}</span>,
          row.planId,
          <Pill key="s" tone={row.status === "ACTIVE" || row.status === "TRIALING" ? "good" : row.status === "PAST_DUE" ? "warn" : "muted"}>{STATUS[row.status] ?? row.status}{row.cancelAtPeriodEnd ? " · cancela no fim" : ""}</Pill>,
          <Pill key="b" tone={row.billingLinked ? "good" : "muted"}>{row.billingLinked ? "Stripe vinculada" : "Sem vínculo Stripe"}</Pill>,
          date(row.currentPeriodEnd),
          date(row.updatedAt),
        ])} />
      </div>
    </div>
  );
}
