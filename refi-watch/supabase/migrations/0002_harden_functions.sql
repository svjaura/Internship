-- Refi Watch: harden helper functions (from Supabase's security advisor).
-- Pin search_path on the trigger function, and stop exposing helper functions over the API.
-- is_org_member stays executable by signed-in users because the RLS policies call it.
alter function public.audit_log_append_only() set search_path = public;
revoke execute on function public.create_org_settings() from public, anon, authenticated;
revoke execute on function public.audit_log_append_only() from public, anon, authenticated;
revoke execute on function public.is_org_member(uuid) from public, anon;
grant execute on function public.is_org_member(uuid) to authenticated;

-- Keep the RLS helper out of the exposed API schema. Policies reference the function by OID,
-- so they keep working after the move.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
alter function public.is_org_member(uuid) set schema private;
