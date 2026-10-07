import { execFile } from "node:child_process";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { openPdfRenderer } from "./render";
import { EngineError } from "./errors";
import type { AnalyzedPage, OcrBlock } from "./types";

const execFileAsync = promisify(execFile);

function parseTsv(tsv: string, page: AnalyzedPage, pixelWidth: number, pixelHeight: number): OcrBlock[] {
  const xScale = page.width / pixelWidth;
  const yScale = page.height / pixelHeight;
  const blocks: OcrBlock[] = [];
  for (const line of tsv.split(/\r?\n/).slice(1)) {
    const columns = line.split("\t");
    if (columns.length < 12) continue;
    const confidence = Number(columns[10]);
    const text = columns.slice(11).join("\t").trim();
    const x = Number(columns[6]);
    const y = Number(columns[7]);
    const width = Number(columns[8]);
    const height = Number(columns[9]);
    if (!text || !Number.isFinite(confidence) || confidence < 0 || ![x, y, width, height].every(Number.isFinite)) continue;
    blocks.push({
      text,
      confidence,
      box: {
        left: x * xScale,
        right: (x + width) * xScale,
        bottom: page.height - (y + height) * yScale,
        top: page.height - y * yScale,
      },
    });
  }
  return blocks;
}

export async function recognizeScannedPage(bytes: Uint8Array, page: AnalyzedPage): Promise<OcrBlock[]> {
  const renderer = await openPdfRenderer(bytes);
  const directory = await mkdtemp(join(process.env.UNO_ENGINE_TMP_DIR ?? tmpdir(), "uno-ocr-"));
  await chmod(directory, 0o700);
  const inputPath = join(directory, "page.png");
  try {
    const rendered = await renderer.render(page.pageNumber, 203, 0);
    await writeFile(inputPath, rendered.png, { mode: 0o600 });
    const resolvedInputPath = await realpath(inputPath);
    let stdout: string;
    try {
      const result = await execFileAsync(
        "tesseract",
        [resolvedInputPath, "stdout", "-l", "por+eng", "--psm", "11", "-c", "tessedit_create_tsv=1"],
        {
        timeout: 45_000,
        killSignal: "SIGKILL",
        maxBuffer: 12 * 1_024 * 1_024,
        env: process.env,
        },
      );
      stdout = result.stdout;
    } catch {
      throw new EngineError("ocr_unavailable", { terminal: false });
    }
    return parseTsv(stdout, page, rendered.width, rendered.height);
  } finally {
    await Promise.allSettled([
      renderer.close(),
      rm(directory, { recursive: true, force: true }),
    ]);
  }
}
