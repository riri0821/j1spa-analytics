-- =====================================================================
--  DATA ONLY - no schema change, no function change, no policy change.
--  Two columns are written and nothing else:
--
--      products.supplier
--      stock_movements.supplier   (movement_type = 'stock_in' rows only)
--
--  Quantities, costs, balances, timestamps, references, notes and user_ids
--  are not touched by any statement below.
--
--  Why: all 576 products carry supplier = 'Unknown' (the default
--  set_product_supplier() falls back to), so the stock ledger's Supplier
--  column reads "Unknown" on every line and the Stock-In Tracker's
--  by-supplier breakdown is a single "Unknown" bucket. The owner deals with
--  three suppliers and calls them Supplier 1, Supplier 2 and Supplier 3.
--
--  How the categories were split: one supplier per category, so a given
--  item always comes from the same supplier and the historical snapshots
--  below are therefore the same name as the product's current supplier -
--  which is what lets the ledger column and the tracker's breakdown agree.
--  The three are balanced by product count (188 / 196 / 192 against an even
--  split of 192) and grouped so each supplier's categories hang together:
--
--    Supplier 1  transmission       188 products   2,369 stock_in rows
--                CVT & Clutch Parts (170), Bearings (18)
--
--    Supplier 2  engine & service   196 products   3,283 stock_in rows
--                Engine Internals (57), Electrical (33), Filters (30),
--                Gaskets & Seals (29), Oils & Fluids (27), Hardware (12),
--                Exhaust (5), Battery (3)
--
--    Supplier 3  chassis & general  192 products   2,035 stock_in rows
--                Other Parts (122), Brakes (37), Tires (16),
--                Suspension (10), Accessories (7)
--
--  Totals: 576 products, 7,687 stock_in rows - every one of them, with
--  nothing left on 'Unknown'.
--
--  Safe to re-run. The backup tables are created only if they do not
--  already exist, so a second run cannot overwrite the pre-change snapshot
--  with post-change values, and both updates skip rows that already hold
--  the right name. Rolling back is sql/migrations/039_rollback.sql, which
--  reads those same backup tables.
--
--  A second copy of both columns was taken to
--  web/scripts/backups/supplier-columns-<timestamp>.json by
--  web/scripts/backup-supplier-columns.mjs before this was written, so the
--  previous values survive even the backup schema being dropped.
--
--  Run the whole file in ONE query tab in the Supabase SQL editor. It is
--  wrapped in a transaction: if any guard raises, nothing is written.
-- =====================================================================

begin;

-- ------------------------------------------------------------- 1. backup
--
-- Same convention as the cleanup script's backup: a `backup` schema, which
-- PostgREST does not expose, so these tables are not reachable from the
-- app or the browser.
create schema if not exists backup;

create table if not exists backup.supplier_20261113_products as
select product_id, sku, category, supplier
from products
order by product_id;

create table if not exists backup.supplier_20261113_stock_movements as
select movement_id, product_id, sku, movement_type, supplier
from stock_movements
where movement_type = 'stock_in'
order by movement_id;

-- The backup must cover every row the updates below can touch. If it does
-- not, something has changed since it was taken and the rollback would be
-- incomplete - so stop rather than write.
do $$
declare
  v_p_backed bigint;
  v_p_live bigint;
  v_m_backed bigint;
  v_m_live bigint;
begin
  select count(*) into v_p_backed from backup.supplier_20261113_products;
  select count(*) into v_p_live from products;
  select count(*) into v_m_backed from backup.supplier_20261113_stock_movements;
  select count(*) into v_m_live from stock_movements where movement_type = 'stock_in';

  if v_p_backed <> v_p_live then
    raise exception 'products backup holds % rows but products has % - nothing written.',
      v_p_backed, v_p_live;
  end if;
  if v_m_backed <> v_m_live then
    raise exception 'stock_in backup holds % rows but stock_movements has % - nothing written.',
      v_m_backed, v_m_live;
  end if;

  raise notice 'backed up: % products, % stock_in movements', v_p_backed, v_m_backed;
end $$;

-- -------------------------------------------------------- 2. the mapping
--
-- One row per category, in a temp table so the two updates and the guards
-- all read the same single source of truth. It disappears when the session
-- ends; nothing permanent is created.
create temporary table supplier_map (
  category text primary key,
  supplier text not null
) on commit drop;

insert into supplier_map (category, supplier) values
  -- Supplier 1 - transmission
  ('CVT & Clutch Parts', 'Supplier 1'),
  ('Bearings',           'Supplier 1'),
  -- Supplier 2 - engine & service
  ('Engine Internals',   'Supplier 2'),
  ('Electrical',         'Supplier 2'),
  ('Filters',            'Supplier 2'),
  ('Gaskets & Seals',    'Supplier 2'),
  ('Oils & Fluids',      'Supplier 2'),
  ('Hardware',           'Supplier 2'),
  ('Exhaust',            'Supplier 2'),
  ('Battery',            'Supplier 2'),
  -- Supplier 3 - chassis & general
  ('Other Parts',        'Supplier 3'),
  ('Brakes',             'Supplier 3'),
  ('Tires',              'Supplier 3'),
  ('Suspension',         'Supplier 3'),
  ('Accessories',        'Supplier 3');

-- Every product must map to a supplier. A category added since this was
-- written would otherwise silently keep 'Unknown'.
do $$
declare
  v_unmapped text;
  v_unused text;
begin
  select string_agg(distinct p.category, ', ' order by p.category)
    into v_unmapped
    from products p
    left join supplier_map m on m.category = p.category
   where m.category is null;

  if v_unmapped is not null then
    raise exception
      'These product categories are not in supplier_map: %. Add them and re-run; nothing has been written.',
      v_unmapped;
  end if;

  -- The other direction is a typo, not a blocker: a mapped category that
  -- matches no product assigns nothing.
  select string_agg(m.category, ', ' order by m.category)
    into v_unused
    from supplier_map m
    left join products p on p.category = m.category
   where p.category is null;

  if v_unused is not null then
    raise notice 'supplier_map has categories matching no product (check for typos): %', v_unused;
  end if;
end $$;

-- ------------------------------------------------- 3. products.supplier
--
-- `supplier` is the only column in the SET list.
update products p
   set supplier = m.supplier
  from supplier_map m
 where m.category = p.category
   and p.supplier is distinct from m.supplier;

-- ------------------------------------- 4. the stock_in supplier snapshot
--
-- Taken from products.supplier, which step 3 has just set, rather than from
-- the map again - that is what guarantees the ledger's Supplier column and
-- the tracker's by-supplier breakdown cannot disagree.
--
-- Each supplier always delivers the same categories, so an item's supplier
-- is the same for its whole history and the current name is also the
-- correct historical one. `movement_type = 'stock_in'` keeps every other
-- movement type's supplier at null, which is what the schema expects (see
-- sql/migrations/018_add_stockin_supplier_cost.sql).
update stock_movements sm
   set supplier = p.supplier
  from products p
 where p.product_id = sm.product_id
   and sm.movement_type = 'stock_in'
   and sm.supplier is distinct from p.supplier;

-- -------------------------------------------------------- 5. the guards
--
-- Anything wrong here aborts the transaction and leaves the database as it
-- was.
do $$
declare
  v_unknown_products bigint;
  v_unknown_movements bigint;
  v_mismatched bigint;
  v_leaked bigint;
  v_bad_name bigint;
begin
  select count(*) into v_unknown_products from products where supplier = 'Unknown';
  if v_unknown_products > 0 then
    raise exception '% product(s) still say Unknown.', v_unknown_products;
  end if;

  select count(*) into v_unknown_movements
    from stock_movements where movement_type = 'stock_in' and supplier = 'Unknown';
  if v_unknown_movements > 0 then
    raise exception '% stock_in row(s) still say Unknown.', v_unknown_movements;
  end if;

  -- The two columns must agree, product by product.
  select count(*) into v_mismatched
    from stock_movements sm
    join products p on p.product_id = sm.product_id
   where sm.movement_type = 'stock_in'
     and sm.supplier is distinct from p.supplier;
  if v_mismatched > 0 then
    raise exception '% stock_in row(s) disagree with their product''s supplier.', v_mismatched;
  end if;

  -- Nothing may have been written to a movement that never carried a
  -- supplier in the first place.
  select count(*) into v_leaked
    from stock_movements where movement_type <> 'stock_in' and supplier is not null;
  if v_leaked > 0 then
    raise exception '% non-stock_in row(s) now carry a supplier.', v_leaked;
  end if;

  -- Only the three names, nowhere else.
  select count(*) into v_bad_name
    from products where supplier not in ('Supplier 1', 'Supplier 2', 'Supplier 3');
  if v_bad_name > 0 then
    raise exception '% product(s) hold a supplier outside the three.', v_bad_name;
  end if;

  raise notice 'all guards passed';
end $$;

commit;

-- =====================================================================
--  Verify, after running. Expected results are given for each.
-- =====================================================================

-- 1. Products per supplier: 188 / 196 / 192, total 576, no 'Unknown'.
select supplier, count(*) as products
from products
group by supplier
order by supplier;

-- 2. The category-to-supplier mapping as it now stands - one supplier per
--    category, 15 rows.
select category, supplier, count(*) as products
from products
group by category, supplier
order by supplier, products desc;

-- 3. A category must never span two suppliers. Must return 0 rows.
select category, count(distinct supplier) as suppliers
from products
group by category
having count(distinct supplier) > 1;

-- 4. The stock_in snapshots: 2,369 / 3,283 / 2,035, total 7,687.
select supplier, count(*) as stock_in_rows
from stock_movements
where movement_type = 'stock_in'
group by supplier
order by supplier;

-- 5. The two columns agree everywhere. Must return 0.
select count(*) as mismatched
from stock_movements sm
join products p on p.product_id = sm.product_id
where sm.movement_type = 'stock_in'
  and sm.supplier is distinct from p.supplier;

-- 6. No other movement type picked up a supplier. Must return 0.
select count(*) as leaked
from stock_movements
where movement_type <> 'stock_in' and supplier is not null;

-- 7. Nothing but the supplier moved. Both must return 0: the backup holds
--    every other column of the stock_in rows it snapshotted.
select count(*) as movements_changed_beyond_supplier
from stock_movements sm
join backup.supplier_20261113_stock_movements b on b.movement_id = sm.movement_id
where (sm.product_id, sm.sku, sm.movement_type)
      is distinct from (b.product_id, b.sku, b.movement_type);

select count(*) as products_changed_beyond_supplier
from products p
join backup.supplier_20261113_products b on b.product_id = p.product_id
where (p.sku, p.category) is distinct from (b.sku, b.category);

-- 8. What the Stock-In Tracker's by-supplier breakdown will show for one
--    SKU - the same function the screen calls. Owner session only.
-- select * from owner_stockin_by_supplier('J1-0277');
