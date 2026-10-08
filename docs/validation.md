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

## Phases 10–13 — Public API, webhooks, management/administration, retention/security

2026-10-07: `pnpm check` PASS — lint, strict typecheck, 299 tests (8 opt-in native/OCR cases skipped) and production build.

- **Public API (10).** Parser/admission/key tests pass. Opt-in native HTTP test (`UNO_RUN_NATIVE_API=1`) passed against the local app, worker, PostgreSQL, Redis and S3 emulator: 401 without key, 403 `plan_required` on Free, unknown field 400, non-PDF 422, `202` creation, idempotent replay returning the same id, `409 idempotency_conflict` on changed options, foreign-tenant 404 for conversion and batch, polling to `completed`, signed one-page PDF download, two-item batch with ZIP, and usage `confirmed: 3` isolated per organization. Fixed during validation: conflicting replays left their new snapshot behind; `409 idempotency_in_progress` lacked `Retry-After`; the rate limit was per route instead of per organization.
- **Webhooks (11).** 117 tests cover AES-256-GCM secrets with organization/endpoint AAD, exact-body HMAC, stable delivery id, fan-out deduplication, the 1m/5m/30m/2h/12h schedule, stale claims, disable/downgrade cancellation, tenant isolation and the SSRF matrix (private ranges, IPv4-mapped IPv6, DNS rebinding, redirects, body cap, timeout) through injected transports. Plan is now checked before any DNS lookup. **NOT VERIFIED:** a real TLS delivery to a public receiver, the system DNS resolver, and `skip locked` contention on native PostgreSQL. Known limits: a delivery that exhausted six attempts cannot be retried manually; editing a URL/events means recreating the endpoint; deleting an endpoint deletes its delivery history.
- **Management and administration (12).** 27 tests cover foreign organizations, revoked selection fallback, no re-elevation by provisioning, ownership transfer, last-owner protection, admin elevation attempts, expired/revoked/mismatched/replayed invitations, platform-admin double credential, and release evidence (missing/divergent report, idempotent and conflicting publication). Browser flow passed: rename organization → invite by e-mail through Mailpit → invitee accepts → member listed; consumed token rejected for another identity; `/admin` returns 404 and the admin API 403 for a regular account. **NOT VERIFIED:** the `/admin` pages rendered for a real platform administrator, rate limits, and true concurrent row locking (PGlite serializes).
- **Retention and security (13).** 37 tests cover repeated/partial deletion, processing and archive leases, concurrent claims, expiry during download authorization, pending-versus-confirmed usage, batch aggregates, expired unused uploads, engine workspace recovery without following symlinks, security headers and tenant isolation of public readers. **NOT VERIFIED / operational gates:** bucket lifecycle rules for incomplete multipart uploads and untracked orphans, backups, container limits. The CSP uses `'unsafe-inline'` (no nonce) and was exercised only through the flows below.
- **Engine.** Layouts now resolve through a versioned registry (`src/engine/templates`); behavior for the initial template is unchanged (engine tests pass; private sample re-checked in memory only: 100 × 150 and 100 × 210 mm rejected as too small, 100 × 250 mm passes content, geometry and code equivalence in 557 ms warm).
- **Browsers.** With the security headers active, the full Playwright suite ran on Chromium, Firefox, WebKit and mobile: 49 of 56 passed in one run; the 7 failures were the real 3-per-minute signup guard on a single IP (plus one test locator fixed for mobile) and each passed when rerun spaced apart. Covered: auth, upload → progress → preview → download, history/reprocess, batches/ZIP, billing/usage, API keys, team invitations, webhook gating.
- **Environment notes.** The local S3 emulator and Mailpit had stopped responding during the session and were restarted; a stale dev server returned 500 on API uploads until restarted. None was a code defect.
- **Production (15).** `Dockerfile` and `docs/deploy.md` were written without a container runtime and are **NOT VERIFIED**. Stripe payments, Resend, R2, deployment and the physical print proof remain open gates; no template/size is production-released.

## Compact label format (2026-10-07, after product owner review)

The owner rejected the 100 × 250 mm full-preservation output and supplied a market reference. The engine now emits, for digital inputs, the logistics label at original scale plus a summarized DANFE strip on 100 × 150 mm (see the amendment in `specs/03-contracts/pdf-engine-v1.md`). `pnpm check` PASS with 303 tests (4 new compact cases). Private sample re-checked in memory: 100 × 150 mm passes geometry and code equivalence, scale 1, strip barcode equal to the printed key. Live API test and Chromium upload/history flows pass with the restarted worker. **NOT VERIFIED:** physical print/scan of the compact label, fiscal acceptability of the summarized strip, and the product/SKU header shown in the reference (the input PDF carries no product data).

## Product header (2026-10-07)

Optional product data (quantity, title, SKU, variation) now flows from the dashboard form and `/api/v1/conversions` through the database (migration `0009`), the worker and reprocessing into a dashed box above the label. `pnpm check` PASS with 307 tests. Live HTTP test passed a 100 × 150 mm conversion with product fields, a 400 for an invalid quantity and a 400 for product fields on a batch. Chromium flow passed: fill product fields → upload → completed 100 × 150 mm. Private sample with example product data passes at 100 × 150 mm (in memory). **NOT VERIFIED:** physical print legibility with the label reduced below 100 %; product data per item in batches is not supported.

## Landing motion and anonymous one-time trial (2026-10-07)

The landing hero now hosts a drop zone backed by `POST /api/public/trial`: one PDF up to 5 MB is converted in memory to 100 × 150 mm, rendered in the page and offered for download; nothing is stored. Reuse is blocked by an HttpOnly cookie plus a keyed hash of the network address (30 days), with per-visitor and global rate limits, a concurrency cap, same-origin enforcement and the same template-release gate as paid conversions. `pnpm check` PASS with 310 tests; the landing suite (16 cases incl. trial → preview → download → "already used") passed on Chromium, Firefox, WebKit and mobile with no console errors. **Limits to know:** "once" is a deterrent, not an identity guarantee (a new network and cleared cookies get another try); the address comes from `X-Forwarded-For`, so the deployment proxy must set it; the trial runs the engine inside the web process without the isolated child used by the worker; scanned PDFs need Tesseract, which the web image does not ship; and in production the trial returns "template not released" until a release is published.

## Owner administration views (2026-10-07)

`/admin` gained Financeiro (estimated MRR from catalog prices of Stripe-linked subscriptions, at-risk and unbilled paid plans), Clientes (ranking by labels in 30 days with quota use and channel), Atividade (labels per day, by channel, template, plan and format), Chaves de API (label, public prefix, state and 30-day use across organizations) and Conexões (presence of provider configuration, never values). `pnpm admin:local [email]` creates or promotes a local platform administrator and stores generated credentials in the ignored `.tmp/local-admin.txt`. `pnpm check` PASS; three new tests cover access denial, billed-only revenue and absence of file names, key hashes, provider ids and object keys in the responses. All six pages rendered for the local administrator with no console errors. **Not implemented:** signup attribution (campaign/referrer), real Stripe revenue figures, and administrative mutations (plans and quotas remain read-only by contract).

## Stripe test mode (2026-10-07)

With the owner's test-mode keys: three monthly BRL prices (Starter R$ 29, Pro R$ 59, Business R$ 149) and the Customer Portal configuration were created through the API; `STRIPE_SECRET_KEY`, the three `STRIPE_PRICE_*` ids and a local `STRIPE_WEBHOOK_SECRET` (from `stripe listen`) are set in `.env.local`. A real test-mode flow passed end to end for a synthetic account: Checkout session from the dashboard API → payment with Stripe's published test card → return to `/dashboard/billing?checkout=success` → webhook events delivered through `stripe listen` with HTTP 200 → subscription `PRO`, `ACTIVE`, with a one-month period. **NOT VERIFIED:** live-mode keys and prices, a deployed webhook endpoint (the local secret only works with `stripe listen`), the portal flows (cancel/upgrade) in a browser, and tax configuration.

## Pricing change and API add-on (2026-10-08)

Catalog defaults changed to Starter R$ 9,99, Pro R$ 15,99 and Business R$ 29,90; no plan includes the API any more, and API keys, the public API and webhooks became the "+ API" add-on (R$ 50,00/month, a separate Stripe subscription on the same customer, migration `0010_rich_zodiak`). The prices recorded in the earlier entries above are the ones that were verified at the time and are kept as history. Evidence for this change is local only: lint, typecheck, the Vitest suite (entitlement matrix, add-on checkout rules, reconciliation classification and finance MRR, all with an injected billing gateway on PGlite) and the production build. **Not verified:** `scripts/stripe-setup.ts` was not run, so the new prices, the "UNO API" product, the archiving of the older prices and the portal configuration do not exist in any Stripe account yet; the add-on Checkout, its webhooks and its cancellation through the Customer Portal have not been exercised against Stripe test or live mode; the dashboard and marketing screens were not checked in a browser and the e2e specs were not run.
