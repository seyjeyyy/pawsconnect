import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createDatabase, createUser } from '../helpers/db';

let db: PGlite;
let owner: string, outsider: string, admin: string, staff: string, rescuer: string, driver: string, superAdmin: string, secondSuper: string;
let pet: string, product: string, vehicle: string;
const one = async (sql: string, args: unknown[] = []) => (await db.query<any>(sql, args)).rows[0];
beforeAll(async () => {
  db = await createDatabase();
  [owner,outsider,admin,staff,rescuer,driver,superAdmin,secondSuper] = await Promise.all(['owner','outsider','admin','staff','rescuer','driver','super','super2'].map(name => createUser(db,`${name}@connected.test`)));
  for (const [user,role] of [[admin,'administrator'],[staff,'shelter_staff'],[rescuer,'rescue_personnel'],[driver,'shelter_driver'],[superAdmin,'super_administrator'],[secondSuper,'super_administrator']]) await db.query('insert into public.user_roles(user_id,role_name) values($1,$2)',[user,role]);
  pet = (await one("insert into public.pets(name,species,sex,size,status,is_published) values('Test pet','dog','female','small','available',true) returning id")).id;
  product = (await one("insert into public.products(name,slug,price_centavos,stock_quantity,is_published) values('Test item','connected-item',12500,8,true) returning id")).id;
  vehicle = (await one("insert into public.shelter_vehicles(name,plate_number,animal_capacity) values('Test vehicle','TEST-ONLY',2) returning id")).id;
  await db.query("insert into public.shelter_drivers(user_id,license_reference,verified_by,is_active) values($1,'test licence',$2,true)",[driver,admin]);
  // Isolated geometric fixtures, never used as real Bulacan service boundaries.
  for (const service of ['rescue','transport','delivery']) await db.query(`insert into public.service_zones(name,service_type,province,boundary,source_reference,is_active,created_by) values('Test boundary',$1,'Bulacan',extensions.st_multi(extensions.st_geomfromtext('POLYGON((120.78 14.82,120.84 14.82,120.84 14.87,120.78 14.87,120.78 14.82))',4326)),'automated test fixture',true,$2)`,[service,admin]);
});
afterAll(()=>db.close());

describe('persisted account data',()=>{
  it('saves a profile and a cart, scopes private records, and rejects untrusted cart quantities',async()=>{
    await asUser(db,owner,tx=>tx.query("update public.profiles set full_name='Updated owner' where id=$1",[owner]));
    expect((await asUser(db,owner,tx=>tx.query<any>('select full_name from public.profiles where id=$1',[owner]))).rows[0].full_name).toBe('Updated owner');
    await db.query('select public.set_cart_item($1,$2,null,3)',[owner,product]);
    await db.query('select public.set_cart_item($1,$2,null,4)',[owner,product]);
    expect((await asUser(db,owner,tx=>tx.query<any>('select quantity from public.cart_items'))).rows).toEqual([{quantity:4}]);
    expect((await asUser(db,outsider,tx=>tx.query('select * from public.cart_items'))).rows).toHaveLength(0);
    await expect(db.query('select public.set_cart_item($1,$2,null,9)',[owner,product])).rejects.toThrow(/stock/);
    await expect(asUser(db,outsider,tx=>tx.query('select public.set_cart_item($1,$2,null,1)',[owner,product]))).rejects.toThrow(/permission denied/);
    expect((await one('select stock_quantity from public.products where id=$1',[product])).stock_quantity).toBe(8);
  });
  it('keeps favorites private and saves support replies with recipient notifications',async()=>{
    await db.query('insert into public.favorite_pets(user_id,pet_id) values($1,$2)',[owner,pet]);
    expect((await asUser(db,outsider,tx=>tx.query('select * from public.favorite_pets'))).rows).toHaveLength(0);
    const message=await one("insert into public.contact_messages(user_id,name,email,message) values($1,'Owner','owner@connected.test','Please explain the adoption process') returning id",[owner]);
    await expect(db.query("select public.reply_to_contact($1,$2,'Please see your account')",[outsider,message.id])).rejects.toThrow(/Staff/);
    await db.query("select public.reply_to_contact($1,$2,'Please see your account for the scheduled interview')",[staff,message.id]);
    const saved=await one('select status,reply,replied_at from public.contact_messages where id=$1',[message.id]);
    expect(saved.status).toBe('replied');expect(saved.reply).toContain('interview');expect(saved.replied_at).toBeTruthy();
    const seen=await asUser(db,owner,tx=>tx.query<any>('select id,entity_id from public.notifications where entity_id=$1',[message.id]));
    expect(seen.rows).toHaveLength(1);
    await asUser(db,owner,tx=>tx.query('update public.notifications set read_at=now() where id=$1',[seen.rows[0].id]));
    expect((await asUser(db,owner,tx=>tx.query<any>('select read_at from public.notifications where id=$1',[seen.rows[0].id]))).rows[0].read_at).toBeTruthy();
    expect((await asUser(db,outsider,tx=>tx.query('select * from public.notifications'))).rows).toHaveLength(0);
  });
  it('computes totals over every record instead of truncating at the API page size',async()=>{
    await db.query("insert into public.notifications(user_id,title,body) select $1,'Test notification','Only inside PGlite' from generate_series(1,105)",[owner]);
    const metrics=(await one('select public.account_metrics($1) as data',[owner])).data;
    expect(metrics.updates).toBe(105);
    expect((await one('select public.account_metrics($1) as data',[outsider])).data.updates).toBe(0);
  });
});

describe('adoption, interviews and verified care data',()=>{
  let application:string;
  it('atomically creates the application and adopter household and blocks foreign or missing documents',async()=>{
    await expect(db.query("select public.submit_adoption_application($1,$2,'I can provide a caring home','{}',array[$3])",[owner,pet,`${outsider}/missing.pdf`])).rejects.toThrow(/uploaded file/);
    expect((await one('select count(*)::int as n from public.adoption_applications')).n).toBe(0);
    const saved=await one("select * from public.submit_adoption_application($1,$2,'I can provide a caring home','{\"housing_type\":\"house\"}','{}')",[owner,pet]);
    application=saved.id;expect(saved.status).toBe('submitted');
    expect((await one('select housing_type from public.adopter_profiles where user_id=$1',[owner])).housing_type).toBe('house');
    expect((await asUser(db,outsider,tx=>tx.query('select * from public.adoption_applications'))).rows).toHaveLength(0);
    expect((await asUser(db,staff,tx=>tx.query('select * from public.adoption_applications'))).rows).toHaveLength(1);
  });
  it('reviews, schedules, approves, reserves and finalizes only through authorized transitions',async()=>{
    await expect(db.query("select public.transition_adoption($1,$2,'under_review',null)",[outsider,application])).rejects.toThrow(/not permitted/);
    await db.query("select public.transition_adoption($1,$2,'under_review','Requirements reviewed')",[staff,application]);
    await db.query("select public.schedule_adoption_appointment($1,$2,now()+interval '1 day','Shelter meeting room','Bring proof of address')",[staff,application]);
    expect((await asUser(db,owner,tx=>tx.query('select * from public.adoption_appointments'))).rows).toHaveLength(1);
    await expect(db.query("select public.transition_adoption($1,$2,'approved','Approved')",[staff,application])).rejects.toThrow(/not permitted/);
    await db.query("select public.transition_adoption($1,$2,'approved','Requirements verified')",[admin,application]);
    await db.query('select public.reserve_pet($1,$2)',[staff,application]);
    await expect(db.query('select public.reserve_pet($1,$2)',[staff,application])).rejects.toThrow();
    await db.query("select public.transition_adoption($1,$2,'awaiting_handover','No adoption fee for this test pet')",[staff,application]);
    await db.query("select public.finalize_adoption($1,$2,'Identity and physical handover verified')",[staff,application]);
    expect((await one('select status from public.pets where id=$1',[pet])).status).toBe('adopted');
    expect((await one('select status from public.adoption_applications where id=$1',[application])).status).toBe('completed');
    expect((await one('select count(*)::int as n from public.application_reviews where application_id=$1',[application])).n).toBe(3);
  });
  it('saves assessment answers and calculated results together, private to the adopter',async()=>{
    await db.query("select public.save_assessment($1,'{\"activity\":3}',$2::jsonb)",[owner,JSON.stringify([{pet_id:pet,score:70,confidence:60,excluded:false,reasons:['Recorded observation'],challenges:['Unknown care needs'],factors:[]}])]);
    expect((await asUser(db,owner,tx=>tx.query('select * from public.personality_answers'))).rows).toHaveLength(1);
    expect((await asUser(db,outsider,tx=>tx.query('select * from public.matching_results'))).rows).toHaveLength(0);
  });
});

describe('rescue and transport',()=>{
  it('persists verified rescue progress, assignments, outcomes and notifications',async()=>{
    const report={animal_type:'dog',animal_count:1,description:'Animal observed near the crossing',condition:'injured',observed_at:new Date().toISOString(),province:'Bulacan',city:'Malolos',barangay:'Test',latitude:14.84,longitude:120.81,address:'Test crossing'};
    const saved=(await one("select to_jsonb(public.submit_stray_report($1,$2::jsonb,'{}')) as data",[owner,JSON.stringify(report)])).data;
    expect(saved.coverage_status).toBe('within_coverage');
    for(const status of ['under_verification','verified']) await db.query('select public.transition_rescue($1,$2,$3,null)',[staff,saved.id,status]);
    await db.query('select public.assign_rescue($1,$2,$3,null)',[staff,saved.id,rescuer]);
    await expect(db.query("select public.transition_rescue($1,$2,'in_progress',null)",[outsider,saved.id])).rejects.toThrow(/Forbidden/);
    await db.query("select public.transition_rescue($1,$2,'in_progress','On the way')",[rescuer,saved.id]);
    await expect(db.query("select public.transition_rescue($1,$2,'resolved',null)",[rescuer,saved.id])).rejects.toThrow(/outcome notes/);
    await db.query("select public.transition_rescue($1,$2,'resolved','Animal safely brought to the shelter')",[rescuer,saved.id]);
    expect((await asUser(db,owner,tx=>tx.query('select * from public.rescue_outcomes'))).rows).toHaveLength(1);
    expect((await asUser(db,outsider,tx=>tx.query('select * from public.stray_reports'))).rows).toHaveLength(0);
    expect((await one('select count(*)::int as n from public.notifications where user_id=$1 and entity_id=$2',[owner,saved.id])).n).toBe(5);
  });
  it('never treats a demo-labelled zone as an approved real service boundary',async()=>{
    await db.query("update public.service_zones set name='Demo rescue zone' where service_type='rescue'");
    const coverage=(await one("select public.check_service_eligibility('rescue',120.81,14.84) as data")).data;
    expect(coverage.eligible).toBe(false);
  });
  it('requires quotation acceptance, a verified driver, and physical handover to finish a transport',async()=>{
    const saved=await one("insert into public.transport_requests(user_id,pet_details,pickup_address,dropoff_address,pickup_latitude,pickup_longitude,dropoff_latitude,dropoff_longitude,preferred_schedule,contact_phone) values($1,'Test dog in carrier','Shelter pickup','Customer destination',14.84,120.81,14.85,120.82,now()+interval '2 days','test contact') returning id",[owner]);
    await db.query("select public.transition_transport($1,$2,'under_review')",[staff,saved.id]);
    await db.query("select public.create_transport_quote($1,$2,0,'{}',now()+interval '1 day')",[staff,saved.id]);
    await expect(db.query("select public.transition_transport($1,$2,'confirmed')",[outsider,saved.id])).rejects.toThrow(/not permitted/);
    await db.query("select public.transition_transport($1,$2,'confirmed')",[owner,saved.id]);
    await db.query("select public.schedule_transport($1,$2,$3,$4,now()+interval '3 days')",[staff,saved.id,driver,vehicle]);
    expect((await one('select confirmed_schedule>preferred_schedule as changed from public.transport_requests where id=$1',[saved.id])).changed).toBe(true);
    for(const status of ['picked_up','in_transit','arrived'])await db.query('select public.transition_transport($1,$2,$3)',[driver,saved.id,status]);
    await expect(db.query("select public.transition_transport($1,$2,'completed')",[staff,saved.id])).rejects.toThrow(/handover/);
    await db.query("select public.confirm_transport_handover($1,$2,'Recipient','Animal received safely')",[owner,saved.id]);
    await db.query("select public.transition_transport($1,$2,'completed')",[staff,saved.id]);
    expect((await one('select status from public.transport_requests where id=$1',[saved.id])).status).toBe('completed');
  });
  it('keeps alternative arrangements pending for manual staff review',async()=>{
    const record=await one("insert into public.alternative_transport_requests(user_id,arrangement_type,details) values($1,'customer_arranged','Customer proposes a qualified carrier') returning *",[owner]);
    expect(record.status).toBe('submitted');expect(record.reviewed_by).toBeNull();
    await expect(db.query("select public.transition_alternative_transport($1,$2,'approved','Looks good')",[owner,record.id])).rejects.toThrow();
  });
});

describe('trusted security events and approvals',()=>{
  it('creates no fabricated alerts, then flags five actual recorded denials',async()=>{
    expect((await one('select count(*)::int as n from public.security_alerts')).n).toBe(0);
    for(let i=0;i<4;i++)await db.query("select public.record_authorization_denial($1,'GET /api/admin/users')",[outsider]);
    expect((await one('select count(*)::int as n from public.security_alerts')).n).toBe(0);
    await db.query("select public.record_authorization_denial($1,'GET /api/admin/users')",[outsider]);
    const alert=await one('select * from public.security_alerts');expect(alert.event_count).toBe(5);
    for(const user of [owner,outsider,admin,staff])expect((await asUser(db,user,tx=>tx.query('select * from public.security_events'))).rows).toHaveLength(0);
    expect((await asUser(db,superAdmin,tx=>tx.query('select * from public.security_events'))).rows).toHaveLength(5);
    await expect(db.query("select public.resolve_security_alert($1,$2,'Reviewed event history')",[admin,alert.id])).rejects.toThrow(/Super administrator/);
    await db.query("select public.resolve_security_alert($1,$2,'Reviewed event history and contacted account owner')",[superAdmin,alert.id]);
    expect((await one('select status from public.security_alerts where id=$1',[alert.id])).status).toBe('resolved');
  });
  it('requires an independent super administrator for a critical role approval',async()=>{
    await expect(db.query("select public.assign_user_role($1,$2,'super_administrator',true)",[admin,owner])).rejects.toThrow(/Super administrator/);
    const approval=await one("insert into public.critical_approvals(requested_by,user_id,role_name,enabled,reason) values($1,$2,'administrator',true,'Needs delegated operational oversight') returning id",[superAdmin,outsider]);
    await expect(db.query('select public.decide_critical_approval($1,$2,true)',[superAdmin,approval.id])).rejects.toThrow(/different super administrator/);
    await db.query('select public.decide_critical_approval($1,$2,true)',[secondSuper,approval.id]);
    expect((await one("select count(*)::int as n from public.user_roles where user_id=$1 and role_name='administrator'",[outsider])).n).toBe(1);
    await expect(db.query('select public.decide_critical_approval($1,$2,true)',[secondSuper,approval.id])).rejects.toThrow(/not pending/);
    const metrics=(await one('select public.security_metrics($1) as data',[superAdmin])).data;
    expect(metrics.registered_users).toBe(8);expect(metrics.authorization_denials).toBe(5);expect(metrics.resolved_alerts).toBe(1);
  });
});
