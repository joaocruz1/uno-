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
      const table = plan.itemsTable;
      if (table) {
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
        const { box, headerHeight, rowHeight } = table;
        const width = box.right - box.left;
        // SKU | Variação | Qtd, as on the picking slips sellers already use.
        const quantityLeft = box.right - 30;
        const variationLeft = box.left + width * 0.56;
        const line = (x1: number, y1: number, x2: number, y2: number, thickness = 0.5) =>
          page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color: rgb(0, 0, 0) });
        page.drawRectangle({ x: box.left, y: box.bottom, width, height: box.top - box.bottom, borderColor: rgb(0, 0, 0), borderWidth: 0.8 });
        const headerBottom = box.top - headerHeight;
        line(box.left, headerBottom, box.right, headerBottom, 0.8);
        const rows = table.items.length + (table.hidden > 0 ? 1 : 0);
        const columnsBottom = box.top - headerHeight - table.items.length * rowHeight;
        line(variationLeft, box.top, variationLeft, columnsBottom);
        line(quantityLeft, box.top, quantityLeft, columnsBottom);
        const headerBaseline = headerBottom + 2.8;
        page.drawText("SKU", { x: box.left + 3, y: headerBaseline, size: 6.5, font: bold });
        page.drawText("Variação", { x: variationLeft + 3, y: headerBaseline, size: 6.5, font: bold });
        page.drawText("Qtd", { x: quantityLeft + (30 - bold.widthOfTextAtSize("Qtd", 6.5)) / 2, y: headerBaseline, size: 6.5, font: bold });
        for (const [index, item] of table.items.entries()) {
          const top = headerBottom - index * rowHeight;
          const bottom = top - rowHeight;
          if (index < rows - 1) line(box.left, bottom, box.right, bottom, 0.3);
          const baseline = bottom + 3;
          const name = safe(item.sku ?? item.title ?? "");
          page.drawText(fit(name, regular, 7, variationLeft - box.left - 6), { x: box.left + 3, y: baseline, size: 7, font: regular });
          const variation = item.variation ? safe(item.variation) : "";
          if (variation) page.drawText(fit(variation, regular, 7, quantityLeft - variationLeft - 6), { x: variationLeft + 3, y: baseline, size: 7, font: regular });
          const quantity = String(item.quantity);
          const quantityX = quantityLeft + (30 - bold.widthOfTextAtSize(quantity, 7.5)) / 2;
          // More than one unit is the usual picking mistake: invert the cell so it stands out.
          if (item.quantity > 1) {
            page.drawRectangle({ x: quantityLeft + 0.4, y: bottom + 0.4, width: box.right - quantityLeft - 0.8, height: rowHeight - 0.8, color: rgb(0, 0, 0) });
          }
          page.drawText(quantity, { x: quantityX, y: baseline, size: 7.5, font: bold, color: item.quantity > 1 ? rgb(1, 1, 1) : rgb(0, 0, 0) });
        }
        if (table.hidden > 0) {
          const notice = `+ ${table.hidden} ${table.hidden === 1 ? "item não coube" : "itens não couberam"} na etiqueta`;
          page.drawText(notice, { x: box.left + 3, y: box.bottom + 3, size: 6.5, font: bold });
        }
      }
      return { bytes: await output.save({ useObjectStreams: true }), layout: plan };
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError("validation_failed");
    }
  }
}

export const composePdf = (plan: LayoutPlan) => new VectorPdfComposer().compose(plan);
