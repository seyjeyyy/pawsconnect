import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {postgis} from '@electric-sql/pglite-postgis';
import {expect,it} from 'vitest';
import {createDatabase,createUser,asUser} from '../helpers/db';

// A real isolated PostgreSQL data-directory export + restoration. This proves
// this migration set survives a local restore; it is NOT a Supabase/Storage drill.
it('restores an isolated database archive and validates records, RLS and workflow integrity',async()=>{
 const original=await createDatabase();let restored:PGlite|undefined;
 try{
  const owner=await createUser(original,'drill-owner@test.local');
  const other=await createUser(original,'drill-other@test.local');
  await original.query("insert into customer_addresses(user_id,recipient_name,phone,line1,city,province) values($1,'Recovery fixture','09000000000','Fixture address','Malolos','Bulacan')",[owner]);
  const archive=await original.dumpDataDir('none');
  const digest=createHash('sha256').update(Buffer.from(await archive.arrayBuffer())).digest('hex');
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  await original.close();
  const started=performance.now();
  restored=await PGlite.create({loadDataDir:archive,extensions:{pgcrypto,postgis}});
  const profile=(await restored.query<{id:string}>('select id from profiles where id=$1',[owner])).rows[0];
  expect(profile.id).toBe(owner);
  expect((await asUser(restored,other,tx=>tx.query('select id from customer_addresses'))).rows).toHaveLength(0);
  expect((await asUser(restored,owner,tx=>tx.query('select id from customer_addresses'))).rows).toHaveLength(1);
  const result=await restored.query<{job:{status:string;affected_rows:number}}>("select to_jsonb(public.run_operations_job('expire_order_reservations',null)) job");
  expect(result.rows[0].job).toMatchObject({status:'succeeded',affected_rows:0});
  console.info('Isolated database recovery drill:',{archive_bytes:archive.size,sha256:digest,restore_and_validation_ms:Math.round(performance.now()-started)});
 }finally{await restored?.close();if(!original.closed)await original.close();}
});
