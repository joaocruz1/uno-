import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { outputSizeSchema } from "../src/lib/label-size";
import { convertPdfIsolated } from "../src/engine/isolated";
import { VALIDATION_POLICY } from "../src/engine/validator";
import { SYNTHETIC_CODES, syntheticPdf } from "../tests/fixtures/synthetic-pdf";

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

async function main() {
  const { values } = parseArgs({ options: { width: { type: "string" }, height: { type: "string" }, scanned: { type: "boolean", default: false }, additional: { type: "boolean", default: false } } });
  if (!values.width || !values.height) throw new Error("Explicit dimensions required");
  const size = outputSizeSchema.parse({ preset: "custom", widthMm: Number(values.width), heightMm: Number(values.height) });
  if (size.preset !== "custom") throw new Error("Print proof requires explicit dimensions");
  const input = await syntheticPdf({ scanned: values.scanned, additionalInformation: values.additional });
  const result = await convertPdfIsolated(input, size);
  const folder = resolve(".tmp/print-proof");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const runId = randomUUID();
  const name = `synthetic-${size.widthMm}x${size.heightMm}-${values.scanned ? "scan" : "digital"}${values.additional ? "-additional" : ""}-${runId}`;
  const staging = await mkdtemp(resolve(folder, ".pending-"));
  try {
    const evidence = {
      runId, createdAt: new Date().toISOString(), fixture: "synthetic-pdf-v1", variants: { scanned: values.scanned, additional: values.additional },
      inputSha256: sha256(input), outputSha256: sha256(result.bytes), versions: result.versions,
      widthMm: result.widthMm, heightMm: result.heightMm, pageCount: result.pageCount,
      validation: result.validation, validationPolicy: VALIDATION_POLICY, timingsMs: result.timingsMs,
      syntheticExpectedCodes: [
        { role: "logistics_barcode", format: "CODE_128", value: SYNTHETIC_CODES.logisticsBarcode },
        { role: "logistics_qr", format: "QR_CODE", value: SYNTHETIC_CODES.logisticsQr },
        { role: "danfe_barcode", format: "CODE_128", value: SYNTHETIC_CODES.danfeBarcode },
      ],
      physicalApproval: "NOT VERIFIED",
    };
    await writeFile(resolve(staging, "input.pdf"), input, { mode: 0o600 });
    await writeFile(resolve(staging, "output.pdf"), result.bytes, { mode: 0o600 });
    const report = JSON.stringify(evidence, null, 2);
    await writeFile(resolve(staging, "automatic.json"), report, { mode: 0o600 });
    await writeFile(resolve(staging, "automatic.sha256"), sha256(report), { mode: 0o600 });
    await rename(staging, resolve(folder, name));
    console.info(`Synthetic candidate package created in ${resolve(folder, name)}. Physical approval remains pending.`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch(() => { console.error("Print proof was not created: check the requested format and local OCR prerequisites. No partial output was published."); process.exitCode = 1; });
