-- =====================================================================
--  Bugfix: the dashboard's Gross Profit Margin tile was computing its
--  current-vs-previous-90-day comparison by pulling every confirmed sale
--  from the last 180 days to the client and summing there, with no
--  pagination and no order-by. Once that crossed PostgREST's default
--  1000-row page (easily happens at real sales volume), the client only
--  ever saw an arbitrary leading slice of the 180-day window - in
--  practice the oldest rows in it, since an unordered index range scan
--  tends to come back in roughly that order. That pushed every sale from
--  the real last-90-days bucket out of the page entirely, reading as a
--  false "0% gross margin, down 25.9pt" despite the business actually
--  being profitable and growing in that window.
--
--  Fix: aggregate both 90-day buckets in SQL and return a single row -
--  correct regardless of how many sales exist, not just "paginate
--  correctly" with a bigger ceiling.
--
--  ADDITIVE ONLY - safe to run with real data. Run in a NEW query tab.
--  Also mirrored into sql/supabase_schema.sql.
-- =====================================================================

create or replace function sales_kpi_summary()
returns table(
  current_revenue numeric,
  current_cost numeric,
  previous_revenue numeric,
  previous_cost numeric
)
language sql
stable
as $$
  select
    coalesce(sum(total_amount) filter (
      where sale_ts >= now() - interval '90 days'), 0) as current_revenue,
    coalesce(sum(total_cost) filter (
      where sale_ts >= now() - interval '90 days'), 0) as current_cost,
    coalesce(sum(total_amount) filter (
      where sale_ts < now() - interval '90 days'), 0) as previous_revenue,
    coalesce(sum(total_cost) filter (
      where sale_ts < now() - interval '90 days'), 0) as previous_cost
  from sales
  where status = 'confirmed' and sale_ts >= now() - interval '180 days';
$$;

grant execute on function sales_kpi_summary() to authenticated, service_role;
