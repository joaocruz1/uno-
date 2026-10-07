# Verification evidence

## Phase 1 — Foundation

2026-10-07: pnpm check PASS (lint, strict TypeScript, 11 tests, Next production build).
Local PostgreSQL 17 migration PASS. PGlite migration, tenant FK isolation and quota reserve/confirm/release tests PASS.
UI shell only at this checkpoint; authentication, providers and PDF processing not verified yet.
Original PDF excluded from repository and artifacts.

## Phase 2 — Design and landing

2026-10-07: pnpm check PASS (lint, strict TypeScript, 13 tests, Next production build).
Optional PostgreSQL concurrency test separately PASS: 12 competing requests accepted exactly 3 for a quota of 3.
12 Playwright cases PASS across Chromium, Firefox, WebKit and mobile: responsive landing, pricing/docs, reduced-motion hydration with no browser errors.
Desktop/mobile visual review performed; headline spacing and demo layout corrected. Public legal text remains an operator/legal-review draft.

## Phase 03 — Authentication

- Full lint, strict typecheck, 18 unit/integration tests and production build passed.
- Better Auth + PostgreSQL + Redis + local Mailpit browser flow passed in Chromium, Firefox, WebKit and mobile: signup, confirmation, session, logout, password reset and login. Synthetic accounts only.
- Verified-email boundary, server-owned admin role, idempotent FREE organization provisioning and CSRF/redirect/error guards covered by tests; read-only QA review approved.
- Browser projects share one localhost IP; reset tests honor the real 3-per-60-second rate guard. No limits disabled for tests.
- Production Resend delivery and deployed cookie/domain behavior remain unverified until credentials and deployment exist. Additional revoked membership and cross-tenant actor tests belong to phase 13.

## Phase 04 — Private upload

- Lint, typecheck, 37 unit/integration tests and production build passed. Native PostgreSQL migrations applied and rerun idempotently.
- Real S3 emulator test passed signed PUT (Content-Length binding), HEAD, bounded read/range, checksum, temporary GET and deletion. Actual auth→intent→SHA-signed PUT→readValidatedUpload passed using a synthetic two-page PDF. Cross-organization lookup denied.
- Browser upload and invalid-PDF rejection passed in Chromium and mobile.
- Native PostgreSQL/Redis concurrency passed: 12 simultaneous FREE intents yielded exactly 10 accepted + 2 pending-cap 429 responses; 12 distributed limiter calls with limit3 yielded exactly 3 accepted.
- Architecture/security re-review approved after distributed rate guard and atomic pending cap. The conversion snapshot and atomic consume are required in phase06.
- Authentication security review also approved session revocation after password reset; old-session denial has a passing integration assertion.
- S3 emulator confirms protocol behavior; real R2 private policy/CORS/deployed access remains unverified until production credentials exist. Native integrations are opt-in tests, not silently claimed by default CI.

## Phase 05 — Template engine

- Six separate stages implement the initial versioned template. Digital output embeds original regions; scanned output keeps original pixels and uses local Portuguese/English OCR only for detection.
- Full lint, strict typecheck, 58 tests and production build passed. Four tests are opt-in: three native infrastructure integrations and OCR. Dedicated engine QA passed 21 tests; the OCR case separately passed with local Tesseract.
- Regression checks cover additional fiscal content, reversed/rotated pages, missing non-code content, unknown/ambiguous templates, active content, corrupt/page-count errors, vector CTM, nested Form matrices and identity Forms. The thin two-rectangle structural frame is recognized by its versioned geometry; arbitrary full-page filled content is retained.
- Codes are decoded and compared at 203 and 300 dpi. Content manifests and geometry are checked, with rendered pixel preservation at 203 dpi. These checks do not certify physical printing.
- Private reference tested only in memory: 100 × 150 and 100 × 210 mm safely reject as insufficient; 100 × 250 mm passes one-page, geometry/content and code-equivalence checks. Cold isolated conversion measured 1,900 ms; warm in-process conversion 564 ms. No customer bytes, code values, text or rendered pages were saved to repository/logs/artifacts.
- Native isolation test passed with RSS monitoring enabled, six ordered real progress callbacks and no remaining temporary workspace. Deadline, delayed final progress, callback failure and safe error propagation are covered. A hard container memory limit remains required for deployment.
- Read-only architecture/security and QA reviews approved. Printing-package review approved explicit dimensions, atomic UUID packages, hashes, synthetic expected values and the distinction between automatic candidates and physical approval.
- Digital, additional-content and scanned synthetic candidates were generated privately in `.tmp/print-proof/`. Operator printing at 100% and recorded scans remain **NOT VERIFIED**. No template/size is production-released by these automated results.

## Phase 06 — Conversion

- Lint, strict typecheck, 69 tests and production build passed; five native/OCR integrations remain opt-in in the default suite.
- Native PostgreSQL/Redis/S3/BullMQ integration passed queue-outage recovery, immutable snapshots, success confirmation once, deterministic failure release, lost commit acknowledgement recovery and expired-claim recovery. Migration rerun was idempotent.
- Read-only architecture and QA reviews approved after regression fixes for live duplicate jobs, pre-claim failures, commit uncertainty and output publication races. Persisted claims and versions remain authoritative.
- Synthetic full upload → actual progress → result comparison → download/print flow passed Chromium, Firefox, WebKit and mobile. The insufficient format fails without confirmed usage. PDF previews render with versioned local PDF.js assets and omit credentials on signed requests.
- Worker restarted with final reviewed code. Local native services demonstrate integration behavior; production providers, container memory limits and physical template releases remain unverified.

## Phase 07 — History and reprocessing

- Full lint/typecheck, 85 tests and production build passed; six native/OCR cases are opt-in.
- Sixteen focused tests cover literal search, filter-bound stable pagination, dates, tenant references, missing/expired files, retention during HEAD/row-lock waits, immutable copies, independent reservations, plan/template revalidation and lost/unknown commit outcomes.
- Native PostgreSQL/S3 concurrency passed: equivalent simultaneous reprocess requests return one child, one reservation and one outbox event; conflicting parameters return 409. Final migration/constraint state validated locally.
- Chromium, Firefox, WebKit and mobile passed failed 100×150 source → searchable history → original dimensions retained → new 100×250 conversion → preview/download. Confirmed usage is one; the original failure does not consume quota.
- Read-only architecture/security and UI QA reviews approved. Reprocessing preserves the original preset/template unless changed, uses a stable retry key and hides stale detail actions during navigation. No production release or physical certification is implied.

## Phase 08 — Batches

- Full lint, strict typecheck, 94 tests and production build passed; seven native/OCR cases remain opt-in. The mock typing correction also removed lint warnings.
- Independent private upload sessions prepare immutable items before one atomic batch admission. Individual conversions retain their own quota lifecycle; ZIP packaging includes only successful outputs.
- Native PostgreSQL concurrency passed: twelve equivalent submissions produced one batch and two reservations. Migration application and rerun passed.
- Chromium, Firefox, WebKit and mobile passed eight synthetic end-to-end cases with the final restarted worker: dialog focus/Escape, accepted batch, stable ZIP filename/download, insufficient-format failure, no ZIP for zero successes and released quota.
- Architecture/security re-review approved effective archive deadlines (including providers ignoring cancellation), stable staging keys tracked until signed uploads expire, and publication/cleanup row-lock races. ZIP64 uses bounded multipart buffers and actual persisted aggregate progress.
- Local integration evidence does not certify physical printing, real R2 settings or deployment memory. Aggregate parent/ZIP/finalization/child memory must be measured before setting production resource limits.

## Phase 09 — Billing and usage

- Full lint, strict typecheck, 109 tests and production build passed; seven native/OCR cases remain opt-in. Migration0006 was applied and rerun idempotently in native PostgreSQL.
- Fourteen billing tests cover validated configuration, current effective rights, one open Checkout across keys, stable provider idempotency, expired attempts, cancellation/recontracting, unknown contracts, signed raw bytes using the actual Stripe SDK, tampering/stale signatures, event hash deduplication, fenced out-of-order reconciliation, recovery backoff and preserved counters/contiguous renewal.
- Admission clocks are refreshed after the subscription lock in conversion, reprocessing and batch acceptance; an expiration-during-wait regression passes. Ledger capacity after downgrade preserves accepted units while admission and displayed remaining use the effective plan limit.
- Eight billing/usage E2E cases passed Chromium, Firefox, WebKit and mobile. With the final restarted worker, four Chromium regression flows also passed real upload, history/reprocessing and successful/failed batches. Native batch concurrency still passed after entitlement changes.
- Architecture/security and UI QA approved. An environment disk-space failure was resolved by removing only regenerable UNO caches; optional UNO_DISABLE_DEV_DISK_CACHE=true disables local persistent dev caching. Automatic development URL/function/browser logging is disabled to avoid logging sensitive links.
- Stripe account availability for the UNO CLI project is false. Actual Checkout/payment/portal and provider webhook delivery remain **NOT VERIFIED** until an UNO sandbox is configured; local gateway and offline signature evidence do not prove payment processing.
