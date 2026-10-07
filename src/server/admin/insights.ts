import { sql } from "drizzle-orm";

import { getDb, type UnoDatabase } from "@/db";
import { getPlanCatalog, planIdSchema, type PlanId } from "@/lib/plans";

import { assertPlatformAdmin, type AdminIdentity } from "./access";

/*
 * Owner-facing business views. Still metadata only: organization names,
 * counters, plan and key labels. Never documents, file names, key secrets or
 * provider identifiers.
 */

type Database = Pick<UnoDatabase, "select" | "execute">;
const PAID_STATUSES = ["ACTIVE", "TRIALING", "PAST_DUE"] as const;
const number = (value: unknown) => Number(value ?? 0);
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);

export type AdminFinance = {
  /** Catalog price × paying subscriptions. An estimate, not the provider's revenue report. */
  estimatedMrrBrlCents: number;
  payingOrganizations: number;
  freeOrganizations: number;
  /** Paid plan without a billing link (granted manually or test data); excluded from revenue. */
  unbilledPaidOrganizations: number;
  cancelingAtPeriodEnd: number;
  pastDue: number;
  newPaidLast30Days: number;
  byPlan: Array<{ planId: PlanId; name: string; priceBrlCents: number; subscriptions: number; mrrBrlCents: number }>;
  recentPaid: Array<{ organizationId: string; organizationName: string; planId: PlanId; status: string; billingLinked: boolean; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean; updatedAt: string }>;
};

export async function adminFinance(identity: AdminIdentity, database: Database = getDb(), now = new Date()): Promise<AdminFinance> {
  await assertPlatformAdmin(identity, database);
  const catalog = getPlanCatalog();
  const counts = await database.execute<{ plan_id: string; status: string; linked: boolean; total: string; canceling: string; recent: string }>(sql`
    select plan_id::text, status::text, (stripe_subscription_id is not null) as linked, count(*) as total,
           count(*) filter (where cancel_at_period_end) as canceling,
           count(*) filter (where created_at > ${now.toISOString()}::timestamptz - interval '30 days' or updated_at > ${now.toISOString()}::timestamptz - interval '30 days') as recent
    from subscriptions group by plan_id, status, (stripe_subscription_id is not null)`);
  const byPlan = new Map<PlanId, number>();
  let free = 0; let canceling = 0; let pastDue = 0; let recentPaid = 0; let unbilled = 0;
  for (const row of counts.rows) {
    const planId = planIdSchema.parse(row.plan_id);
    const paying = planId !== "FREE" && (PAID_STATUSES as readonly string[]).includes(row.status);
    if (!paying) { free += number(row.total); continue; }
    if (!row.linked) { unbilled += number(row.total); continue; }
    byPlan.set(planId, (byPlan.get(planId) ?? 0) + number(row.total));
    canceling += number(row.canceling);
    recentPaid += number(row.recent);
    if (row.status === "PAST_DUE") pastDue += number(row.total);
  }
  const plans = (["STARTER", "PRO", "BUSINESS"] as const).map((planId) => {
    const subscriptions = byPlan.get(planId) ?? 0;
    return { planId, name: catalog[planId].name, priceBrlCents: catalog[planId].priceBrlCents, subscriptions, mrrBrlCents: subscriptions * catalog[planId].priceBrlCents };
  });
  const recent = await database.execute<Record<string, unknown>>(sql`
    select s.organization_id, o.name, s.plan_id::text, s.status::text, (s.stripe_subscription_id is not null) as linked,
           s.current_period_end, s.cancel_at_period_end, s.updated_at
    from subscriptions s join organizations o on o.id = s.organization_id
    where s.plan_id <> 'FREE' order by s.updated_at desc limit 50`);
  return {
    estimatedMrrBrlCents: plans.reduce((total, plan) => total + plan.mrrBrlCents, 0),
    payingOrganizations: plans.reduce((total, plan) => total + plan.subscriptions, 0),
    freeOrganizations: free,
    unbilledPaidOrganizations: unbilled,
    cancelingAtPeriodEnd: canceling,
    pastDue,
    newPaidLast30Days: recentPaid,
    byPlan: plans,
    recentPaid: recent.rows.map((row) => ({
      organizationId: String(row.organization_id), organizationName: String(row.name), planId: planIdSchema.parse(row.plan_id),
      status: String(row.status), billingLinked: Boolean(row.linked), currentPeriodEnd: iso(row.current_period_end),
      cancelAtPeriodEnd: Boolean(row.cancel_at_period_end), updatedAt: iso(row.updated_at)!,
    })),
  };
}

export type AdminCustomer = {
  organizationId: string; organizationName: string; planId: PlanId; status: string; members: number;
  periodLimit: number; periodConfirmed: number; conversions30d: number; completed30d: number; failed30d: number;
  viaApi30d: number; viaDashboard30d: number; activeApiKeys: number; lastConversionAt: string | null; createdAt: string;
};

/** Organizations ranked by labels produced in the last 30 days. */
export async function adminCustomers(identity: AdminIdentity, database: Database = getDb(), now = new Date(), limit = 100): Promise<AdminCustomer[]> {
  await assertPlatformAdmin(identity, database);
  const at = now.toISOString();
  const rows = await database.execute<Record<string, unknown>>(sql`
    select o.id, o.name, o.created_at, coalesce(s.plan_id::text, 'FREE') as plan_id, coalesce(s.status::text, 'ACTIVE') as status,
      (select count(*) from memberships m where m.organization_id = o.id) as members,
      coalesce((select p."limit" from usage_periods p where p.organization_id = o.id and p.period_end > ${at}::timestamptz order by p.period_start desc limit 1), 0) as period_limit,
      coalesce((select p.confirmed from usage_periods p where p.organization_id = o.id and p.period_end > ${at}::timestamptz order by p.period_start desc limit 1), 0) as period_confirmed,
      coalesce(c.total, 0) as total, coalesce(c.completed, 0) as completed, coalesce(c.failed, 0) as failed,
      coalesce(c.via_api, 0) as via_api, coalesce(c.via_dashboard, 0) as via_dashboard, c.last_at,
      (select count(*) from api_keys k where k.organization_id = o.id and k.revoked_at is null and (k.expires_at is null or k.expires_at > ${at}::timestamptz)) as active_keys
    from organizations o
    left join subscriptions s on s.organization_id = o.id
    left join (
      select organization_id, count(*) as total,
        count(*) filter (where status = 'completed') as completed,
        count(*) filter (where status = 'failed') as failed,
        count(*) filter (where source = 'api') as via_api,
        count(*) filter (where source = 'dashboard') as via_dashboard,
        max(created_at) as last_at
      from conversions where created_at > ${at}::timestamptz - interval '30 days' group by organization_id
    ) c on c.organization_id = o.id
    order by coalesce(c.completed, 0) desc, o.created_at desc limit ${Math.max(1, Math.min(500, limit))}`);
  return rows.rows.map((row) => ({
    organizationId: String(row.id), organizationName: String(row.name), planId: planIdSchema.parse(row.plan_id), status: String(row.status),
    members: number(row.members), periodLimit: number(row.period_limit), periodConfirmed: number(row.period_confirmed),
    conversions30d: number(row.total), completed30d: number(row.completed), failed30d: number(row.failed),
    viaApi30d: number(row.via_api), viaDashboard30d: number(row.via_dashboard), activeApiKeys: number(row.active_keys),
    lastConversionAt: iso(row.last_at), createdAt: iso(row.created_at)!,
  }));
}

export type AdminApiKey = {
  id: string; organizationId: string; organizationName: string; planId: PlanId; name: string; prefix: string;
  state: "active" | "revoked" | "expired"; createdAt: string; lastUsedAt: string | null; requests30d: number; conversions30d: number;
};

/** Every API key with its label and public prefix; hashes and secrets are never selected. */
export async function adminApiKeys(identity: AdminIdentity, database: Database = getDb(), now = new Date(), limit = 200): Promise<AdminApiKey[]> {
  await assertPlatformAdmin(identity, database);
  const at = now.toISOString();
  const rows = await database.execute<Record<string, unknown>>(sql`
    select k.id, k.organization_id, o.name as organization_name, coalesce(s.plan_id::text, 'FREE') as plan_id, k.name, k.prefix,
      k.created_at, k.last_used_at, k.revoked_at, k.expires_at,
      (select count(*) from api_requests r where r.api_key_id = k.id and r.created_at > ${at}::timestamptz - interval '30 days') as requests,
      (select count(*) from conversions c where c.api_key_id = k.id and c.created_at > ${at}::timestamptz - interval '30 days') as conversions
    from api_keys k join organizations o on o.id = k.organization_id
    left join subscriptions s on s.organization_id = k.organization_id
    order by k.last_used_at desc nulls last, k.created_at desc limit ${Math.max(1, Math.min(500, limit))}`);
  return rows.rows.map((row) => ({
    id: String(row.id), organizationId: String(row.organization_id), organizationName: String(row.organization_name),
    planId: planIdSchema.parse(row.plan_id), name: String(row.name), prefix: String(row.prefix),
    state: row.revoked_at ? "revoked" : row.expires_at && new Date(row.expires_at as string) <= now ? "expired" : "active",
    createdAt: iso(row.created_at)!, lastUsedAt: iso(row.last_used_at), requests30d: number(row.requests), conversions30d: number(row.conversions),
  }));
}

export type AdminActivity = {
  days: Array<{ day: string; completed: number; failed: number; other: number }>;
  bySource: Array<{ key: string; total: number; completed: number }>;
  byTemplate: Array<{ key: string; total: number; completed: number }>;
  bySize: Array<{ key: string; total: number }>;
  byPlan: Array<{ key: string; total: number; completed: number }>;
  withProductHeader: number;
  total30d: number;
  completed30d: number;
  averageProcessingMs: number | null;
  signupsByDay: Array<{ day: string; total: number }>;
};

/** Where labels come from: channel, marketplace template, format and plan over the last 30 days. */
export async function adminActivity(identity: AdminIdentity, database: Database = getDb(), now = new Date()): Promise<AdminActivity> {
  await assertPlatformAdmin(identity, database);
  const at = now.toISOString();
  const window = sql`c.created_at > ${at}::timestamptz - interval '30 days'`;
  const days = await database.execute<Record<string, unknown>>(sql`
    select to_char(date_trunc('day', c.created_at at time zone 'America/Sao_Paulo'), 'YYYY-MM-DD') as day,
      count(*) filter (where c.status = 'completed') as completed, count(*) filter (where c.status = 'failed') as failed,
      count(*) filter (where c.status not in ('completed', 'failed')) as other
    from conversions c where c.created_at > ${at}::timestamptz - interval '14 days' group by 1 order by 1`);
  const bySource = await database.execute<Record<string, unknown>>(sql`
    select c.source::text as key, count(*) as total, count(*) filter (where c.status = 'completed') as completed from conversions c where ${window} group by 1 order by 2 desc`);
  const byTemplate = await database.execute<Record<string, unknown>>(sql`
    select t.display_name || ' ' || c.template_version as key, count(*) as total, count(*) filter (where c.status = 'completed') as completed
    from conversions c join templates t on t.id = c.template_id where ${window} group by 1 order by 2 desc`);
  const bySize = await database.execute<Record<string, unknown>>(sql`
    select trim(to_char(c.output_width_mm, 'FM999990.##'), '.') || ' × ' || trim(to_char(c.output_height_mm, 'FM999990.##'), '.') || ' mm' as key, count(*) as total
    from conversions c where ${window} group by 1 order by 2 desc limit 8`);
  const byPlan = await database.execute<Record<string, unknown>>(sql`
    select coalesce(s.plan_id::text, 'FREE') as key, count(*) as total, count(*) filter (where c.status = 'completed') as completed
    from conversions c left join subscriptions s on s.organization_id = c.organization_id where ${window} group by 1 order by 2 desc`);
  const totals = await database.execute<Record<string, unknown>>(sql`
    select count(*) as total, count(*) filter (where c.status = 'completed') as completed,
      count(*) filter (where c.product_header is not null) as with_header,
      avg(c.processing_time_ms) filter (where c.status = 'completed') as average_ms
    from conversions c where ${window}`);
  const signups = await database.execute<Record<string, unknown>>(sql`
    select to_char(date_trunc('day', created_at at time zone 'America/Sao_Paulo'), 'YYYY-MM-DD') as day, count(*) as total
    from organizations where created_at > ${at}::timestamptz - interval '14 days' group by 1 order by 1`);
  const window14 = Array.from({ length: 14 }, (_, index) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date(now.getTime() - (13 - index) * 86_400_000)));
  const pairs = (rows: Array<Record<string, unknown>>) => rows.map((row) => ({ key: String(row.key), total: number(row.total), completed: number(row.completed) }));
  const summary = totals.rows[0] ?? {};
  return {
    days: window14.map((day) => {
      const row = days.rows.find((candidate) => candidate.day === day);
      return { day, completed: number(row?.completed), failed: number(row?.failed), other: number(row?.other) };
    }),
    bySource: pairs(bySource.rows), byTemplate: pairs(byTemplate.rows), byPlan: pairs(byPlan.rows),
    bySize: bySize.rows.map((row) => ({ key: String(row.key), total: number(row.total) })),
    withProductHeader: number(summary.with_header), total30d: number(summary.total), completed30d: number(summary.completed),
    averageProcessingMs: summary.average_ms === null || summary.average_ms === undefined ? null : Math.round(Number(summary.average_ms)),
    signupsByDay: window14.map((day) => ({ day, total: number(signups.rows.find((candidate) => candidate.day === day)?.total) })),
  };
}

export type AdminConnection = { name: string; purpose: string; configured: boolean; detail: string };

/** Which providers have configuration present. Reports presence only, never values. */
export async function adminConnections(identity: AdminIdentity, database: Database = getDb()): Promise<AdminConnection[]> {
  await assertPlatformAdmin(identity, database);
  const has = (...names: string[]) => names.every((name) => Boolean(process.env[name]?.trim()));
  const state = (configured: boolean, on: string, off: string) => ({ configured, detail: configured ? on : off });
  return [
    { name: "PostgreSQL", purpose: "Banco de dados", ...state(has("DATABASE_URL"), "Configurado", "DATABASE_URL ausente") },
    { name: "Redis", purpose: "Fila, limites de taxa e sessões", ...state(has("REDIS_URL"), "Configurado", "REDIS_URL ausente") },
    { name: "Armazenamento S3/R2", purpose: "PDFs de entrada e saída (privado)", ...state(has("S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"), "Configurado", "Variáveis S3_* incompletas") },
    { name: "Stripe", purpose: "Assinaturas e cobrança", ...state(has("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_STARTER", "STRIPE_PRICE_PRO", "STRIPE_PRICE_BUSINESS"), "Chaves e preços configurados", "Defina STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET e os três STRIPE_PRICE_*") },
    { name: "E-mail", purpose: "Confirmação de conta e convites", ...state(has("RESEND_API_KEY") || has("SMTP_URL"), has("RESEND_API_KEY") ? "Resend configurado" : "SMTP local (Mailpit)", "Defina RESEND_API_KEY ou SMTP_URL") },
    { name: "Webhooks de saída", purpose: "Criptografia dos segredos dos clientes", ...state(has("WEBHOOK_ENCRYPTION_KEY"), "Chave configurada", "WEBHOOK_ENCRYPTION_KEY ausente") },
    { name: "Sentry", purpose: "Erros (opcional)", ...state(has("SENTRY_DSN"), "Configurado", "Opcional — SENTRY_DSN ausente") },
    { name: "PostHog", purpose: "Métricas de produto com consentimento (opcional)", ...state(has("NEXT_PUBLIC_POSTHOG_KEY"), "Configurado", "Opcional — NEXT_PUBLIC_POSTHOG_KEY ausente") },
  ];
}
