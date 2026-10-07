import { HistoryPanel } from "@/components/history/history-panel";

export default function HistoryPage() {
  return <div className="mx-auto max-w-6xl"><p className="text-sm font-semibold text-uno-red">Sua operação</p><h1 className="mt-2 font-heading text-3xl font-bold">Histórico</h1><p className="mt-3 text-zinc-400">Encontre suas etiquetas e acompanhe cada conversão.</p><HistoryPanel/></div>;
}
