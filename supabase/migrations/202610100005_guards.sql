-- Keep linked ownership and geographic classification authoritative even when inserted through the API.
create or replace function public.guard_application_insert()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.status<>'submitted' then raise exception 'New applications must be submitted for review'; end if;
  if not exists(select 1 from public.pets where id=new.pet_id and status='available' and is_published) then raise exception 'Pet is not available for applications'; end if;
  if new.fee_paid_at is not null then raise exception 'Fee payment can only be recorded after provider verification'; end if;
  new.fee_centavos:=0;
  return new;
end $$;
create trigger adoption_application_guard before insert on public.adoption_applications for each row execute function public.guard_application_insert();

create or replace function public.classify_report_coverage()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  new.coverage_status:=public.check_service_eligibility('rescue',new.longitude,new.latitude)->>'status';
  if tg_op='INSERT' and new.status<>'submitted' then raise exception 'New reports require verification'; end if;
  return new;
end $$;
create trigger report_coverage_guard before insert or update of latitude,longitude on public.stray_reports for each row execute function public.classify_report_coverage();

create or replace function public.guard_transport_request()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_pickup jsonb; v_dropoff jsonb; begin
  if tg_op='INSERT' and (new.status<>'submitted' or new.paid_at is not null or new.driver_id is not null or new.vehicle_id is not null) then raise exception 'New requests require staff review'; end if;
  if new.adoption_application_id is not null and not exists(select 1 from public.adoption_applications where id=new.adoption_application_id and user_id=new.user_id and (new.pet_id is null or pet_id=new.pet_id)) then raise exception 'Linked adoption application does not belong to customer'; end if;
  v_pickup:=public.check_service_eligibility('transport',new.pickup_longitude,new.pickup_latitude);
  v_dropoff:=public.check_service_eligibility('transport',new.dropoff_longitude,new.dropoff_latitude);
  new.coverage_status:=case when (v_pickup->>'eligible')::boolean and (v_dropoff->>'eligible')::boolean then 'within_coverage'
    when v_pickup->>'status'='outside_coverage' or v_dropoff->>'status'='outside_coverage' then 'outside_coverage'
    when v_pickup->>'status'='temporarily_unavailable' or v_dropoff->>'status'='temporarily_unavailable' then 'temporarily_unavailable'
    else 'manual_review_required' end;
  return new;
end $$;
create trigger transport_request_guard before insert or update of pickup_latitude,pickup_longitude,dropoff_latitude,dropoff_longitude,adoption_application_id,user_id on public.transport_requests for each row execute function public.guard_transport_request();

create or replace function public.guard_alternative_request()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.status<>'submitted' or new.reviewed_by is not null then raise exception 'Alternative arrangements require manual review'; end if;
  if new.adoption_application_id is not null and not exists(select 1 from public.adoption_applications where id=new.adoption_application_id and user_id=new.user_id) then raise exception 'Linked adoption does not belong to customer'; end if;
  if new.transport_request_id is not null and not exists(select 1 from public.transport_requests where id=new.transport_request_id and user_id=new.user_id) then raise exception 'Linked transport does not belong to customer'; end if;
  return new;
end $$;
create trigger alternative_request_guard before insert on public.alternative_transport_requests for each row execute function public.guard_alternative_request();

create or replace function public.guard_review_insert()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not exists(select 1 from public.order_items i join public.orders o on o.id=i.order_id where i.id=new.order_item_id and i.product_id=new.product_id and o.user_id=new.user_id and o.status='delivered') then raise exception 'Reviews require a delivered purchase by this customer'; end if;
  new.is_approved:=false;
  return new;
end $$;
create trigger customer_review_guard before insert on public.customer_reviews for each row execute function public.guard_review_insert();

create or replace function public.guard_payment_insert()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid; v_expected bigint; v_status text; begin
  if new.status<>'pending' or new.paid_at is not null then raise exception 'New payment transactions must await provider verification'; end if;
  if new.resource_type='order' then
    select user_id,total_centavos,status into v_owner,v_expected,v_status from public.orders where id=new.resource_id and reservation_expires_at>now();
    if v_status is distinct from 'pending_payment' then raise exception 'Order is not payable'; end if;
  elsif new.resource_type='donation' then
    select user_id,amount_centavos,status into v_owner,v_expected,v_status from public.donations where id=new.resource_id and donation_type='monetary';
    if v_status is distinct from 'pending' then raise exception 'Donation is not payable'; end if;
  elsif new.resource_type='transport' then
    select user_id,fee_centavos,status into v_owner,v_expected,v_status from public.transport_requests where id=new.resource_id and paid_at is null;
    if v_status is distinct from 'confirmed' then raise exception 'Transport quotation must be confirmed before payment'; end if;
  elsif new.resource_type='adoption' then
    select user_id,fee_centavos,status into v_owner,v_expected,v_status from public.adoption_applications where id=new.resource_id and fee_paid_at is null;
    if v_status is null or v_status not in ('approved','reserved','awaiting_handover') then raise exception 'Adoption fee is not payable yet'; end if;
  end if;
  if v_owner is distinct from new.user_id or v_expected is distinct from new.amount_centavos then raise exception 'Payment owner or amount does not match resource'; end if;
  return new;
end $$;
create trigger payment_transaction_guard before insert on public.payment_transactions for each row execute function public.guard_payment_insert();

-- Do not permit unverified monetary donations to be inserted already paid.
create or replace function public.guard_donation_insert()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.paid_at is not null or (new.donation_type='monetary' and new.status<>'pending') or (new.donation_type='in_kind' and new.status not in ('pending','pledged')) then raise exception 'Donation needs payment or staff receipt confirmation'; end if;
  return new;
end $$;
create trigger donation_guard before insert on public.donations for each row execute function public.guard_donation_insert();

revoke execute on all functions in schema public from public;
grant execute on all functions in schema public to service_role;
