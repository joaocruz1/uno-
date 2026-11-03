import { createHash, randomBytes, randomUUID } from "node:crypto";

import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { extensionTokens, getDb, memberships, user, type UnoDatabase } from "@/db";
import { AppError } from "@/lib/errors";
import { type Actor, resolveActor } from "@/server/auth/actor";

/** Connected browsers per organization. */
export const MAX_ACTIVE_EXTENSION_TOKENS = 10;
const TOKEN_PREFIX = "unoext_";
/** Minimum spacing between two `last_used_at` writes for the same token. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export const createExtensionTokenInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
}).strict();

export type ExtensionTokenView = {
  id: string;
  name: string;
  prefix: string;
  userName: string;
  mine: boolean;
  lastUsedAt: string | null;
  createdAt: string;
};

export type ExtensionActor = Actor & { extensionTokenId: string };

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function canManageOthers(actor: Pick<Actor, "membershipRole">): boolean {
  return actor.membershipRole === "OWNER" || actor.membershipRole === "ADMIN";
}

/** Any member connects their own browser; the token acts as that member. */
export async function createExtensionToken(
  actor: Pick<Actor, "organizationId" | "userId">,
  rawInput: unknown,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<{ id: string; token: string }> {
  const input = createExtensionTokenInputSchema.parse(rawInput);
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${actor.organizationId}, 47))`);
    const active = await transaction.select({ value: count() }).from(extensionTokens)
      .where(and(eq(extensionTokens.organizationId, actor.organizationId), isNull(extensionTokens.revokedAt)));
    if ((active[0]?.value ?? 0) >= MAX_ACTIVE_EXTENSION_TOKENS) {
      throw new AppError("extension_token_limit_exceeded", "A organização atingiu o limite de navegadores conectados. Desconecte um antes.", 409);
    }
    await transaction.insert(extensionTokens).values({
      id,
      organizationId: actor.organizationId,
      userId: actor.userId,
      name: input.name,
      prefix: token.slice(0, 14),
      tokenHash: tokenHash(token),
      createdAt: now,
    });
  });
  return { id, token };
}

export async function listExtensionTokens(
  actor: Pick<Actor, "organizationId" | "userId" | "membershipRole">,
  database: UnoDatabase = getDb(),
): Promise<ExtensionTokenView[]> {
  const rows = await database.select({
    id: extensionTokens.id,
    name: extensionTokens.name,
    prefix: extensionTokens.prefix,
    userId: extensionTokens.userId,
    userName: user.name,
    lastUsedAt: extensionTokens.lastUsedAt,
    createdAt: extensionTokens.createdAt,
  }).from(extensionTokens).innerJoin(user, eq(user.id, extensionTokens.userId))
    .where(and(eq(extensionTokens.organizationId, actor.organizationId), isNull(extensionTokens.revokedAt)))
    .orderBy(desc(extensionTokens.createdAt));
  return rows
    .filter((row) => canManageOthers(actor) || row.userId === actor.userId)
    .map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      userName: row.userName,
      mine: row.userId === actor.userId,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
}

/** The owner of a token, an OWNER or an ADMIN can disconnect it. */
export async function revokeExtensionToken(
  actor: Pick<Actor, "organizationId" | "userId" | "membershipRole">,
  tokenId: string,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<void> {
  const scope = canManageOthers(actor) ? undefined : eq(extensionTokens.userId, actor.userId);
  const revoked = await database.update(extensionTokens).set({ revokedAt: now }).where(and(
    eq(extensionTokens.organizationId, actor.organizationId),
    eq(extensionTokens.id, tokenId),
    isNull(extensionTokens.revokedAt),
    scope,
  )).returning({ id: extensionTokens.id });
  if (!revoked[0]) throw new AppError("not_found", "Navegador conectado não encontrado.", 404);
}

function bearerToken(headers: Headers): string {
  const match = /^Bearer (unoext_[A-Za-z0-9_-]{40,64})$/.exec(headers.get("authorization") ?? "");
  if (!match) throw new AppError("unauthorized", "Extensão não conectada.", 401);
  return match[1]!;
}

/**
 * Authenticates an extension request as the member who connected it, in the
 * organization it was connected to. Membership and plan are re-read on every
 * call, so a removed member loses access immediately.
 */
export async function requireExtensionActor(
  headers: Headers,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<ExtensionActor> {
  const rows = await database.select({
    id: extensionTokens.id,
    organizationId: extensionTokens.organizationId,
    lastUsedAt: extensionTokens.lastUsedAt,
    revokedAt: extensionTokens.revokedAt,
    userId: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    platformRole: user.platformRole,
  }).from(extensionTokens).innerJoin(user, eq(user.id, extensionTokens.userId))
    // The membership join keeps a member who left from reaching resolveActor,
    // which would otherwise provision a personal organization for them.
    .innerJoin(memberships, and(eq(memberships.userId, extensionTokens.userId), eq(memberships.organizationId, extensionTokens.organizationId)))
    .where(eq(extensionTokens.tokenHash, tokenHash(bearerToken(headers)))).limit(1);
  const row = rows[0];
  if (!row || row.revokedAt) throw new AppError("unauthorized", "Extensão não conectada.", 401);

  let actor: Actor;
  try {
    actor = await resolveActor({
      userId: row.userId,
      email: row.email,
      name: row.name,
      emailVerified: row.emailVerified,
      platformRole: row.platformRole,
    }, row.organizationId, database);
  } catch (error) {
    if (error instanceof AppError && error.code === "organization_required") throw new AppError("unauthorized", "Extensão não conectada.", 401);
    throw error;
  }
  // resolveActor falls back to another membership; the token is bound to one organization.
  if (actor.organizationId !== row.organizationId) throw new AppError("unauthorized", "Extensão não conectada.", 401);

  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_WRITE_INTERVAL_MS) {
    await database.update(extensionTokens).set({ lastUsedAt: now }).where(eq(extensionTokens.id, row.id));
  }
  return { ...actor, extensionTokenId: row.id };
}
