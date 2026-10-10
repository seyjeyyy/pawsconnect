-- PawsConnect. Apply through Supabase migrations; all amounts are PHP centavos.
create extension if not exists pgcrypto with schema extensions;
create extension if not exists postgis with schema extensions;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '', phone text, avatar_url text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.roles (name text primary key, description text not null);
insert into public.roles values
 ('buyer','Purchase pet supplies'),('adopter','Apply to adopt'),('donor','Support the shelter'),
 ('community_reporter','Report animals needing assistance'),('volunteer','Staff-approved volunteer'),
 ('rescue_personnel','Authorized rescue operations'),('shelter_driver','Authorized animal transport'),
 ('shelter_staff','Shelter operations'),('veterinarian','Veterinary records'),('administrator','Platform administration');
create table public.user_roles (
  user_id uuid not null references public.profiles on delete cascade,
  role_name text not null references public.roles(name),
  assigned_by uuid references public.profiles, assigned_at timestamptz not null default now(),
  primary key (user_id,role_name)
);
create table public.buyer_profiles (
  user_id uuid primary key references public.profiles on delete cascade,
  marketing_consent boolean not null default false, created_at timestamptz not null default now()
);
create table public.adopter_profiles (
  user_id uuid primary key references public.profiles on delete cascade,
  housing_type text, household jsonb not null default '{}', experience text,
  consent_at timestamptz, updated_at timestamptz not null default now()
);
create table public.customer_addresses (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles on delete cascade,
  label text not null default 'Home', recipient_name text not null, phone text not null,
  line1 text not null, barangay text not null default '', city text not null, province text not null,
  postal_code text, latitude double precision check(latitude between -90 and 90),
  longitude double precision check(longitude between -180 and 180), instructions text,
  is_default boolean not null default false, created_at timestamptz not null default now(),
  check ((latitude is null) = (longitude is null))
);
create index customer_addresses_user_idx on public.customer_addresses(user_id);

create table public.product_categories (
  id uuid primary key default gen_random_uuid(), name text not null, slug text not null unique,
  description text, image_url text, is_active boolean not null default true
);
create table public.products (
  id uuid primary key default gen_random_uuid(), category_id uuid references public.product_categories,
  name text not null, slug text not null unique, description text not null default '', sku text unique,
  price_centavos bigint not null check(price_centavos >= 0), cost_centavos bigint not null default 0 check(cost_centavos >= 0),
  stock_quantity integer not null default 0 check(stock_quantity >= 0),
  reserved_quantity integer not null default 0 check(reserved_quantity >= 0 and reserved_quantity <= stock_quantity),
  image_url text, specifications jsonb not null default '{}', is_published boolean not null default false,
  is_sample boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index products_catalog_idx on public.products(category_id,is_published,created_at desc);
create table public.product_images (
  id uuid primary key default gen_random_uuid(), product_id uuid not null references public.products on delete cascade,
  image_url text not null, alt_text text not null default '', position integer not null default 0
);
create table public.product_variants (
  id uuid primary key default gen_random_uuid(), product_id uuid not null references public.products on delete cascade,
  name text not null, sku text unique, attributes jsonb not null default '{}',
  price_centavos bigint not null check(price_centavos >= 0),
  stock_quantity integer not null default 0 check(stock_quantity >= 0),
  reserved_quantity integer not null default 0 check(reserved_quantity >= 0 and reserved_quantity <= stock_quantity),
  is_active boolean not null default true
);
create index product_variants_product_idx on public.product_variants(product_id);
create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(), product_id uuid not null references public.products,
  variant_id uuid references public.product_variants, quantity integer not null check(quantity <> 0),
  reason text not null, reference_id uuid, actor_id uuid references public.profiles,
  created_at timestamptz not null default now()
);
create table public.carts (
  id uuid primary key default gen_random_uuid(), user_id uuid not null unique references public.profiles on delete cascade,
  updated_at timestamptz not null default now()
);
create table public.cart_items (
  id uuid primary key default gen_random_uuid(), cart_id uuid not null references public.carts on delete cascade,
  product_id uuid not null references public.products, variant_id uuid references public.product_variants,
  quantity integer not null check(quantity between 1 and 99), created_at timestamptz not null default now()
);
create unique index cart_items_identity_idx on public.cart_items(cart_id,product_id,coalesce(variant_id,'00000000-0000-0000-0000-000000000000'::uuid));
create table public.coupons (
  id uuid primary key default gen_random_uuid(), code text not null unique check(code = upper(code)),
  discount_percent integer check(discount_percent between 1 and 100), discount_centavos bigint check(discount_centavos > 0),
  minimum_subtotal_centavos bigint not null default 0 check(minimum_subtotal_centavos >= 0),
  starts_at timestamptz not null default now(), expires_at timestamptz not null, is_active boolean not null default true,
  max_uses integer check(max_uses > 0), used_count integer not null default 0 check(used_count >= 0),
  reserved_count integer not null default 0 check(reserved_count >= 0),
  check ((discount_percent is null) <> (discount_centavos is null)), check(expires_at > starts_at)
);
create table public.orders (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles,
  order_number text not null unique default ('PC-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,12))),
  status text not null default 'pending_payment' check(status in ('pending_payment','paid','processing','ready_for_shipment','shipped','delivered','cancelled','refunded')),
  subtotal_centavos bigint not null check(subtotal_centavos >= 0), discount_centavos bigint not null default 0 check(discount_centavos >= 0),
  delivery_centavos bigint not null default 0 check(delivery_centavos >= 0), total_centavos bigint not null check(total_centavos >= 0),
  currency text not null default 'PHP' check(currency = 'PHP'), address_snapshot jsonb not null,
  coupon_id uuid references public.coupons, reservation_expires_at timestamptz not null default (now() + interval '30 minutes'),
  paid_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(total_centavos = subtotal_centavos - discount_centavos + delivery_centavos)
);
create index orders_user_idx on public.orders(user_id,created_at desc);
create index orders_expiry_idx on public.orders(reservation_expires_at) where status='pending_payment';
create table public.order_items (
  id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders,
  product_id uuid not null references public.products, variant_id uuid references public.product_variants,
  product_name text not null, quantity integer not null check(quantity between 1 and 99),
  unit_price_centavos bigint not null check(unit_price_centavos >= 0), unit_cost_centavos bigint not null default 0,
  line_total_centavos bigint not null check(line_total_centavos = quantity * unit_price_centavos)
);
create index order_items_order_idx on public.order_items(order_id);
create table public.payment_transactions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles,
  resource_type text not null check(resource_type in ('order','donation','transport','adoption')),
  resource_id uuid not null, provider text not null default 'paymongo' check(provider='paymongo'),
  provider_checkout_id text unique, provider_payment_id text unique, checkout_url text,
  amount_centavos bigint not null check(amount_centavos > 0), currency text not null default 'PHP' check(currency='PHP'),
  status text not null default 'pending' check(status in ('pending','paid','failed','paid_requires_review','refunded')),
  failure_reason text, created_at timestamptz not null default now(), paid_at timestamptz
);
create index payment_resource_idx on public.payment_transactions(resource_type,resource_id);
create unique index payment_pending_resource_idx on public.payment_transactions(resource_type,resource_id) where status='pending';
create table public.payment_webhook_events (
  provider_event_id text primary key, provider_payment_id text not null,
  resource_type text not null, resource_id uuid not null, result jsonb not null default '{}',
  processed_at timestamptz not null default now()
);
create table public.shipments (
  id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders,
  carrier text, tracking_number text, status text not null default 'preparing' check(status in ('preparing','shipped','delivered','returned')),
  shipped_at timestamptz, delivered_at timestamptz, created_at timestamptz not null default now()
);
create table public.refunds (
  id uuid primary key default gen_random_uuid(), payment_transaction_id uuid not null references public.payment_transactions,
  provider_refund_id text unique, amount_centavos bigint not null check(amount_centavos > 0),
  reason text not null, status text not null default 'pending' check(status in ('pending','succeeded','failed')),
  requested_by uuid not null references public.profiles, created_at timestamptz not null default now()
);
create table public.customer_reviews (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles,
  product_id uuid not null references public.products, order_item_id uuid not null unique references public.order_items,
  rating integer not null check(rating between 1 and 5), title text, body text not null,
  is_approved boolean not null default false, created_at timestamptz not null default now()
);
create table public.wishlist_items (
  user_id uuid not null references public.profiles on delete cascade, product_id uuid not null references public.products on delete cascade,
  created_at timestamptz not null default now(), primary key(user_id,product_id)
);

create table public.pets (
  id uuid primary key default gen_random_uuid(), name text not null, species text not null default 'dog', breed text,
  age_months integer check(age_months >= 0), sex text not null check(sex in ('male','female','unknown')),
  size text not null check(size in ('small','medium','large','unknown')), description text not null default '', image_url text,
  status text not null default 'assessment' check(status in ('assessment','available','reserved','adopted','unavailable')),
  adoption_fee_centavos bigint not null default 0 check(adoption_fee_centavos >= 0),
  is_published boolean not null default false, is_sample boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.pet_photos (
  id uuid primary key default gen_random_uuid(), pet_id uuid not null references public.pets on delete cascade,
  image_url text not null, alt_text text not null default '', position integer not null default 0
);
create table public.pet_behavior_profiles (
  pet_id uuid primary key references public.pets on delete cascade,
  energy_level integer check(energy_level between 1 and 5), temperament text[] not null default '{}',
  suitable_homes text[] not null default '{}', good_with_children boolean, good_with_dogs boolean, good_with_cats boolean,
  care_hours_daily numeric(4,1) check(care_hours_daily >= 0), max_hours_alone numeric(4,1) check(max_hours_alone between 0 and 24),
  experience_required integer check(experience_required between 1 and 5), grooming_level integer check(grooming_level between 1 and 5),
  exercise_minutes integer check(exercise_minutes >= 0), needs_outdoor_space boolean,
  verified_by uuid references public.profiles, verified_at timestamptz, notes text,
  check((verified_by is null) = (verified_at is null))
);
create table public.pet_health_records (
  id uuid primary key default gen_random_uuid(), pet_id uuid not null references public.pets,
  recorded_by uuid not null references public.profiles, record_type text not null, notes text not null,
  document_path text, occurred_at timestamptz not null default now(), created_at timestamptz not null default now()
);
create table public.shelter_intakes (
  id uuid primary key default gen_random_uuid(), pet_id uuid not null references public.pets,
  source text not null, notes text, recorded_by uuid not null references public.profiles, intake_at timestamptz not null default now()
);
create table public.personality_assessments (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles,
  answers jsonb not null default '{}', engine_version text not null default '1.0.0', created_at timestamptz not null default now()
);
create table public.personality_answers (
  assessment_id uuid not null references public.personality_assessments on delete cascade,
  question_key text not null, answer jsonb not null, primary key(assessment_id,question_key)
);
create table public.matching_results (
  id uuid primary key default gen_random_uuid(), assessment_id uuid not null references public.personality_assessments on delete cascade,
  pet_id uuid not null references public.pets, score numeric(5,2) check(score between 0 and 100),
  excluded boolean not null default false, reasons jsonb not null default '[]', uncertainties jsonb not null default '[]',
  factors jsonb not null default '{}', confidence integer check(confidence between 0 and 100), challenges jsonb not null default '[]',
  created_at timestamptz not null default now(), unique(assessment_id,pet_id)
);
create table public.adoption_applications (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles,
  pet_id uuid not null references public.pets,
  status text not null default 'submitted' check(status in ('submitted','under_review','information_requested','interview','approved','rejected','withdrawn','reserved','awaiting_handover','completed')),
  motivation text not null, household jsonb not null default '{}', document_paths text[] not null default '{}',
  fee_centavos bigint not null default 0 check(fee_centavos >= 0), fee_paid_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index adoption_active_app_idx on public.adoption_applications(user_id,pet_id)
 where status not in ('rejected','withdrawn','completed');
create table public.application_reviews (
  id uuid primary key default gen_random_uuid(), application_id uuid not null references public.adoption_applications,
  reviewer_id uuid not null references public.profiles, status text not null, notes text,
  created_at timestamptz not null default now()
);
create table public.adoption_appointments (
  id uuid primary key default gen_random_uuid(), application_id uuid not null references public.adoption_applications,
  scheduled_at timestamptz not null, location text not null, notes text,
  status text not null default 'scheduled' check(status in ('scheduled','completed','cancelled'))
);
create table public.pet_reservations (
  id uuid primary key default gen_random_uuid(), pet_id uuid not null references public.pets,
  application_id uuid not null references public.adoption_applications,
  status text not null default 'active' check(status in ('active','completed','cancelled','expired')),
  reserved_by uuid not null references public.profiles, expires_at timestamptz not null default (now()+interval '7 days'),
  created_at timestamptz not null default now()
);
create unique index one_active_reservation_per_pet on public.pet_reservations(pet_id) where status='active';
create unique index one_active_reservation_per_application on public.pet_reservations(application_id) where status='active';
create table public.completed_adoptions (
  id uuid primary key default gen_random_uuid(), pet_id uuid not null unique references public.pets,
  application_id uuid not null unique references public.adoption_applications, user_id uuid not null references public.profiles,
  handover_verified_by uuid not null references public.profiles, handover_notes text not null,
  completed_at timestamptz not null default now(), follow_up_at timestamptz not null default (now()+interval '14 days')
);

create table public.service_zones (
  id uuid primary key default gen_random_uuid(), name text not null,
  service_type text not null check(service_type in ('transport','rescue','delivery','donation_pickup','adoption')),
  province text not null, boundary extensions.geometry(MultiPolygon,4326) not null,
  source_reference text not null check(length(trim(source_reference)) > 0),
  is_active boolean not null default false, availability text not null default 'available' check(availability in ('available','temporarily_unavailable','manual_review')),
  fee_centavos bigint not null default 0 check(fee_centavos >= 0), created_by uuid not null references public.profiles,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(extensions.st_isvalid(boundary) and not extensions.st_isempty(boundary)),
  check(extensions.st_xmin(boundary::extensions.box3d) >= -180 and extensions.st_xmax(boundary::extensions.box3d) <= 180
    and extensions.st_ymin(boundary::extensions.box3d) >= -90 and extensions.st_ymax(boundary::extensions.box3d) <= 90),
  check(service_type not in ('transport','rescue') or lower(province)='bulacan')
);
create index service_zones_boundary_idx on public.service_zones using gist(boundary);
create index service_zones_type_idx on public.service_zones(service_type,is_active);
create table public.zone_rules (
  id uuid primary key default gen_random_uuid(), zone_id uuid not null references public.service_zones on delete cascade,
  rule_type text not null, configuration jsonb not null default '{}', is_active boolean not null default true
);
create table public.service_locations (
  id uuid primary key default gen_random_uuid(), user_id uuid references public.profiles,
  label text not null, address jsonb not null, location extensions.geography(Point,4326) not null,
  created_at timestamptz not null default now()
);
create index service_locations_geo_idx on public.service_locations using gist(location);

create table public.stray_reports (
  id uuid primary key default gen_random_uuid(), user_id uuid references public.profiles,
  animal_type text not null, animal_count integer not null default 1 check(animal_count between 1 and 1000),
  description text not null, condition text not null, observed_at timestamptz not null,
  province text not null, city text not null, barangay text not null default '',
  latitude double precision not null check(latitude between -90 and 90), longitude double precision not null check(longitude between -180 and 180),
  location extensions.geography(Point,4326) generated always as (extensions.st_setsrid(extensions.st_makepoint(longitude,latitude),4326)::extensions.geography) stored,
  address text, reporter_contact text, notes text, coverage_status text not null default 'manual_review_required' check(coverage_status in ('within_coverage','outside_coverage','temporarily_unavailable','manual_review_required')),
  status text not null default 'submitted' check(status in ('submitted','under_verification','verified','assigned','in_progress','resolved','closed','invalid','duplicate','declined','referred')),
  urgency text not null default 'unassessed' check(urgency in ('unassessed','low','medium','high','critical')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index stray_reports_geo_idx on public.stray_reports using gist(location);
create index stray_reports_user_idx on public.stray_reports(user_id,created_at desc);
create table public.stray_report_photos (
  id uuid primary key default gen_random_uuid(), report_id uuid not null references public.stray_reports on delete cascade,
  storage_path text not null, created_at timestamptz not null default now()
);
create table public.rescue_assignments (
  id uuid primary key default gen_random_uuid(), report_id uuid not null references public.stray_reports,
  assigned_to uuid not null references public.profiles, assigned_by uuid not null references public.profiles,
  status text not null default 'assigned' check(status in ('assigned','in_progress','completed','cancelled')),
  notes text, created_at timestamptz not null default now(), unique(report_id,assigned_to)
);
create table public.rescue_events (
  id uuid primary key default gen_random_uuid(), report_id uuid not null references public.stray_reports,
  actor_id uuid not null references public.profiles, status text not null, notes text, created_at timestamptz not null default now()
);
create table public.rescue_outcomes (
  id uuid primary key default gen_random_uuid(), report_id uuid not null unique references public.stray_reports,
  recorded_by uuid not null references public.profiles, outcome text not null, notes text, created_at timestamptz not null default now()
);

create table public.shelter_vehicles (
  id uuid primary key default gen_random_uuid(), name text not null, plate_number text not null unique,
  animal_capacity integer not null check(animal_capacity > 0), is_active boolean not null default true, notes text
);
create table public.shelter_drivers (
  user_id uuid primary key references public.profiles, license_reference text not null,
  verified_by uuid not null references public.profiles, is_active boolean not null default false,
  created_at timestamptz not null default now()
);
create table public.transport_requests (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles,
  pet_id uuid references public.pets, adoption_application_id uuid references public.adoption_applications,
  pet_details text not null, pickup_address text not null, dropoff_address text not null,
  pickup_latitude double precision not null check(pickup_latitude between -90 and 90), pickup_longitude double precision not null check(pickup_longitude between -180 and 180),
  dropoff_latitude double precision not null check(dropoff_latitude between -90 and 90), dropoff_longitude double precision not null check(dropoff_longitude between -180 and 180),
  preferred_schedule timestamptz not null, confirmed_schedule timestamptz, contact_phone text not null, handling_requirements text,
  status text not null default 'submitted' check(status in ('submitted','under_review','quoted','confirmed','paid','scheduled','picked_up','in_transit','arrived','completed','declined','cancelled')),
  coverage_status text not null default 'manual_review_required' check(coverage_status in ('within_coverage','outside_coverage','temporarily_unavailable','manual_review_required')),
  driver_id uuid references public.shelter_drivers(user_id), vehicle_id uuid references public.shelter_vehicles,
  fee_centavos bigint check(fee_centavos >= 0), paid_at timestamptz,
  fuel_cost_centavos bigint not null default 0 check(fuel_cost_centavos >= 0), staff_cost_centavos bigint not null default 0 check(staff_cost_centavos >= 0),
  other_cost_centavos bigint not null default 0 check(other_cost_centavos >= 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index transport_requests_user_idx on public.transport_requests(user_id,created_at desc);
create table public.alternative_transport_requests (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles,
  transport_request_id uuid references public.transport_requests, adoption_application_id uuid references public.adoption_applications,
  arrangement_type text not null check(arrangement_type in ('self_pickup','customer_arranged','shelter_assisted')),
  details text not null, transporter_name text, transporter_contact text,
  status text not null default 'submitted' check(status in ('submitted','under_review','approved','declined','completed','cancelled')),
  reviewed_by uuid references public.profiles, review_notes text, created_at timestamptz not null default now()
);
create table public.transport_quotes (
  id uuid primary key default gen_random_uuid(), transport_request_id uuid not null references public.transport_requests,
  amount_centavos bigint not null check(amount_centavos >= 0), breakdown jsonb not null default '{}',
  quoted_by uuid not null references public.profiles, expires_at timestamptz not null, accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.transport_tracking_events (
  id uuid primary key default gen_random_uuid(), transport_request_id uuid not null references public.transport_requests,
  actor_id uuid not null references public.profiles, status text not null, notes text,
  created_at timestamptz not null default now()
);
create table public.transport_handovers (
  id uuid primary key default gen_random_uuid(), transport_request_id uuid not null unique references public.transport_requests,
  recipient_name text not null, confirmed_by uuid not null references public.profiles,
  notes text not null, recipient_confirmed_at timestamptz not null, created_at timestamptz not null default now()
);

create table public.donations (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles,
  donation_type text not null check(donation_type in ('monetary','in_kind')), amount_centavos bigint check(amount_centavos > 0),
  description text, donor_name text, is_anonymous boolean not null default false,
  status text not null default 'pending' check(status in ('pending','paid','pledged','received','cancelled')),
  paid_at timestamptz, created_at timestamptz not null default now(),
  check((donation_type='monetary' and amount_centavos is not null) or (donation_type='in_kind' and amount_centavos is null))
);
create table public.volunteer_profiles (
  user_id uuid primary key references public.profiles, motivation text not null,
  skills text[] not null default '{}', availability jsonb not null default '{}',
  status text not null default 'submitted' check(status in ('submitted','under_review','approved','declined','inactive')),
  reviewed_by uuid references public.profiles, created_at timestamptz not null default now()
);
create table public.volunteer_tasks (
  id uuid primary key default gen_random_uuid(), volunteer_id uuid not null references public.volunteer_profiles(user_id),
  assigned_by uuid not null references public.profiles, title text not null, description text,
  status text not null default 'assigned' check(status in ('assigned','in_progress','completed','cancelled')),
  scheduled_at timestamptz, created_at timestamptz not null default now()
);
create table public.notifications (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles on delete cascade,
  title text not null, body text not null, link text, read_at timestamptz, created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications(user_id,created_at desc);
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(), actor_id uuid references public.profiles,
  action text not null, entity_type text not null, entity_id uuid, details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table public.expenses (
  id uuid primary key default gen_random_uuid(), category text not null, description text not null,
  amount_centavos bigint not null check(amount_centavos > 0), recorded_by uuid not null references public.profiles,
  occurred_at date not null, created_at timestamptz not null default now()
);
create table public.newsletter_subscriptions (
  id uuid primary key default gen_random_uuid(), email text not null unique,
  consent_at timestamptz not null default now(), confirmed_at timestamptz, unsubscribed_at timestamptz
);
create table public.contact_messages (
  id uuid primary key default gen_random_uuid(), user_id uuid references public.profiles,
  name text not null, email text not null, message text not null,
  status text not null default 'unread' check(status in ('unread','read','replied')),
  created_at timestamptz not null default now()
);
create table public.email_outbox (
  id uuid primary key default gen_random_uuid(), to_email text not null, subject text not null, text text not null,
  status text not null default 'pending' check(status in ('pending','sending','sent','failed')),
  attempts integer not null default 0 check(attempts >= 0), last_error text, sent_at timestamptz,
  created_at timestamptz not null default now()
);
