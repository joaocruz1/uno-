import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { safeInternalPath } from "@/lib/auth-client";
import { AppError } from "@/lib/errors";
import { createUnoAuth, ensureDefaultOrganization } from "@/server/auth";
import type { AuthMailer } from "@/server/auth";
import { defaultOrganizationName } from "@/server/auth/organization";
import { assertSameOrigin, errorResponse } from "@/server/http";

const pglite = new PGlite();
const database = drizzle(pglite, { schema });
const sent: Array<{ kind: "verification" | "reset"; to: string; url: string }> = [];

const mailer: AuthMailer = {
  async sendVerification(message) {
    sent.push({ kind: "verification", to: message.to, url: message.url });
  },
  async sendPasswordReset(message) {
    sent.push({ kind: "reset", to: message.to, url: message.url });
  },
};

async function applyInitialMigration(): Promise<void> {
  const drizzlePath = fileURLToPath(new URL("../drizzle", import.meta.url));
  const migrationName = (await readdir(drizzlePath)).find((name) => /^0000_.*\.sql$/.test(name));
  if (!migrationName) throw new Error("Initial database migration not found");
  const migration = await readFile(`${drizzlePath}/${migrationName}`, "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await pglite.exec(statement);
  }
}

const secondaryValues = new Map<string, string>();
const secondaryStorage = {
  get: (key: string) => secondaryValues.get(key) ?? null,
  getAndDelete(key: string) {
    const value = secondaryValues.get(key) ?? null;
    secondaryValues.delete(key);
    return value;
  },
  increment(key: string) {
    const value = Number(secondaryValues.get(key) ?? "0") + 1;
    secondaryValues.set(key, String(value));
    return value;
  },
  set(key: string, value: string) {
    secondaryValues.set(key, value);
  },
  delete(key: string) {
    secondaryValues.delete(key);
  },
};

beforeAll(applyInitialMigration);
afterAll(() => pglite.close());

describe("authentication foundation", () => {
  it("accepts only internal relative redirect targets", () => {
    expect(safeInternalPath("/dashboard?tab=usage")).toBe("/dashboard?tab=usage");
    expect(safeInternalPath("https://attacker.example/path")).toBe("/dashboard");
    expect(safeInternalPath("//attacker.example/path")).toBe("/dashboard");
    expect(safeInternalPath("/\\attacker.example")).toBe("/dashboard");
  });

  it("enforces same-origin mutations while leaving Better Auth routes to its CSRF guard", () => {
    const previous = process.env.APP_URL;
    process.env.APP_URL = "https://uno.example";
    expect(() => assertSameOrigin(new Request("https://uno.example/api/dashboard/settings", { method: "POST", headers: { origin: "https://uno.example" } }))).not.toThrow();
    expect(() => assertSameOrigin(new Request("https://uno.example/api/dashboard/settings", { method: "POST", headers: { origin: "https://attacker.example" } }))).toThrow(/Origem/);
    expect(() => assertSameOrigin(new Request("https://uno.example/api/auth/sign-in/email", { method: "POST", headers: { origin: "https://attacker.example" } }))).not.toThrow();
    process.env.APP_URL = previous;
  });

  it("never exposes unknown provider errors in JSON responses", async () => {
    const response = errorResponse(new Error("provider-key-secret"), "req_auth_test");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      requestId: "req_auth_test",
      error: { code: "internal_error", message: "Não foi possível concluir a solicitação." },
    });
    const unavailable = errorResponse(new AppError("service_unavailable", "Missing RESEND_API_KEY", 503), "req_auth_config");
    expect(await unavailable.json()).toEqual({
      requestId: "req_auth_config",
      error: { code: "service_unavailable", message: "Serviço temporariamente indisponível." },
    });
  });

  it("creates a verified-email account boundary and provisions one repair-safe free organization", async () => {
    const auth = createUnoAuth({
      database,
      mailer,
      secondaryStorage,
      environment: {
        secret: "test-secret-with-at-least-thirty-two-characters",
        baseURL: "http://uno.test",
        appURL: "http://uno.test",
        adminEmails: new Set(["owner@example.test"]),
        production: false,
      },
      provisionUser: (created) => ensureDefaultOrganization(created, database as never),
    });

    const response = await auth.handler(new Request("http://uno.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://uno.test" },
      body: JSON.stringify({ name: "Pessoa Teste", email: "OWNER@EXAMPLE.TEST", password: "correct-horse-battery", platformRole: "USER", callbackURL: "/verify-email?verified=1" }),
    }));
    expect(response.status).toBe(200);

    const users = await pglite.query<{ id: string; email: string; platform_role: string }>("select id, email, platform_role from \"user\"");
    const created = users.rows[0];
    expect(created?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created).toMatchObject({ email: "owner@example.test", platform_role: "ADMIN" });
    expect(sent).toContainEqual(expect.objectContaining({ kind: "verification", to: "owner@example.test" }));

    const blockedSignIn = await auth.handler(new Request("http://uno.test/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://uno.test" },
      body: JSON.stringify({ email: "owner@example.test", password: "correct-horse-battery" }),
    }));
    expect(blockedSignIn.status).toBe(403);

    const verificationMessage = sent.find((message) => message.kind === "verification");
    expect(verificationMessage).toBeDefined();
    const verified = await auth.handler(new Request(verificationMessage!.url, {
      method: "GET",
      headers: { origin: "http://uno.test" },
    }));
    expect(verified.status).toBe(302);
    const verifiedUser = await pglite.query<{ email_verified: boolean }>("select email_verified from \"user\" where id = $1", [created!.id]);
    expect(verifiedUser.rows[0]?.email_verified).toBe(true);

    const signedIn = await auth.handler(new Request("http://uno.test/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://uno.test" },
      body: JSON.stringify({ email: "owner@example.test", password: "correct-horse-battery" }),
    }));
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("set-cookie")).toContain("better-auth.session_token");

    const resetRequested = await auth.handler(new Request("http://uno.test/api/auth/request-password-reset", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://uno.test" },
      body: JSON.stringify({ email: "owner@example.test", redirectTo: "/reset-password" }),
    }));
    expect(resetRequested.status).toBe(200);
    const resetMessage = sent.find((message) => message.kind === "reset");
    expect(resetMessage).toBeDefined();
    const resetCallback = await auth.handler(new Request(resetMessage!.url, {
      method: "GET",
      headers: { origin: "http://uno.test" },
    }));
    expect(resetCallback.status).toBe(302);
    const resetLocation = resetCallback.headers.get("location");
    const resetToken = resetLocation ? new URL(resetLocation).searchParams.get("token") : null;
    expect(resetToken).toBeTruthy();
    const passwordReset = await auth.handler(new Request("http://uno.test/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://uno.test" },
      body: JSON.stringify({ newPassword: "new-correct-horse-battery", token: resetToken }),
    }));
    expect(passwordReset.status).toBe(200);
    const oldCookie = signedIn.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
    const revokedSession = await auth.api.getSession({ headers: new Headers({ cookie: oldCookie }) });
    expect(revokedSession).toBeNull();

    const newPassword = await auth.handler(new Request("http://uno.test/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://uno.test" },
      body: JSON.stringify({ email: "owner@example.test", password: "new-correct-horse-battery" }),
    }));
    expect(newPassword.status).toBe(200);
    await ensureDefaultOrganization({ id: created!.id, name: "Pessoa Teste" }, database as never);
    const provisioned = await pglite.query<{ organizations: number; memberships: number; subscriptions: number; plan_id: string }>(`
      select
        (select count(*)::integer from organizations where owner_user_id = $1) as organizations,
        (select count(*)::integer from memberships where user_id = $1 and role = 'OWNER') as memberships,
        (select count(*)::integer from subscriptions where organization_id = $1) as subscriptions,
        (select plan_id::text from subscriptions where organization_id = $1) as plan_id
    `, [created!.id]);
    expect(provisioned.rows[0]).toEqual({ organizations: 1, memberships: 1, subscriptions: 1, plan_id: "FREE" });
  });

  it("uses the approved default organization display name", () => {
    expect(defaultOrganizationName(" Ana ")).toBe("Organização de Ana");
  });
});
