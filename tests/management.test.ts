import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { auditLogs, memberships, organizationInvitations, organizations, subscriptions, user, type UnoDatabase } from "@/db";
import { resolveActor, type Identity } from "@/server/auth/actor";
import type { InvitationEmailMessage, InvitationMailer } from "@/server/auth/email";
import { ensureDefaultOrganization } from "@/server/auth/organization";
import {
  acceptInvitation,
  createOrganization,
  inviteMember,
  listInvitations,
  listMembers,
  listOrganizations,
  removeMember,
  renameOrganization,
  revokeInvitation,
  selectOrganization,
  transferOwnership,
  updateMemberRole,
} from "@/server/organizations";
import { selectionCookie } from "@/server/organizations/http";

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const OWNER = id(1);
const ADMIN = id(2);
const MEMBER = id(3);
const OUTSIDER = id(4);
const GUEST = id(5);
const ORG = id(101);
const FOREIGN_ORG = id(102);
const NOW = new Date("2026-10-07T12:00:00.000Z");
const pglite = new PGlite();
const database = drizzle(pglite, { schema }) as unknown as UnoDatabase;
const sent: InvitationEmailMessage[] = [];
const mailer: InvitationMailer = { async sendOrganizationInvitation(message) { sent.push(message); } };

const who = (userId: string, name = "Pessoa"): Pick<Identity, "userId" | "name"> => ({ userId, name });
const identity = (userId: string, email: string): Identity => ({ userId, email, name: "Pessoa", platformRole: "USER" });

async function migrate() {
  const directory = fileURLToPath(new URL("../drizzle", import.meta.url));
  const names = (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  for (const name of names) {
    const migration = await readFile(`${directory}/${name}`, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await pglite.exec(statement);
  }
}

async function roles(organizationId = ORG): Promise<Record<string, string>> {
  const rows = await database.select().from(memberships).where(eq(memberships.organizationId, organizationId));
  return Object.fromEntries(rows.map((row) => [row.userId, row.role]));
}

async function invite(by: string, email: string, role: "ADMIN" | "MEMBER" = "MEMBER", now = NOW) {
  sent.length = 0;
  const invitation = await inviteMember(who(by), ORG, { email, role }, { database, mailer, now });
  const token = new URL(sent[0]!.url).hash.replace("#token=", "");
  return { invitation, token };
}

beforeAll(async () => {
  await migrate();
  await database.insert(user).values([
    { id: OWNER, name: "Dona", email: "owner@example.test", emailVerified: true },
    { id: ADMIN, name: "Admin", email: "admin@example.test", emailVerified: true },
    { id: MEMBER, name: "Membro", email: "member@example.test", emailVerified: true },
    { id: OUTSIDER, name: "Fora", email: "outsider@example.test", emailVerified: true },
    { id: GUEST, name: "Convidada", email: "guest@example.test", emailVerified: true },
  ]);
});

beforeEach(async () => {
  sent.length = 0;
  await database.delete(auditLogs);
  await database.delete(organizationInvitations);
  await database.delete(organizations);
  await database.insert(organizations).values([
    { id: ORG, name: "Expedição", slug: "org-a", ownerUserId: OWNER },
    { id: FOREIGN_ORG, name: "Outra", slug: "org-b", ownerUserId: OUTSIDER },
  ]);
  await database.insert(memberships).values([
    { organizationId: ORG, userId: OWNER, role: "OWNER", createdAt: new Date("2026-01-01") },
    { organizationId: ORG, userId: ADMIN, role: "ADMIN", createdAt: new Date("2026-01-02") },
    { organizationId: ORG, userId: MEMBER, role: "MEMBER", createdAt: new Date("2026-01-03") },
    { organizationId: FOREIGN_ORG, userId: OUTSIDER, role: "OWNER", createdAt: new Date("2026-01-01") },
  ]);
  await database.insert(subscriptions).values([{ organizationId: ORG }, { organizationId: FOREIGN_ORG }]);
});

afterAll(async () => { await pglite.close(); });

describe("organizations", () => {
  it("creates an organization atomically with one OWNER, a FREE subscription and an audit row", async () => {
    const created = await createOrganization(who(MEMBER), { name: "  Filial Sul  " }, database, NOW);
    expect(created).toMatchObject({ name: "Filial Sul", role: "OWNER", planId: "FREE" });
    expect(await roles(created.id)).toEqual({ [MEMBER]: "OWNER" });
    const stored = (await database.select().from(organizations).where(eq(organizations.id, created.id)))[0]!;
    expect(stored.ownerUserId).toBe(MEMBER);
    const subscription = await database.select().from(subscriptions).where(eq(subscriptions.organizationId, created.id));
    expect(subscription).toHaveLength(1);
    expect(subscription[0]).toMatchObject({ planId: "FREE", status: "ACTIVE" });
    const audit = await database.select().from(auditLogs).where(eq(auditLogs.organizationId, created.id));
    expect(audit.map((row) => row.action)).toEqual(["organization.created"]);
    await expect(createOrganization(who(MEMBER), { name: "x" }, database, NOW)).rejects.toThrow();
    const listed = await listOrganizations(who(MEMBER), created.id, database, NOW);
    expect(listed.items.map((item) => item.id).sort()).toEqual([ORG, created.id].sort());
    expect(listed.selectedOrganizationId).toBe(created.id);
  });

  it("hides foreign organizations from every operation", async () => {
    const denied = { code: "not_found", status: 404 };
    await expect(selectOrganization(who(OWNER), FOREIGN_ORG, database)).rejects.toMatchObject(denied);
    await expect(listMembers(who(OWNER), FOREIGN_ORG, database)).rejects.toMatchObject(denied);
    await expect(renameOrganization(who(OWNER), FOREIGN_ORG, { name: "Tomada" }, database, NOW)).rejects.toMatchObject(denied);
    await expect(updateMemberRole(who(OWNER), FOREIGN_ORG, OUTSIDER, { role: "MEMBER" }, database, NOW)).rejects.toMatchObject(denied);
    await expect(removeMember(who(OWNER), FOREIGN_ORG, OUTSIDER, database, NOW)).rejects.toMatchObject(denied);
    await expect(transferOwnership(who(OWNER), FOREIGN_ORG, { userId: OWNER }, database, NOW)).rejects.toMatchObject(denied);
    await expect(listInvitations(who(OWNER), FOREIGN_ORG, database, NOW)).rejects.toMatchObject(denied);
    await expect(inviteMember(who(OWNER), FOREIGN_ORG, { email: "x@example.test" }, { database, mailer, now: NOW })).rejects.toMatchObject(denied);
    await expect(selectOrganization(who(OWNER), "not-a-uuid", database)).rejects.toMatchObject(denied);
    expect((await database.select().from(organizations).where(eq(organizations.id, FOREIGN_ORG)))[0]!.name).toBe("Outra");
    expect(sent).toHaveLength(0);
  });

  it("treats the selection cookie as a preference and recovers after removal", async () => {
    const second = await createOrganization(who(OUTSIDER), { name: "Segunda" }, database, NOW);
    await database.insert(memberships).values({ organizationId: second.id, userId: MEMBER, role: "MEMBER", createdAt: NOW });
    const member = identity(MEMBER, "member@example.test");
    expect((await resolveActor(member, second.id, database)).organizationId).toBe(second.id);

    await removeMember(who(OUTSIDER), second.id, MEMBER, database, NOW);
    const recovered = await resolveActor(member, second.id, database);
    expect(recovered).toMatchObject({ organizationId: ORG, membershipRole: "MEMBER" });
    const listed = await listOrganizations(member, second.id, database, NOW);
    expect(listed).toMatchObject({ selectedOrganizationId: ORG, items: [{ id: ORG, role: "MEMBER" }] });
    await expect(selectOrganization(member, second.id, database)).rejects.toMatchObject({ code: "not_found" });
    await expect(selectOrganization(member, ORG, database)).resolves.toMatchObject({ id: ORG, role: "MEMBER" });
    // A cookie pointing to an organization the user never joined grants nothing either.
    expect((await resolveActor(member, FOREIGN_ORG, database)).organizationId).toBe(ORG);
    expect(selectionCookie(ORG)).toMatch(/^uno_selected_organization=[0-9a-f-]{36}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax/);
  });

  it("provisions the personal organization once and never restores or elevates afterwards", async () => {
    expect(await ensureDefaultOrganization({ id: GUEST, name: "Convidada" }, database)).toBe(GUEST);
    expect(await roles(GUEST)).toEqual({ [GUEST]: "OWNER" });
    await database.insert(memberships).values({ organizationId: GUEST, userId: MEMBER, role: "MEMBER" });
    await transferOwnership(who(GUEST), GUEST, { userId: MEMBER }, database, NOW);

    expect(await ensureDefaultOrganization({ id: GUEST, name: "Convidada" }, database)).toBeNull();
    expect(await roles(GUEST)).toEqual({ [GUEST]: "ADMIN", [MEMBER]: "OWNER" });
    const guest = identity(GUEST, "guest@example.test");
    expect(await resolveActor(guest, undefined, database)).toMatchObject({ organizationId: GUEST, membershipRole: "ADMIN" });

    await removeMember(who(GUEST), GUEST, GUEST, database, NOW);
    expect(await ensureDefaultOrganization({ id: GUEST, name: "Convidada" }, database)).toBeNull();
    await expect(resolveActor(guest, GUEST, database)).rejects.toMatchObject({ code: "organization_required", status: 403 });
    expect(await roles(GUEST)).toEqual({ [MEMBER]: "OWNER" });
    expect((await listOrganizations(guest, GUEST, database, NOW))).toEqual({ items: [], selectedOrganizationId: null });
    expect(await database.select().from(subscriptions).where(eq(subscriptions.organizationId, GUEST))).toHaveLength(1);
  });

  it("lets OWNER and ADMIN rename, and rejects MEMBER", async () => {
    await expect(renameOrganization(who(MEMBER), ORG, { name: "Não" }, database, NOW)).rejects.toMatchObject({ code: "forbidden" });
    await expect(renameOrganization(who(ADMIN), ORG, { name: "Expedição Norte" }, database, NOW)).resolves.toEqual({ id: ORG, name: "Expedição Norte" });
    await expect(renameOrganization(who(OWNER), ORG, { name: "" }, database, NOW)).rejects.toThrow();
  });
});

describe("members", () => {
  it("lists members only for the caller's organization", async () => {
    const members = await listMembers(who(MEMBER), ORG, database);
    expect(members).toMatchObject({ organizationId: ORG, viewerUserId: MEMBER, viewerRole: "MEMBER" });
    expect(members.items.map((item) => [item.userId, item.role])).toEqual([[OWNER, "OWNER"], [ADMIN, "ADMIN"], [MEMBER, "MEMBER"]]);
  });

  it("blocks every elevation attempt by an ADMIN", async () => {
    await expect(updateMemberRole(who(ADMIN), ORG, MEMBER, { role: "ADMIN" }, database, NOW)).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateMemberRole(who(ADMIN), ORG, ADMIN, { role: "MEMBER" }, database, NOW)).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateMemberRole(who(ADMIN), ORG, MEMBER, { role: "OWNER" }, database, NOW)).rejects.toThrow();
    await expect(updateMemberRole(who(ADMIN), ORG, OWNER, { role: "MEMBER" }, database, NOW)).rejects.toMatchObject({ code: "owner_protected" });
    await expect(transferOwnership(who(ADMIN), ORG, { userId: ADMIN }, database, NOW)).rejects.toMatchObject({ code: "forbidden" });
    await expect(inviteMember(who(ADMIN), ORG, { email: "new-admin@example.test", role: "ADMIN" }, { database, mailer, now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateMemberRole(who(MEMBER), ORG, MEMBER, { role: "ADMIN" }, database, NOW)).rejects.toMatchObject({ code: "forbidden" });
    await database.insert(memberships).values({ organizationId: ORG, userId: GUEST, role: "ADMIN" });
    await expect(removeMember(who(ADMIN), ORG, GUEST, database, NOW)).rejects.toMatchObject({ code: "forbidden" });
    expect(await roles()).toEqual({ [OWNER]: "OWNER", [ADMIN]: "ADMIN", [MEMBER]: "MEMBER", [GUEST]: "ADMIN" });
    expect(sent).toHaveLength(0);
  });

  it("lets the OWNER manage admins and an ADMIN remove members, losing access at once", async () => {
    await expect(updateMemberRole(who(OWNER), ORG, MEMBER, { role: "ADMIN" }, database, NOW)).resolves.toEqual({ userId: MEMBER, role: "ADMIN" });
    await updateMemberRole(who(OWNER), ORG, MEMBER, { role: "MEMBER" }, database, NOW);
    await removeMember(who(ADMIN), ORG, MEMBER, database, NOW);
    await expect(listMembers(who(MEMBER), ORG, database)).rejects.toMatchObject({ code: "not_found" });
    await updateMemberRole(who(OWNER), ORG, ADMIN, { role: "MEMBER" }, database, NOW);
    await expect(renameOrganization(who(ADMIN), ORG, { name: "Depois" }, database, NOW)).rejects.toMatchObject({ code: "forbidden" });
    const actions = (await database.select().from(auditLogs).where(eq(auditLogs.organizationId, ORG))).map((row) => row.action);
    expect(actions.filter((action) => action === "membership.role_changed")).toHaveLength(3);
    expect(actions).toContain("membership.removed");
  });

  it("protects the last OWNER on every path except transfer", async () => {
    const guarded = { code: "owner_protected", status: 409 };
    await expect(removeMember(who(OWNER), ORG, OWNER, database, NOW)).rejects.toMatchObject(guarded);
    await expect(removeMember(who(ADMIN), ORG, OWNER, database, NOW)).rejects.toMatchObject(guarded);
    await expect(updateMemberRole(who(OWNER), ORG, OWNER, { role: "ADMIN" }, database, NOW)).rejects.toMatchObject(guarded);
    await expect(transferOwnership(who(OWNER), ORG, { userId: OWNER }, database, NOW)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(transferOwnership(who(OWNER), ORG, { userId: OUTSIDER }, database, NOW)).rejects.toMatchObject({ code: "member_not_found" });
    expect(await roles()).toEqual({ [OWNER]: "OWNER", [ADMIN]: "ADMIN", [MEMBER]: "MEMBER" });
    // A non-owner may leave.
    await expect(removeMember(who(MEMBER), ORG, MEMBER, database, NOW)).resolves.toBeUndefined();
    await expect(removeMember(who(ADMIN), ORG, ADMIN, database, NOW)).resolves.toBeUndefined();
    expect(await roles()).toEqual({ [OWNER]: "OWNER" });
  });

  it("keeps exactly one OWNER when transfers race", async () => {
    const results = await Promise.allSettled([
      transferOwnership(who(OWNER), ORG, { userId: ADMIN }, database, NOW),
      transferOwnership(who(OWNER), ORG, { userId: MEMBER }, database, NOW),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "forbidden" });
    const current = await roles();
    const owners = Object.entries(current).filter(([, role]) => role === "OWNER");
    expect(owners).toHaveLength(1);
    expect(current[OWNER]).toBe("ADMIN");
    const stored = (await database.select().from(organizations).where(eq(organizations.id, ORG)))[0]!;
    expect(stored.ownerUserId).toBe(owners[0]![0]);
    expect((await database.select().from(auditLogs).where(eq(auditLogs.action, "organization.ownership_transferred")))).toHaveLength(1);
    // The former owner cannot transfer again or manage the new owner.
    await expect(transferOwnership(who(OWNER), ORG, { userId: OWNER }, database, NOW)).rejects.toMatchObject({ code: "forbidden" });
    await expect(removeMember(who(OWNER), ORG, owners[0]![0], database, NOW)).rejects.toMatchObject({ code: "owner_protected" });
  });
});

describe("invitations", () => {
  it("stores only the token hash, sends the link by e-mail and accepts once", async () => {
    const { invitation, token } = await invite(ADMIN, "  Guest@Example.TEST ");
    expect(invitation).toMatchObject({ email: "guest@example.test", role: "MEMBER", status: "PENDING", invitedByUserId: ADMIN });
    expect(new Date(invitation.expiresAt).getTime() - NOW.getTime()).toBe(7 * 24 * 60 * 60 * 1_000);
    expect(sent[0]).toMatchObject({ to: "guest@example.test", organizationName: "Expedição", roleLabel: "Membro" });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = (await database.select().from(organizationInvitations).where(eq(organizationInvitations.id, invitation.id)))[0]!;
    expect(stored.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(JSON.stringify(invitation)).not.toContain(token);
    expect(JSON.stringify(await database.select().from(auditLogs))).not.toContain(token);
    await expect(inviteMember(who(OWNER), ORG, { email: "guest@example.test" }, { database, mailer, now: NOW })).rejects.toMatchObject({ code: "invitation_exists" });
    await expect(inviteMember(who(OWNER), ORG, { email: "member@example.test" }, { database, mailer, now: NOW })).rejects.toMatchObject({ code: "already_member" });
    await expect(listInvitations(who(MEMBER), ORG, database, NOW)).rejects.toMatchObject({ code: "forbidden" });

    const accepted = await acceptInvitation(who(GUEST), { token }, database, NOW);
    expect(accepted).toEqual({ organizationId: ORG, organizationName: "Expedição", role: "MEMBER" });
    expect((await roles())[GUEST]).toBe("MEMBER");
    expect((await listInvitations(who(OWNER), ORG, database, NOW)).items[0]).toMatchObject({ id: invitation.id, status: "ACCEPTED" });
  });

  it("does not duplicate or restore membership on replay", async () => {
    const { token } = await invite(OWNER, "guest@example.test", "ADMIN");
    const [first, second] = await Promise.all([
      acceptInvitation(who(GUEST), { token }, database, NOW),
      acceptInvitation(who(GUEST), { token }, database, NOW),
    ]);
    expect(first).toEqual(second);
    expect(await database.select().from(memberships).where(and(eq(memberships.organizationId, ORG), eq(memberships.userId, GUEST)))).toHaveLength(1);
    expect(await database.select().from(auditLogs).where(eq(auditLogs.action, "invitation.accepted"))).toHaveLength(1);

    await updateMemberRole(who(OWNER), ORG, GUEST, { role: "MEMBER" }, database, NOW);
    await expect(acceptInvitation(who(GUEST), { token }, database, NOW)).resolves.toMatchObject({ role: "MEMBER" });
    expect((await roles())[GUEST]).toBe("MEMBER");

    await removeMember(who(OWNER), ORG, GUEST, database, NOW);
    await expect(acceptInvitation(who(GUEST), { token }, database, NOW)).rejects.toMatchObject({ code: "invitation_used", status: 409 });
    expect((await roles())[GUEST]).toBeUndefined();
  });

  it("rejects expired, revoked, mismatched and unknown tokens", async () => {
    const expired = await invite(OWNER, "guest@example.test");
    const later = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1_000);
    await expect(acceptInvitation(who(GUEST), { token: expired.token }, database, later)).rejects.toMatchObject({ code: "invitation_expired", status: 410 });
    expect((await listInvitations(who(OWNER), ORG, database, later)).items[0]!.status).toBe("EXPIRED");
    // An expired invitation can be replaced, and the old token stays dead.
    const replacement = await invite(OWNER, "guest@example.test", "MEMBER", later);
    await expect(acceptInvitation(who(GUEST), { token: expired.token }, database, later)).rejects.toMatchObject({ code: "invitation_revoked" });

    await expect(acceptInvitation(who(OUTSIDER), { token: replacement.token }, database, later)).rejects.toMatchObject({ code: "invitation_email_mismatch", status: 403 });
    await expect(revokeInvitation(who(MEMBER), ORG, replacement.invitation.id, database, later)).rejects.toMatchObject({ code: "forbidden" });
    await expect(revokeInvitation(who(OUTSIDER), ORG, replacement.invitation.id, database, later)).rejects.toMatchObject({ code: "not_found" });
    await revokeInvitation(who(ADMIN), ORG, replacement.invitation.id, database, later);
    await expect(acceptInvitation(who(GUEST), { token: replacement.token }, database, later)).rejects.toMatchObject({ code: "invitation_revoked", status: 410 });

    await expect(acceptInvitation(who(GUEST), { token: "A".repeat(43) }, database, NOW)).rejects.toMatchObject({ code: "invitation_invalid", status: 404 });
    await expect(acceptInvitation(who(GUEST), { token: "short" }, database, NOW)).rejects.toMatchObject({ code: "invitation_invalid" });
    await expect(acceptInvitation(who(GUEST), {}, database, NOW)).rejects.toMatchObject({ code: "invitation_invalid" });
    expect((await roles())[GUEST]).toBeUndefined();
    expect((await roles())[OUTSIDER]).toBeUndefined();
  });

  it("requires a verified identity and an inviter who is still authorized", async () => {
    const adminInvite = await invite(OWNER, "guest@example.test", "ADMIN");
    await database.update(user).set({ emailVerified: false }).where(eq(user.id, GUEST));
    await expect(acceptInvitation(who(GUEST), { token: adminInvite.token }, database, NOW)).rejects.toMatchObject({ code: "email_not_verified" });
    await database.update(user).set({ emailVerified: true }).where(eq(user.id, GUEST));

    // The inviter lost ownership: an ADMIN can no longer back an ADMIN invitation.
    await transferOwnership(who(OWNER), ORG, { userId: ADMIN }, database, NOW);
    await expect(acceptInvitation(who(GUEST), { token: adminInvite.token }, database, NOW)).rejects.toMatchObject({ code: "invitation_no_longer_valid", status: 409 });

    const memberInvite = await invite(OWNER, "outsider@example.test");
    await removeMember(who(ADMIN), ORG, OWNER, database, NOW);
    await expect(acceptInvitation(who(OUTSIDER), { token: memberInvite.token }, database, NOW)).rejects.toMatchObject({ code: "invitation_no_longer_valid" });
    expect(await roles()).toEqual({ [ADMIN]: "OWNER", [MEMBER]: "MEMBER" });
  });

  it("lets an ADMIN revoke only MEMBER invitations and closes the invitation when delivery fails", async () => {
    const adminInvite = await invite(OWNER, "guest@example.test", "ADMIN");
    await expect(revokeInvitation(who(ADMIN), ORG, adminInvite.invitation.id, database, NOW)).rejects.toMatchObject({ code: "forbidden" });
    await revokeInvitation(who(OWNER), ORG, adminInvite.invitation.id, database, NOW);
    await expect(revokeInvitation(who(OWNER), ORG, adminInvite.invitation.id, database, NOW)).resolves.toBeUndefined();

    const failing: InvitationMailer = { async sendOrganizationInvitation() { throw new Error("smtp-secret-detail"); } };
    await expect(inviteMember(who(OWNER), ORG, { email: "outsider@example.test" }, { database, mailer: failing, now: NOW }))
      .rejects.toMatchObject({ code: "invitation_delivery_failed", status: 502, message: expect.not.stringContaining("smtp") });
    const rows = await database.select().from(organizationInvitations).where(eq(organizationInvitations.email, "outsider@example.test"));
    expect(rows.map((row) => row.status)).toEqual(["REVOKED"]);
  });
});
