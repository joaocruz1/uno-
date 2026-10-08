# Deployment runbook

Status: **prepared, NOT VERIFIED**. The images below were written without a
container runtime on the development machine and have never been built or run.
Treat the first build as part of release verification.

## Topology (ADR-0001)

| Service | Where | Image target / command |
| --- | --- | --- |
| Site and dashboard | Vercel | `pnpm build` (standalone Next.js) |
| Public API (`/api/v1`, uploads) | Railway | `Dockerfile` → `node server.js` |
| Worker (queue, engine, webhooks, retention, billing reconcile) | Railway | `Dockerfile.worker` → migrations, then `src/workers/index.ts` |
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

`STRIPE_PRICE_API_ADDON` is optional. It is the price of the "+ API" add-on
(API keys, public API and webhooks, sold on top of any paid plan as a separate
subscription); without it plans are sold normally and the add-on is not
offered. `pnpm stripe:setup <env file>` creates the three plan prices and the
add-on price, writes the four ids and archives the older active prices of
those products. Migration `0010_rich_zodiak` adds the add-on columns: apply it
before the web and API services run this version. No plan includes the API any
more, so organizations that used it through Pro or Business need the add-on
(or a manual grant in `subscriptions.api_addon_*`) to keep access.

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

## Single server with Easypanel

Everything can also run on one server next to PostgreSQL and Redis. Still
**NOT VERIFIED**: these steps have not been executed.

1. **Storage**: create a MinIO service (or use Cloudflare R2), give it an HTTPS
   domain, create a private bucket and allow CORS from the app origin for
   PUT/GET/HEAD. With MinIO set `S3_FORCE_PATH_STYLE=true`. The endpoint must be
   reachable by browsers, because dashboard uploads go straight to storage.
2. **App `uno-web`**: source GitHub repository, build with `Dockerfile`, proxy
   port 3000, attach the domain with HTTPS. Add build arguments `S3_ENDPOINT`
   and `NEXT_PUBLIC_APP_URL` (they are baked into the CSP and the bundle).
3. **App `uno-worker`**: same repository, build with `Dockerfile.worker`, no
   domain or port. It applies pending migrations on every start.
4. **Environment** (both apps): the contents of `.env.production`, using the
   internal hosts of PostgreSQL and Redis. Deploy the worker first.
   Sizing for `uno-worker`: the engine runs in a resident supervised child
   that stays warm between conversions. On macOS a warm idle child measured
   about 570 MB of RSS (mostly native memory of PDF.js and the canvas); Linux
   numbers were not measured yet. The child is replaced when idle RSS exceeds
   `UNO_ENGINE_CHILD_IDLE_RSS_MB` (default 640) and a job is killed above the
   768 MB cap. Give the container at least parent (≈250 MB) + 1 GB per child
   and at least one dedicated vCPU; a throttled CPU is the first thing to check
   when conversions feel slow.
   `UNO_CONVERSION_CONCURRENCY` (default 1, max 4) sets both the number of
   BullMQ slots and of resident children; raise it only with 2+ vCPUs and
   memory for every child. Every completed attempt logs one JSON line
   `{"event":"conversion.completed", ...}` with `queueWaitMs`, `claimMs`,
   `downloadMs`, `spawnMs`, `engineMs`, `uploadMs`, `commitMs` and `wallMs`;
   read it in the service logs to see where time goes in production. The same
   breakdown is stored in `processing_events.metadata` of the `completed` event,
   and Admin → Atividade shows the mean total, engine and queue-wait times.
5. **Administrator**: register on the site, confirm the e-mail, add the address
   to `ADMIN_EMAILS` in both apps, then in the worker console run
   `node --import tsx scripts/create-local-admin.ts you@example.com` and redeploy.
6. **Stripe**: add `https://<domain>/api/stripe/webhook` as an endpoint and set
   `STRIPE_WEBHOOK_SECRET`.
7. **Template release**: publish it in `/admin/templates`; until then every
   conversion is refused in production.
