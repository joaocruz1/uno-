import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

import { EngineError } from "./errors";
import type { ComposedPdf, Composer, LayoutPlan } from "./types";

export class VectorPdfComposer implements Composer {
  async compose(plan: LayoutPlan): Promise<ComposedPdf> {
    try {
      const source = await PDFDocument.load(plan.extraction.analysis.bytes, { updateMetadata: false });
      const output = await PDFDocument.create();
      output.setProducer("UNO PDF Engine 0.1.0");
      output.setCreator("UNO");
      const page = output.addPage([plan.widthPt, plan.heightPt]);
      const sourcePages = plan.regions.map((region) => source.getPage(region.pageNumber - 1));
      const boxes = plan.regions.map((region) => ({
        left: region.box.left,
        bottom: region.box.bottom,
        right: region.box.right,
        top: region.box.top,
      }));
      const embedded = await output.embedPages(sourcePages, boxes);
      for (let index = 0; index < plan.regions.length; index += 1) {
        const region = plan.regions[index];
        page.drawPage(embedded[index], {
          x: region.outputBox.left,
          y: region.outputBox.bottom,
          width: region.outputBox.right - region.outputBox.left,
          height: region.outputBox.top - region.outputBox.bottom,
        });
      }
      const header = plan.productHeader;
      if (header) {
        const regular = await output.embedFont(StandardFonts.Helvetica);
        const bold = await output.embedFont(StandardFonts.HelveticaBold);
        // Standard fonts cover WinAnsi only; anything else would abort the whole label.
        const safe = (value: string) => [...value.normalize("NFC")].filter((character) => {
          const code = character.codePointAt(0)!;
          return (code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff);
        }).join("").replace(/\s+/g, " ").trim();
        const fit = (value: string, font: typeof regular, size: number, width: number) => {
          if (font.widthOfTextAtSize(value, size) <= width) return value;
          let text = value;
          while (text.length > 1 && font.widthOfTextAtSize(`${text}...`, size) > width) text = text.slice(0, -1);
          return `${text.trimEnd()}...`;
        };
        const { box, product } = header;
        const boxWidth = box.right - box.left;
        page.drawRectangle({
          x: box.left, y: box.bottom, width: boxWidth, height: box.top - box.bottom,
          borderColor: rgb(0, 0, 0), borderWidth: 0.6, borderDashArray: [2, 1.5],
        });
        const quantity = String(product.quantity);
        const columnWidth = 52;
        const quantitySize = quantity.length > 2 ? 17 : 22;
        const centerInColumn = (text: string, font: typeof regular, size: number, y: number) =>
          page.drawText(text, { x: box.left + (columnWidth - font.widthOfTextAtSize(text, size)) / 2, y, size, font });
        centerInColumn(quantity, bold, quantitySize, box.bottom + 20);
        centerInColumn(product.quantity === 1 ? "Unidade" : "Unidades", regular, 6, box.bottom + 10);
        const textLeft = box.left + columnWidth + 2;
        const textWidth = box.right - textLeft - 4;
        let cursor = box.top - 9;
        if (product.quantity > 1) {
          page.drawText("ATENÇÃO À QUANTIDADE", { x: textLeft, y: cursor, size: 6.5, font: bold });
          cursor -= 8.5;
        }
        const words = safe(product.title).split(" ");
        const lines: string[] = [];
        for (const word of words) {
          const candidate = lines.length > 0 ? `${lines[lines.length - 1]} ${word}` : word;
          if (lines.length > 0 && bold.widthOfTextAtSize(candidate, 7.5) <= textWidth) lines[lines.length - 1] = candidate;
          else lines.push(word);
        }
        const titleLines = lines.length > 2 ? [lines[0], lines.slice(1).join(" ")] : lines;
        for (const line of titleLines) {
          page.drawText(fit(line, bold, 7.5, textWidth), { x: textLeft, y: cursor, size: 7.5, font: bold });
          cursor -= 8.5;
        }
        const sku = product.sku ? safe(product.sku) : "";
        const badge = quantity;
        const badgeWidth = bold.widthOfTextAtSize(badge, 7) + 4;
        const quantityLabel = "Qtd:";
        const tailWidth = regular.widthOfTextAtSize(quantityLabel, 7) + 3 + badgeWidth;
        let x = textLeft;
        if (sku) {
          page.drawText("SKU:", { x, y: cursor, size: 7, font: regular });
          x += regular.widthOfTextAtSize("SKU:", 7) + 2.5;
          const shown = fit(sku, bold, 7, textWidth - (x - textLeft) - tailWidth - 10);
          page.drawText(shown, { x, y: cursor, size: 7, font: bold });
          x += bold.widthOfTextAtSize(shown, 7) + 4;
          page.drawText("-", { x, y: cursor, size: 7, font: regular });
          x += regular.widthOfTextAtSize("-", 7) + 4;
        }
        page.drawText(quantityLabel, { x, y: cursor, size: 7, font: regular });
        x += regular.widthOfTextAtSize(quantityLabel, 7) + 3;
        page.drawRectangle({ x, y: cursor - 1.6, width: badgeWidth, height: 8.2, color: rgb(0, 0, 0) });
        page.drawText(badge, { x: x + 2, y: cursor, size: 7, font: bold, color: rgb(1, 1, 1) });
        cursor -= 8.5;
        const variation = product.variation ? safe(product.variation) : "";
        if (variation && cursor > box.bottom + 2) {
          page.drawText(fit(variation, regular, 6.5, textWidth), { x: textLeft, y: cursor, size: 6.5, font: regular });
        }
      }
      const strip = plan.fiscalStrip;
      if (strip) {
        const regular = await output.embedFont(StandardFonts.Helvetica);
        const bold = await output.embedFont(StandardFonts.HelveticaBold);
        const centered = (text: string, font: typeof regular, size: number, baseline: number, color = rgb(0, 0, 0)) =>
          page.drawText(text, { x: (plan.widthPt - font.widthOfTextAtSize(text, size)) / 2, y: baseline, size, font, color });
        page.drawRectangle({
          x: strip.titleBar.left, y: strip.titleBar.bottom,
          width: strip.titleBar.right - strip.titleBar.left, height: strip.titleBar.top - strip.titleBar.bottom, color: rgb(0, 0, 0),
        });
        centered("DANFE SIMPLIFICADA - ETIQUETA", bold, 6.5, strip.titleBar.bottom + 2.6, rgb(1, 1, 1));
        const fields: Array<readonly [string, string]> = [
          ["Tipo:", strip.summary.operation], ["NF:", strip.summary.number],
          ["Série:", strip.summary.series], ["Emissão:", strip.summary.issuedOn],
        ];
        const size = 6;
        const cell = (strip.titleBar.right - strip.titleBar.left) / fields.length;
        for (const [index, [label, value]] of fields.entries()) {
          const width = bold.widthOfTextAtSize(label, size) + 3 + regular.widthOfTextAtSize(value, size);
          const x = strip.titleBar.left + cell * index + (cell - width) / 2;
          page.drawText(label, { x, y: strip.lineBaseline, size, font: bold });
          page.drawText(value, { x: x + bold.widthOfTextAtSize(label, size) + 3, y: strip.lineBaseline, size, font: regular });
        }
        const [barcode] = await output.embedPages([source.getPage(strip.pageNumber - 1)], [strip.barcodeSourceBox]);
        page.drawPage(barcode, {
          x: strip.barcodeOutputBox.left, y: strip.barcodeOutputBox.bottom,
          width: strip.barcodeOutputBox.right - strip.barcodeOutputBox.left,
          height: strip.barcodeOutputBox.top - strip.barcodeOutputBox.bottom,
        });
        centered(strip.summary.accessKey, regular, 5.5, strip.digitsBaseline);
      }
      return { bytes: await output.save({ useObjectStreams: true }), layout: plan };
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError("validation_failed");
    }
  }
}

export const composePdf = (plan: LayoutPlan) => new VectorPdfComposer().compose(plan);
