"use client";

import { useState } from "react";
import { CombinedLabel, DanfeSheet, ShippingSheet } from "./label-art";

export function BeforeAfter() {
  const [view, setView] = useState<"before" | "after">("after");
  return (
    <div className="overflow-hidden border border-white/10 bg-[#050505]">
      <div className="flex items-center justify-between border-b border-white/10 p-3">
        <p className="text-xs text-zinc-500">Visualização sintética</p>
        <div className="flex rounded-full border border-white/10 bg-black p-1" role="group" aria-label="Alternar comparação">
          {(["before", "after"] as const).map((item) => <button key={item} type="button" aria-pressed={view === item} onClick={() => setView(item)} className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${view === item ? "bg-white text-black" : "text-zinc-500 hover:text-white"}`}>{item === "before" ? "Antes" : "Depois"}</button>)}
        </div>
      </div>
      <div className="grid min-h-[440px] place-items-center bg-grid p-8">
        {view === "before" ? <div className="flex items-center gap-4 sm:gap-8"><div className="w-32 -rotate-2 sm:w-44"><ShippingSheet /></div><div className="w-32 rotate-2 sm:w-44"><DanfeSheet /></div></div> : <div className="w-44 sm:w-52"><CombinedLabel className="min-h-80" /></div>}
      </div>
    </div>
  );
}
