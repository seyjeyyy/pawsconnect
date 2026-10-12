-- Vouchers and loyalty rewards, built on the existing coupons table and checkout reservation.
-- Additive: existing coupons keep working as single-use-per-customer promotional codes.
--
-- Rules, in one place:
--   * A voucher is reserved when the order is created, redeemed when the payment is verified, and
--     released when the order is cancelled or its reservation expires before payment.
--   * Once an order is paid the voucher stays redeemed, even if the order is later cancelled or refunded.
--   * A loyalty reward that was granted stays granted if a counted order is later refunded.
--   * One voucher per order. Discounts never exceed what they apply to (subtotal or delivery fee).

alter table public.coupons
  add column if not exists name text check(length(name) between 2 and 80),
  add column if not exists description text check(length(description) <= 300),
  -- promo: anyone with the code. first_purchase: customers with no paid order. loyalty: only customers granted it.
  add column if not exists kind text not null default 'promo' check(kind in ('promo','first_purchase','loyalty')),
  add column if not exists applies_to text not null default 'subtotal' check(applies_to in ('subtotal','delivery')),
  add column if not exists max_discount_centavos bigint check(max_discount_centavos > 0),
  add column if not exists per_user_limit integer not null default 1 check(per_user_limit between 1 and 100),
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- Earn a reward voucher every `threshold` paid orders, or every `threshold` centavos spent.
create table public.loyalty_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null check(length(name) between 2 and 80),
  metric text not null default 'orders' check(metric in ('orders','spend')),
  threshold bigint not null check(threshold > 0),
  reward_code text not null references public.coupons(code) on update cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.voucher_grants (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  rule_id uuid references public.loyalty_rules on delete set null,
  milestone integer check(milestone > 0),
  reason text not null check(length(reason) between 2 and 200),
  granted_at timestamptz not null default now(),
  -- One reward per rule per milestone, however many times the order is updated.
  unique(rule_id, user_id, milestone)
);
create index voucher_grants_user_idx on public.voucher_grants(user_id, coupon_id);

create table public.voucher_redemptions (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons,
  user_id uuid not null references public.profiles on delete cascade,
  order_id uuid not null unique references public.orders on delete cascade,
  discount_centavos bigint not null check(discount_centavos >= 0),
  status text not null default 'reserved' check(status in ('reserved','redeemed','released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index voucher_redemptions_user_idx on public.voucher_redemptions(user_id, coupon_id, status);
create index voucher_redemptions_coupon_idx on public.voucher_redemptions(coupon_id, status);

alter table public.loyalty_rules enable row level security;
alter table public.voucher_grants enable row level security;
alter table public.voucher_redemptions enable row level security;
revoke all on public.loyalty_rules, public.voucher_grants, public.voucher_redemptions from anon, authenticated;
-- The API (service role) is the only writer. Directly, a customer can read only their own rows.
grant select on public.voucher_grants, public.voucher_redemptions to authenticated;
create policy voucher_grants_own on public.voucher_grants for select to authenticated using (user_id = auth.uid());
create policy voucher_redemptions_own on public.voucher_redemptions for select to authenticated using (user_id = auth.uid());
create policy active_app_session on public.loyalty_rules as restrictive for all to authenticated using(public.current_session_allowed()) with check(public.current_session_allowed());
create policy active_app_session on public.voucher_grants as restrictive for all to authenticated using(public.current_session_allowed()) with check(public.current_session_allowed());
create policy active_app_session on public.voucher_redemptions as restrictive for all to authenticated using(public.current_session_allowed()) with check(public.current_session_allowed());

-- The single place a voucher is checked. Checkout quotes call it without a lock; reserve_order
-- calls it with one, so two orders cannot take the last use of a voucher at the same time.
create or replace function public.evaluate_voucher(p_user_id uuid, p_code text, p_subtotal_centavos bigint, p_delivery_centavos bigint, p_lock boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_coupon public.coupons; v_held integer; v_used integer; v_allowed integer; v_base bigint; v_discount bigint;
begin
  if p_lock then select * into v_coupon from public.coupons where code=upper(trim(p_code)) for update;
  else select * into v_coupon from public.coupons where code=upper(trim(p_code)); end if;
  if not found or not v_coupon.is_active or now()<v_coupon.starts_at then raise exception 'That voucher code is not valid.'; end if;
  if now()>=v_coupon.expires_at then raise exception 'That voucher has expired.'; end if;
  if p_subtotal_centavos<v_coupon.minimum_subtotal_centavos then
    raise exception 'Spend at least PHP % on products to use this voucher.', trim(to_char(v_coupon.minimum_subtotal_centavos/100.0,'FM999,999,990.00'));
  end if;
  if v_coupon.max_uses is not null and v_coupon.used_count+v_coupon.reserved_count>=v_coupon.max_uses then raise exception 'That voucher has been fully claimed.'; end if;
  if v_coupon.kind='first_purchase' and exists(select 1 from public.orders where user_id=p_user_id and paid_at is not null) then
    raise exception 'That voucher is for a first order only.';
  end if;
  select count(*) filter(where status='reserved'), count(*) filter(where status='redeemed') into v_held, v_used
    from public.voucher_redemptions where coupon_id=v_coupon.id and user_id=p_user_id;
  if v_coupon.kind='loyalty' then
    select count(*) into v_allowed from public.voucher_grants where coupon_id=v_coupon.id and user_id=p_user_id;
    if v_allowed=0 then raise exception 'That voucher is a reward you have not earned yet.'; end if;
  else v_allowed:=v_coupon.per_user_limit; end if;
  if v_used+v_held>=v_allowed then
    if v_held>0 then raise exception 'That voucher is held by an order awaiting payment. Pay or cancel that order first.'; end if;
    raise exception 'You have already used that voucher.';
  end if;
  v_base:=case when v_coupon.applies_to='delivery' then p_delivery_centavos else p_subtotal_centavos end;
  v_discount:=least(v_base, coalesce(v_coupon.discount_centavos, v_base*v_coupon.discount_percent/100));
  if v_coupon.max_discount_centavos is not null then v_discount:=least(v_discount, v_coupon.max_discount_centavos); end if;
  return jsonb_build_object('coupon_id',v_coupon.id,'code',v_coupon.code,'name',coalesce(v_coupon.name,v_coupon.code),
    'applies_to',v_coupon.applies_to,'discount_percent',v_coupon.discount_percent,'discount_centavos',greatest(v_discount,0));
end $$;

-- Same routine as migration 010, with the discount-code block replaced by evaluate_voucher and a redemption row.
create or replace function public.reserve_order(p_user_id uuid,p_items jsonb,p_address_id uuid,p_coupon_code text default null)
returns public.orders language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare v_address public.customer_addresses; v_order public.orders; v_product public.products; v_variant public.product_variants;
  v_voucher jsonb; v_coupon_id uuid; v_item record; v_normalized jsonb; v_geo jsonb; v_subtotal bigint:=0; v_discount bigint:=0; v_fee bigint; v_price bigint;
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
    -- Locks the voucher row, so its limits are checked and taken one order at a time.
    v_voucher:=public.evaluate_voucher(p_user_id,p_coupon_code,v_subtotal,v_fee,true);
    v_coupon_id:=(v_voucher->>'coupon_id')::uuid; v_discount:=(v_voucher->>'discount_centavos')::bigint;
    update public.coupons set reserved_count=reserved_count+1 where id=v_coupon_id;
  end if;
  insert into public.orders(user_id,subtotal_centavos,discount_centavos,delivery_centavos,total_centavos,address_snapshot,coupon_id)
    values(p_user_id,v_subtotal,v_discount,v_fee,v_subtotal-v_discount+v_fee,to_jsonb(v_address)-'user_id',v_coupon_id) returning * into v_order;
  if v_coupon_id is not null then
    insert into public.voucher_redemptions(coupon_id,user_id,order_id,discount_centavos) values(v_coupon_id,p_user_id,v_order.id,v_discount);
  end if;
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

-- Grants any reward the customer has newly reached. Safe to call repeatedly: a milestone is granted once.
-- Only orders paid after a rule was created count toward it, so a new rule never pays out for old orders.
create or replace function public.grant_loyalty_rewards(p_user_id uuid)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v_rule record; v_progress bigint; v_milestone integer; v_granted integer:=0; v_new integer;
begin
  for v_rule in select r.id,r.name,r.metric,r.threshold,r.created_at,c.id as coupon_id,coalesce(c.name,c.code) as reward
      from public.loyalty_rules r join public.coupons c on c.code=r.reward_code where r.is_active and c.is_active and now()<c.expires_at loop
    select case when v_rule.metric='orders' then count(*) else coalesce(sum(total_centavos),0) end into v_progress
      from public.orders where user_id=p_user_id and paid_at is not null and paid_at>=v_rule.created_at and status not in('cancelled','refunded');
    for v_milestone in 1..least(v_progress/v_rule.threshold,500)::integer loop
      insert into public.voucher_grants(coupon_id,user_id,rule_id,milestone,reason) values(v_rule.coupon_id,p_user_id,v_rule.id,v_milestone,v_rule.name)
        on conflict(rule_id,user_id,milestone) do nothing;
      get diagnostics v_new = row_count;
      if v_new>0 then
        v_granted:=v_granted+1;
        insert into public.notifications(user_id,title,body,link) values(p_user_id,'You earned a reward voucher',v_rule.reward||' is now in your vouchers.','/account/vouchers');
      end if;
    end loop;
  end loop;
  return v_granted;
end $$;

-- Keeps a voucher's redemption in step with its order, whichever routine changes the order.
create or replace function public.voucher_follow_order()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if old.status='pending_payment' and new.status='cancelled' then
    update public.voucher_redemptions set status='released',updated_at=now() where order_id=new.id and status='reserved';
  elsif old.status='pending_payment' and new.status='paid' then
    update public.voucher_redemptions set status='redeemed',updated_at=now() where order_id=new.id and status='reserved';
    perform public.grant_loyalty_rewards(new.user_id);
  end if;
  return new;
end $$;
create trigger voucher_follow_order after update of status on public.orders
  for each row when (old.status is distinct from new.status) execute function public.voucher_follow_order();

-- Closed to clients: only the API (service role) calls these.
revoke execute on function public.evaluate_voucher(uuid,text,bigint,bigint,boolean) from public, anon, authenticated;
revoke execute on function public.reserve_order(uuid,jsonb,uuid,text) from public, anon, authenticated;
revoke execute on function public.grant_loyalty_rewards(uuid) from public, anon, authenticated;
revoke execute on function public.voucher_follow_order() from public, anon, authenticated;
grant execute on function public.evaluate_voucher(uuid,text,bigint,bigint,boolean), public.reserve_order(uuid,jsonb,uuid,text), public.grant_loyalty_rewards(uuid) to service_role;
notify pgrst, 'reload schema';
