import type { Metadata } from "next";

import { ConversionFlow } from "@/components/conversion/conversion-flow";
import { PLANS } from "@/lib/plans";
import { requireActor } from "@/server/http";

export const metadata: Metadata = {
  title: "Nova conversão",
};

export default async function ProcessPage() {
  const actor = await requireActor();
  const plan = PLANS[actor.planId];

  return (
    <div className="mx-auto max-w-6xl">
      <header className="max-w-2xl">
        <p className="text-sm font-semibold text-uno-red">Nova conversão</p>
        <h1 className="mt-2 font-heading text-3xl font-bold tracking-tight sm:text-4xl">Envie sua etiqueta.</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-400 sm:text-base">Envie a etiqueta logística e a DANFE no mesmo PDF. A UNO organiza o conteúdo e valida os códigos antes de liberar sua etiqueta.</p>
      </header>

      <div className="mt-8">
        <ConversionFlow planName={plan.name} maxFileMB={plan.maxFileMB} />
      </div>
    </div>
  );
}
