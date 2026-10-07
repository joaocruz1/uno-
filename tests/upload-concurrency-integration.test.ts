import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { closeDb, getDb, organizations, uploadIntents, user } from "@/db";
import { ensureDefaultOrganization } from "@/server/auth/organization";
import { enforceRateLimit } from "@/server/rate-limit";
import { closeRedis } from "@/server/redis";
import { createUploadIntent } from "@/server/uploads";

it.skipIf(process.env.UNO_UPLOAD_INTEGRATION !== "1")("concurrent pending intents and distributed rate limit are bounded", async () => {
  const id = crypto.randomUUID();
  const db = getDb();
  try {
    await db.insert(user).values({ id, name: "Synthetic Concurrent Upload", email: `${id}@example.test`, emailVerified: true });
    await ensureDefaultOrganization({ id, name: "Synthetic Concurrent Upload" });
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => createUploadIntent({ organizationId: id, userId: id, planId: "FREE" }, { contentLength: 100, contentType: "application/pdf" })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(10);
    const denied = results.filter(result => result.status === "rejected");
    expect(denied).toHaveLength(2);
    for (const result of denied) if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 429, code: "pending_upload_limit_exceeded" });
    expect(await db.select().from(uploadIntents).where(eq(uploadIntents.organizationId, id))).toHaveLength(10);
    const rateResults = await Promise.allSettled(Array.from({ length: 12 }, () => enforceRateLimit({ namespace: "integration", identifier: id, limit: 3 })));
    expect(rateResults.filter(result => result.status === "fulfilled")).toHaveLength(3);
    for (const result of rateResults) if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 429, code: "rate_limit_exceeded" });
  } finally {
    await db.delete(organizations).where(eq(organizations.id, id));
    await db.delete(user).where(eq(user.id, id));
    await closeDb(); await closeRedis();
  }
});
