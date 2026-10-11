import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {PGlite} from '@electric-sql/pglite';
import {applyMigrations,asUser,createDatabase,createUser} from '../helpers/db';
let db:PGlite,system:string,staff:string,customer:string,vet:string;
const row=async(sql:string,args:unknown[]=[]) => (await db.query<any>(sql,args)).rows[0];
beforeAll(async()=>{
 db=await createDatabase({through:'202610110017_remove_mfa_requirement.sql'});
 system=await createUser(db,'system@permissions.test');staff=await createUser(db,'staff@permissions.test');customer=await createUser(db,'user@permissions.test');vet=await createUser(db,'vet@permissions.test');
 await db.query("insert into public.user_roles(user_id,role_name) values($1,'super_administrator'),($2,'shelter_staff'),($3,'veterinarian')",[system,staff,vet]);
 await db.query("insert into public.contact_messages(user_id,name,email,message) values($1,'Existing owner','user@permissions.test','Keep this historical inquiry')",[customer]);
 await applyMigrations(db,f=>f>'202610110017_remove_mfa_requirement.sql');
});
afterAll(()=>db?.close());
describe('populated three-experience account migration',()=>{
 it('preserves identities, memberships and historical ownership',async()=>{
  expect((await row('select count(*)::int n from auth.users')).n).toBe(4);
  expect((await row("select count(*)::int n from public.user_roles where role_name='shelter_staff'")).n).toBe(1);
  expect((await row('select user_id from public.contact_messages')).user_id).toBe(customer);
  expect((await row('select permissions from public.staff_access where user_id=$1',[staff])).permissions).toContain('finance.manage');
  expect((await row('select public.account_permissions($1) permissions',[system])).permissions).toEqual([]);
 });
 it('denies cross-module reads and SQL workflows after narrowing a staff assignment',async()=>{
  await db.query("select public.set_staff_access($1,$2,array['animals.view','adoptions.review'])",[system,staff]);
  expect((await asUser(db,staff,tx=>tx.query('select * from public.contact_messages'))).rows).toHaveLength(0);
  await expect(db.query('select public.admin_metrics($1)',[staff])).rejects.toThrow(/Staff role required/);
  await expect(db.query('select public.authorize_workspace_export($1)',[staff])).rejects.toThrow(/export permission/);
  await expect(db.query("select public.adjust_inventory($1,gen_random_uuid(),null,1,'Denied change')",[staff])).rejects.toThrow(/staff role required/i);
  const overview=await row('select public.workspace_overview($1) data',[staff]);
  expect(Object.keys(overview.data).sort()).toEqual(['animals_in_care','pending_adoptions']);
  expect((await asUser(db,customer,tx=>tx.query('select * from public.contact_messages'))).rows).toHaveLength(1);
 });
 it('cannot grant elevated permissions or change grants as a customer',async()=>{
  await expect(db.query("select public.set_staff_access($1,$2,array['finance.manage'])",[customer,staff])).rejects.toThrow(/System administrator/);
  await expect(db.query("select public.set_staff_access($1,$2,array['adoptions.decide'])",[system,staff])).rejects.toThrow(/exceeds/);
  await expect(asUser(db,staff,tx=>tx.query("update public.staff_access set permissions=array['finance.manage']"))).rejects.toThrow(/permission denied/);
  await expect(asUser(db,staff,tx=>tx.query('select public.set_staff_access($1,$2,array[]::text[])',[system,staff]))).rejects.toThrow(/permission denied/);
  expect((await asUser(db,customer,tx=>tx.query("select public.has_permission($1,'animals.view') allowed",[staff]))).rows).toEqual([{allowed:false}]);
  expect((await asUser(db,staff,tx=>tx.query("select public.has_permission($1,'animals.view') allowed",[staff]))).rows).toEqual([{allowed:true}]);
 });
 it('creates Staff access on the same user identity without broadening to finance',async()=>{
  await db.query("select public.set_staff_access($1,$2,array['animals.view'])",[system,customer]);
  expect((await row('select public.account_permissions($1) p',[customer])).p).toEqual(['animals.view']);
  expect((await row('select user_id from public.contact_messages')).user_id).toBe(customer);
  expect((await row("select count(*)::int n from public.notifications where user_id=$1 and entity_type='profiles'",[customer])).n).toBeGreaterThan(0);
 });
 it('removing legacy authority also removes effective grants',async()=>{
  await db.query("delete from public.user_roles where user_id=$1 and role_name='shelter_staff'",[customer]);
  expect((await row('select public.account_permissions($1) p',[customer])).p).toEqual([]);
 });
 it('revokes veterinarian access at the direct database boundary',async()=>{
  const pet=await row("insert into public.pets(name,species,sex,size,status,is_published) values('Private care record','dog','unknown','small','assessment',false) returning id");
  await db.query("insert into public.pet_health_records(pet_id,record_type,notes,recorded_by) values($1,'observation','Private care notes',$2)",[pet.id,vet]);
  expect((await asUser(db,vet,tx=>tx.query('select * from public.pet_health_records'))).rows).toHaveLength(1);
  await db.query('select public.set_staff_access($1,$2,array[]::text[])',[system,vet]);
  expect((await row("select public.has_permission($1,'animals.health') allowed",[vet])).allowed).toBe(false);
  expect((await asUser(db,vet,tx=>tx.query('select * from public.pet_health_records'))).rows).toHaveLength(0);
  expect((await asUser(db,vet,tx=>tx.query('select id from public.pets'))).rows).toHaveLength(0);
 });
 it('approves and deactivates volunteer capability on the original identity while retaining tasks',async()=>{
  await db.query("insert into public.volunteer_profiles(user_id,motivation) values($1,'Help care for shelter animals')",[customer]);
  await db.query("update public.volunteer_profiles set status='approved',reviewed_by=$2 where user_id=$1",[customer,staff]);
  expect((await row("select public.has_role($1,array['volunteer']) approved",[customer])).approved).toBe(true);
  expect((await row('select public.account_permissions($1) p',[customer])).p).toContain('rescue.assigned');
  await db.query("insert into public.volunteer_tasks(volunteer_id,assigned_by,title) values($1,$2,'Prepare food')",[customer,staff]);
  await db.query("update public.volunteer_profiles set status='inactive' where user_id=$1",[customer]);
  expect((await row("select public.has_role($1,array['volunteer']) approved",[customer])).approved).toBe(false);
  expect((await row('select public.account_permissions($1) p',[customer])).p).not.toContain('rescue.assigned');
  expect((await row('select count(*)::int n from public.volunteer_tasks where volunteer_id=$1',[customer])).n).toBe(1);
  expect((await row('select count(*)::int n from auth.users')).n).toBe(4);
 });
});
