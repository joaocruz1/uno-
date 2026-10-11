import { BillingPanel } from "@/components/billing/billing-panel";
import { PixPurchase } from "@/components/billing/pix-purchase";
import { requireActor } from "@/server/http";

export default async function BillingPage() {
  const actor = await requireActor();
  const canManage = actor.membershipRole !== "MEMBER";
  return <div className="mx-auto max-w-6xl space-y-6"><div><p className="text-sm font-semibold text-uno-red">Seu ritmo de expedição</p><h1 className="mt-2 font-heading text-3xl font-bold">Assinatura</h1><p className="mt-3 text-zinc-400">Assinatura no cartão (recorrente) ou compra avulsa por PIX. Sem excedentes automáticos. A confirmação vem do provedor de cobrança.</p></div><BillingPanel key={actor.organizationId} canManage={canManage}/>{canManage ? <PixPurchase/> : null}</div>;
}
