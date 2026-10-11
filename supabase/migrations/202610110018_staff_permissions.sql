-- Additive account simplification. Legacy memberships remain compatibility assignments.
-- No identity, transaction, assignment or role row is removed.
-- Store exact pre-upgrade definitions for a guarded, pre-use rollback.
create table public.permission_rollout_backup (kind text not null, name text not null, definition text not null, primary key(kind,name));
alter table public.permission_rollout_backup enable row level security;
revoke all on public.permission_rollout_backup from public,anon,authenticated;
grant all on public.permission_rollout_backup to service_role;
insert into public.permission_rollout_backup
select 'function',p.oid::regprocedure::text,pg_get_functiondef(p.oid)
from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
('can_read_report','can_read_transport','transition_order','adjust_inventory','transition_adoption','reserve_pet','finalize_adoption','schedule_adoption_appointment','transition_rescue','assign_rescue','transition_transport','create_transport_quote','schedule_transport','confirm_transport_handover','transition_alternative_transport','admin_metrics','reply_to_contact','upsert_service_zone');
insert into public.permission_rollout_backup
select 'policy',schemaname||'.'||tablename||'.'||policyname,
 format('alter policy %I on %I.%I%s%s',policyname,schemaname,tablename,
 case when qual is not null then ' using ('||qual||')' else '' end,
 case when with_check is not null then ' with check ('||with_check||')' else '' end)
from pg_policies where schemaname in ('public','storage');
create table public.staff_access (
  user_id uuid primary key references public.profiles(id),
  permissions text[] not null default '{}',
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
update public.operations_config set schema_version='018' where id;
alter table public.staff_access enable row level security;
revoke all on public.staff_access from public,anon,authenticated;
grant select on public.staff_access to authenticated;
grant all on public.staff_access to service_role;
create policy staff_access_read on public.staff_access for select to authenticated
  using(public.current_session_allowed() and (user_id=auth.uid() or public.is_system_admin()));

create function public.legacy_permissions(p_user_id uuid) returns text[]
language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(array_agg(distinct permission order by permission),'{}'::text[])
  from public.user_roles r cross join lateral unnest(case r.role_name
    when 'administrator' then array['animals.view','animals.manage','animals.health','adoptions.review','adoptions.decide','rescue.manage','transport.manage','store.manage','donations.view','donations.manage','finance.manage','volunteers.manage','reports.export','contacts.manage','zones.view','zones.manage']
    when 'shelter_staff' then array['animals.view','animals.manage','animals.health','adoptions.review','rescue.manage','transport.manage','store.manage','donations.view','donations.manage','finance.manage','volunteers.manage','reports.export','contacts.manage','zones.view']
    when 'veterinarian' then array['animals.view','animals.health']
    when 'rescue_personnel' then array['rescue.assigned']
    when 'shelter_driver' then array['transport.assigned']
    when 'volunteer' then array['rescue.assigned']
    else '{}'::text[] end) permission where r.user_id=p_user_id;
$$;
create function public.account_permissions(p_user_id uuid) returns text[]
language sql stable security definer set search_path=public,pg_temp as $$
  -- Intersection means removing a legacy authority cannot leave a stale grant behind.
  select coalesce(array_agg(p order by p),'{}'::text[]) from unnest(public.legacy_permissions(p_user_id)) p
  where not exists(select 1 from public.staff_access where user_id=p_user_id)
     or p=any((select permissions from public.staff_access where user_id=p_user_id)::text[])
     -- Volunteer approval is a User capability independent of prior staff grants.
     or (p='rescue.assigned' and exists(select 1 from public.volunteer_profiles where user_id=p_user_id and status='approved'));
$$;
create function public.has_permission(p_user_id uuid,p_permission text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select case when current_setting('role',true) in ('anon','authenticated') and p_user_id is distinct from auth.uid()
    then false else p_permission=any(public.account_permissions(p_user_id)) end;
$$;
-- A snapshot makes each existing staff member's initial module assignments explicit.
insert into public.staff_access(user_id,permissions)
select distinct user_id,public.legacy_permissions(user_id) from public.user_roles
where role_name in ('administrator','shelter_staff','veterinarian','rescue_personnel','shelter_driver');

create function public.set_staff_access(p_actor_id uuid,p_user_id uuid,p_permissions text[]) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare previous text[]; begin
  if not public.has_role(p_actor_id,array['super_administrator']) then raise exception 'System administrator required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtext('pawsconnect-role-administration'));
  if p_actor_id=p_user_id then raise exception 'Cannot change your own staff access' using errcode='42501'; end if;
  if p_permissions is null or array_length(p_permissions,1)>30 then raise exception 'Invalid permission list' using errcode='22023'; end if;
  -- A new Staff account uses the ordinary operational compatibility assignment.
  -- Elevated decision/zone rights still require the existing two-person approval.
  if not public.has_role(p_user_id,array['administrator','shelter_staff','veterinarian','rescue_personnel','shelter_driver']) then
    if public.has_role(p_user_id,array['super_administrator']) then raise exception 'Keep system and shelter accounts separate' using errcode='42501'; end if;
    insert into public.user_roles(user_id,role_name,assigned_by) values(p_user_id,'shelter_staff',p_actor_id);
  end if;
  if not p_permissions <@ public.legacy_permissions(p_user_id) then raise exception 'Permission exceeds approved operational assignment' using errcode='42501'; end if;
  select permissions into previous from public.staff_access where user_id=p_user_id for update;
  insert into public.staff_access(user_id,permissions,updated_by) values(p_user_id,p_permissions,p_actor_id)
  on conflict(user_id) do update set permissions=excluded.permissions,updated_by=p_actor_id,updated_at=now();
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details)
    values(p_actor_id,'staff.permissions_changed','profiles',p_user_id,jsonb_build_object('before',previous,'after',p_permissions));
  insert into public.notifications(user_id,title,body,link,entity_type,entity_id)
    values(p_user_id,'Account permissions updated','Your staff module assignments have changed.','/account/settings','profiles',p_user_id);
end $$;

-- Tighten all existing direct-read policies at their staff branches. Owner/public
-- branches stay intact. Do not turn system administration into shelter authority.
do $$ declare r record; permission text; expr text; check_expr text; begin
  for r in select * from pg_policies where schemaname='public' and (qual like '%is_staff()%' or qual like '%is_admin()%') loop
    permission := case
      when r.tablename in ('products','product_categories','product_images','product_variants','orders','order_items','shipments','inventory_movements','coupons','customer_reviews') then 'store.manage'
      when r.tablename in ('pets','pet_photos','pet_behavior_profiles','shelter_intakes') then 'animals.view'
      when r.tablename='pet_health_records' then 'animals.health'
      when r.tablename in ('adoption_applications','application_reviews','adoption_appointments','pet_reservations','completed_adoptions','personality_assessments','personality_answers','matching_results','adopter_profiles') then 'adoptions.review'
      when r.tablename in ('rescue_assignments') then 'rescue.manage'
      when r.tablename in ('shelter_vehicles','shelter_drivers','alternative_transport_requests') then 'transport.manage'
      when r.tablename in ('volunteer_profiles','volunteer_tasks') then 'volunteers.manage'
      when r.tablename='donations' then 'donations.view'
      when r.tablename in ('payment_transactions','refunds','expenses','payment_webhook_events') then 'finance.manage'
      when r.tablename in ('service_zones','zone_rules') then 'zones.view'
      when r.tablename in ('contact_messages','newsletter_subscriptions','email_outbox') then 'contacts.manage'
      when r.tablename in ('customer_addresses','buyer_profiles') then 'store.manage'
      when r.tablename='profiles' then 'adoptions.review'
      else null end;
    if permission is not null then
      expr := replace(replace(r.qual,'is_staff()',format('(is_staff() AND has_permission(auth.uid(), %L))',permission)), 'is_admin()',format('(is_admin() AND has_permission(auth.uid(), %L))',permission));
      execute format('alter policy %I on public.%I using (%s)',r.policyname,r.tablename,expr);
    end if;
  end loop;
end $$;
create or replace function public.can_read_report(p_report_id uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select (public.is_staff() and public.has_permission(auth.uid(),'rescue.manage'))
 or exists(select 1 from public.stray_reports where id=p_report_id and user_id=auth.uid())
 or (public.has_permission(auth.uid(),'rescue.assigned') and exists(select 1 from public.rescue_assignments where report_id=p_report_id and assigned_to=auth.uid() and status in ('assigned','in_progress','completed')));
$$;
create or replace function public.can_read_transport(p_request_id uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select (public.is_staff() and public.has_permission(auth.uid(),'transport.manage'))
 or exists(select 1 from public.transport_requests where id=p_request_id and (user_id=auth.uid() or (driver_id=auth.uid() and public.has_permission(auth.uid(),'transport.assigned'))));
$$;
-- Preserve each transaction body and signature, adding a permission check before
-- its original role/ownership/state/locking checks. Fail migration on missing functions.
do $$ declare item record; f record; definition text; guard text; begin
 for item in select * from (values
 ('transition_order','store.manage',null),('adjust_inventory','store.manage',null),
 ('transition_adoption','adoptions.review',null),('reserve_pet','adoptions.review',null),('finalize_adoption','adoptions.review',null),('schedule_adoption_appointment','adoptions.review',null),
 ('transition_rescue','rescue.manage','rescue.assigned'),('assign_rescue','rescue.manage',null),
 ('transition_transport','transport.manage','transport.assigned'),('create_transport_quote','transport.manage',null),('schedule_transport','transport.manage',null),('confirm_transport_handover','transport.manage',null),('transition_alternative_transport','transport.manage',null),
 ('admin_metrics','finance.manage',null),('reply_to_contact','contacts.manage',null),('upsert_service_zone','zones.manage',null)
 ) as checks(name,permission,alternative) loop
  select p.oid,p.prosrc into strict f from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=item.name;
  definition:=pg_get_functiondef(f.oid);
  guard:=format('(public.has_permission(p_actor_id,%L)%s)',item.permission,case when item.alternative is null then '' else format(' OR public.has_permission(p_actor_id,%L)',item.alternative) end);
  definition:=regexp_replace(definition,'(public\.has_role\(p_actor_id,\s*array\[[^]]+\]\))','(\1 AND '||guard||')','g');
  if item.name='transition_transport' then
    definition:=replace(definition,'elsif p_actor_id=v_request.driver_id then','elsif p_actor_id=v_request.driver_id and public.has_permission(p_actor_id,''transport.assigned'') then');
  end if;
  if item.name='transition_adoption' then
    definition:=replace(definition,'public.has_role(p_actor_id,array[''administrator''])','(public.has_role(p_actor_id,array[''administrator'']) AND public.has_permission(p_actor_id,''adoptions.decide''))');
  end if;
  if item.name='assign_rescue' then
    definition:=regexp_replace(definition,'(public\.has_role\(p_assignee_id,\s*array\[[^]]+\]\))','(\1 AND public.has_permission(p_assignee_id,''rescue.assigned''))','g');
  end if;
  if item.name in ('schedule_transport','transition_transport') then
    definition:=regexp_replace(definition,'(public\.has_role\(p_driver_id,\s*array\[[^]]+\]\))','(\1 AND public.has_permission(p_driver_id,''transport.assigned''))','g');
  end if;
  execute definition;
 end loop;
end $$;

-- Approved volunteer enrollment unlocks the existing assignment capability on
-- the same identity; deactivation closes it without deleting task history.
create function public.sync_volunteer_capability() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.status='approved' then insert into public.user_roles(user_id,role_name) values(new.user_id,'volunteer') on conflict do nothing;
 elsif old.status='approved' then delete from public.user_roles where user_id=new.user_id and role_name='volunteer'; end if;
 return new;
end $$;
create trigger volunteer_capability after update of status on public.volunteer_profiles for each row execute function public.sync_volunteer_capability();
insert into public.user_roles(user_id,role_name) select user_id,'volunteer' from public.volunteer_profiles where status='approved' on conflict do nothing;

-- Actual owner/order and assignment predicates used by current endpoints.
create index if not exists orders_owner_created_id on public.orders(user_id,created_at desc,id desc);
create index if not exists adoptions_owner_created_id on public.adoption_applications(user_id,created_at desc,id desc);
create index if not exists donations_owner_created_id on public.donations(user_id,created_at desc,id desc);
create index if not exists reports_owner_created_id on public.stray_reports(user_id,created_at desc,id desc);
create index if not exists transport_driver_created_id on public.transport_requests(driver_id,created_at desc,id desc);
create index if not exists rescue_assignee_status_report on public.rescue_assignments(assigned_to,status,report_id);
create index if not exists notifications_owner_created_id on public.notifications(user_id,created_at desc,id desc);
revoke execute on function public.legacy_permissions(uuid),public.account_permissions(uuid),public.has_permission(uuid,text),public.set_staff_access(uuid,uuid,text[]),public.sync_volunteer_capability() from public,anon,authenticated;
grant execute on function public.has_permission(uuid,text) to anon,authenticated;
grant execute on all functions in schema public to service_role;

create function public.workspace_overview(p_actor_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb:='{}'; begin
 if public.has_permission(p_actor_id,'animals.view') then result:=result||jsonb_build_object('animals_in_care',(select count(*) from public.pets where status<>'adopted' and not is_sample)); end if;
 if public.has_permission(p_actor_id,'adoptions.review') then result:=result||jsonb_build_object('pending_adoptions',(select count(*) from public.adoption_applications where status in ('submitted','under_review','information_requested','interview'))); end if;
 if public.has_permission(p_actor_id,'rescue.manage') then result:=result||jsonb_build_object('active_rescues',(select count(*) from public.stray_reports where status in ('verified','assigned','in_progress'))); end if;
 if public.has_permission(p_actor_id,'transport.manage') then result:=result||jsonb_build_object('transport_to_review',(select count(*) from public.transport_requests where status in ('submitted','under_review'))); end if;
 if public.has_permission(p_actor_id,'store.manage') then result:=result||jsonb_build_object('orders_to_process',(select count(*) from public.orders where status in ('paid','processing'))); end if;
 if public.has_permission(p_actor_id,'volunteers.manage') then result:=result||jsonb_build_object('volunteer_applications',(select count(*) from public.volunteer_profiles where status in ('submitted','under_review'))); end if;
 return result;
end $$;
revoke execute on function public.workspace_overview(uuid) from public,anon,authenticated;
grant execute on function public.workspace_overview(uuid) to service_role;

-- Medical staff retain only explicitly assigned care access.
drop policy health_staff_read on public.pet_health_records;
create policy health_staff_read on public.pet_health_records for select to authenticated using(public.has_permission(auth.uid(),'animals.health'));
drop policy pet_public_read on public.pets;
create policy pet_public_read on public.pets for select using((is_published and not is_sample and status in ('available','reserved','adopted')) or public.has_permission(auth.uid(),'animals.view'));
-- Storage direct access has the same module boundaries as signed URLs.
drop policy private_upload_read on storage.objects;
create policy private_upload_read on storage.objects for select to authenticated using(
 bucket_id in ('rescue-evidence','adoption-documents') and
 ((storage.foldername(name))[1]=auth.uid()::text or
 (bucket_id='rescue-evidence' and public.has_permission(auth.uid(),'rescue.manage')) or
 (bucket_id='adoption-documents' and public.has_permission(auth.uid(),'adoptions.review'))));
alter policy listing_images_staff_insert on storage.objects with check(bucket_id='listing-images' and (public.has_permission(auth.uid(),'animals.manage') or public.has_permission(auth.uid(),'store.manage')));
alter policy listing_images_staff_update on storage.objects using(bucket_id='listing-images' and (public.has_permission(auth.uid(),'animals.manage') or public.has_permission(auth.uid(),'store.manage'))) with check(bucket_id='listing-images' and (public.has_permission(auth.uid(),'animals.manage') or public.has_permission(auth.uid(),'store.manage')));
alter policy listing_images_staff_delete on storage.objects using(bucket_id='listing-images' and (public.has_permission(auth.uid(),'animals.manage') or public.has_permission(auth.uid(),'store.manage')));

create function public.workspace_people_lookup(p_actor_id uuid,p_kind text,p_search text)
returns table(id uuid,name text) language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if p_kind not in ('drivers','rescuers') or not public.has_permission(p_actor_id,case when p_kind='drivers' then 'transport.manage' else 'rescue.manage' end) then raise exception 'Module permission required' using errcode='42501'; end if;
 return query select p.id,p.full_name from public.profiles p
 where p.full_name ilike '%'||p_search||'%' and (
 (p_kind='drivers' and public.has_permission(p.id,'transport.assigned') and exists(select 1 from public.shelter_drivers d where d.user_id=p.id and d.is_active)) or
 (p_kind='rescuers' and public.has_permission(p.id,'rescue.assigned') and (public.has_role(p.id,array['rescue_personnel']) or exists(select 1 from public.volunteer_profiles v where v.user_id=p.id and v.status='approved'))))
 order by p.full_name,p.id limit 100;
end $$;
revoke execute on function public.workspace_people_lookup(uuid,text,text) from public,anon,authenticated;
grant execute on function public.workspace_people_lookup(uuid,text,text) to service_role;

create function public.authorize_workspace_export(p_actor_id uuid) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if not public.has_permission(p_actor_id,'reports.export') and not public.has_role(p_actor_id,array['super_administrator']) then raise exception 'Report export permission required' using errcode='42501'; end if;
 return true;
end $$;
revoke execute on function public.authorize_workspace_export(uuid) from public,anon,authenticated;
grant execute on function public.authorize_workspace_export(uuid) to service_role;
