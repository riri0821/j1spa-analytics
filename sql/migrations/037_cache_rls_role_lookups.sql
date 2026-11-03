-- =====================================================================
--  037 - RLS policies that were evaluated once per row.
--
--  Every policy below called current_user_role(), auth.uid() or auth.role()
--  directly. Postgres re-evaluates such a call FOR EVERY ROW the policy is
--  checked against, because the expression sits in the row filter. Wrapping
--  it in a scalar subquery - `(select current_user_role())` - turns it into
--  an InitPlan, evaluated once per statement and reused.
--
--  current_user_role() is the expensive one. It is
--
--    select role from profiles where id = auth.uid();
--
--  so a policy that calls it pays a profiles lookup per row of the table
--  being read. On stock_movements that is 279,362 of them, and a staff read
--  did not come back:
--
--    staff select from stock_movements    8,195 ms -> statement timeout
--
--  The refusal was correct - the policy returns no rows for staff - but it
--  arrived as a timeout rather than an empty result, which is slow for them
--  and, in check-staff-access.mjs, was scoring as a denial while proving
--  nothing. The owner pays the same cost on the reads that DO return rows:
--  the stock ledger and Decision Support.
--
--  SAME LOGIC, every one of them. `(select f()) = 'owner'` and
--  `f() = 'owner'` differ only in when f() runs - including for a caller
--  with no profile row, where both are NULL and a NULL policy denies.
--  Nothing here changes who can see what; if it did, that would be a bug in
--  this file.
--
--  auth.role() is wrapped too. The brief asked about current_user_role()
--  and auth.uid(); auth.role() is the same construct with the same per-row
--  cost, and it is what guards the four tables staff actually read (sales,
--  sale_items, services, products), so leaving it alone would have left the
--  staff-facing half unimproved.
--
--  Wrapped in a transaction. Between a `drop policy` and its `create` the
--  table has RLS on with one policy missing, which DENIES rather than
--  exposes - so the window is fail-closed either way, but inside a
--  transaction nobody sees even that.
--
--  18 policies, 8 tables. login_lockouts has RLS on and no policies at all
--  (service_role only), so there is nothing to rewrite there.
--
--  Rollback: sql/migrations/037_rollback.sql puts the direct calls back.
--
--  SAFE TO RUN against real data - no table data is touched, only policy
--  definitions. Run in a NEW query tab, as ONE statement batch so the
--  begin/commit holds. Mirrored into sql/supabase_schema.sql.
-- =====================================================================


-- ---------------------------------------------------------------------
--  BEFORE (read-only). Uncomment and run first if you want the baseline.
--  Every row's qual/with_check should show a bare current_user_role(),
--  auth.uid() or auth.role() - that is the thing being fixed.
-- ---------------------------------------------------------------------

/*
select tablename, policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
*/


begin;

-- Both calls wrapped. auth.uid() is compared against a column, so the
-- comparison is still per row - it is the CALL that is hoisted out.
drop policy if exists "profiles_select" on profiles;
create policy "profiles_select" on profiles for select
  using ((select auth.uid()) = id or (select current_user_role()) = 'owner');

drop policy if exists "products_select" on products;
create policy "products_select" on products for select
  using ((select auth.role()) = 'authenticated');
drop policy if exists "products_write" on products;
create policy "products_write" on products for all
  using ((select current_user_role()) = 'owner')
  with check ((select current_user_role()) = 'owner');

drop policy if exists "sales_select" on sales;
create policy "sales_select" on sales for select
  using ((select auth.role()) = 'authenticated');
drop policy if exists "sales_insert" on sales;
create policy "sales_insert" on sales for insert
  with check ((select auth.role()) = 'authenticated');
drop policy if exists "sales_owner_write" on sales;
create policy "sales_owner_write" on sales for update
  using ((select current_user_role()) = 'owner');

drop policy if exists "sale_items_select" on sale_items;
create policy "sale_items_select" on sale_items for select
  using ((select auth.role()) = 'authenticated');
drop policy if exists "sale_items_insert" on sale_items;
create policy "sale_items_insert" on sale_items for insert
  with check ((select auth.role()) = 'authenticated');

-- This is the one that was timing out. 279,362 rows, each re-running
-- current_user_role(), which is itself a select on profiles.
drop policy if exists "stock_movements_select" on stock_movements;
create policy "stock_movements_select" on stock_movements for select
  using ((select current_user_role()) = 'owner');
-- Staff sales and voids reach this table through the security-definer
-- functions, which bypass RLS - see 026_fix_stockin_owner_only.sql.
drop policy if exists "stock_movements_insert" on stock_movements;
create policy "stock_movements_insert" on stock_movements for insert
  with check ((select current_user_role()) = 'owner');
-- Owners can reassign user_id when deleting a staff account.
drop policy if exists "stock_movements_owner_write" on stock_movements;
create policy "stock_movements_owner_write" on stock_movements for update
  using ((select current_user_role()) = 'owner');

drop policy if exists "services_select" on services;
create policy "services_select" on services for select
  using ((select auth.role()) = 'authenticated');
drop policy if exists "services_insert" on services;
create policy "services_insert" on services for insert
  with check ((select auth.role()) = 'authenticated');
drop policy if exists "services_owner_write" on services;
create policy "services_owner_write" on services for update
  using ((select current_user_role()) = 'owner');

-- Decision Support reads the newest batch on every page load.
drop policy if exists "alerts_select" on alerts;
create policy "alerts_select" on alerts for select
  using ((select current_user_role()) = 'owner');
drop policy if exists "alerts_insert" on alerts;
create policy "alerts_insert" on alerts for insert
  with check ((select current_user_role()) = 'owner');

drop policy if exists "advisory_overrides_select" on advisory_overrides;
create policy "advisory_overrides_select" on advisory_overrides for select
  using ((select current_user_role()) = 'owner');
drop policy if exists "advisory_overrides_write" on advisory_overrides;
create policy "advisory_overrides_write" on advisory_overrides for all
  using ((select current_user_role()) = 'owner')
  with check ((select current_user_role()) = 'owner');


commit;


-- ---------------------------------------------------------------------
--  VERIFY (read-only). Uncomment and run after the above.
-- ---------------------------------------------------------------------

-- a. No policy calls any of the three directly any more. MUST return 0
--    rows. The regex looks for the function name NOT preceded by `select `,
--    which is exactly the unwrapped form.

/*
select tablename, policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and (
    coalesce(qual, '') ~ '(?<!select )(current_user_role|auth\.uid|auth\.role)\(\)'
    or coalesce(with_check, '') ~ '(?<!select )(current_user_role|auth\.uid|auth\.role)\(\)'
  )
order by tablename, policyname;
*/

-- b. All 18 are still there, one row each, with the wrapped form. Compare
--    the count and the names against the list in this file's comments.

/*
select tablename, policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
*/

-- c. The behaviour, not the text - this is the one that matters, and it
--    covers the owner side as well as staff:
--      cd web && node scripts/check-staff-access.mjs --expect=after
--
--    The staff stock_movements probe must now report an empty result or a
--    permission error rather than a timeout, and its Timings section shows
--    the owner reads. For before/after medians:
--      cd web && node scripts/rls-timing.mjs
