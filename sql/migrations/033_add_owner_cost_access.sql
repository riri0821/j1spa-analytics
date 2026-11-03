-- =====================================================================
--  Owner-only access to cost and profit, step 1 of 2.
--
--  THE PROBLEM
--
--  Owner and staff both authenticate as the Postgres role `authenticated`,
--  and RLS is row-level only. So a staff session holding the publishable
--  anon key can read, directly over PostgREST:
--
--    products.unit_cost          sales.total_cost
--    sale_items.unit_cost        sale_items.line_cost
--    stock_movements.unit_cost   vw_product_velocity.gross_profit_90d
--
--  and can call sales_kpi_summary(), dashboard_margin_trend() and
--  dashboard_gross_net_range(), whose `net` IS profit. The UI hides all of
--  it; the database does not. Every owner/staff split on money is currently
--  cosmetic.
--
--  WHY TWO MIGRATIONS
--
--  The fix is column-level privileges, and those cannot tell an owner from
--  a member of staff: both are `authenticated`. So revoking select on
--  unit_cost takes it from the OWNER too, and every owner screen that reads
--  cost has to go through a security-definer function first. Those functions
--  run as their owner, so column privileges do not apply to them, and each
--  one checks current_user_role() itself.
--
--  This migration only ADDS those functions. Nothing is revoked here, so it
--  is safe to run against a live database with the old code still serving:
--  the old reads keep working, the new functions sit unused until the deploy
--  that calls them. 034_lock_cost_columns.sql does the revoking and must run
--  only AFTER that deploy.
--
--  Deliberately NOT done here: adding the owner check to the existing
--  sales_kpi_summary / dashboard_margin_trend / dashboard_gross_net_range.
--  That would break every staff session the moment this file ran, which is
--  the opposite of additive. New owner_* functions instead, and 034 revokes
--  the originals.
--
--  ALSO IN HERE, and not about cost: undo_sale and undo_service are
--  recreated with the null-role guard the other five write RPCs already
--  have. Same NULL bypass as the owner_* guards below, but on a write - see
--  section 8 and 9 at the end of this file. Additive in the same sense:
--  recreating a function body breaks nothing that was working.
--
--  SAFE TO RUN against real data. Run in a NEW query tab. Mirrored into
--  sql/supabase_schema.sql.
-- =====================================================================


-- ---------------------------------------------------------------------
--  The guard every function below opens with.
--
--  security definer + `set search_path = public` is the same shape the
--  write RPCs use (confirm_sale and friends). The role check is not
--  optional decoration: a definer function bypasses the column privileges
--  034 puts in place, so without the check it would hand staff exactly
--  what 034 takes away.
--
--  `is distinct from`, NOT `<>`. current_user_role() reads
--
--    select role from profiles where id = auth.uid()
--
--  which returns NULL when there is no matching row - an authenticated user
--  whose profile row is missing, or a call with no auth.uid() at all. And
--  `NULL <> 'owner'` is NULL, not true, so a plain `if ... <> 'owner' then`
--  is SKIPPED in that case and the function goes on to return cost data.
--  The guard would fail open on exactly the input it exists to stop.
--  `is distinct from` is NULL-safe: it returns true, and the exception is
--  raised.
--
--  The same shape is safe in an RLS policy, which is why the policies in
--  supabase_schema.sql read `current_user_role() = 'owner'`: there NULL
--  means the row is filtered out, so it fails closed. It is only the
--  negated form inside a plpgsql IF that inverts.
-- ---------------------------------------------------------------------


-- 1. The product catalog WITH costs, for the Products screen.
--
--    Search and category filtering move into the function because the
--    screen can no longer read the cost columns directly. p_search is a
--    parameter, not interpolated text, and the LIKE metacharacters are
--    escaped so a '%' in the box matches a literal per cent.
create or replace function owner_product_catalog(
  p_search text default null,
  p_category text default null,
  p_limit integer default 500
)
returns table(
  product_id bigint,
  sku varchar(40),
  name varchar(160),
  category varchar(80),
  supplier varchar(120),
  unit_cost numeric(12,2),
  unit_price numeric(12,2),
  reorder_point integer,
  stock_on_hand integer,
  is_active boolean
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_term text;
begin
  if current_user_role() is distinct from 'owner' then
    raise exception 'Owner access only.';
  end if;

  v_term := nullif(btrim(coalesce(p_search, '')), '');
  if v_term is not null then
    v_term := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
    select p.product_id, p.sku, p.name, p.category, p.supplier, p.unit_cost,
           p.unit_price, p.reorder_point, p.stock_on_hand, p.is_active
    from products p
    where (p_category is null or p.category = p_category)
      and (
        v_term is null
        or p.name     ilike v_term escape '\'
        or p.sku      ilike v_term escape '\'
        or p.supplier ilike v_term escape '\'
        or p.category ilike v_term escape '\'
      )
    order by p.name
    limit greatest(1, least(coalesce(p_limit, 500), 2000));
end;
$$;

revoke execute on function owner_product_catalog(text, text, integer) from public;
revoke execute on function owner_product_catalog(text, text, integer) from anon;
grant execute on function owner_product_catalog(text, text, integer) to authenticated, service_role;


-- 2. Product performance, replacing the direct vw_product_velocity read.
--
--    One row per active product: the velocity figures plus the catalog
--    fields the dashboard's Tracking table shows. lib/analytics.js joined
--    these two itself; doing it here keeps gross_profit_90d from ever
--    leaving the function.
create or replace function owner_product_performance()
returns table(
  sku varchar(40),
  name varchar(160),
  category varchar(80),
  stock_on_hand integer,
  reorder_point integer,
  units_90d numeric,
  revenue_90d numeric,
  gross_profit_90d numeric
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if current_user_role() is distinct from 'owner' then
    raise exception 'Owner access only.';
  end if;

  return query
    select p.sku, p.name, p.category, p.stock_on_hand, p.reorder_point,
           coalesce(v.units_90d, 0)        as units_90d,
           coalesce(v.revenue_90d, 0)      as revenue_90d,
           coalesce(v.gross_profit_90d, 0) as gross_profit_90d
    from products p
    left join vw_product_velocity v on v.sku = p.sku
    where p.is_active
    order by p.sku;
end;
$$;

revoke execute on function owner_product_performance() from public;
revoke execute on function owner_product_performance() from anon;
grant execute on function owner_product_performance() to authenticated, service_role;


-- 3. The KPI summary. Same body as sales_kpi_summary(), behind the check.
create or replace function owner_sales_kpi_summary()
returns table(
  current_revenue numeric,
  current_cost numeric,
  previous_revenue numeric,
  previous_cost numeric
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if current_user_role() is distinct from 'owner' then
    raise exception 'Owner access only.';
  end if;

  return query
    with combined as (
      select sale_ts as ts, total_amount as amount, total_cost as cost
      from sales
      where status = 'confirmed' and sale_ts >= now() - interval '180 days'
      union all
      -- Services are labour: the full amount, no recorded cost.
      select service_ts as ts, total_amount as amount, 0::numeric as cost
      from services
      where status = 'confirmed' and service_ts >= now() - interval '180 days'
    )
    select
      coalesce(sum(amount) filter (where ts >= now() - interval '90 days'), 0) as current_revenue,
      coalesce(sum(cost)   filter (where ts >= now() - interval '90 days'), 0) as current_cost,
      coalesce(sum(amount) filter (where ts <  now() - interval '90 days'), 0) as previous_revenue,
      coalesce(sum(cost)   filter (where ts <  now() - interval '90 days'), 0) as previous_cost
    from combined;
end;
$$;

revoke execute on function owner_sales_kpi_summary() from public;
revoke execute on function owner_sales_kpi_summary() from anon;
grant execute on function owner_sales_kpi_summary() to authenticated, service_role;


-- 4. The margin sparkline. Same body as dashboard_margin_trend(), Manila
--    dates and all (migration 032), behind the check.
create or replace function owner_margin_trend()
returns table(
  period_start date,
  gross numeric,
  net numeric
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if current_user_role() is distinct from 'owner' then
    raise exception 'Owner access only.';
  end if;

  return query
    with combined as (
      select (sale_ts at time zone 'Asia/Manila')::date as ts, total_amount as amount, total_cost as cost
      from sales where status = 'confirmed'
      union all
      select (service_ts at time zone 'Asia/Manila')::date as ts, total_amount as amount, 0::numeric as cost
      from services where status = 'confirmed'
    ),
    today as (
      select (now() at time zone 'Asia/Manila')::date as d
    ),
    points as (
      select (date_trunc('month', today.d) - make_interval(months => n) - interval '1 day')::date as p
      from generate_series(0, 10) as n, today
      union all
      select today.d from today
    )
    select
      points.p as period_start,
      coalesce(sum(combined.amount), 0) as gross,
      coalesce(sum(combined.amount - combined.cost), 0) as net
    from points
    left join combined on combined.ts between points.p - 89 and points.p
    group by points.p
    order by points.p asc;
end;
$$;

revoke execute on function owner_margin_trend() from public;
revoke execute on function owner_margin_trend() from anon;
grant execute on function owner_margin_trend() to authenticated, service_role;


-- 5. Gross & Net for a calendar period. Same body as
--    dashboard_gross_net_range(), behind the check.
create or replace function owner_gross_net_range(
  p_start date,
  p_end date,
  p_bucket text
)
returns table(
  period_start timestamp,
  gross numeric,
  net numeric
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_step interval;
begin
  if current_user_role() is distinct from 'owner' then
    raise exception 'Owner access only.';
  end if;

  if p_bucket is null or p_bucket not in ('hour', 'day', 'month') then
    raise exception 'Unknown bucket %. Use ''hour'', ''day'' or ''month''.', coalesce(p_bucket, '(null)');
  end if;
  if p_start is null or p_end is null then
    raise exception 'p_start and p_end are both required.';
  end if;
  if p_end < p_start then
    raise exception 'p_end (%) is before p_start (%).', p_end, p_start;
  end if;
  if (p_end - p_start) > 400 then
    raise exception 'Range too wide: % days (maximum 400).', (p_end - p_start);
  end if;

  v_step := case p_bucket
              when 'hour' then interval '1 hour'
              when 'day' then interval '1 day'
              else interval '1 month'
            end;

  return query
    with combined as (
      select
        (sale_ts at time zone 'Asia/Manila') as ts,
        total_amount                         as amount,
        total_cost                           as cost
      from sales
      where status = 'confirmed'
      union all
      select
        (service_ts at time zone 'Asia/Manila') as ts,
        total_amount                            as amount,
        0::numeric                              as cost
      from services
      where status = 'confirmed'
    ),
    buckets as (
      select generate_series(
        date_trunc(p_bucket, p_start::timestamp),
        date_trunc(p_bucket, (p_end + 1)::timestamp - interval '1 microsecond'),
        v_step
      ) as bucket_start
    )
    select
      buckets.bucket_start::timestamp                          as period_start,
      coalesce(sum(combined.amount), 0)::numeric               as gross,
      coalesce(sum(combined.amount - combined.cost), 0)::numeric as net
    from buckets
    left join combined
      on combined.ts >= buckets.bucket_start
     and combined.ts <  buckets.bucket_start + v_step
    group by buckets.bucket_start
    order by buckets.bucket_start asc;
end;
$$;

revoke execute on function owner_gross_net_range(date, date, text) from public;
revoke execute on function owner_gross_net_range(date, date, text) from anon;
grant execute on function owner_gross_net_range(date, date, text) to authenticated, service_role;


-- 6. The Stock-In Tracker's log, with unit_cost and the spend it implies.
--
--    `spent` is computed here rather than in the browser, so the screen
--    never needs the per-unit figure at all - but unit_cost is returned
--    too, because the tracker shows it.
create or replace function owner_stockin_log(
  p_start timestamptz,
  p_end timestamptz
)
returns table(
  movement_id bigint,
  movement_ts timestamptz,
  sku varchar(40),
  product_name varchar(160),
  quantity integer,
  balance_after integer,
  supplier varchar(120),
  unit_cost numeric(12,2),
  spent numeric,
  reference varchar(120),
  recorded_by text
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if current_user_role() is distinct from 'owner' then
    raise exception 'Owner access only.';
  end if;

  return query
    select
      m.movement_id,
      m.movement_ts,
      m.sku,
      p.name as product_name,
      m.quantity,
      m.balance_after,
      m.supplier,
      m.unit_cost,
      case when m.unit_cost is null then null else m.unit_cost * m.quantity end as spent,
      m.reference,
      pr.full_name as recorded_by
    from stock_movements m
    left join products p  on p.product_id = m.product_id
    left join profiles pr on pr.id = m.user_id
    where m.movement_type = 'stock_in'
      and m.movement_ts >= p_start
      and m.movement_ts <  p_end
    order by m.movement_id desc;
end;
$$;

revoke execute on function owner_stockin_log(timestamptz, timestamptz) from public;
revoke execute on function owner_stockin_log(timestamptz, timestamptz) from anon;
grant execute on function owner_stockin_log(timestamptz, timestamptz) to authenticated, service_role;


-- 7. One SKU's whole supplier history, aggregated.
--
--    Deliberately not date-filtered, like the query it replaces: this is
--    "from what supplier is that item", over all time. Aggregating in SQL
--    also means the per-row costs never leave the database - the browser
--    only ever sees the totals.
create or replace function owner_stockin_by_supplier(p_sku text)
returns table(
  supplier text,
  units bigint,
  spent numeric,
  batches bigint
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if current_user_role() is distinct from 'owner' then
    raise exception 'Owner access only.';
  end if;

  return query
    select
      coalesce(nullif(m.supplier, ''), 'Unknown')::text as supplier,
      sum(m.quantity)::bigint                           as units,
      coalesce(sum(coalesce(m.unit_cost, 0) * m.quantity), 0)::numeric as spent,
      count(*)::bigint                                  as batches
    from stock_movements m
    where m.sku = p_sku
      and m.movement_type = 'stock_in'
    group by coalesce(nullif(m.supplier, ''), 'Unknown')
    order by units desc;
end;
$$;

revoke execute on function owner_stockin_by_supplier(text) from public;
revoke execute on function owner_stockin_by_supplier(text) from anon;
grant execute on function owner_stockin_by_supplier(text) to authenticated, service_role;


-- ---------------------------------------------------------------------
--  8 and 9. undo_sale and undo_service: refuse a caller with no profile.
--
--  Both read
--
--    if v_role <> 'owner' and ( ...the staff restriction... ) then
--
--  and v_role comes from current_user_role(), which is NULL when there is
--  no profile row for auth.uid(). `NULL <> 'owner'` is NULL, a plpgsql IF
--  treats NULL as false, so for such a caller the whole condition is
--  skipped and the staff restriction never applies: they could undo
--  ANYONE's sale or service, from ANY date. These are writes, which makes
--  this the more serious half of the same NULL bypass the owner_* guards
--  above had.
--
--  Confirmed against the live database rather than read off the source, by
--  web/scripts/check-staff-access.mjs: a signed-in caller whose profile row
--  had been removed reached 'Sale not found.' and 'Service record not
--  found.', which is only possible after passing the role logic.
--
--  The fix is the one the other five write RPCs already use - confirm_sale,
--  edit_sale, record_service, set_product_supplier and
--  record_stock_movements all raise on a null role immediately after the
--  lookup. These two were the only ones that did not.
--
--  ONLY that guard changes. Everything else, the Manila date comparison
--  from migration 031 included, is byte-identical to what
--  supabase_schema.sql held.
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
  -- A null role means there is no profile row for this account. Without
  -- this, `v_role <> 'owner'` below evaluates to NULL, the IF is skipped,
  -- and the staff restriction never applies - so the caller could undo
  -- anyone's record from any date. The other write RPCs all raise here.
  if v_role is null then
    raise exception 'No profile found for this account.';
  end if;

  select * into v_sale from sales where sale_id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found.';
  end if;
  if v_sale.status = 'voided' then
    raise exception 'Already undone.';
  end if;

  -- staff may undo only their own sale on the same day; owner may undo any.
  -- Manila, not UTC: a timestamptz cast to date uses the session's TimeZone,
  -- which for PostgREST is UTC, and so is current_date - which put "the same
  -- day" eight hours out of step with the trading day. See
  -- sql/migrations/031_fix_audit_batch_1.sql.
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
  -- A null role means there is no profile row for this account. Without
  -- this, `v_role <> 'owner'` below evaluates to NULL, the IF is skipped,
  -- and the staff restriction never applies - so the caller could undo
  -- anyone's record from any date. The other write RPCs all raise here.
  if v_role is null then
    raise exception 'No profile found for this account.';
  end if;

  select * into v_service from services where service_id = p_service_id for update;
  if not found then
    raise exception 'Service record not found.';
  end if;
  if v_service.status = 'voided' then
    raise exception 'Already undone.';
  end if;

  -- staff may undo only their own record on the same day; owner may undo
  -- any. Manila, not UTC - see undo_sale above, and
  -- sql/migrations/031_fix_audit_batch_1.sql.
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
--  VERIFY (read-only). Uncomment and run after the above.
-- ---------------------------------------------------------------------

-- a. All seven exist, are security definer, and pin search_path.

/*
select p.proname, p.prosecdef as security_definer, p.proconfig
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'owner\_%'
order by p.proname;
*/

-- b. Every one carries the role check. MUST be true for all seven.

/*
select p.proname, p.prosrc like '%current_user_role() <> ''owner''%' as has_owner_check
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'owner\_%'
order by p.proname;
*/

-- c. Executable by authenticated and service_role, by neither anon nor
--    PUBLIC. (The role check inside is what separates owner from staff;
--    the grant only has to let a signed-in session reach it.)

/*
select p.proname,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_role,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'owner\_%'
order by p.proname;
*/

-- d. As the owner, each returns rows; as staff, each raises. Easiest
--    checked from the app side - see web/scripts/check-staff-access.mjs.
