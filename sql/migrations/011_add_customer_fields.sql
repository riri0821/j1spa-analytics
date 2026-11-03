-- =====================================================================
--  Adds optional customer-info capture (name, contact number, address)
--  to the sales entry flow.
--
--  ADDITIVE ONLY - safe to run against real data. Run in a NEW SQL
--  Editor query tab. Mirrors sql/supabase_schema.sql, which stays the
--  source of truth for a from-scratch setup - keep them in sync if you
--  change either.
-- =====================================================================

alter table sales
  add column if not exists customer_name     varchar(255),
  add column if not exists customer_contact  varchar(100),
  add column if not exists customer_address  varchar(255);

-- confirm_sale's signature is growing from 2 params to 5 - drop the old
-- overload explicitly so it doesn't linger alongside the new one.
drop function if exists confirm_sale(jsonb, text);

create or replace function confirm_sale(
  items jsonb,
  note text default null,
  customer_name text default null,
  customer_contact text default null,
  customer_address text default null
)
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

  insert into sales (user_id, user_role, total_amount, total_cost, note,
      customer_name, customer_contact, customer_address)
  values (v_uid, v_role, 0, 0, nullif(note, ''),
      nullif(customer_name, ''), nullif(customer_contact, ''), nullif(customer_address, ''))
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

revoke execute on function confirm_sale(jsonb, text, text, text, text) from public;
grant execute on function confirm_sale(jsonb, text, text, text, text) to authenticated;
