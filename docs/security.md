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

## HTTP headers

`next.config.ts` sets, for every route: `Content-Security-Policy`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`,
`Cross-Origin-Opener-Policy: same-origin`, and in production
`Strict-Transport-Security` (two years, subdomains, no preload).

The policy allows only same-origin scripts, styles, fonts, images and workers
(the PDF.js worker and its assets are served from `/pdfjs`), forbids framing,
plugins and foreign form targets, and limits `connect-src` to the app, the
private storage origin (`S3_ENDPOINT`, plus the bucket subdomain) and PostHog
only when a key is configured. It is not a nonce-based policy: `script-src` and
`style-src` include `'unsafe-inline'` because Next.js inlines its bootstrap and
no proxy issues nonces, and `'wasm-unsafe-eval'` is needed by PDF.js decoders.

Headers are fixed when the server is built. If `S3_ENDPOINT` is not available
at build time, `connect-src` falls back to `https:`; set it (or
`UNO_CSP_CONNECT_SRC`) in the build environment to get the narrow policy.

## Temporary files

Each conversion runs in a private `0700` directory that the parent removes on
success, failure and timeout. `recoverAbandonedEngineWorkspaces` removes
leftovers only when they are real directories matching the engine name pattern,
owned by the process user, private, and older than the configured age. Symbolic
links are never followed and no path comes from a request.

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
  CSP violations for upload, preview, download, checkout and analytics consent.
