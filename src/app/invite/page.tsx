import type { Metadata } from "next";

import { AuthShell } from "@/components/auth";
import { InvitationAcceptance } from "@/components/settings/invitation-acceptance";

export const metadata: Metadata = { title: "Convite", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function InvitePage() {
  return (
    <AuthShell title="Convite para uma organização" description="Aceite para trabalhar com a equipe que convidou você.">
      <InvitationAcceptance />
    </AuthShell>
  );
}
