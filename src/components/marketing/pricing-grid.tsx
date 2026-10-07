import { Check } from "lucide-react";
import { PLANS, type PlanId } from "@/lib/plans";
import { ButtonLink } from "../ui/button";
import { Card } from "../ui/card";

const order: PlanId[] = ["FREE", "STARTER", "PRO", "BUSINESS"];
const extras: Record<PlanId, string[]> = {
  FREE: ["Processamento individual", "Histórico por 7 dias"],
  STARTER: ["Lotes de até 50 arquivos", "Histórico por 30 dias"],
  PRO: ["API e webhooks", "60 requisições por minuto"],
  BUSINESS: ["Lotes de até 500 arquivos", "120 requisições por minuto"],
};

export function PricingGrid({ compact = false }: { compact?: boolean }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {order.map((id) => {
        const plan = PLANS[id];
        const featured = id === "PRO";
        return (
          <Card key={id} className={`relative flex flex-col rounded-2xl p-6 ${featured ? "border-uno-red shadow-[0_0_45px_rgba(239,35,60,.1)]" : ""}`}>
            {featured ? <span className="absolute right-4 top-4 rounded-full bg-uno-red px-2.5 py-1 text-[10px] font-bold text-white">Mais escolhido</span> : null}
            <h3 className="font-heading text-xl font-bold">{plan.name}</h3>
            <div className="mt-5 flex items-end gap-1"><span className="font-heading text-4xl font-extrabold tracking-tight">R$ {plan.price}</span><span className="mb-1 text-sm text-zinc-500">/mês</span></div>
            <p className="mt-5 border-y border-white/[.07] py-4 text-sm text-zinc-300"><b className="text-white">{plan.monthlyLimit.toLocaleString("pt-BR")}</b> etiquetas por mês</p>
            <ul className="mt-5 flex-1 space-y-3 text-sm text-zinc-400">
              <li className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-uno-red" />Arquivos de até {plan.maxFileMB} MB</li>
              <li className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-uno-red" />Retenção por {plan.retentionDays} dias</li>
              {!compact && extras[id].map((item) => <li key={item} className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-uno-red" />{item}</li>)}
            </ul>
            <ButtonLink href={`/register?plan=${id.toLowerCase()}`} variant={featured ? "primary" : "secondary"} className="mt-7 w-full">{id === "FREE" ? "Começar grátis" : `Escolher ${plan.name}`}</ButtonLink>
          </Card>
        );
      })}
    </div>
  );
}
