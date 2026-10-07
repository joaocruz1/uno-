import { BillingPanel } from "@/components/billing/billing-panel";
import { requireActor } from "@/server/http";

export default async function BillingPage() {
  const actor = await requireActor();
  return <div className="mx-auto max-w-6xl"><p className="text-sm font-semibold text-uno-red">Seu ritmo de expedição</p><h1 className="mt-2 font-heading text-3xl font-bold">Assinatura</h1><p className="mt-3 text-zinc-400">Cobrança mensal, sem excedentes automáticos. A confirmação da assinatura vem do provedor de cobrança.</p><BillingPanel key={actor.organizationId} canManage={actor.membershipRole !== "MEMBER"}/></div>;
}
