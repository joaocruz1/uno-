import { redirect } from "next/navigation";
import Link from "next/link";

import { LogoutButton } from "@/components/auth";
import { Sidebar } from "@/components/sidebar";
import { AppError } from "@/lib/errors";
import { getPlanCatalog } from "@/lib/plans";
import { isPlatformAdmin } from "@/server/auth/actor";
import { requireActor } from "@/server/http";

// Authenticated area: never prerender at build time, when no database is available.
export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  let actor;
  try {
    actor = await requireActor();
  } catch (error) {
    if (error instanceof AppError && error.code === "unauthorized") redirect("/login?callbackURL=/dashboard");
    if (error instanceof AppError && error.code === "organization_required") redirect("/organization/new");
    throw error;
  }

  return (
    <div className="min-h-screen bg-black lg:flex">
      <div className="hidden lg:block"><Sidebar accountName={actor.organizationName} planName={getPlanCatalog()[actor.planId].name} showAdmin={isPlatformAdmin(actor)} /></div>
      <main className="min-w-0 flex-1">
        <header className="flex min-h-16 items-center justify-between gap-4 border-b border-white/[.06] px-4 sm:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <details className="relative lg:hidden">
              <summary className="cursor-pointer list-none rounded-lg border border-white/10 px-3 py-2 text-sm text-zinc-200">Menu</summary>
              <nav aria-label="Dashboard móvel" className="absolute left-0 top-12 z-20 w-52 rounded-xl border border-white/10 bg-[#090909] p-2 shadow-2xl">
                <Link href="/dashboard" className="block rounded-lg px-3 py-2 text-sm hover:bg-white/[.06]">Início</Link>
                <Link href="/dashboard/process" className="block rounded-lg px-3 py-2 text-sm hover:bg-white/[.06]">Nova conversão</Link>
                <Link href="/dashboard/history" className="block rounded-lg px-3 py-2 text-sm hover:bg-white/[.06]">Histórico</Link>
                <Link href="/dashboard/batches" className="block rounded-lg px-3 py-2 text-sm hover:bg-white/[.06]">Lotes</Link>
                <Link href="/dashboard/api" className="block rounded-lg px-3 py-2 text-sm hover:bg-white/[.06]">API</Link>
                <Link href="/dashboard/webhooks" className="block rounded-lg px-3 py-2 text-sm hover:bg-white/[.06]">Webhooks</Link>
                <Link href="/dashboard/usage" className="block rounded-lg px-3 py-2 text-sm hover:bg-white/[.06]">Uso</Link>
                <Link href="/dashboard/billing" className="block rounded-lg px-3 py-2 text-sm hover:bg-white/[.06]">Assinatura</Link>
                <Link href="/dashboard/indicacoes" className="block rounded-lg px-3 py-2 text-sm hover:bg-white/[.06]">Indicações</Link>
                <Link href="/dashboard/settings" className="block rounded-lg px-3 py-2 text-sm hover:bg-white/[.06]">Configurações</Link>
              </nav>
            </details>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">{actor.organizationName}</p>
              <p className="truncate text-xs text-zinc-500">{actor.email}</p>
            </div>
          </div>
          <LogoutButton />
        </header>
        <div className="px-4 py-8 sm:px-8">{children}</div>
      </main>
    </div>
  );
}
