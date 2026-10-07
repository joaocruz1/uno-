"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Search, RefreshCw } from "lucide-react";
import { Button, EmptyState, Input, Table, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";
import { historyListSchema } from "@/lib/history-model";
import { z } from "zod";

type HistoryList = z.infer<typeof historyListSchema>;
const labels: Record<string, string> = { queued: "Na fila", processing: "Processando", completed: "Concluída", failed: "Falhou" };
const selectClass = "h-11 rounded-lg border border-white/10 bg-[#101010] px-3 text-sm text-zinc-300";

export function HistoryPanel() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [period, setPeriod] = useState("");
  const [filters, setFilters] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [data, setData] = useState<HistoryList>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams(filters);
    if (cursor) parameters.set("cursor", cursor);
    let active = true;
    void (async () => {
      setLoading(true); setError(undefined);
      try {
        const response = await fetch(`/api/dashboard/conversions?${parameters}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error();
        const result = historyListSchema.parse(await response.json());
        if (active) setData(result);
      } catch { if (active) setError("Não foi possível consultar o histórico. Tente novamente."); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; controller.abort(); };
  }, [filters, cursor, refresh]);
  const search = () => {
    const parameters = new URLSearchParams();
    if (query.trim()) parameters.set("q", query.trim());
    if (status) parameters.set("status", status);
    if (source) parameters.set("source", source);
    if (period) {
      const end = new Date(); const start = new Date(end);
      if (period === "today") start.setHours(0, 0, 0, 0);
      else start.setDate(start.getDate() - Number(period));
      parameters.set("from", start.toISOString()); parameters.set("to", end.toISOString());
    }
    setCursor(undefined); setFilters(parameters.toString()); setRefresh(value => value + 1);
  };
  return <div className="mt-8 space-y-5">
    <form className="flex flex-wrap gap-3" onSubmit={event => { event.preventDefault(); search(); }}>
      <label className="min-w-44 flex-1"><span className="sr-only">Buscar por arquivo</span><Input placeholder="Buscar por nome do arquivo" value={query} maxLength={120} onChange={event => setQuery(event.target.value)}/></label>
      <label><span className="sr-only">Estado</span><select aria-label="Estado" className={selectClass} value={status} onChange={event => setStatus(event.target.value)}><option value="">Todos os estados</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span className="sr-only">Origem</span><select aria-label="Origem" className={selectClass} value={source} onChange={event => setSource(event.target.value)}><option value="">Todas as origens</option><option value="dashboard">Painel</option><option value="api">API</option></select></label>
      <label><span className="sr-only">Período</span><select aria-label="Período" className={selectClass} value={period} onChange={event => setPeriod(event.target.value)}><option value="">Todo o período</option><option value="today">Hoje</option><option value="7">Últimos 7 dias</option><option value="30">Últimos 30 dias</option></select></label>
      <Button type="submit" disabled={loading}><Search size={16}/>Buscar</Button>
      <Button variant="secondary" aria-label="Atualizar histórico" onClick={() => setRefresh(value => value + 1)} disabled={loading}><RefreshCw size={16}/></Button>
    </form>
    {error ? <p role="alert" className="rounded-xl border border-red-400/20 p-5 text-sm text-red-300">{error}</p> : null}
    {loading ? <p role="status" className="py-8 text-sm text-zinc-400">Consultando suas conversões…</p> : !error && data?.items.length ? <div className="overflow-hidden rounded-xl border border-white/10"><Table><TableHeader><TableRow><TableHead>Arquivo</TableHead><TableHead>Estado</TableHead><TableHead>Formato</TableHead><TableHead>Criada em</TableHead><TableHead><span className="sr-only">Ações</span></TableHead></TableRow></TableHeader><tbody>{data.items.map(item => <TableRow key={item.id}><TableCell><p className="max-w-56 truncate font-medium text-white">{item.originalFileName ?? "Arquivo PDF"}</p><p className="mt-1 text-xs text-zinc-500">{item.template}</p></TableCell><TableCell><span className={item.status === "completed" ? "text-emerald-300" : item.status === "failed" ? "text-red-300" : "text-zinc-300"}>{labels[item.status]}{item.status === "processing" ? ` · ${item.progress}%` : ""}</span></TableCell><TableCell>{item.size.widthMm} × {item.size.heightMm} mm</TableCell><TableCell>{new Date(item.createdAt).toLocaleString("pt-BR")}</TableCell><TableCell><Link className="font-medium text-uno-red underline underline-offset-4" href={`/dashboard/history/${item.id}`}>Ver detalhes</Link></TableCell></TableRow>)}</tbody></Table></div> : !error ? <EmptyState title="Nenhuma conversão encontrada" description="Ajuste os filtros ou envie seu primeiro PDF."/> : null}
    {!loading && data ? <div className="flex justify-between gap-4"><Button variant="ghost" disabled={!cursor} onClick={() => setCursor(undefined)}>Voltar ao início</Button><Button variant="secondary" disabled={!data.nextCursor} onClick={() => setCursor(data.nextCursor ?? undefined)}>Próxima página</Button></div> : null}
  </div>;
}
