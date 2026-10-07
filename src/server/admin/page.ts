import { notFound, redirect } from "next/navigation";

import { AppError } from "@/lib/errors";
import { requirePlatformAdmin, type Identity } from "@/server/auth/actor";

/**
 * Server-side guard for every administration page. Anyone without both
 * platform credentials gets a 404, so the area is not advertised.
 */
export async function requireAdminPage(): Promise<Identity> {
  let failure: unknown;
  try {
    return await requirePlatformAdmin();
  } catch (error) {
    failure = error;
  }
  if (failure instanceof AppError && failure.code === "unauthorized") redirect("/login?callbackURL=/admin");
  if (failure instanceof AppError && (failure.code === "forbidden" || failure.code === "email_not_verified")) notFound();
  throw failure;
}
