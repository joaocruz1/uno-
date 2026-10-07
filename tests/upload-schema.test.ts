import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const db = new PGlite();
const USER_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000101";

async function apply(relativePath: string): Promise<void> {
  const migration = await readFile(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await db.exec(statement);
  }
}

beforeAll(async () => {
  const drizzleDirectory = fileURLToPath(new URL("../drizzle", import.meta.url));
  const migrations = (await readdir(drizzleDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const migration of migrations) await apply(`drizzle/${migration}`);
  await db.exec(`
    insert into "user" (id, name, email) values ('${USER_ID}', 'Upload Test', 'upload@example.test');
    insert into organizations (id, name, slug, owner_user_id)
      values ('${ORG_ID}', 'Upload Org', 'upload-org', '${USER_ID}');
  `);
});

afterAll(async () => db.close());

describe("upload schema migration", () => {
  it("adds upload and conversion metadata with the expected source enum", async () => {
    const columns = await db.query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_name = 'conversions'
        and column_name in ('source', 'original_file_name', 'input_sha256', 'input_pages', 'output_pages', 'processing_time_ms')
    `);
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
      "input_pages",
      "input_sha256",
      "original_file_name",
      "output_pages",
      "processing_time_ms",
      "source",
    ]);
  });

  it("accepts a safe private upload intent", async () => {
    await expect(
      db.query(
        `insert into upload_intents
          (id, organization_id, created_by_user_id, object_key, content_type, content_length, checksum_sha256, original_file_name, expires_at)
         values ($1, $2, $3, $4, 'application/pdf', 128, $5, 'etiqueta.pdf', now() + interval '5 minutes')`,
        [
          "00000000-0000-4000-8000-000000000501",
          ORG_ID,
          USER_ID,
          `organizations/${ORG_ID}/uploads/00000000-0000-4000-8000-000000000502.pdf`,
          "a".repeat(64),
        ],
      ),
    ).resolves.toBeDefined();
  });

  it("rejects an unsafe persisted display filename", async () => {
    await expect(
      db.query(
        `insert into upload_intents
          (id, organization_id, object_key, content_type, content_length, checksum_sha256, original_file_name, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, now() + interval '5 minutes')`,
        [
          crypto.randomUUID(),
          ORG_ID,
          `organizations/${ORG_ID}/uploads/${crypto.randomUUID()}.pdf`,
          "application/pdf",
          128,
          "a".repeat(64),
          "../etiqueta.pdf",
        ],
      ),
    ).rejects.toThrow(/check constraint/i);
  });
});
