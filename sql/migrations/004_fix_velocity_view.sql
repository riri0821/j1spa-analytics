-- =====================================================================
--  Bugfix: vw_product_velocity was counting voided (and stale >90d)
--  sales in units_90d/revenue_90d/gross_profit_90d.
--
--  Cause: it joined sale_items to products unconditionally, then tried
--  to filter by sales.status/date in a SECOND join's ON clause - by
--  then the sale_items numbers were already attached to the product
--  regardless of whether that second join matched. A voided sale's
--  line items kept counting toward the product's trailing-90-day
--  figures on the dashboard.
--
--  Fix: pre-filter sale_items to only rows belonging to a confirmed,
--  in-window sale BEFORE joining to products.
--
--  ADDITIVE ONLY (CREATE OR REPLACE VIEW never touches table data) -
--  safe to run with real data. Also fixed in sql/supabase_schema.sql
--  (source of truth for a from-scratch setup) - keep both in sync.
-- =====================================================================

create or replace view vw_product_velocity as
select
  p.sku,
  p.name     as product_name,
  p.category as category_name,
  coalesce(sum(si.quantity), 0)                     as units_90d,
  coalesce(sum(si.line_revenue), 0)                 as revenue_90d,
  coalesce(sum(si.line_revenue - si.line_cost), 0)  as gross_profit_90d
from products p
left join (
  select si.*
  from sale_items si
  join sales s on s.sale_id = si.sale_id
  where s.status = 'confirmed' and s.sale_ts >= now() - interval '90 days'
) si on si.product_id = p.product_id
group by p.sku, p.name, p.category;
