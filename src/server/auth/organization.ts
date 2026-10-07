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
 * Repairs or creates the deterministic personal organization for a user.
 * One SQL statement keeps organization, owner membership and free subscription
 * atomic. A paid subscription is never downgraded during a repair.
 */
export async function ensureDefaultOrganization(
  member: ProvisionedUser,
  database: Pick<UnoDatabase, "execute"> = getDb(),
): Promise<string> {
  const subscriptionId = crypto.randomUUID();
  const result = await database.execute(sql`
    with ensured_organization as (
      insert into organizations (id, name, slug, owner_user_id)
      values (${member.id}, ${defaultOrganizationName(member.name)}, ${`org-${member.id}`}, ${member.id})
      on conflict (id) do update
        set updated_at = organizations.updated_at
        where organizations.owner_user_id = excluded.owner_user_id
      returning id
    ), ensured_membership as (
      insert into memberships (organization_id, user_id, role)
      select id, ${member.id}, 'OWNER'::membership_role from ensured_organization
      on conflict (organization_id, user_id) do update set role = 'OWNER', updated_at = now()
    ), ensured_subscription as (
      insert into subscriptions (id, organization_id, plan_id, status)
      select ${subscriptionId}, id, 'FREE'::plan_id, 'ACTIVE'::subscription_status from ensured_organization
      on conflict (organization_id) do nothing
    )
    select id as organization_id from ensured_organization
  `);

  const row = result.rows[0] as { organization_id?: string } | undefined;
  if (!row?.organization_id) throw new Error("Default organization could not be provisioned");
  return row.organization_id;
}
