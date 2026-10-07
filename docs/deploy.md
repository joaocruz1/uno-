# Deployment runbook

Status: **prepared, NOT VERIFIED**. The images below were written without a
container runtime on the development machine and have never been built or run.
Treat the first build as part of release verification.

## Topology (ADR-0001)

| Service | Where | Image target / command |
| --- | --- | --- |
| Site and dashboard | Vercel | `pnpm build` (standalone Next.js) |
| Public API (`/api/v1`, uploads) | Railway | `docker build --target web` → `node server.js` |
| Worker (queue, engine, webhooks, retention, billing reconcile) | Railway | `docker build --target worker` → `node --import tsx src/workers/index.ts` |
| PostgreSQL 17, Redis 7 (`noeviction`, TCP) | managed | — |
| Private object storage | Cloudflare R2 | bucket never public |

The worker image installs Tesseract with Portuguese and English data. Run the
web and worker containers as the non-root `node` user with a read-only root
filesystem, a private writable temp directory, and hard memory/CPU/process
limits. Aggregate worker memory (parent, engine child, ZIP packaging) must be
measured before the limits are fixed.

## Release order

1. Build both targets from the same commit.
2. Run migrations once from the worker image:
   `node --import tsx scripts/migrate.ts`. Migrations are forward-only;
   `0008` adds an enum value and new NOT NULL webhook delivery columns, which
   is safe only while `webhook_deliveries` is empty (true before first release).
3. Deploy the worker, then the web/API service, then the Vercel site.
4. Check `GET /api/health` on each web origin, then create one synthetic
   conversion through the dashboard and one through `/api/v1`.

Rollback: redeploy the previous image pair. Do not roll the database back;
restore from backup only for data loss, after stopping workers.

## Configuration

Every variable is listed in `.env.example`. Required in production:
`DATABASE_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET` (≥ 32 chars),
`BETTER_AUTH_URL`, `APP_URL`, `API_URL`, `S3_*`, `RESEND_API_KEY`,
`EMAIL_FROM`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PRICE_{STARTER,PRO,BUSINESS}`, `WEBHOOK_ENCRYPTION_KEY`, and
`ADMIN_EMAILS` (platform admins also need `platform_role = 'ADMIN'` in the
database). `UNO_ALLOW_DRAFT_TEMPLATES` is ignored in production.

Security headers and the Content-Security-Policy are computed at **build
time**: `S3_ENDPOINT` (and `NEXT_PUBLIC_POSTHOG_*`, if used) must be present in
the build environment or `connect-src` falls back to `https:`.

## Provider checklist (each item is a release gate)

- R2: private bucket, CORS limited to the dashboard origin (PUT/GET/HEAD),
  lifecycle rules that abort incomplete multipart uploads and expire
  `*/api-staging/*` and batch staging prefixes. See `docs/security.md`.
- Stripe: three monthly prices, Customer Portal, webhook endpoint
  `/api/stripe/webhook`. See `docs/billing.md`.
- Resend: verified sending domain for `EMAIL_FROM`.
- Sentry/PostHog: optional; PostHog only sends after the user opts in.
- Backups for PostgreSQL; alerts on worker liveness, queue depth, outbox and
  webhook delivery failures (`/admin` shows the same counters).
- Templates: no template/size is usable in production until an administrator
  publishes a release with the automatic report and the physical proof
  (`docs/printing-validation.md`) in `/admin/templates`.

## Not verified

Docker builds, Railway/Vercel deployment, real R2 policy and CORS, real Stripe
payments, real Resend delivery, a real outbound webhook over TLS, container
resource limits, backups, and the physical print proof.
