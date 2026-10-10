import { z } from "zod";

export const referralProgressSchema = z.object({
  code: z.string(),
  signups: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  goal: z.number().int().positive(),
  rewarded: z.boolean(),
  eligible: z.boolean(),
});

export type ReferralProgress = z.infer<typeof referralProgressSchema>;
