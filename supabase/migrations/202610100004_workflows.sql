create or replace function public.assign_user_role(p_actor_id uuid,p_user_id uuid,p_role_name text,p_enabled boolean)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not public.has_role(p_actor_id,array['administrator']) then raise exception 'Administrator role required' using errcode='42501'; end if;
  if p_enabled then insert into public.user_roles(user_id,role_name,assigned_by) values(p_user_id,p_role_name,p_actor_id) on conflict do nothing;
  else
    if p_user_id=p_actor_id and p_role_name='administrator' then raise exception 'Cannot remove your own administrator role'; end if;
    delete from public.user_roles where user_id=p_user_id and role_name=p_role_name;
  end if;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details) values(p_actor_id,'role.changed','profile',p_user_id,jsonb_build_object('role',p_role_name,'enabled',p_enabled));
end $$;

create or replace function public.transition_adoption(p_actor_id uuid,p_application_id uuid,p_status text,p_notes text default null)
returns public.adoption_applications language plpgsql security definer set search_path=public,pg_temp as $$
declare v_app public.adoption_applications; v_allowed boolean:=false; begin
  select * into v_app from public.adoption_applications where id=p_application_id for update;
  if not found then raise exception 'Application not found'; end if;
  if p_status='withdrawn' and v_app.user_id=p_actor_id and v_app.status in ('submitted','under_review','information_requested','interview','approved','reserved','awaiting_handover') then v_allowed:=true;
  elsif public.has_role(p_actor_id,array['administrator','shelter_staff']) then
    v_allowed:=(v_app.status='submitted' and p_status='under_review')
      or (v_app.status='under_review' and p_status in ('information_requested','interview'))
      or (v_app.status='information_requested' and p_status in ('under_review','interview'))
      or (v_app.status='interview' and p_status='under_review')
      or (v_app.status='reserved' and p_status='awaiting_handover');
    if p_status in ('approved','rejected') then
      v_allowed:=public.has_role(p_actor_id,array['administrator']) and v_app.status in ('under_review','interview');
    end if;
  end if;
  if not v_allowed then raise exception 'Adoption transition is not permitted' using errcode='42501'; end if;
  if p_status='approved' then
    if not exists(select 1 from public.pets where id=v_app.pet_id and status='available') then raise exception 'Pet is not available'; end if;
    update public.adoption_applications set fee_centavos=(select adoption_fee_centavos from public.pets where id=v_app.pet_id) where id=v_app.id;
  end if;
  if p_status='awaiting_handover' and v_app.fee_centavos>0 and v_app.fee_paid_at is null then raise exception 'Verified fee payment required'; end if;
  if p_status='withdrawn' and exists(select 1 from public.pet_reservations where application_id=v_app.id and status='active') then
    perform id from public.pets where id=v_app.pet_id for update;
    update public.pet_reservations set status='cancelled' where application_id=v_app.id and status='active';
    update public.pets set status='available',updated_at=now() where id=v_app.pet_id and status='reserved';
  end if;
  update public.adoption_applications set status=p_status,updated_at=now() where id=v_app.id returning * into v_app;
  insert into public.application_reviews(application_id,reviewer_id,status,notes) values(v_app.id,p_actor_id,p_status,p_notes);
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details) values(p_actor_id,'adoption.transition','adoption_application',v_app.id,jsonb_build_object('status',p_status));
  insert into public.notifications(user_id,title,body,link) values(v_app.user_id,'Adoption application updated','Your application is now '||replace(p_status,'_',' '),'/dashboard');
  return v_app;
end $$;

create or replace function public.reserve_pet(p_actor_id uuid,p_application_id uuid)
returns public.pet_reservations language plpgsql security definer set search_path=public,pg_temp as $$
declare v_app public.adoption_applications; v_pet public.pets; v_res public.pet_reservations; begin
  if not public.has_role(p_actor_id,array['administrator','shelter_staff']) then raise exception 'Staff role required' using errcode='42501'; end if;
  select * into v_app from public.adoption_applications where id=p_application_id for update;
  if not found or v_app.status<>'approved' then raise exception 'Application must be approved before reservation'; end if;
  select * into v_pet from public.pets where id=v_app.pet_id for update;
  if v_pet.status<>'available' then raise exception 'Pet is not available for reservation'; end if;
  insert into public.pet_reservations(pet_id,application_id,reserved_by) values(v_app.pet_id,v_app.id,p_actor_id) returning * into v_res;
  update public.pets set status='reserved',updated_at=now() where id=v_app.pet_id;
  update public.adoption_applications set status='reserved',updated_at=now() where id=v_app.id;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id) values(p_actor_id,'adoption.reserved','adoption_application',v_app.id);
  return v_res;
end $$;

create or replace function public.finalize_adoption(p_actor_id uuid,p_application_id uuid,p_handover_notes text)
returns public.completed_adoptions language plpgsql security definer set search_path=public,pg_temp as $$
declare v_app public.adoption_applications; v_pet public.pets; v_res public.pet_reservations; v_completed public.completed_adoptions; begin
  if not public.has_role(p_actor_id,array['administrator','shelter_staff']) then raise exception 'Staff role required' using errcode='42501'; end if;
  if p_handover_notes is null or length(trim(p_handover_notes))<10 then raise exception 'Record verification of physical handover'; end if;
  select * into v_app from public.adoption_applications where id=p_application_id for update;
  if not found or v_app.status<>'awaiting_handover' then raise exception 'Application must be awaiting handover'; end if;
  select * into v_pet from public.pets where id=v_app.pet_id for update;
  select * into v_res from public.pet_reservations where application_id=v_app.id and status='active' for update;
  if not found or v_res.expires_at<=now() or v_pet.status<>'reserved' then raise exception 'An active pet reservation is required'; end if;
  if v_app.fee_centavos>0 and v_app.fee_paid_at is null then raise exception 'Verified fee payment required'; end if;
  if exists(select 1 from public.transport_requests where adoption_application_id=v_app.id and status not in ('completed','declined','cancelled')) then raise exception 'Linked transport must complete before adoption handover'; end if;
  if exists(select 1 from public.alternative_transport_requests where adoption_application_id=v_app.id and status not in ('completed','declined','cancelled')) then raise exception 'Alternative arrangement must complete before adoption handover'; end if;
  insert into public.completed_adoptions(pet_id,application_id,user_id,handover_verified_by,handover_notes)
    values(v_app.pet_id,v_app.id,v_app.user_id,p_actor_id,p_handover_notes) returning * into v_completed;
  update public.pets set status='adopted',updated_at=now() where id=v_app.pet_id;
  update public.pet_reservations set status='completed' where id=v_res.id;
  update public.adoption_applications set status='completed',updated_at=now() where id=v_app.id;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id) values(p_actor_id,'adoption.handover_verified','completed_adoption',v_completed.id);
  insert into public.notifications(user_id,title,body,link) values(v_app.user_id,'Adoption finalized','Physical handover has been verified. Your follow-up is scheduled in 14 days.','/dashboard');
  return v_completed;
end $$;

create or replace function public.expire_pet_reservations()
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v_app record; v_res public.pet_reservations; v_count integer:=0; begin
  -- Use the same application -> pet -> reservation locking order as handover/withdrawal.
  for v_app in select a.id,a.pet_id from public.adoption_applications a where exists(select 1 from public.pet_reservations r where r.application_id=a.id and r.status='active' and r.expires_at<=now()) order by a.id for update of a skip locked loop
    perform id from public.pets where id=v_app.pet_id for update;
    select * into v_res from public.pet_reservations where application_id=v_app.id and status='active' and expires_at<=now() for update;
    if found then
      update public.pet_reservations set status='expired' where id=v_res.id;
      update public.pets set status='available',updated_at=now() where id=v_app.pet_id and status='reserved';
      update public.adoption_applications set status='approved',updated_at=now() where id=v_app.id and status in ('reserved','awaiting_handover');
      insert into public.audit_logs(action,entity_type,entity_id) values('adoption.reservation_expired','adoption_application',v_app.id);
      v_count:=v_count+1;
    end if;
  end loop;
  return v_count;
end $$;

create or replace function public.transition_rescue(p_actor_id uuid,p_report_id uuid,p_status text,p_notes text default null)
returns public.stray_reports language plpgsql security definer set search_path=public,pg_temp as $$
declare v_report public.stray_reports; v_allowed boolean:=false; v_staff boolean; begin
  select * into v_report from public.stray_reports where id=p_report_id for update;
  if not found then raise exception 'Report not found'; end if;
  v_staff:=public.has_role(p_actor_id,array['administrator','shelter_staff']);
  if not v_staff and not exists(select 1 from public.rescue_assignments where report_id=p_report_id and assigned_to=p_actor_id and status in ('assigned','in_progress')) then raise exception 'Forbidden' using errcode='42501'; end if;
  v_allowed:=(v_staff and v_report.status='submitted' and p_status='under_verification')
    or (v_staff and v_report.status='under_verification' and p_status in ('verified','invalid','duplicate','declined','referred'))
    or (v_report.status='assigned' and p_status='in_progress')
    or (v_report.status='in_progress' and p_status='resolved')
    or (v_staff and v_report.status='resolved' and p_status='closed')
    or (v_staff and v_report.status='verified' and p_status in ('declined','referred'));
  if not v_allowed then raise exception 'Rescue transition is not permitted'; end if;
  if p_status='in_progress' and not (public.check_service_eligibility('rescue',v_report.longitude,v_report.latitude)->>'eligible')::boolean then raise exception 'Rescue zone is unavailable'; end if;
  update public.stray_reports set status=p_status,updated_at=now() where id=p_report_id returning * into v_report;
  if p_status in ('in_progress','resolved') then update public.rescue_assignments set status=case when p_status='resolved' then 'completed' else 'in_progress' end where report_id=p_report_id and status in ('assigned','in_progress'); end if;
  insert into public.rescue_events(report_id,actor_id,status,notes) values(p_report_id,p_actor_id,p_status,p_notes);
  if p_status='resolved' then
    if nullif(trim(p_notes),'') is null then raise exception 'Rescue outcome notes are required'; end if;
    insert into public.rescue_outcomes(report_id,recorded_by,outcome,notes) values(p_report_id,p_actor_id,'resolved',p_notes);
  end if;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details) values(p_actor_id,'rescue.transition','stray_report',p_report_id,jsonb_build_object('status',p_status));
  return v_report;
end $$;

create or replace function public.assign_rescue(p_actor_id uuid,p_report_id uuid,p_assignee_id uuid,p_notes text default null)
returns public.rescue_assignments language plpgsql security definer set search_path=public,pg_temp as $$
declare v_report public.stray_reports; v_assignment public.rescue_assignments; begin
  if not public.has_role(p_actor_id,array['administrator','shelter_staff']) then raise exception 'Staff role required' using errcode='42501'; end if;
  if not public.has_role(p_assignee_id,array['rescue_personnel','shelter_staff','administrator']) and not exists(select 1 from public.volunteer_profiles where user_id=p_assignee_id and status='approved') then raise exception 'Assignee must be authorized rescue personnel or an approved volunteer'; end if;
  select * into v_report from public.stray_reports where id=p_report_id for update;
  if not found or v_report.status not in ('verified','assigned') then raise exception 'Report must be verified before dispatch'; end if;
  if not (public.check_service_eligibility('rescue',v_report.longitude,v_report.latitude)->>'eligible')::boolean then raise exception 'No shelter dispatch outside active rescue coverage'; end if;
  if exists(select 1 from public.rescue_assignments where assigned_to=p_assignee_id and status in ('assigned','in_progress')) then raise exception 'Assignee already has an active rescue assignment'; end if;
  -- Serialize assignments for an individual person to enforce availability.
  perform id from public.profiles where id=p_assignee_id for update;
  if exists(select 1 from public.rescue_assignments where assigned_to=p_assignee_id and status in ('assigned','in_progress')) then raise exception 'Assignee already has an active rescue assignment'; end if;
  insert into public.rescue_assignments(report_id,assigned_to,assigned_by,notes) values(p_report_id,p_assignee_id,p_actor_id,p_notes) returning * into v_assignment;
  update public.stray_reports set status='assigned',coverage_status='within_coverage',updated_at=now() where id=p_report_id;
  insert into public.rescue_events(report_id,actor_id,status,notes) values(p_report_id,p_actor_id,'assigned',p_notes);
  insert into public.notifications(user_id,title,body,link) values(p_assignee_id,'Rescue assignment','You have been assigned a verified rescue report.','/dashboard');
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details) values(p_actor_id,'rescue.assigned','stray_report',p_report_id,jsonb_build_object('assignee_id',p_assignee_id));
  return v_assignment;
end $$;

create or replace function public.create_transport_quote(p_actor_id uuid,p_request_id uuid,p_amount_centavos bigint,p_breakdown jsonb,p_expires_at timestamptz)
returns public.transport_quotes language plpgsql security definer set search_path=public,pg_temp as $$
declare v_request public.transport_requests; v_quote public.transport_quotes; begin
  if not public.has_role(p_actor_id,array['administrator','shelter_staff']) then raise exception 'Staff role required' using errcode='42501'; end if;
  if p_amount_centavos is null or p_amount_centavos<0 or p_expires_at is null or p_expires_at<=now() then raise exception 'Invalid quotation'; end if;
  select * into v_request from public.transport_requests where id=p_request_id for update;
  if not found or v_request.status not in ('under_review','quoted') then raise exception 'Transport must be under review'; end if;
  if not (public.check_service_eligibility('transport',v_request.pickup_longitude,v_request.pickup_latitude)->>'eligible')::boolean
    or not (public.check_service_eligibility('transport',v_request.dropoff_longitude,v_request.dropoff_latitude)->>'eligible')::boolean then raise exception 'Both locations must be in approved shelter transport coverage'; end if;
  insert into public.transport_quotes(transport_request_id,amount_centavos,breakdown,quoted_by,expires_at) values(p_request_id,p_amount_centavos,p_breakdown,p_actor_id,p_expires_at) returning * into v_quote;
  update public.transport_requests set status='quoted',fee_centavos=p_amount_centavos,coverage_status='within_coverage',updated_at=now() where id=p_request_id;
  insert into public.transport_tracking_events(transport_request_id,actor_id,status,notes) values(p_request_id,p_actor_id,'quoted','Quotation issued for customer confirmation.');
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details) values(p_actor_id,'transport.quoted','transport_request',p_request_id,jsonb_build_object('amount_centavos',p_amount_centavos));
  return v_quote;
end $$;

create or replace function public.transition_transport(p_actor_id uuid,p_request_id uuid,p_status text,p_notes text default null,p_driver_id uuid default null,p_vehicle_id uuid default null)
returns public.transport_requests language plpgsql security definer set search_path=public,pg_temp as $$
declare v_request public.transport_requests; v_staff boolean; v_allowed boolean:=false; v_quote public.transport_quotes; begin
  select * into v_request from public.transport_requests where id=p_request_id for update;
  if not found then raise exception 'Transport request not found'; end if;
  v_staff:=public.has_role(p_actor_id,array['administrator','shelter_staff']);
  if p_status='confirmed' and v_request.status='quoted' and p_actor_id=v_request.user_id then
    select * into v_quote from public.transport_quotes where transport_request_id=p_request_id order by created_at desc limit 1 for update;
    if not found or v_quote.expires_at<=now() then raise exception 'Quotation has expired'; end if;
    update public.transport_quotes set accepted_at=now() where id=v_quote.id; v_allowed:=true;
  elsif p_status='cancelled' and v_request.status in ('submitted','under_review','quoted') and (p_actor_id=v_request.user_id or v_staff) then v_allowed:=true;
  elsif v_staff then
    v_allowed:=(v_request.status='submitted' and p_status='under_review')
      or (v_request.status in ('submitted','under_review','quoted') and p_status='declined')
      or (v_request.status in ('confirmed','paid') and p_status='scheduled')
      or (v_request.status='scheduled' and p_status='picked_up')
      or (v_request.status='picked_up' and p_status='in_transit')
      or (v_request.status='in_transit' and p_status='arrived')
      or (v_request.status='arrived' and p_status='completed');
  elsif p_actor_id=v_request.driver_id then
    v_allowed:=(v_request.status='scheduled' and p_status='picked_up') or (v_request.status='picked_up' and p_status='in_transit') or (v_request.status='in_transit' and p_status='arrived');
  end if;
  if not v_allowed then raise exception 'Transport transition is not permitted' using errcode='42501'; end if;
  if p_status in ('scheduled','picked_up','in_transit') then
    if not (public.check_service_eligibility('transport',v_request.pickup_longitude,v_request.pickup_latitude)->>'eligible')::boolean
      or not (public.check_service_eligibility('transport',v_request.dropoff_longitude,v_request.dropoff_latitude)->>'eligible')::boolean then raise exception 'Both locations must remain in active shelter transport coverage'; end if;
    if v_request.fee_centavos is null or (v_request.fee_centavos>0 and v_request.paid_at is null) then raise exception 'Verified transport payment is required'; end if;
  end if;
  if p_status='scheduled' then
    perform user_id from public.shelter_drivers where user_id=p_driver_id and is_active for update;
    if not found or not public.has_role(p_driver_id,array['shelter_driver']) then raise exception 'An active verified driver is required'; end if;
    perform id from public.shelter_vehicles where id=p_vehicle_id and is_active for update;
    if not found then raise exception 'An available shelter vehicle is required'; end if;
    if exists(select 1 from public.transport_requests where id<>p_request_id and status in ('scheduled','picked_up','in_transit') and (driver_id=p_driver_id or vehicle_id=p_vehicle_id)) then raise exception 'Driver or vehicle is already assigned to active transportation'; end if;
    update public.transport_requests set driver_id=p_driver_id,vehicle_id=p_vehicle_id,confirmed_schedule=preferred_schedule where id=p_request_id;
  end if;
  if p_status='completed' and not exists(select 1 from public.transport_handovers where transport_request_id=p_request_id) then raise exception 'Recipient handover confirmation required'; end if;
  update public.transport_requests set status=p_status,updated_at=now() where id=p_request_id returning * into v_request;
  insert into public.transport_tracking_events(transport_request_id,actor_id,status,notes) values(p_request_id,p_actor_id,p_status,p_notes);
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details) values(p_actor_id,'transport.transition','transport_request',p_request_id,jsonb_build_object('status',p_status));
  return v_request;
end $$;

create or replace function public.confirm_transport_handover(p_actor_id uuid,p_request_id uuid,p_recipient_name text,p_notes text)
returns public.transport_handovers language plpgsql security definer set search_path=public,pg_temp as $$
declare v_request public.transport_requests; v_handover public.transport_handovers; begin
  select * into v_request from public.transport_requests where id=p_request_id for update;
  if not found or v_request.status<>'arrived' then raise exception 'Transport must have arrived'; end if;
  if p_actor_id<>v_request.user_id and not public.has_role(p_actor_id,array['administrator','shelter_staff']) then raise exception 'Customer or staff confirmation required' using errcode='42501'; end if;
  if nullif(trim(p_recipient_name),'') is null or nullif(trim(p_notes),'') is null then raise exception 'Recipient name and safe arrival notes required'; end if;
  insert into public.transport_handovers(transport_request_id,recipient_name,confirmed_by,notes,recipient_confirmed_at) values(p_request_id,p_recipient_name,p_actor_id,p_notes,now()) returning * into v_handover;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id) values(p_actor_id,'transport.handover_confirmed','transport_request',p_request_id);
  return v_handover;
end $$;

create or replace function public.transition_alternative_transport(p_actor_id uuid,p_request_id uuid,p_status text,p_notes text default null)
returns public.alternative_transport_requests language plpgsql security definer set search_path=public,pg_temp as $$
declare v_request public.alternative_transport_requests; v_allowed boolean:=false; begin
  select * into v_request from public.alternative_transport_requests where id=p_request_id for update;
  if not found then raise exception 'Alternative request not found'; end if;
  if v_request.user_id=p_actor_id and p_status='cancelled' and v_request.status in ('submitted','under_review') then v_allowed:=true;
  elsif public.has_role(p_actor_id,array['administrator','shelter_staff']) then
    v_allowed:=(v_request.status='submitted' and p_status='under_review')
      or (v_request.status='under_review' and p_status in ('approved','declined') and public.has_role(p_actor_id,array['administrator']))
      or (v_request.status='approved' and p_status='completed');
  end if;
  if not v_allowed then raise exception 'Alternative transport transition is not permitted' using errcode='42501'; end if;
  if p_status in ('approved','completed') and (p_notes is null or length(trim(p_notes))<10) then raise exception 'Record verification of the arrangement and transporter'; end if;
  if p_status='approved' and v_request.arrangement_type='customer_arranged' and (nullif(trim(v_request.transporter_name),'') is null or nullif(trim(v_request.transporter_contact),'') is null) then raise exception 'Verified transporter name and contact are required'; end if;
  update public.alternative_transport_requests set status=p_status,reviewed_by=p_actor_id,review_notes=p_notes where id=p_request_id returning * into v_request;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details) values(p_actor_id,'alternative_transport.transition','alternative_transport_request',p_request_id,jsonb_build_object('status',p_status));
  return v_request;
end $$;

create or replace function public.upsert_service_zone(p_actor_id uuid,p_zone_id uuid,p_name text,p_service_type text,p_province text,p_geojson jsonb,p_source_reference text,p_fee_centavos bigint,p_is_active boolean)
returns public.service_zones language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare v_boundary geometry; v_zone public.service_zones; begin
  if not public.has_role(p_actor_id,array['administrator']) then raise exception 'Administrator role required' using errcode='42501'; end if;
  v_boundary:=st_multi(st_setsrid(st_geomfromgeojson(p_geojson),4326));
  if st_geometrytype(v_boundary)<>'ST_MultiPolygon' or not st_isvalid(v_boundary) then raise exception 'A valid WGS84 Polygon or MultiPolygon is required'; end if;
  if nullif(trim(p_name),'') is null then raise exception 'Zone name required'; end if;
  if p_zone_id is null then
    insert into public.service_zones(name,service_type,province,boundary,source_reference,fee_centavos,is_active,created_by)
      values(p_name,p_service_type,p_province,v_boundary,p_source_reference,p_fee_centavos,p_is_active,p_actor_id) returning * into v_zone;
  else
    update public.service_zones set name=p_name,service_type=p_service_type,province=p_province,boundary=v_boundary,source_reference=p_source_reference,fee_centavos=p_fee_centavos,is_active=p_is_active,updated_at=now() where id=p_zone_id returning * into v_zone;
    if not found then raise exception 'Service zone not found'; end if;
  end if;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details) values(p_actor_id,'service_zone.saved','service_zone',v_zone.id,jsonb_build_object('source_reference',p_source_reference,'active',p_is_active));
  return v_zone;
end $$;

create or replace function public.overlapping_service_zones(p_actor_id uuid,p_zone_id uuid)
returns table(id uuid,name text,overlap_square_meters double precision) language plpgsql stable security definer set search_path=public,extensions,pg_temp as $$
begin
  if not public.has_role(p_actor_id,array['administrator','shelter_staff']) then raise exception 'Staff role required' using errcode='42501'; end if;
  return query select z.id,z.name,st_area(st_intersection(z.boundary,a.boundary)::geography) from public.service_zones a join public.service_zones z on z.id<>a.id and z.service_type=a.service_type and st_intersects(z.boundary,a.boundary) where a.id=p_zone_id;
end $$;

create or replace function public.admin_metrics(p_actor_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_sales bigint; v_transport bigint; v_adoption bigint; v_donations bigint; v_refunds bigint; v_costs bigint; v_expenses bigint; v_transport_costs bigint; begin
  if not public.has_role(p_actor_id,array['administrator','shelter_staff']) then raise exception 'Staff role required' using errcode='42501'; end if;
  select coalesce(sum(subtotal_centavos-discount_centavos),0) into v_sales from public.orders where paid_at is not null;
  select coalesce(sum(fee_centavos),0),coalesce(sum(fuel_cost_centavos+staff_cost_centavos+other_cost_centavos),0) into v_transport,v_transport_costs from public.transport_requests where paid_at is not null;
  select coalesce(sum(fee_centavos),0) into v_adoption from public.adoption_applications where fee_paid_at is not null;
  select coalesce(sum(amount_centavos),0) into v_donations from public.donations where status='paid' and donation_type='monetary';
  select coalesce(sum(amount_centavos),0) into v_refunds from public.refunds where status='succeeded';
  select coalesce(sum(i.quantity*i.unit_cost_centavos),0) into v_costs from public.order_items i join public.orders o on o.id=i.order_id where o.paid_at is not null;
  select coalesce(sum(amount_centavos),0) into v_expenses from public.expenses;
  return jsonb_build_object(
    'total_buyers',(select count(distinct user_id) from public.orders),
    'total_orders',(select count(*) from public.orders),
    'pending_orders',(select count(*) from public.orders where status='pending_payment'),
    'store_revenue_centavos',v_sales,
    'delivery_receipts_centavos',(select coalesce(sum(delivery_centavos),0) from public.orders where paid_at is not null),
    'inventory_units',(select coalesce(sum(stock_quantity-reserved_quantity),0) from public.products where not is_sample),
    'total_adoption_applications',(select count(*) from public.adoption_applications a join public.pets p on p.id=a.pet_id where not p.is_sample),
    'completed_adoptions',(select count(*) from public.completed_adoptions a join public.pets p on p.id=a.pet_id where not p.is_sample),
    'available_pets',(select count(*) from public.pets where status='available' and not is_sample),
    'stray_reports',(select count(*) from public.stray_reports),
    'active_rescue_cases',(select count(*) from public.stray_reports where status in ('verified','assigned','in_progress')),
    'transport_bookings',(select count(*) from public.transport_requests),
    'transport_revenue_centavos',v_transport,'adoption_fee_receipts_centavos',v_adoption,'donations_centavos',v_donations,
    'gross_receipts_centavos',(select coalesce(sum(amount_centavos),0) from public.payment_transactions where status in ('paid','paid_requires_review','refunded')),
    'unallocated_payment_receipts_centavos',(select coalesce(sum(amount_centavos),0) from public.payment_transactions where status='paid_requires_review'),
    'refunds_centavos',v_refunds,'cost_of_goods_centavos',v_costs,'expenses_centavos',v_expenses,'transport_costs_centavos',v_transport_costs,
    'operating_surplus_centavos',v_sales+v_transport+v_adoption-v_refunds-v_costs-v_expenses-v_transport_costs,
    'transport_contribution_centavos',v_transport-v_transport_costs,
    'financial_note','Management totals in PHP centavos. Donations and delivery pass-through receipts are excluded from operating surplus. Refunds require reconciled provider records.');
end $$;

revoke execute on all functions in schema public from public;
grant execute on all functions in schema public to service_role;
