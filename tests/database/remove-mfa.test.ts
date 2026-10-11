import {expect,it} from 'vitest';
import {applyMigrations,asUser,createDatabase,createUser} from '../helpers/db';

it('upgrades 016 to password-only access without restoring revoked sessions or losing records',async()=>{
 const prior='202610110016_session_and_alert_controls.sql';
 const db=await createDatabase({through:prior});
 try{
  const system=await createUser(db,'system-mfa-upgrade@test.local');
  const customer=await createUser(db,'customer-mfa-upgrade@test.local');
  await db.query("insert into user_roles(user_id,role_name) values($1,'super_administrator')",[system]);
  await db.query("select public.change_account_access($1,$2,'suspend','Suspended before migration test')",[system,customer]);
  const restrictions=(await db.query('select * from account_access_controls')).rows;
  const audit=(await db.query('select * from audit_logs order by id')).rows;
  expect((await asUser(db,system,tx=>tx.query('select * from operations_config'))).rows).toEqual([]);
  await applyMigrations(db,file=>file>prior);
  expect((await db.query('select * from account_access_controls')).rows).toEqual(restrictions);
  expect((await db.query('select * from audit_logs order by id')).rows).toEqual(audit);
  expect((await asUser(db,system,tx=>tx.query('select schema_version from operations_config'))).rows).toEqual([{schema_version:'017'}]);
  expect((await asUser(db,customer,tx=>tx.query('select * from profiles'))).rows).toEqual([]);
  await db.query('delete from auth.sessions where user_id=$1',[system]);
  expect((await asUser(db,system,tx=>tx.query('select * from operations_config'))).rows).toEqual([]);
 }finally{await db.close();}
});
