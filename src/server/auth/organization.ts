import { sql } from "drizzle-orm";

import { getDb, type UnoDatabase } from "@/db";

export type ProvisionedUser = {
  id: string;
  name: string;
};

export function defaultOrganizationName(name: string): string {
  const normalized = name.trim() || "você";
  return `Organização de ${normalized}`;
}

/**
 * Creates the deterministic personal organization for a user exactly once.
 * The organization id equals the user id, so its existence is the durable
 * marker that provisioning already happened. Later calls are no-ops: they
 * never restore a removed membership, never elevate a role and never touch an
 * existing subscription. Returns the organization id only when it was created.
 */
export async function ensureDefaultOrganization(
  member: ProvisionedUser,
  database: Pick<UnoDatabase, "execute"> = getDb(),
): Promise<string | null> {
  const subscriptionId = crypto.randomUUID();
  const result = await database.execute(sql`
    with created_organization as (
      insert into organizations (id, name, slug, owner_user_id)
      values (${member.id}, ${defaultOrganizationName(member.name)}, ${`org-${member.id}`}, ${member.id})
      on conflict do nothing
      returning id
    ), created_membership as (
      insert into memberships (organization_id, user_id, role)
      select id, ${member.id}, 'OWNER'::membership_role from created_organization
      on conflict do nothing
    ), created_subscription as (
      insert into subscriptions (id, organization_id, plan_id, status)
      select ${subscriptionId}, id, 'FREE'::plan_id, 'ACTIVE'::subscription_status from created_organization
      on conflict do nothing
    )
    select id as organization_id from created_organization
  `);

  const row = result.rows[0] as { organization_id?: string } | undefined;
  return row?.organization_id ?? null;
}
