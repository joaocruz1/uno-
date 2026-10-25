import { paidPlanIdSchema, type PaidPlanId } from "./billing-model";
import { safeInternalPath } from "./safe-path";

/**
 * Reads the `plan` query parameter that marketing pages pass to sign-up and
 * sign-in (`/register?plan=pro`). Only the paid plan ids are accepted, case
 * insensitively; anything else (including `free`) is ignored.
 */
export function parsePlanParam(value: unknown): PaidPlanId | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== "string" || candidate.length > 16) return undefined;
  const parsed = paidPlanIdSchema.safeParse(candidate.trim().toUpperCase());
  return parsed.success ? parsed.data : undefined;
}

/** Whether the visitor explicitly chose the free plan (`?plan=free`). */
export function choseFreePlan(value: unknown): boolean {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate.trim().toUpperCase() === "FREE";
}

/** The checkout page, with the chosen plan preselected when there is one. */
export function checkoutPath(plan?: PaidPlanId): string {
  return plan ? `/checkout?plan=${plan.toLowerCase()}` : "/checkout";
}


/** A safe explicit destination, or "" when none (or an unsafe one) was given. */
export function explicitDestination(callbackURL: string | undefined): string {
  return callbackURL ? safeInternalPath(callbackURL, "") : "";
}

/**
 * Where a successful sign-in goes: a safe explicit callbackURL first, then the
 * checkout when a plan was chosen on the pricing page, else the dashboard.
 */
export function loginDestination(callbackURL: string | undefined, plan: PaidPlanId | undefined): string {
  return explicitDestination(callbackURL) || (plan ? checkoutPath(plan) : "/dashboard");
}

/**
 * Where a new account goes right after sign-up (NEX-42): a safe explicit
 * callbackURL (an invitation, for example), the dashboard when the visitor
 * explicitly chose the free plan, else straight to checkout.
 */
export function registerDestination(callbackURL: string | undefined, plan: PaidPlanId | undefined, freePlan = false): string {
  const explicit = explicitDestination(callbackURL);
  if (explicit) return explicit;
  if (freePlan && !plan) return "/dashboard";
  return checkoutPath(plan);
}

/** Query string that carries the destination and plan between /login and /register. */
export function authQuery(callbackURL: string | undefined, plan: string | undefined): string {
  const query = new URLSearchParams();
  const explicit = explicitDestination(callbackURL);
  if (explicit) query.set("callbackURL", explicit);
  if (plan) query.set("plan", plan.toLowerCase());
  return query.size ? `?${query.toString()}` : "";
}
