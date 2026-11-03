-- =====================================================================
--  Perf fix: Decision Support was calling monthly_demand(sku) once per
--  active product (576 separate round trips with the real catalog) to
--  build each SKU's monthly series. Fine with a handful of test products,
--  not fine at real scale. This returns every SKU's monthly demand in a
--  single query instead - the app groups it by sku client-side.
--
--  ADDITIVE ONLY - safe to run with real data. Run in a NEW query tab.
--  Also mirrored into sql/supabase_schema.sql.
-- =====================================================================

create or replace function monthly_demand_all()
returns table(sku text, year int, month int, units numeric)
language sql
stable
as $$
  select
    p.sku,
    extract(year from s.sale_ts)::int as year,
    extract(month from s.sale_ts)::int as month,
    sum(si.quantity)::numeric as units
  from sale_items si
  join sales s    on s.sale_id = si.sale_id
  join products p on p.product_id = si.product_id
  where s.status = 'confirmed'
  group by p.sku, year, month
  order by p.sku, year, month;
$$;

grant execute on function monthly_demand_all() to authenticated, service_role;
