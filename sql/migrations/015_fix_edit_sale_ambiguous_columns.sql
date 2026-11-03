-- =====================================================================
--  Fixes a bug in edit_sale() (just applied via the combined migrations
--  run): its parameters were named note/customer_name/customer_contact/
--  customer_address/customer_vehicle_brand - the exact same names as the
--  sales table's own columns. In the function's final
--  `update sales set note = nullif(note, ''), ...` statement, every
--  right-hand-side reference to one of those names is ambiguous between
--  the table column and the plpgsql parameter, so Postgres raises
--  "column reference is ambiguous" (42702) on EVERY call - the entire
--  Edit Sale feature was broken.
--
--  Fix: rename the parameters to p_note/p_customer_name/p_customer_contact/
--  p_customer_address/p_customer_vehicle_brand (same pattern already used
--  for p_sale_id), so they no longer collide with the column names.
--  Postgres won't let CREATE OR REPLACE rename parameters of an existing
--  function (even with identical types/order) - "cannot change name of
--  input parameter" (42P13) - so the old overload has to be dropped
--  first.
--
--  web/src/app/sales/SalesScreen.js's saveEditSale() has already been
--  updated to call edit_sale with the new p_-prefixed argument names, so
--  this migration and that code change must land together.
--
--  ADDITIVE ONLY - safe to run with real data. Run in a NEW query tab.
--  Also mirrored into sql/supabase_schema.sql and
--  sql/migrations/014_add_edit_sale.sql.
-- =====================================================================

drop function if exists edit_sale(bigint, jsonb, text, text, text, text, text);

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
grant execute on function edit_sale(bigint, jsonb, text, text, text, text, text) to authenticated;
