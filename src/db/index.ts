import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

type UnoDatabase = NodePgDatabase<typeof schema>;

type DatabaseState = {
  pool?: Pool;
  db?: UnoDatabase;
};

const globalDatabase = globalThis as typeof globalThis & {
  __unoDatabase?: DatabaseState;
};

const state = globalDatabase.__unoDatabase ?? {};

if (process.env.NODE_ENV !== "production") {
  globalDatabase.__unoDatabase = state;
}

function databaseUrl(): string {
  const value = process.env.DATABASE_URL;

  if (!value) {
    throw new Error("DATABASE_URL is required when the database is used");
  }

  return value;
}

/**
 * Returns the shared Drizzle client. Environment validation and pool creation
 * are intentionally deferred until the first query path calls this function,
 * so static Next.js builds can import database-backed modules without secrets.
 */
export function getDb(): UnoDatabase {
  if (state.db) return state.db;

  const configuredMax = Number.parseInt(process.env.DATABASE_POOL_MAX ?? "10", 10);
  const max = Number.isInteger(configuredMax) && configuredMax > 0 ? configuredMax : 10;

  state.pool = new Pool({
    connectionString: databaseUrl(),
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: process.env.NODE_ENV !== "production",
  });
  state.db = drizzle(state.pool, { schema });

  return state.db;
}

export async function closeDb(): Promise<void> {
  if (!state.pool) return;

  await state.pool.end();
  state.pool = undefined;
  state.db = undefined;
}

export type { UnoDatabase };
export * from "./schema";
