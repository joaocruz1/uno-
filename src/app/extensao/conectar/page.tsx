import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthShell } from "@/components/auth";
import { ConnectExtension } from "@/components/extension/connect-extension";
import { AppError } from "@/lib/errors";
import { requireActor } from "@/server/http";

// Authenticated area: never prerender at build time, when no database is available.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Conectar extensão", robots: { index: false, follow: false } };

const STATE_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

export default async function ConnectExtensionPage({ searchParams }: { searchParams: Promise<{ state?: string | string[] }> }) {
  const query = await searchParams;
  const state = typeof query.state === "string" && STATE_PATTERN.test(query.state) ? query.state : null;
  let actor;
  try {
    actor = await requireActor();
  } catch (error) {
    if (error instanceof AppError && error.code === "unauthorized") {
      const back = state ? `/extensao/conectar?state=${state}` : "/extensao/conectar";
      redirect(`/login?callbackURL=${encodeURIComponent(back)}`);
    }
    if (error instanceof AppError && error.code === "organization_required") redirect("/organization/new");
    throw error;
  }
  return (
    <AuthShell title="Conectar a extensão" description="Converta as etiquetas direto no painel do marketplace.">
      <ConnectExtension state={state} organizationName={actor.organizationName} userName={actor.name} />
    </AuthShell>
  );
}
