# Retention and security hardening

Governing contract: `specs/03-contracts/security-retention-v1.md`. This page
separates what the code enforces from what the operator must still provide.

## Retention lifecycle

`artifactsExpireAt` is fixed when a conversion or batch is accepted; later plan
changes never move it. Once it has passed, the retention worker
(`src/workers/retention-worker.ts`, logic in `src/server/retention/`) runs a
bounded pass in this order:

1. **Batches.** The row is locked and re-checked. A valid archive lease defers
   the batch, as does a child still holding a valid processing lease. An open
   batch has its aggregate closed first (`completedCount`/`failedCount` taken
   from the children, archive marked `archive_expired`, one `batch.completed`
   event with status `failed`); the packager is fenced by the status change.
   The batch becomes `deleting`, the ZIP is deleted, then it becomes `deleted`.
2. **Conversions.** Batch row, then conversion row, are locked and re-checked.
   A valid processing lease defers the conversion. A child waits until its
   batch aggregate is closed. An expired processing claim is fenced and its
   per-attempt output key is registered on the row so the deletion can be
   retried. A reservation still `RESERVED` is released; `CONFIRMED` usage is
   never touched. The row becomes `deleting`, the registered objects (input,
   output, consumed upload staging object) are deleted, then it becomes
   `deleted` with `deletedAt`.
3. **Upload intents** never consumed by a conversion are removed with their
   staged object after the last signed PUT validity plus a grace period.
4. **Engine workspaces** abandoned by a dead parent process are removed.

Every claim carries a fencing token and a lease (`retentionToken`,
`retentionLeaseExpiresAt`). `deleted` is confirmed only by the claim that
deleted every object; a failed or interrupted deletion stays `deleting` and is
retried after the lease. Deleting an absent object succeeds, so repeating a
pass is safe and several workers may run concurrently.

A tombstone keeps IDs, foreign keys, source, template/engine versions, hashes,
counters, usage records and processing events. It removes `originalFileName`
from the conversion and from the upload records behind it (mandatory name
columns receive the placeholder `removido`).

Readers hide `deleting`/`deleted` records (404), and download signing and
reprocessing re-check expiry on the server at request time. A closed batch
reports the aggregate stored at completion, not a live count of its children.

### Orphans

Objects are deleted only through a record that proves ownership. There is no
bucket listing and no sweep. `collectOrphanCandidate` accepts a candidate only
with organization, owner, attempt token, the exact derived key and a due time;
it re-reads the owner under lock and preserves the object when the owner is
missing, still references the key, still owns the attempt, or when the database
answer is unavailable or inconclusive.

Not removable by code today, because nothing in the database names them: an
input snapshot whose commit result stayed unknown, a per-attempt output left by
a processor that crashed before a later attempt succeeded, and incomplete
multipart uploads. These need the bucket lifecycle rules below.

## Configuration

| Variable | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `UNO_RETENTION_INTERVAL_MS` | 60000 | 1000 to 3600000 | Delay between passes |
| `UNO_RETENTION_BATCH_SIZE` | 50 | 1 to 500 | Records claimed per kind and pass |
| `UNO_RETENTION_LEASE_MS` | 300000 | 10000 to 3600000 | Claim lifetime; retry delay after a failed deletion |
| `UNO_RETENTION_UPLOAD_GRACE_MS` | 900000 | 60000 to 86400000 | Wait after the signed PUT expiry before removing an unused upload |
| `UNO_ENGINE_TMP_MAX_AGE_MS` | 3600000 | 300000 to 604800000 | Minimum age of an abandoned engine workspace |
| `UNO_CSP_CONNECT_SRC` | empty | HTTPS origins, space or comma separated | Extra origins the browser may fetch |

An unset variable uses the default. A value that is not an integer inside the
allowed range stops the retention worker at start; an invalid
`UNO_CSP_CONNECT_SRC` fails the configuration load. Nothing falls back
silently. Retention length itself comes from the plan catalogue (`docs/billing.md`).

## Sign-up without e-mail confirmation (NEX-42)

Owner decision: confirming the e-mail no longer blocks normal use. Sign-up
signs the person in at once, and no confirmation e-mail is sent automatically
(`requireEmailVerification`, `sendOnSignUp` and `sendOnSignIn` are off; the
sender stays configured for on-demand confirmation at `/verify-email` and on
the invitation screen).

Trade-off: an account no longer proves that its owner controls the address.
Anyone can register `someone@company.com` and use a FREE organization under
that name. Everything that trusts the address still requires a confirmed
e-mail, re-read from the database on every operation:

- **Platform administration.** `platform_role = 'ADMIN'` is granted from
  `ADMIN_EMAILS` when the account is created, so `isPlatformAdmin` and
  `assertPlatformAdmin` also require `email_verified`. Someone who registers an
  admin address first gets the role stored but never the access; the real
  owner of the address must confirm it (or the operator must delete the
  impostor account) before administering.
- **Invitation acceptance.** Invitations match by e-mail, so accepting one
  returns 403 `email_not_verified` until the address is confirmed.
- **Google account linking.** Better Auth's default
  `requireLocalEmailVerified` stays on: a Google sign-in never links implicitly
  onto a password account whose e-mail was not confirmed (the person is told to
  sign in with e-mail and password). Accounts created by Google arrive
  confirmed by Google.

- **Confirmation never hands an account over.** Without this, someone could
  register the victim's address, trigger a confirmation e-mail, and the victim's
  click would mark the account confirmed and sign the victim into it (and the
  creator, who knows the password, would keep their session). So
  `autoSignInAfterVerification` is off and `afterEmailVerification` ends every
  session of the account. For an `ADMIN_EMAILS` address it also removes the
  password set before confirmation: administration starts only after the inbox
  owner chooses a password through "Esqueci a senha" (or signs in with Google).
- **Redirect targets** (`callbackURL`, the post-auth `/checkout`) go through
  `safeInternalPath`, which validates the normalized path, so `/.//evil.com`
  and similar cannot become `//evil.com`.

Residual risks to monitor: squatting of addresses (a later legitimate owner
gets "Já existe uma conta com este e-mail" and must recover through password
reset, which does prove the address), and abuse of FREE quotas with
throwaway addresses (sign-up stays rate limited per IP).

## HTTP headers

`next.config.ts` sets, for every route: `Content-Security-Policy`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`,
`Cross-Origin-Opener-Policy: same-origin`, and in production
`Strict-Transport-Security` (two years, subdomains, no preload).

The policy allows only same-origin scripts, styles, fonts, images and workers
(the PDF.js worker and its assets are served from `/pdfjs`), plus Stripe.js;
forbids being framed (`frame-ancestors 'none'`), plugins and foreign form
targets; and limits `connect-src` to the app, the private storage origin
(`S3_ENDPOINT`, plus the bucket subdomain), Stripe and PostHog only when a key
is configured. Stripe entries, per Stripe's CSP guidance for the Payment Element
and 3D Secure (NEX-52): `script-src https://js.stripe.com https://*.js.stripe.com`,
`frame-src https://js.stripe.com https://*.js.stripe.com https://hooks.stripe.com https://*.stripe.com`
(the only frames the app may embed), `connect-src https://api.stripe.com
https://m.stripe.network https://q.stripe.com` and `img-src https://*.stripe.com`. It is not a nonce-based policy: `script-src` and
`style-src` include `'unsafe-inline'` because Next.js inlines its bootstrap and
no proxy issues nonces, and `'wasm-unsafe-eval'` is needed by PDF.js decoders.

Headers are fixed when the server is built. If `S3_ENDPOINT` is not available
at build time, `connect-src` falls back to `https:`; set it (or
`UNO_CSP_CONNECT_SRC`) in the build environment to get the narrow policy.

## Card payments (NEX-52)

The checkout page (`/checkout`) embeds Stripe's Payment Element: card number,
expiry and CVC are typed inside Stripe's iframes and go straight to Stripe.
No card data reaches UNO servers, logs or database, which keeps the
integration in PCI DSS SAQ A scope. The server creates the subscription
incomplete and hands the browser only the client secret of its first payment
(or of a SetupIntent when nothing is due); the secret is never stored or
logged. The plan is granted only by the signed Stripe webhook and the
reconciliation that follows it, never by the browser's confirmation; a
subscription whose first invoice is unpaid grants nothing and Stripe expires it
after 23 h.

Saved cards are Stripe PaymentMethods attached to the organization's Customer.
The UNO reads brand, last four digits and expiry from Stripe when a page asks
and stores none of it. The Payment Element gets a short-lived CustomerSession
of that Customer only (OWNER/ADMIN, same origin, rate limited); removing a card
goes through `DELETE /api/dashboard/billing/cards`, which only acts on cards of
the organization's own Customer (others answer 404) and refuses to remove the
only card that pays a live subscription. Removal inside the Payment Element is
disabled for that reason. Changing the card stays in the Stripe Customer Portal.

Card testing: `/subscribe` and the Payment Element could be used to test
stolen cards, and the `setup` path (nothing due today, e.g. a 100% coupon)
validates a card without charging it. The app limits `/subscribe` per user
(`UNO_SUBSCRIBE_RATE_LIMIT`) and coupon lookups per user and address, but it
does not count declines: `payment_intent.payment_failed` and
`setup_intent.setup_failed` are not webhook events the app handles, so no
per-organization failure guard was added. **Operational gate:** enable Stripe
Radar's card-testing protections and add rules that block after repeated
failures (for example, more than 5 declines per customer or per IP address in
an hour) before opening the checkout to the public.

## Temporary files

The engine runs in resident, supervised child processes (one per conversion
slot, `UNO_CONVERSION_CONCURRENCY`). Each parent process creates one private
`0700` root (`uno-engine-XXXXXX`) that is the `TMPDIR` of its children for the
parent's whole life. Every job gets its own `job-<uuid>` directory (`0700`)
inside that root: the child validates the path, creates it, points `TMPDIR` and
`UNO_ENGINE_TMP_DIR` at it for the job and removes it before reporting the
outcome; the parent removes it again on success, failure and timeout. The root
is removed when the pool closes and, synchronously, when the parent exits.

A child serves one job at a time and is retired (SIGKILL of its process group)
on the deadline, which starts at the call and also covers the wait for a free
child; on group RSS above the limit while a job runs; on exit, IPC error,
protocol violation (unexpected message or job id) or a throwing progress
handler; after `UNO_ENGINE_CHILD_MAX_JOBS` jobs (50); when idle for
`UNO_ENGINE_CHILD_IDLE_MS` (10 min, never more than `UNO_ENGINE_TMP_MAX_AGE_MS`);
and when an idle RSS sample exceeds `UNO_ENGINE_CHILD_IDLE_RSS_MB` (640). A
typed engine error (invalid PDF and similar) does not retire the child. Only the
allowlisted error codes cross the boundary. The RSS watchdog reads `/proc` on
Linux (after a self-test at first use) and falls back to `ps` elsewhere.

`recoverAbandonedEngineWorkspaces` removes leftovers only when they are real
directories matching the engine name pattern, owned by the process user,
private, older than the configured age and not the root of a live pool of the
same process. Symbolic links are never followed and no path comes from a
request.

## Operational gates (not enforced by code)

- Bucket private, with lifecycle rules for incomplete multipart uploads and for
  the staging and per-attempt prefixes, as a second line behind the worker.
- Backups and object versioning retain deleted data for their own period.
  Deletion here is logical removal from the live bucket, not instant physical
  erasure; align backup retention with the published policy.
- Run as a non-root user with a read-only application filesystem and a private
  writable temp directory; set container memory, CPU and process limits. The
  supervised child process bounds resources but is not an OS sandbox.
- TLS termination in front of the app, so HSTS is meaningful.
- The retention worker must be running; without it nothing expires.
- Before release, load the app in a browser and confirm the console reports no
  CSP violations for upload, preview, download, checkout (Payment Element and a
  3D Secure challenge with a Stripe test card) and analytics consent.

The phone collected at sign-up (NEX-51) is format-validated only and never verified (no SMS or call, owner decision): treat it as contact data typed by the user, not as proof of identity.
