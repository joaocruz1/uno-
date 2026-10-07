import { BatchPanel } from "@/components/batches/batch-panel";
import { getPlanCatalog } from "@/lib/plans";
import { requireActor } from "@/server/http";

export default async function BatchesPage() {
  const actor = await requireActor(); const plan = getPlanCatalog()[actor.planId];
  return <div className="mx-auto max-w-6xl"><p className="text-sm font-semibold text-uno-red">Mais etiquetas, mesmo fluxo</p><h1 className="mt-2 font-heading text-3xl font-bold">Lotes</h1><p className="mt-3 text-zinc-400">Prepare seus arquivos e baixe as etiquetas aprovadas em um ZIP.</p><BatchPanel batchLimit={plan.batchLimit} maxFileMB={plan.maxFileMB}/></div>;
}
