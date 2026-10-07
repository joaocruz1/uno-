import type { ReactNode } from "react";

export const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export const integer = (value: number) => value.toLocaleString("pt-BR");
export const dateTime = (value: string | null) => value ? new Date(value).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) : "—";
export const date = (value: string | null) => value ? new Date(value).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—";

export function PageHeader({ kicker, title, description }: { kicker: string; title: string; description: string }) {
  return <header><p className="text-sm font-semibold text-uno-red">{kicker}</p><h1 className="mt-2 font-heading text-3xl font-bold">{title}</h1><p className="mt-3 max-w-2xl text-zinc-400">{description}</p></header>;
}

export function Stat({ label, value, hint, accent = false }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-5 ${accent ? "border-uno-red/40 bg-uno-red/[.07]" : "border-white/10 bg-[#080808]"}`}>
      <p className="text-xs text-zinc-500">{label}</p>
      <p className="mt-2 font-heading text-3xl font-bold tabular-nums">{value}</p>
      {hint ? <p className="mt-2 text-xs text-zinc-500">{hint}</p> : null}
    </div>
  );
}

export function Panel({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return <section className="rounded-2xl border border-white/10 bg-[#080808] p-5"><h2 className="text-sm font-semibold">{title}</h2>{note ? <p className="mt-1 text-xs text-zinc-500">{note}</p> : null}<div className="mt-4">{children}</div></section>;
}

/** Horizontal bars for a ranked breakdown. */
export function Bars({ rows, empty }: { rows: Array<{ label: string; value: number; detail?: string }>; empty: string }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  if (rows.length === 0) return <p className="text-sm text-zinc-500">{empty}</p>;
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li key={row.label}>
          <div className="flex items-baseline justify-between gap-3 text-sm"><span className="truncate text-zinc-200">{row.label}</span><span className="shrink-0 tabular-nums text-white">{integer(row.value)}{row.detail ? <span className="ml-2 text-xs text-zinc-500">{row.detail}</span> : null}</span></div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/[.06]"><div className="h-full rounded-full bg-uno-red" style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

/** Daily columns: completed in red, failed in grey. */
export function DailyColumns({ days, empty }: { days: Array<{ day: string; primary: number; secondary?: number }>; empty: string }) {
  const max = Math.max(1, ...days.map((day) => day.primary + (day.secondary ?? 0)));
  if (days.length === 0) return <p className="text-sm text-zinc-500">{empty}</p>;
  return (
    <div className="flex h-40 items-end gap-1.5" role="img" aria-label={days.map((day) => `${day.day}: ${day.primary}`).join(", ")}>
      {days.map((day) => (
        <div key={day.day} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${day.day.slice(8)}/${day.day.slice(5, 7)} · ${day.primary}${day.secondary ? ` + ${day.secondary} falhas` : ""}`}>
          <div className="flex h-32 w-full flex-col justify-end overflow-hidden rounded-sm bg-white/[.03]">
            {day.secondary ? <div className="w-full bg-zinc-600" style={{ height: `${(day.secondary / max) * 100}%` }} /> : null}
            <div className="w-full bg-uno-red" style={{ height: `${(day.primary / max) * 100}%` }} />
          </div>
          <span className="text-[10px] tabular-nums text-zinc-600">{day.day.slice(8)}</span>
        </div>
      ))}
    </div>
  );
}

export function DataTable({ columns, rows, empty }: { columns: string[]; rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) return <p className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-zinc-500">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/10">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="bg-[#080808] text-xs text-zinc-500"><tr>{columns.map((column) => <th key={column} scope="col" className="px-4 py-3 font-medium">{column}</th>)}</tr></thead>
        <tbody className="divide-y divide-white/[.06]">{rows.map((row, index) => <tr key={index} className="hover:bg-white/[.02]">{row.map((cell, cellIndex) => <td key={cellIndex} className="px-4 py-3 align-top">{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function Pill({ tone, children }: { tone: "good" | "bad" | "muted" | "warn"; children: ReactNode }) {
  const tones = { good: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300", bad: "border-red-400/30 bg-red-400/10 text-red-300", warn: "border-amber-400/30 bg-amber-400/10 text-amber-300", muted: "border-white/10 text-zinc-400" };
  return <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}
