import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\x00-\x1f\x7f]/u.test(value));
const quantity = z.number().int().min(1).max(9_999);

/** A single product printed in the items table. Supplied by the caller, never read from the PDF. */
export const productHeaderSchema = z.object({
  quantity,
  title: text(140),
  sku: text(60).optional(),
  variation: text(60).optional(),
}).strict();

/** One order line; the SKU or the title identifies it. */
export const pickingItemSchema = z.object({
  quantity,
  title: text(140).optional(),
  sku: text(60).optional(),
  variation: text(60).optional(),
}).strict().refine((item) => item.sku !== undefined || item.title !== undefined, { message: "Informe sku ou title." });

export const MAX_PICKING_ITEMS = 20;

/** Picking data of one conversion: a single product or the order's item list (SKU / Variação / Qtd). */
export const productInputSchema = z.union([
  productHeaderSchema,
  z.object({ items: z.array(pickingItemSchema).min(1).max(MAX_PICKING_ITEMS) }).strict(),
]);

export type PickingItem = z.infer<typeof pickingItemSchema>;
export type ProductHeader = z.infer<typeof productInputSchema>;

/**
 * Multipart form fields of the public API: either quantity, productTitle, sku and
 * variation for one product, or `items` with a JSON array of order lines.
 */
export function parseProductFields(fields: Record<string, string | undefined>): ProductHeader | undefined {
  const { quantity: rawQuantity, productTitle, sku, variation, items } = fields;
  const single = rawQuantity !== undefined || productTitle !== undefined || sku !== undefined || variation !== undefined;
  if (items !== undefined) {
    if (single) throw new Error("Envie items ou os campos de produto único, não os dois.");
    return productInputSchema.parse({ items: JSON.parse(items) as unknown });
  }
  if (!single) return undefined;
  return productHeaderSchema.parse({
    quantity: rawQuantity === undefined ? 1 : /^\d{1,4}$/.test(rawQuantity.trim()) ? Number(rawQuantity.trim()) : Number.NaN,
    title: productTitle,
    ...(sku === undefined ? {} : { sku }),
    ...(variation === undefined ? {} : { variation }),
  });
}
