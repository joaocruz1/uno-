"use client";

import { AnalyticsConsent } from "@/components/telemetry/analytics-consent";
import type { MembershipRole } from "@/lib/management-model";

import { InvitationsSection } from "./invitations-section";
import { MembersSection } from "./members-section";
import { OrganizationSection } from "./organization-section";

export function SettingsPanel({ organizationId, organizationName, viewerUserId, role }: { organizationId: string; organizationName: string; viewerUserId: string; role: MembershipRole }) {
  return (
    <div className="mt-8 space-y-8">
      <OrganizationSection organizationId={organizationId} organizationName={organizationName} role={role} />
      <MembersSection organizationId={organizationId} viewerUserId={viewerUserId} />
      {role !== "MEMBER" ? <InvitationsSection organizationId={organizationId} role={role} /> : null}
      <AnalyticsConsent />
    </div>
  );
}
