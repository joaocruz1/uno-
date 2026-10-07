import { eq } from "drizzle-orm";

import { getDb, user, type UnoDatabase } from "@/db";
import { AppError } from "@/lib/errors";
import { isPlatformAdmin, type Identity } from "@/server/auth/actor";

export { requirePlatformAdmin } from "@/server/auth/actor";

export type AdminIdentity = Pick<Identity, "userId">;

/**
 * Re-reads the stored platform role and e-mail for every administrative
 * operation. Both the ADMIN role and the ADMIN_EMAILS allowlist are required;
 * organization roles never grant platform privilege.
 */
export async function assertPlatformAdmin(identity: AdminIdentity, database: Pick<UnoDatabase, "select"> = getDb()): Promise<void> {
  const rows = await database.select({ email: user.email, emailVerified: user.emailVerified, platformRole: user.platformRole })
    .from(user).where(eq(user.id, identity.userId)).limit(1);
  const current = rows[0];
  if (!current || !current.emailVerified || !isPlatformAdmin(current)) {
    throw new AppError("forbidden", "Acesso negado.", 403);
  }
}
