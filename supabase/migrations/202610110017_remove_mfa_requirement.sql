-- Remove the application MFA requirement at the project owner's request.
-- Preserve current-session checks, account suspension, role isolation and approvals.
create or replace function public.current_session_allowed()
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select public.account_session_allowed(auth.uid(),nullif(auth.jwt()->>'session_id','')::uuid);
$$;
revoke all on function public.current_session_allowed() from public,anon,authenticated;
grant execute on function public.current_session_allowed() to authenticated,service_role;

do $$ declare t text; begin
 foreach t in array array['operations_config','operations_incidents','operations_incident_events','operations_telemetry','operations_signals','operations_jobs','operations_requests'] loop
  execute format('drop policy system_mfa_read on public.%I',t);
  execute format('create policy system_read on public.%I for select to authenticated using(public.has_role(auth.uid(),array[''super_administrator'']))',t);
 end loop;
end $$;
-- The restrictive active_app_session policies remain in force. Worker lease
-- records remain inaccessible to browser roles (no SELECT grant is added).
update public.operations_config set schema_version='017' where id;
notify pgrst, 'reload schema';
