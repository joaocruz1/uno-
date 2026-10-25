import { redirect } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { Layers3 } from "lucide-react";

import { LogoutButton } from "@/components/auth";
import { MobileMenu } from "@/components/mobile-menu";
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

  const planName = getPlanCatalog()[actor.planId].name;

  return (
    <div className="app-shell min-h-screen lg:flex">
      <div className="hidden lg:block">
        <Sidebar accountName={actor.organizationName} planName={planName} showAdmin={isPlatformAdmin(actor)} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex min-h-16 items-center justify-between gap-4 border-b border-[var(--color-line)] bg-[color-mix(in_srgb,var(--color-canvas)_82%,transparent)] px-4 backdrop-blur-md sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <MobileMenu showAdmin={isPlatformAdmin(actor)} />

            <Link href="/dashboard" className="flex items-center gap-2 lg:hidden">
              <Image src="/uno-icon.png" width={24} height={24} alt="" />
              <span className="font-heading text-base font-extrabold tracking-tight text-[var(--color-ink)]">UNO</span>
            </Link>

            <div className="hidden min-w-0 lg:block">
              <p className="truncate text-sm font-semibold text-[var(--color-ink)]">{actor.organizationName}</p>
              <p className="truncate text-xs text-[var(--color-muted)]">{actor.email}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/dashboard/process"
              className="hidden items-center gap-2 rounded-xl bg-uno-red px-4 py-2 text-sm font-semibold text-white shadow-[0_8px_20px_-10px_rgba(239,35,60,.9)] transition hover:brightness-110 sm:inline-flex"
            >
              <Layers3 size={16} />
              Nova conversão
            </Link>
            <LogoutButton />
          </div>
        </header>

        <main className="px-4 py-7 sm:px-6 sm:py-8 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
