import { FilePlus2 } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({ title, description, action, icon }: { title: string; description: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="grid min-h-64 place-items-center border border-dashed border-white/15 bg-white/[.015] p-8 text-center">
      <div className="max-w-sm">
        <span className="mx-auto grid size-12 place-items-center rounded-full bg-white/[.05] text-zinc-400">{icon ?? <FilePlus2 />}</span>
        <h3 className="mt-4 font-heading text-lg font-bold">{title}</h3>
        <p className="mt-2 text-sm leading-6 text-zinc-500">{description}</p>
        {action ? <div className="mt-5">{action}</div> : null}
      </div>
    </div>
  );
}
