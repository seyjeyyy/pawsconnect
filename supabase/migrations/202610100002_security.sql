-- Authorization helpers avoid user_roles RLS recursion. No client may invoke privileged RPCs.
create or replace function public.has_role(p_user_id uuid, p_roles text[])
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.user_roles where user_id=p_user_id and role_name=any(p_roles));
$$;
create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.has_role(auth.uid(),array['administrator','shelter_staff']);
$$;
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.has_role(auth.uid(),array['administrator']);
$$;
create or replace function public.can_read_report(p_report_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_staff() or exists(select 1 from public.stray_reports where id=p_report_id and user_id=auth.uid())
    or exists(select 1 from public.rescue_assignments where report_id=p_report_id and assigned_to=auth.uid() and status in ('assigned','in_progress'));
$$;
create or replace function public.can_read_transport(p_request_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_staff() or exists(select 1 from public.transport_requests where id=p_request_id and (user_id=auth.uid() or driver_id=auth.uid()));
$$;
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.profiles(id,full_name) values(new.id,left(coalesce(new.raw_user_meta_data->>'full_name',''),200));
  -- Ignore every role supplied by the client or by auth metadata.
  insert into public.user_roles(user_id,role_name) values(new.id,'buyer'),(new.id,'adopter'),(new.id,'donor'),(new.id,'community_reporter');
  insert into public.buyer_profiles(user_id) values(new.id);
  insert into public.adopter_profiles(user_id) values(new.id);
  insert into public.carts(user_id) values(new.id);
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Deny by default on EVERY application table. Policies below grant narrowly scoped reads.
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname='public' loop
    execute format('alter table public.%I enable row level security',t.tablename);
    execute format('revoke all on public.%I from anon, authenticated',t.tablename);
    execute format('grant select on public.%I to authenticated',t.tablename);
    execute format('grant all on public.%I to service_role',t.tablename);
  end loop;
end $$;

create policy profiles_read on public.profiles for select to authenticated using(id=auth.uid() or public.is_staff());
create policy profiles_update on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
grant update(full_name,phone,avatar_url) on public.profiles to authenticated;
create policy roles_read on public.roles for select to authenticated using(true);
create policy user_roles_read on public.user_roles for select to authenticated using(user_id=auth.uid() or public.is_admin());
-- No insert/update/delete grants on user_roles: assignments only through audited admin RPC.

do $$ declare n text; begin
  foreach n in array array['buyer_profiles','adopter_profiles','customer_addresses','carts','orders','payment_transactions',
    'personality_assessments','adoption_applications','completed_adoptions','alternative_transport_requests','donations',
    'volunteer_profiles','notifications','service_locations','contact_messages'] loop
    execute format('create policy owner_or_staff_read on public.%I for select to authenticated using (user_id=auth.uid() or public.is_staff())',n);
  end loop;
end $$;
create policy addresses_insert on public.customer_addresses for insert to authenticated with check(user_id=auth.uid());
create policy addresses_update on public.customer_addresses for update to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
create policy addresses_delete on public.customer_addresses for delete to authenticated using(user_id=auth.uid());
grant insert,update,delete on public.customer_addresses to authenticated;
create policy buyer_profile_update on public.buyer_profiles for update to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
grant update(marketing_consent) on public.buyer_profiles to authenticated;
create policy adopter_profile_update on public.adopter_profiles for update to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
grant update(housing_type,household,experience,consent_at) on public.adopter_profiles to authenticated;
create policy notifications_mark_read on public.notifications for update to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
grant update(read_at) on public.notifications to authenticated;

grant select on public.product_categories,public.products,public.product_images,public.product_variants,
 public.pets,public.pet_photos,public.pet_behavior_profiles,public.customer_reviews,public.service_zones to anon;
create policy category_public_read on public.product_categories for select using(is_active or public.is_staff());
create policy product_public_read on public.products for select using(is_published or public.is_staff());
create policy product_image_public_read on public.product_images for select using(exists(select 1 from public.products p where p.id=product_id and (p.is_published or public.is_staff())));
create policy variant_public_read on public.product_variants for select using((is_active and exists(select 1 from public.products p where p.id=product_id and p.is_published)) or public.is_staff());
create policy pet_public_read on public.pets for select using((is_published and status in ('available','reserved','adopted')) or public.is_staff());
create policy pet_photo_public_read on public.pet_photos for select using(exists(select 1 from public.pets p where p.id=pet_id and (p.is_published or public.is_staff())));
create policy pet_behavior_public_read on public.pet_behavior_profiles for select using(exists(select 1 from public.pets p where p.id=pet_id and (p.is_published or public.is_staff())));
create policy review_public_read on public.customer_reviews for select using(is_approved or user_id=auth.uid() or public.is_staff());
create policy zone_public_read on public.service_zones for select using(is_active or public.is_staff());

do $$ declare n text; begin
  foreach n in array array['product_categories','products','product_images','product_variants','pets','pet_photos','pet_behavior_profiles','shelter_vehicles','coupons'] loop
    execute format('create policy staff_manage on public.%I for all to authenticated using(public.is_staff()) with check(public.is_staff())',n);
    execute format('grant insert,update,delete on public.%I to authenticated',n);
  end loop;
end $$;
create policy zone_admin_manage on public.service_zones for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy zone_rule_admin_manage on public.zone_rules for all to authenticated using(public.is_admin()) with check(public.is_admin());
grant insert,update,delete on public.service_zones,public.zone_rules to authenticated;
-- Public product reads must not expose acquisition costs.
revoke select on public.products from anon,authenticated;
grant select(id,category_id,name,slug,description,sku,price_centavos,stock_quantity,reserved_quantity,image_url,specifications,is_published,is_sample,created_at,updated_at) on public.products to anon,authenticated;
-- Health notes and exact reporter coordinates never have a public policy.
create policy health_staff_read on public.pet_health_records for select to authenticated using(public.is_staff() or public.has_role(auth.uid(),array['veterinarian']));
do $$ declare n text; begin
  foreach n in array array['inventory_movements','shelter_intakes','zone_rules','shelter_vehicles','shelter_drivers','coupons','expenses','email_outbox'] loop
    execute format('create policy staff_read on public.%I for select to authenticated using(public.is_staff())',n);
  end loop;
end $$;
create policy audit_admin_read on public.audit_logs for select to authenticated using(public.is_admin());
create policy webhook_admin_read on public.payment_webhook_events for select to authenticated using(public.is_admin());
create policy newsletter_admin_read on public.newsletter_subscriptions for select to authenticated using(public.is_admin());

create policy cart_item_owner_read on public.cart_items for select to authenticated using(exists(select 1 from public.carts c where c.id=cart_id and c.user_id=auth.uid()));
create policy cart_item_owner_write on public.cart_items for all to authenticated
 using(exists(select 1 from public.carts c where c.id=cart_id and c.user_id=auth.uid()))
 with check(exists(select 1 from public.carts c where c.id=cart_id and c.user_id=auth.uid())
   and exists(select 1 from public.products p where p.id=product_id and p.is_published)
   and (variant_id is null or exists(select 1 from public.product_variants v where v.id=variant_id and v.product_id=cart_items.product_id and v.is_active)));
grant insert,update,delete on public.cart_items to authenticated;
create policy wishlist_owner on public.wishlist_items for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
grant insert,delete on public.wishlist_items to authenticated;
create policy order_item_read on public.order_items for select to authenticated using(exists(select 1 from public.orders o where o.id=order_id and (o.user_id=auth.uid() or public.is_staff())));
create policy shipment_read on public.shipments for select to authenticated using(exists(select 1 from public.orders o where o.id=order_id and (o.user_id=auth.uid() or public.is_staff())));
create policy refund_read on public.refunds for select to authenticated using(exists(select 1 from public.payment_transactions p where p.id=payment_transaction_id and (p.user_id=auth.uid() or public.is_staff())));
create policy personality_answer_read on public.personality_answers for select to authenticated using(exists(select 1 from public.personality_assessments a where a.id=assessment_id and (a.user_id=auth.uid() or public.is_staff())));
create policy match_read on public.matching_results for select to authenticated using(exists(select 1 from public.personality_assessments a where a.id=assessment_id and (a.user_id=auth.uid() or public.is_staff())));
create policy application_review_read on public.application_reviews for select to authenticated using(public.is_staff());
create policy appointment_read on public.adoption_appointments for select to authenticated using(exists(select 1 from public.adoption_applications a where a.id=application_id and (a.user_id=auth.uid() or public.is_staff())));
create policy reservation_read on public.pet_reservations for select to authenticated using(exists(select 1 from public.adoption_applications a where a.id=application_id and (a.user_id=auth.uid() or public.is_staff())));
create policy report_read on public.stray_reports for select to authenticated using(public.can_read_report(id));
create policy report_photo_read on public.stray_report_photos for select to authenticated using(public.can_read_report(report_id));
create policy rescue_assignment_read on public.rescue_assignments for select to authenticated using(public.is_staff() or assigned_to=auth.uid());
create policy rescue_event_read on public.rescue_events for select to authenticated using(public.can_read_report(report_id));
create policy rescue_outcome_read on public.rescue_outcomes for select to authenticated using(public.can_read_report(report_id));
create policy transport_read on public.transport_requests for select to authenticated using(public.can_read_transport(id));
create policy transport_quote_read on public.transport_quotes for select to authenticated using(public.can_read_transport(transport_request_id));
create policy transport_event_read on public.transport_tracking_events for select to authenticated using(public.can_read_transport(transport_request_id));
create policy transport_handover_read on public.transport_handovers for select to authenticated using(public.can_read_transport(transport_request_id));
create policy volunteer_task_read on public.volunteer_tasks for select to authenticated using(volunteer_id=auth.uid() or public.is_staff());

-- Upload ownership is encoded in the first path segment. Publication requires staff action.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values
 ('listing-images','listing-images',true,5242880,array['image/jpeg','image/png','image/webp']),
 ('adoption-documents','adoption-documents',false,10485760,array['application/pdf','image/jpeg','image/png','image/webp']),
 ('rescue-evidence','rescue-evidence',false,10485760,array['image/jpeg','image/png','image/webp'])
on conflict(id) do nothing;
create policy listing_images_read on storage.objects for select using(bucket_id='listing-images');
create policy listing_images_staff_insert on storage.objects for insert to authenticated with check(bucket_id='listing-images' and public.is_staff());
create policy listing_images_staff_update on storage.objects for update to authenticated using(bucket_id='listing-images' and public.is_staff()) with check(bucket_id='listing-images' and public.is_staff());
create policy listing_images_staff_delete on storage.objects for delete to authenticated using(bucket_id='listing-images' and public.is_staff());
create policy private_upload_insert on storage.objects for insert to authenticated
 with check(bucket_id in ('adoption-documents','rescue-evidence') and (storage.foldername(name))[1]=auth.uid()::text);
create policy private_upload_read on storage.objects for select to authenticated
 using(bucket_id in ('adoption-documents','rescue-evidence') and ((storage.foldername(name))[1]=auth.uid()::text or public.is_staff()));

-- Only authorized rows are delivered to authenticated subscribers by Realtime.
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.notifications,public.orders,public.transport_tracking_events;
  end if;
end $$;

revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on function public.has_role(uuid,text[]),public.is_staff(),public.is_admin(),public.can_read_report(uuid),public.can_read_transport(uuid) to anon,authenticated,service_role;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public revoke execute on functions from public;
