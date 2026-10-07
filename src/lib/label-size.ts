import { z } from "zod";
export const outputSizeSchema = z.discriminatedUnion("preset", [
  z.object({ preset: z.enum(["100x150", "100x100", "a6"]) }),
  z.object({ preset: z.literal("custom"), widthMm: z.number().min(50).max(210), heightMm: z.number().min(50).max(300) }),
]);
export type OutputSize = z.infer<typeof outputSizeSchema>;
export function sizeDimensions(size: OutputSize): { widthMm: number; heightMm: number } {
  if (size.preset === "custom") return { widthMm: size.widthMm, heightMm: size.heightMm };
  return size.preset === "a6" ? { widthMm: 105, heightMm: 148 } : { widthMm: 100, heightMm: size.preset === "100x100" ? 100 : 150 };
}
export const mmToPoints = (mm: number) => mm * 72 / 25.4;
export function parseOutputSize(fields: { size?: string | null; widthMm?: string | null; heightMm?: string | null }): OutputSize {
  const preset = fields.size || "100x150";
  return outputSizeSchema.parse(preset === "custom" ? { preset, widthMm: Number(fields.widthMm), heightMm: Number(fields.heightMm) } : { preset });
}
