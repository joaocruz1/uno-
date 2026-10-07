import type { Metadata } from "next";
import { Check, Minus } from "lucide-react";
import { PublicPage } from "@/components";
import { PricingGrid } from "@/components/marketing";
import { getPlanCatalog } from "@/lib/plans";

export const metadata: Metadata = { title: "Preços", description: "Compare os planos Free, Starter, Pro e Business da UNO." };

export default function PricingPage() {
  const catalog = getPlanCatalog();
  const plans = [catalog.FREE, catalog.STARTER, catalog.PRO, catalog.BUSINESS];
  const comparison = [
    ["Etiquetas por mês", ...plans.map(plan => plan.monthlyLimit.toLocaleString("pt-BR"))],
    ["Arquivo máximo", ...plans.map(plan => `${plan.maxFileMB} MB`)],
    ["Lote máximo", ...plans.map(plan => String(plan.batchLimit))],
    ["Retenção", ...plans.map(plan => `${plan.retentionDays} dias`)],
    ["API e webhooks", ...plans.map(plan => plan.api)],
    ["Requisições por minuto", ...plans.map(plan => plan.api ? String(plan.rateLimit) : "—")],
  ];
  return (
    <PublicPage eyebrow="Preços" title="Um plano para cada ritmo de expedição." intro="Escolha pelo volume mensal, tamanho dos arquivos, lotes e integrações que a sua operação precisa. Não há cobrança automática por excedente nem marca d'água.">
      <section className="section-space"><div className="page-shell"><PricingGrid /></div></section>
      <section className="section-space border-y border-white/[.06] bg-[#030303]"><div className="page-shell"><h2 className="section-title">Compare os limites.</h2><div className="mt-12 overflow-x-auto border border-white/10"><table className="w-full min-w-[760px] border-collapse text-left text-sm"><thead><tr className="border-b border-white/10 bg-white/[.025]"><th className="p-4 font-medium text-zinc-500">Recurso</th>{["Free", "Starter", "Pro", "Business"].map((plan) => <th className="p-4 font-heading font-bold" key={plan}>{plan}</th>)}</tr></thead><tbody>{comparison.map(([feature, ...values]) => <tr className="border-b border-white/[.06] last:border-0" key={String(feature)}><td className="p-4 text-zinc-400">{feature}</td>{values.map((value, index) => <td key={index} className="p-4 text-zinc-200">{typeof value === "boolean" ? value ? <Check size={17} className="text-uno-red" aria-label="Incluído" /> : <Minus size={17} className="text-zinc-700" aria-label="Não incluído" /> : value}</td>)}</tr>)}</tbody></table></div><p className="mt-5 text-sm leading-6 text-zinc-500">A API e os webhooks ficam disponíveis nos planos Pro e Business. O uso é bloqueado ao atingir o limite mensal; não há excedente automático.</p></div></section>
      <section className="section-space"><div className="page-shell max-w-3xl"><h2 className="section-title">Dúvidas sobre cobrança.</h2><div className="mt-10 divide-y divide-white/10 border-y border-white/10">{[["Quando o limite mensal é atingido?", "Novas conversões ficam bloqueadas até a renovação do período ou uma mudança de plano. Falhas terminais liberam a reserva de uso."], ["Posso trocar de plano?", "A assinatura é gerenciada pelo portal de cobrança. Condições e efeitos da alteração são apresentados antes da confirmação."], ["Uma tentativa repetida consome novamente?", "Retentativas internas não consomem nova cota. Um reprocessamento solicitado pelo usuário cria uma nova conversão e um novo evento de uso."]].map(([question, answer]) => <details className="group py-5" key={question}><summary className="flex cursor-pointer list-none justify-between font-heading font-bold">{question}<span className="text-uno-red group-open:rotate-45">+</span></summary><p className="pt-4 text-sm leading-6 text-zinc-500">{answer}</p></details>)}</div></div></section>
    </PublicPage>
  );
}
