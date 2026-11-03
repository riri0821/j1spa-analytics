-- =====================================================================
--  Owner-only access to cost and profit, step 2 of 2. RESTRICTIVE.
--
--  DO NOT RUN THIS UNTIL THE CODE THAT USES 033'S FUNCTIONS IS DEPLOYED.
--
--  033 added owner-checked security-definer functions for every cost read
--  the owner screens need, and changed nothing else, so it was safe to run
--  under the old code. This file takes the direct access away. Run it
--  against a deployment that still reads products.unit_cost or calls
--  dashboard_margin_trend() from a user session and those screens will
--  break immediately.
--
--  Rollback: sql/migrations/034_rollback.sql puts every grant and policy in
--  this file back exactly as it was.
--
--  WHAT THIS DOES, AND WHY IT IS COLUMN PRIVILEGES
--
--  Owner and staff are both the Postgres role `authenticated`, and RLS is
--  row-level. There is no row-level way to say "this column, but only for
--  one of these two people". Column privileges can say "not for this role",
--  which takes the column from the owner as well - and that is fine, because
--  033's definer functions run as their own owner and are not subject to
--  column privileges at all. They check current_user_role() instead.
--
--  So after this file:
--    * staff and owner sessions alike cannot select a cost column;
--    * the owner reaches cost only through owner_* functions, which refuse
--      anyone who is not the owner;
--    * service_role (the forecast service, the seed scripts, the export
--      routes) is untouched throughout - it bypasses RLS and holds its
--      privileges separately.
--
--  Unaffected by design, and checked before writing this:
--    * RLS policies. Every policy on these tables reads auth.uid(),
--      auth.role() or current_user_role(); none reads a cost column, and a
--      policy is evaluated by the system rather than with the caller's
--      column privileges.
--    * The set_updated_at trigger. A trigger function reading NEW.* does
--      not need the caller's select privilege.
--    * confirm_sale, edit_sale, undo_sale, record_service, undo_service,
--      record_stock_movements, set_product_supplier. All security definer,
--      all running as their owner, so they still write cost columns.
--    * UPDATE on products.unit_cost from api/products/save. Only SELECT is
--      revoked here, and supabase-js sends an update with
--      `Prefer: return=minimal`, so nothing is read back.
--
--  Run in a NEW query tab. Mirrored into sql/supabase_schema.sql.
-- =====================================================================


-- ---------------------------------------------------------------------
--  STEP 1 - products: everything except unit_cost
-- ---------------------------------------------------------------------

revoke select on products from authenticated;
grant select (
  product_id, sku, name, category, brand, vehicle_compat, supplier,
  unit_price, reorder_point, stock_on_hand, is_active, source_type,
  created_at, updated_at
) on products to authenticated;


-- ---------------------------------------------------------------------
--  STEP 2 - sales: everything except total_cost
-- ---------------------------------------------------------------------

revoke select on sales from authenticated;
grant select (
  sale_id, sale_ts, user_id, user_role, total_amount, status, voided_ts,
  note, source_type, customer_name, customer_contact, customer_address,
  customer_vehicle_brand
) on sales to authenticated;


-- ---------------------------------------------------------------------
--  STEP 3 - sale_items: everything except unit_cost and line_cost
-- ---------------------------------------------------------------------

revoke select on sale_items from authenticated;
grant select (
  sale_item_id, sale_id, product_id, sku, quantity, unit_price, line_revenue
) on sale_items to authenticated;


-- ---------------------------------------------------------------------
--  STEP 4 - stock_movements: everything except unit_cost, AND the table
--  becomes owner-only at the row level.
--
--  Staff have no screen that reads it. Verified in the code before this
--  was written: the Stock-In Tracker, the per-product ledger, the
--  stock-movements export and api/products/delete are the only readers and
--  every one of them is owner-gated. api/settings/delete-staff writes it
--  through the service-role client.
--
--  Both gates, not one: the policy stops staff reading any row, and the
--  column grant keeps unit_cost away from the owner's own session, which
--  reaches it through owner_stockin_log instead.
-- ---------------------------------------------------------------------

revoke select on stock_movements from authenticated;
grant select (
  movement_id, movement_ts, product_id, sku, movement_type, quantity,
  balance_after, user_id, reference, note, supplier
) on stock_movements to authenticated;

drop policy if exists "stock_movements_select" on stock_movements;
create policy "stock_movements_select" on stock_movements for select
  using (current_user_role() = 'owner');


-- ---------------------------------------------------------------------
--  STEP 5 - alerts and advisory_overrides: owner-only at the row level.
--
--  Same check: nothing staff-facing reads either. alerts is read by
--  api/products/delete and by lib/decisionSupport.js, both owner-only;
--  advisory_overrides by lib/decisionSupport.js and
--  api/decision-support/advisory-status, both owner-only. No cost column in
--  either, so there is nothing to do at the column level.
-- ---------------------------------------------------------------------

drop policy if exists "alerts_select" on alerts;
create policy "alerts_select" on alerts for select
  using (current_user_role() = 'owner');

drop policy if exists "advisory_overrides_select" on advisory_overrides;
create policy "advisory_overrides_select" on advisory_overrides for select
  using (current_user_role() = 'owner');


-- ---------------------------------------------------------------------
--  STEP 6 - the view and the cost-bearing functions.
--
--  vw_product_velocity carries gross_profit_90d, so the whole view goes.
--  owner_product_performance() replaces it for the dashboard and Decision
--  Support. Note the view has security_invoker = true (migration 031), so
--  even with a grant it would now return nothing to staff once
--  stock_movements and the cost columns are closed - but the explicit
--  revoke is the statement of intent.
--
--  The three originals keep existing, for the service_role callers and so a
--  rollback is a grant rather than a recreate. Their owner_* equivalents in
--  033 are what the app calls.
-- ---------------------------------------------------------------------

revoke select on vw_product_velocity from authenticated;

revoke execute on function sales_kpi_summary() from authenticated;
revoke execute on function dashboard_margin_trend() from authenticated;
revoke execute on function dashboard_gross_net_range(date, date, text) from authenticated;

-- monthly_demand / monthly_demand_all return quantities, never money, and
-- the forecast service calls monthly_demand with the service-role key.
-- Decision Support (owner-only) calls monthly_demand_all. Both stay as they
-- are; there is no cost in them to protect.


-- ---------------------------------------------------------------------
--  VERIFY (read-only). Uncomment and run after the above.
-- ---------------------------------------------------------------------

-- a. Exactly which columns `authenticated` may select. The cost columns
--    must be ABSENT from this list.

/*
select table_name, string_agg(column_name, ', ' order by ordinal_position) as selectable
from information_schema.column_privileges
where grantee = 'authenticated'
  and table_schema = 'public'
  and privilege_type = 'SELECT'
  and table_name in ('products', 'sales', 'sale_items', 'stock_movements')
group by table_name
order by table_name;
*/

-- b. The same question the other way round. MUST return 0 rows.

/*
select table_name, column_name
from information_schema.column_privileges
where grantee = 'authenticated'
  and table_schema = 'public'
  and privilege_type = 'SELECT'
  and (table_name, column_name) in (
    ('products', 'unit_cost'),
    ('sales', 'total_cost'),
    ('sale_items', 'unit_cost'),
    ('sale_items', 'line_cost'),
    ('stock_movements', 'unit_cost')
  );
*/

-- c. The three tables that are now owner-only at the row level.

/*
select tablename, policyname, cmd, qual
from pg_policies
where schemaname = 'public'
  and tablename in ('stock_movements', 'alerts', 'advisory_overrides')
  and cmd = 'SELECT'
order by tablename;
*/

-- d. The view and the three originals are out of reach, the owner_*
--    functions are in reach. authenticated should be false for the first
--    four rows and true for the owner_* ones.

/*
select 'view vw_product_velocity' as object,
       has_table_privilege('authenticated', 'vw_product_velocity', 'SELECT') as authenticated,
       has_table_privilege('service_role', 'vw_product_velocity', 'SELECT') as service_role
union all
select 'function ' || p.proname,
       has_function_privilege('authenticated', p.oid, 'EXECUTE'),
       has_function_privilege('service_role', p.oid, 'EXECUTE')
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (p.proname in ('sales_kpi_summary', 'dashboard_margin_trend', 'dashboard_gross_net_range')
       or p.proname like 'owner\_%')
order by object;
*/

-- e. The whole thing end to end, as a real staff session:
--      cd web && node scripts/check-staff-access.mjs --expect=after
--    Every cost read must FAIL and every staff job must still PASS.
