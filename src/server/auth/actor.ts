import { asc, eq, sql } from "drizzle-orm";
import { headers as nextHeaders } from "next/headers";

import { getDb, memberships, organizations, subscriptions, user, type UnoDatabase } from "@/db";
import { AppError } from "@/lib/errors";
import { effectivePlanFromSubscription } from "@/server/billing/entitlements";

import { getAuth } from "./index";
import { ensureDefaultOrganization } from "./organization";

export const SELECTED_ORGANIZATION_COOKIE = "uno_selected_organization";

/** Verified identity. It carries no organization authorization by itself. */
export type Identity = {
  userId: string;
  email: string;
  name: string;
  platformRole: "USER" | "ADMIN";
};

export type Actor = Identity & {
  organizationId: string;
  organizationName: string;
  membershipRole: "OWNER" | "ADMIN" | "MEMBER";
  planId: "FREE" | "STARTER" | "PRO" | "BUSINESS";
  /** API keys, public API and webhooks: the API add-on on a paid plan in force. Presentation only; servers re-check. */
  apiAccess: boolean;
};

function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  const entry = header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!entry) return undefined;
  try {
    return decodeURIComponent(entry.slice(name.length + 1));
  } catch {
    return undefined;
  }
}

function isUuid(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

async function requestHeaders(provided?: Headers): Promise<Headers> {
  return provided ?? nextHeaders();
}

/**
 * Authenticates a verified identity without requiring any organization.
 * Listing, switching and creating organizations and accepting invitations use
 * it so a removed member can still recover. The platform role is re-read from
 * the database on every request.
 */
export async function requireIdentity(providedHeaders?: Headers, database: UnoDatabase = getDb()): Promise<Identity> {
  const incomingHeaders = await requestHeaders(providedHeaders);
  let authSession: Awaited<ReturnType<ReturnType<typeof getAuth>["api"]["getSession"]>>;
  try {
    authSession = await getAuth().api.getSession({ headers: incomingHeaders });
  } catch {
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }

  if (!authSession) throw new AppError("unauthorized", "Autenticação necessária.", 401);
  if (!authSession.user.emailVerified) {
    throw new AppError("email_not_verified", "Confirme seu e-mail antes de continuar.", 403);
  }

  const rows = await database.select({ email: user.email, name: user.name, emailVerified: user.emailVerified, platformRole: user.platformRole })
    .from(user).where(eq(user.id, authSession.user.id)).limit(1);
  const current = rows[0];
  if (!current) throw new AppError("unauthorized", "Autenticação necessária.", 401);
  if (!current.emailVerified) throw new AppError("email_not_verified", "Confirme seu e-mail antes de continuar.", 403);
  return { userId: authSession.user.id, email: current.email, name: current.name, platformRole: current.platformRole };
}

/** Reads the selected-organization preference. It is never an authorization. */
export function selectedOrganizationPreference(headers: Headers): string | undefined {
  const selected = cookieValue(headers.get("cookie"), SELECTED_ORGANIZATION_COOKIE);
  return isUuid(selected) ? selected : undefined;
}

/**
 * Resolves the organization the identity currently works in. The cookie is a
 * preference only: when it points to an organization the user no longer
 * belongs to, the oldest current membership is used instead.
 */
export async function resolveActor(identity: Identity, preferredOrganizationId: string | undefined, database: UnoDatabase = getDb()): Promise<Actor> {
  const preference = preferredOrganizationId
    ? sql`case when ${memberships.organizationId} = ${preferredOrganizationId} then 0 else 1 end`
    : sql`1`;
  const load = () => database
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      membershipRole: memberships.role,
      planId: subscriptions.planId,
      subscriptionStatus: subscriptions.status,
      currentPeriodStart: subscriptions.currentPeriodStart,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      apiAddonStatus: subscriptions.apiAddonStatus,
      apiAddonCurrentPeriodEnd: subscriptions.apiAddonCurrentPeriodEnd,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .leftJoin(subscriptions, eq(subscriptions.organizationId, organizations.id))
    .where(eq(memberships.userId, identity.userId))
    .orderBy(preference, asc(memberships.createdAt), asc(memberships.organizationId))
    .limit(1);

  let membership = (await load())[0];
  if (!membership) {
    // Only reached without any membership. Provisioning is a no-op when the
    // personal organization already existed, so nothing is ever restored.
    let created: string | null;
    try {
      created = await ensureDefaultOrganization({ id: identity.userId, name: identity.name }, database);
    } catch {
      throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
    }
    if (created) membership = (await load())[0];
  }
  if (!membership) {
    throw new AppError("organization_required", "Você não participa de nenhuma organização.", 403);
  }

  const entitlement = effectivePlanFromSubscription(membership.planId ? {
    planId: membership.planId,
    status: membership.subscriptionStatus ?? "ACTIVE",
    currentPeriodStart: membership.currentPeriodStart,
    currentPeriodEnd: membership.currentPeriodEnd,
    apiAddonStatus: membership.apiAddonStatus,
    apiAddonCurrentPeriodEnd: membership.apiAddonCurrentPeriodEnd,
  } : undefined);
  return {
    ...identity,
    organizationId: membership.organizationId,
    organizationName: membership.organizationName,
    membershipRole: membership.membershipRole,
    planId: entitlement.planId,
    apiAccess: entitlement.plan.api,
  };
}

export async function requireActor(providedHeaders?: Headers): Promise<Actor> {
  const incomingHeaders = await requestHeaders(providedHeaders);
  const database = getDb();
  const identity = await requireIdentity(incomingHeaders, database);
  return resolveActor(identity, selectedOrganizationPreference(incomingHeaders), database);
}

function configuredAdminEmails(): ReadonlySet<string> {
  return new Set((process.env.ADMIN_EMAILS ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
}

/** Platform administration needs BOTH the stored role and the operational allowlist. */
export function isPlatformAdmin(identity: Pick<Identity, "email" | "platformRole">): boolean {
  return identity.platformRole === "ADMIN" && configuredAdminEmails().has(identity.email.trim().toLowerCase());
}

export async function requireAdmin(providedHeaders?: Headers): Promise<Actor> {
  const actor = await requireActor(providedHeaders);
  if (!isPlatformAdmin(actor)) throw new AppError("forbidden", "Acesso negado.", 403);
  return actor;
}

/** Same rule as requireAdmin, without depending on any organization membership. */
export async function requirePlatformAdmin(providedHeaders?: Headers): Promise<Identity> {
  const identity = await requireIdentity(providedHeaders);
  if (!isPlatformAdmin(identity)) throw new AppError("forbidden", "Acesso negado.", 403);
  return identity;
}
