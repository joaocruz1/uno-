import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";

import * as schema from "@/db/schema";
import { brPhoneSchema, PHONE_REQUIRED_MESSAGE } from "@/lib/phone";
import type { AuthSecondaryStorage } from "@/server/redis";

import type { AuthMailer } from "./email";
import type { ProvisionedUser } from "./organization";

type AuthDatabase = Parameters<typeof drizzleAdapter>[0];

export type UnoAuthEnvironment = {
  secret: string;
  baseURL: string;
  appURL: string;
  adminEmails: ReadonlySet<string>;
  production: boolean;
  /** Google sign-in. Registered only when both values are configured. */
  google?: { clientId: string; clientSecret: string };
};

export type UnoAuthDependencies = {
  database: AuthDatabase;
  mailer: AuthMailer;
  environment: UnoAuthEnvironment;
  provisionUser(user: ProvisionedUser): Promise<unknown>;
  secondaryStorage?: AuthSecondaryStorage;
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createUnoAuth(dependencies: UnoAuthDependencies) {
  const { database, environment, mailer, provisionUser, secondaryStorage } = dependencies;

  const auth = betterAuth({
    appName: "UNO",
    secret: environment.secret,
    baseURL: environment.baseURL,
    trustedOrigins: [new URL(environment.appURL).origin, new URL(environment.baseURL).origin],
    database: drizzleAdapter(database, {
      provider: "pg",
      schema,
      transaction: true,
    }),
    secondaryStorage,
    session: {
      storeSessionInDatabase: true,
    },
    verification: {
      storeInDatabase: true,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 30,
      storage: secondaryStorage ? "secondary-storage" : "memory",
    },
    advanced: {
      database: { generateId: "uuid" },
      useSecureCookies: environment.production,
    },
    user: {
      additionalFields: {
        platformRole: {
          type: "string",
          required: true,
          defaultValue: "USER",
          input: false,
        },
        // NEX-51: required at e-mail sign-up (enforced in the create hook below, so
        // Google sign-ups and older accounts still work and are asked for it later).
        // Every write, sign-up and /update-user alike, is normalized to E.164.
        phone: {
          type: "string",
          required: false,
          input: true,
          validator: { input: brPhoneSchema },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      // Owner decision (NEX-42): confirmation never blocks normal use. Sign-up
      // signs the person in at once. A verified e-mail is still required for
      // platform administration and for accepting organization invitations.
      requireEmailVerification: false,
      autoSignIn: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user, url }) {
        await mailer.sendPasswordReset({ to: user.email, name: user.name, url });
      },
    },
    // Kept configured so a person can still confirm the address on request
    // (/verify-email and the invitation screen).
    emailVerification: {
      sendOnSignUp: false,
      sendOnSignIn: false,
      // Confirmation is optional, so an account may have been created by someone
      // who does not own the inbox. Clicking the link must never hand that
      // account to the inbox owner, nor leave the creator signed in.
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60,
      async sendVerificationEmail({ user, url }) {
        await mailer.sendVerification({ to: user.email, name: user.name, url });
      },
      async afterEmailVerification(verified) {
        const { internalAdapter } = await auth.$context;
        await internalAdapter.deleteUserSessions(verified.id);
        // A platform-admin address only becomes admin with a password set by the inbox owner.
        if (environment.adminEmails.has(normalizeEmail(verified.email))) {
          const accounts = await internalAdapter.findAccounts(verified.id);
          for (const account of accounts) {
            if (account.providerId === "credential") await internalAdapter.deleteAccount(account.id);
          }
        }
      },
    },
    ...(environment.google ? {
      socialProviders: {
        google: {
          clientId: environment.google.clientId,
          clientSecret: environment.google.clientSecret,
          prompt: "select_account" as const,
        },
      },
    } : {}),
    // Default account linking stays on: requireLocalEmailVerified (default true)
    // keeps Google from implicitly linking onto an unverified password account.
    databaseHooks: {
      user: {
        create: {
          async before(candidate, context) {
            // Owner decision (NEX-51): a phone is mandatory for e-mail sign-up.
            if (context?.path === "/sign-up/email" && !(candidate as { phone?: unknown }).phone) {
              throw APIError.from("BAD_REQUEST", { code: "PHONE_REQUIRED", message: PHONE_REQUIRED_MESSAGE });
            }
            const email = normalizeEmail(candidate.email);
            return {
              data: {
                ...candidate,
                email,
                platformRole: environment.adminEmails.has(email) ? "ADMIN" : "USER",
              },
            };
          },
          async after(created) {
            await provisionUser({ id: created.id, name: created.name });
          },
        },
      },
    },
    // nextCookies must remain the last plugin so Server Actions receive every
    // Set-Cookie header emitted by Better Auth.
    plugins: [nextCookies()],
  });
  return auth;
}

export type UnoAuth = ReturnType<typeof createUnoAuth>;
