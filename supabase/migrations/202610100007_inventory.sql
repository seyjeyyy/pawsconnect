-- Manual stock adjustment (receiving, damage, stock-take corrections). The API
-- referenced this function but no earlier migration defined it.
-- Every change is recorded in inventory_movements with the actor and reason.
create or replace function public.adjust_inventory(p_actor_id uuid, p_product_id uuid, p_variant_id uuid, p_quantity_delta integer, p_reason text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_stock integer; v_reserved integer;
begin
  if not public.has_role(p_actor_id, array['administrator', 'shelter_staff']) then
    raise exception 'Shelter staff role required' using errcode = '42501';
  end if;
  if p_quantity_delta is null or p_quantity_delta = 0 then raise exception 'Adjustment quantity must not be zero'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'A reason is required for every stock adjustment'; end if;

  if p_variant_id is null then
    select stock_quantity, reserved_quantity into v_stock, v_reserved from public.products where id = p_product_id for update;
    if not found then raise exception 'Product not found'; end if;
    if exists (select 1 from public.product_variants where product_id = p_product_id and is_active) then
      raise exception 'This product is stocked by variant. Adjust a variant instead.';
    end if;
  else
    select stock_quantity, reserved_quantity into v_stock, v_reserved from public.product_variants
      where id = p_variant_id and product_id = p_product_id for update;
    if not found then raise exception 'Product variant not found'; end if;
  end if;

  -- Stock promised to unpaid orders cannot be written off underneath them.
  if v_stock + p_quantity_delta < v_reserved then
    raise exception 'Stock cannot drop below the % unit(s) reserved by pending orders', v_reserved;
  end if;

  if p_variant_id is null then
    update public.products set stock_quantity = stock_quantity + p_quantity_delta, updated_at = now() where id = p_product_id;
  else
    update public.product_variants set stock_quantity = stock_quantity + p_quantity_delta where id = p_variant_id;
  end if;
  insert into public.inventory_movements (product_id, variant_id, quantity, reason, actor_id)
    values (p_product_id, p_variant_id, p_quantity_delta, trim(p_reason), p_actor_id);
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
    values (p_actor_id, 'inventory.adjusted', 'product', p_product_id,
      jsonb_build_object('variant_id', p_variant_id, 'quantity_delta', p_quantity_delta, 'reason', trim(p_reason)));
  return jsonb_build_object('product_id', p_product_id, 'variant_id', p_variant_id,
    'stock_quantity', v_stock + p_quantity_delta, 'reserved_quantity', v_reserved);
end $$;

revoke execute on function public.adjust_inventory(uuid, uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.adjust_inventory(uuid, uuid, uuid, integer, text) to service_role;
