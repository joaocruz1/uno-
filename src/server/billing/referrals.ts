import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { billingGrants, conversions, getDb, referralCodes, referrals, type UnoDatabase } from "@/db";
import { AppError } from "@/lib/errors";

import { applyGrant as applyGrantDefault } from "./grants";

/** Cookie that carries a referral code from /r/<code> until the referred signs in. */
export const REFERRAL_COOKIE = "uno_ref";
/** Active referrals needed, free days earned, and which plan those days grant. */
export const REFERRAL_GOAL = 3;
export const REFERRAL_REWARD_DAYS = 5;
export const REFERRAL_REWARD_PLAN = "PRO" as const;

function newCode(): string {
  return randomBytes(6).toString("base64url");
}

/** Returns the user's referral code, creating one on first use. */
export async function ensureReferralCode(userId: string, database: UnoDatabase = getDb()): Promise<string> {
  const existing = await database.select({ code: referralCodes.code }).from(referralCodes).where(eq(referralCodes.userId, userId)).limit(1);
  if (existing[0]) return existing[0].code;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newCode();
    try {
      await database.insert(referralCodes).values({ id: randomUUID(), userId, code });
      return code;
    } catch {
      const row = await database.select({ code: referralCodes.code }).from(referralCodes).where(eq(referralCodes.userId, userId)).limit(1);
      if (row[0]) return row[0].code;
    }
  }
  throw new AppError("service_unavailable", "Não foi possível gerar o link de indicação.", 503);
}

export async function resolveReferralCode(code: string, database: UnoDatabase = getDb()): Promise<string | null> {
  const rows = await database.select({ userId: referralCodes.userId }).from(referralCodes).where(eq(referralCodes.code, code)).limit(1);
  return rows[0]?.userId ?? null;
}

/**
 * Links a referred user to the referrer behind a code. One referrer per referred
 * (immutable) and never self; a repeated call is a no-op.
 */
export async function linkReferral(
  input: { code: string; referredUserId: string; signupIpHash?: string },
  database: UnoDatabase = getDb(),
): Promise<{ linked: boolean }> {
  const referrerUserId = await resolveReferralCode(input.code, database);
  if (!referrerUserId || referrerUserId === input.referredUserId) return { linked: false };
  const existing = await database.select({ id: referrals.id }).from(referrals).where(eq(referrals.referredUserId, input.referredUserId)).limit(1);
  if (existing[0]) return { linked: false };
  try {
    await database.insert(referrals).values({
      id: randomUUID(),
      referrerUserId,
      referredUserId: input.referredUserId,
      signupIpHash: input.signupIpHash ?? null,
    });
    return { linked: true };
  } catch {
    // Lost a race on the unique referred-user index: already linked.
    return { linked: false };
  }
}

/** Referred users whose personal organization has at least one completed conversion. */
async function countActive(referrerUserId: string, database: UnoDatabase): Promise<{ signups: number; active: number }> {
  const referred = await database.select({ id: referrals.referredUserId }).from(referrals).where(eq(referrals.referrerUserId, referrerUserId));
  const ids = referred.map((row) => row.id);
  if (ids.length === 0) return { signups: 0, active: 0 };
  // The personal organization id equals the user id (ensureDefaultOrganization).
  const activeRows = await database.selectDistinct({ organizationId: conversions.organizationId }).from(conversions)
    .where(and(inArray(conversions.organizationId, ids), eq(conversions.status, "completed")));
  return { signups: ids.length, active: activeRows.length };
}

export type ReferralProgress = {
  code: string;
  signups: number;
  active: number;
  goal: number;
  rewarded: boolean;
  eligible: boolean;
};

export async function referralProgress(referrerUserId: string, database: UnoDatabase = getDb()): Promise<ReferralProgress> {
  const code = await ensureReferralCode(referrerUserId, database);
  const { signups, active } = await countActive(referrerUserId, database);
  const rewarded = await rewardGranted(referrerUserId, database);
  return { code, signups, active, goal: REFERRAL_GOAL, rewarded, eligible: active >= REFERRAL_GOAL && !rewarded };
}

/** The once-ever referral reward is a billing grant keyed by the referrer. */
function rewardExternalRef(referrerUserId: string): string {
  return `referral:${referrerUserId}`;
}

async function rewardGranted(referrerUserId: string, database: UnoDatabase): Promise<boolean> {
  const rows = await database.select({ id: billingGrants.id }).from(billingGrants).where(eq(billingGrants.externalRef, rewardExternalRef(referrerUserId))).limit(1);
  return Boolean(rows[0]);
}

/**
 * Grants the referral reward to the referrer's personal organization once they
 * reach the goal of active referrals. Idempotent (the grant's external_ref is
 * unique), so calling it repeatedly or below the goal is safe.
 */
export async function claimReferralReward(
  referrerUserId: string,
  database: UnoDatabase = getDb(),
  now: Date = new Date(),
  applyGrant = applyGrantDefault,
): Promise<{ rewarded: boolean }> {
  const { active } = await countActive(referrerUserId, database);
  if (active < REFERRAL_GOAL) return { rewarded: false };
  // applyGrant is idempotent by external_ref: applied on the first claim, a
  // no-op afterwards. Either way the reward is in place.
  await applyGrant({
    organizationId: referrerUserId,
    planId: REFERRAL_REWARD_PLAN,
    days: REFERRAL_REWARD_DAYS,
    source: "REFERRAL",
    externalRef: rewardExternalRef(referrerUserId),
  }, database, now);
  return { rewarded: true };
}
