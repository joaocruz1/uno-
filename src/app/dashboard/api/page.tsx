import { ApiKeyPanel } from "@/components/api/api-key-panel";
import { getPlanCatalog } from "@/lib/plans";
import { requireActor } from "@/server/http";

export default async function ApiPage() {
  const actor = await requireActor();
  const plan = getPlanCatalog()[actor.planId];
  return <div className="mx-auto max-w-5xl"><p className="text-sm font-semibold text-uno-red">Integrações com ERPs</p><h1 className="mt-2 font-heading text-3xl font-bold">API</h1><p className="mt-3 text-zinc-400">Automatize as conversões e consulte o resultado pelo seu sistema.</p><ApiKeyPanel key={actor.organizationId} canManage={actor.membershipRole !== "MEMBER"} apiAvailable={plan.api} rateLimit={plan.rateLimit}/></div>;
}
