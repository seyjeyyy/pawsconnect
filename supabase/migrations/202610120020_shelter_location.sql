-- The official shelter location: one record that every shelter-operated service
-- reads its starting point from. Additive: no existing row changes.
-- Anyone may read it. It is written only through update_shelter_location, which
-- the API calls with the service role and which records every change in the audit trail.
create table public.shelter_locations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check(code ~ '^[A-Z0-9_]{3,60}$'),
  name text not null check(length(trim(name)) between 2 and 150),
  location_type text not null default 'SHELTER' check(location_type in ('SHELTER')),
  pickup_mode text not null default 'FIXED' check(pickup_mode in ('FIXED')),
  latitude double precision not null check(latitude between -90 and 90),
  longitude double precision not null check(longitude between -180 and 180),
  google_maps_url text check(google_maps_url is null or google_maps_url ~ '^https://'),
  -- Empty until an administrator confirms it. Never typed in by a migration.
  formatted_address text check(formatted_address is null or length(trim(formatted_address)) between 5 and 500),
  address_verified_at timestamptz,
  address_verified_by uuid references public.profiles,
  updated_by uuid references public.profiles,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check((formatted_address is null) = (address_verified_at is null))
);

insert into public.shelter_locations(code, name, location_type, pickup_mode, latitude, longitude, google_maps_url)
values('PAWSCONNECT_MAIN_SHELTER', 'PawsConnect Animal Shelter', 'SHELTER', 'FIXED', 15.017163, 120.948071, 'https://maps.app.goo.gl/e6hDczktzrXMntQr9');

alter table public.shelter_locations enable row level security;
revoke all on public.shelter_locations from public, anon, authenticated;
grant select on public.shelter_locations to anon, authenticated;
grant all on public.shelter_locations to service_role;
create policy shelter_locations_read on public.shelter_locations for select to anon, authenticated using (true);
-- Same rule as every other table since migration 016: a revoked session reads nothing.
create policy active_app_session on public.shelter_locations as restrictive for all to authenticated using(public.current_session_allowed()) with check(public.current_session_allowed());

-- The only way to change the record. An administrator needs the zones module, the
-- same authority that manages service zones; the super administrator may also edit it.
-- Changing the coordinates clears a previously confirmed address unless a new one is
-- confirmed in the same change, so a verified address never describes another place.
create function public.update_shelter_location(p_actor_id uuid, p_code text, p_name text, p_latitude double precision, p_longitude double precision, p_google_maps_url text, p_formatted_address text, p_reason text)
returns public.shelter_locations language plpgsql security definer set search_path=public,pg_temp as $$
declare v_before public.shelter_locations; v_after public.shelter_locations; v_address text := nullif(trim(coalesce(p_formatted_address, '')), ''); begin
  if not (public.has_role(p_actor_id, array['super_administrator'])
    or (public.has_role(p_actor_id, array['administrator']) and public.has_permission(p_actor_id, 'zones.manage'))) then
    raise exception 'Administrator role required' using errcode='42501';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'A reason for the change is required'; end if;
  select * into v_before from public.shelter_locations where code=p_code for update;
  if not found then raise exception 'Shelter location not found'; end if;
  update public.shelter_locations set
    name=trim(p_name), latitude=p_latitude, longitude=p_longitude,
    google_maps_url=nullif(trim(coalesce(p_google_maps_url, '')), ''),
    formatted_address=v_address,
    address_verified_at=case when v_address is null then null
      when v_address is not distinct from v_before.formatted_address and p_latitude=v_before.latitude and p_longitude=v_before.longitude then v_before.address_verified_at
      else now() end,
    address_verified_by=case when v_address is null then null
      when v_address is not distinct from v_before.formatted_address and p_latitude=v_before.latitude and p_longitude=v_before.longitude then v_before.address_verified_by
      else p_actor_id end,
    updated_by=p_actor_id, updated_at=now()
  where id=v_before.id returning * into v_after;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details)
  values(p_actor_id, 'shelter_location.updated', 'shelter_location', v_after.id, jsonb_build_object(
    'code', v_after.code, 'reason', trim(p_reason),
    'before', jsonb_build_object('name', v_before.name, 'latitude', v_before.latitude, 'longitude', v_before.longitude, 'google_maps_url', v_before.google_maps_url, 'formatted_address', v_before.formatted_address),
    'after', jsonb_build_object('name', v_after.name, 'latitude', v_after.latitude, 'longitude', v_after.longitude, 'google_maps_url', v_after.google_maps_url, 'formatted_address', v_after.formatted_address)));
  return v_after;
end $$;
revoke execute on function public.update_shelter_location(uuid, text, text, double precision, double precision, text, text, text) from public, anon, authenticated;
grant execute on function public.update_shelter_location(uuid, text, text, double precision, double precision, text, text, text) to service_role;
notify pgrst, 'reload schema';
