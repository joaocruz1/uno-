import type { Metadata } from "next";
import Link from "next/link";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { PublicPage } from "@/components";
import { getPlanCatalog } from "@/lib/plans";

export const metadata: Metadata = { title: "Documentação", description: "Referência da API v1 da UNO para conversões, lotes, uso e webhooks." };

const curlExample = `curl -X POST https://api.seudominio.com/api/v1/conversions \\
  -H "Authorization: Bearer $UNO_API_KEY" \\
  -H "Idempotency-Key: pedido-sintetico-001-v1" \\
  -F "file=@etiqueta.pdf" \\
  -F "size=100x150"`;

const javascriptExample = `// Execute no serviço do ERP, com a chave em um cofre de segredos.
async function convertPdf(file, apiUrl, apiKey, operationKey) {
  const form = new FormData();
  form.append("file", file, "synthetic.pdf");
  form.append("size", "100x150");
  const response = await fetch(\`\${apiUrl}/api/v1/conversions\`, {
    method: "POST",
    headers: {
      Authorization: \`Bearer \${apiKey}\`,
      "Idempotency-Key": operationKey,
    },
    body: form,
  });
  const conversion = await response.json();
  if (!response.ok) throw new Error(conversion.error.code);
  return conversion;
}`;

const nodeExample = `import { openAsBlob } from "node:fs";

const form = new FormData();
form.append("file", await openAsBlob("synthetic.pdf", { type: "application/pdf" }), "synthetic.pdf");
form.append("size", "100x150");

const response = await fetch("https://api.seudominio.com/api/v1/conversions", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.UNO_API_KEY}\`,
    "Idempotency-Key": "pedido-sintetico-001-v1",
  },
  body: form,
});`;

const pythonExample = `import os
import requests

with open("etiqueta.pdf", "rb") as label:
    response = requests.post(
        "https://api.seudominio.com/api/v1/conversions",
        headers={
            "Authorization": f"Bearer {os.environ['UNO_API_KEY']}",
            "Idempotency-Key": "pedido-sintetico-001-v1",
        },
        files={"file": ("etiqueta.pdf", label, "application/pdf")},
        data={"size": "100x150"},
    )

conversion = response.json()`;

const batchExample = `curl --fail-with-body "$UNO_API_URL/api/v1/batches" \\
  -H "Authorization: Bearer $UNO_API_KEY" \\
  -H "Idempotency-Key: lote-sintetico-001-v1" \\
  -F "files=@synthetic-a.pdf;type=application/pdf" \\
  -F "files=@synthetic-b.pdf;type=application/pdf" \\
  -F "size=custom" -F "widthMm=100" -F "heightMm=250"

curl "$UNO_API_URL/api/v1/batches/ID_RETORNADO" \\
  -H "Authorization: Bearer $UNO_API_KEY"
curl "$UNO_API_URL/api/v1/usage" \\
  -H "Authorization: Bearer $UNO_API_KEY"`;

function CodeBlock({ title, children }: { title: string; children: string }) {
  return <div className="overflow-hidden rounded-xl border border-white/10 bg-[#050505]"><div className="border-b border-white/10 px-4 py-3 text-xs text-zinc-500">{title}</div><pre className="overflow-x-auto p-5 text-xs leading-6 text-zinc-300"><code>{children}</code></pre></div>;
}

const errorCodes = [
  ["invalid_request", "400", "Campos ausentes ou inválidos."], ["pdf_encrypted", "422", "O PDF exige senha."], ["file_too_large", "413", "O arquivo excede o limite do plano."], ["unsupported_template", "422", "O template não é reconhecido."], ["ambiguous_template", "422", "A detecção não encontrou uma correspondência segura."], ["format_too_small", "422", "O conteúdo não cabe com legibilidade no tamanho pedido."], ["quota_exceeded", "403", "A organização atingiu a cota mensal."], ["rate_limited", "429", "O limite de requisições foi atingido."],
];

export default function DocsPage() {
  const plans = getPlanCatalog();
  return (
    <PublicPage eyebrow="Documentação da API" title="Integre a UNO em poucos endpoints." intro="A API v1 usa JSON UTF-8, autenticação Bearer e recursos assíncronos. Todas as respostas incluem requestId e os identificadores são opacos.">
      <div className="page-shell grid gap-12 py-16 lg:grid-cols-[220px_1fr]">
        <aside className="hidden lg:block"><nav className="sticky top-28 space-y-1 text-sm" aria-label="Nesta página">{[["Início rápido", "#inicio"], ["Autenticação", "#autenticacao"], ["Exemplos", "#exemplos"], ["Lotes e uso", "#lotes"], ["Estados", "#estados"], ["Webhooks", "#webhooks"], ["Erros", "#erros"], ["Limites", "#limites"]].map(([label, href]) => <Link key={href} href={href} className="block rounded-lg px-3 py-2 text-zinc-500 hover:bg-white/[.04] hover:text-white">{label}</Link>)}</nav></aside>
        <article className="min-w-0 max-w-4xl space-y-20">
          <section id="inicio" className="scroll-mt-28"><p className="section-kicker">Início rápido</p><h2 className="mt-4 font-heading text-4xl font-bold tracking-tight">Crie uma conversão.</h2><p className="mt-5 max-w-2xl leading-7 text-zinc-400">Envie um PDF multipart com uma etiqueta logística e uma DANFE. O servidor reserva a cota e responde com HTTP 202 sem esperar o processamento terminar.</p><div className="mt-8"><CodeBlock title="cURL">{curlExample}</CodeBlock></div><div className="mt-4"><CodeBlock title="202 Accepted">{`{
  "requestId": "req_...",
  "id": "cnv_...",
  "status": "queued",
  "progress": 0,
  "createdAt": "2026-01-01T00:00:00Z"
}`}</CodeBlock></div></section>
          <section id="autenticacao" className="scroll-mt-28"><p className="section-kicker">Autenticação</p><h2 className="mt-4 font-heading text-3xl font-bold">Use uma chave Bearer.</h2><p className="mt-4 leading-7 text-zinc-400">As chaves de API estão disponíveis para organizações Pro e Business. O valor completo aparece uma única vez durante a criação. Guarde-o em um gerenciador de segredos e envie no cabeçalho abaixo.</p><div className="mt-6"><CodeBlock title="Cabeçalho">Authorization: Bearer uno_live_...</CodeBlock></div><div className="mt-5 flex gap-3 border border-amber-400/20 bg-amber-400/[.05] p-4 text-sm leading-6 text-amber-100"><AlertCircle className="mt-0.5 shrink-0" size={18} /><p>Não exponha a chave em código de navegador. Os exemplos com chave Bearer são executados no serviço do ERP. Um navegador deve usar um proxy autenticado no seu próprio backend.</p></div></section>
          <section id="exemplos" className="scroll-mt-28"><p className="section-kicker">Exemplos</p><h2 className="mt-4 font-heading text-3xl font-bold">Escolha a sua stack.</h2><div className="mt-8 space-y-5"><CodeBlock title="JavaScript no serviço do ERP">{javascriptExample}</CodeBlock><CodeBlock title="Node.js 24">{nodeExample}</CodeBlock><CodeBlock title="Python com requests">{pythonExample}</CodeBlock></div></section>
          <section id="lotes" className="scroll-mt-28"><p className="section-kicker">Lotes e uso</p><h2 className="mt-4 font-heading text-3xl font-bold">Uma admissão, vários arquivos.</h2><p className="mt-4 leading-7 text-zinc-400">Envie o campo files repetido. O lote reserva a cota inteira ou rejeita a operação. Consulte o estado até a conclusão da composição do ZIP; o arquivo inclui somente as etiquetas aprovadas, com contadores e erros dos demais itens.</p><div className="mt-6"><CodeBlock title="cURL · lote e cota">{batchExample}</CodeBlock></div><p className="mt-5 text-sm leading-6 text-zinc-500">Use uma combinação de template e tamanho liberada. O formato personalizado aceita largura de 50–210 mm e altura de 50–300 mm, sujeito à composição legível. A resposta de uso inclui periodStart, periodEnd, limit, reserved, confirmed e remaining.</p></section>
          <section id="estados" className="scroll-mt-28"><p className="section-kicker">Ciclo de vida</p><h2 className="mt-4 font-heading text-3xl font-bold">Consulte o estado persistido.</h2><div className="mt-8 grid gap-3 sm:grid-cols-2">{[["queued", "Aceita e aguardando o worker."], ["processing", "A engine está executando uma etapa registrada."], ["completed", "A saída inclui uma URL assinada e expiresAt."], ["failed", "A resposta inclui código e mensagem segura."]].map(([status, text]) => <div className="border border-white/10 p-5" key={status}><code className="text-red-300">{status}</code><p className="mt-3 text-sm leading-6 text-zinc-500">{text}</p></div>)}</div><div className="mt-6"><CodeBlock title="Consultar conversão">GET /api/v1/conversions/cnv_...</CodeBlock></div></section>
          <section id="webhooks" className="scroll-mt-28"><p className="section-kicker">Webhooks</p><h2 className="mt-4 font-heading text-3xl font-bold">Verifique o corpo exato antes de processar.</h2><p className="mt-4 leading-7 text-zinc-400">A UNO envia <code>conversion.completed</code>, <code>conversion.failed</code> e <code>batch.completed</code>. Calcule HMAC-SHA-256 sobre os bytes UTF-8 de <code>&lt;timestamp&gt;.&lt;corpo exato&gt;</code> e compare com <code>X-Label-Signature</code>.</p><div className="mt-6"><CodeBlock title="Cabeçalhos">{`X-Label-Timestamp: 1790812800
X-Label-Delivery: dlv_...
X-Label-Signature: v1=<hex-hmac-sha256>`}</CodeBlock></div><ul className="mt-6 space-y-3 text-sm text-zinc-400">{["Valide a assinatura antes de interpretar o JSON.", "Rejeite timestamps antigos conforme a tolerância da sua aplicação.", "Deduplicate pelo identificador X-Label-Delivery.", "Responda com 2xx somente depois de persistir o evento."].map((item) => <li className="flex gap-3" key={item}><CheckCircle2 className="mt-0.5 shrink-0 text-uno-red" size={17} />{item}</li>)}</ul><p className="mt-6 text-sm text-zinc-500">Falhas de entrega são repetidas após 1 minuto, 5 minutos, 30 minutos, 2 horas e 12 horas.</p></section>
          <section id="erros" className="scroll-mt-28"><p className="section-kicker">Erros</p><h2 className="mt-4 font-heading text-3xl font-bold">Códigos estáveis para cada decisão.</h2><div className="mt-8 overflow-x-auto border border-white/10"><table className="w-full min-w-[620px] text-left text-sm"><thead className="border-b border-white/10 text-zinc-500"><tr><th className="p-4 font-medium">Código</th><th className="p-4 font-medium">HTTP</th><th className="p-4 font-medium">Significado</th></tr></thead><tbody>{errorCodes.map(([code, status, description]) => <tr className="border-b border-white/[.06] last:border-0" key={code}><td className="p-4"><code className="text-red-300">{code}</code></td><td className="p-4 text-zinc-300">{status}</td><td className="p-4 text-zinc-500">{description}</td></tr>)}</tbody></table></div><div className="mt-5"><CodeBlock title="Envelope de erro">{`{
  "requestId": "req_...",
  "error": {
    "code": "unsupported_template",
    "message": "The PDF does not match the selected template."
  }
}`}</CodeBlock></div></section>
          <section id="limites" className="scroll-mt-28"><p className="section-kicker">Limites</p><h2 className="mt-4 font-heading text-3xl font-bold">Limite por organização.</h2><p className="mt-4 leading-7 text-zinc-400">Pro aceita {plans.PRO.rateLimit} requisições por minuto e Business aceita {plans.BUSINESS.rateLimit}. Uma resposta 429 inclui o cabeçalho <code>Retry-After</code>. O tamanho de arquivo, lote e retenção seguem o plano ativo.</p><p id="status" className="mt-5 text-sm text-zinc-500">Disponibilidade operacional e incidentes devem ser publicados no endereço de status configurado para o ambiente.</p></section>
        </article>
      </div>
    </PublicPage>
  );
}
