alter table public.payment_transactions add column livemode boolean;
-- The provider-saved checkout id is authoritative for sandbox sessions only.
update public.payment_transactions set livemode=false where provider='stripe' and provider_checkout_id like 'cs_test_%';
create or replace function public.admin_metrics(p_actor_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_sales bigint; v_transport bigint; v_adoption bigint; v_donations bigint; v_refunds bigint; v_costs bigint; v_expenses bigint; v_transport_costs bigint; begin
  if not public.has_role(p_actor_id,array['administrator','shelter_staff']) then raise exception 'Staff role required' using errcode='42501'; end if;
  select coalesce(sum(subtotal_centavos-discount_centavos),0) into v_sales from public.orders where paid_at is not null and exists(select 1 from public.payment_transactions pay where pay.resource_type='order' and pay.resource_id=orders.id and pay.livemode is true and pay.status in ('paid','refunded'));
  select coalesce(sum(fee_centavos),0),coalesce(sum(fuel_cost_centavos+staff_cost_centavos+other_cost_centavos),0) into v_transport,v_transport_costs from public.transport_requests where paid_at is not null and exists(select 1 from public.payment_transactions pay where pay.resource_type='transport' and pay.resource_id=transport_requests.id and pay.livemode is true and pay.status in ('paid','refunded'));
  select coalesce(sum(fee_centavos),0) into v_adoption from public.adoption_applications where fee_paid_at is not null and exists(select 1 from public.payment_transactions pay where pay.resource_type='adoption' and pay.resource_id=adoption_applications.id and pay.livemode is true and pay.status in ('paid','refunded'));
  select coalesce(sum(amount_centavos),0) into v_donations from public.donations where status='paid' and donation_type='monetary' and exists(select 1 from public.payment_transactions pay where pay.resource_type='donation' and pay.resource_id=donations.id and pay.livemode is true and pay.status in ('paid','refunded'));
  select coalesce(sum(amount_centavos),0) into v_refunds from public.refunds where status='succeeded' and exists(select 1 from public.payment_transactions pay where pay.id=refunds.payment_transaction_id and pay.livemode is true);
  select coalesce(sum(i.quantity*i.unit_cost_centavos),0) into v_costs from public.order_items i join public.orders o on o.id=i.order_id where o.paid_at is not null and exists(select 1 from public.payment_transactions pay where pay.resource_type='order' and pay.resource_id=o.id and pay.livemode is true and pay.status in ('paid','refunded'));
  select coalesce(sum(amount_centavos),0) into v_expenses from public.expenses;
  return jsonb_build_object(
    'registered_users',(select count(*) from public.profiles),
    'registered_pets',(select count(*) from public.pets where not is_sample),
    'administrators',(select count(distinct user_id) from public.user_roles where role_name in ('administrator','super_administrator')),
    'pending_adoptions',(select count(*) from public.adoption_applications where status in ('submitted','under_review','information_requested','interview')),
    'approved_adoptions',(select count(*) from public.adoption_applications where status in ('approved','reserved','awaiting_handover','completed')),
    'rejected_adoptions',(select count(*) from public.adoption_applications where status='rejected'),
    'test_payments',(select count(*) from public.payment_transactions where livemode is false and status in ('paid','refunded','paid_requires_review')),
    'legacy_unclassified_payments',(select count(*) from public.payment_transactions where livemode is null),
    'verified_payments',(select count(*) from public.payment_transactions where status='paid' and livemode is true),
    'total_buyers',(select count(distinct user_id) from public.orders),
    'total_orders',(select count(*) from public.orders),
    'pending_orders',(select count(*) from public.orders where status='pending_payment'),
    'store_revenue_centavos',v_sales,
    'delivery_receipts_centavos',(select coalesce(sum(delivery_centavos),0) from public.orders where paid_at is not null and exists(select 1 from public.payment_transactions pay where pay.resource_type='order' and pay.resource_id=orders.id and pay.livemode is true and pay.status in ('paid','refunded'))),
    'inventory_units',(select coalesce(sum(stock_quantity-reserved_quantity),0) from public.products where not is_sample),
    'total_adoption_applications',(select count(*) from public.adoption_applications a join public.pets p on p.id=a.pet_id where not p.is_sample),
    'completed_adoptions',(select count(*) from public.completed_adoptions a join public.pets p on p.id=a.pet_id where not p.is_sample),
    'available_pets',(select count(*) from public.pets where status='available' and not is_sample),
    'stray_reports',(select count(*) from public.stray_reports),
    'active_rescue_cases',(select count(*) from public.stray_reports where status in ('verified','assigned','in_progress')),
    'transport_bookings',(select count(*) from public.transport_requests),
    'transport_revenue_centavos',v_transport,'adoption_fee_receipts_centavos',v_adoption,'donations_centavos',v_donations,
    'gross_receipts_centavos',(select coalesce(sum(amount_centavos),0) from public.payment_transactions where status in ('paid','paid_requires_review','refunded') and livemode is true),
    'unallocated_payment_receipts_centavos',(select coalesce(sum(amount_centavos),0) from public.payment_transactions where status='paid_requires_review' and livemode is true),
    'refunds_centavos',v_refunds,'cost_of_goods_centavos',v_costs,'expenses_centavos',v_expenses,'transport_costs_centavos',v_transport_costs,
    'operating_surplus_centavos',v_sales+v_transport+v_adoption-v_refunds-v_costs-v_expenses-v_transport_costs,
    'transport_contribution_centavos',v_transport-v_transport_costs,
    'financial_note','Live-mode payment totals only, in PHP centavos. Stripe test sessions and unclassified historical payments are excluded from receipts and sales. Operational counts still include retained historical records. Donations and delivery pass-through receipts are excluded from operating surplus. Refunds require reconciled provider records.');
end $$;
revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on function public.has_role(uuid,text[]),public.is_staff(),public.is_admin(),public.can_read_report(uuid),public.can_read_transport(uuid),public.check_service_eligibility(text,double precision,double precision) to anon,authenticated,service_role;
grant execute on all functions in schema public to service_role;
