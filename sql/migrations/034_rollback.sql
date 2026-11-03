-- =====================================================================
--  Rollback for 034_lock_cost_columns.sql.
--
--  Puts every grant and policy that file changed back exactly as it was,
--  for the case where something breaks after 034 is applied and the fix
--  has to wait. It reopens the hole 034 closed: staff can read cost and
--  profit again. Treat it as a way to buy an hour, not as a resting state.
--
--  It does NOT drop 033's owner_* functions. They are additive, nothing
--  else depends on them being absent, and leaving them means 034 can be
--  re-applied without re-running 033.
--
--  Safe to run whether or not 034 was applied: every statement is either a
--  grant (idempotent) or a drop-and-recreate of a policy.
--
--  Run in a NEW query tab.
-- =====================================================================


-- ---------------------------------------------------------------------
--  Table-wide select back, which is what the three tables had before:
--  no column-level grants at all, just select on the whole table.
--
--  The column grants 034 made are left in place deliberately. A
--  table-level grant is the union of itself and any column grants, so this
--  restores the previous behaviour exactly; dropping the column grants as
--  well would make no difference to what is readable.
-- ---------------------------------------------------------------------

grant select on products        to authenticated;
grant select on sales           to authenticated;
grant select on sale_items      to authenticated;
grant select on stock_movements to authenticated;


-- ---------------------------------------------------------------------
--  The three select policies, as they read before 034.
--
--  stock_movements, alerts: any signed-in user.
--  advisory_overrides: any signed-in user (its write policy, which 034 did
--  not touch, stays owner-only).
-- ---------------------------------------------------------------------

drop policy if exists "stock_movements_select" on stock_movements;
create policy "stock_movements_select" on stock_movements for select
  using (auth.role() = 'authenticated');

drop policy if exists "alerts_select" on alerts;
create policy "alerts_select" on alerts for select
  using (auth.role() = 'authenticated');

drop policy if exists "advisory_overrides_select" on advisory_overrides;
create policy "advisory_overrides_select" on advisory_overrides for select
  using (auth.role() = 'authenticated');


-- ---------------------------------------------------------------------
--  The view and the three cost-bearing functions.
-- ---------------------------------------------------------------------

grant select on vw_product_velocity to authenticated;

grant execute on function sales_kpi_summary() to authenticated;
grant execute on function dashboard_margin_trend() to authenticated;
grant execute on function dashboard_gross_net_range(date, date, text) to authenticated;


-- ---------------------------------------------------------------------
--  VERIFY (read-only). Uncomment and run after the above.
-- ---------------------------------------------------------------------

-- The cost columns are selectable by `authenticated` again. Expect all five.

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
  )
order by table_name, column_name;
*/

-- ...and the proof script agrees, with the hole open again:
--   cd web && node scripts/check-staff-access.mjs --expect=before
