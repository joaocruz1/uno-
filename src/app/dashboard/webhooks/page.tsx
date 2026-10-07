import { WebhookPanel } from "@/components/webhooks/webhook-panel";
import { getPlanCatalog } from "@/lib/plans";
import { requireActor } from "@/server/http";

export default async function WebhooksPage() {
  const actor = await requireActor();
  const plan = getPlanCatalog()[actor.planId];
  return <div className="mx-auto max-w-5xl"><p className="text-sm font-semibold text-uno-red">Integrações com ERPs</p><h1 className="mt-2 font-heading text-3xl font-bold">Webhooks</h1><p className="mt-3 text-zinc-400">Receba um aviso no seu sistema quando uma conversão ou um lote terminar.</p><WebhookPanel key={actor.organizationId} canManage={actor.membershipRole !== "MEMBER"} webhooksAvailable={plan.api}/></div>;
}
