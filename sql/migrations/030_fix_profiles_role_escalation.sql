-- =====================================================================
--  SECURITY FIX: any signed-in user could make themselves the owner.
--
--  Two separate ways in, both closed here.
--
--  1. Policy "profiles_update_own" allowed `update` on a user's own
--     profile row with no restriction on WHICH columns:
--
--       using (auth.uid() = id)
--
--     RLS has no column-level grain, so that covered `role` along with
--     everything else. Any staff member with the anon key and their own
--     session could run
--
--       update profiles set role = 'owner' where id = auth.uid();
--
--     and immediately reach the dashboard, forecasting, decision support,
--     the full product catalog, staff management, and every peso figure
--     the UI hides from staff. Nothing in the app ever used this policy:
--     the only write to `profiles` anywhere in the code is
--     api/settings/toggle-user, which goes through the service-role client
--     and bypasses RLS entirely. Every other `profiles` access is a select.
--     So the policy is dropped outright rather than narrowed - there is no
--     self-service profile editing to preserve.
--
--  2. handle_new_user() took the new profile's role straight out of
--     raw_user_meta_data:
--
--       coalesce((new.raw_user_meta_data ->> 'role')::user_role, 'staff')
--
--     That metadata is supplied by whoever makes the sign-up request. With
--     public sign-ups enabled, `{ "data": { "role": "owner" } }` on a
--     /auth/v1/signup call to the anon endpoint creates an owner account
--     from outside the app, with no existing session at all. The function
--     now hard-codes 'staff' and ignores the metadata role; the
--     username/full_name fallbacks are unchanged.
--
--  AFTER RUNNING THIS, two things are not optional:
--
--   a. There is no longer ANY code path that creates an owner. Promote the
--      owner account by hand, once, in the SQL editor:
--
--        update profiles set role = 'owner' where username = 'you@example.com';
--
--      (Check what you got first: `select id, username, role from profiles;`)
--
--   b. Turn OFF "Allow new users to sign up" in Supabase ->
--      Authentication -> Sign In / Providers. Staff accounts are created by
--      the owner through /settings (api/settings/add-staff, service-role),
--      which does not need public sign-up. Leaving it on lets anyone create
--      a working staff login against the project's anon key - still a
--      staff account after this fix, but an unwanted one.
--
--  Also verify the live policy list afterwards:
--    select policyname, cmd from pg_policies
--     where schemaname = 'public' and tablename = 'profiles';
--  Expect exactly one row: profiles_select / SELECT.
--
--  SAFE TO RUN against real data: it removes a policy nothing uses and
--  replaces one function body. No table data is touched - existing roles,
--  including the owner's, are left exactly as they are. Run in a NEW query
--  tab. Mirrored into sql/supabase_schema.sql.
-- =====================================================================

-- 1. The escalation policy. Already dropped by hand in the live database;
--    `if exists` makes this file safe to run there anyway, and it is what a
--    database restored from an older schema needs.
drop policy if exists "profiles_update_own" on profiles;

-- 2. New profiles are always staff. Role is NOT read from metadata.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    -- Hard-coded, not coalesce(metadata -> 'role', 'staff'): the sign-up
    -- request controls that metadata. api/settings/add-staff still sends
    -- role: 'staff' in user_metadata; it is now simply ignored, and the
    -- account it creates is unchanged.
    'staff'
  );
  return new;
end;
$$;
