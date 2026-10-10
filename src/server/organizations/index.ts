import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, memberships, organizationInvitations, organizations, subscriptions, user, type UnoDatabase } from "@/db";
import { appUrl } from "@/lib/env";
import { AppError } from "@/lib/errors";
import {
  acceptInvitationInputSchema,
  acceptedInvitationSchema,
  createInvitationInputSchema,
  createOrganizationInputSchema,
  invitationListSchema,
  invitationSchema,
  memberListSchema,
  organizationListSchema,
  organizationSummarySchema,
  renameOrganizationInputSchema,
  ROLE_LABELS,
  transferOwnershipInputSchema,
  updateMemberInputSchema,
  type AcceptedInvitation,
  type AssignableRole,
  type Invitation,
  type InvitationList,
  type MemberList,
  type MembershipRole,
  type OrganizationList,
  type OrganizationSummary,
} from "@/lib/management-model";
import type { Identity } from "@/server/auth/actor";
import { createInvitationMailer, type InvitationMailer } from "@/server/auth/email";
import { effectivePlanId } from "@/server/billing/entitlements";

import { writeAudit } from "./audit";
import { invitationTtlMs, maxOwnedOrganizations, maxPendingInvitations } from "./limits";

type Transaction = Parameters<Parameters<UnoDatabase["transaction"]>[0]>[0];
type Reader = Pick<UnoDatabase, "select">;
type Who = Pick<Identity, "userId">;
type InvitationRow = typeof organizationInvitations.$inferSelect;

const idSchema = z.uuid();

function notFound(): AppError {
  return new AppError("not_found", "Organização não encontrada.", 404);
}

function forbidden(): AppError {
  return new AppError("forbidden", "Acesso negado.", 403);
}

function requireId(value: string, error: () => AppError = notFound): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw error();
  return parsed.data;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isManager(role: MembershipRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}

/** ADMIN handles MEMBER only; OWNER handles ADMIN and MEMBER. Nobody handles OWNER here. */
function canManageRole(actorRole: MembershipRole, targetRole: MembershipRole): boolean {
  if (targetRole === "OWNER") return false;
  if (actorRole === "OWNER") return true;
  return actorRole === "ADMIN" && targetRole === "MEMBER";
}

async function currentRole(reader: Reader, organizationId: string, userId: string): Promise<MembershipRole | undefined> {
  const rows = await reader.select({ role: memberships.role }).from(memberships)
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, userId))).limit(1);
  return rows[0]?.role;
}

/**
 * Serializes every membership, ownership and invitation change of one
 * organization on its row lock, then re-reads the caller's membership inside
 * the same transaction. A non-member cannot tell the organization exists.
 */
async function lockAsMember(transaction: Transaction, organizationId: string, userId: string) {
  const rows = await transaction.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1).for("update");
  const organization = rows[0];
  if (!organization) throw notFound();
  const role = await currentRole(transaction, organizationId, userId);
  if (!role) throw notFound();
  return { organization, role };
}

export async function requireMembership(
  identity: Who,
  rawOrganizationId: string,
  database: Reader = getDb(),
): Promise<{ organizationId: string; role: MembershipRole }> {
  const organizationId = requireId(rawOrganizationId);
  const role = await currentRole(database, organizationId, identity.userId);
  if (!role) throw notFound();
  return { organizationId, role };
}

export async function listOrganizations(
  identity: Who,
  preferredOrganizationId: string | undefined,
  database: Reader = getDb(),
  now = new Date(),
): Promise<OrganizationList> {
  const rows = await database.select({
    id: organizations.id,
    name: organizations.name,
    role: memberships.role,
    createdAt: organizations.createdAt,
    joinedAt: memberships.createdAt,
    planId: subscriptions.planId,
    status: subscriptions.status,
    currentPeriodStart: subscriptions.currentPeriodStart,
    currentPeriodEnd: subscriptions.currentPeriodEnd,
    prepaidPlanId: subscriptions.prepaidPlanId,
    prepaidPeriodEnd: subscriptions.prepaidPeriodEnd,
  }).from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .leftJoin(subscriptions, eq(subscriptions.organizationId, organizations.id))
    .where(eq(memberships.userId, identity.userId))
    .orderBy(asc(memberships.createdAt), asc(memberships.organizationId));
  const items = rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    planId: effectivePlanId(row.planId ? {
      planId: row.planId,
      status: row.status ?? "ACTIVE",
      currentPeriodStart: row.currentPeriodStart,
      currentPeriodEnd: row.currentPeriodEnd,
      prepaidPlanId: row.prepaidPlanId,
      prepaidPeriodEnd: row.prepaidPeriodEnd,
    } : undefined, now),
    createdAt: row.createdAt.toISOString(),
  }));
  const selected = items.find((item) => item.id === preferredOrganizationId) ?? items[0];
  return organizationListSchema.parse({ items, selectedOrganizationId: selected?.id ?? null });
}

export async function createOrganization(
  identity: Who,
  rawInput: unknown,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<OrganizationSummary> {
  const input = createOrganizationInputSchema.parse(rawInput);
  const id = randomUUID();
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identity.userId}, 47))`);
    const owned = await transaction.select({ value: count() }).from(organizations).where(eq(organizations.ownerUserId, identity.userId));
    if ((owned[0]?.value ?? 0) >= maxOwnedOrganizations()) {
      throw new AppError("organization_limit_exceeded", "Você atingiu o limite de organizações próprias.", 409);
    }
    await transaction.insert(organizations).values({ id, name: input.name, slug: `org-${id}`, ownerUserId: identity.userId, createdAt: now, updatedAt: now });
    await transaction.insert(memberships).values({ organizationId: id, userId: identity.userId, role: "OWNER", createdAt: now, updatedAt: now });
    await transaction.insert(subscriptions).values({ organizationId: id, planId: "FREE", status: "ACTIVE" });
    await writeAudit(transaction, { organizationId: id, actorUserId: identity.userId, action: "organization.created", resourceType: "organization", resourceId: id }, now);
  });
  return organizationSummarySchema.parse({ id, name: input.name, role: "OWNER", planId: "FREE", createdAt: now.toISOString() });
}

/** Verifies current membership before the selection cookie is written. */
export async function selectOrganization(
  identity: Who,
  rawOrganizationId: string,
  database: Reader = getDb(),
): Promise<{ id: string; name: string; role: MembershipRole }> {
  const organizationId = requireId(rawOrganizationId);
  const rows = await database.select({ id: organizations.id, name: organizations.name, role: memberships.role })
    .from(memberships).innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, identity.userId))).limit(1);
  if (!rows[0]) throw notFound();
  return rows[0];
}

export async function renameOrganization(
  identity: Who,
  rawOrganizationId: string,
  rawInput: unknown,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<{ id: string; name: string }> {
  const organizationId = requireId(rawOrganizationId);
  const input = renameOrganizationInputSchema.parse(rawInput);
  await database.transaction(async (transaction) => {
    const { role } = await lockAsMember(transaction, organizationId, identity.userId);
    if (!isManager(role)) throw forbidden();
    await transaction.update(organizations).set({ name: input.name, updatedAt: now }).where(eq(organizations.id, organizationId));
    await writeAudit(transaction, { organizationId, actorUserId: identity.userId, action: "organization.renamed", resourceType: "organization", resourceId: organizationId }, now);
  });
  return { id: organizationId, name: input.name };
}

export async function listMembers(
  identity: Who,
  rawOrganizationId: string,
  database: Reader = getDb(),
): Promise<MemberList> {
  const { organizationId, role } = await requireMembership(identity, rawOrganizationId, database);
  const rows = await database.select({ userId: memberships.userId, name: user.name, email: user.email, role: memberships.role, joinedAt: memberships.createdAt })
    .from(memberships).innerJoin(user, eq(user.id, memberships.userId))
    .where(eq(memberships.organizationId, organizationId))
    .orderBy(asc(memberships.createdAt), asc(memberships.userId));
  return memberListSchema.parse({
    organizationId,
    viewerUserId: identity.userId,
    viewerRole: role,
    items: rows.map((row) => ({ ...row, joinedAt: row.joinedAt.toISOString() })),
  });
}

export async function updateMemberRole(
  identity: Who,
  rawOrganizationId: string,
  rawTargetUserId: string,
  rawInput: unknown,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<{ userId: string; role: AssignableRole }> {
  const organizationId = requireId(rawOrganizationId);
  const targetUserId = requireId(rawTargetUserId, () => new AppError("member_not_found", "Membro não encontrado.", 404));
  const input = updateMemberInputSchema.parse(rawInput);
  await database.transaction(async (transaction) => {
    const { role: actorRole } = await lockAsMember(transaction, organizationId, identity.userId);
    if (!isManager(actorRole)) throw forbidden();
    const targetRole = await currentRole(transaction, organizationId, targetUserId);
    if (!targetRole) throw new AppError("member_not_found", "Membro não encontrado.", 404);
    if (targetRole === "OWNER") {
      throw new AppError("owner_protected", "O proprietário só muda por transferência de propriedade.", 409);
    }
    // The actor must be allowed to manage both the current and the requested role.
    if (!canManageRole(actorRole, targetRole) || !canManageRole(actorRole, input.role)) throw forbidden();
    if (targetRole === input.role) return;
    await transaction.update(memberships).set({ role: input.role, updatedAt: now })
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, targetUserId)));
    await writeAudit(transaction, {
      organizationId,
      actorUserId: identity.userId,
      action: "membership.role_changed",
      resourceType: "membership",
      resourceId: targetUserId,
      changes: { previousRole: targetRole, role: input.role },
    }, now);
  });
  return { userId: targetUserId, role: input.role };
}

/** Removes another member under the role rules, or lets a non-owner leave. */
export async function removeMember(
  identity: Who,
  rawOrganizationId: string,
  rawTargetUserId: string,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<void> {
  const organizationId = requireId(rawOrganizationId);
  const targetUserId = requireId(rawTargetUserId, () => new AppError("member_not_found", "Membro não encontrado.", 404));
  await database.transaction(async (transaction) => {
    const { role: actorRole } = await lockAsMember(transaction, organizationId, identity.userId);
    const leaving = targetUserId === identity.userId;
    const targetRole = leaving ? actorRole : await currentRole(transaction, organizationId, targetUserId);
    if (!leaving && !isManager(actorRole)) throw forbidden();
    if (!targetRole) throw new AppError("member_not_found", "Membro não encontrado.", 404);
    if (targetRole === "OWNER") {
      throw new AppError("owner_protected", "Transfira a propriedade antes de remover o proprietário.", 409);
    }
    if (!leaving && !canManageRole(actorRole, targetRole)) throw forbidden();
    await transaction.delete(memberships)
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, targetUserId)));
    await writeAudit(transaction, {
      organizationId,
      actorUserId: identity.userId,
      action: leaving ? "membership.left" : "membership.removed",
      resourceType: "membership",
      resourceId: targetUserId,
      changes: { previousRole: targetRole },
    }, now);
  });
}

export async function transferOwnership(
  identity: Who,
  rawOrganizationId: string,
  rawInput: unknown,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<{ organizationId: string; ownerUserId: string; previousOwnerUserId: string }> {
  const organizationId = requireId(rawOrganizationId);
  const input = transferOwnershipInputSchema.parse(rawInput);
  await database.transaction(async (transaction) => {
    const { organization, role } = await lockAsMember(transaction, organizationId, identity.userId);
    const locked = await transaction.select({ userId: memberships.userId, role: memberships.role }).from(memberships)
      .where(eq(memberships.organizationId, organizationId)).orderBy(asc(memberships.userId)).for("update");
    const owner = locked.find((row) => row.role === "OWNER");
    // Re-read under lock: a concurrent transfer leaves the former owner as ADMIN.
    if (role !== "OWNER" || owner?.userId !== identity.userId || organization.ownerUserId !== identity.userId) throw forbidden();
    if (input.userId === identity.userId) {
      throw new AppError("invalid_request", "Escolha outro membro para receber a propriedade.", 400);
    }
    if (!locked.some((row) => row.userId === input.userId)) {
      throw new AppError("member_not_found", "O novo proprietário precisa ser membro da organização.", 404);
    }
    // Demote first: the partial unique index allows a single OWNER at any time.
    await transaction.update(memberships).set({ role: "ADMIN", updatedAt: now })
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, identity.userId)));
    await transaction.update(memberships).set({ role: "OWNER", updatedAt: now })
      .where(and(eq(memberships.organizationId, organizationId), eq(memberships.userId, input.userId)));
    await transaction.update(organizations).set({ ownerUserId: input.userId, updatedAt: now }).where(eq(organizations.id, organizationId));
    await writeAudit(transaction, {
      organizationId,
      actorUserId: identity.userId,
      action: "organization.ownership_transferred",
      resourceType: "organization",
      resourceId: organizationId,
      changes: { previousOwnerUserId: identity.userId, ownerUserId: input.userId },
    }, now);
  });
  return { organizationId, ownerUserId: input.userId, previousOwnerUserId: identity.userId };
}

function publicInvitation(row: InvitationRow, now: Date): Invitation {
  return invitationSchema.parse({
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status === "PENDING" && row.expiresAt <= now ? "EXPIRED" : row.status,
    invitedByUserId: row.invitedByUserId,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  });
}

export async function listInvitations(
  identity: Who,
  rawOrganizationId: string,
  database: Reader = getDb(),
  now = new Date(),
): Promise<InvitationList> {
  const { organizationId, role } = await requireMembership(identity, rawOrganizationId, database);
  if (!isManager(role)) throw forbidden();
  const rows = await database.select().from(organizationInvitations)
    .where(eq(organizationInvitations.organizationId, organizationId))
    .orderBy(desc(organizationInvitations.createdAt), desc(organizationInvitations.id)).limit(200);
  return invitationListSchema.parse({ items: rows.map((row) => publicInvitation(row, now)) });
}

export type CreatedInvitation = {
  invitation: Invitation;
  organizationName: string;
  /** Returned to the delivery step only. Never persisted, logged or sent to the inviter. */
  token: string;
};

export async function createInvitation(
  identity: Who,
  rawOrganizationId: string,
  rawInput: unknown,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<CreatedInvitation> {
  const organizationId = requireId(rawOrganizationId);
  const input = createInvitationInputSchema.parse(rawInput);
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();
  const expiresAt = new Date(now.getTime() + invitationTtlMs());
  return database.transaction(async (transaction) => {
    const { organization, role: actorRole } = await lockAsMember(transaction, organizationId, identity.userId);
    if (!isManager(actorRole) || !canManageRole(actorRole, input.role)) throw forbidden();

    const existingMember = await transaction.select({ userId: memberships.userId }).from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(and(eq(memberships.organizationId, organizationId), sql`lower(${user.email}) = ${input.email}`)).limit(1);
    if (existingMember[0]) throw new AppError("already_member", "Esta pessoa já participa da organização.", 409);

    // Expired pending rows no longer grant anything; closing them frees the unique pending slot.
    await transaction.update(organizationInvitations).set({ status: "REVOKED", revokedAt: now, updatedAt: now }).where(and(
      eq(organizationInvitations.organizationId, organizationId),
      eq(organizationInvitations.status, "PENDING"),
      sql`${organizationInvitations.expiresAt} <= ${now}`,
    ));
    const pending = await transaction.select({ email: organizationInvitations.email }).from(organizationInvitations).where(and(
      eq(organizationInvitations.organizationId, organizationId),
      eq(organizationInvitations.status, "PENDING"),
    ));
    if (pending.some((row) => row.email === input.email)) {
      throw new AppError("invitation_exists", "Já existe um convite pendente para este e-mail.", 409);
    }
    if (pending.length >= maxPendingInvitations()) {
      throw new AppError("invitation_limit_exceeded", "A organização atingiu o limite de convites pendentes.", 409);
    }

    const inserted = await transaction.insert(organizationInvitations).values({
      id,
      organizationId,
      email: input.email,
      role: input.role,
      tokenHash: tokenHash(token),
      status: "PENDING",
      invitedByUserId: identity.userId,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    }).returning();
    await writeAudit(transaction, {
      organizationId,
      actorUserId: identity.userId,
      action: "invitation.created",
      resourceType: "invitation",
      resourceId: id,
      changes: { role: input.role },
    }, now);
    return { invitation: publicInvitation(inserted[0]!, now), organizationName: organization.name, token };
  });
}

export async function revokeInvitation(
  identity: Who,
  rawOrganizationId: string,
  rawInvitationId: string,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<void> {
  const invitationNotFound = () => new AppError("invitation_not_found", "Convite não encontrado.", 404);
  const organizationId = requireId(rawOrganizationId);
  const invitationId = requireId(rawInvitationId, invitationNotFound);
  await database.transaction(async (transaction) => {
    const { role: actorRole } = await lockAsMember(transaction, organizationId, identity.userId);
    if (!isManager(actorRole)) throw forbidden();
    const rows = await transaction.select().from(organizationInvitations).where(and(
      eq(organizationInvitations.organizationId, organizationId),
      eq(organizationInvitations.id, invitationId),
    )).limit(1).for("update");
    const invitation = rows[0];
    if (!invitation) throw invitationNotFound();
    if (!canManageRole(actorRole, invitation.role)) throw forbidden();
    if (invitation.status === "REVOKED") return;
    if (invitation.status !== "PENDING") throw new AppError("invitation_used", "Este convite já foi utilizado.", 409);
    await transaction.update(organizationInvitations).set({ status: "REVOKED", revokedAt: now, updatedAt: now })
      .where(and(eq(organizationInvitations.organizationId, organizationId), eq(organizationInvitations.id, invitationId)));
    await writeAudit(transaction, { organizationId, actorUserId: identity.userId, action: "invitation.revoked", resourceType: "invitation", resourceId: invitationId }, now);
  });
}

export function invitationUrl(token: string): string {
  // The fragment never reaches servers, proxies or referrer headers.
  return `${new URL("/invite", appUrl()).toString()}#token=${token}`;
}

export type InviteDependencies = {
  database?: UnoDatabase;
  mailer?: InvitationMailer;
  now?: Date;
};

/** Creates the invitation and delivers its single-use link. A failed delivery closes the invitation. */
export async function inviteMember(
  identity: Pick<Identity, "userId" | "name">,
  rawOrganizationId: string,
  rawInput: unknown,
  dependencies: InviteDependencies = {},
): Promise<Invitation> {
  const database = dependencies.database ?? getDb();
  const now = dependencies.now ?? new Date();
  const created = await createInvitation(identity, rawOrganizationId, rawInput, database, now);
  try {
    const mailer = dependencies.mailer ?? createInvitationMailer();
    await mailer.sendOrganizationInvitation({
      to: created.invitation.email,
      organizationName: created.organizationName,
      inviterName: identity.name,
      roleLabel: ROLE_LABELS[created.invitation.role],
      url: invitationUrl(created.token),
      expiresAt: new Date(created.invitation.expiresAt),
    });
  } catch {
    await database.update(organizationInvitations).set({ status: "REVOKED", revokedAt: now, updatedAt: now }).where(and(
      eq(organizationInvitations.id, created.invitation.id),
      eq(organizationInvitations.status, "PENDING"),
    ));
    throw new AppError("invitation_delivery_failed", "Não foi possível enviar o convite. Tente novamente.", 502);
  }
  return created.invitation;
}

/**
 * Accepts an invitation for the authenticated, verified identity. Everything
 * that authorizes the acceptance is re-read under the organization lock.
 */
export async function acceptInvitation(
  identity: Who,
  rawInput: unknown,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<AcceptedInvitation> {
  const invalid = () => new AppError("invitation_invalid", "Convite inválido.", 404);
  const parsed = acceptInvitationInputSchema.safeParse(rawInput);
  if (!parsed.success) throw invalid();
  const hash = tokenHash(parsed.data.token);
  const located = await database.select({ id: organizationInvitations.id, organizationId: organizationInvitations.organizationId })
    .from(organizationInvitations).where(eq(organizationInvitations.tokenHash, hash)).limit(1);
  if (!located[0]) throw invalid();
  const { id: invitationId, organizationId } = located[0];

  return database.transaction(async (transaction) => {
    const organizationRows = await transaction.select({ id: organizations.id, name: organizations.name })
      .from(organizations).where(eq(organizations.id, organizationId)).limit(1).for("update");
    const organization = organizationRows[0];
    if (!organization) throw invalid();
    const invitationRows = await transaction.select().from(organizationInvitations).where(and(
      eq(organizationInvitations.id, invitationId),
      eq(organizationInvitations.organizationId, organizationId),
      eq(organizationInvitations.tokenHash, hash),
    )).limit(1).for("update");
    const invitation = invitationRows[0];
    if (!invitation) throw invalid();

    const accountRows = await transaction.select({ email: user.email, emailVerified: user.emailVerified })
      .from(user).where(eq(user.id, identity.userId)).limit(1);
    const account = accountRows[0];
    if (!account) throw new AppError("unauthorized", "Autenticação necessária.", 401);
    if (!account.emailVerified) throw new AppError("email_not_verified", "Confirme seu e-mail antes de continuar.", 403);
    if (account.email.trim().toLowerCase() !== invitation.email) {
      throw new AppError("invitation_email_mismatch", "Este convite foi enviado para outro endereço de e-mail.", 403);
    }

    const existingRole = await currentRole(transaction, organizationId, identity.userId);
    if (invitation.status === "ACCEPTED") {
      // Replay by the same identity is idempotent and never re-creates a removed membership.
      if (invitation.acceptedByUserId === identity.userId && existingRole) {
        return acceptedInvitationSchema.parse({ organizationId, organizationName: organization.name, role: existingRole });
      }
      throw new AppError("invitation_used", "Este convite já foi utilizado.", 409);
    }
    if (invitation.status === "REVOKED") throw new AppError("invitation_revoked", "Este convite foi revogado.", 410);
    if (invitation.expiresAt <= now) throw new AppError("invitation_expired", "Este convite expirou. Peça um novo convite.", 410);
    if (invitation.role !== "ADMIN" && invitation.role !== "MEMBER") throw invalid();

    const inviterRole = invitation.invitedByUserId
      ? await currentRole(transaction, organizationId, invitation.invitedByUserId)
      : undefined;
    if (!inviterRole || !isManager(inviterRole) || !canManageRole(inviterRole, invitation.role)) {
      throw new AppError("invitation_no_longer_valid", "Este convite não é mais válido. Peça um novo convite.", 409);
    }

    // An existing member keeps the current role: an invitation never changes it.
    const role = existingRole ?? invitation.role;
    if (!existingRole) {
      await transaction.insert(memberships).values({ organizationId, userId: identity.userId, role: invitation.role, createdAt: now, updatedAt: now });
    }
    await transaction.update(organizationInvitations)
      .set({ status: "ACCEPTED", acceptedByUserId: identity.userId, acceptedAt: now, updatedAt: now })
      .where(eq(organizationInvitations.id, invitationId));
    await writeAudit(transaction, {
      organizationId,
      actorUserId: identity.userId,
      action: "invitation.accepted",
      resourceType: "invitation",
      resourceId: invitationId,
      changes: { role, membershipCreated: !existingRole },
    }, now);
    return acceptedInvitationSchema.parse({ organizationId, organizationName: organization.name, role });
  });
}
