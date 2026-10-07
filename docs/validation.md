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
