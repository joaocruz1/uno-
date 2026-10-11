import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const uuidDefault = sql`gen_random_uuid()::text`;
const now = sql`now()`;

export const platformRoleEnum = pgEnum("platform_role", ["USER", "ADMIN"]);
export const membershipRoleEnum = pgEnum("membership_role", ["OWNER", "ADMIN", "MEMBER"]);
export const planIdEnum = pgEnum("plan_id", ["FREE", "STARTER", "PRO", "BUSINESS"]);
export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "INCOMPLETE",
  "TRIALING",
  "ACTIVE",
  "PAST_DUE",
  "CANCELED",
  "UNPAID",
  "PAUSED",
]);
export const templateStatusEnum = pgEnum("template_status", ["DRAFT", "RELEASED", "RETIRED"]);
export const conversionStatusEnum = pgEnum("conversion_status", [
  "queued",
  "processing",
  "completed",
  "failed",
  "deleting",
  "deleted",
]);
export const conversionSourceEnum = pgEnum("conversion_source", ["dashboard", "api"]);
export const batchStatusEnum = pgEnum("batch_status", [
  "queued",
  "processing",
  "completed",
  "failed",
  "deleting",
  "deleted",
]);
export const batchUploadSessionStatusEnum = pgEnum("batch_upload_session_status", ["OPEN", "ACCEPTED", "EXPIRED"]);
export const batchUploadItemStatusEnum = pgEnum("batch_upload_item_status", ["PENDING", "UPLOADING", "PREPARING", "READY", "FAILED"]);
export const batchArchiveStatusEnum = pgEnum("batch_archive_status", ["PENDING", "PACKAGING", "READY", "FAILED"]);
/** A lote of independent files (ZIP output) or a marketplace export split into orders (one combined PDF). */
export const batchKindEnum = pgEnum("batch_kind", ["files", "marketplace"]);
export const pageRoleEnum = pgEnum("page_role", ["logistics", "danfe"]);
export const pageKindEnum = pgEnum("page_kind", ["digital", "scanned"]);
export const usageReservationStatusEnum = pgEnum("usage_reservation_status", [
  "RESERVED",
  "CONFIRMED",
  "RELEASED",
]);
export const requestStatusEnum = pgEnum("request_status", ["PENDING", "COMPLETED", "FAILED"]);
export const apiRequestUploadStatusEnum = pgEnum("api_request_upload_status", ["PREPARING", "READY", "COMMITTED", "ABORTED"]);
export const outboxStatusEnum = pgEnum("outbox_status", ["PENDING", "PROCESSING", "PUBLISHED", "FAILED"]);
export const deliveryStatusEnum = pgEnum("delivery_status", ["PENDING", "PROCESSING", "DELIVERED", "FAILED", "CANCELED"]);
export const invitationStatusEnum = pgEnum("invitation_status", ["PENDING", "ACCEPTED", "REVOKED"]);
export const stripeEventStatusEnum = pgEnum("stripe_event_status", ["PROCESSING", "PROCESSED", "FAILED"]);
export const billingCheckoutStatusEnum = pgEnum("billing_checkout_status", ["CREATING", "OPEN", "COMPLETED", "EXPIRED", "FAILED"]);
/** Where a prepaid grant of plan days came from. */
export const billingGrantSourceEnum = pgEnum("billing_grant_source", ["PIX", "REFERRAL"]);
export const billingGrantStatusEnum = pgEnum("billing_grant_status", ["APPLIED", "REVOKED"]);
/** Lifecycle of a one-off PIX charge that buys prepaid plan days. */
export const pixChargeStatusEnum = pgEnum("pix_charge_status", ["PENDING", "APPROVED", "EXPIRED", "FAILED"]);

// Better Auth 1.7.7 core tables. Property names stay canonical for the adapter;
// physical names are snake_case for PostgreSQL tooling and raw SQL.
export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey().default(uuidDefault),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    platformRole: platformRoleEnum("platform_role").notNull().default("USER"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [uniqueIndex("user_email_uq").on(table.email)],
);

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey().default(uuidDefault),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("session_token_uq").on(table.token), index("session_user_id_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey().default(uuidDefault),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index("account_user_id_idx").on(table.userId),
    uniqueIndex("account_provider_account_uq").on(table.providerId, table.accountId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey().default(uuidDefault),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey().default(uuidDefault),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [uniqueIndex("organizations_slug_uq").on(table.slug), index("organizations_owner_user_id_idx").on(table.ownerUserId)],
);

export const memberships = pgTable(
  "memberships",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: membershipRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    primaryKey({ name: "memberships_pk", columns: [table.organizationId, table.userId] }),
    index("memberships_user_id_idx").on(table.userId),
    index("memberships_org_role_idx").on(table.organizationId, table.role),
    uniqueIndex("memberships_one_owner_uq").on(table.organizationId).where(sql`${table.role} = 'OWNER'`),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    planId: planIdEnum("plan_id").notNull().default("FREE"),
    status: subscriptionStatusEnum("status").notNull().default("ACTIVE"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripePriceId: text("stripe_price_id"),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    // API add-on: a separate Stripe subscription on the same customer.
    apiAddonSubscriptionId: text("api_addon_subscription_id"),
    apiAddonStatus: subscriptionStatusEnum("api_addon_status"),
    apiAddonCurrentPeriodEnd: timestamp("api_addon_current_period_end", { withTimezone: true }),
    // Prepaid plan days bought by PIX or earned by referral, independent of Stripe.
    // Reconciliation never writes these, so an active Stripe sub cannot clear them.
    prepaidPlanId: planIdEnum("prepaid_plan_id"),
    prepaidPeriodEnd: timestamp("prepaid_period_end", { withTimezone: true }),
    reconciliationVersion: integer("reconciliation_version").notNull().default(0),
    lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex("subscriptions_organization_id_uq").on(table.organizationId),
    uniqueIndex("subscriptions_stripe_customer_id_uq").on(table.stripeCustomerId).where(sql`${table.stripeCustomerId} is not null`),
    uniqueIndex("subscriptions_stripe_subscription_id_uq").on(table.stripeSubscriptionId).where(sql`${table.stripeSubscriptionId} is not null`),
    check("subscriptions_reconciliation_version_ck", sql`${table.reconciliationVersion} >= 0`),
    check("subscriptions_prepaid_ck", sql`(${table.prepaidPlanId} is null and ${table.prepaidPeriodEnd} is null) or (${table.prepaidPlanId} is not null and ${table.prepaidPlanId} <> 'FREE' and ${table.prepaidPeriodEnd} is not null)`),
  ],
);

/**
 * Idempotent ledger of prepaid plan days granted to an organization. `externalRef`
 * (the PIX payment id or the referral cycle key) is unique, so replaying a webhook
 * or a referral reward never grants twice. The effective prepaid state lives on
 * `subscriptions.prepaid_*`; this table is the audit trail and the dedup key.
 */
export const billingGrants = pgTable(
  "billing_grants",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    planId: planIdEnum("plan_id").notNull(),
    days: integer("days").notNull(),
    source: billingGrantSourceEnum("source").notNull(),
    externalRef: text("external_ref").notNull(),
    amountBrlCents: integer("amount_brl_cents"),
    status: billingGrantStatusEnum("status").notNull().default("APPLIED"),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().default(now),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex("billing_grants_external_ref_uq").on(table.externalRef),
    index("billing_grants_org_idx").on(table.organizationId, table.appliedAt),
    check("billing_grants_days_ck", sql`${table.days} > 0`),
    check("billing_grants_plan_ck", sql`${table.planId} <> 'FREE'`),
    check("billing_grants_amount_ck", sql`${table.amountBrlCents} is null or ${table.amountBrlCents} >= 0`),
  ],
);

/**
 * One-off PIX charge (via the PixProvider, e.g. Mercado Pago) that buys prepaid
 * plan days. The webhook reconsults the payment and, once approved, grants the
 * days through `applyGrant` keyed by `pix:<provider_charge_id>`, so a replayed
 * notification never grants twice.
 */
export const pixCharges = pgTable(
  "pix_charges",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    planId: planIdEnum("plan_id").notNull(),
    days: integer("days").notNull(),
    amountBrlCents: integer("amount_brl_cents").notNull(),
    provider: text("provider").notNull().default("mercadopago"),
    providerChargeId: text("provider_charge_id"),
    status: pixChargeStatusEnum("status").notNull().default("PENDING"),
    qrCode: text("qr_code"),
    qrCodeBase64: text("qr_code_base64"),
    grantExternalRef: text("grant_external_ref"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    unique("pix_charges_org_id_uq").on(table.organizationId, table.id),
    uniqueIndex("pix_charges_provider_charge_uq").on(table.providerChargeId).where(sql`${table.providerChargeId} is not null`),
    index("pix_charges_org_created_idx").on(table.organizationId, table.createdAt),
    check("pix_charges_days_ck", sql`${table.days} > 0`),
    check("pix_charges_plan_ck", sql`${table.planId} <> 'FREE'`),
    check("pix_charges_amount_ck", sql`${table.amountBrlCents} >= 0`),
  ],
);

/** A user's shareable referral code (one per user). */
export const referralCodes = pgTable(
  "referral_codes",
  {
    id: text("id").primaryKey().default(uuidDefault),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex("referral_codes_user_id_uq").on(table.userId),
    uniqueIndex("referral_codes_code_uq").on(table.code),
  ],
);

/**
 * Who referred whom. One referrer per referred (immutable), never self.
 * "Active" is computed on read (the referred has ≥1 completed conversion), and
 * the reward is a billing_grants row keyed by `referral:<referrer>`, so the
 * once-ever bonus cannot be granted twice.
 */
export const referrals = pgTable(
  "referrals",
  {
    id: text("id").primaryKey().default(uuidDefault),
    referrerUserId: text("referrer_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    referredUserId: text("referred_user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    /** Hashed signup IP, for same-source review; never the raw IP. */
    signupIpHash: text("signup_ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex("referrals_referred_user_id_uq").on(table.referredUserId),
    index("referrals_referrer_user_id_idx").on(table.referrerUserId),
    check("referrals_not_self_ck", sql`${table.referrerUserId} <> ${table.referredUserId}`),
  ],
);

export const billingCheckoutIntents = pgTable(
  "billing_checkout_intents",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    // Exactly one target: a paid plan, or the API add-on.
    planId: planIdEnum("plan_id"),
    addon: text("addon"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    providerAttempt: integer("provider_attempt").notNull().default(1),
    stripeSessionId: text("stripe_session_id"),
    checkoutUrl: text("checkout_url"),
    status: billingCheckoutStatusEnum("status").notNull().default("CREATING"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    unique("billing_checkout_intents_org_id_uq").on(table.organizationId, table.id),
    uniqueIndex("billing_checkout_intents_org_idempotency_uq").on(table.organizationId, table.idempotencyKey),
    uniqueIndex("billing_checkout_intents_stripe_session_uq").on(table.stripeSessionId).where(sql`${table.stripeSessionId} is not null`),
    uniqueIndex("billing_checkout_intents_org_active_uq").on(table.organizationId).where(sql`${table.status} in ('CREATING','OPEN')`),
    index("billing_checkout_intents_status_expires_idx").on(table.status, table.expiresAt),
    check("billing_checkout_intents_plan_ck", sql`(${table.planId} is not null and ${table.planId} <> 'FREE' and ${table.addon} is null) or (${table.planId} is null and ${table.addon} = 'API')`),
    check("billing_checkout_intents_idempotency_ck", sql`char_length(${table.idempotencyKey}) between 16 and 128 and ${table.requestHash} ~ '^[0-9a-f]{64}$'`),
    check("billing_checkout_intents_provider_attempt_ck", sql`${table.providerAttempt} > 0`),
    check("billing_checkout_intents_open_ck", sql`${table.status} <> 'OPEN' or (${table.stripeSessionId} is not null and ${table.checkoutUrl} is not null and ${table.expiresAt} is not null)`),
  ],
);

export const templates = pgTable(
  "templates",
  {
    id: text("id").primaryKey().default(uuidDefault),
    key: text("key").notNull(),
    version: text("version").notNull(),
    displayName: text("display_name").notNull(),
    engineVersion: text("engine_version").notNull(),
    status: templateStatusEnum("status").notNull().default("DRAFT"),
    definition: jsonb("definition").notNull().$type<Record<string, unknown>>(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex("templates_key_version_uq").on(table.key, table.version),
    index("templates_status_key_idx").on(table.status, table.key),
  ],
);

export const usagePeriods = pgTable(
  "usage_periods",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    limit: integer("limit").notNull(),
    reserved: integer("reserved").notNull().default(0),
    confirmed: integer("confirmed").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex("usage_periods_org_period_uq").on(table.organizationId, table.periodStart, table.periodEnd),
    unique("usage_periods_org_id_uq").on(table.organizationId, table.id),
    check("usage_periods_dates_ck", sql`${table.periodEnd} > ${table.periodStart}`),
    check("usage_periods_limit_ck", sql`${table.limit} >= 0`),
    check("usage_periods_counters_ck", sql`${table.reserved} >= 0 and ${table.confirmed} >= 0 and ${table.reserved} + ${table.confirmed} <= ${table.limit}`),
  ],
);

export const uploadIntents = pgTable(
  "upload_intents",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull().default("application/pdf"),
    contentLength: integer("content_length").notNull(),
    checksumSha256: text("checksum_sha256"),
    originalFileName: text("original_file_name"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex("upload_intents_object_key_uq").on(table.objectKey),
    unique("upload_intents_org_id_uq").on(table.organizationId, table.id),
    index("upload_intents_org_expires_idx").on(table.organizationId, table.expiresAt),
    index("upload_intents_created_by_user_id_idx").on(table.createdByUserId),
    check("upload_intents_content_length_ck", sql`${table.contentLength} > 0`),
    check(
      "upload_intents_original_file_name_ck",
      sql`${table.originalFileName} is null or (char_length(${table.originalFileName}) between 1 and 160 and position('/' in ${table.originalFileName}) = 0 and position(chr(92) in ${table.originalFileName}) = 0 and ${table.originalFileName} !~ '[[:cntrl:]]')`,
    ),
  ],
);

export const batchUploadSessions = pgTable(
  "batch_upload_sessions",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    status: batchUploadSessionStatusEnum("status").notNull().default("OPEN"),
    templateReference: text("template_reference").notNull(),
    outputPreset: text("output_preset").notNull(),
    outputWidthMm: numeric("output_width_mm", { precision: 6, scale: 2 }).notNull(),
    outputHeightMm: numeric("output_height_mm", { precision: 6, scale: 2 }).notNull(),
    acceptedBatchId: text("accepted_batch_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    unique("batch_upload_sessions_org_id_uq").on(table.organizationId, table.id),
    uniqueIndex("batch_upload_sessions_accepted_batch_uq").on(table.acceptedBatchId).where(sql`${table.acceptedBatchId} is not null`),
    index("batch_upload_sessions_org_status_expires_idx").on(table.organizationId, table.status, table.expiresAt),
    check("batch_upload_sessions_size_ck", sql`${table.outputWidthMm} between 50 and 210 and ${table.outputHeightMm} between 50 and 300`),
  ],
);

export const batchUploadItems = pgTable(
  "batch_upload_items",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull(),
    clientItemId: text("client_item_id").notNull(),
    originalFileName: text("original_file_name").notNull(),
    contentLength: integer("content_length").notNull(),
    expectedSha256: text("expected_sha256"),
    status: batchUploadItemStatusEnum("status").notNull().default("PENDING"),
    stagingObjectKey: text("staging_object_key"),
    stagingExpiresAt: timestamp("staging_expires_at", { withTimezone: true }),
    readyObjectKey: text("ready_object_key"),
    readySha256: text("ready_sha256"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    unique("batch_upload_items_org_id_uq").on(table.organizationId, table.id),
    uniqueIndex("batch_upload_items_session_client_uq").on(table.sessionId, table.clientItemId),
    uniqueIndex("batch_upload_items_staging_key_uq").on(table.stagingObjectKey).where(sql`${table.stagingObjectKey} is not null`),
    uniqueIndex("batch_upload_items_ready_key_uq").on(table.readyObjectKey).where(sql`${table.readyObjectKey} is not null`),
    index("batch_upload_items_org_status_idx").on(table.organizationId, table.status),
    foreignKey({ name: "batch_upload_items_org_session_fk", columns: [table.organizationId, table.sessionId], foreignColumns: [batchUploadSessions.organizationId, batchUploadSessions.id] }).onDelete("cascade"),
    check("batch_upload_items_content_length_ck", sql`${table.contentLength} > 0`),
    check("batch_upload_items_client_id_ck", sql`char_length(${table.clientItemId}) between 1 and 128 and ${table.clientItemId} !~ '[[:cntrl:]]'`),
    check("batch_upload_items_sha_ck", sql`${table.expectedSha256} is null or ${table.expectedSha256} ~ '^[0-9a-f]{64}$'`),
    check("batch_upload_items_ready_sha_ck", sql`${table.readySha256} is null or ${table.readySha256} ~ '^[0-9a-f]{64}$'`),
    check("batch_upload_items_name_ck", sql`char_length(${table.originalFileName}) between 1 and 160 and position('/' in ${table.originalFileName}) = 0 and position(chr(92) in ${table.originalFileName}) = 0 and ${table.originalFileName} !~ '[[:cntrl:]]'`),
    check("batch_upload_items_ready_ck", sql`${table.status} <> 'READY' or (${table.readyObjectKey} is not null and ${table.readySha256} is not null and ${table.completedAt} is not null)`),
  ],
);

export const batches = pgTable(
  "batches",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    apiKeyId: text("api_key_id"),
    uploadSessionId: text("upload_session_id"),
    idempotencyKey: text("idempotency_key"),
    requestHash: text("request_hash"),
    status: batchStatusEnum("status").notNull().default("queued"),
    phase: text("phase").notNull().default("queued"),
    /** "files" = ZIP of independent uploads; "marketplace" = one combined PDF from a split export. */
    kind: batchKindEnum("kind").notNull().default("files"),
    /** Source marketplace for kind='marketplace' (e.g. "mercado-livre"); null for "files". */
    marketplace: text("marketplace"),
    /** Label numbering options for the combined PDF (kind='marketplace'); null when off. */
    numbering: jsonb("numbering").$type<{ letter?: string; start: number; showTotal: boolean }>(),
    itemCount: integer("item_count").notNull(),
    completedCount: integer("completed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    progress: integer("progress").notNull().default(0),
    zipObjectKey: text("zip_object_key"),
    zipByteLength: bigint("zip_byte_length", { mode: "number" }),
    /** Output for kind='marketplace': one combined PDF instead of a ZIP. */
    combinedPdfObjectKey: text("combined_pdf_object_key"),
    combinedPdfByteLength: bigint("combined_pdf_byte_length", { mode: "number" }),
    archiveStatus: batchArchiveStatusEnum("archive_status").notNull().default("PENDING"),
    archiveAttempts: integer("archive_attempts").notNull().default(0),
    archiveMaxAttempts: integer("archive_max_attempts").notNull().default(3),
    archiveToken: text("archive_token"),
    archiveLeaseExpiresAt: timestamp("archive_lease_expires_at", { withTimezone: true }),
    archiveErrorCode: text("archive_error_code"),
    archiveErrorMessage: text("archive_error_message"),
    artifactsExpireAt: timestamp("artifacts_expire_at", { withTimezone: true }),
    retentionToken: text("retention_token"),
    retentionLeaseExpiresAt: timestamp("retention_lease_expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("batches_org_id_uq").on(table.organizationId, table.id),
    uniqueIndex("batches_upload_session_uq").on(table.uploadSessionId).where(sql`${table.uploadSessionId} is not null`),
    uniqueIndex("batches_org_idempotency_uq").on(table.organizationId, table.idempotencyKey).where(sql`${table.idempotencyKey} is not null`),
    index("batches_org_status_created_idx").on(table.organizationId, table.status, table.createdAt),
    index("batches_created_by_user_id_idx").on(table.createdByUserId),
    index("batches_api_key_id_idx").on(table.apiKeyId),
    index("batches_retention_idx").on(table.artifactsExpireAt).where(sql`${table.status} <> 'deleted'`),
    index("batches_archive_lease_idx").on(table.archiveLeaseExpiresAt).where(sql`${table.phase} = 'packaging'`),
    foreignKey({ name: "batches_org_upload_session_fk", columns: [table.organizationId, table.uploadSessionId], foreignColumns: [batchUploadSessions.organizationId, batchUploadSessions.id] }).onDelete("restrict"),
    foreignKey({ name: "batches_org_api_key_fk", columns: [table.organizationId, table.apiKeyId], foreignColumns: [apiKeys.organizationId, apiKeys.id] }).onDelete("restrict"),
    check("batches_item_count_ck", sql`${table.itemCount} > 0`),
    check("batches_counts_ck", sql`${table.completedCount} >= 0 and ${table.failedCount} >= 0 and ${table.completedCount} + ${table.failedCount} <= ${table.itemCount}`),
    check("batches_progress_ck", sql`${table.progress} between 0 and 100`),
    check("batches_phase_ck", sql`${table.phase} in ('queued','processing','packaging','completed','failed')`),
    check("batches_idempotency_ck", sql`(${table.idempotencyKey} is null and ${table.requestHash} is null) or (${table.idempotencyKey} is not null and ${table.requestHash} is not null and char_length(${table.idempotencyKey}) between 16 and 128 and ${table.requestHash} ~ '^[0-9a-f]{64}$')`),
    check("batches_archive_attempts_ck", sql`${table.archiveAttempts} >= 0 and ${table.archiveMaxAttempts} > 0 and ${table.archiveAttempts} <= ${table.archiveMaxAttempts}`),
    check("batches_archive_claim_ck", sql`(${table.archiveStatus} = 'PACKAGING' and ${table.archiveToken} is not null and ${table.archiveLeaseExpiresAt} is not null) or (${table.archiveStatus} <> 'PACKAGING' and ${table.archiveToken} is null and ${table.archiveLeaseExpiresAt} is null)`),
    check("batches_kind_ck", sql`(${table.kind} = 'files' and ${table.marketplace} is null) or (${table.kind} = 'marketplace' and ${table.marketplace} is not null)`),
  ],
);

export const conversions = pgTable(
  "conversions",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    apiKeyId: text("api_key_id"),
    batchId: text("batch_id"),
    /** Position of this order inside a kind='marketplace' lote, so the combined PDF keeps upload order. */
    batchOrderIndex: integer("batch_order_index"),
    uploadIntentId: text("upload_intent_id"),
    sourceConversionId: text("source_conversion_id"),
    reprocessIdempotencyKey: text("reprocess_idempotency_key"),
    reprocessRequestHash: text("reprocess_request_hash"),
    templateId: text("template_id")
      .notNull()
      .references(() => templates.id, { onDelete: "restrict" }),
    templateVersion: text("template_version").notNull(),
    engineVersion: text("engine_version").notNull(),
    status: conversionStatusEnum("status").notNull().default("queued"),
    source: conversionSourceEnum("source").notNull().default("dashboard"),
    originalFileName: text("original_file_name"),
    progress: integer("progress").notNull().default(0),
    currentStage: text("current_stage"),
    outputPreset: text("output_preset").notNull(),
    outputWidthMm: numeric("output_width_mm", { precision: 6, scale: 2 }).notNull(),
    outputHeightMm: numeric("output_height_mm", { precision: 6, scale: 2 }).notNull(),
    inputObjectKey: text("input_object_key").notNull(),
    inputSha256: text("input_sha256"),
    outputObjectKey: text("output_object_key"),
    sourceByteLength: integer("source_byte_length").notNull(),
    inputPages: integer("input_pages"),
    outputPages: integer("output_pages"),
    processingTimeMs: integer("processing_time_ms"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    processingToken: text("processing_token"),
    processingLeaseExpiresAt: timestamp("processing_lease_expires_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    suggestedSize: text("suggested_size"),
    productHeader: jsonb("product_header").$type<{ quantity: number; title: string; sku?: string; variation?: string }>(),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().default(now),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    artifactsExpireAt: timestamp("artifacts_expire_at", { withTimezone: true }),
    retentionToken: text("retention_token"),
    retentionLeaseExpiresAt: timestamp("retention_lease_expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    unique("conversions_org_id_uq").on(table.organizationId, table.id),
    index("conversions_org_status_created_idx").on(table.organizationId, table.status, table.createdAt),
    index("conversions_org_created_id_idx").on(table.organizationId, table.createdAt, table.id),
    index("conversions_org_source_created_idx").on(table.organizationId, table.source, table.createdAt, table.id),
    index("conversions_org_batch_id_idx").on(table.organizationId, table.batchId),
    index("conversions_template_id_idx").on(table.templateId),
    index("conversions_processing_lease_idx").on(table.processingLeaseExpiresAt).where(sql`${table.status} = 'processing'`),
    uniqueIndex("conversions_upload_intent_uq").on(table.uploadIntentId).where(sql`${table.uploadIntentId} is not null`),
    uniqueIndex("conversions_input_object_key_uq").on(table.inputObjectKey),
    uniqueIndex("conversions_reprocess_idempotency_uq")
      .on(table.organizationId, table.sourceConversionId, table.reprocessIdempotencyKey)
      .where(sql`${table.sourceConversionId} is not null and ${table.reprocessIdempotencyKey} is not null`),
    index("conversions_created_by_user_id_idx").on(table.createdByUserId),
    index("conversions_api_key_id_idx").on(table.apiKeyId),
    index("conversions_retention_idx").on(table.artifactsExpireAt).where(sql`${table.status} <> 'deleted'`),
    foreignKey({ name: "conversions_org_batch_fk", columns: [table.organizationId, table.batchId], foreignColumns: [batches.organizationId, batches.id] }).onDelete("cascade"),
    foreignKey({ name: "conversions_org_api_key_fk", columns: [table.organizationId, table.apiKeyId], foreignColumns: [apiKeys.organizationId, apiKeys.id] }).onDelete("restrict"),
    foreignKey({ name: "conversions_org_upload_intent_fk", columns: [table.organizationId, table.uploadIntentId], foreignColumns: [uploadIntents.organizationId, uploadIntents.id] }).onDelete("restrict"),
    foreignKey({ name: "conversions_org_source_conversion_fk", columns: [table.organizationId, table.sourceConversionId], foreignColumns: [table.organizationId, table.id] }).onDelete("restrict"),
    check("conversions_progress_ck", sql`${table.progress} between 0 and 100`),
    check("conversions_attempts_ck", sql`${table.attempts} >= 0 and ${table.maxAttempts} > 0 and ${table.attempts} <= ${table.maxAttempts}`),
    check(
      "conversions_processing_claim_ck",
      sql`(${table.status} = 'processing' and ${table.processingToken} is not null and ${table.processingLeaseExpiresAt} is not null) or (${table.status} <> 'processing' and ${table.processingToken} is null and ${table.processingLeaseExpiresAt} is null)`,
    ),
    check("conversions_source_byte_length_ck", sql`${table.sourceByteLength} > 0`),
    check("conversions_input_sha256_ck", sql`${table.inputSha256} is null or ${table.inputSha256} ~ '^[0-9a-f]{64}$'`),
    check("conversions_input_pages_ck", sql`${table.inputPages} is null or ${table.inputPages} > 0`),
    check("conversions_output_pages_ck", sql`${table.outputPages} is null or ${table.outputPages} > 0`),
    check("conversions_processing_time_ck", sql`${table.processingTimeMs} is null or ${table.processingTimeMs} >= 0`),
    check(
      "conversions_original_file_name_ck",
      sql`${table.originalFileName} is null or (char_length(${table.originalFileName}) between 1 and 160 and position('/' in ${table.originalFileName}) = 0 and position(chr(92) in ${table.originalFileName}) = 0 and ${table.originalFileName} !~ '[[:cntrl:]]')`,
    ),
    check("conversions_output_size_ck", sql`${table.outputWidthMm} between 50 and 210 and ${table.outputHeightMm} between 50 and 300`),
    check("conversions_source_conversion_ck", sql`${table.sourceConversionId} is null or ${table.sourceConversionId} <> ${table.id}`),
    check(
      "conversions_reprocess_idempotency_ck",
      sql`(${table.sourceConversionId} is null and ${table.reprocessIdempotencyKey} is null and ${table.reprocessRequestHash} is null) or (${table.sourceConversionId} is not null and ${table.reprocessIdempotencyKey} is not null and ${table.reprocessRequestHash} is not null and char_length(${table.reprocessIdempotencyKey}) between 16 and 128 and ${table.reprocessRequestHash} ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

export const conversionPages = pgTable(
  "conversion_pages",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    conversionId: text("conversion_id").notNull(),
    pageNumber: integer("page_number").notNull(),
    role: pageRoleEnum("role").notNull(),
    kind: pageKindEnum("kind").notNull(),
    rotationDegrees: integer("rotation_degrees").notNull().default(0),
    widthPoints: numeric("width_points", { precision: 10, scale: 3 }).notNull(),
    heightPoints: numeric("height_points", { precision: 10, scale: 3 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex("conversion_pages_org_id_uq").on(table.organizationId, table.id),
    uniqueIndex("conversion_pages_conversion_page_uq").on(table.conversionId, table.pageNumber),
    index("conversion_pages_org_conversion_idx").on(table.organizationId, table.conversionId),
    foreignKey({ name: "conversion_pages_org_conversion_fk", columns: [table.organizationId, table.conversionId], foreignColumns: [conversions.organizationId, conversions.id] }).onDelete("cascade"),
    check("conversion_pages_page_number_ck", sql`${table.pageNumber} in (1, 2)`),
    check("conversion_pages_rotation_ck", sql`${table.rotationDegrees} in (0, 90, 180, 270)`),
    check("conversion_pages_dimensions_ck", sql`${table.widthPoints} > 0 and ${table.heightPoints} > 0`),
  ],
);

export const processingEvents = pgTable(
  "processing_events",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id").notNull(),
    conversionId: text("conversion_id").notNull(),
    stage: text("stage").notNull(),
    progress: integer("progress").notNull(),
    attempt: integer("attempt").notNull(),
    durationMs: integer("duration_ms"),
    metadata: jsonb("metadata").notNull().default({}).$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index("processing_events_org_conversion_created_idx").on(table.organizationId, table.conversionId, table.createdAt),
    foreignKey({ name: "processing_events_org_conversion_fk", columns: [table.organizationId, table.conversionId], foreignColumns: [conversions.organizationId, conversions.id] }).onDelete("cascade"),
    check("processing_events_progress_ck", sql`${table.progress} between 0 and 100`),
    check("processing_events_attempt_ck", sql`${table.attempt} > 0`),
    check("processing_events_duration_ck", sql`${table.durationMs} is null or ${table.durationMs} >= 0`),
  ],
);

export const usageReservations = pgTable(
  "usage_reservations",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id").notNull(),
    usagePeriodId: text("usage_period_id").notNull(),
    conversionId: text("conversion_id").notNull(),
    units: integer("units").notNull().default(1),
    status: usageReservationStatusEnum("status").notNull().default("RESERVED"),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().default(now),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex("usage_reservations_org_id_uq").on(table.organizationId, table.id),
    uniqueIndex("usage_reservations_conversion_uq").on(table.conversionId),
    index("usage_reservations_org_period_status_idx").on(table.organizationId, table.usagePeriodId, table.status),
    foreignKey({ name: "usage_reservations_org_period_fk", columns: [table.organizationId, table.usagePeriodId], foreignColumns: [usagePeriods.organizationId, usagePeriods.id] }).onDelete("restrict"),
    foreignKey({ name: "usage_reservations_org_conversion_fk", columns: [table.organizationId, table.conversionId], foreignColumns: [conversions.organizationId, conversions.id] }).onDelete("cascade"),
    check("usage_reservations_units_ck", sql`${table.units} > 0`),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex("api_keys_hash_uq").on(table.keyHash),
    unique("api_keys_org_id_uq").on(table.organizationId, table.id),
    index("api_keys_org_active_idx").on(table.organizationId, table.createdAt).where(sql`${table.revokedAt} is null`),
    index("api_keys_created_by_user_id_idx").on(table.createdByUserId),
  ],
);

export const apiRequests = pgTable(
  "api_requests",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    apiKeyId: text("api_key_id"),
    requestId: text("request_id").notNull(),
    method: text("method").notNull(),
    route: text("route").notNull(),
    idempotencyKey: text("idempotency_key"),
    requestHash: text("request_hash"),
    status: requestStatusEnum("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(1),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<Record<string, unknown>>(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex("api_requests_request_id_uq").on(table.requestId),
    unique("api_requests_org_id_uq").on(table.organizationId, table.id),
    uniqueIndex("api_requests_org_route_idempotency_uq").on(table.organizationId, table.route, table.idempotencyKey).where(sql`${table.idempotencyKey} is not null`),
    index("api_requests_org_created_idx").on(table.organizationId, table.createdAt),
    foreignKey({ name: "api_requests_org_api_key_fk", columns: [table.organizationId, table.apiKeyId], foreignColumns: [apiKeys.organizationId, apiKeys.id] }).onDelete("restrict"),
    check("api_requests_attempts_ck", sql`${table.attempts} > 0`),
  ],
);

export const apiRequestUploads = pgTable(
  "api_request_uploads",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id").notNull(),
    apiRequestId: text("api_request_id").notNull(),
    attempt: integer("attempt").notNull(),
    ordinal: integer("ordinal").notNull(),
    objectKey: text("object_key").notNull(),
    multipartUploadId: text("multipart_upload_id"),
    status: apiRequestUploadStatusEnum("status").notNull().default("PREPARING"),
    originalFileName: text("original_file_name").notNull(),
    contentType: text("content_type").notNull(),
    contentLength: integer("content_length"),
    checksumSha256: text("checksum_sha256"),
    cleanupAfter: timestamp("cleanup_after", { withTimezone: true }).notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    unique("api_request_uploads_org_id_uq").on(table.organizationId, table.id),
    uniqueIndex("api_request_uploads_request_attempt_ordinal_uq").on(table.apiRequestId, table.attempt, table.ordinal),
    uniqueIndex("api_request_uploads_object_key_uq").on(table.objectKey),
    index("api_request_uploads_cleanup_idx").on(table.status, table.cleanupAfter),
    foreignKey({ name: "api_request_uploads_org_request_fk", columns: [table.organizationId, table.apiRequestId], foreignColumns: [apiRequests.organizationId, apiRequests.id] }).onDelete("cascade"),
    check("api_request_uploads_ordinal_ck", sql`${table.ordinal} >= 0`),
    check("api_request_uploads_attempt_ck", sql`${table.attempt} > 0`),
    check("api_request_uploads_content_length_ck", sql`${table.contentLength} is null or ${table.contentLength} > 0`),
    check("api_request_uploads_sha_ck", sql`${table.checksumSha256} is null or ${table.checksumSha256} ~ '^[0-9a-f]{64}$'`),
    check("api_request_uploads_name_ck", sql`char_length(${table.originalFileName}) between 1 and 160 and position('/' in ${table.originalFileName}) = 0 and position(chr(92) in ${table.originalFileName}) = 0 and ${table.originalFileName} !~ '[[:cntrl:]]'`),
    check("api_request_uploads_ready_ck", sql`${table.status} in ('PREPARING', 'ABORTED') or (${table.contentLength} is not null and ${table.checksumSha256} is not null)`),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    deduplicationKey: text("deduplication_key").notNull(),
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
    status: outboxStatusEnum("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().default(now),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex("outbox_events_deduplication_key_uq").on(table.deduplicationKey),
    unique("outbox_events_org_id_uq").on(table.organizationId, table.id),
    index("outbox_events_pending_idx").on(table.availableAt, table.createdAt).where(sql`${table.status} in ('PENDING', 'FAILED')`),
    index("outbox_events_recovery_idx").on(table.status, table.updatedAt),
    check("outbox_events_attempts_ck", sql`${table.attempts} >= 0`),
  ],
);

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    secretIv: text("secret_iv").notNull(),
    secretAuthTag: text("secret_auth_tag").notNull(),
    encryptionKeyVersion: text("encryption_key_version").notNull(),
    subscribedEvents: text("subscribed_events").array().notNull(),
    active: boolean("active").notNull().default(true),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    unique("webhook_endpoints_org_id_uq").on(table.organizationId, table.id),
    index("webhook_endpoints_org_active_idx").on(table.organizationId, table.active),
    index("webhook_endpoints_created_by_user_id_idx").on(table.createdByUserId),
    check("webhook_endpoints_events_ck", sql`cardinality(${table.subscribedEvents}) > 0`),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id").notNull(),
    endpointId: text("endpoint_id").notNull(),
    outboxEventId: text("outbox_event_id").notNull(),
    eventType: text("event_type").notNull(),
    body: text("body").notNull(),
    claimToken: text("claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    status: deliveryStatusEnum("status").notNull().default("PENDING"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().default(now),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastResponseStatus: integer("last_response_status"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex("webhook_deliveries_endpoint_event_uq").on(table.endpointId, table.outboxEventId),
    unique("webhook_deliveries_org_id_uq").on(table.organizationId, table.id),
    index("webhook_deliveries_due_idx").on(table.nextAttemptAt, table.createdAt).where(sql`${table.status} in ('PENDING', 'FAILED')`),
    index("webhook_deliveries_org_created_idx").on(table.organizationId, table.createdAt),
    index("webhook_deliveries_lease_idx").on(table.leaseExpiresAt).where(sql`${table.status} = 'PROCESSING'`),
    foreignKey({ name: "webhook_deliveries_org_endpoint_fk", columns: [table.organizationId, table.endpointId], foreignColumns: [webhookEndpoints.organizationId, webhookEndpoints.id] }).onDelete("cascade"),
    foreignKey({ name: "webhook_deliveries_org_outbox_fk", columns: [table.organizationId, table.outboxEventId], foreignColumns: [outboxEvents.organizationId, outboxEvents.id] }).onDelete("cascade"),
    check("webhook_deliveries_attempt_count_ck", sql`${table.attemptCount} between 0 and 6`),
  ],
);

export const webhookDeliveryAttempts = pgTable(
  "webhook_delivery_attempts",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id").notNull(),
    deliveryId: text("delivery_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    responseStatus: integer("response_status"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex("webhook_delivery_attempts_delivery_number_uq").on(table.deliveryId, table.attemptNumber),
    index("webhook_delivery_attempts_org_delivery_idx").on(table.organizationId, table.deliveryId),
    foreignKey({ name: "webhook_attempts_org_delivery_fk", columns: [table.organizationId, table.deliveryId], foreignColumns: [webhookDeliveries.organizationId, webhookDeliveries.id] }).onDelete("cascade"),
    check("webhook_attempts_number_ck", sql`${table.attemptNumber} between 1 and 6`),
  ],
);

export const organizationInvitations = pgTable(
  "organization_invitations",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: membershipRoleEnum("role").notNull().default("MEMBER"),
    tokenHash: text("token_hash").notNull(),
    status: invitationStatusEnum("status").notNull().default("PENDING"),
    invitedByUserId: text("invited_by_user_id").references(() => user.id, { onDelete: "set null" }),
    acceptedByUserId: text("accepted_by_user_id").references(() => user.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex("organization_invitations_token_hash_uq").on(table.tokenHash),
    unique("organization_invitations_org_id_uq").on(table.organizationId, table.id),
    uniqueIndex("organization_invitations_pending_email_uq").on(table.organizationId, table.email).where(sql`${table.status} = 'PENDING'`),
    index("organization_invitations_org_created_idx").on(table.organizationId, table.createdAt),
    index("organization_invitations_invited_by_user_id_idx").on(table.invitedByUserId),
    index("organization_invitations_accepted_by_user_id_idx").on(table.acceptedByUserId),
    check("organization_invitations_role_ck", sql`${table.role} in ('ADMIN', 'MEMBER')`),
    check("organization_invitations_email_ck", sql`${table.email} = lower(${table.email}) and char_length(${table.email}) between 3 and 320`),
    check("organization_invitations_token_hash_ck", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const templateReleases = pgTable(
  "template_releases",
  {
    id: text("id").primaryKey().default(uuidDefault),
    templateId: text("template_id")
      .notNull()
      .references(() => templates.id, { onDelete: "restrict" }),
    templateVersion: text("template_version").notNull(),
    engineVersion: text("engine_version").notNull(),
    widthMm: numeric("width_mm", { precision: 6, scale: 2 }).notNull(),
    heightMm: numeric("height_mm", { precision: 6, scale: 2 }).notNull(),
    automaticReport: jsonb("automatic_report").notNull().$type<Record<string, unknown>>(),
    automaticReportSha256: text("automatic_report_sha256").notNull(),
    physicalProof: jsonb("physical_proof").notNull().$type<Record<string, unknown>>(),
    physicalProofSha256: text("physical_proof_sha256").notNull(),
    evidenceSha256: text("evidence_sha256").notNull(),
    attestedByUserId: text("attested_by_user_id").references(() => user.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex("template_releases_template_size_uq").on(table.templateId, table.widthMm, table.heightMm),
    index("template_releases_attested_by_user_id_idx").on(table.attestedByUserId),
    check("template_releases_size_ck", sql`${table.widthMm} between 50 and 210 and ${table.heightMm} between 50 and 300`),
    check("template_releases_sha_ck", sql`${table.automaticReportSha256} ~ '^[0-9a-f]{64}$' and ${table.physicalProofSha256} ~ '^[0-9a-f]{64}$' and ${table.evidenceSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey().default(uuidDefault),
    organizationId: text("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    actorType: text("actor_type").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    metadata: jsonb("metadata").notNull().default({}).$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    index("audit_logs_org_created_idx").on(table.organizationId, table.createdAt),
    index("audit_logs_actor_user_id_idx").on(table.actorUserId),
    index("audit_logs_resource_idx").on(table.resourceType, table.resourceId),
  ],
);

export const processedStripeEvents = pgTable(
  "processed_stripe_events",
  {
    id: text("id").primaryKey().default(uuidDefault),
    stripeEventId: text("stripe_event_id").notNull(),
    organizationId: text("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    payloadHash: text("payload_hash").notNull(),
    stripeCreatedAt: timestamp("stripe_created_at", { withTimezone: true }).notNull(),
    status: stripeEventStatusEnum("status").notNull().default("PROCESSING"),
    attempts: integer("attempts").notNull().default(1),
    error: text("error"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().default(now),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(now),
  },
  (table) => [
    uniqueIndex("processed_stripe_events_event_id_uq").on(table.stripeEventId),
    index("processed_stripe_events_status_received_idx").on(table.status, table.receivedAt),
    index("processed_stripe_events_org_received_idx").on(table.organizationId, table.receivedAt),
    check("processed_stripe_events_attempts_ck", sql`${table.attempts} > 0`),
  ],
);

export type DbUser = typeof user.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type Conversion = typeof conversions.$inferSelect;
export type UsagePeriod = typeof usagePeriods.$inferSelect;
