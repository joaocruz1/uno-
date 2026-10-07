"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export const ADMIN_SECTIONS = [
  ["Visão geral", "/admin"],
  ["Financeiro", "/admin/finance"],
  ["Clientes", "/admin/customers"],
  ["Atividade", "/admin/activity"],
  ["Chaves de API", "/admin/api-keys"],
  ["Conexões", "/admin/connections"],
  ["Organizações", "/admin/organizations"],
  ["Assinaturas", "/admin/subscriptions"],
  ["Uso", "/admin/usage"],
  ["Conversões", "/admin/conversions"],
  ["Falhas", "/admin/failures"],
  ["Jobs", "/admin/jobs"],
  ["Modelos", "/admin/templates"],
] as const;

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Administração" className="flex gap-1 overflow-x-auto border-b border-white/[.06] px-4 sm:px-8">
      {ADMIN_SECTIONS.map(([label, href]) => {
        const active = pathname === href;
        return <Link key={href} href={href} aria-current={active ? "page" : undefined} className={`whitespace-nowrap border-b-2 px-3 py-3 text-sm transition ${active ? "border-uno-red text-white" : "border-transparent text-zinc-400 hover:text-white"}`}>{label}</Link>;
      })}
    </nav>
  );
}
