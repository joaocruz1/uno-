# UNO implementation and acceptance checklist

Governing documents:

- [Product specification](../specs/02-features/uno-platform.md)
- [Architecture decision](../specs/04-decisions/ADR-0001-platform-and-processing-architecture.md)
- [Public API contract](../specs/03-contracts/public-api-v1.md)
- [PDF engine contract](../specs/03-contracts/pdf-engine-v1.md)

Every unchecked item is **NOT VERIFIED**. A phase closes only after its relevant
lint, strict typecheck, tests, build, documentation, and commit are complete.
The private original PDF must never be committed, copied into fixtures, logged,
or uploaded to telemetry. Repository fixtures must be synthetic.

## Phases

- [ ] **NOT VERIFIED — 01 Foundation:** independent Next.js/TypeScript project,
  package boundaries, Drizzle/PostgreSQL model, local Docker Compose services,
  environment validation, CI, health checks, and baseline documentation.
- [ ] **NOT VERIFIED — 02 Design and landing:** UNO Red Noir identity,
  Manrope/Inter, complete responsive landing, accessible system components, and
  supported loading/empty/error states.
- [ ] **NOT VERIFIED — 03 Authentication:** Better Auth flows, organizations,
  membership/role enforcement, session security, onboarding, and tenant tests.
- [ ] **NOT VERIFIED — 04 Upload:** private object upload, MIME/signature/size
  validation, plan limits, safe metadata, and no document contents in telemetry.
- [ ] **NOT VERIFIED — 05 Engine:** six contract stages, initial versioned
  template, synthetic fixtures, digital embedding, scan OCR guidance, typed
  failures, 203/300 dpi validation, and code equivalence.
- [ ] **NOT VERIFIED — 06 Conversion:** BullMQ/Redis enqueue and worker, atomic
  quota lifecycle, persisted real progress, retry recovery, comparison, signed
  download, print, and retention metadata.
- [ ] **NOT VERIFIED — 07 History:** organization-scoped search/filter,
  conversion detail, safe errors, signed re-download, and reprocessing as a new
  charged conversion.
- [ ] **NOT VERIFIED — 08 Batches:** plan-count validation, atomic reservation,
  independent items, aggregate real progress, partial failure behavior, private
  ZIP generation, and signed ZIP download.
- [ ] **NOT VERIFIED — 09 Stripe:** monthly plans and configurable limits,
  Checkout, Customer Portal, idempotent events, reconciliation, entitlements,
  and no overage/watermark behavior.
- [ ] **NOT VERIFIED — 10 Public API:** all `/api/v1` contract routes, hashed
  show-once Bearer keys, idempotency, organization scope, Pro/Business access,
  per-plan rate limits, and cURL/JavaScript/Node/Python documentation.
- [ ] **NOT VERIFIED — 11 Webhooks:** dashboard endpoint management, show-once
  secret, exact-body HMAC-SHA-256 signatures, three event types, deduplication,
  delivery history, and retries at 1m/5m/30m/2h/12h.
- [ ] **NOT VERIFIED — 12 Administration:** authorized support/admin views for
  organizations, subscriptions, usage, conversions, failures, jobs, and template
  releases with auditability and no document-content exposure.
- [ ] **NOT VERIFIED — 13 Security:** tenant-isolation tests, least privilege,
  input hardening, secret redaction, private R2 policy, signed URL expiry, key
  hashing/revocation, webhook replay controls, dependency review, and retention
  cleanup.
- [ ] **NOT VERIFIED — 14 QA:** lint, strict typecheck, unit/integration/E2E,
  concurrency/idempotency/recovery tests, Chrome/Safari/Firefox/mobile, digital
  performance target, measured OCR performance, and full spec/security audits.
- [ ] **NOT VERIFIED — 15 Production:** Vercel site/dashboard, Railway API and
  worker, production PostgreSQL/Redis/R2, Stripe/Resend/Sentry/PostHog setup,
  migrations, monitoring/alerts, backups, cleanup schedule, rollback/runbooks,
  and release approval.

## Product acceptance

- [ ] **NOT VERIFIED — AC-UNO-001:** supported digital pair produces one correct
  page with preserved content, no clipping, correct size, and equivalent codes.
- [ ] **NOT VERIFIED — AC-UNO-002:** scanned pair uses OCR only for region
  detection and retains original fiscal pixels/content.
- [ ] **NOT VERIFIED — AC-UNO-003:** reversed order, rotations, and populated
  additional-information areas pass.
- [ ] **NOT VERIFIED — AC-UNO-004:** corrupt, encrypted, unknown, ambiguous,
  illegible-code, and too-small inputs fail explicitly with safe guidance.
- [ ] **NOT VERIFIED — AC-UNO-005:** primary UI flow and real progress pass on
  supported desktop browsers and responsive mobile.
- [ ] **NOT VERIFIED — AC-UNO-006:** SaaS management flows enforce plan and
  organization boundaries.
- [ ] **NOT VERIFIED — AC-UNO-007:** concurrent and retried quota accounting is
  atomic, once-only, and releases failures.
- [ ] **NOT VERIFIED — AC-UNO-008:** API async creation, polling, idempotency,
  and signed download pass.
- [ ] **NOT VERIFIED — AC-UNO-009:** signed webhooks, retry schedule, and
  delivery deduplication pass.
- [ ] **NOT VERIFIED — AC-UNO-010:** Stripe lifecycle and reconciliation map to
  the correct configurable entitlements.
- [ ] **NOT VERIFIED — AC-UNO-011:** privacy, tenant isolation, secret handling,
  and retention deletion pass.
- [ ] **NOT VERIFIED — AC-UNO-012:** automated 203/300 dpi checks pass; physical
  proof at 100% scale records printer, settings, scan result, and approval for
  every released template/size pair.
- [ ] **NOT VERIFIED — AC-UNO-013:** common digital conversion is under three
  seconds excluding upload; OCR is measured separately.
- [ ] **NOT VERIFIED — AC-UNO-014:** all required quality, browser, security,
  build, and spec-compliance gates pass.

## Private sample and release evidence

- [ ] **NOT VERIFIED:** initial detector/layout validated locally against the
  user-supplied private sample without persisting its bytes or extracted values
  in Git, logs, telemetry, screenshots, or CI artifacts.
- [ ] **NOT VERIFIED:** synthetic two-page digital fixture covers equivalent
  geometry, codes, text blocks, whitespace, and additional information.
- [ ] **NOT VERIFIED:** synthetic scanned fixture covers OCR-assisted detection
  at representative quality and rotation.
- [ ] **NOT VERIFIED:** physical 100 × 150 mm feasibility is proven; until then,
  that composition remains an unverified hypothesis and must not be advertised
  as certified.
