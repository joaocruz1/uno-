import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const db = new PGlite();
const USER = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-000000000101";
const TEMPLATE = "00000000-0000-4000-8000-000000000201";
const INTENT = "00000000-0000-4000-8000-000000000301";

async function migration(name: string) {
  const sql = await readFile(fileURLToPath(new URL(`../drizzle/${name}`, import.meta.url)), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) if (statement.trim()) await db.exec(statement);
}

beforeAll(async () => {
  await migration("0000_giant_starhawk.sql");
  await migration("0001_quota_functions.sql");
  await migration("0002_stiff_mantis.sql");
  await migration("0003_phase6_conversion_queue.sql");
  await db.exec(`
    insert into "user" (id,name,email) values ('${USER}','Synthetic','conversion@example.test');
    insert into organizations (id,name,slug,owner_user_id) values ('${ORG}','Synthetic','synthetic-conversion','${USER}');
    insert into templates (id,key,version,display_name,engine_version,status,definition)
      values ('${TEMPLATE}','mercado-livre','1.0.0','Mercado Livre','0.1.0','DRAFT','{}');
    insert into upload_intents (id,organization_id,object_key,content_length,expires_at)
      values ('${INTENT}','${ORG}','synthetic/input.pdf',1024,now()+interval '5 minutes');
  `);
});

afterAll(async () => db.close());

async function insertConversion(id: string, overrides = "") {
  return db.exec(`insert into conversions (
    id,organization_id,upload_intent_id,template_id,template_version,engine_version,
    output_preset,output_width_mm,output_height_mm,input_object_key,input_sha256,source_byte_length${overrides ? "," + overrides.split("=")[0] : ""}
  ) values (
    '${id}','${ORG}','${INTENT}','${TEMPLATE}','1.0.0','0.1.0',
    'custom',100,250,'snapshots/${id}.pdf','${"a".repeat(64)}',1024${overrides ? "," + overrides.split("=")[1] : ""}
  )`);
}

describe("phase 6 conversion schema", () => {
  it("puts current_stage and claim fields on conversions", async () => {
    const columns = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name='conversions' and column_name in ('current_stage','processing_token','processing_lease_expires_at')",
    );
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
      "current_stage", "processing_lease_expires_at", "processing_token",
    ]);
  });

  it("rejects a processing state without its attempt token and lease", async () => {
    await expect(insertConversion("00000000-0000-4000-8000-000000000401", "status='processing'"))
      .rejects.toThrow(/conversions_processing_claim_ck|check constraint/i);
  });

  it("allows at most one conversion for an upload intent", async () => {
    await insertConversion("00000000-0000-4000-8000-000000000402");
    await expect(insertConversion("00000000-0000-4000-8000-000000000403"))
      .rejects.toThrow(/conversions_upload_intent_uq|unique/i);
  });
});
