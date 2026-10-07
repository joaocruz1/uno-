import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, it } from "vitest";
const databaseUrl = process.env.UNO_INTEGRATION_DATABASE_URL;
it.skipIf(!databaseUrl)("serializes concurrent reservations without exceeding an organization quota", async () => {
  const pool = new Pool({connectionString:databaseUrl, max:12});
  const userId=randomUUID(), org=randomUUID(), template=randomUUID(), period=randomUUID();
  try {
    await pool.query('insert into "user"(id,name,email) values($1,$2,$3)',[userId,"Concurrent test",`${userId}@example.test`]);
    await pool.query('insert into organizations(id,name,slug,owner_user_id) values($1,$2,$3,$4)',[org,"Concurrency test",org,userId]);
    await pool.query('insert into templates(id,key,version,display_name,engine_version,definition) values($1,$2,$3,$4,$5,$6)',[template,template,"1","Synthetic","1",{}]);
    await pool.query('insert into usage_periods(id,organization_id,period_start,period_end,"limit") values($1,$2,$3,$4,3)',[period,org,"2026-10-01","2026-11-01"]);
    const ids=Array.from({length:12},()=>randomUUID());
    for(const id of ids) await pool.query("insert into conversions(id,organization_id,template_id,template_version,engine_version,output_preset,output_width_mm,output_height_mm,input_object_key,source_byte_length) values($1,$2,$3,'1','1','100x150',100,150,$4,10)",[id,org,template,`test/${id}.pdf`]);
    const results=await Promise.allSettled(ids.map(id=>pool.query('select * from reserve_usage($1,$2,$3,$4,1)',[randomUUID(),org,period,id])));
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(3);
    expect((await pool.query('select reserved,confirmed from usage_periods where id=$1',[period])).rows[0]).toEqual({reserved:3,confirmed:0});
  } finally {
    await pool.query('delete from usage_reservations where organization_id=$1',[org]);
    await pool.query('delete from organizations where id=$1',[org]);
    await pool.query('delete from templates where id=$1',[template]);
    await pool.query('delete from "user" where id=$1',[userId]);
    await pool.end();
  }
});
