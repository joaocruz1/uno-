import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { eq } from "drizzle-orm";

import { closeDb, getDb, user } from "../src/db";
import { getAuth } from "../src/server/auth";

/**
 * Development helper: creates (or re-promotes) a platform administrator in the
 * local database and stores the generated credentials in .tmp/local-admin.txt,
 * which is ignored by Git. Usage: pnpm admin:local [email]
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("This helper is for local development only.");
  const email = (process.argv[2] ?? "admin@uno.local").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("Invalid e-mail.");
  const database = getDb();
  const existing = await database.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  let created = false;
  if (!existing[0]) {
    const password = randomBytes(18).toString("base64url");
    await getAuth().api.signUpEmail({ body: { name: "Administrador UNO", email, password } });
    await mkdir(".tmp", { recursive: true });
    await writeFile(".tmp/local-admin.txt", `URL: ${process.env.APP_URL ?? "http://127.0.0.1:3100"}/admin\nE-mail: ${email}\nSenha: ${password}\n`, { mode: 0o600 });
    created = true;
  }
  await database.update(user).set({ emailVerified: true, platformRole: "ADMIN" }).where(eq(user.email, email));

  const envPath = ".env.local";
  const env = await readFile(envPath, "utf8").catch(() => "");
  const current = /^ADMIN_EMAILS=(.*)$/m.exec(env)?.[1] ?? "";
  const listed = current.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (!listed.includes(email)) {
    const line = `ADMIN_EMAILS=${[...listed, email].join(",")}`;
    await writeFile(envPath, /^ADMIN_EMAILS=.*$/m.test(env) ? env.replace(/^ADMIN_EMAILS=.*$/m, line) : `${env.trimEnd()}\n${line}\n`);
    console.info("ADMIN_EMAILS updated in .env.local — restart the app to apply it.");
  }
  console.info(created ? "Administrator created. Credentials saved to .tmp/local-admin.txt." : "Existing account promoted to administrator (password unchanged).");
}

main().catch((error: unknown) => {
  console.error("Could not create the local administrator.", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => closeDb());
