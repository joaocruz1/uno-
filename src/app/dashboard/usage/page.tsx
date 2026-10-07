import { UsagePanel } from "@/components/billing/usage-panel";
import { requireActor } from "@/server/http";

export default async function UsagePage() {
  const actor = await requireActor();
  return <div className="mx-auto max-w-5xl"><p className="text-sm font-semibold text-uno-red">Contabilidade da organização</p><h1 className="mt-2 font-heading text-3xl font-bold">Uso</h1><p className="mt-3 text-zinc-400">Uma etiqueta consome cota quando a conversão conclui. Falhas liberam a reserva.</p><UsagePanel key={actor.organizationId}/></div>;
}
