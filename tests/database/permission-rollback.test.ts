import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {applyMigrations,createDatabase,createUser} from '../helpers/db';
const rollback=readFileSync(new URL('../../supabase/rollback/018_before_permission_changes.sql',import.meta.url),'utf8');
it('rolls an unused permission rollout back to the exact previous policies and functions',async()=>{
 const db=await createDatabase({through:'202610110017_remove_mfa_requirement.sql'});
 try{
  const identity=await createUser(db,'retained@rollback.test');
  const before=(await db.query("select pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname in ('transition_order','admin_metrics','can_read_report') order by proname")).rows;
  await applyMigrations(db,f=>f>'202610110017_remove_mfa_requirement.sql');
  await db.exec(rollback);
  expect((await db.query("select pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname in ('transition_order','admin_metrics','can_read_report') order by proname")).rows).toEqual(before);
  expect((await db.query('select id from auth.users')).rows).toEqual([{id:identity}]);
  expect((await db.query('select schema_version from operations_config')).rows).toEqual([{schema_version:'017'}]);
 }finally{await db.close();}
});
it('refuses a schema rollback once permission restrictions have been assigned',async()=>{
 const db=await createDatabase();
 try{
  const system=await createUser(db,'system@rollback.test'),staff=await createUser(db,'staff@rollback.test');
  await db.query("insert into user_roles(user_id,role_name) values($1,'super_administrator')",[system]);
  await db.query("select public.set_staff_access($1,$2,array['animals.view'])",[system,staff]);
  await expect(db.exec(rollback)).rejects.toThrow(/Rollback refused/);
  await db.exec('rollback');
  expect((await db.query('select public.account_permissions($1) p',[staff])).rows).toEqual([{p:['animals.view']}]);
 }finally{await db.close();}
});
