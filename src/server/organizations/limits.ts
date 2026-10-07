import { positiveIntegerEnv } from "@/lib/env";
import { enforceRateLimit } from "@/server/rate-limit";

export function invitationTtlMs(): number {
  return positiveIntegerEnv("UNO_INVITATION_TTL_HOURS", 168) * 60 * 60 * 1_000;
}

export function maxOwnedOrganizations(): number {
  return positiveIntegerEnv("UNO_MAX_OWNED_ORGANIZATIONS", 10);
}

export function maxPendingInvitations(): number {
  return positiveIntegerEnv("UNO_MAX_PENDING_INVITATIONS", 50);
}

/** Per-user limit for organization and membership mutations. */
export async function enforceManagementRateLimit(userId: string): Promise<void> {
  await enforceRateLimit({ namespace: "management", identifier: userId, limit: positiveIntegerEnv("UNO_MANAGEMENT_RATE_LIMIT", 30) });
}

/** Per-organization hourly limit for invitation e-mails. */
export async function enforceInvitationRateLimit(organizationId: string): Promise<void> {
  await enforceRateLimit({ namespace: "invitation-create", identifier: organizationId, limit: positiveIntegerEnv("UNO_INVITATION_RATE_LIMIT", 20), windowSeconds: 3_600 });
}

/** Per-user limit for invitation token attempts. */
export async function enforceInvitationAcceptRateLimit(userId: string): Promise<void> {
  await enforceRateLimit({ namespace: "invitation-accept", identifier: userId, limit: positiveIntegerEnv("UNO_INVITATION_ACCEPT_RATE_LIMIT", 10) });
}

/** Per-administrator limit for platform administration requests. */
export async function enforceAdminRateLimit(userId: string): Promise<void> {
  await enforceRateLimit({ namespace: "admin", identifier: userId, limit: positiveIntegerEnv("UNO_ADMIN_RATE_LIMIT", 120) });
}
