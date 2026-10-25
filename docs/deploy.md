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
database and, since sign-up no longer confirms the address, a confirmed
e-mail: request the link at `/verify-email` or sign in with Google). `UNO_ALLOW_DRAFT_TEMPLATES` is ignored in production.

`STRIPE_PRICE_API_ADDON` is optional. It is the price of the "+ API" add-on
(API keys, public API and webhooks, sold on top of any paid plan as a separate
subscription); without it plans are sold normally and the add-on is not
offered. `pnpm stripe:setup <env file>` creates the three plan prices and the
add-on price, writes the four ids and archives the older active prices of
those products. Migration `0010_rich_zodiak` adds the add-on columns: apply it
before the web and API services run this version. No plan includes the API any
more, so organizations that used it through Pro or Business need the add-on
(or a manual grant in `subscriptions.api_addon_*`) to keep access.

Migration `0018_rare_vance_astro` (NEX-51) adds `user.phone`, the `coupons`
table and the coupon columns of `billing_checkout_intents` and
`subscriptions`. Deploy the worker (which applies migrations) before the web
app. Coupons are created from Admin → Cupons and need Stripe configured;
`UNO_COUPON_RATE_LIMIT` (default 10 per user per minute) limits coupon lookups.

Own checkout (NEX-52): the card is typed on `/checkout`, in Stripe's Payment
Element. Set `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (the `pk_test_`/`pk_live_`
key of the same account and mode as `STRIPE_SECRET_KEY`) in the web app
service. The server reads it at request time (dynamic lookup), so it works as a
runtime variable too; Easypanel also passes it as a build argument, which is
harmless because it is public. Without it, or with a mode mismatch, `/checkout`
shows "A cobrança ainda não está configurada" and no payment is possible.
Migration `0019_strange_songbird` adds `billing_checkout_intents.stripe_subscription_id`
and relaxes the OPEN check (an intent is open with a hosted session or with an
incomplete subscription). Deploy the worker (migrations) before the web app.
The webhook endpoint must receive at least `invoice.paid`,
`invoice.payment_failed` and `customer.subscription.*` (the add-on and plans
are activated by them; `checkout.session.*` stays for sessions opened before
this version). The CSP always allows Stripe.js (`js.stripe.com`), its frames
and 3D Secure (`hooks.stripe.com`, `*.stripe.com`) and `api.stripe.com`,
`m.stripe.network`, `q.stripe.com`; it is fixed at build, so this version must
be rebuilt (not only restarted) for the checkout to load.
Rollback of `0019`: the old `billing_checkout_intents_open_ck` requires a
hosted session on every OPEN intent. Before restoring it, expire the intents
opened by the own checkout:
`update billing_checkout_intents set status = 'EXPIRED', updated_at = now() where status = 'OPEN' and stripe_session_id is null and stripe_subscription_id is not null;`
(their incomplete subscriptions expire on their own in Stripe after 23 h).
Before opening the checkout to the public, enable Stripe Radar's card-testing
protections and a rule that blocks repeated declines per customer/IP (see
`docs/security.md`): the app does not count declines itself.

Google sign-in is optional: set both `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` (web app service only; the worker does not need them)
and the "Continuar com Google" button appears on `/login` and `/register`.
With either one missing, the provider is not registered and the button is
hidden. Create the client in Google Cloud Console → APIs & Services →
Credentials → Create credentials → OAuth client ID → "Web application":

- Authorized JavaScript origins: the public origin, e.g.
  `https://api-nextpy-uno.1nwz76.easypanel.host` (and `http://localhost:3000`
  for development, in a separate client if preferred).
- Authorized redirect URIs: `${BETTER_AUTH_URL}/api/auth/callback/google`
  (`BETTER_AUTH_URL` falls back to `APP_URL`), e.g.
  `https://api-nextpy-uno.1nwz76.easypanel.host/api/auth/callback/google`.
- The OAuth consent screen needs the `openid`, `email` and `profile` scopes
  (the defaults) and must be published ("In production") before people outside
  the test-user list can sign in.

The flow is a top-level redirect to `accounts.google.com` and back to our own
origin, so the CSP (`form-action 'self'`, `connect-src`) needs no change.

Security headers and the Content-Security-Policy are computed at **build
time**: `S3_ENDPOINT` (and `NEXT_PUBLIC_POSTHOG_*`, if used) must be present in
the build environment or `connect-src` falls back to `https:`.

## Provider checklist (each item is a release gate)

- R2: private bucket, CORS limited to the dashboard origin (PUT/GET/HEAD),
  lifecycle rules that abort incomplete multipart uploads and expire
  `*/api-staging/*` and batch staging prefixes. See `docs/security.md`.
- Stripe: three monthly prices, Customer Portal (card update, cancellation,
  invoices), webhook endpoint `/api/stripe/webhook` with `invoice.*` and
  `customer.subscription.*`, publishable key in the web app, Radar
  card-testing protections and decline rules enabled. See
  `docs/billing.md`.
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
   `STRIPE_WEBHOOK_SECRET`; set `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` in the web
   app and rebuild it (the CSP that allows Stripe.js is fixed at build).
7. **Template release**: publish it in `/admin/templates`; until then every
   conversion is refused in production.
