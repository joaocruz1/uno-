import type { Metadata } from "next";

import { ReferralPanel } from "@/components/referrals/referral-panel";
import { requireActor } from "@/server/http";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Indique e ganhe",
};

export default async function IndicacoesPage() {
  await requireActor();
  return (
    <div className="mx-auto max-w-4xl">
      <header className="max-w-2xl">
        <p className="text-sm font-semibold text-uno-red">Indique e ganhe</p>
        <h1 className="mt-2 font-heading text-3xl font-bold tracking-tight sm:text-4xl">Traga outros vendedores.</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-400 sm:text-base">Compartilhe seu link. A cada 3 indicações ativas — quem se cadastra pelo link e converte ao menos uma etiqueta —, você ganha 5 dias de acesso completo, uma vez.</p>
      </header>
      <div className="mt-8">
        <ReferralPanel />
      </div>
    </div>
  );
}
