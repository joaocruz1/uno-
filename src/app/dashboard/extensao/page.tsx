import { ExtensionPanel } from "@/components/extension/extension-panel";

const STEPS = [
  "Instale a extensão UNO no Chrome, Edge, Brave ou Opera.",
  "Clique no ícone da UNO na barra do navegador e em Conectar.",
  "Baixe as etiquetas no Mercado Livre, Shopee ou TikTok Shop como sempre.",
  "A UNO troca o download pela etiqueta 10×15 pronta. Se algo falhar, o arquivo original é baixado.",
];

export default function ExtensionPage() {
  const storeUrl = process.env.UNO_EXTENSION_STORE_URL;
  return <div className="mx-auto max-w-5xl">
    <p className="text-sm font-semibold text-uno-red">Mercado Livre · Shopee · TikTok Shop</p>
    <h1 className="mt-2 font-heading text-3xl font-bold">Extensão do navegador</h1>
    <p className="mt-3 text-[var(--color-muted)]">Converta as etiquetas no próprio painel do marketplace, sem subir arquivo.</p>
    <section className="mt-8 rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
      <h2 className="font-heading text-xl font-semibold">Como funciona</h2>
      <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-[var(--color-muted)]">{STEPS.map(step => <li key={step}>{step}</li>)}</ol>
      {storeUrl ? <a href={storeUrl} target="_blank" rel="noreferrer" className="mt-5 inline-block text-sm text-uno-red underline">Instalar a extensão</a> : <p className="mt-5 text-sm text-[var(--color-muted)]">A extensão está chegando à Chrome Web Store.</p>}
      <p className="mt-4 text-xs text-[var(--color-muted)]">Mercado Livre usa a cota do plano (uma etiqueta por pedido). Shopee, TikTok Shop e Full ML seguem como no lote do painel.</p>
    </section>
    <ExtensionPanel/>
  </div>;
}
