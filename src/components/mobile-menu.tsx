"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ThemeToggle } from "@/components/theme-toggle";

const LINKS = [
  ["Início", "/dashboard"],
  ["Nova conversão", "/dashboard/process"],
  ["Lote de marketplace", "/dashboard/marketplace"],
  ["Histórico", "/dashboard/history"],
  ["Assinatura", "/dashboard/billing"],
  ["Lotes", "/dashboard/batches"],
  ["Uso", "/dashboard/usage"],
  ["Indicações", "/dashboard/indicacoes"],
  ["API", "/dashboard/api"],
  ["Webhooks", "/dashboard/webhooks"],
  ["Configurações", "/dashboard/settings"],
] as const;

/**
 * Phone navigation for the dashboard. Mirrors the desktop sidebar, including
 * the administration entry for platform admins, and closes on a tap outside,
 * on Escape and when a link is chosen.
 */
export function MobileMenu({ showAdmin }: { showAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();
  const links = showAdmin ? [...LINKS, ["Administração", "/admin"] as const] : LINKS;

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <details ref={root} open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="relative lg:hidden">
      <summary aria-label="Abrir menu" className="grid size-9 cursor-pointer list-none place-items-center rounded-lg border border-[var(--color-line)] text-[var(--color-ink)]">
        <span className="flex flex-col gap-[3px]"><i className="h-px w-4 bg-current" /><i className="h-px w-4 bg-current" /><i className="h-px w-4 bg-current" /></span>
      </summary>
      <nav aria-label="Menu" className="card-soft absolute left-0 top-11 z-30 w-60 rounded-2xl p-2">
        {links.map(([label, href]) => (
          <Link
            key={href}
            href={href}
            onClick={() => setOpen(false)}
            aria-current={pathname === href ? "page" : undefined}
            className="block rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-ink)] hover:bg-[var(--hover-ink)] aria-[current=page]:text-uno-red"
          >
            {label}
          </Link>
        ))}
        <div className="mt-1 flex items-center justify-between border-t border-[var(--color-line)] px-3 pt-2">
          <span className="text-xs text-[var(--color-muted)]">Tema</span>
          <ThemeToggle className="grid size-8 place-items-center rounded-lg text-[var(--color-muted)] hover:bg-[var(--hover-ink)]" />
        </div>
      </nav>
    </details>
  );
}
