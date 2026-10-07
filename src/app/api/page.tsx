import type { Metadata } from "next";
import { ArrowRight, BellRing, KeyRound, RotateCw, ShieldCheck } from "lucide-react";
import { PublicPage } from "@/components";
import { ApiTerminal } from "@/components/marketing";
import { ButtonLink, Card } from "@/components/ui";

export const metadata: Metadata = { title: "API", description: "Integre conversões de etiquetas ao seu ERP ou sistema logístico com a API UNO." };

export default function ApiPage() {
  return (
    <PublicPage eyebrow="API para integrações" title="A conversão entra no seu sistema sem mudar o seu fluxo." intro="Crie conversões e lotes, consulte o estado persistido e receba eventos assinados quando o trabalho terminar. Disponível nos planos Pro e Business.">
      <section className="section-space"><div className="page-shell grid items-center gap-12 lg:grid-cols-2"><div><h2 className="section-title">Uma requisição para começar.</h2><p className="section-copy mt-5">Envie o PDF em multipart, informe uma chave de idempotência e receba um recurso assíncrono para acompanhar.</p><div className="mt-8 flex gap-3"><ButtonLink href="/docs">Ler documentação <ArrowRight size={16} /></ButtonLink><ButtonLink href="/register?plan=pro" variant="secondary">Criar conta</ButtonLink></div></div><ApiTerminal /></div></section>
      <section className="section-space border-y border-white/[.06] bg-[#030303]"><div className="page-shell grid gap-4 md:grid-cols-2 lg:grid-cols-4">{[[KeyRound, "Chaves protegidas", "O segredo é exibido uma vez e armazenado somente como hash."], [RotateCw, "Idempotência", "A mesma operação pode ser repetida sem criar uma conversão duplicada."], [BellRing, "Webhooks assinados", "Eventos de conclusão e falha usam assinatura HMAC-SHA-256."], [ShieldCheck, "Escopo por organização", "Recursos e limites pertencem à organização autenticada."]].map(([Icon, title, text]) => { const ItemIcon = Icon as typeof KeyRound; return <Card className="p-6" key={String(title)}><ItemIcon className="text-uno-red" size={22} /><h3 className="mt-10 font-heading text-lg font-bold">{String(title)}</h3><p className="mt-3 text-sm leading-6 text-zinc-500">{String(text)}</p></Card>; })}</div></section>
      <section className="section-space"><div className="page-shell"><p className="section-kicker">Contrato v1</p><h2 className="section-title mt-4">Recursos previsíveis, falhas explícitas.</h2><div className="mt-12 grid gap-px bg-white/10 md:grid-cols-3"><div className="bg-black p-7"><p className="font-heading text-xl font-bold">Conversões</p><code className="mt-5 block text-sm text-red-300">POST /api/v1/conversions</code><code className="mt-2 block text-sm text-zinc-500">GET /api/v1/conversions/:id</code></div><div className="bg-black p-7"><p className="font-heading text-xl font-bold">Lotes</p><code className="mt-5 block text-sm text-red-300">POST /api/v1/batches</code><code className="mt-2 block text-sm text-zinc-500">GET /api/v1/batches/:id</code></div><div className="bg-black p-7"><p className="font-heading text-xl font-bold">Uso</p><code className="mt-5 block text-sm text-red-300">GET /api/v1/usage</code><p className="mt-2 text-sm text-zinc-500">Limite, reservado, confirmado e restante.</p></div></div></div></section>
    </PublicPage>
  );
}
