"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
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

const PILL = { type: "spring", stiffness: 480, damping: 38, mass: 0.7 } as const;

function NavLink({ item, active }: { item: Item; active: boolean }) {
  const [label, href, Icon] = item;
  const reduced = useReducedMotion();
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red/70 ${
        active ? "text-white" : "text-[#9a9aa2] hover:bg-white/[.05] hover:text-white"
      }`}
    >
      {active ? (
        <motion.span
          layoutId="sidebar-pill"
          transition={reduced ? { duration: 0 } : PILL}
          className="absolute inset-0 rounded-xl bg-uno-red shadow-[0_6px_18px_-8px_rgba(239,35,60,.9)]"
          aria-hidden
        />
      ) : null}
      <Icon size={18} className={`relative transition-transform duration-200 group-hover:translate-x-0.5 ${active ? "text-white" : "text-[#7d7d85]"}`} />
      <span className="relative">{label}</span>
    </Link>
  );
}

export function Sidebar({ accountName, planName, showAdmin = false }: { accountName: string; planName: string; showAdmin?: boolean }) {
  const isActive = useIsActive();
  const moreHasActive = MORE.some(([, href]) => isActive(href));
  const reduced = useReducedMotion();
  // null = follow the route (open while a "Mais" page is active); a click pins the choice.
  const [moreChoice, setMoreChoice] = useState<boolean | null>(null);
  const showMore = moreChoice ?? moreHasActive;

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

          <div className="mt-1">
            <button
              type="button"
              onClick={() => setMoreChoice(!showMore)}
              aria-expanded={showMore}
              aria-controls="sidebar-mais"
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-[#9a9aa2] transition-colors hover:bg-white/[.05] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red/70"
            >
              <ChevronRight size={18} className={`text-[#7d7d85] transition-transform duration-200 ease-[cubic-bezier(.16,1,.3,1)] ${showMore ? "rotate-90" : ""}`} />
              Mais
            </button>
            <AnimatePresence initial={false}>
              {showMore ? (
                <motion.div
                  id="sidebar-mais"
                  initial={reduced ? false : { height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={reduced ? undefined : { height: 0, opacity: 0 }}
                  transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
                  className="overflow-hidden"
                >
                  <div className="mt-1 flex flex-col gap-1 pl-3">
                    {MORE.map((item) => (
                      <NavLink key={item[1]} item={item} active={isActive(item[1])} />
                    ))}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

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
