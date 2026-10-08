/**
 * Local benchmark of the conversion engine on the synthetic Mercado Livre
 * fixture. Prints the warm in-process time, the time through the supervised
 * child (as the worker runs it) and the overhead between the two.
 *
 *   corepack pnpm bench:engine            # 3 runs of each
 *   corepack pnpm bench:engine -- --runs 5
 */
import { convertPdf } from "../src/engine/index";
import { closeEngineChildPool, convertPdfIsolated } from "../src/engine/isolated";
import { syntheticPdf } from "../tests/fixtures/synthetic-pdf";

const SIZE = { preset: "100x150" } as const;
const TEMPLATE = "mercado-livre@1.0.0";

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const parsed = index >= 0 ? Number(process.argv[index + 1]) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function format(timings: Record<string, number>): string {
  return Object.entries(timings).map(([stage, value]) => `${stage} ${Math.round(value)}`).join(", ");
}

async function main() {
  const runs = argument("--runs", 3);
  const input = await syntheticPdf({ fiscalSummary: true, additionalInformation: true });
  console.log(`fixture: ${input.byteLength} bytes, output ${SIZE.preset}, ${runs} runs each\n`);

  for (let run = 1; run <= runs; run += 1) {
    const started = performance.now();
    const result = await convertPdf(input, SIZE, TEMPLATE);
    console.log(`in-process run ${run}: ${Math.round(performance.now() - started)} ms (${format(result.timingsMs)})`);
  }
  console.log();

  try {
    for (let run = 1; run <= runs; run += 1) {
      const started = performance.now();
      let firstProgressMs: number | null = null;
      const result = await convertPdfIsolated(input, SIZE, TEMPLATE, () => {
        firstProgressMs ??= Math.round(performance.now() - started);
      });
      const total = Math.round(performance.now() - started);
      const engine = Math.round(Object.values(result.timingsMs).reduce((sum, value) => sum + value, 0));
      console.log(
        `isolated run ${run}: ${total} ms total, first progress at ${firstProgressMs ?? "—"} ms, engine ${engine} ms, overhead ${total - engine} ms`,
      );
    }
  } finally {
    await closeEngineChildPool?.();
  }
}

await main();
