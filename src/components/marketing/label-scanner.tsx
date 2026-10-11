"use client";

import { BadgeCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { ChannelMark } from "@/components/marketplace-logos";

// Synthetic but realistic Mercado Livre orders the scanner cycles through, so
// the hero shows the product working on varied real inputs. Only the supported
// channel appears here; roadmap channels stay in the "Em breve" strip below.
const ORDERS = [
  { dest: "Ana Souza", addr: "Rua das Palmeiras, 240", city: "São Paulo · SP", cep: "01310-100", nf: "000.481", serie: "1", date: "10/2026", code: "7891234560071" },
  { dest: "Bruno Lima", addr: "Av. Brasil, 1820", city: "Curitiba · PR", cep: "80010-010", nf: "000.517", serie: "1", date: "10/2026", code: "7899008120345" },
  { dest: "Caio Dias", addr: "Rua do Sol, 77", city: "Recife · PE", cep: "50010-000", nf: "000.603", serie: "2", date: "10/2026", code: "7890553341902" },
  { dest: "Duda Reis", addr: "Alameda Verde, 915", city: "Belo Horizonte · MG", cep: "30110-002", nf: "000.642", serie: "1", date: "10/2026", code: "7898412009887" },
];

/** Deterministic barcode bars from the order code, so each order draws a
 * distinct barcode without randomness (stable across re-renders). */
function bars(code: string): { w: number; gap: number }[] {
  return Array.from({ length: 52 }, (_, index) => {
    const seed = code.charCodeAt(index % code.length) + index * 13;
    return { w: 1 + (seed % 4), gap: 1 + (seed % 2) };
  });
}

function Barcode({ code, tall = false }: { code: string; tall?: boolean }) {
  return (
    <div className={`flex w-full items-end ${tall ? "h-11" : "h-5"}`} aria-hidden>
      {bars(code).map((bar, index) => (
        <span key={index} style={{ width: bar.w, marginRight: bar.gap, height: "100%" }} className="shrink-0 bg-[#0b0b0c]" />
      ))}
    </div>
  );
}

export function LabelScanner() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const prefersReduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) return;
    const timer = setInterval(() => setIndex((value) => (value + 1) % ORDERS.length), 3000);
    return () => clearInterval(timer);
  }, []);

  const order = ORDERS[index];

  return (
    <div className="neon-stage w-full max-w-[420px] rounded-[30px] p-5 sm:p-7">
      <div className="relative overflow-hidden rounded-2xl bg-white p-4 text-[#0b0b0c] shadow-[0_20px_50px_-20px_rgba(0,0,0,.6)]">
        <div className="scan-sweep" aria-hidden />
        <div key={index} className="label-swap">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-xs font-semibold text-[#52525b]"><ChannelMark id="mercado-livre" size={22} />Etiqueta de envio</span>
            <span className="badge-pulse inline-flex items-center gap-1 rounded-full bg-[#ecfdf3] px-2 py-1 text-[10px] font-bold text-[#15803d]"><BadgeCheck size={12} />Conferido</span>
          </div>

          <div className="mt-3"><Barcode code={order.code} tall /></div>
          <p className="mt-1 text-center text-[9px] tracking-[.3em] text-[#9a9aa2] tabular-nums">{order.code}</p>

          <div className="mt-3 flex items-start justify-between gap-3">
            <div className="text-[10px] leading-4 text-[#52525b]">
              <p className="font-bold text-[#0b0b0c]">Destinatário</p>
              <p className="font-medium text-[#0b0b0c]">{order.dest}</p>
              <p>{order.addr}</p>
              <p>{order.city}</p>
              <p className="tabular-nums">CEP {order.cep}</p>
            </div>
            <svg width="48" height="48" viewBox="0 0 10 10" className="shrink-0" aria-hidden>
              <path fill="#0b0b0c" d="M0 0h3v3H0zM4 0h1v1H4zM6 0h1v2H6zM8 0h2v1H8zM0 4h1v1H0zM2 4h2v1H2zM5 4h1v2H5zM7 4h1v1H7zM9 4h1v2H9zM4 6h1v1H4zM6 7h2v1H6zM0 7h3v3H0zM4 8h1v2H4zM7 9h3v1H7z" />
            </svg>
          </div>

          <div className="mt-3 rounded-md bg-[#fafafa] p-2.5 ring-1 ring-inset ring-[#e8e8ec]">
            <p className="text-[9px] font-bold tracking-wide text-[#0b0b0c]">DANFE SIMPLIFICADA</p>
            <p className="mt-1 text-[9px] tabular-nums text-[#52525b]">NF {order.nf} · Série {order.serie} · {order.date}</p>
            <div className="mt-1.5"><Barcode code={`${order.nf}${order.code}`} /></div>
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-center gap-1.5" aria-hidden>
        {ORDERS.map((candidate, dot) => (
          <span key={candidate.nf} className={`h-1.5 rounded-full transition-all ${dot === index ? "w-5 bg-uno-red" : "w-1.5 bg-white/25"}`} />
        ))}
      </div>
    </div>
  );
}
