-- =====================================================================
--  Batch 2: the dashboard's own "today", in Manila time.
--
--  Follow-up to migration 031, which fixed the staff undo window. The same
--  UTC assumption was left in the functions that decide period edges, so
--  the dashboard's months and the forecaster's monthly demand were cut on
--  UTC dates while every date the app displays is a Manila one.
--
--  A timestamptz cast to date, or fed to extract()/date_trunc(), resolves
--  in the SESSION's TimeZone - UTC for PostgREST - and so does
--  current_date. Manila is UTC+8, so 00:00-08:00 Manila falls on the
--  PREVIOUS UTC date: a sale at 01:00 on the 1st of a month was being
--  counted in the month before.
--
--  STEP 1  dashboard_margin_trend()  - rebucketed, Manila
--  STEP 2  monthly_demand(text)      - rebucketed, Manila
--  STEP 3  monthly_demand_all()      - rebucketed, Manila
--  STEP 4  dashboard_gross_net_summary(text, integer) - DROPPED, uncalled
--  STEP 5  Read-only verification (commented)
--
--  Each function is recreated with ONLY the timezone change; every other
--  line is identical to what supabase_schema.sql held. Grants are unchanged
--  (authenticated, service_role).
--
--  NOT changed, and why:
--    * sales_kpi_summary()        - compares `sale_ts >= now() - interval
--      '90 days'`. That is an instant against an instant, so it means the
--      same ninety-day window in any timezone. Nothing to fix.
--    * dashboard_gross_net_range() - already buckets on
--      `at time zone 'Asia/Manila'` (migration 028).
--    * vw_product_velocity        - same rolling-instant form as
--      sales_kpi_summary.
--
--  STILL UTC, deliberately left alone because nothing calls them - the same
--  reasoning that drops dashboard_gross_net_summary below, but these were
--  not in scope to remove: monthly_sales_totals(), vw_daily_sales,
--  vw_monthly_sales. Either fix or drop them when something needs them.
--
--  SAFE TO RUN against real data: four function definitions, no table data
--  touched. Run in a NEW query tab. Mirrored into sql/supabase_schema.sql.
-- =====================================================================


-- ---------------------------------------------------------------------
--  STEP 1 - dashboard_margin_trend()
--
--  Feeds the dashboard hero card's 90-day margin sparkline: twelve points,
--  each the trailing 90 days ending on a month end, plus today.
--
--  Three UTC reads, all of them now Manila:
--    * sale_ts::date and service_ts::date, which decide which day a sale
--      lands on inside each 90-day window;
--    * current_date, twice, which decides where the twelve points sit.
-- ---------------------------------------------------------------------

create or replace function dashboard_margin_trend()
returns table(
  period_start date,
  gross numeric,
  net numeric
)
language sql
stable
as $$
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
$$;

revoke execute on function dashboard_margin_trend() from public;
revoke execute on function dashboard_margin_trend() from anon;
grant execute on function dashboard_margin_trend() to authenticated, service_role;


-- ---------------------------------------------------------------------
--  STEP 2 - monthly_demand(p_sku)
--
--  One SKU's units per month. Read by the forecasting service (every
--  model's input series) and by Decision Support. extract() on a
--  timestamptz resolves in UTC, so each month lost its first eight hours
--  to the month before.
-- ---------------------------------------------------------------------

create or replace function monthly_demand(p_sku text)
returns table(year int, month int, units numeric)
language sql
stable
as $$
  select
    extract(year from (s.sale_ts at time zone 'Asia/Manila'))::int as year,
    extract(month from (s.sale_ts at time zone 'Asia/Manila'))::int as month,
    sum(si.quantity)::numeric as units
  from sale_items si
  join sales s    on s.sale_id = si.sale_id
  join products p on p.product_id = si.product_id
  where p.sku = p_sku and s.status = 'confirmed'
  group by year, month
  order by year, month;
$$;

revoke execute on function monthly_demand(text) from public;
revoke execute on function monthly_demand(text) from anon;
grant execute on function monthly_demand(text) to authenticated, service_role;


-- ---------------------------------------------------------------------
--  STEP 3 - monthly_demand_all()
--
--  The same series for every SKU in one call, which is what Decision
--  Support uses. Same change, same reason.
-- ---------------------------------------------------------------------

create or replace function monthly_demand_all()
returns table(sku text, year int, month int, units numeric)
language sql
stable
as $$
  select
    p.sku,
    extract(year from (s.sale_ts at time zone 'Asia/Manila'))::int as year,
    extract(month from (s.sale_ts at time zone 'Asia/Manila'))::int as month,
    sum(si.quantity)::numeric as units
  from sale_items si
  join sales s    on s.sale_id = si.sale_id
  join products p on p.product_id = si.product_id
  where s.status = 'confirmed'
  group by p.sku, year, month
  order by p.sku, year, month;
$$;

revoke execute on function monthly_demand_all() from public;
revoke execute on function monthly_demand_all() from anon;
grant execute on function monthly_demand_all() to authenticated, service_role;


-- ---------------------------------------------------------------------
--  STEP 4 - drop dashboard_gross_net_summary(text, integer)
--
--  Superseded by dashboard_gross_net_range(), which the Gross & Net chart
--  has called since migration 028. Nothing in web/src or forecast-service
--  references it - only the historical migration headers that describe it.
--  It buckets on a UTC date cast, so leaving it in place would be leaving a
--  function that answers the same question wrongly, for the next person who
--  finds it and assumes it is current.
-- ---------------------------------------------------------------------

drop function if exists dashboard_gross_net_summary(text, integer);


-- ---------------------------------------------------------------------
--  STEP 5 - VERIFY (read-only). Uncomment and run after the above.
-- ---------------------------------------------------------------------

-- 5a. All three functions read Manila and none of them UTC any more. Every
--     row must show uses_manila = true and the other two false.

/*
select proname,
       prosrc like '%Asia/Manila%'  as uses_manila,
       prosrc like '%current_date%' as still_uses_current_date,
       prosrc ~ 'from (s\.)?sale_ts|sale_ts::date' as still_casts_raw_ts
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and proname in ('dashboard_margin_trend', 'monthly_demand', 'monthly_demand_all')
order by proname;
*/

-- 5b. The dropped function is gone. MUST return 0 rows.

/*
select p.proname from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'dashboard_gross_net_summary';
*/

-- 5c. Grants survived the recreate: each must be executable by
--     authenticated and service_role, and by neither anon nor PUBLIC.

/*
select p.proname,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_role,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('dashboard_margin_trend', 'monthly_demand', 'monthly_demand_all')
order by p.proname;
*/

-- 5d. The shift this introduces, in one query: sales that fall in the first
--     eight hours of a Manila day are the ones that change month. This
--     counts how many confirmed sales sit in a different month under each
--     reading - the size of the correction, not an error.

/*
select
  count(*) as sales_total,
  count(*) filter (
    where date_trunc('month', sale_ts at time zone 'Asia/Manila')
       <> date_trunc('month', sale_ts at time zone 'UTC')
  ) as sales_changing_month,
  count(*) filter (
    where (sale_ts at time zone 'Asia/Manila')::date
       <> (sale_ts at time zone 'UTC')::date
  ) as sales_changing_day
from sales
where status = 'confirmed';
*/
