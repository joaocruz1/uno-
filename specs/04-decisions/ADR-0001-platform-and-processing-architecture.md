# ADR-0001 — Platform and PDF processing architecture

Status: Approved

## Context

UNO combines a customer-facing SaaS, a public multipart API, durable conversion
jobs, private documents, subscriptions, and CPU-heavy PDF/OCR processing. The
public API must accept files beyond Vercel's function request limit, and digital
PDFs must retain vector quality.

## Decision

- Build one TypeScript codebase on Next.js App Router with strict TypeScript,
  Tailwind, shadcn/ui, Motion, Better Auth, PostgreSQL, and Drizzle.
- Run the site and dashboard on Vercel. Run the public Next.js API and a separate
  worker on Railway so multipart uploads and processing are not constrained by
  Vercel's function request-body limit.
- Share domain services for identity, organization authorization, plans, quota,
  and conversion state between dashboard and public API entry points.
- Use BullMQ with Redis over TCP for durable work. Store private input/output
  objects in R2. Provide equivalent PostgreSQL, Redis, and object-storage
  services through Docker Compose for local development.
- Implement the engine behind six explicit stages: Analyzer, Template Detector,
  Content Extractor, Layout Engine, PDF Composer, and Validator.
- Use PDF.js for inspection and pdf-lib page-region embedding for digital PDFs.
  Use local Tesseract with Portuguese and English data only to identify regions
  in scanned PDFs; never reconstruct fiscal text from OCR output.
- Version every template detector, region set, layout rule, and fixture. Reject
  an unknown or ambiguous template instead of applying a generic fallback.
- Persist organizations, memberships, subscriptions, conversions, batches,
  usage reservations, API keys, webhook endpoints/deliveries, processing events,
  engine/template versions, states, and attempts.
- Integrate Stripe Checkout/Portal, Resend, Sentry, and PostHog behind adapters so
  domain behavior remains testable and document contents never enter telemetry.

## Alternatives considered

- Stack complete pages vertically and scale them down: rejected because large
  blank areas reduce readability and code reliability.
- Rasterize every input: rejected because it degrades digital PDFs and discards
  embedded fonts and vector codes.
- Process all uploads in Vercel functions: rejected because request-size and
  execution constraints conflict with the published plan limits and OCR work.
- OCR and redraw scanned fiscal content: rejected because recognition errors can
  alter legally relevant information.
- Generic fallback for new layouts: rejected because silent miscomposition is
  less safe than an explicit unsupported-template result.

## Consequences

- Deployments require Vercel, Railway web/worker services, PostgreSQL, Redis,
  R2, and configured provider credentials.
- API and worker share domain packages but have independent scaling and health
  checks.
- At-least-once queues and provider webhooks require idempotent state transitions
  and atomic quota accounting.
- New marketplaces require samples, a versioned template implementation,
  synthetic fixtures, automated validation, and physical approval for each
  released size.
- Scanned conversions will be slower and measured separately from digital jobs.

## References

- [Product specification](../02-features/uno-platform.md)
- [Public API contract](../03-contracts/public-api-v1.md)
- [PDF engine contract](../03-contracts/pdf-engine-v1.md)
