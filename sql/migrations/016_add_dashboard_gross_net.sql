-- =====================================================================
--  Adds the function backing the Dashboard's Gross & Net chart, which
--  replaces the old Sales Volume Heatmap. Combines sales (revenue has
--  a cost, so net = revenue - cost) and services (manual entry, no
--  cost tracked, so net = gross for that row) into one per-period
--  timeline, grouped by day/week/month/year.
--
--  ADDITIVE ONLY - safe to run against real data. Run in a NEW SQL
--  Editor query tab. Mirrors sql/supabase_schema.sql, which stays the
--  source of truth for a from-scratch setup - keep them in sync if you
--  change either. Depends on sql/migrations/013_add_services.sql already
--  having been run (needs the services table).
-- =====================================================================

create or replace function dashboard_gross_net_summary(p_granularity text, p_periods integer default 12)
returns table(
  period_start date,
  gross numeric,
  net numeric
)
language sql
stable
as $$
  with combined as (
    select sale_ts as ts, total_amount as amount, total_cost as cost
    from sales where status = 'confirmed'
    union all
    select service_ts as ts, total_amount as amount, 0::numeric as cost
    from services where status = 'confirmed'
  )
  select period_start, gross, net from (
    select
      date_trunc(p_granularity, ts)::date as period_start,
      sum(amount)        as gross,
      sum(amount - cost) as net
    from combined
    group by period_start
    order by period_start desc
    limit p_periods
  ) recent
  order by period_start asc;
$$;

grant execute on function dashboard_gross_net_summary(text, integer) to authenticated, service_role;
