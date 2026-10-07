---
id: CONTRACT-UNO-ENGINE-001
status: approved
owners:
  - UNO conversion engine
---

# Purpose

Define the deterministic boundary between queued conversion work and a validated
one-page PDF. The contract supports one digital or scanned logistics-label +
DANFE pair and deliberately provides no fallback for unknown templates.

# Interface

```ts
type OutputSize =
  | { preset: "100x150" | "100x100" | "a6" }
  | { preset: "custom"; widthMm: number; heightMm: number };

interface ConversionRequest {
  conversionId: string;
  inputObjectKey: string;
  templateId?: string;
  outputSize: OutputSize;
}

interface ConversionResult {
  outputObjectKey: string;
  pageCount: 1;
  widthMm: number;
  heightMm: number;
  engineVersion: string;
  templateVersion: string;
  validation: {
    contentPreserved: true;
    geometryValid: true;
    codesEquivalent: true;
  };
  timingsMs: Record<string, number>;
}
```

The worker emits persisted stage progress and returns either a validated result
or a typed terminal/retryable failure. Object keys are internal references, not
public URLs.

## Pipeline stages

1. **Analyzer** validates PDF structure, encryption, page count, dimensions,
   rotations, embedded resources, and whether each page is digital or scanned.
2. **Template Detector** compares versioned template evidence and classifies the
   logistics and DANFE pages. When `templateId` is present, it verifies the
   selected template instead of bypassing detection. It must reject no-match and
   ambiguous results.
3. **Content Extractor** locates required useful regions and protected code
   areas. Digital inputs use PDF geometry/text evidence; scans add Tesseract
   Portuguese/English blocks and coordinates. OCR text is never output content.
4. **Layout Engine** removes internal whitespace and fits original regions into
   the requested physical size while preserving aspect ratios, populated
   additional information, code quiet zones, and required margins.
5. **PDF Composer** produces exactly one page. Digital regions are embedded from
   the source with pdf-lib; scanned regions remain source image pixels at a
   validated effective resolution.
6. **Validator** renders at 203 and 300 dpi, checks page geometry and clipping,
   verifies required content/regions, and decodes protected codes to establish
   equality with the input. Only a passing result may be stored as completed.

# Inputs and outputs

- Input is one private PDF with exactly the supported pair. The initial template
  derives from the private reference sample and is implemented using synthetic
  fixtures that reproduce layout characteristics without real data.
- Presets are 100 × 150 mm, 100 × 100 mm, and A6. Custom dimensions must be
  50–210 mm wide and 50–300 mm high.
- The default is 100 × 150 mm. A size is eligible for production only after its
  template/size release gate passes automated and physical validation.
- All coordinates use PDF points internally with an explicit conversion to
  physical millimetres. Rotation is normalized before region coordinates are
  resolved.
- Template definitions include a stable ID/version, page classifiers, required
  regions, protected code regions/quiet zones, layout rules, and synthetic
  fixtures. Changing any of these changes the template version.
- The engine records per-stage duration. The target for common digital inputs is
  under three seconds; OCR timings are reported separately.

# Compatibility and versioning

- Jobs pin both engine and template versions so retries are reproducible.
- A new marketplace or materially changed layout is a new template/version with
  fixtures and release validation; it is never silently accepted by an existing
  detector.
- Engine changes that alter layout or validation require regression comparison
  against every released synthetic fixture and renewed physical proof whenever
  print characteristics may change.

# Error behavior

Terminal failures include `invalid_pdf`, `pdf_encrypted`, `invalid_page_count`,
`unsupported_template`, `ambiguous_template`, `missing_required_region`,
`codes_unreadable`, `format_too_small`, and `validation_failed`.
`format_too_small` includes the smallest larger released size that can satisfy
the layout, when one is known. Infrastructure/provider errors are retryable;
deterministic input, template, layout, and validation errors are terminal.

No failed or partial output is downloadable. Terminal failure releases the
single quota reservation. An internal retry reuses the conversion, pinned
versions, and reservation. Logs, traces, and metrics include identifiers,
states, versions, and timings only; never document bytes, rendered pages, OCR
text, decoded code values, addresses, tax data, or names.

# Amendment 2026-10-07 — compact fiscal strip (product owner decision)

The product owner requires the output to match the common marketplace
"etiqueta + DANFE simplificada" format on one 100 × 150 mm label. This amends
the whitespace/region rules above for templates that declare `compactFiscal`:

- When the fiscal page is **digital** and its operation type, number, series,
  issue date and 44-digit access key are read exactly from PDF text — and the
  series and number printed agree with those embedded in the key — the output is
  the logistics regions followed by a strip: title bar "DANFE SIMPLIFICADA -
  ETIQUETA", one line (Tipo, NF, Série, Emissão), the **original** access-key
  barcode (full width, a central horizontal band) and the key digits. Other
  fiscal-page content (protocol, issuer/recipient lines, additional
  information) is intentionally not reproduced.
- The logistics regions stay at original scale when they fit and may shrink
  uniformly down to 85 %; below that the conversion fails `format_too_small`.
- The validator still decodes every code at 203/300 dpi, compares input and
  output, and additionally requires the strip barcode to equal the printed key.
- Scanned fiscal pages, or any doubt in the fields, keep the previous behavior
  (all regions embedded, no summarization). OCR text is never printed.

Whether the summarized strip is acceptable in place of the full simplified
DANFE for a given operation is a fiscal/compliance decision of the operator and
is **NOT VERIFIED** here; physical print proof remains required per size.

## Product header (same amendment)

`ConversionRequest` may carry `product { quantity, title, sku?, variation? }`
supplied by the caller. The layout reserves a dashed box above the logistics
regions. When present in compact mode, blank bands above and below each
logistics region's real content are trimmed and the label may shrink uniformly
down to 80 %; below that the conversion fails `format_too_small`. Code
equivalence is still decoded at 203 and 300 dpi on every output.
