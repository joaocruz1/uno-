import { TEMPLATE_KEY, TEMPLATE_VERSION, type AnalyzedPage, type FiscalSummary } from "../types";
import { anchorAt, normalizeEvidenceText, type TemplateDefinition } from "./definition";

/**
 * Reads the simplified DANFE header. The access key embeds series and number,
 * so a summary is returned only when the printed values agree with the key.
 */
function summarizeDanfe(page: AnalyzedPage): FiscalSummary | undefined {
  if (page.kind !== "digital") return undefined;
  const items = page.textItems.map((item) => item.text.trim()).filter(Boolean);
  const keys = [...new Set(items.filter((text) => /^\d{44}$/.test(text)))];
  const operation = items.map((text) => /^\d\s*-\s*(sa[ií]da|entrada)$/i.exec(text)?.[1]).find(Boolean);
  const numbering = items.map((text) => /^(\d[\d.,]*)\s*\/\s*s[eé]rie\s*(\d{1,3})$/i.exec(text)).find(Boolean);
  const issuedOn = items.find((text) => /^\d{2}\/\d{2}\/\d{4}$/.test(text));
  if (keys.length !== 1 || !operation || !numbering || !issuedOn) return undefined;
  const accessKey = keys[0];
  const number = numbering[1].replace(/\D/g, "");
  const series = numbering[2];
  if (!number || Number(accessKey.slice(25, 34)) !== Number(number) || Number(accessKey.slice(22, 25)) !== Number(series)) return undefined;
  return { operation: /^s/i.test(operation) ? "Saída" : "Entrada", number: String(Number(number)), series: String(Number(series)), issuedOn, accessKey };
}

/** Mercado Livre logistics label + simplified DANFE, two 100 × 150 mm pages. */
export const mercadoLivreTemplate: TemplateDefinition = {
  key: TEMPLATE_KEY,
  version: TEMPLATE_VERSION,
  displayName: "Mercado Livre",
  page: { widthPt: 283.4646, heightPt: 425.1969, tolerancePt: 1 },
  bands: {
    logistics: [[4, 56], [66, 91], [94, 176], [205, 246], [255, 293], [307, 421]],
    danfe: [[5, 46], [53, 126], [132, 153], [161, 202], [329, 340]],
  },
  structuralOuterFrame: { left: 8.5039, bottom: 2.8346, right: 264.1889, top: 424.3464 },
  minimumScores: { logistics: 3, danfe: 4 },
  scoreRoles(value) {
    return {
      logistics: (value.includes("DESPACHAR") ? 3 : 0) + (value.includes("ROTA") ? 2 : 0) +
        (value.includes("DESTINATARIO") ? 1 : 0),
      danfe: (value.includes("DANFE") ? 3 : 0) + (value.includes("CHAVE DE ACESSO") ? 3 : 0) +
        (value.includes("DOCUMENTO AUXILIAR") ? 1 : 0),
    };
  },
  matchesRoleGeometry(page, blocks, role) {
    if (role === "logistics") {
      const hasHeaderIdentifier = blocks.some((block) => {
        const centerTop = page.height - (block.box.bottom + block.box.top) / 2;
        return centerTop >= 0 && centerTop <= 60 && normalizeEvidenceText(block.text).replace(/[^A-Z0-9]/g, "").length >= 4;
      });
      return hasHeaderIdentifier && anchorAt(page, blocks, "DESPACHAR", 65, 95);
    }
    return anchorAt(page, blocks, "CHAVE", 0, 46) &&
      anchorAt(page, blocks, "REMETENTE", 125, 158) &&
      anchorAt(page, blocks, "DESTINATARIO", 155, 185) &&
      anchorAt(page, blocks, "DANFE", 170, 205);
  },
  compactFiscal: { barcodeId: "danfe_barcode", summarize: summarizeDanfe },
  protectedCodes(logisticsPage, danfePage) {
    return [
      {
        id: "logistics_barcode",
        pageNumber: logisticsPage,
        format: "CODE_128",
        box: { left: 37.1339, bottom: 270.9921, right: 207.2126, top: 327.685 },
      },
      {
        id: "logistics_qr",
        pageNumber: logisticsPage,
        format: "QR_CODE",
        box: { left: 167.5276, bottom: 29.4803, right: 252.567, top: 114.5197 },
      },
      {
        id: "danfe_barcode",
        pageNumber: danfePage,
        format: "CODE_128",
        box: { left: 20.126, bottom: 312.0384, right: 246.8977, top: 368.7313 },
      },
    ];
  },
};
