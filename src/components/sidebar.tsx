import Image from "next/image";
import Link from "next/link";
import { BarChart3, CreditCard, FileClock, Gauge, History, KeyRound, Layers3, Settings } from "lucide-react";

const items = [
  ["Início", "/dashboard", Gauge],
  ["Nova conversão", "/dashboard/process", Layers3],
  ["Histórico", "/dashboard/history", History],
  ["Lotes", "/dashboard/batches", FileClock],
  ["API", "/dashboard/api", KeyRound],
  ["Uso", "/dashboard/usage", BarChart3],
  ["Assinatura", "/dashboard/billing", CreditCard],
  ["Configurações", "/dashboard/settings", Settings],
] as const;

export function Sidebar() {
  return (
    <aside className="flex min-h-screen w-64 flex-col border-r border-white/[.06] bg-[#050505] p-4">
      <Link href="/" className="flex items-center gap-3 px-3 py-4"><Image src="/uno.svg" width={30} height={30} alt="" /><span className="font-heading text-xl font-extrabold">UNO</span></Link>
      <nav className="mt-6 space-y-1" aria-label="Dashboard">{items.map(([label, href, Icon]) => <Link key={href} href={href} className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-zinc-400 hover:bg-white/[.05] hover:text-white"><Icon size={18} />{label}</Link>)}</nav>
      <div className="mt-auto rounded-xl border border-white/[.07] bg-white/[.025] p-3"><p className="text-sm font-semibold">Sua conta</p><p className="mt-1 text-xs text-zinc-500">Plano Free</p></div>
    </aside>
  );
}
