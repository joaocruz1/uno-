import Link from "next/link";
import { ArrowRight, Boxes, Braces, FileCheck2, Files, Fingerprint, History, Layers3, LockKeyhole, ScanLine, ShieldCheck, Sparkles } from "lucide-react";
import { Footer, Navbar } from "@/components";
import { ApiTerminal, BeforeAfter, MergeDemo, PricingGrid } from "@/components/marketing";
import { Badge, ButtonLink, Card } from "@/components/ui";

const steps = [
  { number: "01", title: "Envie", description: "Faça upload do PDF original com a etiqueta e a DANFE." },
  { number: "02", title: "Processamos", description: "A engine identifica o template e reorganiza as duas páginas." },
  { number: "03", title: "Imprima", description: "Baixe uma única página no formato escolhido para impressão." },
];

const features = [
  { icon: Layers3, title: "Unificação automática", text: "Transforma a etiqueta logística e a DANFE em uma composição única.", className: "md:col-span-2" },
  { icon: Files, title: "Processamento em lote", text: "Envie vários PDFs e baixe os resultados concluídos em ZIP.", className: "" },
  { icon: Braces, title: "API para integrações", text: "Conecte ERP, e-commerce ou sistema logístico com uma API assíncrona.", className: "" },
  { icon: ScanLine, title: "Códigos preservados", text: "O fluxo mantém proporções, áreas de silêncio e conteúdo original dos códigos.", className: "md:col-span-2" },
  { icon: History, title: "Histórico", text: "Localize e baixe resultados durante a retenção do seu plano.", className: "" },
  { icon: Boxes, title: "Templates versionados", text: "Mercado Livre é o primeiro template. Novos layouts passam por validação antes da liberação.", className: "" },
];

const faqs = [
  ["Quais arquivos são aceitos?", "A primeira versão recebe um PDF com duas páginas: uma etiqueta logística e uma DANFE simplificada. PDFs corrompidos, protegidos por senha, ambíguos ou de template ainda não liberado são recusados com uma mensagem específica."],
  ["Quais formatos de saída existem?", "O formato padrão é 100 × 150 mm. Também estão previstos 100 × 100 mm, A6 e tamanhos personalizados entre 50–210 mm de largura e 50–300 mm de altura."],
  ["O conteúdo fiscal é reescrito?", "Não. A composição preserva as regiões do PDF original. Em documentos escaneados, o reconhecimento de texto serve apenas para localizar áreas; ele não reconstrói conteúdo fiscal."],
  ["A API está disponível em todos os planos?", "A API e os webhooks estão disponíveis nos planos Pro e Business. As chaves são exibidas uma única vez e usadas como credenciais Bearer."],
  ["O que acontece se a etiqueta não couber?", "A conversão é bloqueada para evitar perda de legibilidade e indica um formato maior quando houver uma alternativa compatível."],
];

export default function Home() {
  return (
    <main>
      <Navbar />
      <section className="hero-grid overflow-hidden pb-20 pt-36 sm:pt-44">
        <div className="page-shell grid items-center gap-14 lg:grid-cols-[.9fr_1.1fr]">
          <div className="relative z-10">
            <Badge><Sparkles size={13} />Automatize suas etiquetas</Badge>
            <h1 className="mt-7 font-heading text-[clamp(2.65rem,11.5vw,5.5rem)] font-extrabold uppercase leading-[.9] tracking-[-.045em] [word-spacing:.04em] sm:text-[clamp(3rem,5vw,5.5rem)]">
              <span className="block whitespace-nowrap">Duas páginas.</span>
              <span className="mt-2 block whitespace-nowrap text-uno-red">Uma etiqueta.</span>
            </h1>
            <p className="mt-8 max-w-xl text-base leading-7 text-zinc-400 sm:text-lg">Transforme etiquetas e DANFEs de duas páginas em uma única composição pronta para o seu fluxo de impressão.</p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row"><ButtonLink href="/register" size="lg">Unir minha etiqueta <ArrowRight size={17} /></ButtonLink><ButtonLink href="#como-funciona" variant="secondary" size="lg">Ver como funciona</ButtonLink></div>
            <p className="mt-5 text-xs text-zinc-600">Comece com 10 etiquetas por mês no plano Free.</p>
          </div>
          <MergeDemo />
        </div>
      </section>

      <section id="produto" className="section-space border-y border-white/[.06] bg-[#030303]">
        <div className="page-shell grid gap-12 lg:grid-cols-[.72fr_1.28fr] lg:items-center">
          <div><p className="section-kicker">Veja a mudança</p><h2 className="section-title mt-4">O que ocupava duas folhas passa a caber em uma etiqueta.</h2><p className="section-copy mt-5">Compare a entrada e a saída com um exemplo inteiramente sintético. O layout remove espaço interno desnecessário e preserva os blocos operacionais e fiscais.</p></div>
          <BeforeAfter />
        </div>
      </section>

      <section id="como-funciona" className="section-space">
        <div className="page-shell"><div className="max-w-2xl"><p className="section-kicker">Como funciona</p><h2 className="section-title mt-4">Do arquivo à impressão em três movimentos.</h2></div><div className="mt-14 grid border-y border-white/10 md:grid-cols-3">{steps.map((step, index) => <div key={step.number} className={`relative px-1 py-9 md:px-8 ${index > 0 ? "border-t border-white/10 md:border-l md:border-t-0" : ""}`}><span className="font-heading text-sm font-bold text-uno-red">{step.number}</span><h3 className="mt-10 font-heading text-2xl font-bold">{step.title}</h3><p className="mt-3 max-w-xs text-sm leading-6 text-zinc-500">{step.description}</p></div>)}</div></div>
      </section>

      <section className="section-space border-y border-white/[.06] bg-[#030303]">
        <div className="page-shell grid gap-10 lg:grid-cols-3">
          <div className="lg:col-span-1"><p className="section-kicker">Feito para a operação</p><h2 className="section-title mt-4">Menos etapas entre receber o pedido e colar a etiqueta.</h2></div>
          <div className="grid gap-px bg-white/10 lg:col-span-2 sm:grid-cols-2">
            {[[FileCheck2, "Composição fiel", "O conteúdo original continua sendo a fonte da etiqueta final."], [ScanLine, "Tamanhos controlados", "Saídas em dimensões físicas explícitas, sem distorcer o conteúdo."], [ShieldCheck, "Falhas visíveis", "Arquivos incompatíveis param com um motivo claro, sem composição por tentativa."], [Fingerprint, "Rastreabilidade", "Versões do template e da engine acompanham cada conversão."]].map(([Icon, title, text]) => { const ItemIcon = Icon as typeof FileCheck2; return <div key={String(title)} className="bg-[#030303] p-7"><ItemIcon className="text-uno-red" size={22} /><h3 className="mt-7 font-heading text-lg font-bold">{String(title)}</h3><p className="mt-2 text-sm leading-6 text-zinc-500">{String(text)}</p></div>; })}
          </div>
        </div>
      </section>

      <section className="section-space">
        <div className="page-shell"><div className="max-w-2xl"><p className="section-kicker">Recursos</p><h2 className="section-title mt-4">Uma camada de impressão para todo o fluxo de etiquetas.</h2></div><div className="mt-12 grid gap-4 md:grid-cols-3">{features.map(({ icon: Icon, title, text, className }) => <Card key={title} className={`group min-h-60 p-7 ${className}`}><Icon className="text-uno-red" size={23} /><h3 className="mt-16 font-heading text-xl font-bold">{title}</h3><p className="mt-3 max-w-md text-sm leading-6 text-zinc-500">{text}</p></Card>)}</div></div>
      </section>

      <section className="section-space border-y border-white/[.06] bg-[#030303]">
        <div className="page-shell grid items-center gap-12 lg:grid-cols-2">
          <div><p className="section-kicker">Integração</p><h2 className="section-title mt-4">Envie a etiqueta direto do seu sistema.</h2><p className="section-copy mt-5">A API recebe a conversão de forma assíncrona. Consulte o estado ou receba um webhook assinado quando o processamento terminar.</p><ButtonLink href="/docs" variant="secondary" className="mt-8">Abrir documentação <ArrowRight size={16} /></ButtonLink></div>
          <ApiTerminal />
        </div>
      </section>

      <section className="section-space overflow-hidden">
        <div className="page-shell grid items-center gap-14 lg:grid-cols-2">
          <div className="relative min-h-96">
            <div className="absolute left-0 top-10 w-[72%] border border-white/10 bg-[#080808] p-5 shadow-2xl">
              <div className="flex justify-between text-xs">
                <span>LOTE DE EXEMPLO</span>
                <span className="text-zinc-500">37 / 50</span>
              </div>
              <div className="mt-4 h-1 overflow-hidden bg-white/10"><div className="h-full w-[74%] bg-uno-red" /></div>
              <div className="mt-8 space-y-3">
                {["pedido-demo-001.pdf", "pedido-demo-002.pdf", "pedido-demo-003.pdf"].map((name, index) => (
                  <div key={name} className="flex items-center justify-between border-t border-white/[.07] py-3 text-xs">
                    <span className="text-zinc-300">{name}</span>
                    <span className={index < 2 ? "text-red-300" : "text-zinc-600"}>{index < 2 ? "Concluído" : "Processando"}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="absolute bottom-0 right-0 w-48 border border-uno-red/40 bg-[#0b0506] p-5 shadow-[0_20px_70px_rgba(239,35,60,.18)]">
              <p className="text-xs text-red-300">Saída do lote</p>
              <p className="mt-6 font-heading text-3xl font-extrabold">ZIP</p>
              <p className="mt-2 text-xs leading-5 text-zinc-500">Resultados concluídos reunidos para download.</p>
            </div>
          </div>
          <div><p className="section-kicker">Processamento em lote</p><h2 className="section-title mt-4">Muitos pedidos entram. Um fluxo organizado sai.</h2><p className="section-copy mt-5">Envie um conjunto de PDFs, acompanhe o progresso persistido de cada item e reúna as saídas concluídas em um arquivo ZIP.</p></div>
        </div>
      </section>

      <section id="seguranca" className="section-space border-y border-white/[.06] bg-[#030303]">
        <div className="page-shell grid gap-10 lg:grid-cols-[.8fr_1.2fr]"><div><LockKeyhole className="text-uno-red" size={30} /><h2 className="section-title mt-6">Seus documentos ficam privados.</h2></div><div className="grid gap-8 sm:grid-cols-2"><div><h3 className="font-heading font-bold">Acesso temporário</h3><p className="mt-3 text-sm leading-6 text-zinc-500">Arquivos de entrada e saída ficam privados. Downloads usam links assinados com expiração.</p></div><div><h3 className="font-heading font-bold">Retenção por plano</h3><p className="mt-3 text-sm leading-6 text-zinc-500">Os artefatos são removidos de acordo com o período de retenção da organização.</p></div><div><h3 className="font-heading font-bold">Conteúdo fora da telemetria</h3><p className="mt-3 text-sm leading-6 text-zinc-500">Bytes dos documentos e dados fiscais extraídos não entram em logs ou eventos de produto.</p></div><div><h3 className="font-heading font-bold">Organizações isoladas</h3><p className="mt-3 text-sm leading-6 text-zinc-500">Registros, objetos, chaves e uso são sempre limitados à organização autorizada.</p></div></div></div>
      </section>

      <section id="precos" className="section-space">
        <div className="page-shell"><div className="mx-auto max-w-2xl text-center"><p className="section-kicker">Planos</p><h2 className="section-title mt-4">Comece pequeno. Aumente quando a operação pedir.</h2><p className="section-copy mx-auto mt-5">Sem cobrança automática por excedente e sem marca d&apos;água.</p></div><div className="mt-12"><PricingGrid compact /></div><div className="mt-8 text-center"><Link href="/pricing" className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-300 hover:text-white">Comparar todos os recursos <ArrowRight size={15} /></Link></div></div>
      </section>

      <section className="section-space border-y border-white/[.06] bg-[#030303]">
        <div className="page-shell grid gap-12 lg:grid-cols-[.72fr_1.28fr]"><div><p className="section-kicker">Perguntas frequentes</p><h2 className="section-title mt-4">O que você precisa saber antes do primeiro envio.</h2></div><div className="divide-y divide-white/10 border-y border-white/10">{faqs.map(([question, answer]) => <details key={question} className="group py-5"><summary className="flex cursor-pointer list-none items-center justify-between gap-6 font-heading font-semibold"><span>{question}</span><span className="text-xl text-uno-red transition-transform group-open:rotate-45">+</span></summary><p className="max-w-2xl pt-4 text-sm leading-6 text-zinc-500">{answer}</p></details>)}</div></div>
      </section>

      <section className="overflow-hidden py-24"><div className="page-shell"><div className="relative border border-uno-red/30 bg-[#0b0304] px-6 py-16 text-center sm:px-12"><div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_120%,rgba(239,35,60,.28),transparent_55%)]" /><div className="relative"><h2 className="font-heading text-4xl font-extrabold tracking-[-.05em] sm:text-6xl">Duas páginas esperando para virar uma?</h2><p className="mx-auto mt-5 max-w-xl text-zinc-400">Crie sua conta e processe as primeiras etiquetas no plano Free.</p><ButtonLink href="/register" size="lg" className="mt-8">Começar agora <ArrowRight size={17} /></ButtonLink></div></div></div></section>
      <Footer />
    </main>
  );
}
