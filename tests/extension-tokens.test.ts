import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { extensionTokens, memberships, organizations, subscriptions, user, type UnoDatabase } from "@/db";
import {
  createExtensionToken,
  listExtensionTokens,
  MAX_ACTIVE_EXTENSION_TOKENS,
  requireExtensionActor,
  revokeExtensionToken,
} from "@/server/extension/tokens";

const OWNER = "00000000-0000-4000-8000-000000000001";
const MEMBER = "00000000-0000-4000-8000-000000000002";
const ORG = "00000000-0000-4000-8000-000000000101";
const OTHER_ORG = "00000000-0000-4000-8000-000000000102";
const NOW = new Date("2026-11-03T12:00:00.000Z");
const pglite = new PGlite();
const database = drizzle(pglite, { schema }) as unknown as UnoDatabase;

async function migrate() {
  const directory = fileURLToPath(new URL("../drizzle", import.meta.url));
  const names = (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  for (const name of names) {
    const migration = await readFile(`${directory}/${name}`, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await pglite.exec(statement);
  }
}

const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` });
const owner = { organizationId: ORG, userId: OWNER, membershipRole: "OWNER" as const };
const member = { organizationId: ORG, userId: MEMBER, membershipRole: "MEMBER" as const };

beforeAll(async () => {
  await migrate();
  await database.insert(user).values([
    { id: OWNER, name: "Dona", email: "dona@example.test", emailVerified: true },
    { id: MEMBER, name: "Expedição", email: "expedicao@example.test", emailVerified: true },
  ]);
  await database.insert(organizations).values([
    { id: ORG, name: "Loja", slug: "loja", ownerUserId: OWNER },
    { id: OTHER_ORG, name: "Outra", slug: "outra", ownerUserId: OWNER },
  ]);
  await database.insert(subscriptions).values([
    { organizationId: ORG, planId: "FREE", status: "ACTIVE" },
    { organizationId: OTHER_ORG, planId: "FREE", status: "ACTIVE" },
  ]);
});

beforeEach(async () => {
  await database.delete(extensionTokens);
  await database.delete(memberships);
  await database.insert(memberships).values([
    { organizationId: ORG, userId: OWNER, role: "OWNER" },
    { organizationId: OTHER_ORG, userId: OWNER, role: "OWNER" },
    { organizationId: ORG, userId: MEMBER, role: "MEMBER" },
  ]);
});

afterAll(async () => { await pglite.close(); });

describe("extension tokens", () => {
  it("returns the token once, stores only its hash and authenticates as the member, without the API add-on", async () => {
    const created = await createExtensionToken(member, { name: "Chrome no macOS" }, database, NOW);
    expect(created.token).toMatch(/^unoext_[A-Za-z0-9_-]{43}$/);
    const stored = (await database.select().from(extensionTokens).where(eq(extensionTokens.id, created.id)))[0]!;
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(created.token);

    const actor = await requireExtensionActor(bearer(created.token), database, NOW);
    expect(actor).toMatchObject({ userId: MEMBER, organizationId: ORG, membershipRole: "MEMBER", planId: "FREE", apiAccess: false, extensionTokenId: created.id });
    expect((await database.select().from(extensionTokens).where(eq(extensionTokens.id, created.id)))[0]!.lastUsedAt).toEqual(NOW);
  });

  it("stays bound to the organization it was connected in", async () => {
    const created = await createExtensionToken({ organizationId: OTHER_ORG, userId: OWNER }, { name: "Edge" }, database, NOW);
    await expect(requireExtensionActor(bearer(created.token), database, NOW)).resolves.toMatchObject({ organizationId: OTHER_ORG });
  });

  it("rejects malformed, unknown and revoked tokens, and members who left", async () => {
    await expect(requireExtensionActor(new Headers(), database, NOW)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(requireExtensionActor(bearer("uno_notanextensiontoken_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), database, NOW)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(requireExtensionActor(bearer(`unoext_${"a".repeat(43)}`), database, NOW)).rejects.toMatchObject({ code: "unauthorized" });

    const revoked = await createExtensionToken(member, { name: "Brave" }, database, NOW);
    await revokeExtensionToken(member, revoked.id, database, NOW);
    await expect(requireExtensionActor(bearer(revoked.token), database, NOW)).rejects.toMatchObject({ code: "unauthorized" });

    const removed = await createExtensionToken(member, { name: "Opera" }, database, NOW);
    await database.delete(memberships).where(and(eq(memberships.organizationId, ORG), eq(memberships.userId, MEMBER)));
    await expect(requireExtensionActor(bearer(removed.token), database, NOW)).rejects.toMatchObject({ code: "unauthorized" });
    // ...and no personal organization is provisioned for them on the way.
    expect(await database.select().from(memberships).where(eq(memberships.userId, MEMBER))).toEqual([]);
  });

  it("lets members see and disconnect only their own browsers; owners manage all", async () => {
    const mine = await createExtensionToken(member, { name: "Do membro" }, database, NOW);
    const owners = await createExtensionToken(owner, { name: "Da dona" }, database, NOW);

    expect((await listExtensionTokens(member, database)).map((item) => item.id)).toEqual([mine.id]);
    expect((await listExtensionTokens(owner, database)).map((item) => item.id).sort()).toEqual([mine.id, owners.id].sort());
    await expect(revokeExtensionToken(member, owners.id, database, NOW)).rejects.toMatchObject({ code: "not_found" });
    await expect(revokeExtensionToken({ ...owner, organizationId: OTHER_ORG }, mine.id, database, NOW)).rejects.toMatchObject({ code: "not_found" });
    await revokeExtensionToken(owner, mine.id, database, NOW);
    expect((await listExtensionTokens(owner, database)).map((item) => item.id)).toEqual([owners.id]);
  });

  it("limits active browsers per organization", async () => {
    for (let index = 0; index < MAX_ACTIVE_EXTENSION_TOKENS; index += 1) await createExtensionToken(owner, { name: `Navegador ${index}` }, database, NOW);
    await expect(createExtensionToken(owner, { name: "Excedente" }, database, NOW)).rejects.toMatchObject({ code: "extension_token_limit_exceeded" });
    await expect(createExtensionToken(owner, { name: " " }, database, NOW)).rejects.toThrow();
  });
});
