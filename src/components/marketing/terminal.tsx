export function ApiTerminal() {
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-[#050505] shadow-2xl">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <span className="size-2 rounded-full bg-uno-red" />
        <span className="size-2 rounded-full bg-zinc-700" />
        <span className="size-2 rounded-full bg-zinc-800" />
        <span className="ml-2 text-[11px] text-zinc-600">criar-conversao.sh</span>
      </div>
      <pre className="overflow-x-auto p-5 text-xs leading-6 text-zinc-300 sm:p-7 sm:text-sm">
        <code>
          <span className="text-uno-red">curl</span>
          {` -X POST https://api.seudominio.com/api/v1/conversions \\
  -H "Authorization: Bearer $UNO_API_KEY" \\
  -H "Idempotency-Key: pedido-demo-001" \\
  -F "file=@etiqueta.pdf" \\
  -F "size=100x150"\n\n`}
          <span className="text-zinc-600">{`{`}</span>
          {`\n  "id": "cnv_...",\n  "status": "queued",\n  "progress": 0\n`}
          <span className="text-zinc-600">{`}`}</span>
        </code>
      </pre>
    </div>
  );
}
