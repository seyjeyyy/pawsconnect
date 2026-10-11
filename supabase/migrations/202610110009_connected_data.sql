-- Additive only: no existing operational records are deleted or reclassified.
alter table public.products add column available_quantity integer generated always as (stock_quantity-reserved_quantity) stored;
insert into public.roles values ('super_administrator','Platform security and critical access approvals');
create or replace function public.has_role(p_user_id uuid,p_roles text[])
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.user_roles where user_id=p_user_id and
    (role_name=any(p_roles) or (role_name='super_administrator' and 'administrator'=any(p_roles))));
$$;

-- All writes to operational tables go through the validating, audited API.
-- Direct staff writes previously bypassed inventory and adoption workflow guards.
revoke insert,update,delete on public.products,public.product_categories,public.product_images,
 public.product_variants,public.pets,public.pet_photos,public.pet_behavior_profiles,
 public.shelter_vehicles,public.coupons,public.service_zones,public.zone_rules,public.cart_items from authenticated;
drop policy product_public_read on public.products;
create policy product_public_read on public.products for select using((is_published and not is_sample) or public.is_staff());
drop policy pet_public_read on public.pets;
create policy pet_public_read on public.pets for select using((is_published and not is_sample and status in ('available','reserved','adopted')) or public.is_staff() or public.has_role(auth.uid(),array['veterinarian']));
-- Verification identities and internal behaviour notes are not public.
revoke select on public.pet_behavior_profiles from anon,authenticated;
grant select(pet_id,energy_level,temperament,suitable_homes,good_with_children,good_with_dogs,good_with_cats,care_hours_daily,max_hours_alone,experience_required,grooming_level,exercise_minutes,needs_outdoor_space,verified_at) on public.pet_behavior_profiles to anon,authenticated;

create table public.favorite_pets (
 user_id uuid not null references public.profiles on delete cascade,
 pet_id uuid not null references public.pets on delete cascade,
 created_at timestamptz not null default now(), primary key(user_id,pet_id)
);
alter table public.favorite_pets enable row level security;
grant select on public.favorite_pets to authenticated;
grant all on public.favorite_pets to service_role;
create policy favorite_owner on public.favorite_pets for select to authenticated using(user_id=auth.uid());

alter table public.contact_messages add column reply text;
alter table public.contact_messages add column replied_at timestamptz;
alter table public.contact_messages add column replied_by uuid references public.profiles;
alter table public.notifications add column entity_type text;
alter table public.notifications add column entity_id uuid;

create table public.security_events (
 id uuid primary key default gen_random_uuid(), actor_id uuid not null references public.profiles,
 event_type text not null check(event_type='authorization_denied'), route text not null,
 created_at timestamptz not null default now()
);
create index security_event_actor_idx on public.security_events(actor_id,created_at desc);
create table public.security_alerts (
 id uuid primary key default gen_random_uuid(), actor_id uuid not null references public.profiles,
 rule text not null check(rule='repeated_authorization_denials'), event_id uuid not null references public.security_events,
 event_count integer not null check(event_count>=5), status text not null default 'open' check(status in ('open','resolved')),
 resolution_notes text, resolved_by uuid references public.profiles, resolved_at timestamptz,
 created_at timestamptz not null default now()
);
create unique index security_alert_open_idx on public.security_alerts(actor_id,rule) where status='open';
create table public.critical_approvals (
 id uuid primary key default gen_random_uuid(), requested_by uuid not null references public.profiles,
 user_id uuid not null references public.profiles, role_name text not null references public.roles,
 enabled boolean not null, reason text not null check(length(trim(reason))>=10),
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 decided_by uuid references public.profiles, decided_at timestamptz, created_at timestamptz not null default now(),
 check(role_name in ('administrator','super_administrator'))
);
create unique index critical_pending_idx on public.critical_approvals(user_id,role_name) where status='pending';
do $$ declare t text; begin
 foreach t in array array['security_events','security_alerts','critical_approvals'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to service_role',t);
  execute format('create policy super_read on public.%I for select to authenticated using(public.has_role(auth.uid(),array[''super_administrator'']))',t);
 end loop;
end $$;

create function public.record_authorization_denial(p_actor_id uuid,p_route text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_count integer; begin
 perform pg_advisory_xact_lock(hashtext(p_actor_id::text));
 insert into public.security_events(actor_id,event_type,route) values(p_actor_id,'authorization_denied',left(p_route,200)) returning id into v_id;
 select count(*) into v_count from public.security_events where actor_id=p_actor_id and created_at>=now()-interval '10 minutes';
 if v_count>=5 then
  insert into public.security_alerts(actor_id,rule,event_id,event_count) values(p_actor_id,'repeated_authorization_denials',v_id,v_count)
   on conflict(actor_id,rule) where status='open' do update set event_count=excluded.event_count,event_id=excluded.event_id;
 end if;
end $$;

create or replace function public.assign_user_role(p_actor_id uuid,p_user_id uuid,p_role_name text,p_enabled boolean)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not public.has_role(p_actor_id,array['administrator']) then raise exception 'Administrator role required' using errcode='42501'; end if;
 -- Serialize elevated membership changes, including last-administrator checks.
 perform pg_advisory_xact_lock(hashtext('pawsconnect-role-administration'));
 if (p_role_name='super_administrator' or exists(select 1 from public.user_roles where user_id=p_user_id and role_name='super_administrator'))
    and not public.has_role(p_actor_id,array['super_administrator']) then raise exception 'Super administrator required' using errcode='42501'; end if;
 if not p_enabled and p_role_name in ('administrator','super_administrator') then
  if p_actor_id=p_user_id then raise exception 'Cannot remove your own administrator role'; end if;
  if (select count(*) from public.user_roles where role_name=p_role_name)<=1 then raise exception 'Cannot remove the last administrator of this level'; end if;
 end if;
 if p_enabled then insert into public.user_roles(user_id,role_name,assigned_by) values(p_user_id,p_role_name,p_actor_id) on conflict do nothing;
 else delete from public.user_roles where user_id=p_user_id and role_name=p_role_name; end if;
 insert into public.audit_logs(actor_id,action,entity_type,entity_id,details) values(p_actor_id,'role.changed','profile',p_user_id,jsonb_build_object('role',p_role_name,'enabled',p_enabled));
 insert into public.notifications(user_id,title,body,link,entity_type,entity_id) values(p_user_id,'Account permissions updated','An administrator updated your account permissions.','/account/settings','profiles',p_user_id);
end $$;

create function public.decide_critical_approval(p_actor_id uuid,p_request_id uuid,p_approve boolean)
returns public.critical_approvals language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.critical_approvals; begin
 if not public.has_role(p_actor_id,array['super_administrator']) then raise exception 'Super administrator required' using errcode='42501'; end if;
 select * into v from public.critical_approvals where id=p_request_id for update;
 if not found or v.status<>'pending' then raise exception 'Request is not pending'; end if;
 if v.requested_by=p_actor_id or v.user_id=p_actor_id then raise exception 'A different super administrator must review this request'; end if;
 if p_approve then perform public.assign_user_role(p_actor_id,v.user_id,v.role_name,v.enabled); end if;
 update public.critical_approvals set status=case when p_approve then 'approved' else 'rejected' end,decided_by=p_actor_id,decided_at=now() where id=v.id returning * into v;
 insert into public.audit_logs(actor_id,action,entity_type,entity_id) values(p_actor_id,'critical_approval.'||v.status,'critical_approvals',v.id);
 return v;
end $$;

create function public.set_cart_item(p_actor_id uuid,p_product_id uuid,p_variant_id uuid,p_quantity integer)
returns public.cart_items language plpgsql security definer set search_path=public,pg_temp as $$
declare v_cart uuid; v_product public.products; v_item public.cart_items; v_available integer; begin
 if p_quantity not between 1 and 99 then raise exception 'Quantity must be between 1 and 99'; end if;
 select id into v_cart from public.carts where user_id=p_actor_id for update;
 if not found then raise exception 'Cart not found' using errcode='42501'; end if;
 select * into v_product from public.products where id=p_product_id and is_published and not is_sample;
 if not found then raise exception 'Product unavailable'; end if;
 if p_variant_id is not null then
  select stock_quantity-reserved_quantity into v_available from public.product_variants where id=p_variant_id and product_id=p_product_id and is_active;
  if not found then raise exception 'Variant unavailable'; end if;
 else
  if exists(select 1 from public.product_variants where product_id=p_product_id and is_active) then raise exception 'Choose a product variant'; end if;
  v_available:=v_product.stock_quantity-v_product.reserved_quantity;
 end if;
 if v_available<p_quantity then raise exception 'Not enough stock available'; end if;
 insert into public.cart_items(cart_id,product_id,variant_id,quantity) values(v_cart,p_product_id,p_variant_id,p_quantity)
 on conflict(cart_id,product_id,(coalesce(variant_id,'00000000-0000-0000-0000-000000000000'::uuid))) do update set quantity=excluded.quantity returning * into v_item;
 return v_item;
end $$;

create function public.account_metrics(p_actor_id uuid)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object('orders',(select count(*) from public.orders where user_id=p_actor_id),
 'applications',(select count(*) from public.adoption_applications where user_id=p_actor_id),
 'reports',(select count(*) from public.stray_reports where user_id=p_actor_id),
 'updates',(select count(*) from public.notifications where user_id=p_actor_id and read_at is null));
$$;

create function public.schedule_adoption_appointment(p_actor_id uuid,p_application_id uuid,p_scheduled_at timestamptz,p_location text,p_notes text)
returns public.adoption_appointments language plpgsql security definer set search_path=public,pg_temp as $$
declare v_app public.adoption_applications; v public.adoption_appointments; begin
 if not public.has_role(p_actor_id,array['administrator','shelter_staff']) then raise exception 'Staff required' using errcode='42501'; end if;
 select * into v_app from public.adoption_applications where id=p_application_id for update;
 if not found or v_app.status not in ('under_review','interview','information_requested','approved') then raise exception 'Application is not eligible for an appointment'; end if;
 if p_scheduled_at<=now() or length(trim(p_location))<5 then raise exception 'Provide a future schedule and meeting location'; end if;
 insert into public.adoption_appointments(application_id,scheduled_at,location,notes) values(p_application_id,p_scheduled_at,p_location,p_notes) returning * into v;
 insert into public.audit_logs(actor_id,action,entity_type,entity_id) values(p_actor_id,'appointment.created','adoption_appointments',v.id);
 insert into public.notifications(user_id,title,body,link,entity_type,entity_id) values(v_app.user_id,'Adoption appointment scheduled','See your application for the confirmed date and meeting location.','/account/applications','adoption_appointments',v.id);
 return v;
end $$;

create function public.reply_to_contact(p_actor_id uuid,p_message_id uuid,p_reply text)
returns public.contact_messages language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.contact_messages; begin
 if not public.has_role(p_actor_id,array['administrator','shelter_staff']) then raise exception 'Staff required' using errcode='42501'; end if;
 if length(trim(p_reply)) not between 5 and 5000 then raise exception 'Provide a reply of 5 to 5000 characters'; end if;
 update public.contact_messages set reply=p_reply,replied_at=now(),replied_by=p_actor_id,status='replied' where id=p_message_id returning * into v;
 if not found then raise exception 'Message not found'; end if;
 insert into public.audit_logs(actor_id,action,entity_type,entity_id) values(p_actor_id,'contact.replied','contact_messages',v.id);
 if v.user_id is not null then insert into public.notifications(user_id,title,body,link,entity_type,entity_id) values(v.user_id,'The shelter replied','View your support inquiry for the reply.','/account/messages','contact_messages',v.id); end if;
 return v;
end $$;

create function public.request_refund(p_actor_id uuid,p_payment_id uuid,p_reason text)
returns public.refunds language plpgsql security definer set search_path=public,pg_temp as $$
declare v_pay public.payment_transactions; v public.refunds; begin
 select * into v_pay from public.payment_transactions where id=p_payment_id and user_id=p_actor_id for update;
 if not found then raise exception 'Payment not found' using errcode='42501'; end if;
 if v_pay.status<>'paid' then raise exception 'Only verified payments can be reviewed for a refund'; end if;
 if length(trim(p_reason)) not between 10 and 2000 then raise exception 'Explain the reason for your request'; end if;
 if exists(select 1 from public.refunds where payment_transaction_id=v_pay.id and status in ('pending','succeeded')) then raise exception 'A refund is already pending or completed'; end if;
 insert into public.refunds(payment_transaction_id,amount_centavos,reason,requested_by) values(v_pay.id,v_pay.amount_centavos,p_reason,p_actor_id) returning * into v;
 insert into public.audit_logs(actor_id,action,entity_type,entity_id) values(p_actor_id,'refund.requested','refunds',v.id);
 return v;
end $$;

-- Events come from real inserts and transitions, committed in the same transaction.
create function public.notify_operational_change()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v jsonb:=to_jsonb(new); v_owner uuid; v_id uuid; v_section text:=tg_argv[0]; begin
 v_id:=coalesce(v->>'id',v->>'user_id')::uuid;
 v_owner:=coalesce(v->>'user_id',v->>'volunteer_id')::uuid;
 if tg_op='INSERT' then
  insert into public.notifications(user_id,title,body,link,entity_type,entity_id)
   select distinct user_id,'New '||replace(v_section,'_',' ')||' record','A new record is awaiting shelter review.','/admin/'||v_section,tg_table_name,v_id
   from public.user_roles where role_name in ('administrator','shelter_staff','super_administrator');
 elsif v->>'status' is distinct from to_jsonb(old)->>'status' and v_owner is not null then
  insert into public.notifications(user_id,title,body,link,entity_type,entity_id) values(v_owner,'Shelter update','Status changed to '||replace(v->>'status','_',' ')||'.',
    '/account/'||case v_section when 'rescue' then 'reports' when 'volunteers' then 'volunteer' else v_section end,tg_table_name,v_id);
 end if;
 return new;
end $$;
create trigger adoption_submitted after insert on public.adoption_applications for each row execute function public.notify_operational_change('adoptions');
create trigger order_submitted after insert on public.orders for each row execute function public.notify_operational_change('orders');
create trigger rescue_changes after insert or update of status on public.stray_reports for each row execute function public.notify_operational_change('rescue');
create trigger transport_changes after insert or update of status on public.transport_requests for each row execute function public.notify_operational_change('transport');
create trigger alternative_changes after insert or update of status on public.alternative_transport_requests for each row execute function public.notify_operational_change('alternatives');
create trigger volunteer_changes after insert or update of status on public.volunteer_profiles for each row execute function public.notify_operational_change('volunteers');
create trigger donation_changes after insert or update of status on public.donations for each row execute function public.notify_operational_change('donations');
create trigger contact_submitted after insert on public.contact_messages for each row execute function public.notify_operational_change('contact_messages');

-- Publish notifications only. They contain no addresses, payment details, or private documents.
-- Authorized notifications invalidate API queries; polling covers every other change and missed event.
-- Existing publication entries from migration 2 are kept for compatibility.
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='notifications') then
  alter publication supabase_realtime add table public.notifications;
 end if;
end $$;

revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on function public.has_role(uuid,text[]),public.is_staff(),public.is_admin(),public.can_read_report(uuid),public.can_read_transport(uuid) to anon,authenticated,service_role;
grant execute on all functions in schema public to service_role;
