"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, CreditCard, FileClock, Gauge, Gift, History, KeyRound, Layers3, Settings, ShieldCheck, Webhook } from "lucide-react";

const items = [
  ["Início", "/dashboard", Gauge],
  ["Nova conversão", "/dashboard/process", Layers3],
  ["Histórico", "/dashboard/history", History],
  ["Lotes", "/dashboard/batches", FileClock],
  ["API", "/dashboard/api", KeyRound],
  ["Webhooks", "/dashboard/webhooks", Webhook],
  ["Uso", "/dashboard/usage", BarChart3],
  ["Assinatura", "/dashboard/billing", CreditCard],
  ["Indicações", "/dashboard/indicacoes", Gift],
  ["Configurações", "/dashboard/settings", Settings],
] as const;

export function Sidebar({ accountName, planName, showAdmin = false }: { accountName: string; planName: string; showAdmin?: boolean }) {
  const pathname = usePathname();
  return (
    <aside className="flex min-h-screen w-64 flex-col border-r border-white/[.06] bg-[#050505] p-4">
      <Link href="/" className="flex items-center gap-3 px-3 py-4"><Image src="/uno-icon.png" width={30} height={30} alt="" /><span className="font-heading text-xl font-extrabold">UNO</span></Link>
      <nav className="mt-6 space-y-1" aria-label="Dashboard">{items.map(([label, href, Icon]) => {
        const active = href === "/dashboard" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
        return <Link key={href} href={href} aria-current={active ? "page" : undefined} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition ${active ? "bg-uno-red/10 text-uno-red" : "text-zinc-400 hover:bg-white/[.05] hover:text-white"}`}><Icon size={18} />{label}</Link>;
      })}{showAdmin ? <Link href="/admin" className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-zinc-400 transition hover:bg-white/[.05] hover:text-white"><ShieldCheck size={18} />Administração</Link> : null}</nav>
      <div className="mt-auto rounded-xl border border-white/[.07] bg-white/[.025] p-3"><p className="truncate text-sm font-semibold">{accountName}</p><p className="mt-1 text-xs text-zinc-500">Plano {planName}</p></div>
    </aside>
  );
}
