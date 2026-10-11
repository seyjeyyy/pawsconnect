-- Additive operations controls. Apply before deploying the corresponding API.
-- No history is seeded. External job results must come from the protected worker.
create table public.operations_config (
 id boolean primary key default true check (id), version integer not null default 1, schema_version text not null default '015',
 mode text not null default 'normal' check(mode in ('normal','read_only','partial','full','lockdown')),
 modules text[] not null default '{}', starts_at timestamptz, ends_at timestamptz,
 public_notice text not null default '', instructions text not null default '', reason text not null default '',
 disabled_features text[] not null default '{}', slow_request_ms integer not null default 2000 check(slow_request_ms between 250 and 30000),
 backup_interval_hours integer check(backup_interval_hours between 1 and 168), retention_days integer not null default 30 check(retention_days between 7 and 365),
 rpo_minutes integer not null default 1440 check(rpo_minutes between 1 and 10080), rto_minutes integer not null default 240 check(rto_minutes between 1 and 10080),
 updated_by uuid references public.profiles(id), updated_at timestamptz not null default now(),
 check(mode='normal' or (starts_at is not null and ends_at is not null and ends_at>starts_at and ends_at<=starts_at+interval '24 hours')),
 check(modules <@ array['shop','adoption','rescue','transport','donations','volunteers','uploads','account']::text[]),
 check(disabled_features <@ array['shop','adoption','rescue','transport','donations','volunteers','uploads']::text[]),
 check(mode<>'partial' or cardinality(modules)>0)
);
insert into public.operations_config(id) values(true);

create table public.operations_incidents (
 id uuid primary key default gen_random_uuid(), title text not null check(length(title) between 5 and 200),
 severity text not null check(severity in ('low','medium','high','critical')), service text not null,
 classification text not null default 'availability', status text not null default 'open' check(status in ('open','investigating','resolved')),
 assigned_to uuid references public.profiles(id), created_by uuid references public.profiles(id),
 resolution text, postmortem text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), resolved_at timestamptz,
 check(status<>'resolved' or length(trim(resolution))>=10)
);
create index operations_incidents_status on public.operations_incidents(status,created_at desc);
create table public.operations_incident_events (
 id uuid primary key default gen_random_uuid(), incident_id uuid not null references public.operations_incidents(id),
 actor_id uuid references public.profiles(id), action text not null, notes text not null,
 created_at timestamptz not null default now()
);
create index operations_incident_timeline on public.operations_incident_events(incident_id,created_at);

-- Aggregates only: no URLs, query strings, user bodies, tokens, or raw exceptions.
create table public.operations_telemetry (
 bucket timestamptz not null, service text not null, status_class integer not null check(status_class between 2 and 5),
 requests bigint not null default 0, duration_ms bigint not null default 0, slow_requests bigint not null default 0,
 primary key(bucket,service,status_class)
);
create table public.operations_signals (
 id uuid primary key default gen_random_uuid(), source text not null, code text not null, severity text not null,
 created_at timestamptz not null default now(), incident_id uuid references public.operations_incidents(id)
);
create index operations_signals_time on public.operations_signals(created_at desc);
create table public.operations_jobs (
 id uuid primary key default gen_random_uuid(), kind text not null check(kind in ('expire_order_reservations','expire_pet_reservations','retention')),
 status text not null check(status in ('running','succeeded','failed')), started_at timestamptz not null default clock_timestamp(),
 finished_at timestamptz, affected_rows integer, error_code text, actor_id uuid references public.profiles(id)
);
create index operations_jobs_time on public.operations_jobs(started_at desc);

create table public.operations_requests (
 id uuid primary key default gen_random_uuid(), idempotency_key uuid not null unique,
 kind text not null check(kind in ('backup','restore_drill','restore_production','deployment','rollback')),
 target text not null check(target in ('staging','production')), reason text not null check(length(trim(reason)) between 10 and 2000),
 requested_by uuid references public.profiles(id), approved_by uuid references public.profiles(id), approved_at timestamptz,
 status text not null check(status in ('pending_approval','queued','running','succeeded','failed','rejected','unknown')),
 recovery_point_id uuid references public.operations_requests(id), pre_restore_backup_id uuid references public.operations_requests(id),
 release_ref text, lease_token uuid, lease_expires_at timestamptz,
 created_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz,
 report jsonb, failure_code text,
 check(approved_by is null or approved_by<>requested_by),
 check(kind<>'restore_drill' or target='staging'),
 check(kind<>'restore_production' or target='production'),
 check(kind='backup' or status not in ('queued','running','succeeded') or (approved_by is not null and approved_at is not null))
);
create index operations_requests_status on public.operations_requests(status,created_at);
create table public.tour_progress (
 user_id uuid not null references public.profiles(id) on delete cascade, tour_key text not null check(length(tour_key) between 3 and 100),
 step integer not null check(step between 0 and 100), status text not null check(status in ('paused','completed','dismissed')),
 updated_at timestamptz not null default now(), primary key(user_id,tour_key)
);
alter table public.tour_progress enable row level security;
revoke all on public.tour_progress from anon,authenticated;
grant select on public.tour_progress to authenticated;
create policy tour_owner on public.tour_progress for select to authenticated using(user_id=auth.uid());

do $$ declare t text; begin
 foreach t in array array['operations_config','operations_incidents','operations_incident_events','operations_telemetry','operations_signals','operations_jobs','operations_requests'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy system_mfa_read on public.%I for select to authenticated using(public.has_role(auth.uid(),array[''super_administrator'']) and auth.jwt()->>''aal''=''aal2'')',t);
 end loop;
end $$;
-- Worker lease capabilities are never exposed through the browser's Supabase API.
revoke select on public.operations_requests from authenticated;

create function public.change_operations_config(p_actor_id uuid,p_version integer,p_config jsonb)
returns public.operations_config language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.operations_config; begin
 if not public.has_role(p_actor_id,array['super_administrator']) then raise exception 'Super administrator required' using errcode='42501'; end if;
 select * into v from public.operations_config where id for update;
 if v.version<>p_version then raise exception 'Settings changed. Reload and review the latest version.'; end if;
 if length(trim(p_config->>'reason'))<10 then raise exception 'A change reason is required'; end if;
 update public.operations_config set version=version+1,mode=p_config->>'mode',
  modules=array(select jsonb_array_elements_text(p_config->'modules')),
  starts_at=(p_config->>'starts_at')::timestamptz,ends_at=(p_config->>'ends_at')::timestamptz,
  public_notice=p_config->>'public_notice',instructions=p_config->>'instructions',reason=p_config->>'reason',
  disabled_features=array(select jsonb_array_elements_text(p_config->'disabled_features')),
  slow_request_ms=(p_config->>'slow_request_ms')::integer,
  backup_interval_hours=(p_config->>'backup_interval_hours')::integer,retention_days=(p_config->>'retention_days')::integer,
  rpo_minutes=(p_config->>'rpo_minutes')::integer,rto_minutes=(p_config->>'rto_minutes')::integer,
  updated_by=p_actor_id,updated_at=now() where id returning * into v;
 insert into public.audit_logs(actor_id,action,entity_type,details) values(p_actor_id,'operations.config_changed','operations_config',jsonb_build_object('version',v.version,'config',to_jsonb(v)));
 return v;
end $$;

create function public.save_operations_incident(p_actor_id uuid,p_id uuid,p_input jsonb)
returns public.operations_incidents language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.operations_incidents; v_assignee uuid:=(p_input->>'assigned_to')::uuid; begin
 if not public.has_role(p_actor_id,array['super_administrator']) then raise exception 'Super administrator required' using errcode='42501'; end if;
 if v_assignee is not null and not public.has_role(v_assignee,array['super_administrator']) then raise exception 'Responder must have system access'; end if;
 if length(trim(p_input->>'notes'))<10 then raise exception 'Investigation notes are required'; end if;
 if p_id is null then
  insert into public.operations_incidents(title,severity,service,classification,assigned_to,created_by)
  values(p_input->>'title',p_input->>'severity',p_input->>'service',p_input->>'classification',v_assignee,p_actor_id) returning * into v;
 else
  select * into v from public.operations_incidents where id=p_id for update;
  if not found then raise exception 'Incident not found'; end if;
  update public.operations_incidents set status=p_input->>'status',assigned_to=v_assignee,
   resolution=p_input->>'resolution',postmortem=p_input->>'postmortem',updated_at=now(),
   resolved_at=case when p_input->>'status'='resolved' then coalesce(resolved_at,now()) else null end
  where id=p_id returning * into v;
 end if;
 insert into public.operations_incident_events(incident_id,actor_id,action,notes) values(v.id,p_actor_id,v.status,p_input->>'notes');
 insert into public.audit_logs(actor_id,action,entity_type,entity_id,details) values(p_actor_id,'operations.incident_changed','operations_incidents',v.id,jsonb_build_object('status',v.status));
 return v;
end $$;

create function public.record_operations_request(p_actor_id uuid,p_key uuid,p_kind text,p_target text,p_reason text,p_recovery_point uuid,p_pre_backup uuid,p_release_ref text)
returns public.operations_requests language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.operations_requests; begin
 if not public.has_role(p_actor_id,array['super_administrator']) then raise exception 'Super administrator required' using errcode='42501'; end if;
 -- Repeated clicks/network retries never submit a second job.
 perform pg_advisory_xact_lock(hashtextextended(p_key::text,0));
 select * into v from public.operations_requests where idempotency_key=p_key;
 if found then
  if v.requested_by is distinct from p_actor_id or v.kind<>p_kind or v.target<>p_target or v.reason<>p_reason or v.recovery_point_id is distinct from p_recovery_point or v.pre_restore_backup_id is distinct from p_pre_backup or v.release_ref is distinct from p_release_ref then raise exception 'Idempotency key is already in use'; end if;
  return v;
 end if;
 if p_kind in ('restore_drill','restore_production') then
  if not exists(select 1 from public.operations_requests where id=p_recovery_point and kind='backup' and status='succeeded' and report->>'integrity_verified'='true' and report->>'database_covered'='true' and report->>'storage_covered'='true') then raise exception 'A verified database and Storage recovery point is required'; end if;
 end if;
 if p_kind='restore_production' then
  if not exists(select 1 from public.operations_requests where kind='restore_drill' and status='succeeded' and recovery_point_id=p_recovery_point and report->>'validation_passed'='true' and finished_at>now()-interval '7 days') then raise exception 'A successful staging drill of this recovery point within seven days is required'; end if;
  if not exists(select 1 from public.operations_requests where id=p_pre_backup and kind='backup' and target='production' and status='succeeded' and report->>'integrity_verified'='true' and report->>'storage_covered'='true' and finished_at>now()-interval '1 hour') then raise exception 'A verified production safety backup within one hour is required'; end if;
 end if;
 insert into public.operations_requests(idempotency_key,kind,target,reason,requested_by,status,recovery_point_id,pre_restore_backup_id,release_ref)
 values(p_key,p_kind,p_target,p_reason,p_actor_id,case when p_kind='backup' then 'queued' else 'pending_approval' end,p_recovery_point,p_pre_backup,p_release_ref) returning * into v;
 insert into public.audit_logs(actor_id,action,entity_type,entity_id,details) values(p_actor_id,'operations.requested','operations_requests',v.id,jsonb_build_object('kind',p_kind,'target',p_target,'reason',p_reason));
 return v;
end $$;

create function public.decide_operations_request(p_actor_id uuid,p_id uuid,p_approve boolean,p_notes text)
returns public.operations_requests language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.operations_requests; begin
 if not public.has_role(p_actor_id,array['super_administrator']) then raise exception 'Super administrator required' using errcode='42501'; end if;
 select * into v from public.operations_requests where id=p_id for update;
 if not found or v.status<>'pending_approval' then raise exception 'Request is no longer pending'; end if;
 if v.requested_by=p_actor_id then raise exception 'A different super administrator must decide this request' using errcode='42501'; end if;
 if length(trim(p_notes))<10 then raise exception 'Decision notes are required'; end if;
 update public.operations_requests set status=case when p_approve then 'queued' else 'rejected' end,approved_by=p_actor_id,approved_at=now() where id=p_id returning * into v;
 insert into public.audit_logs(actor_id,action,entity_type,entity_id,details) values(p_actor_id,'operations.decided','operations_requests',p_id,jsonb_build_object('approved',p_approve,'notes',p_notes));
 return v;
end $$;

create function public.claim_operations_request(p_kinds text[])
returns public.operations_requests language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.operations_requests; c public.operations_config; begin
 -- Serialize scheduler decisions. Polling twice cannot create two scheduled exports.
 perform pg_advisory_xact_lock(hashtextextended('operations-backup-schedule',0));
 select * into c from public.operations_config where id;
 if 'backup'=any(p_kinds) and c.backup_interval_hours is not null
  and not exists(select 1 from public.operations_requests where kind='backup' and target='production' and (status in ('queued','running') or created_at>now()-make_interval(hours=>c.backup_interval_hours))) then
  insert into public.operations_requests(idempotency_key,kind,target,reason,status) values(gen_random_uuid(),'backup','production','Scheduled backup under approved operations policy','queued');
 end if;
 -- Never automatically replay a recovery with an ambiguous outcome.
 with expired as (update public.operations_requests set status='unknown',failure_code='WORKER_LEASE_EXPIRED' where status='running' and lease_expires_at<now() returning id)
 insert into public.operations_signals(source,code,severity) select 'worker','WORKER_LEASE_EXPIRED','high' from expired;
 -- Never dispatch production restore from a queue inside the restore target.
 -- An external durable coordinator/fence is required before this can be enabled.
 select * into v from public.operations_requests where status='queued' and kind<>'restore_production' and kind=any(p_kinds) order by created_at for update skip locked limit 1;
 if not found then return null; end if;
 -- A timed-out worker may still be acting. A fresh request must not bypass
 -- reconciliation of that target or overlap another disruptive operation.
 if v.kind<>'backup' and exists(select 1 from public.operations_requests where id<>v.id and target=v.target and kind<>'backup' and status in ('running','unknown')) then return null; end if;
 if v.requested_by is not null and not public.has_role(v.requested_by,array['super_administrator']) then
  update public.operations_requests set status='rejected',failure_code='REQUESTER_ACCESS_REMOVED',finished_at=clock_timestamp() where id=v.id;
  insert into public.audit_logs(action,entity_type,entity_id) values('operations.requester_access_removed','operations_requests',v.id);
  return null;
 end if;
 if v.kind<>'backup' and (v.approved_at is null or v.approved_at<now()-interval '30 minutes' or not public.has_role(v.approved_by,array['super_administrator'])) then
  update public.operations_requests set status='pending_approval',approved_at=null,approved_by=null where id=v.id; return null;
 end if;
 update public.operations_requests set status='running',started_at=clock_timestamp(),lease_token=gen_random_uuid(),lease_expires_at=now()+interval '30 minutes' where id=v.id returning * into v;
 insert into public.audit_logs(action,entity_type,entity_id) values('operations.worker_claimed','operations_requests',v.id);
 return v;
end $$;

-- Direct browser writes must obey maintenance too. Service-role writes remain
-- behind the API guard; settlement and expiry jobs deliberately remain available.
create function public.guard_direct_maintenance_write()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.operations_config; begin
 if auth.uid() is not null and coalesce(auth.role(),'')<>'service_role' then
  select * into c from public.operations_config where id;
  if tg_argv[0]=any(c.disabled_features) or (c.mode<>'normal' and c.starts_at<=now() and c.ends_at>now() and (c.mode<>'partial' or tg_argv[0]=any(c.modules))) then
   raise exception 'This service is paused for maintenance' using errcode='42501';
  end if;
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
do $$ declare r record; begin
 for r in select * from (values
 ('profiles','account'),('buyer_profiles','account'),('adopter_profiles','adoption'),('notifications','account'),('customer_addresses','account'),('carts','shop'),('cart_items','shop'),('wishlist_items','shop'),
 ('favorite_pets','adoption'),('personality_assessments','adoption'),('personality_answers','adoption'),('matching_results','adoption'),
 ('adoption_applications','adoption'),('stray_reports','rescue'),('stray_report_photos','rescue'),('transport_requests','transport'),
 ('alternative_transport_requests','transport'),('donations','donations'),('volunteer_profiles','volunteers'),('customer_reviews','shop'),
 ('contact_messages','account'),('newsletter_subscriptions','account')) as x(t,m) loop
  execute format('create trigger maintenance_write before insert or update or delete on public.%I for each row execute function public.guard_direct_maintenance_write(%L)',r.t,r.m);
 end loop;
end $$;
create trigger maintenance_upload before insert or update or delete on storage.objects for each row execute function public.guard_direct_maintenance_write('uploads');
revoke all on function public.guard_direct_maintenance_write() from public,anon,authenticated;
grant execute on function public.guard_direct_maintenance_write() to service_role;

create function public.complete_operations_request(p_id uuid,p_lease uuid,p_succeeded boolean,p_report jsonb,p_failure text)
returns public.operations_requests language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.operations_requests; begin
 select * into v from public.operations_requests where id=p_id for update;
 if not found or v.lease_token is distinct from p_lease or v.status<>'running' or v.lease_expires_at<now() then raise exception 'Worker lease is not valid'; end if;
 if p_succeeded and v.kind='backup' and not(coalesce(p_report->>'integrity_verified','false')='true' and coalesce(p_report->>'database_covered','false')='true' and coalesce(p_report->>'storage_covered','false')='true' and coalesce(p_report->>'encrypted_offsite','false')='true' and coalesce(p_report->>'sha256','')~'^[a-f0-9]{64}$') then raise exception 'Backup verification evidence is incomplete'; end if;
 if p_succeeded and v.kind='backup' and (coalesce(p_report->>'artifact_ref','')!~'^[a-zA-Z0-9/_:.-]+$' or length(p_report->>'artifact_ref')>300 or coalesce((p_report->>'bytes')::bigint,0)<=0) then raise exception 'A non-empty immutable backup artifact reference and size are required'; end if;
 if p_succeeded and v.kind in ('restore_drill','restore_production') and coalesce(p_report->>'validation_passed','false')<>'true' then raise exception 'Post-restore validation is required'; end if;
 if p_succeeded and v.kind in ('deployment','rollback') and (coalesce(p_report->>'validation_passed','false')<>'true' or p_report->>'release_ref' is distinct from v.release_ref) then raise exception 'Release identity and post-deployment validation are required'; end if;
 update public.operations_requests set status=case when p_succeeded then 'succeeded' else 'failed' end,finished_at=clock_timestamp(),report=p_report,failure_code=p_failure,lease_token=null,lease_expires_at=null where id=p_id returning * into v;
 insert into public.audit_logs(action,entity_type,entity_id,details) values('operations.worker_completed','operations_requests',p_id,jsonb_build_object('status',v.status));
 if not p_succeeded then
  insert into public.operations_signals(source,code,severity) values(v.kind,coalesce(p_failure,'WORKER_FAILED'),'high');
 end if;
 return v;
end $$;

create function public.record_operations_telemetry(p_service text,p_status integer,p_duration integer,p_slow boolean)
returns void language sql security definer set search_path=public,pg_temp as $$
 insert into public.operations_telemetry(bucket,service,status_class,requests,duration_ms,slow_requests)
 values(date_trunc('hour',now()),p_service,p_status,1,greatest(0,least(p_duration,300000)),case when p_slow then 1 else 0 end)
 on conflict(bucket,service,status_class) do update set requests=operations_telemetry.requests+1,duration_ms=operations_telemetry.duration_ms+excluded.duration_ms,slow_requests=operations_telemetry.slow_requests+excluded.slow_requests;
$$;

-- A fixed job allow-list; no SQL or commands supplied by a browser are executed.
create function public.run_operations_job(p_kind text,p_actor_id uuid default null)
returns public.operations_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.operations_jobs; n integer:=0; begin
 if p_actor_id is not null and not public.has_role(p_actor_id,array['super_administrator']) then raise exception 'Super administrator required' using errcode='42501'; end if;
 if p_kind not in ('expire_order_reservations','expire_pet_reservations','retention') then raise exception 'Unknown job'; end if;
 if not pg_try_advisory_xact_lock(hashtextextended('operations-job-'||p_kind,0)) then return null; end if;
 insert into public.operations_jobs(kind,status,actor_id) values(p_kind,'running',p_actor_id) returning * into v;
 begin
  if p_kind='expire_order_reservations' then n:=public.expire_order_reservations();
  elsif p_kind='expire_pet_reservations' then n:=public.expire_pet_reservations();
  else
   delete from public.operations_telemetry where bucket<now()-interval '30 days'; get diagnostics n=row_count;
   delete from public.operations_signals where created_at<now()-interval '90 days' and incident_id is null;
  end if;
  update public.operations_jobs set status='succeeded',finished_at=clock_timestamp(),affected_rows=n where id=v.id returning * into v;
 exception when others then
  update public.operations_jobs set status='failed',finished_at=clock_timestamp(),error_code=sqlstate where id=v.id returning * into v;
  insert into public.operations_signals(source,code,severity) values(p_kind,sqlstate,'high');
 end;
 return v;
end $$;

create function public.operations_diagnostics(p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not public.has_role(p_actor_id,array['super_administrator']) then raise exception 'Super administrator required' using errcode='42501'; end if;
 return jsonb_build_object('schema_version',(select schema_version from public.operations_config where id),'database_bytes',pg_database_size(current_database()),
  'connections',(select count(*) from pg_stat_activity where datname=current_database()),
  'long_queries',(select count(*) from pg_stat_activity where datname=current_database() and state='active' and query_start<now()-interval '5 seconds'),
  'pending_email',(select count(*) from public.email_outbox where sent_at is null),
  'storage_objects',(select count(*) from storage.objects),
  'unresolved_incidents',(select count(*) from public.operations_incidents where status<>'resolved'));
end $$;

-- Close all newly created privileged functions, including Supabase's explicit default grants.
do $$ declare f record; begin
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('change_operations_config','save_operations_incident','record_operations_request','decide_operations_request','claim_operations_request','complete_operations_request','record_operations_telemetry','run_operations_job','operations_diagnostics') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
