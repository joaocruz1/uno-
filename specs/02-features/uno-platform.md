---
id: SPEC-UNO-001
title: UNO — Duas páginas. Uma etiqueta.
status: approved
adrs:
  - ../04-decisions/ADR-0001-platform-and-processing-architecture.md
contracts:
  - ../03-contracts/public-api-v1.md
  - ../03-contracts/pdf-engine-v1.md
depends_on: []
---

# Objective

Deliver UNO as an independent SaaS that converts one logistics-label page plus
one DANFE page into one printable label while preserving the original content
and machine-readable codes. The first release includes the public site,
authenticated dashboard, subscriptions, individual and batch conversion,
history, ERP API, webhooks, usage controls, and administration.

# Context

The first supported template is derived from a private, user-supplied two-page
PDF whose pages are 100 × 150 mm and contain removable internal whitespace.
That original file contains customer and fiscal data and must never be copied to
Git, logs, telemetry, snapshots, or public artifacts. Versioned tests use a
synthetic equivalent fixture with no real personal or fiscal data.

The initial release supports exactly one logistics-label + DANFE pair per input
file. Inputs may be digital PDFs or scanned PDFs. An unknown or ambiguous
template is rejected; there is no generic or best-effort fallback.

# Expected behavior and rules

## Product experience

- Apply the UNO Red Noir visual identity, using Manrope/Inter, to a responsive
  landing page and dashboard.
- Make the primary flow upload → automatic processing → before/after comparison
  → download/print.
- Provide complete authentication, organizations, searchable history,
  reprocessing, batch processing with ZIP output, usage, subscription, API-key
  management, webhook management, and administration.
- Show progress and metrics from persisted processing events rather than
  simulated timers or placeholder counters.

## Conversion

- Analyze, detect, extract, lay out, compose, and validate through the versioned
  engine contract.
- Preserve digital PDF vectors, fonts, and images by embedding original regions;
  do not rasterize an entire digital input.
- For scans, use local Tesseract with Portuguese and English data to locate
  blocks. OCR may guide extraction but must not rewrite fiscal content.
- Remove whitespace between useful blocks while preserving additional
  information, aspect ratios, quiet zones, and margins required by barcodes and
  QR codes.
- Support 100 × 150 mm by default, 100 × 100 mm, A6, and custom sizes from
  50–210 mm wide and 50–300 mm high.
- Block output and recommend a larger format when a readable composition cannot
  fit. Reject corrupt, password-protected, unknown, ambiguous, or code-illegible
  inputs with a specific error.
- Record the engine version, template version, state, attempts, and usage for
  every conversion.

## Plans and quotas

| Plan | Monthly price | Labels/month | Max file | Max batch | Retention |
| --- | ---: | ---: | ---: | ---: | ---: |
| Free | R$ 0 | 10 | 5 MB | 1 | 7 days |
| Starter | R$ 9,99 | 300 | 20 MB | 50 | 30 days |
| Pro | R$ 15,99 | 2,000 | 50 MB | 100 | 90 days |
| Business | R$ 29,90 | 10,000 | 100 MB | 500 | 180 days |

- Values and limits are configuration, with the table above as the initial
  production defaults.
- No plan includes the public API. API keys, the public API and webhooks are
  the paid add-on "+ API" (R$ 50,00/month), a separate monthly subscription
  that any paid plan (Starter, Pro or Business) may buy; Free cannot. The
  add-on grants access only while a paid plan is in force. Rate limits stay
  per plan and per organization: 30 requests/minute for Starter, 60 for Pro
  and 120 for Business.
- Reserve quota atomically when work is enqueued, confirm it only on success,
  and release it on terminal failure. Internal retries never consume quota
  again. A user-requested reprocess creates a new conversion and quota event.
- Billing is monthly through Stripe Checkout and Customer Portal. There are no
  automatic overage charges and no watermark.

## Integrations and operations

- Public API creation is idempotent and asynchronous. API keys are shown once,
  stored only as hashes, and supplied as Bearer credentials.
- Deliver HMAC-SHA-256 signed completion/failure and batch webhooks. Retry after
  1 minute, 5 minutes, 30 minutes, 2 hours, and 12 hours.
- Keep source and output objects private and expose outputs through expiring
  signed URLs. Delete artifacts according to the organization's plan retention.
- Use idempotent Stripe webhooks and subscription reconciliation.
- Provide API examples for cURL, browser/JavaScript, Node.js, and Python.
- Send product email through Resend and instrument errors and product events
  with Sentry and PostHog without transmitting document content or sensitive
  extracted values.

# Edge cases and constraints

- Detect the logistics and fiscal pages even when their input order is reversed.
- Normalize supported page rotations without changing the physical output size.
- Preserve populated additional-information areas rather than assuming they are
  blank.
- A scan remains an image-based composition; recognized text is never used to
  reconstruct legally relevant content.
- Worker retries, concurrent requests, duplicate idempotency keys, and repeated
  provider webhooks must not double-consume quota or create duplicate effects.
- Isolation is enforced at organization boundaries for records, objects,
  billing, keys, webhooks, and administration.
- A template/size pair is not production-approved until automated validation and
  the specified physical print proof have passed.

# Acceptance criteria

- AC-UNO-001: A supported digital two-page pair produces exactly one page with
  the requested physical dimensions, preserved content, no clipping, and input
  and output codes decoding to the same values.
- AC-UNO-002: A supported scanned pair completes through OCR-assisted region
  detection without replacing original fiscal content with recognized text.
- AC-UNO-003: Reversed pages, supported rotations, and populated additional
  information compose correctly.
- AC-UNO-004: Corrupt, encrypted, unknown, ambiguous, code-illegible, and
  too-small-format inputs end in explicit non-success states; too-small formats
  recommend a larger supported size.
- AC-UNO-005: Upload, processing, real progress, before/after comparison, and
  download/print work on supported desktop browsers and responsive mobile UI.
- AC-UNO-006: Searchable history, reprocessing, batches, ZIP download, usage,
  subscription, API keys, webhooks, and admin flows enforce organization scope
  and plan entitlements.
- AC-UNO-007: Quota reservation is atomic under concurrency, is confirmed once
  on success, is released on terminal failure, and is unaffected by internal
  retries or duplicate requests.
- AC-UNO-008: API creation returns asynchronously, idempotency prevents duplicate
  creation, polling exposes real state, and successful output uses a signed URL.
- AC-UNO-009: Webhook signatures verify as HMAC-SHA-256 and failed deliveries
  follow the five configured retry delays without duplicate business effects.
- AC-UNO-010: Stripe Checkout, Customer Portal, idempotent provider events, and
  reconciliation produce the correct plan and limits.
- AC-UNO-011: Private files and secrets do not appear in logs, telemetry, source
  control, or cross-organization responses; retention cleanup removes expired
  objects and records as designed.
- AC-UNO-012: Automated rendering and code decoding pass at 203 and 300 dpi. A
  physical 100% scale proof records printer, settings, code-read result, and
  approval before a template/size combination is certified.
- AC-UNO-013: Common digital PDFs meet the under-three-second processing target;
  OCR latency is measured and reported separately. API upload time is excluded
  from the API creation latency measure.
- AC-UNO-014: Lint, strict typecheck, relevant automated tests, production build,
  supported-browser checks, security review, and spec audit pass before release.

# Open questions

None. Service credentials, provider resource IDs, and physical proof results are
deployment inputs and verification gates, not unresolved product decisions.
