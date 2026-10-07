import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth";
import { OrganizationRecovery } from "@/components/settings/organization-recovery";
import { AppError } from "@/lib/errors";
import { requireIdentity } from "@/server/auth/actor";

// Authenticated area: never prerender at build time, when no database is available.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Nova organização", robots: { index: false, follow: false } };

export default async function NewOrganizationPage() {
  try {
    await requireIdentity();
  } catch (error) {
    if (error instanceof AppError && error.code === "unauthorized") redirect("/login?callbackURL=/organization/new");
    throw error;
  }
  return (
    <AuthShell title="Crie uma organização" description="Sua conta não participa de nenhuma organização no momento.">
      <OrganizationRecovery />
    </AuthShell>
  );
}
