import type { Metadata } from "next";

import { UploadPanel } from "@/components/conversion/upload-panel";
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
        <p className="mt-3 text-sm leading-6 text-zinc-400 sm:text-base">Selecione um PDF de duas páginas. Nesta etapa, o arquivo será enviado ao armazenamento privado da sua organização.</p>
      </header>

      <div className="mt-8">
        <UploadPanel planName={plan.name} maxFileMB={plan.maxFileMB} />
      </div>
    </div>
  );
}
