-- =====================================================================
--  Phase 3: monthly demand series for the forecasting service.
--
--  ADDITIVE ONLY - safe to run with real data. Run in a NEW query tab.
--  Also mirrored into sql/supabase_schema.sql (source of truth for a
--  from-scratch setup) - keep both in sync if you change this.
--
--  Replaces the old fact_transactions/dim_date/dim_product join (the
--  MySQL warehouse star schema) - reads straight off the operational
--  tables instead, same as the other reporting views.
-- =====================================================================

create or replace function monthly_demand(p_sku text)
returns table(year int, month int, units numeric)
language sql
stable
as $$
  select
    extract(year from s.sale_ts)::int as year,
    extract(month from s.sale_ts)::int as month,
    sum(si.quantity)::numeric as units
  from sale_items si
  join sales s    on s.sale_id = si.sale_id
  join products p on p.product_id = si.product_id
  where p.sku = p_sku and s.status = 'confirmed'
  group by year, month
  order by year, month;
$$;

grant execute on function monthly_demand(text) to authenticated, service_role;
