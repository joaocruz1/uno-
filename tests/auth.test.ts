import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { friendlyAuthError, oauthCallbackError } from "@/components/auth/auth-errors";
import type { UnoDatabase } from "@/db";
import * as schema from "@/db/schema";
import { safeInternalPath } from "@/lib/auth-client";
import { authQuery, checkoutPath, choseFreePlan, loginDestination, parsePlanParam, registerDestination } from "@/lib/checkout-intent";
import { googleOAuthEnvironment, googleSignInEnabled } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { createUnoAuth, ensureDefaultOrganization } from "@/server/auth";
import type { AuthMailer } from "@/server/auth";
import { isPlatformAdmin, requireIdentity, resolveActor } from "@/server/auth/actor";
import type { UnoAuth, UnoAuthEnvironment } from "@/server/auth/config";
import { defaultOrganizationName } from "@/server/auth/organization";
import { assertSameOrigin, errorResponse } from "@/server/http";

// requireIdentity resolves the session through getAuth(); point it at the test instance.
const authHolder = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@/server/auth/index", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/auth/index")>();
  return {
    ...original,
    getAuth: () => {
      if (!authHolder.current) throw new Error("test auth not configured");
      return authHolder.current;
    },
  };
});

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

async function applyMigrations(): Promise<void> {
  const drizzlePath = fileURLToPath(new URL("../drizzle", import.meta.url));
  const names = (await readdir(drizzlePath)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  if (!names.length) throw new Error("Database migrations not found");
  for (const name of names) {
    const migration = await readFile(`${drizzlePath}/${name}`, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await pglite.exec(statement);
    }
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

function testAuth(overrides: Partial<UnoAuthEnvironment> = {}): UnoAuth {
  return createUnoAuth({
    database,
    mailer,
    secondaryStorage,
    environment: {
      secret: "test-secret-with-at-least-thirty-two-characters",
      baseURL: "http://uno.test",
      appURL: "http://uno.test",
      adminEmails: new Set(["owner@example.test"]),
      production: false,
      ...overrides,
    },
    provisionUser: (created) => ensureDefaultOrganization(created, database as never),
  });
}

function sessionCookie(response: Response): string {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

function socialSignIn(): Request {
  return new Request("http://uno.test/api/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://uno.test" },
    body: JSON.stringify({ provider: "google", callbackURL: "/dashboard", newUserCallbackURL: "/checkout", errorCallbackURL: "/login" }),
  });
}

beforeAll(applyMigrations);
afterAll(() => pglite.close());

describe("authentication foundation", () => {
  it("accepts only internal relative redirect targets", () => {
    expect(safeInternalPath("/dashboard?tab=usage")).toBe("/dashboard?tab=usage");
    expect(safeInternalPath("https://attacker.example/path")).toBe("/dashboard");
    for (const sneaky of ["/.//evil.com", "/..//evil.com", "/%2e//evil.com", "/a/..//evil.com"]) {
      expect(safeInternalPath(sneaky)).toBe("/dashboard");
    }
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

  it("signs up and signs in at once without e-mail confirmation, keeps manual confirmation and password reset", async () => {
    const previousAdmins = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = "owner@example.test";
    const auth = testAuth();
    authHolder.current = auth;

    const response = await auth.handler(new Request("http://uno.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://uno.test" },
      body: JSON.stringify({ name: "Pessoa Teste", email: "OWNER@EXAMPLE.TEST", password: "correct-horse-battery", platformRole: "USER" }),
    }));
    expect(response.status).toBe(200);
    // Auto sign-in: the sign-up response already carries the session.
    expect(response.headers.get("set-cookie")).toContain("better-auth.session_token");
    const signUpCookie = sessionCookie(response);

    const users = await pglite.query<{ id: string; email: string; platform_role: string; email_verified: boolean }>("select id, email, platform_role, email_verified from \"user\"");
    const created = users.rows[0];
    expect(created?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created).toMatchObject({ email: "owner@example.test", platform_role: "ADMIN", email_verified: false });
    // Nothing is sent automatically any more.
    expect(sent.filter((message) => message.kind === "verification")).toHaveLength(0);

    // Immediate access to the product without confirming the address.
    const identity = await requireIdentity(new Headers({ cookie: signUpCookie }), database as unknown as UnoDatabase);
    expect(identity).toMatchObject({ userId: created!.id, email: "owner@example.test", platformRole: "ADMIN", emailVerified: false });
    const actor = await resolveActor(identity, undefined, database as unknown as UnoDatabase);
    expect(actor).toMatchObject({ membershipRole: "OWNER", planId: "FREE" });
    // ...but platform administration still requires a confirmed e-mail.
    expect(isPlatformAdmin(identity)).toBe(false);

    const signedInUnverified = await auth.handler(new Request("http://uno.test/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://uno.test" },
      body: JSON.stringify({ email: "owner@example.test", password: "correct-horse-battery" }),
    }));
    expect(signedInUnverified.status).toBe(200);
    expect(sent.filter((message) => message.kind === "verification")).toHaveLength(0);

    // Manual confirmation (the /verify-email page and the invitation screen).
    const requested = await auth.handler(new Request("http://uno.test/api/auth/send-verification-email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://uno.test", cookie: signUpCookie },
      body: JSON.stringify({ email: "owner@example.test", callbackURL: "/invite" }),
    }));
    expect(requested.status).toBe(200);
    const verificationMessage = sent.find((message) => message.kind === "verification");
    expect(verificationMessage).toMatchObject({ to: "owner@example.test" });
    const verified = await auth.handler(new Request(verificationMessage!.url, {
      method: "GET",
      headers: { origin: "http://uno.test" },
    }));
    expect(verified.status).toBe(302);
    const verifiedUser = await pglite.query<{ email_verified: boolean }>("select email_verified from \"user\" where id = $1", [created!.id]);
    expect(verifiedUser.rows[0]?.email_verified).toBe(true);
    // Confirming never hands the account over: every session ends, including the creator's...
    await expect(requireIdentity(new Headers({ cookie: signUpCookie }), database as unknown as UnoDatabase)).rejects.toMatchObject({ code: "unauthorized" });
    expect(verified.headers.get("set-cookie") ?? "").not.toContain("better-auth.session_token=");
    // ...and a platform-admin address loses the password chosen before confirmation.
    const staleLogin = await auth.handler(new Request("http://uno.test/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://uno.test" },
      body: JSON.stringify({ email: "owner@example.test", password: "correct-horse-battery" }),
    }));
    expect(staleLogin.status).toBe(401);

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
    // The inbox owner sets a new password and only then reaches administration.
    const signedIn = await auth.handler(new Request("http://uno.test/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://uno.test" },
      body: JSON.stringify({ email: "owner@example.test", password: "new-correct-horse-battery" }),
    }));
    expect(signedIn.status).toBe(200);
    const confirmedIdentity = await requireIdentity(new Headers({ cookie: sessionCookie(signedIn) }), database as unknown as UnoDatabase);
    expect(confirmedIdentity.emailVerified).toBe(true);
    expect(isPlatformAdmin(confirmedIdentity)).toBe(true);

    await ensureDefaultOrganization({ id: created!.id, name: "Pessoa Teste" }, database as never);
    const provisioned = await pglite.query<{ organizations: number; memberships: number; subscriptions: number; plan_id: string }>(`
      select
        (select count(*)::integer from organizations where owner_user_id = $1) as organizations,
        (select count(*)::integer from memberships where user_id = $1 and role = 'OWNER') as memberships,
        (select count(*)::integer from subscriptions where organization_id = $1) as subscriptions,
        (select plan_id::text from subscriptions where organization_id = $1) as plan_id
    `, [created!.id]);
    expect(provisioned.rows[0]).toEqual({ organizations: 1, memberships: 1, subscriptions: 1, plan_id: "FREE" });

    if (previousAdmins === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previousAdmins;
  });

  it("registers Google sign-in only when both credentials are configured", async () => {
    expect(googleOAuthEnvironment({ GOOGLE_CLIENT_ID: " id ", GOOGLE_CLIENT_SECRET: " secret " })).toEqual({ clientId: "id", clientSecret: "secret" });
    expect(googleOAuthEnvironment({ GOOGLE_CLIENT_ID: "id" })).toBeUndefined();
    expect(googleOAuthEnvironment({ GOOGLE_CLIENT_SECRET: "secret" })).toBeUndefined();
    expect(googleSignInEnabled({})).toBe(false);

    const withoutGoogle = testAuth();
    expect(withoutGoogle.options.socialProviders).toBeUndefined();
    const refused = await withoutGoogle.handler(socialSignIn());
    expect(refused.status).not.toBe(200);

    const withGoogle = testAuth({ google: { clientId: "synthetic-client.apps.googleusercontent.com", clientSecret: "synthetic-secret" } });
    expect(withGoogle.options.socialProviders?.google).toBeDefined();
    const started = await withGoogle.handler(socialSignIn());
    expect(started.status).toBe(200);
    const { url } = await started.json() as { url: string };
    const authorization = new URL(url);
    expect(authorization.hostname).toBe("accounts.google.com");
    expect(authorization.searchParams.get("client_id")).toBe("synthetic-client.apps.googleusercontent.com");
    expect(authorization.searchParams.get("redirect_uri")).toBe("http://uno.test/api/auth/callback/google");
  });

  it("validates the plan parameter and routes new accounts to checkout", () => {
    expect(parsePlanParam("pro")).toBe("PRO");
    expect(parsePlanParam(" Starter ")).toBe("STARTER");
    expect(parsePlanParam(["business", "pro"])).toBe("BUSINESS");
    expect(parsePlanParam("free")).toBeUndefined();
    expect(parsePlanParam("enterprise")).toBeUndefined();
    expect(parsePlanParam("PRO".repeat(10))).toBeUndefined();
    expect(parsePlanParam(undefined)).toBeUndefined();
    expect(choseFreePlan("FREE")).toBe(true);
    expect(choseFreePlan("pro")).toBe(false);

    expect(checkoutPath()).toBe("/checkout");
    expect(checkoutPath("PRO")).toBe("/checkout?plan=pro");
    expect(registerDestination(undefined, undefined)).toBe("/checkout");
    expect(registerDestination(undefined, "BUSINESS")).toBe("/checkout?plan=business");
    expect(registerDestination(undefined, undefined, true)).toBe("/dashboard");
    expect(registerDestination("/invite", "PRO")).toBe("/invite");
    expect(registerDestination("https://attacker.example", "PRO")).toBe("/checkout?plan=pro");
    expect(loginDestination(undefined, undefined)).toBe("/dashboard");
    expect(loginDestination(undefined, "STARTER")).toBe("/checkout?plan=starter");
    expect(loginDestination("/dashboard/history", "STARTER")).toBe("/dashboard/history");
    expect(loginDestination("//attacker.example", undefined)).toBe("/dashboard");
    expect(authQuery("/invite", "PRO")).toBe("?callbackURL=%2Finvite&plan=pro");
    expect(authQuery("https://attacker.example", undefined)).toBe("");
  });

  it("explains OAuth failures in pt-BR without leaking unknown codes", () => {
    expect(oauthCallbackError("account_not_linked")).toBe("Este e-mail já tem cadastro com senha. Entre com e-mail e senha.");
    expect(friendlyAuthError("ACCOUNT_NOT_LINKED")).toBe("Este e-mail já tem cadastro com senha. Entre com e-mail e senha.");
    expect(oauthCallbackError("<script>")).toBeUndefined();
    expect(oauthCallbackError(undefined)).toBeUndefined();
    expect(oauthCallbackError("something_new")).toBe("Não foi possível concluir. Tente novamente.");
  });

  it("uses the approved default organization display name", () => {
    expect(defaultOrganizationName(" Ana ")).toBe("Organização de Ana");
  });
});
