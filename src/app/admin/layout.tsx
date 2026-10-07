import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { AdminNav } from "@/components/admin/admin-nav";
import { requireAdminPage } from "@/server/admin/page";

export const metadata: Metadata = { title: "Administração", robots: { index: false, follow: false } };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdminPage();
  return (
    <div className="min-h-screen bg-black">
      <header className="flex min-h-16 items-center justify-between gap-4 border-b border-white/[.06] px-4 sm:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <Image src="/uno-icon.png" width={28} height={28} alt="" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">Administração da plataforma</p>
            <p className="truncate text-xs text-zinc-500">{admin.email}</p>
          </div>
        </div>
        <Link href="/dashboard" className="text-sm text-zinc-300 hover:text-white">Voltar ao painel</Link>
      </header>
      <AdminNav />
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-8">{children}</main>
    </div>
  );
}
