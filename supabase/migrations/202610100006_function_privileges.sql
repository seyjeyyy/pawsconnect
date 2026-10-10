-- Lock down RPC execution.
--
-- Supabase grants EXECUTE on every new function in `public` to the anon and
-- authenticated roles by name, so revoking from PUBLIC alone (as the earlier
-- migrations did) leaves them callable through PostgREST /rpc. The workflow
-- functions are SECURITY DEFINER and trust a caller-supplied actor id
-- (assign_user_role, settle_payment, transition_order, finalize_adoption, ...),
-- so a signed-in user could have promoted themselves to administrator or
-- marked their own order as paid. Only the API, using the service role, may
-- call them.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- Read-only helpers that RLS policies evaluate as the calling user.
grant execute on function
  public.has_role(uuid, text[]),
  public.is_staff(),
  public.is_admin(),
  public.can_read_report(uuid),
  public.can_read_transport(uuid)
to anon, authenticated;

-- Public coverage lookup: returns eligibility for a point, never zone geometry.
grant execute on function public.check_service_eligibility(text, double precision, double precision) to anon, authenticated;

-- Functions added by later migrations start closed to clients as well.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
