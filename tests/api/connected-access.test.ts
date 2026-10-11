import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Test-only PostgREST adapter: assertions check both returned data and the filters
// the service-role API actually sends. SQL/RLS is exercised separately in PGlite.
const state=vi.hoisted(()=>({aal:'aal2',sessionAllowed:true,tables:{} as Record<string,any[]>,queries:[] as {table:string;filters:[string,unknown][];select:string}[],rpc:vi.fn()}));
const ids={alice:'00000000-0000-4000-8000-000000000001',bob:'00000000-0000-4000-8000-000000000002',admin:'00000000-0000-4000-8000-000000000003',super:'00000000-0000-4000-8000-000000000004'};
vi.mock('../../server/src/config/supabase',()=>({
 db:()=>({
  auth:{mfa:{getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:state.aal},error:null})},getUser:async(token:string)=>{
   const id=token.includes('.')?JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).sub:token;
   return Object.values(ids).includes(id)?{data:{user:{id}},error:null}:{data:{user:null},error:{message:'invalid'}};
  }},
  rpc:state.rpc,
  from:(table:string)=>{
   const entry={table,filters:[] as [string,unknown][],select:'*'};state.queries.push(entry);
   let first=0,last=999,single=false;
   const builder:any={
    select:(s:string)=>{entry.select=s;return builder;},
    eq:(key:string,value:unknown)=>{entry.filters.push([key,value]);return builder;},
    in:(key:string,value:unknown[])=>{entry.filters.push([key,value]);return builder;},
    is:(key:string,value:unknown)=>{entry.filters.push([key,value]);return builder;},
    order:()=>builder,limit:()=>builder,
    range:(a:number,b:number)=>{first=a;last=b;return builder;},
    single:()=>{single=true;return builder;},maybeSingle:()=>{single=true;return builder;},
    then:(resolve:(value:unknown)=>void,reject:(e:unknown)=>void)=>{
     let rows=(state.tables[table]||[]).filter(row=>entry.filters.every(([key,value])=>Array.isArray(value)?value.includes(row[key]):row[key]===value));
     const count=rows.length;rows=rows.slice(first,last+1);
     if(!entry.select.includes('*')){const keys=entry.select.split(',').filter(k=>!k.includes('('));rows=rows.map(row=>Object.fromEntries(Object.entries(row).filter(([k])=>keys.includes(k)||['roles','product_categories'].includes(k))));}
     return Promise.resolve({data:single?rows[0]||null:rows,count,error:null}).then(resolve,reject);
    },
   };return builder;
  },
 }),publicAuth:()=>{throw Error('Not used');},
}));
import { createApp } from '../../server/src/app';
const app=createApp();
const tokenFor=(id:string)=>`test.${Buffer.from(JSON.stringify({sub:id,session_id:id,amr:[{method:'totp',timestamp:Math.floor(Date.now()/1000)}]})).toString('base64url')}.test`;
const workflowCalls=()=>state.rpc.mock.calls.filter(call=>call[0]!=='account_session_allowed');
beforeEach(()=>{
 state.aal='aal2';state.sessionAllowed=true;
 state.queries=[];state.rpc.mockReset().mockImplementation(async(name:string)=>({data:name==='account_session_allowed'?state.sessionAllowed:null,error:null}));
 state.tables={user_roles:[{user_id:ids.alice,roles:{name:'buyer'}},{user_id:ids.bob,roles:{name:'buyer'}},{user_id:ids.admin,roles:{name:'administrator'}},{user_id:ids.super,roles:{name:'super_administrator'}}]};
});
describe('connected API ownership',()=>{
 it('reports a deployment mismatch and refuses access when the session-check migration is missing',async()=>{
  state.rpc.mockImplementation(async()=>({data:null,error:{code:'PGRST202',message:'Missing public.account_session_allowed in schema cache'}}));
  const result=await request(app).get('/api/auth/me').set('Authorization',`Bearer ${tokenFor(ids.alice)}`).expect(503);
  expect(result.body.error.code).toBe('DEPLOYMENT_SCHEMA_MISMATCH');
  expect(result.body.error.message).toContain('database upgrade');
  expect(result.body.data).toBeUndefined();
  expect(state.queries.some(q=>q.table==='profiles'||q.table==='user_roles')).toBe(false);
 });
 it.each([null,'invalid',{},Number.MAX_VALUE])('rejects malformed MFA freshness evidence: %s',async(timestamp)=>{
  const token=`test.${Buffer.from(JSON.stringify({sub:ids.super,session_id:ids.super,amr:[{method:'totp',timestamp}]})).toString('base64url')}.test`;
  const response=await request(app).post('/api/admin/operations/jobs/run').set('Authorization',`Bearer ${token}`).send({kind:'retention'}).expect(403);
  expect(response.body.error.code).toBe('MFA_REAUTH_REQUIRED');
  expect(workflowCalls().some(call=>call[0]==='run_operations_job')).toBe(false);
 });
 it('requires system authority for IT records and fresh MFA for critical writes',async()=>{
  await request(app).get('/api/admin/operations/records/jobs').set('Authorization',`Bearer ${tokenFor(ids.admin)}`).expect(403);
  state.aal='aal1';
  await request(app).get('/api/admin/operations/records/jobs').set('Authorization',`Bearer ${tokenFor(ids.super)}`).expect(403);
  expect(state.queries.some(q=>q.table==='operations_jobs')).toBe(false);
 });
 it('rejects unknown job kinds and unconfigured workers before executing anything',async()=>{
  await request(app).post('/api/admin/operations/jobs/run').set('Authorization',`Bearer ${tokenFor(ids.super)}`).send({kind:'arbitrary_sql'}).expect(400);
  const result=await request(app).post('/api/admin/operations/requests').set('Authorization',`Bearer ${tokenFor(ids.super)}`).send({idempotency_key:crypto.randomUUID(),kind:'backup',target:'production',reason:'An isolated API request',confirmation:'PawsConnect production',recovery_point_id:null,pre_restore_backup_id:null,release_ref:null}).expect(503);
  expect(result.body.error.code).toBe('WORKER_UNCONFIGURED');
  await request(app).post('/api/operations/worker/claim').send({}).expect(401);
  expect(workflowCalls()).toEqual([]);
 });
 it('refuses an otherwise valid token after its app session is revoked',async()=>{
  state.sessionAllowed=false;
  const result=await request(app).get('/api/account/records/orders').set('Authorization',`Bearer ${tokenFor(ids.alice)}`).expect(401);
  expect(result.body.error.code).toBe('SESSION_REVOKED');
  expect(state.queries.some(q=>q.table==='orders')).toBe(false);
 });
 it.each([
  ['orders','orders','user_id'],['payments','payment_transactions','user_id'],['applications','adoption_applications','user_id'],['reports','stray_reports','user_id'],['transport','transport_requests','user_id'],['alternatives','alternative_transport_requests','user_id'],['donations','donations','user_id'],['favorites','favorite_pets','user_id'],['messages','contact_messages','user_id'],['refunds','refunds','requested_by'],['notifications','notifications','user_id'],
 ])('scopes %s to the authenticated actor and paginates in the database',async(kind,table,owner)=>{
  state.tables[table]=[{id:'a',[owner]:ids.alice},{id:'b',[owner]:ids.bob}];
  const response=await request(app).get(`/api/account/records/${kind}?page=1&limit=1`).set('Authorization',`Bearer ${tokenFor(ids.alice)}`).expect(200);
  expect(response.body.data.map((row:any)=>row.id)).toEqual(['a']);expect(response.body.meta.total).toBe(1);
  expect(state.queries.find(q=>q.table===table)?.filters).toContainEqual([owner,ids.alice]);
 });
 it('rejects unknown account resources instead of interpolating arbitrary table names',async()=>{
  await request(app).get('/api/account/records/audit_logs').set('Authorization',`Bearer ${tokenFor(ids.alice)}`).expect(404);
  expect(state.queries.some(q=>q.table==='audit_logs')).toBe(false);
 });
 it('records actual authenticated denials but never exposes security events to ordinary administrators',async()=>{
  await request(app).get('/api/admin/security_events').set('Authorization',`Bearer ${tokenFor(ids.admin)}`).expect(403);
  expect(state.rpc).toHaveBeenCalledWith('record_authorization_denial',{p_actor_id:ids.admin,p_route:'GET /api/admin/security_events'});
  expect(state.queries.some(q=>q.table==='security_events')).toBe(false);
  await request(app).get('/api/admin/security_events').set('Authorization',`Bearer ${tokenFor(ids.super)}`).expect(200);
 });
 it('does not attribute invalid tokens to a fabricated user',async()=>{
  await request(app).get('/api/account/records/orders').set('Authorization','Bearer invalid').expect(401);
  expect(workflowCalls()).toEqual([]);
 });
 it('requires critical approval for administrator grants through the API',async()=>{
  const token=`test.${Buffer.from(JSON.stringify({sub:ids.super,session_id:ids.super,amr:[{method:'totp',timestamp:Math.floor(Date.now()/1000)}]})).toString('base64url')}.test`;
  await request(app).post(`/api/admin/users/${ids.alice}/roles`).set('Authorization',`Bearer ${token}`).send({role_name:'administrator'}).expect(409);
  expect(workflowCalls()).toEqual([]);
 });
 it('requires MFA before a privileged account can read its workspace',async()=>{
  state.aal='aal1';
  const result=await request(app).get('/api/admin/security_events').set('Authorization',`Bearer ${tokenFor(ids.super)}`).expect(403);
  expect(result.body.error.code).toBe('MFA_REQUIRED');
  expect(state.queries.some(q=>q.table==='security_events')).toBe(false);
 });
 it('requires fresh MFA before changing system access',async()=>{
  const staleToken=`test.${Buffer.from(JSON.stringify({sub:ids.super,session_id:ids.super,amr:[{method:'totp',timestamp:1}]})).toString('base64url')}.test`;
  const result=await request(app).post(`/api/admin/users/${ids.alice}/roles`).set('Authorization',`Bearer ${staleToken}`).send({role_name:'volunteer'}).expect(403);
  expect(result.body.error.code).toBe('MFA_REAUTH_REQUIRED');
  expect(workflowCalls().map(call=>call[0])).toEqual(['record_authorization_denial']);
 });
 it('refuses role changes by a shelter administrator, and records the refusal',async()=>{
  await request(app).post(`/api/admin/users/${ids.alice}/roles`).set('Authorization',`Bearer ${tokenFor(ids.admin)}`).send({role_name:'volunteer'}).expect(403);
  await request(app).get('/api/admin/users').set('Authorization',`Bearer ${tokenFor(ids.admin)}`).expect(403);
  await request(app).get('/api/admin/audit_logs').set('Authorization',`Bearer ${tokenFor(ids.admin)}`).expect(403);
  // No role was assigned; the only database calls are the security events for the three refusals.
  expect(workflowCalls().map((call:unknown[])=>call[0])).toEqual(['record_authorization_denial','record_authorization_denial','record_authorization_denial']);
 });
 it('refuses shelter operations to the super administrator',async()=>{
  for(const path of ['/api/admin/analytics','/api/admin/orders','/api/admin/products','/api/admin/pets']) await request(app).get(path).set('Authorization',`Bearer ${tokenFor(ids.super)}`).expect(403);
  expect(state.queries.some((q:{table:string})=>['orders','products','pets'].includes(q.table))).toBe(false);
 });
 it('public catalogs never disclose acquisition costs or internal care notes',async()=>{
  state.tables.products=[{id:'p',name:'Published',cost_centavos:500,price_centavos:1000,is_published:true,is_sample:false},{id:'hidden',is_published:false,is_sample:false}];
  const response=await request(app).get('/api/products').expect(200);
  expect(response.body.data).toHaveLength(1);expect(response.body.data[0].cost_centavos).toBeUndefined();
  const query=state.queries.find(q=>q.table==='products')!;expect(query.select).not.toContain('cost_centavos');expect(query.select).not.toContain('*');
  await request(app).get('/api/pets').expect(200);
  const pets=state.queries.find(q=>q.table==='pets')!;expect(pets.select).not.toContain('notes');expect(pets.select).not.toContain('verified_by');
 });
});
