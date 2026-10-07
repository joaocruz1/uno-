import { FileText, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "./badge";
import { Card } from "./card";

export function PDFCard({ name, meta, status = "Pronto", preview }: { name: string; meta: string; status?: string; preview?: ReactNode }) {
  return (
    <Card className="group overflow-hidden rounded-xl">
      <div className="grid aspect-[4/3] place-items-center bg-white/[.025]">{preview ?? <FileText className="text-zinc-700" size={40} />}</div>
      <div className="flex items-start justify-between gap-3 border-t border-white/10 p-4">
        <div className="min-w-0"><p className="truncate text-sm font-semibold">{name}</p><p className="mt-1 text-xs text-zinc-500">{meta}</p><Badge className="mt-3">{status}</Badge></div>
        <button className="rounded-full p-2 text-zinc-500 hover:bg-white/10 hover:text-white" aria-label={`Mais ações para ${name}`}><MoreHorizontal size={18} /></button>
      </div>
    </Card>
  );
}
