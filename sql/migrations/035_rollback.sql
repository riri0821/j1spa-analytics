-- =====================================================================
--  Rollback for 035_hide_provenance_and_names.sql.
--
--  Puts the tags back in `note` and drops data_origin. After this the
--  Sales screen's Note column and both CSV exports show "simulated" again,
--  which is the thing 035 was for - so this is for the case where
--  something downstream turns out to depend on the old shape, not a
--  resting state.
--
--  STEP 1 and STEP 4 are undone. profile_names() and the reordered
--  owner_stockin_log() are left alone: nothing depends on them being
--  absent, and dropping profile_names() would send every Cashier column
--  back to "Former staff".
--
--  Undoing step 4 gives staff back the ability to edit their own sales,
--  which is the thing it took away - so run it only if that capability is
--  wanted back, not as cleanup. The deployed code hides the Edit link from
--  staff either way, so the capability returns to the database without
--  returning to the screen until that code is reverted too.
--
--  Safe to run whether or not 035 was applied. Run in a NEW query tab.
-- =====================================================================


-- The note each row used to carry, back from data_origin. 'seed' was
-- 'seed-backfill'; 'simulated' was itself. Only rows whose note is still
-- empty are written, so a note typed since 035 is not overwritten.
update sales
   set note = 'seed-backfill'
 where data_origin = 'seed' and note is null;
update sales
   set note = 'simulated'
 where data_origin = 'simulated' and note is null;

update stock_movements
   set note = 'seed-backfill'
 where data_origin = 'seed' and note is null;
update stock_movements
   set note = 'simulated'
 where data_origin = 'simulated' and note is null;

-- services never had a note column, so its tag has nowhere to go back to.
-- The id ranges in web/scripts/simulated-ids.json remain the record, which
-- is what they were before 035.

alter table sales           drop constraint if exists sales_data_origin_check;
alter table services        drop constraint if exists services_data_origin_check;
alter table stock_movements drop constraint if exists stock_movements_data_origin_check;

alter table sales           drop column if exists data_origin;
alter table services        drop column if exists data_origin;
alter table stock_movements drop column if exists data_origin;

-- 035 converted each table's grant for `authenticated` from table-wide to
-- per-column so it could leave data_origin out. Those column lists are not
-- undone: with the column gone they cover every column the table has, so
-- `authenticated` reads exactly what it read before 035. The one visible
-- difference is that a future column would start out unreadable rather than
-- readable, which is the safer default and the reason 034 works that way.
-- To go all the way back on services:
--   grant select on services to authenticated;


-- ---------------------------------------------------------------------
--  edit_sale(), back to owner-any-sale / staff-their-own.
--
--  Byte-identical to the definition 035 replaced, guard included:
--
--    if v_role <> 'owner' and v_sale.user_id is distinct from v_uid then
--
--  which is the NULL-unsafe form - for a caller with no profile row that
--  condition is NULL and the IF is skipped. The null-role guard from 033 is
--  what refuses them, and it is still in here; that is exactly the state
--  this file restores, not an improvement on it.
-- ---------------------------------------------------------------------

create or replace function edit_sale(
  p_sale_id bigint,
  items jsonb,
  p_note text default null,
  p_customer_name text default null,
  p_customer_contact text default null,
  p_customer_address text default null,
  p_customer_vehicle_brand text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
  v_sale record;
  v_old record;
  v_item jsonb;
  v_pid bigint;
  v_qty integer;
  v_product record;
  v_new_bal integer;
  v_total_rev numeric(14,2) := 0;
  v_total_cost numeric(14,2) := 0;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;
  v_role := current_user_role();
  if v_role is null then
    raise exception 'No profile found for this account.';
  end if;

  select * into v_sale from sales where sale_id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found.';
  end if;
  if v_sale.status = 'voided' then
    raise exception 'Cannot edit a voided sale.';
  end if;

  if v_role <> 'owner' and v_sale.user_id is distinct from v_uid then
    raise exception 'Not allowed to edit this sale.';
  end if;

  if items is null or jsonb_array_length(items) = 0 then
    raise exception 'A sale needs at least one line item.';
  end if;

  perform 1 from products
    where product_id in (
      select product_id from sale_items where sale_id = p_sale_id
      union
      select (elem ->> 'product_id')::bigint from jsonb_array_elements(items) elem
    )
    order by product_id
    for update;

  for v_old in select product_id, sku, quantity from sale_items where sale_id = p_sale_id
  loop
    update products set stock_on_hand = stock_on_hand + v_old.quantity
      where product_id = v_old.product_id
      returning stock_on_hand into v_new_bal;

    insert into stock_movements (product_id, sku, movement_type, quantity,
        balance_after, user_id, reference)
    values (v_old.product_id, v_old.sku, 'void_increment', v_old.quantity,
        v_new_bal, v_uid, 'edit:' || p_sale_id);
  end loop;

  delete from sale_items where sale_id = p_sale_id;

  for v_item in select * from jsonb_array_elements(items)
  loop
    v_pid := (v_item ->> 'product_id')::bigint;
    v_qty := (v_item ->> 'qty')::integer;

    if v_qty is null or v_qty <= 0 then
      raise exception 'Bad line item.';
    end if;

    select product_id, sku, unit_price, unit_cost, stock_on_hand
      into v_product
      from products where product_id = v_pid;

    if not found then
      raise exception 'Product % not found.', v_pid;
    end if;
    if v_qty > v_product.stock_on_hand then
      raise exception 'Not enough stock for % (on hand %, requested %).',
        v_product.sku, v_product.stock_on_hand, v_qty;
    end if;

    v_new_bal := v_product.stock_on_hand - v_qty;

    insert into sale_items (sale_id, product_id, sku, quantity, unit_price,
        unit_cost, line_revenue, line_cost)
    values (p_sale_id, v_pid, v_product.sku, v_qty, v_product.unit_price,
        v_product.unit_cost, round(v_qty * v_product.unit_price, 2),
        round(v_qty * v_product.unit_cost, 2));

    update products set stock_on_hand = v_new_bal where product_id = v_pid;

    insert into stock_movements (product_id, sku, movement_type, quantity,
        balance_after, user_id, reference)
    values (v_pid, v_product.sku, 'sale_decrement', -v_qty, v_new_bal, v_uid,
        'edit:' || p_sale_id);

    v_total_rev := v_total_rev + round(v_qty * v_product.unit_price, 2);
    v_total_cost := v_total_cost + round(v_qty * v_product.unit_cost, 2);
  end loop;

  update sales set
      total_amount = v_total_rev,
      total_cost = v_total_cost,
      note = nullif(p_note, ''),
      customer_name = nullif(p_customer_name, ''),
      customer_contact = nullif(p_customer_contact, ''),
      customer_address = nullif(p_customer_address, ''),
      customer_vehicle_brand = nullif(p_customer_vehicle_brand, '')
    where sale_id = p_sale_id;

  return jsonb_build_object('ok', true, 'sale_id', p_sale_id, 'total_amount', v_total_rev);
end;
$$;

revoke execute on function edit_sale(bigint, jsonb, text, text, text, text, text) from public;
revoke execute on function edit_sale(bigint, jsonb, text, text, text, text, text) from anon;
grant execute on function edit_sale(bigint, jsonb, text, text, text, text, text) to authenticated, service_role;


-- ---------------------------------------------------------------------
--  VERIFY (read-only). Uncomment and run after the above.
-- ---------------------------------------------------------------------

-- The notes are back and the column is gone. Expect the dry-run figures
-- from 035 step 0, and no data_origin column anywhere.

/*
select 'sales' as table_name, note, count(*)
from sales where note is not null group by note
union all
select 'stock_movements', note, count(*)
from stock_movements where note is not null group by note
order by table_name, note;
*/

/*
select table_name, column_name
from information_schema.columns
where table_schema = 'public' and column_name = 'data_origin';
*/

-- And edit_sale is back to the old guard: staff may edit their own sales.

/*
select p.proname,
       p.prosrc like '%Not allowed to edit this sale.%'   as old_guard_back,
       p.prosrc not like '%Only the owner can edit%'      as owner_only_gone
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'edit_sale';
*/
