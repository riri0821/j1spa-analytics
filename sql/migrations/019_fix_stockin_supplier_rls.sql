-- =====================================================================
--  Fixes a bug in the Stock In screen's new supplier-editing UI: products
--  can only be written by the 'owner' role (see policy "products_write"),
--  but Stock In is also used by staff. The UI was calling
--  supabase.from("products").update(...) directly from the client, which
--  RLS silently no-ops for staff (0 rows affected, no error) - so a staff
--  member's supplier edit, or the "Supplier name" field on a stock-in
--  batch, looked like it saved but never persisted.
--
--  Fix: route both through security-definer RPCs, same pattern already
--  used for stock_on_hand writes (record_stock_movements). Anyone signed
--  in with a profile may now set a product's supplier - it's an
--  operational label like reference/note, not a priced field, so it
--  doesn't need the owner-only restriction unit_cost/unit_price have.
--
--  ADDITIVE ONLY - safe to run with real data. Run in a NEW query tab.
--  Also mirrored into sql/supabase_schema.sql.
-- =====================================================================

create or replace function set_product_supplier(p_product_id bigint, p_supplier text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;
  v_role := current_user_role();
  if v_role is null then
    raise exception 'No profile found for this account.';
  end if;

  update products set supplier = coalesce(nullif(trim(p_supplier), ''), 'Unknown')
    where product_id = p_product_id;

  if not found then
    raise exception 'Product not found.';
  end if;
end;
$$;

revoke execute on function set_product_supplier(bigint, text) from public;
grant execute on function set_product_supplier(bigint, text) to authenticated;

-- record_stock_movements gains a `supplier` param: when a batch's
-- "Supplier name" field is filled in, it now updates products.supplier
-- for every item in the batch itself (inside the same security-definer
-- call, before the per-item supplier/unit_cost snapshot is read), instead
-- of the old client-side bulk update that RLS was silently dropping for
-- staff.
drop function if exists record_stock_movements(jsonb, text);

create or replace function record_stock_movements(items jsonb, reference text default null, supplier text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
  v_ref text := nullif(trim(reference), '');
  v_sup text := nullif(trim(supplier), '');
  v_item jsonb;
  v_pid bigint;
  v_qty integer;
  v_product record;
  v_new_bal integer;
  v_mt movement_type;
  v_recorded jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;
  v_role := current_user_role();
  if v_role is null then
    raise exception 'No profile found for this account.';
  end if;

  if items is null or jsonb_array_length(items) = 0 then
    raise exception 'Nothing to record.';
  end if;

  perform 1 from products
    where product_id in (
      select (elem ->> 'product_id')::bigint from jsonb_array_elements(items) elem
    )
    order by product_id
    for update;

  if v_sup is not null then
    update products set supplier = v_sup
      where product_id in (
        select (elem ->> 'product_id')::bigint from jsonb_array_elements(items) elem
      );
  end if;

  for v_item in select * from jsonb_array_elements(items)
  loop
    v_pid := (v_item ->> 'product_id')::bigint;
    v_qty := (v_item ->> 'qty')::integer;

    if v_qty is null or v_qty = 0 then
      continue;
    end if;

    select product_id, sku, name, stock_on_hand, supplier, unit_cost into v_product
      from products where product_id = v_pid;
    if not found then
      raise exception 'Product % not found.', v_pid;
    end if;

    v_new_bal := v_product.stock_on_hand + v_qty;
    if v_new_bal < 0 then
      raise exception 'Adjustment would make % negative (% + %).',
        v_product.name, v_product.stock_on_hand, v_qty;
    end if;

    v_mt := case when v_qty > 0 then 'stock_in' else 'adjustment' end;

    update products set stock_on_hand = v_new_bal where product_id = v_pid;

    insert into stock_movements (product_id, sku, movement_type, quantity,
        balance_after, user_id, reference, supplier, unit_cost)
    values (
      v_pid, v_product.sku, v_mt, v_qty, v_new_bal, v_uid, v_ref,
      case when v_mt = 'stock_in' then v_product.supplier else null end,
      case when v_mt = 'stock_in' then v_product.unit_cost else null end
    );

    v_recorded := v_recorded || jsonb_build_object(
      'sku', v_product.sku, 'name', v_product.name,
      'change', v_qty, 'balance', v_new_bal
    );
  end loop;

  if jsonb_array_length(v_recorded) = 0 then
    raise exception 'Nothing to record.';
  end if;

  return jsonb_build_object('ok', true, 'recorded', v_recorded);
end;
$$;

revoke execute on function record_stock_movements(jsonb, text, text) from public;
grant execute on function record_stock_movements(jsonb, text, text) to authenticated;
