import { PDFDocument } from "pdf-lib";

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
      return { bytes: await output.save({ useObjectStreams: true }), layout: plan };
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError("validation_failed");
    }
  }
}

export const composePdf = (plan: LayoutPlan) => new VectorPdfComposer().compose(plan);
