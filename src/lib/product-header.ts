import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\x00-\x1f\x7f]/u.test(value));

/** Optional picking data printed above the label. Supplied by the caller, never read from the PDF. */
export const productHeaderSchema = z.object({
  quantity: z.number().int().min(1).max(9_999),
  title: text(140),
  sku: text(60).optional(),
  variation: text(60).optional(),
}).strict();

export type ProductHeader = z.infer<typeof productHeaderSchema>;

/** Multipart form fields of the public API: quantity, productTitle, sku, variation. */
export function parseProductFields(fields: Record<string, string | undefined>): ProductHeader | undefined {
  const { quantity, productTitle, sku, variation } = fields;
  if (quantity === undefined && productTitle === undefined && sku === undefined && variation === undefined) return undefined;
  return productHeaderSchema.parse({
    quantity: quantity === undefined ? 1 : /^\d{1,4}$/.test(quantity.trim()) ? Number(quantity.trim()) : Number.NaN,
    title: productTitle,
    ...(sku === undefined ? {} : { sku }),
    ...(variation === undefined ? {} : { variation }),
  });
}
