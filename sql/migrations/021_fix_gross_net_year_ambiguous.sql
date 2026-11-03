-- =====================================================================
--  Fixes a bug in dashboard_gross_net_summary()'s 'year' branch (Gross &
--  Net chart, "Year" tab): same root cause as the edit_sale() bug fixed
--  earlier - the function's `returns table(period_start date, gross
--  numeric, net numeric)` makes period_start/gross/net implicit plpgsql
--  variables throughout the function body. The 'year' branch's outer
--  `select period_start, gross, net from (...) recent` (and the inner
--  subquery's `group by period_start` / `order by period_start desc`)
--  referenced those names bare, which Postgres can't resolve between the
--  plpgsql variable and the subquery's own same-named column - "column
--  reference 'period_start' is ambiguous" (42702) on every 'year' call.
--
--  The day/week/month branches never hit this: they always alias off a
--  qualified source column (days.d as period_start, buckets.bucket_start
--  as period_start, months.m as period_start) and never reference the
--  bare alias afterward, so there's nothing ambiguous to resolve.
--
--  Fix: qualify every reference with the subquery's `recent` alias, and
--  group/order by the actual expression instead of the bare alias.
--  Function signature (name, params, return columns) is unchanged, so
--  this is a plain CREATE OR REPLACE - no need to drop first.
--
--  ADDITIVE ONLY - safe to run with real data. Run in a NEW query tab.
--  Also mirrored into sql/supabase_schema.sql and
--  sql/migrations/017_fix_gross_net_windows.sql.
-- =====================================================================

create or replace function dashboard_gross_net_summary(p_granularity text, p_periods integer default 12)
returns table(
  period_start date,
  gross numeric,
  net numeric
)
language plpgsql
stable
as $$
declare
  v_today date := current_date;
begin
  if p_granularity = 'day' then
    return query
      with combined as (
        select sale_ts::date as ts, total_amount as amount, total_cost as cost
        from sales where status = 'confirmed'
        union all
        select service_ts::date as ts, total_amount as amount, 0::numeric as cost
        from services where status = 'confirmed'
      ),
      days as (
        select generate_series(v_today - 29, v_today, interval '1 day')::date as d
      )
      select
        days.d as period_start,
        coalesce(sum(combined.amount), 0) as gross,
        coalesce(sum(combined.amount - combined.cost), 0) as net
      from days
      left join combined on combined.ts = days.d
      group by days.d
      order by days.d asc;

  elsif p_granularity = 'week' then
    return query
      with combined as (
        select sale_ts::date as ts, total_amount as amount, total_cost as cost
        from sales where status = 'confirmed'
        union all
        select service_ts::date as ts, total_amount as amount, 0::numeric as cost
        from services where status = 'confirmed'
      ),
      month_bounds as (
        select
          date_trunc('month', v_today)::date as m_start,
          (date_trunc('month', v_today) + interval '1 month' - interval '1 day')::date as m_end
      ),
      buckets as (
        select
          (m_start + (n * 7)) as bucket_start,
          least(m_start + (n * 7) + 6, m_end) as bucket_end
        from month_bounds, generate_series(0, 4) as n
        where (m_start + (n * 7)) <= m_end
          and (m_start + (n * 7)) <= v_today
      )
      select
        buckets.bucket_start as period_start,
        coalesce(sum(combined.amount), 0) as gross,
        coalesce(sum(combined.amount - combined.cost), 0) as net
      from buckets
      left join combined on combined.ts between buckets.bucket_start and buckets.bucket_end
      group by buckets.bucket_start, buckets.bucket_end
      order by buckets.bucket_start asc;

  elsif p_granularity = 'month' then
    return query
      with combined as (
        select sale_ts::date as ts, total_amount as amount, total_cost as cost
        from sales where status = 'confirmed'
        union all
        select service_ts::date as ts, total_amount as amount, 0::numeric as cost
        from services where status = 'confirmed'
      ),
      months as (
        select generate_series(date_trunc('year', v_today), date_trunc('month', v_today), interval '1 month')::date as m
      )
      select
        months.m as period_start,
        coalesce(sum(combined.amount), 0) as gross,
        coalesce(sum(combined.amount - combined.cost), 0) as net
      from months
      left join combined on date_trunc('month', combined.ts)::date = months.m
      group by months.m
      order by months.m asc;

  else -- 'year' - unchanged trailing-periods-with-data behavior
    return query
      with combined as (
        select sale_ts as ts, total_amount as amount, total_cost as cost
        from sales where status = 'confirmed'
        union all
        select service_ts as ts, total_amount as amount, 0::numeric as cost
        from services where status = 'confirmed'
      )
      select recent.period_start, recent.gross, recent.net from (
        select
          date_trunc('year', ts)::date as period_start,
          sum(amount)        as gross,
          sum(amount - cost) as net
        from combined
        group by date_trunc('year', ts)::date
        order by date_trunc('year', ts)::date desc
        limit p_periods
      ) recent
      order by recent.period_start asc;
  end if;
end;
$$;

grant execute on function dashboard_gross_net_summary(text, integer) to authenticated, service_role;
