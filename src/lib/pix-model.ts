import { z } from "zod";

export const pixPurchaseViewSchema = z.object({
  id: z.string(),
  status: z.enum(["PENDING", "APPROVED", "EXPIRED", "FAILED"]),
  amountBrlCents: z.number().int().nonnegative(),
  qrCode: z.string().nullable(),
  qrCodeBase64: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

export type PixPurchaseView = z.infer<typeof pixPurchaseViewSchema>;
