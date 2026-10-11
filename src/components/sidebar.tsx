"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  ChevronRight,
  CreditCard,
  FileClock,
  Gauge,
  Gift,
  History,
  KeyRound,
  Layers3,
  ListChecks,
  Package,
  Settings,
  ShieldCheck,
  Webhook,
  type LucideIcon,
} from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";

type Item = readonly [label: string, href: string, icon: LucideIcon];

// The daily flow lives up top; everything account- or integration-related is
// one reveal away, so the rail stays short (the mockup's five-tab feel).
const PRIMARY: Item[] = [
  ["Início", "/dashboard", Gauge],
  ["Nova conversão", "/dashboard/process", Layers3],
  ["Lote de marketplace", "/dashboard/marketplace", Package],
  ["Histórico", "/dashboard/history", History],
  ["Assinatura", "/dashboard/billing", CreditCard],
];

const MORE: Item[] = [
  ["Lista Shopee", "/dashboard/shopee-lista", ListChecks],
  ["Lotes", "/dashboard/batches", FileClock],
  ["Uso", "/dashboard/usage", BarChart3],
  ["Indicações", "/dashboard/indicacoes", Gift],
  ["API", "/dashboard/api", KeyRound],
  ["Webhooks", "/dashboard/webhooks", Webhook],
  ["Configurações", "/dashboard/settings", Settings],
];

function useIsActive() {
  const pathname = usePathname();
  return (href: string) => (href === "/dashboard" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`));
}

function NavLink({ item, active }: { item: Item; active: boolean }) {
  const [label, href, Icon] = item;
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red/70 ${
        active
          ? "bg-uno-red text-white shadow-[0_6px_18px_-8px_rgba(239,35,60,.9)]"
          : "text-[#9a9aa2] hover:bg-white/[.05] hover:text-white"
      }`}
    >
      <Icon size={18} className={active ? "text-white" : "text-[#7d7d85]"} />
      {label}
    </Link>
  );
}

export function Sidebar({ accountName, planName, showAdmin = false }: { accountName: string; planName: string; showAdmin?: boolean }) {
  const isActive = useIsActive();
  const moreHasActive = MORE.some(([, href]) => isActive(href));

  return (
    <aside className="sticky top-0 flex h-screen w-64 flex-col p-3">
      <div className="flex min-h-0 flex-1 flex-col rounded-[22px] bg-[var(--color-sidebar)] p-3 text-white">
        <Link href="/" className="flex items-center gap-2.5 px-2 py-3">
          <Image src="/uno-icon.png" width={28} height={28} alt="" />
          <span className="font-heading text-lg font-extrabold tracking-tight">UNO</span>
        </Link>

        <nav className="mt-4 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto" aria-label="Painel">
          {PRIMARY.map((item) => (
            <NavLink key={item[1]} item={item} active={isActive(item[1])} />
          ))}

          <details className="nav-reveal mt-1" open={moreHasActive}>
            <summary className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-[#9a9aa2] transition-colors hover:bg-white/[.05] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red/70">
              <ChevronRight size={18} className="nav-chevron text-[#7d7d85]" />
              Mais
            </summary>
            <div className="nav-reveal-body mt-1 flex flex-col gap-1 pl-3">
              {MORE.map((item) => (
                <NavLink key={item[1]} item={item} active={isActive(item[1])} />
              ))}
            </div>
          </details>

          {showAdmin ? (
            <div className="mt-1 border-t border-white/[.07] pt-2">
              <NavLink item={["Administração", "/admin", ShieldCheck]} active={isActive("/admin")} />
            </div>
          ) : null}
        </nav>

        <div className="mt-2 flex items-center gap-2 rounded-xl border border-white/[.07] bg-white/[.03] p-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">{accountName}</p>
            <p className="truncate text-xs text-[#8a8a92]">Plano {planName}</p>
          </div>
          <ThemeToggle className="grid size-9 shrink-0 place-items-center rounded-lg text-[#9a9aa2] transition-colors hover:bg-white/[.07] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red/70" />
        </div>
      </div>
    </aside>
  );
}
