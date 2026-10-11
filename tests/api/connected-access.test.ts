import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Test-only PostgREST adapter: assertions check both returned data and the filters
// the service-role API actually sends. SQL/RLS is exercised separately in PGlite.
const state=vi.hoisted(()=>({tables:{} as Record<string,any[]>,queries:[] as {table:string;filters:[string,unknown][];select:string}[],rpc:vi.fn()}));
const ids={alice:'00000000-0000-4000-8000-000000000001',bob:'00000000-0000-4000-8000-000000000002',admin:'00000000-0000-4000-8000-000000000003',super:'00000000-0000-4000-8000-000000000004'};
vi.mock('../../server/src/config/supabase',()=>({
 db:()=>({
  auth:{getUser:async(token:string)=>Object.values(ids).includes(token)?{data:{user:{id:token}},error:null}:{data:{user:null},error:{message:'invalid'}}},
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
beforeEach(()=>{
 state.queries=[];state.rpc.mockReset().mockResolvedValue({data:null,error:null});
 state.tables={user_roles:[{user_id:ids.alice,roles:{name:'buyer'}},{user_id:ids.bob,roles:{name:'buyer'}},{user_id:ids.admin,roles:{name:'administrator'}},{user_id:ids.super,roles:{name:'super_administrator'}}]};
});
describe('connected API ownership',()=>{
 it.each([
  ['orders','orders','user_id'],['payments','payment_transactions','user_id'],['applications','adoption_applications','user_id'],['reports','stray_reports','user_id'],['transport','transport_requests','user_id'],['alternatives','alternative_transport_requests','user_id'],['donations','donations','user_id'],['favorites','favorite_pets','user_id'],['messages','contact_messages','user_id'],['refunds','refunds','requested_by'],['notifications','notifications','user_id'],
 ])('scopes %s to the authenticated actor and paginates in the database',async(kind,table,owner)=>{
  state.tables[table]=[{id:'a',[owner]:ids.alice},{id:'b',[owner]:ids.bob}];
  const response=await request(app).get(`/api/account/records/${kind}?page=1&limit=1`).set('Authorization',`Bearer ${ids.alice}`).expect(200);
  expect(response.body.data.map((row:any)=>row.id)).toEqual(['a']);expect(response.body.meta.total).toBe(1);
  expect(state.queries.find(q=>q.table===table)?.filters).toContainEqual([owner,ids.alice]);
 });
 it('rejects unknown account resources instead of interpolating arbitrary table names',async()=>{
  await request(app).get('/api/account/records/audit_logs').set('Authorization',`Bearer ${ids.alice}`).expect(404);
  expect(state.queries.some(q=>q.table==='audit_logs')).toBe(false);
 });
 it('records actual authenticated denials but never exposes security events to ordinary administrators',async()=>{
  await request(app).get('/api/admin/security_events').set('Authorization',`Bearer ${ids.admin}`).expect(403);
  expect(state.rpc).toHaveBeenCalledWith('record_authorization_denial',{p_actor_id:ids.admin,p_route:'GET /api/admin/security_events'});
  expect(state.queries.some(q=>q.table==='security_events')).toBe(false);
  await request(app).get('/api/admin/security_events').set('Authorization',`Bearer ${ids.super}`).expect(200);
 });
 it('does not attribute invalid tokens to a fabricated user',async()=>{
  await request(app).get('/api/account/records/orders').set('Authorization','Bearer invalid').expect(401);
  expect(state.rpc).not.toHaveBeenCalled();
 });
 it('requires critical approval for administrator grants through the API',async()=>{
  await request(app).post(`/api/admin/users/${ids.alice}/roles`).set('Authorization',`Bearer ${ids.admin}`).send({role_name:'administrator'}).expect(409);
  expect(state.rpc).not.toHaveBeenCalled();
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
