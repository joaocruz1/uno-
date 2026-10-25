import { describe, expect, it } from "vitest";

import { friendlyAuthError } from "@/components/auth/auth-errors";
import { brPhoneSchema, formatBrPhone, maskBrPhone, normalizeBrPhone } from "@/lib/phone";

describe("Brazilian phone validation (NEX-51)", () => {
  it("normalizes mobiles and landlines to E.164 from any typed form", () => {
    expect(normalizeBrPhone("(11) 98765-4321")).toBe("+5511987654321");
    expect(normalizeBrPhone("11987654321")).toBe("+5511987654321");
    expect(normalizeBrPhone("+55 11 98765-4321")).toBe("+5511987654321");
    expect(normalizeBrPhone("55 21 3456-7890")).toBe("+552134567890");
    expect(normalizeBrPhone("0 11 98765 4321")).toBe("+5511987654321");
    expect(normalizeBrPhone("(48) 2345-6789")).toBe("+554823456789");
  });

  it("rejects unknown area codes, malformed numbers and placeholders", () => {
    for (const invalid of [
      "", "123", "(10) 98765-4321", "(20) 98765-4321", "(23) 3456-7890", "(00) 98765-4321",
      "(11) 88765-4321", // 9 digits must start with 9
      "(11) 1234-5678", "(11) 6234-5678", // 8-digit landlines start with 2–5
      "(11) 99999-9999", "(11) 987654-32100", "+1 415 555 0100", "x".repeat(40),
    ]) {
      expect(normalizeBrPhone(invalid), invalid).toBeNull();
    }
  });

  it("masks while typing and formats stored values", () => {
    expect(maskBrPhone("1")).toBe("(1");
    expect(maskBrPhone("119")).toBe("(11) 9");
    expect(maskBrPhone("1198765")).toBe("(11) 9876-5");
    expect(maskBrPhone("1134567890")).toBe("(11) 3456-7890");
    expect(maskBrPhone("11987654321")).toBe("(11) 98765-4321");
    expect(maskBrPhone("1198765432199")).toBe("(11) 98765-4321");
    expect(formatBrPhone("+5511987654321")).toBe("(11) 98765-4321");
    expect(formatBrPhone(null)).toBe("");
  });

  it("validates on the server with a pt-BR message", () => {
    expect(brPhoneSchema.parse("(11) 98765-4321")).toBe("+5511987654321");
    const failed = brPhoneSchema.safeParse("(11) 1234");
    expect(failed.success).toBe(false);
    expect(failed.error?.issues[0]?.message).toMatch(/telefone válido com DDD/);
    expect(friendlyAuthError("PHONE_REQUIRED")).toBe("Informe seu telefone com DDD.");
  });
});
