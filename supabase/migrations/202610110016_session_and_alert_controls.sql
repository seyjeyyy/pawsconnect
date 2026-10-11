-- App access can be suspended without deleting a user or their records.
update public.operations_config set schema_version='016' where id;
create table public.account_access_controls (
 user_id uuid primary key references public.profiles(id), suspended boolean not null default false,
 sessions_valid_after timestamptz, reason text not null, updated_by uuid not null references public.profiles(id), updated_at timestamptz not null default now()
);
alter table public.account_access_controls enable row level security;
revoke all on public.account_access_controls from anon,authenticated;
grant all on public.account_access_controls to service_role;

create function public.account_session_allowed(p_user_id uuid,p_session_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from auth.sessions s left join public.account_access_controls c on c.user_id=s.user_id
 where s.id=p_session_id and s.user_id=p_user_id and not coalesce(c.suspended,false)
 and (c.sessions_valid_after is null or s.created_at>c.sessions_valid_after));
$$;
-- This deliberately public helper takes NO actor argument. It only answers for
-- the caller's signed JWT, so it cannot inspect another person's sessions.
create function public.current_session_allowed()
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select public.account_session_allowed(auth.uid(),nullif(auth.jwt()->>'session_id','')::uuid)
 and (not public.has_role(auth.uid(),array['super_administrator','administrator','shelter_staff','veterinarian','rescue_personnel','shelter_driver']) or auth.jwt()->>'aal'='aal2');
$$;
create function public.change_account_access(p_actor_id uuid,p_user_id uuid,p_action text,p_reason text)
returns public.account_access_controls language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.account_access_controls; begin
 if not public.has_role(p_actor_id,array['super_administrator']) then raise exception 'Super administrator required' using errcode='42501'; end if;
 if p_actor_id=p_user_id then raise exception 'You cannot restrict your own account' using errcode='42501'; end if;
 -- Elevated holders retain the existing two-person role-removal procedure.
 if public.has_role(p_user_id,array['administrator','super_administrator']) then raise exception 'Remove elevated access through independent approval before restricting this account'; end if;
 if p_action not in ('suspend','reinstate','revoke_sessions') or length(trim(p_reason))<10 then raise exception 'A valid action and reason are required'; end if;
 insert into public.account_access_controls(user_id,suspended,sessions_valid_after,reason,updated_by)
 values(p_user_id,p_action='suspend',clock_timestamp(),p_reason,p_actor_id)
 on conflict(user_id) do update set suspended=case when p_action='revoke_sessions' then account_access_controls.suspended else p_action='suspend' end,
 sessions_valid_after=clock_timestamp(),reason=p_reason,updated_by=p_actor_id,updated_at=now() returning * into v;
 insert into public.audit_logs(actor_id,action,entity_type,entity_id,details) values(p_actor_id,'account.'||p_action,'account_access_controls',p_user_id,jsonb_build_object('reason',p_reason));
 return v;
end $$;
revoke all on function public.account_session_allowed(uuid,uuid),public.current_session_allowed(),public.change_account_access(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.account_session_allowed(uuid,uuid),public.change_account_access(uuid,uuid,text,text),public.current_session_allowed() to service_role;
grant execute on function public.current_session_allowed() to authenticated;

-- Service-role queries still filter/check in the API; direct browser access is
-- additionally denied for suspended/revoked sessions across every public table.
do $$ declare t record; begin
 for t in select tablename from pg_tables where schemaname='public' loop
  execute format('create policy active_app_session on public.%I as restrictive for all to authenticated using(public.current_session_allowed()) with check(public.current_session_allowed())',t.tablename);
 end loop;
end $$;
create policy active_app_session on storage.objects as restrictive for all to authenticated using(public.current_session_allowed()) with check(public.current_session_allowed());

alter table public.operations_signals add column status text not null default 'open' check(status in ('open','acknowledged','resolved'));
alter table public.operations_signals add column assigned_to uuid references public.profiles(id);
alter table public.operations_signals add column notes text;
alter table public.operations_signals add column updated_at timestamptz;
create function public.review_operations_signal(p_actor_id uuid,p_id uuid,p_status text,p_assignee uuid,p_notes text)
returns public.operations_signals language plpgsql security definer set search_path=public,pg_temp as $$
declare v public.operations_signals; begin
 if not public.has_role(p_actor_id,array['super_administrator']) then raise exception 'Super administrator required' using errcode='42501'; end if;
 if p_assignee is not null and not public.has_role(p_assignee,array['super_administrator']) then raise exception 'Responder requires system access'; end if;
 if length(trim(p_notes))<10 then raise exception 'Investigation notes required'; end if;
 update public.operations_signals set status=p_status,assigned_to=p_assignee,notes=p_notes,updated_at=now() where id=p_id returning * into v;
 if not found then raise exception 'Signal not found'; end if;
 insert into public.audit_logs(actor_id,action,entity_type,entity_id,details) values(p_actor_id,'operations.signal_reviewed','operations_signals',p_id,jsonb_build_object('status',p_status,'notes',p_notes));
 return v;
end $$;
revoke all on function public.review_operations_signal(uuid,uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.review_operations_signal(uuid,uuid,text,uuid,text) to service_role;
