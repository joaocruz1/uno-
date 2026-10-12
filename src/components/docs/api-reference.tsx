"use client";

import Link from "next/link";
import Image from "next/image";
import { Check, ChevronRight, Copy, Download, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type Lang = "curl" | "node" | "python";
const LANGS: { id: Lang; label: string }[] = [
  { id: "curl", label: "cURL" },
  { id: "node", label: "Node.js" },
  { id: "python", label: "Python" },
];

type Method = "POST" | "GET";
const METHOD_STYLE: Record<Method, string> = {
  POST: "text-emerald-400",
  GET: "text-sky-400",
};

type NavItem = { id: string; label: string; method?: Method };
type NavGroup = { label: string; items: NavItem[] };

const NAV: NavGroup[] = [
  { label: "", items: [{ id: "introducao", label: "Introdução" }, { id: "autenticacao", label: "Autenticação" }] },
  { label: "Conversões", items: [{ id: "conversions-create", label: "Criar conversão", method: "POST" }, { id: "conversions-get", label: "Consultar conversão", method: "GET" }] },
  { label: "Lotes", items: [{ id: "batches-create", label: "Criar lote", method: "POST" }, { id: "batches-get", label: "Consultar lote", method: "GET" }] },
  { label: "", items: [{ id: "usage", label: "Uso", method: "GET" }, { id: "webhooks", label: "Webhooks" }, { id: "erros", label: "Erros" }, { id: "limites", label: "Limites" }] },
];

const SAMPLES = {
  conversionsCreate: {
    curl: `curl --fail-with-body "$UNO_API_URL/api/v1/conversions" \\
  -H "Authorization: Bearer $UNO_API_KEY" \\
  -H "Idempotency-Key: pedido-001-v1" \\
  -F "file=@etiqueta.pdf;type=application/pdf" \\
  -F "size=100x150"`,
    node: `import { openAsBlob } from "node:fs";
const body = new FormData();
body.append("file", await openAsBlob("etiqueta.pdf", { type: "application/pdf" }), "etiqueta.pdf");
body.append("size", "100x150");

const res = await fetch(\`\${process.env.UNO_API_URL}/api/v1/conversions\`, {
  method: "POST", body,
  headers: {
    Authorization: \`Bearer \${process.env.UNO_API_KEY}\`,
    "Idempotency-Key": "pedido-001-v1",
  },
});
const conversion = await res.json(); // HTTP 202`,
    python: `import os, requests

with open("etiqueta.pdf", "rb") as label:
    res = requests.post(
        f"{os.environ['UNO_API_URL']}/api/v1/conversions",
        headers={
            "Authorization": f"Bearer {os.environ['UNO_API_KEY']}",
            "Idempotency-Key": "pedido-001-v1",
        },
        files={"file": ("etiqueta.pdf", label, "application/pdf")},
        data={"size": "100x150"},
    )
conversion = res.json()`,
  },
  conversionsGet: {
    curl: `curl "$UNO_API_URL/api/v1/conversions/cnv_123" \\
  -H "Authorization: Bearer $UNO_API_KEY"`,
    node: `const res = await fetch(\`\${process.env.UNO_API_URL}/api/v1/conversions/cnv_123\`, {
  headers: { Authorization: \`Bearer \${process.env.UNO_API_KEY}\` },
});
const conversion = await res.json();`,
    python: `import os, requests
res = requests.get(
    f"{os.environ['UNO_API_URL']}/api/v1/conversions/cnv_123",
    headers={"Authorization": f"Bearer {os.environ['UNO_API_KEY']}"},
)
conversion = res.json()`,
  },
  batchesCreate: {
    curl: `curl --fail-with-body "$UNO_API_URL/api/v1/batches" \\
  -H "Authorization: Bearer $UNO_API_KEY" \\
  -H "Idempotency-Key: lote-001-v1" \\
  -F "files=@a.pdf;type=application/pdf" \\
  -F "files=@b.pdf;type=application/pdf" \\
  -F "size=100x150"`,
    node: `const body = new FormData();
for (const name of ["a.pdf", "b.pdf"])
  body.append("files", await openAsBlob(name, { type: "application/pdf" }), name);
body.append("size", "100x150");

const res = await fetch(\`\${process.env.UNO_API_URL}/api/v1/batches\`, {
  method: "POST", body,
  headers: {
    Authorization: \`Bearer \${process.env.UNO_API_KEY}\`,
    "Idempotency-Key": "lote-001-v1",
  },
});`,
    python: `import os, requests
files = [("files", (n, open(n, "rb"), "application/pdf")) for n in ("a.pdf", "b.pdf")]
res = requests.post(
    f"{os.environ['UNO_API_URL']}/api/v1/batches",
    headers={"Authorization": f"Bearer {os.environ['UNO_API_KEY']}", "Idempotency-Key": "lote-001-v1"},
    files=files, data={"size": "100x150"},
)`,
  },
  batchesGet: {
    curl: `curl "$UNO_API_URL/api/v1/batches/bat_123" \\
  -H "Authorization: Bearer $UNO_API_KEY"`,
    node: `const res = await fetch(\`\${process.env.UNO_API_URL}/api/v1/batches/bat_123\`, {
  headers: { Authorization: \`Bearer \${process.env.UNO_API_KEY}\` },
});`,
    python: `res = requests.get(
    f"{os.environ['UNO_API_URL']}/api/v1/batches/bat_123",
    headers={"Authorization": f"Bearer {os.environ['UNO_API_KEY']}"},
)`,
  },
  usage: {
    curl: `curl "$UNO_API_URL/api/v1/usage" \\
  -H "Authorization: Bearer $UNO_API_KEY"`,
    node: `const res = await fetch(\`\${process.env.UNO_API_URL}/api/v1/usage\`, {
  headers: { Authorization: \`Bearer \${process.env.UNO_API_KEY}\` },
});
const usage = await res.json();`,
    python: `res = requests.get(
    f"{os.environ['UNO_API_URL']}/api/v1/usage",
    headers={"Authorization": f"Bearer {os.environ['UNO_API_KEY']}"},
)`,
  },
};

function useCopy() {
  const [copied, setCopied] = useState(false);
  return {
    copied,
    copy: (text: string) => {
      navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }, () => undefined);
    },
  };
}

function MethodBadge({ method }: { method: Method }) {
  return <span className={`shrink-0 font-mono text-[10px] font-bold tracking-wide ${METHOD_STYLE[method]}`}>{method}</span>;
}

function CopyButton({ text }: { text: string }) {
  const { copied, copy } = useCopy();
  return (
    <button type="button" onClick={() => copy(text)} className="grid size-7 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200" aria-label="Copiar">
      {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
    </button>
  );
}

/** The right-hand request panel: language tabs + request sample + response. */
function RequestPanel({ method, path, samples, lang, setLang, response }: {
  method: Method; path: string; samples: Record<Lang, string>; lang: Lang; setLang: (l: Lang) => void; response?: string;
}) {
  return (
    <div className="lg:sticky lg:top-6 space-y-3">
      <div className="overflow-hidden rounded-xl border border-white/10 bg-[#0b0b0d]">
        <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
          <MethodBadge method={method} />
          <span className="truncate font-mono text-xs text-zinc-300">{path}</span>
        </div>
        <div className="flex items-center justify-between gap-2 border-b border-white/[.07] px-2 py-1.5">
          <div className="flex gap-1">
            {LANGS.map((entry) => (
              <button key={entry.id} type="button" onClick={() => setLang(entry.id)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${lang === entry.id ? "bg-white/10 text-white" : "text-zinc-500 hover:text-zinc-300"}`}>
                {entry.label}
              </button>
            ))}
          </div>
          <CopyButton text={samples[lang]} />
        </div>
        <pre className="overflow-x-auto p-4 text-[12px] leading-[1.7] text-zinc-300"><code>{samples[lang]}</code></pre>
      </div>
      {response ? (
        <div className="overflow-hidden rounded-xl border border-white/10 bg-[#0b0b0d]">
          <div className="border-b border-white/10 px-3 py-2 text-[11px] text-zinc-500">Resposta</div>
          <pre className="overflow-x-auto p-4 text-[12px] leading-[1.7] text-zinc-300"><code>{response}</code></pre>
        </div>
      ) : null}
    </div>
  );
}

/** One endpoint: method+path header and prose on the left, request panel on the right. */
function Endpoint({ id, method, path, title, children, samples, response, lang, setLang }: {
  id: string; method: Method; path: string; title: string; children: React.ReactNode;
  samples: Record<Lang, string>; response?: string; lang: Lang; setLang: (l: Lang) => void;
}) {
  return (
    <section id={id} className="scroll-mt-6 border-t border-white/[.07] pt-12 lg:grid lg:grid-cols-[1fr_minmax(0,430px)] lg:gap-12">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className={`rounded-md border px-2 py-0.5 font-mono text-[11px] font-bold ${method === "POST" ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-400" : "border-sky-400/30 bg-sky-400/10 text-sky-400"}`}>{method}</span>
          <code className="font-mono text-sm text-zinc-200">{path}</code>
        </div>
        <h2 className="mt-4 font-heading text-2xl font-bold tracking-tight text-white">{title}</h2>
        <div className="mt-4 space-y-4 text-[15px] leading-7 text-zinc-400">{children}</div>
      </div>
      <div className="mt-6 lg:mt-0">
        <RequestPanel method={method} path={path} samples={samples} lang={lang} setLang={setLang} response={response} />
      </div>
    </section>
  );
}

function Param({ name, type, required, children }: { name: string; type: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="border-t border-white/[.06] py-3 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <code className="font-mono text-sm text-zinc-200">{name}</code>
        <span className="font-mono text-xs text-zinc-500">{type}</span>
        {required ? <span className="text-[10px] font-semibold uppercase tracking-wide text-uno-red">obrigatório</span> : <span className="text-[10px] text-zinc-600">opcional</span>}
      </div>
      <p className="mt-1 text-sm leading-6 text-zinc-500">{children}</p>
    </div>
  );
}

export function ApiReference({ rates }: { rates: { STARTER: number; PRO: number; BUSINESS: number } }) {
  const [lang, setLang] = useState<Lang>("curl");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState("introducao");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return NAV;
    return NAV.map((group) => ({ ...group, items: group.items.filter((item) => item.label.toLowerCase().includes(q)) })).filter((group) => group.items.length > 0);
  }, [query]);

  useEffect(() => {
    const ids = NAV.flatMap((group) => group.items.map((item) => item.id));
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActive(visible[0].target.id);
      },
      { rootMargin: "-10% 0px -70% 0px", threshold: 0 },
    );
    for (const id of ids) { const el = document.getElementById(id); if (el) observer.observe(el); }
    return () => observer.disconnect();
  }, []);

  return (
    <div className="min-h-screen bg-[#070708] text-zinc-300 [background-image:radial-gradient(circle_at_1px_1px,rgba(255,255,255,.05)_1px,transparent_0)] [background-size:28px_28px]">
      <div className="mx-auto flex max-w-[1500px]">
        {/* Sidebar */}
        <aside className="sticky top-0 hidden h-screen w-[270px] shrink-0 flex-col border-r border-white/[.07] bg-[#070708]/80 backdrop-blur lg:flex">
          <div className="flex items-center gap-2.5 px-5 py-4">
            <Image src="/uno-icon.png" width={24} height={24} alt="" />
            <span className="font-heading text-sm font-extrabold tracking-tight text-white">UNO</span>
            <span className="rounded-md bg-white/[.06] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">API v1</span>
          </div>
          <div className="px-4 pb-3">
            <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[.03] px-2.5 py-2">
              <Search size={14} className="text-zinc-500" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar" className="w-full bg-transparent text-sm text-white placeholder:text-zinc-600 outline-none" aria-label="Buscar na documentação" />
            </div>
          </div>
          <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-6" aria-label="Documentação">
            {groups.map((group, index) => (
              <div key={group.label || index}>
                {group.label ? <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-600">{group.label}</p> : null}
                <div className="space-y-0.5">
                  {group.items.map((item) => (
                    <a key={item.id} href={`#${item.id}`} aria-current={active === item.id ? "true" : undefined}
                      className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${active === item.id ? "bg-uno-red/10 text-white" : "text-zinc-400 hover:bg-white/[.04] hover:text-zinc-200"}`}>
                      {item.method ? <MethodBadge method={item.method} /> : <span className="w-[26px]" />}
                      <span className="truncate">{item.label}</span>
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </nav>
          <div className="border-t border-white/[.07] px-4 py-3">
            <Link href="/" className="flex items-center gap-1.5 text-xs text-zinc-500 transition-colors hover:text-zinc-300">Voltar ao site <ChevronRight size={13} /></Link>
          </div>
        </aside>

        {/* Content */}
        <main className="min-w-0 flex-1 px-5 py-10 sm:px-10 lg:px-14">
          <div className="mx-auto max-w-[1050px]">
            <section id="introducao" className="scroll-mt-6 lg:grid lg:grid-cols-[1fr_minmax(0,430px)] lg:gap-12">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-white/[.06] px-2 py-0.5 font-mono text-[11px] text-zinc-300">v1.0.0</span>
                  <span className="rounded-md bg-white/[.06] px-2 py-0.5 font-mono text-[11px] text-zinc-400">OpenAPI 3.1.0</span>
                </div>
                <h1 className="mt-4 font-heading text-4xl font-extrabold tracking-tight text-white">UNO API</h1>
                <a href="/openapi.json" download className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-uno-red hover:underline"><Download size={15} />Baixar documento OpenAPI</a>
                <p className="mt-5 text-[15px] leading-7 text-zinc-400">Converta o PDF de duas páginas (etiqueta logística + DANFE) em uma etiqueta 100×150 mm pronta para a térmica. A API é <span className="text-zinc-200">assíncrona</span>, usa JSON UTF-8 e autenticação Bearer, com idempotência e webhooks assinados. Toda resposta traz <code className="rounded bg-white/[.06] px-1 py-0.5 font-mono text-[13px] text-zinc-200">requestId</code>.</p>
              </div>
              <div className="mt-6 lg:mt-0 lg:sticky lg:top-6 space-y-3">
                <div className="overflow-hidden rounded-xl border border-white/10 bg-[#0b0b0d]">
                  <div className="border-b border-white/10 px-3 py-2 text-[11px] text-zinc-500">Servidor</div>
                  <div className="px-3 py-2.5 font-mono text-xs text-zinc-300">https://api-nextpy-uno.1nwz76.easypanel.host</div>
                </div>
                <div className="overflow-hidden rounded-xl border border-white/10 bg-[#0b0b0d]">
                  <div className="border-b border-white/10 px-3 py-2 text-[11px] text-zinc-500">Autenticação</div>
                  <div className="px-3 py-2.5 font-mono text-xs text-zinc-300">Authorization: Bearer <span className="text-uno-red">uno_live_…</span></div>
                </div>
              </div>
            </section>

            <section id="autenticacao" className="mt-12 scroll-mt-6 border-t border-white/[.07] pt-12">
              <h2 className="font-heading text-2xl font-bold tracking-tight text-white">Autenticação</h2>
              <p className="mt-4 max-w-2xl text-[15px] leading-7 text-zinc-400">As chaves de API ficam disponíveis com o adicional <span className="text-zinc-200">+ API</span>, contratado sobre qualquer plano pago. A chave aparece uma única vez na criação — guarde-a no cofre de segredos do ERP e envie no cabeçalho <code className="rounded bg-white/[.06] px-1 py-0.5 font-mono text-[13px] text-zinc-200">Authorization</code>. Sem o adicional ou sem um plano pago vigente, as chamadas respondem <code className="rounded bg-white/[.06] px-1 py-0.5 font-mono text-[13px] text-zinc-200">403</code>.</p>
              <div className="mt-5 flex max-w-2xl gap-3 rounded-xl border border-amber-400/20 bg-amber-400/[.05] p-4 text-sm leading-6 text-amber-100/90">
                <span>Nunca exponha a chave em código de navegador. Os exemplos com Bearer rodam no servidor do ERP; um navegador deve passar por um proxy autenticado no seu próprio backend.</span>
              </div>
            </section>

            <Endpoint id="conversions-create" method="POST" path="/api/v1/conversions" title="Criar uma conversão"
              samples={SAMPLES.conversionsCreate} lang={lang} setLang={setLang}
              response={`{
  "requestId": "req_…",
  "id": "cnv_…",
  "status": "queued",
  "progress": 0,
  "createdAt": "2026-01-01T00:00:00Z"
}`}>
              <p>Envie um PDF multipart com uma etiqueta logística e uma DANFE. O servidor reserva a cota e responde <span className="text-zinc-200">202</span> sem esperar o processamento terminar.</p>
              <div className="rounded-xl border border-white/[.07] bg-white/[.02] p-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Corpo · multipart/form-data</p>
                <Param name="file" type="binary" required>PDF de duas páginas (etiqueta + DANFE).</Param>
                <Param name="size" type="string" required>100x150, 100x100, a6 ou custom.</Param>
                <Param name="widthMm" type="number">Largura 50–210, quando size=custom.</Param>
                <Param name="heightMm" type="number">Altura 50–300, quando size=custom.</Param>
                <Param name="Idempotency-Key" type="header" required>Repetir a mesma chave retorna o mesmo resultado.</Param>
              </div>
            </Endpoint>

            <Endpoint id="conversions-get" method="GET" path="/api/v1/conversions/{id}" title="Consultar uma conversão"
              samples={SAMPLES.conversionsGet} lang={lang} setLang={setLang}
              response={`{
  "id": "cnv_…",
  "status": "completed",
  "downloadUrl": "https://…",
  "expiresAt": "2026-01-01T01:00:00Z"
}`}>
              <p>Uma etiqueta digital fica pronta em cerca de um segundo após o <span className="text-zinc-200">202</span>. Comece o polling 500&nbsp;ms depois e repita a cada 500&nbsp;ms–1&nbsp;s até <code className="font-mono text-[13px] text-emerald-400">completed</code> ou <code className="font-mono text-[13px] text-uno-red">failed</code> — ou receba o webhook.</p>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {[["queued", "Aceita, aguardando o worker."], ["processing", "A engine está executando."], ["completed", "Inclui downloadUrl e expiresAt."], ["failed", "Inclui código e mensagem."]].map(([status, text]) => (
                  <div key={status} className="rounded-lg border border-white/[.07] p-3"><code className={`font-mono text-[13px] ${status === "completed" ? "text-emerald-400" : status === "failed" ? "text-uno-red" : "text-zinc-300"}`}>{status}</code><p className="mt-1.5 text-xs leading-5 text-zinc-500">{text}</p></div>
                ))}
              </div>
            </Endpoint>

            <Endpoint id="batches-create" method="POST" path="/api/v1/batches" title="Criar um lote"
              samples={SAMPLES.batchesCreate} lang={lang} setLang={setLang}
              response={`{
  "id": "bat_…",
  "status": "queued",
  "itemCount": 2
}`}>
              <p>Envie o campo <code className="font-mono text-[13px] text-zinc-200">files</code> repetido. O lote reserva a cota inteira ou rejeita a operação; o ZIP final inclui só as etiquetas aprovadas, com os contadores e erros dos demais itens.</p>
            </Endpoint>

            <Endpoint id="batches-get" method="GET" path="/api/v1/batches/{id}" title="Consultar um lote"
              samples={SAMPLES.batchesGet} lang={lang} setLang={setLang}
              response={`{
  "id": "bat_…",
  "status": "completed",
  "completedCount": 2,
  "failedCount": 0,
  "downloadUrl": "https://…"
}`}>
              <p>Consulte o estado até a composição do ZIP terminar. O download é uma URL assinada com expiração.</p>
            </Endpoint>

            <Endpoint id="usage" method="GET" path="/api/v1/usage" title="Consultar o uso"
              samples={SAMPLES.usage} lang={lang} setLang={setLang}
              response={`{
  "periodStart": "2026-01-01T00:00:00Z",
  "periodEnd": "2026-02-01T00:00:00Z",
  "limit": 2000,
  "reserved": 3,
  "confirmed": 180,
  "remaining": 1817
}`}>
              <p>O consumo da cota no período vigente: <code className="font-mono text-[13px] text-zinc-200">limit</code>, <code className="font-mono text-[13px] text-zinc-200">reserved</code>, <code className="font-mono text-[13px] text-zinc-200">confirmed</code> e <code className="font-mono text-[13px] text-zinc-200">remaining</code>.</p>
            </Endpoint>

            <section id="webhooks" className="mt-12 scroll-mt-6 border-t border-white/[.07] pt-12 lg:grid lg:grid-cols-[1fr_minmax(0,430px)] lg:gap-12">
              <div className="min-w-0">
                <h2 className="font-heading text-2xl font-bold tracking-tight text-white">Webhooks</h2>
                <p className="mt-4 text-[15px] leading-7 text-zinc-400">A UNO envia <code className="font-mono text-[13px] text-zinc-200">conversion.completed</code>, <code className="font-mono text-[13px] text-zinc-200">conversion.failed</code> e <code className="font-mono text-[13px] text-zinc-200">batch.completed</code>. Calcule HMAC-SHA-256 sobre <code className="font-mono text-[13px] text-zinc-200">&lt;timestamp&gt;.&lt;corpo exato&gt;</code> e compare com <code className="font-mono text-[13px] text-zinc-200">X-Label-Signature</code>.</p>
                <ul className="mt-5 space-y-2.5 text-sm text-zinc-400">
                  {["Valide a assinatura antes de interpretar o JSON.", "Rejeite timestamps antigos conforme a sua tolerância.", "Deduplicate pelo X-Label-Delivery.", "Responda 2xx só depois de persistir o evento."].map((item) => (
                    <li key={item} className="flex gap-2.5"><Check size={16} className="mt-0.5 shrink-0 text-uno-red" />{item}</li>
                  ))}
                </ul>
                <p className="mt-5 text-sm text-zinc-500">Reentregas após 1 min, 5 min, 30 min, 2 h e 12 h.</p>
              </div>
              <div className="mt-6 lg:mt-0 lg:sticky lg:top-6">
                <div className="overflow-hidden rounded-xl border border-white/10 bg-[#0b0b0d]">
                  <div className="border-b border-white/10 px-3 py-2 text-[11px] text-zinc-500">Cabeçalhos</div>
                  <pre className="overflow-x-auto p-4 text-[12px] leading-[1.7] text-zinc-300"><code>{`X-Label-Timestamp: 1790812800
X-Label-Delivery: dlv_…
X-Label-Signature: v1=<hex-hmac-sha256>`}</code></pre>
                </div>
              </div>
            </section>

            <section id="erros" className="mt-12 scroll-mt-6 border-t border-white/[.07] pt-12">
              <h2 className="font-heading text-2xl font-bold tracking-tight text-white">Erros</h2>
              <p className="mt-4 max-w-2xl text-[15px] leading-7 text-zinc-400">Toda falha traz um código estável e uma mensagem segura, dentro do envelope com <code className="font-mono text-[13px] text-zinc-200">requestId</code>.</p>
              <div className="mt-6 overflow-x-auto rounded-xl border border-white/10">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead className="border-b border-white/10 text-zinc-500"><tr><th className="px-4 py-3 font-medium">Código</th><th className="px-4 py-3 font-medium">HTTP</th><th className="px-4 py-3 font-medium">Significado</th></tr></thead>
                  <tbody>
                    {[["invalid_request", "400", "Campos ausentes ou inválidos."], ["plan_required", "403", "Sem plano pago vigente ou sem o adicional + API."], ["file_too_large", "413", "O arquivo excede o limite do plano."], ["pdf_encrypted", "422", "O PDF exige senha."], ["unsupported_template", "422", "O template não é reconhecido."], ["ambiguous_template", "422", "A detecção não encontrou correspondência segura."], ["quota_exceeded", "403", "Cota mensal atingida."], ["rate_limited", "429", "Limite de requisições atingido."]].map(([code, status, meaning]) => (
                      <tr key={code} className="border-b border-white/[.06] last:border-0"><td className="px-4 py-3"><code className="font-mono text-[13px] text-uno-red">{code}</code></td><td className="px-4 py-3 text-zinc-300">{status}</td><td className="px-4 py-3 text-zinc-500">{meaning}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section id="limites" className="mt-12 scroll-mt-6 border-t border-white/[.07] pt-12 pb-20">
              <h2 className="font-heading text-2xl font-bold tracking-tight text-white">Limites</h2>
              <p className="mt-4 max-w-2xl text-[15px] leading-7 text-zinc-400">Com o adicional + API, o limite por minuto segue o plano: Starter <span className="text-zinc-200">{rates.STARTER}</span>, Pro <span className="text-zinc-200">{rates.PRO}</span> e Business <span className="text-zinc-200">{rates.BUSINESS}</span> requisições. Um <code className="font-mono text-[13px] text-zinc-200">429</code> inclui <code className="font-mono text-[13px] text-zinc-200">Retry-After</code>. Tamanho de arquivo, lote e retenção seguem o plano ativo.</p>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}
