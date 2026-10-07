import { describe, expect, it } from "vitest";

import { PdfAnalyzer } from "@/engine/analyzer";
import { TemplateDetector } from "@/engine/detector";
import {
  findTemplateDefinition,
  listTemplateDefinitions,
  mercadoLivreTemplate,
  selectTemplateDefinitions,
  type TemplateDefinition,
} from "@/engine/templates";
import { syntheticPdf } from "./fixtures/synthetic-pdf";

const otherCarrier: TemplateDefinition = {
  ...mercadoLivreTemplate,
  key: "synthetic-carrier",
  displayName: "Synthetic carrier",
  page: { widthPt: 420, heightPt: 595, tolerancePt: 1 },
};

describe("template registry", () => {
  it("exposes unique versioned definitions and resolves explicit selections", () => {
    const identities = listTemplateDefinitions().map((definition) => `${definition.key}@${definition.version}`);
    expect(new Set(identities).size).toBe(identities.length);
    expect(findTemplateDefinition("mercado-livre", "1.0.0")).toBe(mercadoLivreTemplate);
    expect(findTemplateDefinition("mercado-livre", "9.9.9")).toBeUndefined();
    for (const selection of ["mercado-livre", "mercado-livre@1.0.0", "mercado-livre:1.0.0"]) {
      expect(selectTemplateDefinitions(selection)).toEqual([mercadoLivreTemplate]);
    }
    expect(() => selectTemplateDefinitions("shopee@1.0.0")).toThrowError(expect.objectContaining({ code: "unsupported_template" }));
    expect(selectTemplateDefinitions("synthetic-carrier", [mercadoLivreTemplate, otherCarrier])).toEqual([otherCarrier]);
  });

  it("detects through every registered layout without a generic fallback", async () => {
    const analysis = await new PdfAnalyzer().analyze(await syntheticPdf());

    const detected = await new TemplateDetector([otherCarrier, mercadoLivreTemplate]).detect(analysis);
    expect(detected).toMatchObject({ templateKey: "mercado-livre", templateVersion: "1.0.0" });

    await expect(new TemplateDetector([otherCarrier]).detect(analysis))
      .rejects.toMatchObject({ code: "unsupported_template" });
    await expect(new TemplateDetector([mercadoLivreTemplate, otherCarrier]).detect(analysis, "synthetic-carrier"))
      .rejects.toMatchObject({ code: "unsupported_template" });

    const lookalike: TemplateDefinition = { ...mercadoLivreTemplate, key: "synthetic-lookalike" };
    await expect(new TemplateDetector([mercadoLivreTemplate, lookalike]).detect(analysis))
      .rejects.toMatchObject({ code: "ambiguous_template" });
  });
});
