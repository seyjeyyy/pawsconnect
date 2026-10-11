create function public.resolve_security_alert(p_actor_id uuid,p_alert_id uuid,p_notes text)
returns public.security_alerts language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.security_alerts; begin
 if not public.has_role(p_actor_id,array['super_administrator']) then raise exception 'Super administrator required' using errcode='42501'; end if;
 if length(trim(p_notes))<10 then raise exception 'Record the investigation outcome'; end if;
 update public.security_alerts set status='resolved',resolution_notes=p_notes,resolved_at=now(),resolved_by=p_actor_id where id=p_alert_id and status='open' returning * into v;
 if not found then raise exception 'Alert is not open'; end if;
 insert into public.audit_logs(actor_id,action,entity_type,entity_id) values(p_actor_id,'security_alert.resolved','security_alerts',v.id);
 return v;
end $$;
create function public.security_metrics(p_actor_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if not public.has_role(p_actor_id,array['super_administrator']) then raise exception 'Super administrator required' using errcode='42501'; end if;
 return jsonb_build_object(
  'registered_users',(select count(*) from public.profiles),
  'administrators',(select count(distinct user_id) from public.user_roles where role_name in ('administrator','super_administrator')),
  'role_assignments',(select count(*) from public.user_roles),
  'authorization_denials',(select count(*) from public.security_events),
  'open_alerts',(select count(*) from public.security_alerts where status='open'),
  'resolved_alerts',(select count(*) from public.security_alerts where status='resolved'),
  'pending_critical_approvals',(select count(*) from public.critical_approvals where status='pending'),
  'audit_events',(select count(*) from public.audit_logs),
  'source_note','Authorization denials recorded by this API. Authentication provider login events are not imported. Counts do not imply users are currently online.');
end $$;
-- The API verifies actor and elevated role changes; direct SQL remains a documented bootstrap path.
create function public.guard_critical_request()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not public.has_role(new.requested_by,array['administrator']) or new.status<>'pending' or new.decided_by is not null then raise exception 'Administrator request required' using errcode='42501'; end if;
 insert into public.audit_logs(actor_id,action,entity_type,entity_id,details) values(new.requested_by,'critical_approval.requested','critical_approvals',new.id,jsonb_build_object('role',new.role_name,'enabled',new.enabled));
 return new;
end $$;
create trigger critical_requested before insert on public.critical_approvals for each row execute function public.guard_critical_request();
-- Role changes submitted by the browser cannot bypass approval for elevated roles.
-- The reviewing RPC calls assign_user_role within its transaction.

-- Prevent sample pets from accepting applications even through service-role inserts.
create or replace function public.guard_application_insert()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.status<>'submitted' then raise exception 'New applications must be submitted for review'; end if;
 perform id from public.pets where id=new.pet_id and status='available' and is_published and not is_sample for update;
 if not found then raise exception 'Pet is not available for applications'; end if;
 if new.fee_paid_at is not null then raise exception 'Fee payment can only be recorded after provider verification'; end if;
 new.fee_centavos:=0;
 return new;
end $$;

-- Staff and customers read notification contents only when they are the recipient.
drop policy owner_or_staff_read on public.notifications;
create policy notification_recipient on public.notifications for select to authenticated using(user_id=auth.uid());

-- Use actor-bound, RLS-protected invalidation messages for changes not covered by
-- existing notification-generating workflow functions. Never expose changed row payloads.
create function public.notify_assigned_task()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into public.notifications(user_id,title,body,link,entity_type,entity_id) values(new.volunteer_id,'Volunteer task updated',new.title||': '||replace(new.status,'_',' '),'/account/volunteer','volunteer_tasks',new.id);
 return new;
end $$;
create trigger volunteer_task_changed after insert or update of status on public.volunteer_tasks for each row execute function public.notify_assigned_task();

revoke execute on all functions in schema public from public,anon,authenticated;
grant execute on function public.has_role(uuid,text[]),public.is_staff(),public.is_admin(),public.can_read_report(uuid),public.can_read_transport(uuid) to anon,authenticated,service_role;
grant execute on all functions in schema public to service_role;
