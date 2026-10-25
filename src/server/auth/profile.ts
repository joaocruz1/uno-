import { eq } from "drizzle-orm";

import { getDb, user, type UnoDatabase } from "@/db";

/** The signed-in person's stored phone (E.164), or null when it was never filled in. */
export async function readUserPhone(userId: string, database: Pick<UnoDatabase, "select"> = getDb()): Promise<string | null> {
  const rows = await database.select({ phone: user.phone }).from(user).where(eq(user.id, userId)).limit(1);
  return rows[0]?.phone ?? null;
}
