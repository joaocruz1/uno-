import { z } from "zod";
export const planIdSchema = z.enum(["FREE", "STARTER", "PRO", "BUSINESS"]);
export type PlanId = z.infer<typeof planIdSchema>;
export const PLANS = { FREE: { name: "Free", price: 0, monthlyLimit: 10, maxFileMB: 5, batchLimit: 1, retentionDays: 7, api: false, rateLimit: 0 }, STARTER: { name: "Starter", price: 29, monthlyLimit: 300, maxFileMB: 20, batchLimit: 50, retentionDays: 30, api: false, rateLimit: 0 }, PRO: { name: "Pro", price: 59, monthlyLimit: 2000, maxFileMB: 50, batchLimit: 100, retentionDays: 90, api: true, rateLimit: 60 }, BUSINESS: { name: "Business", price: 149, monthlyLimit: 10000, maxFileMB: 100, batchLimit: 500, retentionDays: 180, api: true, rateLimit: 120 } } as const;
