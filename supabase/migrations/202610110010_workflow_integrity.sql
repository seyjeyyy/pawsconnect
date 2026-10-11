-- Replace existing routines without changing past migrations.
create or replace function public.reserve_order(p_user_id uuid,p_items jsonb,p_address_id uuid,p_coupon_code text default null)
returns public.orders language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare v_address public.customer_addresses; v_order public.orders; v_product public.products; v_variant public.product_variants;
  v_coupon public.coupons; v_item record; v_normalized jsonb; v_geo jsonb; v_subtotal bigint:=0; v_discount bigint:=0; v_fee bigint; v_price bigint;
begin
  if p_user_id is null or not exists(select 1 from public.profiles where id=p_user_id) then raise exception 'Unknown customer'; end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' then raise exception 'Cart must be an array'; end if;
  if jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Cart must contain 1 to 100 lines'; end if;
  select * into v_address from public.customer_addresses where id=p_address_id and user_id=p_user_id;
  if not found then raise exception 'Address not found' using errcode='42501'; end if;
  v_geo:=public.check_service_eligibility('delivery',v_address.longitude,v_address.latitude);
  if not (v_geo->>'eligible')::boolean then raise exception 'Delivery address is not within an active approved delivery zone'; end if;
  v_fee:=(v_geo->>'fee_centavos')::bigint;
  if exists(select 1 from jsonb_array_elements(p_items) e where e->>'product_id' is null or e->>'quantity' is null or (e->>'quantity') !~ '^[1-9][0-9]?$') then raise exception 'Invalid cart line'; end if;
  select jsonb_agg(jsonb_build_object('product_id',product_id,'variant_id',variant_id,'quantity',quantity) order by product_id,variant_id)
    into v_normalized from (select (e->>'product_id')::uuid product_id,nullif(e->>'variant_id','')::uuid variant_id,sum((e->>'quantity')::integer) quantity
      from jsonb_array_elements(p_items) e group by 1,2) x;
  if exists(select 1 from jsonb_array_elements(v_normalized) e where (e->>'quantity')::integer>99) then raise exception 'Maximum quantity per item is 99'; end if;
  -- Stable lock ordering prevents overselling and reduces checkout deadlocks.
  perform id from public.products where id in(select (e->>'product_id')::uuid from jsonb_array_elements(v_normalized) e) order by id for update;
  perform id from public.product_variants where id in(select (e->>'variant_id')::uuid from jsonb_array_elements(v_normalized) e) order by id for update;
  for v_item in select * from jsonb_to_recordset(v_normalized) as x(product_id uuid,variant_id uuid,quantity integer) loop
    select * into v_product from public.products where id=v_item.product_id and is_published and not is_sample;
    if not found then raise exception 'Product is unavailable'; end if;
    if v_item.variant_id is not null then
      select * into v_variant from public.product_variants where id=v_item.variant_id and product_id=v_item.product_id and is_active;
      if not found then raise exception 'Invalid product variant'; end if;
      if v_variant.stock_quantity-v_variant.reserved_quantity<v_item.quantity then raise exception 'Insufficient stock: %',v_product.name; end if;
      v_price:=v_variant.price_centavos;
    else
      if exists(select 1 from public.product_variants where product_id=v_product.id and is_active) then raise exception 'Choose a product variant'; end if;
      if v_product.stock_quantity-v_product.reserved_quantity<v_item.quantity then raise exception 'Insufficient stock: %',v_product.name; end if;
      v_price:=v_product.price_centavos;
    end if;
    v_subtotal:=v_subtotal+v_price*v_item.quantity;
  end loop;
  if nullif(trim(p_coupon_code),'') is not null then
    select * into v_coupon from public.coupons where code=upper(trim(p_coupon_code)) for update;
    if not found or not v_coupon.is_active or now()<v_coupon.starts_at or now()>=v_coupon.expires_at or v_subtotal<v_coupon.minimum_subtotal_centavos
      or (v_coupon.max_uses is not null and v_coupon.used_count+v_coupon.reserved_count>=v_coupon.max_uses) then raise exception 'Discount code is invalid or unavailable'; end if;
    v_discount:=least(v_subtotal,coalesce(v_coupon.discount_centavos,v_subtotal*v_coupon.discount_percent/100));
    update public.coupons set reserved_count=reserved_count+1 where id=v_coupon.id;
  end if;
  insert into public.orders(user_id,subtotal_centavos,discount_centavos,delivery_centavos,total_centavos,address_snapshot,coupon_id)
    values(p_user_id,v_subtotal,v_discount,v_fee,v_subtotal-v_discount+v_fee,to_jsonb(v_address)-'user_id',v_coupon.id) returning * into v_order;
  for v_item in select * from jsonb_to_recordset(v_normalized) as x(product_id uuid,variant_id uuid,quantity integer) loop
    select * into v_product from public.products where id=v_item.product_id;
    if v_item.variant_id is null then
      v_price:=v_product.price_centavos;
      update public.products set reserved_quantity=reserved_quantity+v_item.quantity where id=v_item.product_id;
    else
      select * into v_variant from public.product_variants where id=v_item.variant_id;
      v_price:=v_variant.price_centavos;
      update public.product_variants set reserved_quantity=reserved_quantity+v_item.quantity where id=v_item.variant_id;
    end if;
    insert into public.order_items(order_id,product_id,variant_id,product_name,quantity,unit_price_centavos,unit_cost_centavos,line_total_centavos)
      values(v_order.id,v_item.product_id,v_item.variant_id,v_product.name,v_item.quantity,v_price,v_product.cost_centavos,v_price*v_item.quantity);
  end loop;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id) values(p_user_id,'order.reserved','order',v_order.id);
  return v_order;
end $$;
create or replace function public.check_service_eligibility(p_service_type text,p_longitude double precision,p_latitude double precision)
returns jsonb language plpgsql stable security definer set search_path=public,extensions,pg_temp as $$
declare v_zones jsonb; v_fee bigint; v_status text; begin
  if p_service_type not in ('transport','rescue','delivery','donation_pickup','adoption') then raise exception 'Invalid service type'; end if;
  if p_longitude is null or p_latitude is null or not(p_longitude between -180 and 180 and p_latitude between -90 and 90) then raise exception 'Invalid coordinates'; end if;
  select jsonb_agg(jsonb_build_object('id',z.id,'name',z.name,'fee_centavos',z.fee_centavos,'availability',z.availability) order by z.fee_centavos,z.id),
    min(z.fee_centavos) filter(where z.availability='available' and not exists(select 1 from public.zone_rules r where r.zone_id=z.id and r.is_active)),
    case when bool_or(z.availability='available' and not exists(select 1 from public.zone_rules r where r.zone_id=z.id and r.is_active)) then 'within_coverage'
      when bool_or(z.availability='manual_review' or exists(select 1 from public.zone_rules r where r.zone_id=z.id and r.is_active)) then 'manual_review_required'
      else 'temporarily_unavailable' end
  into v_zones,v_fee,v_status from public.service_zones z
  where z.is_active and z.service_type=p_service_type
    and z.name !~* '^demo' and z.source_reference !~* '^demo'
    and st_covers(z.boundary,st_setsrid(st_makepoint(p_longitude,p_latitude),4326));
  if v_zones is null then v_status:='outside_coverage'; end if;
  return jsonb_build_object('status',v_status,'eligible',v_status='within_coverage','zones',coalesce(v_zones,'[]'::jsonb),'fee_centavos',v_fee);
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
    'registered_users',(select count(*) from public.profiles),
    'registered_pets',(select count(*) from public.pets where not is_sample),
    'administrators',(select count(distinct user_id) from public.user_roles where role_name in ('administrator','super_administrator')),
    'pending_adoptions',(select count(*) from public.adoption_applications where status in ('submitted','under_review','information_requested','interview')),
    'approved_adoptions',(select count(*) from public.adoption_applications where status in ('approved','reserved','awaiting_handover','completed')),
    'rejected_adoptions',(select count(*) from public.adoption_applications where status='rejected'),
    'verified_payments',(select count(*) from public.payment_transactions where status='paid'),
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
create function public.schedule_transport(p_actor_id uuid,p_request_id uuid,p_driver_id uuid,p_vehicle_id uuid,p_schedule timestamptz)
returns public.transport_requests language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.transport_requests; begin
 if p_schedule<=now() then raise exception 'Choose a future schedule'; end if;
 select * into v from public.transition_transport(p_actor_id,p_request_id,'scheduled',null,p_driver_id,p_vehicle_id);
 update public.transport_requests set confirmed_schedule=p_schedule where id=p_request_id returning * into v;
 return v;
end $$;
revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on function public.has_role(uuid,text[]),public.is_staff(),public.is_admin(),public.can_read_report(uuid),public.can_read_transport(uuid) to anon,authenticated,service_role;
grant execute on all functions in schema public to service_role;
