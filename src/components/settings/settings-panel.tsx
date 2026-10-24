"use client";

import { AnalyticsConsent } from "@/components/telemetry/analytics-consent";
import type { MembershipRole } from "@/lib/management-model";

import { InvitationsSection } from "./invitations-section";
import { MembersSection } from "./members-section";
import { OrganizationSection } from "./organization-section";
import { ProfileSection } from "./profile-section";
import { SubscriptionSection } from "./subscription-section";

const ANCHORS = [
  ["perfil", "Perfil"],
  ["assinatura", "Assinatura"],
  ["organizacao", "Organização"],
] as const;

export function SettingsPanel({ organizationId, organizationName, viewerUserId, viewerName, viewerEmail, role }: { organizationId: string; organizationName: string; viewerUserId: string; viewerName: string; viewerEmail: string; role: MembershipRole }) {
  return (
    <div className="mt-8">
      <nav aria-label="Seções das configurações" className="-mx-1 flex gap-2 overflow-x-auto px-1 py-1">
        {ANCHORS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="shrink-0 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] hover:border-uno-red/60 focus-visible:outline-2 focus-visible:outline-uno-red">{label}</a>
        ))}
      </nav>
      <div className="mt-6 space-y-8">
        <div id="perfil" className="scroll-mt-20 space-y-8"><ProfileSection initialName={viewerName} email={viewerEmail} /></div>
        <div id="assinatura" className="scroll-mt-20"><SubscriptionSection canManage={role !== "MEMBER"} /></div>
        <div id="organizacao" className="scroll-mt-20 space-y-8">
          <OrganizationSection organizationId={organizationId} organizationName={organizationName} role={role} />
          <MembersSection organizationId={organizationId} viewerUserId={viewerUserId} />
          {role !== "MEMBER" ? <InvitationsSection organizationId={organizationId} role={role} /> : null}
        </div>
        <AnalyticsConsent />
      </div>
    </div>
  );
}
