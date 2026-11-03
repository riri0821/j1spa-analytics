-- =====================================================================
--  Change: the dashboard's Gross Profit Margin tile counted only rows in
--  `sales`. Per the client, "sales" means sales + services combined (the
--  same definition the Gross & Net Sales chart already uses in
--  dashboard_gross_net_summary: services contribute their full amount at
--  zero cost). This makes sales_kpi_summary() match, so the headline
--  margin, its previous-90-day delta, and the margin sparkline all agree.
--
--  Same signature and return columns as before - the deployed app keeps
--  working whether or not the new web code has been pushed yet.
--
--  Run in a NEW query tab in the Supabase SQL editor. Also mirrored into
--  sql/supabase_schema.sql.
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
  with combined as (
    select sale_ts as ts, total_amount as amount, total_cost as cost
    from sales
    where status = 'confirmed' and sale_ts >= now() - interval '180 days'
    union all
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
$$;

grant execute on function sales_kpi_summary() to authenticated, service_role;
