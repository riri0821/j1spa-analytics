-- =====================================================================
--  Phase 2: sale confirm/undo functions.
--
--  ADDITIVE ONLY - unlike sql/supabase_schema.sql, this does not drop
--  any table, so it's safe to run even if you already have real
--  products/sales data. Run this in a NEW SQL Editor query tab (not one
--  that still has the full schema script in it).
--
--  These two functions do the same job as sql/supabase_schema.sql's
--  copies (that file stays the source of truth for a from-scratch
--  setup) - keep them in sync if you change one.
-- =====================================================================

create or replace function confirm_sale(items jsonb, note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
  v_sale_id bigint;
  v_total_rev numeric(14,2) := 0;
  v_total_cost numeric(14,2) := 0;
  v_item jsonb;
  v_pid bigint;
  v_qty integer;
  v_product record;
  v_new_bal integer;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;

  v_role := current_user_role();
  if v_role is null then
    raise exception 'No profile found for this account.';
  end if;

  if items is null or jsonb_array_length(items) = 0 then
    raise exception 'No items to record.';
  end if;

  perform 1 from products
    where product_id in (
      select (elem ->> 'product_id')::bigint from jsonb_array_elements(items) elem
    )
    order by product_id
    for update;

  insert into sales (user_id, user_role, total_amount, total_cost, note)
  values (v_uid, v_role, 0, 0, nullif(note, ''))
  returning sale_id into v_sale_id;

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
    values (v_sale_id, v_pid, v_product.sku, v_qty, v_product.unit_price,
        v_product.unit_cost, round(v_qty * v_product.unit_price, 2),
        round(v_qty * v_product.unit_cost, 2));

    update products set stock_on_hand = v_new_bal where product_id = v_pid;

    insert into stock_movements (product_id, sku, movement_type, quantity,
        balance_after, user_id, reference)
    values (v_pid, v_product.sku, 'sale_decrement', -v_qty, v_new_bal, v_uid,
        'sale:' || v_sale_id);

    v_total_rev := v_total_rev + round(v_qty * v_product.unit_price, 2);
    v_total_cost := v_total_cost + round(v_qty * v_product.unit_cost, 2);
  end loop;

  update sales set total_amount = v_total_rev, total_cost = v_total_cost
    where sale_id = v_sale_id;

  return jsonb_build_object('sale_id', v_sale_id, 'total_amount', v_total_rev);
end;
$$;

revoke execute on function confirm_sale(jsonb, text) from public;
grant execute on function confirm_sale(jsonb, text) to authenticated;

create or replace function undo_sale(p_sale_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
  v_sale record;
  v_item record;
  v_new_bal integer;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;
  v_role := current_user_role();

  select * into v_sale from sales where sale_id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found.';
  end if;
  if v_sale.status = 'voided' then
    raise exception 'Already undone.';
  end if;

  if v_role <> 'owner' and (
    v_sale.user_id <> v_uid or v_sale.sale_ts::date <> current_date
  ) then
    raise exception 'Not allowed to undo this sale.';
  end if;

  for v_item in select product_id, sku, quantity from sale_items where sale_id = p_sale_id
  loop
    update products set stock_on_hand = stock_on_hand + v_item.quantity
      where product_id = v_item.product_id
      returning stock_on_hand into v_new_bal;

    insert into stock_movements (product_id, sku, movement_type, quantity,
        balance_after, user_id, reference)
    values (v_item.product_id, v_item.sku, 'void_increment', v_item.quantity,
        v_new_bal, v_uid, 'undo:' || p_sale_id);
  end loop;

  update sales set status = 'voided', voided_ts = now() where sale_id = p_sale_id;

  return jsonb_build_object('ok', true, 'sale_id', p_sale_id);
end;
$$;

revoke execute on function undo_sale(bigint) from public;
grant execute on function undo_sale(bigint) to authenticated;
