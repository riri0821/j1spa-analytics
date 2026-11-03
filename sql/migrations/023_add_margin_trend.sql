-- =====================================================================
--  dashboard_margin_trend() - rolling 90-day gross & net, sampled at the
--  last 11 month-ends plus today (12 points), for the hero card's margin
--  sparkline. Each point is the trailing-90-day window ending on that date,
--  the same measure as the headline Gross Profit Margin tile, so the final
--  point matches it (up to the headline's now()-vs-date boundary).
--
--  Separate from dashboard_gross_net_summary() on purpose: that function's
--  'month' branch is calendar-year-to-date and the Gross & Net chart depends
--  on it. Same definition as the rest of the dashboard: services count at
--  their full amount with zero cost.
--
--  Replaces the earlier calendar-month version (same signature).
--  Run in a NEW query tab in the Supabase SQL editor. Also mirrored into
--  sql/supabase_schema.sql.
-- =====================================================================

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
    select sale_ts::date as ts, total_amount as amount, total_cost as cost
    from sales where status = 'confirmed'
    union all
    select service_ts::date as ts, total_amount as amount, 0::numeric as cost
    from services where status = 'confirmed'
  ),
  points as (
    select (date_trunc('month', current_date) - make_interval(months => n) - interval '1 day')::date as p
    from generate_series(0, 10) as n
    union all
    select current_date
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

grant execute on function dashboard_margin_trend() to authenticated, service_role;
