import { and, asc, eq } from "drizzle-orm";
import { headers as nextHeaders } from "next/headers";

import { getDb, memberships, organizations, subscriptions, user } from "@/db";
import { AppError } from "@/lib/errors";

import { getAuth } from "./index";
import { ensureDefaultOrganization } from "./organization";

export const SELECTED_ORGANIZATION_COOKIE = "uno_selected_organization";

export type Actor = {
  userId: string;
  email: string;
  name: string;
  platformRole: "USER" | "ADMIN";
  organizationId: string;
  organizationName: string;
  membershipRole: "OWNER" | "ADMIN" | "MEMBER";
  planId: "FREE" | "STARTER" | "PRO" | "BUSINESS";
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

export async function requireActor(providedHeaders?: Headers): Promise<Actor> {
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

  const database = getDb();
  try {
    await ensureDefaultOrganization({ id: authSession.user.id, name: authSession.user.name }, database);
  } catch {
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }

  const selected = cookieValue(incomingHeaders.get("cookie"), SELECTED_ORGANIZATION_COOKIE);
  const selectedOrganizationId = isUuid(selected) ? selected : undefined;
  const filters = [eq(memberships.userId, authSession.user.id)];
  if (selectedOrganizationId) filters.push(eq(memberships.organizationId, selectedOrganizationId));

  const rows = await database
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      membershipRole: memberships.role,
      planId: subscriptions.planId,
      platformRole: user.platformRole,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .innerJoin(user, eq(user.id, memberships.userId))
    .leftJoin(subscriptions, eq(subscriptions.organizationId, organizations.id))
    .where(and(...filters))
    .orderBy(asc(memberships.createdAt))
    .limit(1);

  const membership = rows[0];
  if (!membership) {
    throw new AppError(selectedOrganizationId ? "not_found" : "forbidden", selectedOrganizationId ? "Organização não encontrada." : "Acesso negado.", selectedOrganizationId ? 404 : 403);
  }

  return {
    userId: authSession.user.id,
    email: authSession.user.email,
    name: authSession.user.name,
    platformRole: membership.platformRole,
    organizationId: membership.organizationId,
    organizationName: membership.organizationName,
    membershipRole: membership.membershipRole,
    planId: membership.planId ?? "FREE",
  };
}

function configuredAdminEmails(): ReadonlySet<string> {
  return new Set((process.env.ADMIN_EMAILS ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
}

export async function requireAdmin(providedHeaders?: Headers): Promise<Actor> {
  const actor = await requireActor(providedHeaders);
  const allowedByEnvironment = configuredAdminEmails().has(actor.email.toLowerCase());
  if (actor.platformRole !== "ADMIN" || !allowedByEnvironment) {
    throw new AppError("forbidden", "Acesso negado.", 403);
  }
  return actor;
}
