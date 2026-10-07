import { sql } from "drizzle-orm";

import { getDb, type UnoDatabase } from "@/db";

import { enqueueConversion } from "./conversion-queue";

type ClaimedOutbox = {
  id: string;
  aggregate_id: string;
  type: string;
};

export type OutboxPublisherDependencies = {
  database: Pick<UnoDatabase, "execute">;
  publishConversion(conversionId: string, outboxEventId: string): Promise<void>;
};

function defaults(): OutboxPublisherDependencies {
  return { database: getDb(), publishConversion: enqueueConversion };
}

async function claimOutbox(
  eventId: string | undefined,
  database: Pick<UnoDatabase, "execute">,
): Promise<ClaimedOutbox | undefined> {
  const result = await database.execute<ClaimedOutbox>(sql`
    with candidate as (
      select id from outbox_events
      where type = 'conversion.queued'
        and (${eventId ?? null}::text is null or id = ${eventId ?? null})
        and (
          (status in ('PENDING', 'FAILED') and available_at <= now())
          or (status = 'PROCESSING' and updated_at < now() - interval '5 minutes')
        )
      order by created_at
      for update skip locked
      limit 1
    )
    update outbox_events o
    set status = 'PROCESSING', attempts = attempts + 1, updated_at = now(), last_error = null
    from candidate
    where o.id = candidate.id
    returning o.id, o.aggregate_id, o.type
  `);
  return result.rows[0];
}

export async function publishPendingConversionJobs(
  options: { eventId?: string; limit?: number } = {},
  dependencies: OutboxPublisherDependencies = defaults(),
): Promise<number> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 25));
  let published = 0;
  for (let index = 0; index < limit; index += 1) {
    const event = await claimOutbox(options.eventId, dependencies.database);
    if (!event) break;
    try {
      await dependencies.publishConversion(event.aggregate_id, event.id);
      await dependencies.database.execute(sql`
        update outbox_events set status = 'PUBLISHED', published_at = now(), updated_at = now()
        where id = ${event.id} and status = 'PROCESSING'
      `);
      published += 1;
    } catch {
      await dependencies.database.execute(sql`
        update outbox_events
        set status = 'FAILED', available_at = now() + interval '15 seconds',
            last_error = 'queue_publish_failed', updated_at = now()
        where id = ${event.id} and status = 'PROCESSING'
      `);
      if (options.eventId) break;
    }
  }
  return published;
}
