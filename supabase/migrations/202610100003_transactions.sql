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
    and st_covers(z.boundary,st_setsrid(st_makepoint(p_longitude,p_latitude),4326));
  if v_zones is null then v_status:='outside_coverage'; end if;
  return jsonb_build_object('status',v_status,'eligible',v_status='within_coverage','zones',coalesce(v_zones,'[]'::jsonb),'fee_centavos',v_fee);
end $$;

create or replace function public.nearby_verified_reports(p_actor_id uuid,p_longitude double precision,p_latitude double precision,p_radius_meters integer default 3000)
returns table(id uuid,animal_type text,status text,distance_meters double precision)
language plpgsql stable security definer set search_path=public,extensions,pg_temp as $$
begin
  if not public.has_role(p_actor_id,array['administrator','shelter_staff','rescue_personnel']) then raise exception 'Forbidden' using errcode='42501'; end if;
  if not(p_longitude between -180 and 180 and p_latitude between -90 and 90 and p_radius_meters between 1 and 50000) then raise exception 'Invalid proximity query'; end if;
  return query select r.id,r.animal_type,r.status,st_distance(r.location,st_setsrid(st_makepoint(p_longitude,p_latitude),4326)::geography)
    from public.stray_reports r where r.status in ('verified','assigned','in_progress')
      and st_dwithin(r.location,st_setsrid(st_makepoint(p_longitude,p_latitude),4326)::geography,p_radius_meters)
      and (public.has_role(p_actor_id,array['administrator','shelter_staff']) or exists(select 1 from public.rescue_assignments a where a.report_id=r.id and a.assigned_to=p_actor_id and a.status in ('assigned','in_progress')))
    order by 4;
end $$;

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
    select * into v_product from public.products where id=v_item.product_id and is_published;
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

-- Internal helper, never granted to public callers. Caller locks the order first.
create or replace function public.release_order_stock(p_order_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_item record; v_coupon uuid; begin
  perform p.id from public.products p join public.order_items i on i.product_id=p.id where i.order_id=p_order_id order by p.id for update of p;
  perform v.id from public.product_variants v join public.order_items i on i.variant_id=v.id where i.order_id=p_order_id order by v.id for update of v;
  for v_item in select * from public.order_items where order_id=p_order_id order by product_id,variant_id loop
    if v_item.variant_id is null then update public.products set reserved_quantity=reserved_quantity-v_item.quantity where id=v_item.product_id;
    else update public.product_variants set reserved_quantity=reserved_quantity-v_item.quantity where id=v_item.variant_id; end if;
  end loop;
  select coupon_id into v_coupon from public.orders where id=p_order_id;
  if v_coupon is not null then update public.coupons set reserved_count=reserved_count-1 where id=v_coupon; end if;
end $$;

create or replace function public.expire_order_reservations()
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order record; v_count integer:=0; begin
  for v_order in select id from public.orders where status='pending_payment' and reservation_expires_at<=now() order by id for update skip locked loop
    perform public.release_order_stock(v_order.id);
    update public.orders set status='cancelled',updated_at=now() where id=v_order.id;
    insert into public.audit_logs(action,entity_type,entity_id) values('order.reservation_expired','order',v_order.id);
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;

create or replace function public.settle_payment(p_event_id text,p_provider_payment_id text,p_resource_type text,p_resource_id uuid,p_amount_centavos bigint,p_currency text,p_status text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_transaction public.payment_transactions; v_order public.orders; v_item record; v_result jsonb;
  v_review boolean:=false; v_expected bigint; v_resource_status text; v_rows integer;
begin
  if nullif(p_event_id,'') is null or nullif(p_provider_payment_id,'') is null or p_resource_id is null or p_status is null or p_status not in ('paid','failed') then raise exception 'Invalid payment event'; end if;
  if p_currency is distinct from 'PHP' or p_amount_centavos is null or p_amount_centavos<=0 then raise exception 'Invalid payment currency or amount'; end if;
  insert into public.payment_webhook_events(provider_event_id,provider_payment_id,resource_type,resource_id)
    values(p_event_id,p_provider_payment_id,p_resource_type,p_resource_id) on conflict do nothing;
  get diagnostics v_rows=row_count;
  if v_rows=0 then
    select result into v_result from public.payment_webhook_events where provider_event_id=p_event_id;
    return v_result || jsonb_build_object('duplicate',true);
  end if;
  -- Resource locking serializes different event IDs for the same purchase/donation.
  if p_resource_type='order' then
    select * into v_order from public.orders where id=p_resource_id for update;
    if not found then raise exception 'Order not found'; end if;
    v_expected:=v_order.total_centavos;
    v_resource_status:=v_order.status;
  elsif p_resource_type='donation' then
    select amount_centavos,status into v_expected,v_resource_status from public.donations where id=p_resource_id and donation_type='monetary' for update;
  elsif p_resource_type='transport' then
    select fee_centavos,status into v_expected,v_resource_status from public.transport_requests where id=p_resource_id for update;
  elsif p_resource_type='adoption' then
    select fee_centavos,status into v_expected,v_resource_status from public.adoption_applications where id=p_resource_id for update;
  else raise exception 'Unsupported payment resource'; end if;
  if v_expected is null or p_amount_centavos<>v_expected then raise exception 'Payment amount does not match resource'; end if;
  select * into v_transaction from public.payment_transactions where resource_type=p_resource_type and resource_id=p_resource_id
    and (provider_payment_id=p_provider_payment_id or status='pending') order by (provider_payment_id=p_provider_payment_id) desc nulls last,created_at desc limit 1 for update;
  if not found or v_transaction.amount_centavos<>p_amount_centavos or v_transaction.currency<>p_currency or v_transaction.provider_checkout_id is null then raise exception 'No matching payment checkout'; end if;
  if v_transaction.provider_payment_id=p_provider_payment_id and v_transaction.status in ('paid','paid_requires_review') then
    v_result:=jsonb_build_object('duplicate',true,'status',v_transaction.status);
    update public.payment_webhook_events set result=v_result where provider_event_id=p_event_id;
    return v_result;
  end if;
  if p_status='failed' then
    update public.payment_transactions set status='failed',provider_payment_id=p_provider_payment_id where id=v_transaction.id;
    v_result:=jsonb_build_object('status','failed');
  else
    if p_resource_type='order' then
      if v_order.status<>'pending_payment' or v_order.reservation_expires_at<=now() then
        v_review:=true;
        if v_order.status='pending_payment' then
          perform public.release_order_stock(v_order.id);
          update public.orders set status='cancelled',updated_at=now() where id=v_order.id;
        end if;
      else
        perform p.id from public.products p join public.order_items i on i.product_id=p.id where i.order_id=v_order.id order by p.id for update of p;
        perform v.id from public.product_variants v join public.order_items i on i.variant_id=v.id where i.order_id=v_order.id order by v.id for update of v;
        for v_item in select * from public.order_items where order_id=v_order.id order by product_id,variant_id loop
          if v_item.variant_id is null then update public.products set stock_quantity=stock_quantity-v_item.quantity,reserved_quantity=reserved_quantity-v_item.quantity where id=v_item.product_id;
          else update public.product_variants set stock_quantity=stock_quantity-v_item.quantity,reserved_quantity=reserved_quantity-v_item.quantity where id=v_item.variant_id; end if;
          insert into public.inventory_movements(product_id,variant_id,quantity,reason,reference_id) values(v_item.product_id,v_item.variant_id,-v_item.quantity,'sale',v_order.id);
        end loop;
        if v_order.coupon_id is not null then update public.coupons set reserved_count=reserved_count-1,used_count=used_count+1 where id=v_order.coupon_id; end if;
        update public.orders set status='paid',paid_at=now(),updated_at=now() where id=p_resource_id;
      end if;
    elsif p_resource_type='donation' then
      if v_resource_status<>'pending' then v_review:=true;
      else update public.donations set status='paid',paid_at=now() where id=p_resource_id; end if;
    elsif p_resource_type='transport' then
      if v_resource_status<>'confirmed' then v_review:=true;
      else update public.transport_requests set status='paid',paid_at=now(),updated_at=now() where id=p_resource_id; end if;
    elsif p_resource_type='adoption' then
      if v_resource_status not in ('approved','reserved','awaiting_handover') or exists(select 1 from public.adoption_applications where id=p_resource_id and fee_paid_at is not null) then v_review:=true;
      else update public.adoption_applications set fee_paid_at=now(),updated_at=now() where id=p_resource_id; end if;
    end if;
    update public.payment_transactions set status=case when v_review then 'paid_requires_review' else 'paid' end,provider_payment_id=p_provider_payment_id,paid_at=now() where id=v_transaction.id;
    v_result:=jsonb_build_object('status',case when v_review then 'paid_requires_review' else 'paid' end,'requires_review',v_review);
    insert into public.notifications(user_id,title,body,link) values(v_transaction.user_id,
      case when v_review then 'Payment needs staff review' else 'Payment received' end,
      case when v_review then 'Your payment was received after the request became unavailable. Staff will arrange the next step or refund.' else 'Your payment has been verified by the payment provider.' end,'/dashboard');
  end if;
  update public.payment_webhook_events set result=v_result where provider_event_id=p_event_id;
  insert into public.audit_logs(action,entity_type,entity_id,details) values('payment.'||(v_result->>'status'),p_resource_type,p_resource_id,jsonb_build_object('event_id',p_event_id,'payment_id',p_provider_payment_id,'amount_centavos',p_amount_centavos));
  return v_result;
end $$;

create or replace function public.transition_order(p_actor_id uuid,p_order_id uuid,p_status text)
returns public.orders language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.orders; v_allowed boolean:=false; begin
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'Order not found'; end if;
  if p_status='cancelled' and v_order.status='pending_payment' and (v_order.user_id=p_actor_id or public.has_role(p_actor_id,array['administrator','shelter_staff'])) then
    perform public.release_order_stock(p_order_id); v_allowed:=true;
  elsif public.has_role(p_actor_id,array['administrator','shelter_staff']) then
    v_allowed:=(v_order.status='paid' and p_status='processing') or (v_order.status='processing' and p_status='ready_for_shipment')
      or (v_order.status='ready_for_shipment' and p_status='shipped') or (v_order.status='shipped' and p_status='delivered');
    if p_status='refunded' and v_order.status in ('paid','processing','ready_for_shipment','shipped','delivered') then
      v_allowed:=coalesce((select sum(r.amount_centavos) from public.refunds r join public.payment_transactions t on t.id=r.payment_transaction_id
        where t.resource_type='order' and t.resource_id=v_order.id and r.status='succeeded'),0)>=v_order.total_centavos;
    end if;
  end if;
  if not v_allowed then raise exception 'Order transition is not permitted' using errcode='42501'; end if;
  update public.orders set status=p_status,updated_at=now() where id=p_order_id returning * into v_order;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,details) values(p_actor_id,'order.transition','order',p_order_id,jsonb_build_object('status',p_status));
  insert into public.notifications(user_id,title,body,link) values(v_order.user_id,'Order updated','Your order status is now '||replace(p_status,'_',' '),'/orders/'||p_order_id);
  return v_order;
end $$;

revoke execute on all functions in schema public from public;
grant execute on all functions in schema public to service_role;
grant execute on function public.check_service_eligibility(text,double precision,double precision) to anon,authenticated;
