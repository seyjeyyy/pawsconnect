-- Separate system administration from shelter operations.
--
-- Until now a super administrator counted as an administrator everywhere, and
-- an administrator could read every account, read the audit trail and assign
-- roles. They become two lines of authority, neither implying the other:
--   super_administrator  accounts and access, audit trail, security
--   administrator        shelter operations (store, animals, rescue, transport, money)
-- No rows are changed. Existing role assignments stay exactly as they are.

-- A role now means only itself.
create or replace function public.has_role(p_user_id uuid, p_roles text[])
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.user_roles where user_id = p_user_id and role_name = any(p_roles));
$$;

create function public.is_system_admin()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.has_role(auth.uid(), array['super_administrator']);
$$;

-- Assigning roles is system administration.
create or replace function public.assign_user_role(p_actor_id uuid, p_user_id uuid, p_role_name text, p_enabled boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role(p_actor_id, array['super_administrator']) then raise exception 'Super administrator required' using errcode = '42501'; end if;
  -- Serialize elevated membership changes, including last-holder checks.
  perform pg_advisory_xact_lock(hashtext('pawsconnect-role-administration'));
  if not p_enabled and p_role_name in ('administrator', 'super_administrator') then
    if p_actor_id = p_user_id and p_role_name = 'super_administrator' then raise exception 'Cannot remove your own super administrator role'; end if;
    if (select count(*) from public.user_roles where role_name = p_role_name) <= 1 then raise exception 'Cannot remove the last holder of this role'; end if;
  end if;
  if p_enabled then insert into public.user_roles(user_id, role_name, assigned_by) values(p_user_id, p_role_name, p_actor_id) on conflict do nothing;
  else delete from public.user_roles where user_id = p_user_id and role_name = p_role_name; end if;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details) values(p_actor_id, 'role.changed', 'profile', p_user_id, jsonb_build_object('role', p_role_name, 'enabled', p_enabled));
  insert into public.notifications(user_id, title, body, link, entity_type, entity_id) values(p_user_id, 'Account permissions updated', 'Your account permissions were updated.', '/account/settings', 'profiles', p_user_id);
end $$;

-- A request to grant or remove administrator-level access is filed by one
-- super administrator and decided by another (decide_critical_approval).
create or replace function public.guard_critical_request()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_role(new.requested_by, array['super_administrator']) or new.status <> 'pending' or new.decided_by is not null then raise exception 'Super administrator request required' using errcode = '42501'; end if;
  insert into public.audit_logs(actor_id, action, entity_type, entity_id, details) values(new.requested_by, 'critical_approval.requested', 'critical_approvals', new.id, jsonb_build_object('role', new.role_name, 'enabled', new.enabled));
  return new;
end $$;

-- Direct reads through Supabase follow the same split as the API.
drop policy user_roles_read on public.user_roles;
create policy user_roles_read on public.user_roles for select to authenticated using (user_id = auth.uid() or public.is_system_admin());
drop policy audit_admin_read on public.audit_logs;
create policy audit_admin_read on public.audit_logs for select to authenticated using (public.is_system_admin());
-- The super administrator manages accounts, so it can read profiles; it is no longer shelter staff, which is what granted that before.
drop policy profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (id = auth.uid() or public.is_staff() or public.is_system_admin());

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.has_role(uuid, text[]), public.is_staff(), public.is_admin(), public.is_system_admin(), public.can_read_report(uuid), public.can_read_transport(uuid), public.check_service_eligibility(text, double precision, double precision) to anon, authenticated, service_role;
grant execute on all functions in schema public to service_role;
