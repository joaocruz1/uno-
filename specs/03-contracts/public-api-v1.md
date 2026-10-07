---
id: CONTRACT-UNO-API-001
status: approved
owners:
  - UNO platform
---

# Purpose

Define the stable `/api/v1` ERP interface for asynchronous conversion, batches,
and usage. This contract governs externally observable behavior; internal
dashboard routes are outside it.

# Interface

## Common rules

- Authenticate with `Authorization: Bearer <api-key>`. Only Pro and Business
  organizations may create and use keys.
- Accept `Idempotency-Key` on creation endpoints. The same organization, route,
  and key with the same request returns the original resource; reuse with a
  different request returns `409 idempotency_conflict`.
- JSON responses use UTF-8 and include `requestId`. Resource identifiers are
  opaque strings. Timestamps use RFC 3339 UTC.
- Enforce 60 requests/minute for Pro and 120 requests/minute for Business per
  organization. A limited response is `429` and supplies `Retry-After`.
- Never return object-store credentials or permanent object URLs.

## POST `/api/v1/conversions`

Accept `multipart/form-data`:

| Field | Required | Value |
| --- | --- | --- |
| `file` | yes | one PDF containing one logistics + DANFE pair |
| `template` | no | released template identifier; omitted means auto-detect |
| `size` | no | `100x150`, `100x100`, `a6`, or `custom`; defaults to `100x150` |
| `widthMm` | custom only | number from 50 through 210 |
| `heightMm` | custom only | number from 50 through 300 |

When `template` is supplied, the detector must verify that the input matches it;
it must not force that template onto a non-matching PDF. Auto-detection still
rejects unknown and ambiguous inputs.

On accepted enqueue, atomically reserve one label and return `202`:

```json
{
  "requestId": "req_...",
  "id": "cnv_...",
  "status": "queued",
  "progress": 0,
  "createdAt": "2026-01-01T00:00:00Z"
}
```

## GET `/api/v1/conversions/{id}`

Return only a resource owned by the authenticated organization. The conversion
contains `id`, `status`, `progress`, `template`, `size`, `engineVersion`,
`templateVersion`, `createdAt`, and `updatedAt`.

- While active, `status` is `queued` or `processing`; `progress` reflects stored
  stage events.
- On success, `status` is `completed` and `download` contains an expiring signed
  URL and `expiresAt`.
- On terminal failure, `status` is `failed`, `download` is absent, and `error`
  contains a stable `code`, safe `message`, and optional `suggestedSize`.

## POST `/api/v1/batches`

Accept `multipart/form-data` with repeated `files`, plus the same optional
template/size fields and defaults as conversion creation. File count must fit
the organization's plan.
Reserve quota atomically for the accepted file count and return `202` with a
batch `id`, `status: "queued"`, `progress: 0`, and item count. Idempotency covers
the whole batch.

## GET `/api/v1/batches/{id}`

Return `id`, `status`, aggregate `progress`, counts by state, item summaries,
and timestamps. Batch status is `queued`, `processing`, `completed`, or `failed`.
After every item is terminal, keep `processing` with `phase: "packaging"` until
the ZIP is durably published. Then the batch is `completed` when at least one output
succeeded and `failed` when no output succeeded; an unrecoverable batch-level
orchestration error also produces `failed`. A completed batch includes an
expiring signed ZIP URL and expiry for successful outputs, and may expose failed
item errors without leaking file contents.
An exhausted archive retry produces `failed/archive_failed` while preserving
successful individual downloads and their confirmed usage.

## GET `/api/v1/usage`

Return the authenticated organization's current plan and billing-period usage:
`periodStart`, `periodEnd`, `limit`, `reserved`, `confirmed`, and `remaining`.
Remaining usage accounts for active reservations and never becomes negative.

# Inputs and outputs

Allowed output sizes and plan limits are defined in `SPEC-UNO-001`. A file over
the plan limit is rejected before enqueue. Creation latency excludes upload
transfer time and does not wait for conversion completion.

Webhook endpoint configuration is managed in the dashboard. UNO emits these
event types:

- `conversion.completed`
- `conversion.failed`
- `batch.completed`

`batch.completed` means processing reached a terminal aggregate state. Its data
includes the final batch `status` (`completed` or `failed`) and item counts, so a
single event covers full success, partial success, and zero-output failure.

Each POST body contains `id`, `type`, `createdAt`, `organizationId`, and `data`.
Send `X-Label-Timestamp` as Unix seconds, `X-Label-Delivery` as the opaque
delivery identifier, and `X-Label-Signature` as
`v1=<lowercase-hex-HMAC-SHA256>`. Compute the HMAC with the endpoint secret over
the UTF-8 bytes of `<timestamp>.<exact transmitted body>` before any parsing or
re-serialization. Receivers can reject stale timestamps and deduplicate by the
delivery identifier.
Retry a non-successful delivery after 1 minute, 5 minutes, 30 minutes, 2 hours,
and 12 hours. Event resources follow the same safe-field rules as polling.

# Compatibility and versioning

- `/api/v1` changes remain backward compatible. Breaking wire changes require a
  new major path.
- Adding optional response fields, error codes, template identifiers, or webhook
  event types is compatible.
- API keys are displayed once at creation and stored only as a cryptographic
  hash. Revocation takes effect for subsequent authentication attempts.

# Error behavior

Errors use this envelope:

```json
{
  "requestId": "req_...",
  "error": {
    "code": "unsupported_template",
    "message": "The PDF does not match the selected template."
  }
}
```

Required stable codes include `invalid_request`, `invalid_pdf`, `pdf_encrypted`,
`file_too_large`, `unsupported_template`, `ambiguous_template`,
`codes_unreadable`, `format_too_small`, `quota_exceeded`, `plan_required`,
`idempotency_conflict`, `not_found`, `rate_limited`, and `internal_error`.
Use `401` for invalid/missing keys, `403` for plan or scope denial, `404` for an
absent or other-organization resource, `413` for file size, `422` for validly
encoded but unprocessable input, and `5xx` only for service failures. Logs and
errors must not contain document bytes or extracted personal/fiscal values.
