import { describe, expect, it } from "vitest";
import { parseOutputSize, sizeDimensions, mmToPoints } from "@/lib/label-size";
describe("physical output contract", () => {
  it("defaults to the thermal label instead of A4", () => { expect(sizeDimensions(parseOutputSize({}))).toEqual({widthMm:100,heightMm:150}); expect(mmToPoints(25.4)).toBe(72); });
  it("uses real A6 dimensions", () => { expect(sizeDimensions(parseOutputSize({size:"a6"}))).toEqual({widthMm:105,heightMm:148}); });
  it.each([{size:"custom",widthMm:"0",heightMm:"150"},{size:"custom",widthMm:"100",heightMm:"301"},{size:"A4"},{size:"custom",widthMm:"NaN",heightMm:"150"}])("rejects unsafe dimensions %j", fields => { expect(()=>parseOutputSize(fields)).toThrow(); });
});
