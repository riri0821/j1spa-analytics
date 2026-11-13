-- =====================================================================
--  Undo sql/migrations/039_assign_suppliers.sql.
--
--  Puts products.supplier and the stock_in supplier snapshots back to
--  exactly the values the backup tables hold - which is 'Unknown' on all
--  576 products and all 7,687 stock_in rows, as they were before 039 ran.
--
--  DATA ONLY, and only the `supplier` column of each table. Nothing else is
--  read from the backup and nothing else is written.
--
--  Needs backup.supplier_20261113_products and
--  backup.supplier_20261113_stock_movements, which 039 created before it
--  wrote anything. If those have been dropped, restore from
--  web/scripts/backups/supplier-columns-<timestamp>.json instead - it holds
--  the same two columns keyed by product_id and movement_id.
--
--  Does NOT touch migration 038: the ambiguity fix in
--  record_stock_movements() is unrelated to the supplier names and should
--  stay. Rolling that one back means re-running 026.
--
--  Safe to re-run. Run the whole file in ONE query tab.
-- =====================================================================

begin;

-- The backup has to be there, and has to still describe this database.
do $$
declare
  v_p_backed bigint;
  v_p_live bigint;
  v_m_backed bigint;
  v_m_live bigint;
begin
  if to_regclass('backup.supplier_20261113_products') is null
     or to_regclass('backup.supplier_20261113_stock_movements') is null then
    raise exception
      'The backup tables from 039 are gone. Restore from web/scripts/backups/supplier-columns-<timestamp>.json instead; nothing has been written.';
  end if;

  select count(*) into v_p_backed from backup.supplier_20261113_products;
  select count(*) into v_p_live from products;
  select count(*) into v_m_backed from backup.supplier_20261113_stock_movements;
  select count(*) into v_m_live from stock_movements where movement_type = 'stock_in';

  if v_p_backed <> v_p_live then
    raise exception 'products backup holds % rows, products has % - nothing written.',
      v_p_backed, v_p_live;
  end if;
  if v_m_backed <> v_m_live then
    raise exception 'stock_in backup holds % rows, stock_movements has % - nothing written.',
      v_m_backed, v_m_live;
  end if;
end $$;

-- ------------------------------------------------------------- products
update products p
   set supplier = b.supplier
  from backup.supplier_20261113_products b
 where b.product_id = p.product_id
   and p.supplier is distinct from b.supplier;

-- -------------------------------------------- the stock_in snapshots
--
-- Keyed by movement_id, so each row gets back the value it personally had.
-- The movement_type filter is belt-and-braces: the backup holds stock_in
-- rows only.
update stock_movements sm
   set supplier = b.supplier
  from backup.supplier_20261113_stock_movements b
 where b.movement_id = sm.movement_id
   and sm.movement_type = 'stock_in'
   and sm.supplier is distinct from b.supplier;

-- ---------------------------------------------------------------- guards
do $$
declare
  v_p_left bigint;
  v_m_left bigint;
begin
  select count(*) into v_p_left
    from products p
    join backup.supplier_20261113_products b on b.product_id = p.product_id
   where p.supplier is distinct from b.supplier;
  if v_p_left > 0 then
    raise exception '% product(s) do not match the backup.', v_p_left;
  end if;

  select count(*) into v_m_left
    from stock_movements sm
    join backup.supplier_20261113_stock_movements b on b.movement_id = sm.movement_id
   where sm.supplier is distinct from b.supplier;
  if v_m_left > 0 then
    raise exception '% stock_in row(s) do not match the backup.', v_m_left;
  end if;

  raise notice 'rolled back: both columns match the backup';
end $$;

commit;

-- Verify, after running: one row, 'Unknown', 576 - and one row,
-- 'Unknown', 7687.
select supplier, count(*) as products from products group by supplier order by supplier;

select supplier, count(*) as stock_in_rows
from stock_movements
where movement_type = 'stock_in'
group by supplier
order by supplier;

-- The backup tables are left in place on purpose, so a rollback can be
-- re-run or re-checked. Drop them only when you are done with 039:
--   drop table backup.supplier_20261113_products;
--   drop table backup.supplier_20261113_stock_movements;
