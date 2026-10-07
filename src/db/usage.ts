import { sql } from "drizzle-orm";

import { getDb, type UnoDatabase } from "./index";
import type { UsageReservation } from "./usage.types";

export class QuotaExceededError extends Error {
  readonly code = "quota_exceeded";

  constructor() {
    super("The organization has no remaining usage for this billing period.");
    this.name = "QuotaExceededError";
  }
}

export type ReserveUsageInput = {
  reservationId: string;
  organizationId: string;
  usagePeriodId: string;
  conversionId: string;
  units?: number;
};

type UsageDatabase = Pick<UnoDatabase, "execute">;

function reservationFromRows(rows: unknown[]): UsageReservation {
  const reservation = rows[0] as UsageReservation | undefined;
  if (!reservation) throw new Error("Usage reservation was not returned by PostgreSQL");
  return reservation;
}

function mapQuotaError(error: unknown): never {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4 && candidate; depth += 1) {
    if (candidate instanceof Error && candidate.message.includes("quota_exceeded")) {
      throw new QuotaExceededError();
    }
    candidate = typeof candidate === "object" && "cause" in candidate
      ? (candidate as { cause?: unknown }).cause
      : undefined;
  }
  throw error;
}

/** Calls the database function that locks the period and reserves quota once. */
export async function reserveUsage(
  input: ReserveUsageInput,
  db: UsageDatabase = getDb(),
): Promise<UsageReservation> {
  const units = input.units ?? 1;
  if (!Number.isInteger(units) || units <= 0) throw new RangeError("units must be a positive integer");

  try {
    const result = await db.execute(sql`
      select * from reserve_usage(
        ${input.reservationId},
        ${input.organizationId},
        ${input.usagePeriodId},
        ${input.conversionId},
        ${units}
      )
    `);
    return reservationFromRows(result.rows);
  } catch (error) {
    return mapQuotaError(error);
  }
}

export async function confirmUsage(
  reservationId: string,
  organizationId: string,
  db: UsageDatabase = getDb(),
): Promise<UsageReservation> {
  const result = await db.execute(sql`
    select * from confirm_usage(${reservationId}, ${organizationId})
  `);
  return reservationFromRows(result.rows);
}

export async function releaseUsage(
  reservationId: string,
  organizationId: string,
  db: UsageDatabase = getDb(),
): Promise<UsageReservation> {
  const result = await db.execute(sql`
    select * from release_usage(${reservationId}, ${organizationId})
  `);
  return reservationFromRows(result.rows);
}
