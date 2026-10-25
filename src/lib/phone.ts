import { z } from "zod";

/** Area codes (DDD) in use in Brazil, per Anatel's national numbering plan. */
export const BR_AREA_CODES: ReadonlySet<string> = new Set([
  "11", "12", "13", "14", "15", "16", "17", "18", "19",
  "21", "22", "24", "27", "28",
  "31", "32", "33", "34", "35", "37", "38",
  "41", "42", "43", "44", "45", "46", "47", "48", "49",
  "51", "53", "54", "55",
  "61", "62", "63", "64", "65", "66", "67", "68", "69",
  "71", "73", "74", "75", "77", "79",
  "81", "82", "83", "84", "85", "86", "87", "88", "89",
  "91", "92", "93", "94", "95", "96", "97", "98", "99",
]);

export const PHONE_REQUIRED_MESSAGE = "Informe seu telefone com DDD.";
export const PHONE_INVALID_MESSAGE = "Informe um telefone válido com DDD, como (11) 98765-4321.";

/** The national digits (DDD + number) of an input, dropping a leading +55/55 country code. */
export function nationalDigits(input: string): string {
  let digits = input.replace(/\D/g, "");
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) digits = digits.slice(2);
  // A trunk prefix "0" before the DDD, as in 0 11 98765-4321.
  if ((digits.length === 11 || digits.length === 12) && digits.startsWith("0")) digits = digits.slice(1);
  return digits;
}

/**
 * Normalizes a Brazilian phone to E.164 (+55DDNNNNNNNNN), or null when invalid:
 * a known DDD followed by a 9-digit mobile (starting with 9) or an 8-digit
 * landline (starting with 2 to 5).
 */
export function normalizeBrPhone(input: string): string | null {
  if (typeof input !== "string" || input.length > 32) return null;
  const digits = nationalDigits(input);
  if (digits.length !== 10 && digits.length !== 11) return null;
  const areaCode = digits.slice(0, 2);
  const number = digits.slice(2);
  if (!BR_AREA_CODES.has(areaCode)) return null;
  if (number.length === 9 && number[0] !== "9") return null;
  if (number.length === 8 && !/^[2-5]/.test(number)) return null;
  if (/^(\d)\1+$/.test(number)) return null;
  return `+55${digits}`;
}

/** Input mask: "(11) 98765-4321" or "(11) 3456-7890", applied while typing. */
export function maskBrPhone(input: string): string {
  const digits = nationalDigits(input).slice(0, 11);
  if (digits.length === 0) return "";
  if (digits.length <= 2) return `(${digits}`;
  const area = digits.slice(0, 2);
  const rest = digits.slice(2);
  if (rest.length <= 4) return `(${area}) ${rest}`;
  const split = rest.length === 9 ? 5 : 4;
  return `(${area}) ${rest.slice(0, split)}-${rest.slice(split)}`;
}

/** Display form of a stored E.164 number; anything unexpected is shown as stored. */
export function formatBrPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const normalized = normalizeBrPhone(e164);
  return normalized ? maskBrPhone(normalized.slice(3)) : e164;
}

/** Server-side validator: accepts any typed form and yields the E.164 value. */
export const brPhoneSchema = z.string({ error: PHONE_INVALID_MESSAGE }).transform((value, context) => {
  const normalized = normalizeBrPhone(value);
  if (!normalized) {
    context.addIssue({ code: "custom", message: PHONE_INVALID_MESSAGE });
    return z.NEVER;
  }
  return normalized;
});
