-- =====================================================================
--  Bugfix: the dashboard's Sales Volume Heatmap (and anything else reading
--  vw_monthly_sales directly) was silently truncated to PostgREST's
--  default 1000-row page. That view groups by year/month/sku, so the real
--  catalog produces 40,000+ rows - the unpaginated client query only ever
--  saw an arbitrary first slice of them, understating every month's real
--  unit volume (and masking the shop's actual 2020->2026 growth curve).
--
--  Fix: aggregate shop-wide totals in SQL (one row per calendar month -
--  a few dozen, ever, regardless of catalog size) instead of shipping
--  every sku's rows to the client to sum there.
--
--  ADDITIVE ONLY - safe to run with real data. Run in a NEW query tab.
--  Also mirrored into sql/supabase_schema.sql.
-- =====================================================================

create or replace function monthly_sales_totals()
returns table(year int, month int, units numeric)
language sql
stable
as $$
  select
    extract(year from s.sale_ts)::int as year,
    extract(month from s.sale_ts)::int as month,
    sum(si.quantity)::numeric as units
  from sale_items si
  join sales s on s.sale_id = si.sale_id
  where s.status = 'confirmed'
  group by year, month
  order by year, month;
$$;

grant execute on function monthly_sales_totals() to authenticated, service_role;
