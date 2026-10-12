-- Shelter transport from the official shelter. Additive: no existing booking's pickup,
-- destination, status or price changes. Requires migration 020 (shelter_locations).

-- ---------- What a booking records ----------
alter table public.transport_requests
  -- Shown to customers and staff instead of the row id.
  add column reference text not null default ('PT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  -- Set when the pickup was taken from the official shelter record. Null on bookings made before
  -- this migration, where the customer typed the pickup in; those keep the rules they were made under.
  add column shelter_location_id uuid references public.shelter_locations,
  -- A copy made when the booking was saved. Editing the shelter record later does not change it.
  add column pickup_name text,
  add column dropoff_street text, add column dropoff_barangay text, add column dropoff_city text, add column dropoff_province text,
  add column contact_name text, add column delivery_instructions text,
  add column pet_name text, add column pet_species text check(pet_species is null or pet_species in ('dog','cat','other')),
  add column pet_weight_kg numeric(5,1) check(pet_weight_kg is null or pet_weight_kg > 0), add column has_carrier boolean,
  -- From the routing service at the time of booking; never straight-line and never sent by the browser.
  add column route_distance_km numeric(7,1) check(route_distance_km is null or route_distance_km >= 0),
  add column route_duration_minutes integer check(route_duration_minutes is null or route_duration_minutes >= 0),
  add column route_geometry jsonb,
  -- What the customer was shown before staff quoted. The final price stays in fee_centavos, set by a staff quotation.
  add column estimate_breakdown jsonb,
  add column estimate_total_centavos bigint check(estimate_total_centavos is null or estimate_total_centavos >= 0);
alter table public.transport_requests add constraint transport_requests_reference_key unique(reference);
create index transport_requests_status_idx on public.transport_requests(status);
create index transport_requests_created_idx on public.transport_requests(created_at desc);
create index transport_requests_driver_idx on public.transport_requests(driver_id) where driver_id is not null;

-- A booking with no pickup gets the official shelter. (Pickup has always been required, so this
-- is expected to match nothing; bookings with a different saved pickup are deliberately left alone.)
update public.transport_requests t
set shelter_location_id=s.id, pickup_name=s.name, pickup_address=coalesce(s.formatted_address, s.name), pickup_latitude=s.latitude, pickup_longitude=s.longitude
from public.shelter_locations s
where s.code='PAWSCONNECT_MAIN_SHELTER' and trim(t.pickup_address)='';

-- ---------- Settings: delivery range and pricing ----------
-- One row. Every value starts empty: with no pricing there is no estimate, and with no
-- maximum distance the service zones alone decide coverage. Changed only through the API.
create table public.transport_settings (
  id boolean primary key default true check(id),
  max_distance_km numeric(6,1) check(max_distance_km is null or max_distance_km > 0),
  base_fee_centavos bigint check(base_fee_centavos is null or base_fee_centavos >= 0),
  rate_per_km_centavos bigint check(rate_per_km_centavos is null or rate_per_km_centavos >= 0),
  handling_fees jsonb not null default '{}',
  surcharges jsonb not null default '[]',
  updated_by uuid references public.profiles,
  updated_at timestamptz not null default now()
);
insert into public.transport_settings default values;
alter table public.transport_settings enable row level security;
revoke all on public.transport_settings from public, anon, authenticated;
grant all on public.transport_settings to service_role;
create policy active_app_session on public.transport_settings as restrictive for all to authenticated using(public.current_session_allowed()) with check(public.current_session_allowed());

-- ---------- Coverage: the destination decides ----------
-- A booking that starts at the official shelter is classified by its destination only, plus the
-- optional maximum driving distance. Older bookings, with a customer-entered pickup, keep the
-- both-ends rule. A new shelter booking outside the delivery area is refused here as well as in
-- the API; the Alternative request is the route for those, and it is always reviewed by staff.
create or replace function public.guard_transport_request()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_pickup jsonb; v_dropoff jsonb; v_max numeric; begin
  if tg_op='INSERT' and (new.status<>'submitted' or new.paid_at is not null or new.driver_id is not null or new.vehicle_id is not null) then raise exception 'New requests require staff review'; end if;
  if new.adoption_application_id is not null and not exists(select 1 from public.adoption_applications where id=new.adoption_application_id and user_id=new.user_id and (new.pet_id is null or pet_id=new.pet_id)) then raise exception 'Linked adoption application does not belong to customer'; end if;
  v_dropoff:=public.check_service_eligibility('transport',new.dropoff_longitude,new.dropoff_latitude);
  if new.shelter_location_id is not null then
    select max_distance_km into v_max from public.transport_settings where id;
    new.coverage_status:=case when v_dropoff->>'status'='within_coverage' and v_max is not null and new.route_distance_km is not null and new.route_distance_km>v_max then 'outside_coverage' else v_dropoff->>'status' end;
    if tg_op='INSERT' and new.coverage_status in ('outside_coverage','temporarily_unavailable') then raise exception 'This location is outside our delivery area'; end if;
    return new;
  end if;
  v_pickup:=public.check_service_eligibility('transport',new.pickup_longitude,new.pickup_latitude);
  new.coverage_status:=case when (v_pickup->>'eligible')::boolean and (v_dropoff->>'eligible')::boolean then 'within_coverage'
    when v_pickup->>'status'='outside_coverage' or v_dropoff->>'status'='outside_coverage' then 'outside_coverage'
    when v_pickup->>'status'='temporarily_unavailable' or v_dropoff->>'status'='temporarily_unavailable' then 'temporarily_unavailable'
    else 'manual_review_required' end;
  return new;
end $$;
drop trigger transport_request_guard on public.transport_requests;
create trigger transport_request_guard before insert or update of pickup_latitude,pickup_longitude,dropoff_latitude,dropoff_longitude,adoption_application_id,user_id,shelter_location_id,route_distance_km on public.transport_requests for each row execute function public.guard_transport_request();

-- Quoting and scheduling re-check coverage. For a shelter booking only the destination is
-- re-checked. The functions keep everything else, including the permission checks added by
-- migration 018, so the one condition is changed in place; a definition that no longer
-- contains it stops the migration instead of being silently skipped.
do $$ declare f record; definition text; changed text;
  v_old constant text := 'not (public.check_service_eligibility(''transport'',v_request.pickup_longitude,v_request.pickup_latitude)->>''eligible'')::boolean';
begin
  for f in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('transition_transport','create_transport_quote') loop
    definition:=pg_get_functiondef(f.oid);
    changed:=replace(definition, v_old, '(v_request.shelter_location_id is null and '||v_old||')');
    if changed=definition then raise exception 'Coverage check not found in %', f.proname; end if;
    execute changed;
  end loop;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('transition_transport','create_transport_quote'))<>2 then raise exception 'Expected transport functions are missing'; end if;
end $$;

-- The only way to change delivery range and pricing: an administrator holding the transport
-- module, with a reason, and with the before and after values written to the audit trail.
create function public.update_transport_settings(p_actor_id uuid, p_max_distance_km numeric, p_base_fee_centavos bigint, p_rate_per_km_centavos bigint, p_handling_fees jsonb, p_surcharges jsonb, p_reason text)
returns public.transport_settings language plpgsql security definer set search_path=public,pg_temp as $$
declare v_before public.transport_settings; v_after public.transport_settings; begin
  if not (public.has_role(p_actor_id, array['administrator']) and public.has_permission(p_actor_id, 'transport.manage')) then raise exception 'Administrator role required' using errcode='42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'A reason for the change is required'; end if;
  if jsonb_typeof(p_handling_fees) is distinct from 'object' or jsonb_typeof(p_surcharges) is distinct from 'array' then raise exception 'Invalid pricing settings'; end if;
  select * into v_before from public.transport_settings where id for update;
  update public.transport_settings set max_distance_km=p_max_distance_km, base_fee_centavos=p_base_fee_centavos, rate_per_km_centavos=p_rate_per_km_centavos,
    handling_fees=p_handling_fees, surcharges=p_surcharges, updated_by=p_actor_id, updated_at=now() where id returning * into v_after;
  insert into public.audit_logs(actor_id, action, entity_type, details)
  values(p_actor_id, 'transport_settings.updated', 'transport_settings', jsonb_build_object('reason', trim(p_reason),
    'before', to_jsonb(v_before) - 'id' - 'updated_by' - 'updated_at', 'after', to_jsonb(v_after) - 'id' - 'updated_by' - 'updated_at'));
  return v_after;
end $$;
revoke execute on function public.update_transport_settings(uuid, numeric, bigint, bigint, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.update_transport_settings(uuid, numeric, bigint, bigint, jsonb, jsonb, text) to service_role;

-- ---------- Staff notes ----------
-- Written and read through the API by shelter staff only. Never shown to the customer or the
-- driver, which is why they are not tracking events (those are visible to both).
create table public.transport_internal_notes (
  id uuid primary key default gen_random_uuid(),
  transport_request_id uuid not null references public.transport_requests,
  author_id uuid not null references public.profiles,
  note text not null check(length(trim(note)) between 2 and 2000),
  created_at timestamptz not null default now()
);
create index transport_internal_notes_request_idx on public.transport_internal_notes(transport_request_id, created_at);
alter table public.transport_internal_notes enable row level security;
revoke all on public.transport_internal_notes from public, anon, authenticated;
grant all on public.transport_internal_notes to service_role;
create policy active_app_session on public.transport_internal_notes as restrictive for all to authenticated using(public.current_session_allowed()) with check(public.current_session_allowed());

-- Scheduling records who was assigned, not only that the status changed.
create or replace function public.schedule_transport(p_actor_id uuid,p_request_id uuid,p_driver_id uuid,p_vehicle_id uuid,p_schedule timestamptz)
returns public.transport_requests language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.transport_requests; begin
 if p_schedule<=now() then raise exception 'Choose a future schedule'; end if;
 select * into v from public.transition_transport(p_actor_id,p_request_id,'scheduled',null,p_driver_id,p_vehicle_id);
 update public.transport_requests set confirmed_schedule=p_schedule where id=p_request_id returning * into v;
 insert into public.audit_logs(actor_id,action,entity_type,entity_id,details) values(p_actor_id,'transport.assigned','transport_request',p_request_id,jsonb_build_object('driver_id',p_driver_id,'vehicle_id',p_vehicle_id,'confirmed_schedule',p_schedule));
 return v;
end $$;
notify pgrst, 'reload schema';
