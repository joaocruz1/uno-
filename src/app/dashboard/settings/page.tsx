import type { Metadata } from "next";

import { SettingsPanel } from "@/components/settings/settings-panel";
import { requireActor } from "@/server/http";

export const metadata: Metadata = { title: "Configurações" };

export default async function SettingsPage() {
  const actor = await requireActor();
  return (
    <div className="mx-auto max-w-5xl">
      <p className="text-sm font-semibold text-uno-red">Perfil, assinatura e equipe</p>
      <h1 className="mt-2 font-heading text-3xl font-bold">Configurações</h1>
      <p className="mt-3 text-[var(--color-muted)]">Seus dados de acesso, a assinatura da organização e quem opera com você.</p>
      <SettingsPanel key={`${actor.organizationId}:${actor.membershipRole}:${actor.organizationName}`} organizationId={actor.organizationId} organizationName={actor.organizationName} viewerUserId={actor.userId} viewerName={actor.name} viewerEmail={actor.email} role={actor.membershipRole} />
    </div>
  );
}
