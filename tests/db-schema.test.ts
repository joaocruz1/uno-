import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const ORG_A = "00000000-0000-4000-8000-000000000101";
const ORG_B = "00000000-0000-4000-8000-000000000102";
const TEMPLATE_ID = "00000000-0000-4000-8000-000000000201";
const PERIOD_ID = "00000000-0000-4000-8000-000000000401";
const CONVERSIONS = [
  "00000000-0000-4000-8000-000000000301",
  "00000000-0000-4000-8000-000000000302",
  "00000000-0000-4000-8000-000000000303",
] as const;

const db = new PGlite();

async function applyMigration(relativePath: string): Promise<void> {
  const path = fileURLToPath(new URL(`../${relativePath}`, import.meta.url));
  const migration = await readFile(path, "utf8");

  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await db.exec(statement);
  }
}

beforeAll(async () => {
  await applyMigration("drizzle/0000_giant_starhawk.sql");
  await applyMigration("drizzle/0001_quota_functions.sql");

  await db.exec(`
    insert into "user" (id, name, email) values
      ('${USER_ID}', 'Schema Test', 'schema@example.test');
    insert into organizations (id, name, slug, owner_user_id) values
      ('${ORG_A}', 'Organization A', 'organization-a', '${USER_ID}'),
      ('${ORG_B}', 'Organization B', 'organization-b', '${USER_ID}');
    insert into templates (id, key, version, display_name, engine_version, status, definition)
      values ('${TEMPLATE_ID}', 'synthetic-test', '1.0.0', 'Synthetic Test', '1.0.0', 'RELEASED', '{}');
    insert into usage_periods (id, organization_id, period_start, period_end, "limit")
      values ('${PERIOD_ID}', '${ORG_A}', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', 2);
  `);

  for (const conversionId of CONVERSIONS) {
    await db.query(
      `insert into conversions (
        id, organization_id, template_id, template_version, engine_version,
        output_preset, output_width_mm, output_height_mm, input_object_key, source_byte_length
      ) values ($1, $2, $3, '1.0.0', '1.0.0', '100x150', 100, 150, $4, 1024)`,
      [conversionId, ORG_A, TEMPLATE_ID, `test/${conversionId}.pdf`],
    );
  }
});

afterAll(async () => {
  await db.close();
});

describe("database foundation", () => {
  it("applies every migration to a real PostgreSQL-compatible engine", async () => {
    const result = await db.query<{ count: number }>(
      "select count(*)::integer as count from information_schema.tables where table_schema = 'public'",
    );
    expect(result.rows[0]?.count).toBe(23);
  });

  it("rejects cross-organization child records through composite foreign keys", async () => {
    await expect(
      db.query(
        `insert into conversion_pages (
          id, organization_id, conversion_id, page_number, role, kind,
          width_points, height_points
        ) values ($1, $2, $3, 1, 'logistics', 'digital', 283.465, 425.197)`,
        ["00000000-0000-4000-8000-000000000601", ORG_B, CONVERSIONS[0]],
      ),
    ).rejects.toThrow(/conversion_pages_org_conversion_fk|foreign key/i);
  });

  it("reserves, confirms, and releases quota atomically and idempotently", async () => {
    const reservationOne = "00000000-0000-4000-8000-000000000501";
    const reservationTwo = "00000000-0000-4000-8000-000000000502";
    const reservationThree = "00000000-0000-4000-8000-000000000503";

    await db.query("select * from reserve_usage($1, $2, $3, $4, 1)", [reservationOne, ORG_A, PERIOD_ID, CONVERSIONS[0]]);
    const duplicate = await db.query<{ id: string }>("select id from reserve_usage($1, $2, $3, $4, 1)", [reservationThree, ORG_A, PERIOD_ID, CONVERSIONS[0]]);
    expect(duplicate.rows[0]?.id).toBe(reservationOne);

    await db.query("select * from reserve_usage($1, $2, $3, $4, 1)", [reservationTwo, ORG_A, PERIOD_ID, CONVERSIONS[1]]);
    await expect(
      db.query("select * from reserve_usage($1, $2, $3, $4, 1)", [reservationThree, ORG_A, PERIOD_ID, CONVERSIONS[2]]),
    ).rejects.toThrow(/quota_exceeded/);

    await db.query("select * from confirm_usage($1, $2)", [reservationOne, ORG_A]);
    await db.query("select * from confirm_usage($1, $2)", [reservationOne, ORG_A]);
    await db.query("select * from release_usage($1, $2)", [reservationTwo, ORG_A]);
    await db.query("select * from release_usage($1, $2)", [reservationTwo, ORG_A]);

    const counters = await db.query<{ reserved: number; confirmed: number }>(
      "select reserved, confirmed from usage_periods where id = $1",
      [PERIOD_ID],
    );
    expect(counters.rows[0]).toEqual({ reserved: 0, confirmed: 1 });

    await db.query("select * from reserve_usage($1, $2, $3, $4, 1)", [reservationThree, ORG_A, PERIOD_ID, CONVERSIONS[2]]);
    const finalCounters = await db.query<{ reserved: number; confirmed: number }>(
      "select reserved, confirmed from usage_periods where id = $1",
      [PERIOD_ID],
    );
    expect(finalCounters.rows[0]).toEqual({ reserved: 1, confirmed: 1 });
  });
});
