-- MANUAL rollback only, while migration 018 has not yet been used to change grants.
-- Stop API traffic first. Deploy the previous code only AFTER this transaction.
-- If the guard refuses, preserve 018 and roll forward; reverting would broaden access.
begin;
lock table public.staff_access in access exclusive mode;
do $$ declare r record; begin
 if exists(select 1 from public.staff_access where updated_by is not null) or
    exists(select 1 from public.audit_logs where action='staff.permissions_changed') then
   raise exception 'Rollback refused: module grants have changed. Keep permission enforcement and roll forward.';
 end if;
 for r in select definition from public.permission_rollout_backup where kind='function' loop execute r.definition; end loop;
 for r in select definition from public.permission_rollout_backup where kind='policy' loop execute r.definition; end loop;
end $$;
drop trigger volunteer_capability on public.volunteer_profiles;
drop function public.sync_volunteer_capability();
drop function public.workspace_people_lookup(uuid,text,text);
drop function public.workspace_overview(uuid);
drop function public.authorize_workspace_export(uuid);
drop function public.set_staff_access(uuid,uuid,text[]);
drop function public.has_permission(uuid,text);
drop function public.account_permissions(uuid);
drop function public.legacy_permissions(uuid);
drop table public.staff_access;
drop table public.permission_rollout_backup;
update public.operations_config set schema_version='017' where id;
-- Ownership indexes and approved-volunteer compatibility memberships are retained.
commit;
