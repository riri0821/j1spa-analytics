-- =====================================================================
--  Rollback for 037_cache_rls_role_lookups.sql.
--
--  Puts the direct calls back, so every policy is evaluated once per row
--  again. That is the state where a staff read of stock_movements times out
--  after 8 seconds, so this is for the case where something turns out to
--  depend on the old form - not a resting state.
--
--  The logic is identical either way; only the timing of the function call
--  differs. If a permission question looks different after running this,
--  that is a finding about 037 worth reporting, not a rollback working.
--
--  Byte-identical to the policies 037 replaced, down to which ones had a
--  `with check` and which did not.
--
--  Safe to run whether or not 037 was applied. Run in a NEW query tab, as
--  ONE statement batch so the begin/commit holds.
-- =====================================================================

begin;

drop policy if exists "profiles_select" on profiles;
create policy "profiles_select" on profiles for select
  using (auth.uid() = id or current_user_role() = 'owner');

drop policy if exists "products_select" on products;
create policy "products_select" on products for select
  using (auth.role() = 'authenticated');
drop policy if exists "products_write" on products;
create policy "products_write" on products for all
  using (current_user_role() = 'owner')
  with check (current_user_role() = 'owner');

drop policy if exists "sales_select" on sales;
create policy "sales_select" on sales for select
  using (auth.role() = 'authenticated');
drop policy if exists "sales_insert" on sales;
create policy "sales_insert" on sales for insert
  with check (auth.role() = 'authenticated');
drop policy if exists "sales_owner_write" on sales;
create policy "sales_owner_write" on sales for update
  using (current_user_role() = 'owner');

drop policy if exists "sale_items_select" on sale_items;
create policy "sale_items_select" on sale_items for select
  using (auth.role() = 'authenticated');
drop policy if exists "sale_items_insert" on sale_items;
create policy "sale_items_insert" on sale_items for insert
  with check (auth.role() = 'authenticated');

drop policy if exists "stock_movements_select" on stock_movements;
create policy "stock_movements_select" on stock_movements for select
  using (current_user_role() = 'owner');
drop policy if exists "stock_movements_insert" on stock_movements;
create policy "stock_movements_insert" on stock_movements for insert
  with check (current_user_role() = 'owner');
drop policy if exists "stock_movements_owner_write" on stock_movements;
create policy "stock_movements_owner_write" on stock_movements for update
  using (current_user_role() = 'owner');

drop policy if exists "services_select" on services;
create policy "services_select" on services for select
  using (auth.role() = 'authenticated');
drop policy if exists "services_insert" on services;
create policy "services_insert" on services for insert
  with check (auth.role() = 'authenticated');
drop policy if exists "services_owner_write" on services;
create policy "services_owner_write" on services for update
  using (current_user_role() = 'owner');

drop policy if exists "alerts_select" on alerts;
create policy "alerts_select" on alerts for select
  using (current_user_role() = 'owner');
drop policy if exists "alerts_insert" on alerts;
create policy "alerts_insert" on alerts for insert
  with check (current_user_role() = 'owner');

drop policy if exists "advisory_overrides_select" on advisory_overrides;
create policy "advisory_overrides_select" on advisory_overrides for select
  using (current_user_role() = 'owner');
drop policy if exists "advisory_overrides_write" on advisory_overrides;
create policy "advisory_overrides_write" on advisory_overrides for all
  using (current_user_role() = 'owner')
  with check (current_user_role() = 'owner');


commit;


-- ---------------------------------------------------------------------
--  VERIFY (read-only). Uncomment and run after the above.
-- ---------------------------------------------------------------------

-- The direct calls are back: this should now return most of the 18 rows,
-- which is the opposite of 037's verify query (a).

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
