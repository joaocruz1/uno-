import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";

import * as schema from "@/db/schema";
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

  return betterAuth({
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
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user, url }) {
        await mailer.sendPasswordReset({ to: user.email, name: user.name, url });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60,
      async sendVerificationEmail({ user, url }) {
        await mailer.sendVerification({ to: user.email, name: user.name, url });
      },
    },
    databaseHooks: {
      user: {
        create: {
          async before(candidate) {
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
}

export type UnoAuth = ReturnType<typeof createUnoAuth>;
