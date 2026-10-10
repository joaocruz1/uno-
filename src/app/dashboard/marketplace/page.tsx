import type { Metadata } from "next";

import { LoteFlow } from "@/components/marketplace/lote-flow";
import { getPlanCatalog } from "@/lib/plans";
import { requireActor } from "@/server/http";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lote de marketplace",
};

export default async function MarketplaceLotePage() {
  const actor = await requireActor();
  const plan = getPlanCatalog()[actor.planId];

  return (
    <div className="mx-auto max-w-6xl">
      <header className="max-w-2xl">
        <p className="text-sm font-semibold text-uno-red">Lote de marketplace</p>
        <h1 className="mt-2 font-heading text-3xl font-bold tracking-tight sm:text-4xl">Vários pedidos. Um PDF.</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-400 sm:text-base">Envie o PDF de etiquetas do Mercado Livre com o lote inteiro. A UNO separa os pedidos, valida os códigos de cada um e devolve um PDF único, pronto para a térmica.</p>
      </header>

      <div className="mt-8">
        <LoteFlow planName={plan.name} maxFileMB={plan.maxFileMB} />
      </div>
    </div>
  );
}
