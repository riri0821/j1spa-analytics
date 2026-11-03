-- =====================================================================
--  Security audit, batch 1. Four separate things, all safe against real
--  data and all idempotent - the file can be re-run without harm.
--
--  STEP 1  Views and function grants no longer reachable by `anon`.
--          ALREADY APPLIED BY HAND to the live database; recorded here so
--          the repo matches it and a from-scratch setup gets it too.
--  STEP 2  undo_sale / undo_service: the staff same-day rule compares
--          Manila dates, not UTC ones.
--  STEP 3  products: non-negative check constraints.
--  STEP 4  Read-only verification queries (commented).
--
--  Depends on migration 030 (also already applied by hand).
--  Run in a NEW query tab. Mirrored into sql/supabase_schema.sql.
-- =====================================================================


-- ---------------------------------------------------------------------
--  STEP 1 - close off `anon`.
--
--  Two separate holes, both from Postgres/Supabase defaults rather than
--  from anything written here.
--
--  a) A view is not subject to the RLS of the tables underneath it. Since
--     PG15 a view runs as its OWNER unless security_invoker is set, and
--     these three are owned by `postgres`, which bypasses RLS. Supabase's
--     default privileges then grant SELECT on new objects in `public` to
--     `anon` - so the publishable anon key, which ships in the browser
--     bundle, could read revenue, cost and gross profit out of
--     vw_product_velocity with no login at all. security_invoker makes the
--     view run as the caller, so the underlying policies apply; the revoke
--     is the belt to that braces.
--
--  b) Postgres grants EXECUTE on a new function to PUBLIC by default, and
--     PUBLIC includes `anon`. The write RPCs each revoked it explicitly
--     (see confirm_sale et al), but the read-side analytics functions -
--     sales_kpi_summary, dashboard_gross_net_summary,
--     dashboard_gross_net_range, dashboard_margin_trend, monthly_demand,
--     monthly_demand_all, monthly_sales_totals - did not, so an
--     unauthenticated caller could invoke them. They are not security
--     definer, so RLS still applied to the tables they read and `anon`
--     would have got empty results; this closes the call itself.
--
--  The ALTER DEFAULT PRIVILEGES lines are what stop the next function
--  added to this schema from arriving with the same PUBLIC grant.
-- ---------------------------------------------------------------------

alter view vw_product_velocity set (security_invoker = true);
alter view vw_daily_sales      set (security_invoker = true);
alter view vw_monthly_sales    set (security_invoker = true);

revoke all on vw_product_velocity from anon;
revoke all on vw_daily_sales      from anon;
revoke all on vw_monthly_sales    from anon;

revoke execute on all functions in schema public from anon;
revoke execute on all functions in schema public from public;

grant execute on all functions in schema public to authenticated, service_role;

alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from public;

-- A hand-made leftover that was never in the repo and that nothing calls.
-- Dropped rather than left to rot with a grant nobody is tracking.
drop function if exists public.sales_tracker_summary(text);


-- ---------------------------------------------------------------------
--  STEP 2 - the staff same-day undo rule, in Manila time.
--
--  Both functions compared `<record>_ts::date <> current_date`. A
--  timestamptz cast to date uses the SESSION's TimeZone, which for
--  PostgREST is UTC, and current_date is UTC too - so "the same day" meant
--  the same UTC day, eight hours out of step with the trading day:
--
--    * at 09:00 Manila, staff could NOT undo their own sale from 01:00
--      that morning (17:00 UTC the day before);
--    * at 07:00 Manila, staff COULD still undo a sale from 23:00 the
--      previous evening (both 15:00-23:00 UTC the same day).
--
--  Both now read the two sides in Asia/Manila. The Philippines has been
--  UTC+8 with no DST since 1978, which is the same assumption the app's
--  own date handling makes (web/src/lib/grossNetRange.js).
--
--  This is the ONLY change to either function - everything else is
--  byte-identical to what supabase_schema.sql already held.
-- ---------------------------------------------------------------------

create or replace function undo_sale(p_sale_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
  v_sale record;
  v_item record;
  v_new_bal integer;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;
  v_role := current_user_role();

  select * into v_sale from sales where sale_id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found.';
  end if;
  if v_sale.status = 'voided' then
    raise exception 'Already undone.';
  end if;

  -- staff may undo only their own sale on the same day; owner may undo any
  if v_role <> 'owner' and (
    v_sale.user_id is distinct from v_uid
    or (v_sale.sale_ts at time zone 'Asia/Manila')::date
       <> (now() at time zone 'Asia/Manila')::date
  ) then
    raise exception 'Not allowed to undo this sale.';
  end if;

  for v_item in select product_id, sku, quantity from sale_items where sale_id = p_sale_id
  loop
    update products set stock_on_hand = stock_on_hand + v_item.quantity
      where product_id = v_item.product_id
      returning stock_on_hand into v_new_bal;

    insert into stock_movements (product_id, sku, movement_type, quantity,
        balance_after, user_id, reference)
    values (v_item.product_id, v_item.sku, 'void_increment', v_item.quantity,
        v_new_bal, v_uid, 'undo:' || p_sale_id);
  end loop;

  update sales set status = 'voided', voided_ts = now() where sale_id = p_sale_id;

  return jsonb_build_object('ok', true, 'sale_id', p_sale_id);
end;
$$;

revoke execute on function undo_sale(bigint) from public;
revoke execute on function undo_sale(bigint) from anon;
grant execute on function undo_sale(bigint) to authenticated, service_role;

create or replace function undo_service(p_service_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
  v_service record;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;
  v_role := current_user_role();

  select * into v_service from services where service_id = p_service_id for update;
  if not found then
    raise exception 'Service record not found.';
  end if;
  if v_service.status = 'voided' then
    raise exception 'Already undone.';
  end if;

  -- staff may undo only their own record on the same day; owner may undo any
  if v_role <> 'owner' and (
    v_service.user_id is distinct from v_uid
    or (v_service.service_ts at time zone 'Asia/Manila')::date
       <> (now() at time zone 'Asia/Manila')::date
  ) then
    raise exception 'Not allowed to undo this service record.';
  end if;

  update services set status = 'voided', voided_ts = now() where service_id = p_service_id;

  return jsonb_build_object('ok', true, 'service_id', p_service_id);
end;
$$;

revoke execute on function undo_service(bigint) from public;
revoke execute on function undo_service(bigint) from anon;
grant execute on function undo_service(bigint) to authenticated, service_role;


-- ---------------------------------------------------------------------
--  STEP 3 - products cannot hold negative money or quantities.
--
--  The table had no check constraints at all, and api/products/save read
--  its numbers as `Number(body.unit_cost) || 0`, which passes a negative
--  straight through. A unit_cost of -500 makes gross profit exceed revenue
--  everywhere it is computed - the KPI tiles, the margin trend, Gross &
--  Net, the velocity view, Decision Support - with nothing to flag it.
--  stock_on_hand is guarded by the RPCs, never by the column itself.
--
--  Counted against the live data before adding these: 0 rows violate any
--  of the four. The route handlers now reject negatives with a 400 as
--  well, so this is the backstop rather than the only check.
--
--  `not valid` is deliberately NOT used: the table is clean, so these
--  validate immediately.
-- ---------------------------------------------------------------------

alter table products drop constraint if exists products_unit_cost_non_negative;
alter table products add constraint products_unit_cost_non_negative
  check (unit_cost >= 0);

alter table products drop constraint if exists products_unit_price_non_negative;
alter table products add constraint products_unit_price_non_negative
  check (unit_price >= 0);

alter table products drop constraint if exists products_reorder_point_non_negative;
alter table products add constraint products_reorder_point_non_negative
  check (reorder_point >= 0);

alter table products drop constraint if exists products_stock_on_hand_non_negative;
alter table products add constraint products_stock_on_hand_non_negative
  check (stock_on_hand >= 0);


-- ---------------------------------------------------------------------
--  STEP 4 - VERIFY (read-only). Uncomment and run each after the above.
-- ---------------------------------------------------------------------

-- 4a. All three views run as the caller now. security_invoker=true must
--     appear in reloptions for each.

/*
select c.relname, c.reloptions
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v'
order by c.relname;
*/

-- 4b. `anon` holds no privilege on the views. MUST return 0 rows.

/*
select table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee = 'anon'
  and table_name in ('vw_product_velocity', 'vw_daily_sales', 'vw_monthly_sales');
*/

-- 4c. No function in `public` is executable by anon or PUBLIC. MUST return
--     0 rows. (PUBLIC shows as an empty grantee in this view.)

/*
select p.proname, a.grantee
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
left join pg_roles r on r.oid = a.grantee
where n.nspname = 'public'
  and a.privilege_type = 'EXECUTE'
  and (r.rolname = 'anon' or a.grantee = 0)
order by p.proname;
*/

-- 4d. ...while `authenticated` still has every one of them. Expect the
--     full list of app functions.

/*
select p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and has_function_privilege('authenticated', p.oid, 'EXECUTE')
order by p.proname;
*/

-- 4e. The leftover is gone. MUST return 0 rows.

/*
select p.proname from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'sales_tracker_summary';
*/

-- 4f. The four constraints exist and are validated.

/*
select conname, convalidated, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'products'::regclass and contype = 'c'
order by conname;
*/

-- 4g. The Manila undo rule. Both function bodies must contain
--     'Asia/Manila' and no bare current_date.

/*
select proname,
       prosrc like '%Asia/Manila%'  as uses_manila,
       prosrc like '%current_date%' as still_uses_current_date
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and proname in ('undo_sale', 'undo_service');
*/
