import { getDb } from "@/db";
import { authEnvironment } from "@/lib/env";
import { authSecondaryStorage } from "@/server/redis";

import { createUnoAuth, type UnoAuth } from "./config";
import { createAuthMailer } from "./email";
import { ensureDefaultOrganization } from "./organization";

let auth: UnoAuth | undefined;

function adminEmails(): ReadonlySet<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Creates provider clients only on the first request, never during import. */
export function getAuth(): UnoAuth {
  if (auth) return auth;

  const environment = authEnvironment();
  const database = getDb();
  auth = createUnoAuth({
    database,
    mailer: createAuthMailer(),
    environment: {
      ...environment,
      appURL: process.env.APP_URL ?? environment.baseURL,
      adminEmails: adminEmails(),
      production: process.env.NODE_ENV === "production",
    },
    secondaryStorage: authSecondaryStorage(),
    provisionUser: (created) => ensureDefaultOrganization(created, database),
  });
  return auth;
}

export { createUnoAuth } from "./config";
export { ensureDefaultOrganization } from "./organization";
export type { AuthMailer } from "./email";
