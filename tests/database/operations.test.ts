import type {PGlite} from '@electric-sql/pglite';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {createDatabase,createUser,asUser} from '../helpers/db';
let db:PGlite,one:string,two:string,staff:string,buyer:string;
const row=async(sql:string,args:unknown[]=[])=> (await db.query<any>(sql,args)).rows[0];
const config=(mode='normal')=>({mode,modules:[],starts_at:new Date(Date.now()-1000).toISOString(),ends_at:new Date(Date.now()+3600000).toISOString(),public_notice:'Scheduled testing',instructions:'Verify before reopening',reason:'Isolated maintenance test',disabled_features:[],slow_request_ms:2000,backup_interval_hours:null,retention_days:30,rpo_minutes:1440,rto_minutes:240});
async function request(kind:string,key=crypto.randomUUID(),point:string|null=null,pre:string|null=null){return (await row('select to_jsonb(public.record_operations_request($1,$2,$3,$4,$5,$6,$7,null)) as r',[one,key,kind,kind==='restore_drill'?'staging':'production','An isolated recovery test',point,pre])).r;}
beforeAll(async()=>{db=await createDatabase();one=await createUser(db,'ops-one@test.local');two=await createUser(db,'ops-two@test.local');staff=await createUser(db,'staff@test.local');buyer=await createUser(db,'buyer@test.local');await db.query("insert into user_roles(user_id,role_name) values ($1,'super_administrator'),($2,'super_administrator'),($3,'administrator')",[one,two,staff]);});
afterAll(()=>db.close());
describe('operations integrity and authorization',()=>{
 it('is additive and starts with no invented operations history',async()=>{
  for(const table of ['operations_incidents','operations_jobs','operations_requests','operations_signals','operations_telemetry'])expect((await row(`select count(*)::int n from ${table}`)).n).toBe(0);
 });
 it('refuses shelter roles and browser writes, including privileged functions',async()=>{
  await expect(db.query('select public.change_operations_config($1,1,$2)',[staff,config()])).rejects.toThrow(/Super administrator/);
  await expect(asUser(db,one,tx=>tx.query("update operations_config set mode='normal'"))).rejects.toThrow(/permission denied/);
  await expect(asUser(db,one,tx=>tx.query('select public.run_operations_job($1,$2)',['retention',one]))).rejects.toThrow(/permission denied/);
  expect((await asUser(db,buyer,tx=>tx.query('select * from operations_config'))).rows).toEqual([]);
 });
 it('rejects stale configuration and audits the accepted change atomically',async()=>{
  await db.query('select public.change_operations_config($1,1,$2)',[one,config('read_only')]);
  await expect(db.query('select public.change_operations_config($1,1,$2)',[two,config()])).rejects.toThrow(/Settings changed/);
  expect((await row("select count(*)::int n from audit_logs where action='operations.config_changed'")).n).toBe(1);
  await expect(asUser(db,buyer,tx=>tx.query('update profiles set full_name=$1 where id=$2',['Blocked name',buyer]))).rejects.toThrow(/maintenance/);
  await db.query('select public.change_operations_config($1,2,$2)',[one,config()]);
 });
 it('records incident state and immutable timeline in one transaction',async()=>{
  const input={title:'Test unavailable service',severity:'high',service:'database',classification:'availability',assigned_to:two,notes:'Investigation started in isolation'};
  const incident=(await row('select to_jsonb(public.save_operations_incident($1,null,$2)) r',[one,input])).r;
  await expect(db.query('select public.save_operations_incident($1,$2,$3)',[one,incident.id,{status:'resolved',assigned_to:two,notes:'Attempt without resolution',resolution:'short'}])).rejects.toThrow();
  await db.query('select public.save_operations_incident($1,$2,$3)',[two,incident.id,{status:'resolved',assigned_to:two,notes:'Validated database connectivity',resolution:'Database connectivity is restored',postmortem:'Review the integration timeout'}]);
  expect((await row('select count(*)::int n from operations_incident_events where incident_id=$1',[incident.id])).n).toBe(2);
 });
 it('deduplicates backup requests and never labels an unverified result successful',async()=>{
  const key=crypto.randomUUID(),backup=await request('backup',key);
  expect((await request('backup',key)).id).toBe(backup.id);
  const claim=(await row("select to_jsonb(public.claim_operations_request(array['backup'])) r")).r;
  expect(claim.status).toBe('running');
  await expect(db.query('select public.complete_operations_request($1,$2,true,$3,null)',[claim.id,claim.lease_token,{integrity_verified:true}])).rejects.toThrow(/evidence/);
  await db.query('select public.complete_operations_request($1,$2,true,$3,null)',[claim.id,claim.lease_token,{integrity_verified:true,database_covered:true,storage_covered:true,encrypted_offsite:true,sha256:'a'.repeat(64),artifact_ref:'fixture/backup-1',bytes:1024}]);
  await expect(db.query('select public.complete_operations_request($1,$2,true,$3,null)',[claim.id,claim.lease_token,{}])).rejects.toThrow(/lease/);
 });
 it('requires independent approval and a drill before production recovery',async()=>{
  const backup=(await row("select id from operations_requests where kind='backup' and status='succeeded' limit 1")).id;
  await expect(request('restore_production',crypto.randomUUID(),backup,backup)).rejects.toThrow(/staging drill/);
  const drill=await request('restore_drill',crypto.randomUUID(),backup);
  await expect(db.query('select public.decide_operations_request($1,$2,true,$3)',[one,drill.id,'Approve my own request'])).rejects.toThrow(/different/);
  await db.query('select public.decide_operations_request($1,$2,true,$3)',[two,drill.id,'Independent approval for test']);
  const claim=(await row("select to_jsonb(public.claim_operations_request(array['restore_drill'])) r")).r;
  await expect(db.query('select public.complete_operations_request($1,$2,true,$3,null)',[claim.id,claim.lease_token,{validation_passed:false}])).rejects.toThrow(/validation/);
  await db.query('select public.complete_operations_request($1,$2,true,$3,null)',[claim.id,claim.lease_token,{validation_passed:true,rto_seconds:42}]);
  const production=await request('restore_production',crypto.randomUUID(),backup,backup);
  await db.query('select public.decide_operations_request($1,$2,true,$3)',[two,production.id,'Independent production recovery approval']);
  expect((await row("select to_jsonb(public.claim_operations_request(array['restore_production'])) r")).r?.id ?? null).toBeNull();
  expect((await row('select status from operations_requests where id=$1',[production.id])).status).toBe('queued');
 });
 it('retains ambiguous worker outcomes instead of replaying restoration',async()=>{
  const backup=await request('backup');const claim=(await row("select to_jsonb(public.claim_operations_request(array['backup'])) r")).r;
  await db.query("update operations_requests set lease_expires_at=now()-interval '1 minute' where id=$1",[claim.id]);
  await db.query("select public.claim_operations_request(array['backup'])");
  expect((await row('select status from operations_requests where id=$1',[backup.id])).status).toBe('unknown');
 });
 it('reports real job results and bounded diagnostic values',async()=>{
  const job=(await row("select to_jsonb(public.run_operations_job('expire_order_reservations',$1)) r",[one])).r;
  expect(job.status).toBe('succeeded');expect(job.affected_rows).toBe(0);expect(job.finished_at).toBeTruthy();
  const metrics=(await row('select public.operations_diagnostics($1) r',[one])).r;
  expect(metrics.schema_version).toBe('016');expect(metrics.database_bytes).toBeGreaterThan(0);
 });
 it('rechecks approval access before dispatch and blocks unresolved target outcomes',async()=>{
  const backup=(await row("select id from operations_requests where kind='backup' and status='succeeded' limit 1")).id;
  const drill=await request('restore_drill',crypto.randomUUID(),backup);
  await db.query('select public.decide_operations_request($1,$2,true,$3)',[two,drill.id,'Independent staging approval']);
  await db.query("delete from user_roles where user_id=$1 and role_name='super_administrator'",[two]);
  await db.query("select public.claim_operations_request(array['restore_drill'])");
  expect((await row('select status from operations_requests where id=$1',[drill.id])).status).toBe('pending_approval');
  await db.query("insert into user_roles(user_id,role_name) values($1,'super_administrator')",[two]);
  await db.query('select public.decide_operations_request($1,$2,true,$3)',[two,drill.id,'Fresh independent staging approval']);
  const claim=(await row("select to_jsonb(public.claim_operations_request(array['restore_drill'])) r")).r;
  await db.query("update operations_requests set lease_expires_at=now()-interval '1 minute' where id=$1",[claim.id]);
  await db.query("select public.claim_operations_request(array['restore_drill'])");
  await expect(db.query('select public.complete_operations_request($1,$2,true,$3,null)',[claim.id,claim.lease_token,{validation_passed:true}])).rejects.toThrow(/lease/);
  const second=await request('restore_drill',crypto.randomUUID(),backup);
  await db.query('select public.decide_operations_request($1,$2,true,$3)',[two,second.id,'Review another staging request']);
  await db.query("select public.claim_operations_request(array['restore_drill'])");
  expect((await row('select status from operations_requests where id=$1',[second.id])).status).toBe('queued');
 });
 it('suspends API and direct database access while retaining all records',async()=>{
  expect((await row('select public.account_session_allowed($1,$1) allowed',[buyer])).allowed).toBe(true);
  await db.query("select public.change_account_access($1,$2,'suspend','Investigating confirmed account compromise')",[one,buyer]);
  expect((await row('select public.account_session_allowed($1,$1) allowed',[buyer])).allowed).toBe(false);
  expect((await asUser(db,buyer,tx=>tx.query('select id from profiles'))).rows).toEqual([]);
  expect((await row('select count(*)::int n from profiles where id=$1',[buyer])).n).toBe(1);
  await db.query("select public.change_account_access($1,$2,'reinstate','Investigation completed and access restored')",[one,buyer]);
  expect((await row('select public.account_session_allowed($1,$1) allowed',[buyer])).allowed).toBe(false);
  // A new provider sign-in creates a different session; refreshing the old one cannot bypass the cutoff.
  const newSession=crypto.randomUUID();await db.query('insert into auth.sessions(id,user_id,created_at) values($1,$2,clock_timestamp())',[newSession,buyer]);
  expect((await row('select public.account_session_allowed($1,$2) allowed',[buyer,newSession])).allowed).toBe(true);
  await expect(db.query("select public.change_account_access($1,$2,'suspend','Attempting elevated suspension')",[one,two])).rejects.toThrow(/independent approval/);
 });
 it('requires a current provider session, even for a valid account id',async()=>{
  expect((await row('select public.account_session_allowed($1,$2) allowed',[one,crypto.randomUUID()])).allowed).toBe(false);
  expect((await row('select public.account_session_allowed($1,$2) allowed',[one,two])).allowed).toBe(false);
  await expect(asUser(db,one,tx=>tx.query('select public.account_session_allowed($1,$1)',[two]))).rejects.toThrow(/permission denied/);
 });
 it('does not let a privileged account bypass MFA through direct database reads',async()=>{
  const result=await asUser(db,one,async tx=>{
   await tx.query("select set_config('request.jwt.claim.aal','aal1',true)");
   return tx.query('select * from audit_logs');
  });
  expect(result.rows).toEqual([]);
 });
});
