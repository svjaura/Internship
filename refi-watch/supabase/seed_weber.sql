-- Refi Watch: create the Weber Mortgage org and make one staff user a member.
--
-- 1. First add the user: Supabase > Authentication > Users > Add user > Create new user
--    (email + password, tick "Auto Confirm User").
-- 2. Open that user and copy its UID.
-- 3. Replace the two PASTE-... values below, then run this whole file in the SQL editor.
--
-- Safe to run more than once. Run it again with another UID and email to add another staff
-- user (Michael, later) to the same org. The org's default rule (6.125%, $4,000, 0.75 points,
-- $150 a month, 36 months, 6 months) is created automatically with the org.

do $$
declare
  v_user_id uuid := 'PASTE-USER-UID-HERE';     -- the user's UID, e.g. 3f1c...-...-...
  v_email   text := 'PASTE-USER-EMAIL-HERE';   -- the same user's email, as a check
  v_role    text := 'owner';                   -- 'owner' or 'staff' (both see the same dashboard)
  v_org     uuid;
begin
  if not exists (select 1 from auth.users where id = v_user_id and lower(email) = lower(v_email)) then
    raise exception 'No user with that UID and email. Add the user first (Authentication > Users > Add user), then paste its UID and email here.';
  end if;

  select id into v_org from public.orgs where name = 'Weber Mortgage' order by created_at limit 1;
  if v_org is null then
    insert into public.orgs (name) values ('Weber Mortgage') returning id into v_org;
  end if;

  insert into public.staff_members (org_id, user_id, role)
  values (v_org, v_user_id, v_role)
  on conflict (org_id, user_id) do nothing;
end $$;

-- Check: one row per staff user, and has_rule = 1.
select o.name as org, u.email, s.role,
       (select count(*) from public.org_settings st where st.org_id = o.id) as has_rule
from public.staff_members s
join public.orgs o on o.id = s.org_id
join auth.users u on u.id = s.user_id
where o.name = 'Weber Mortgage';
