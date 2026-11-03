-- =====================================================================
--  Adds supplier + unit_cost snapshots to stock_movements so the new
--  Stock-In Tracker can show "how much he spent" and "which supplier"
--  per batch accurately, even if a product's supplier/cost later changes
--  in the Products screen - same reasoning as sale_items already
--  snapshotting unit_cost/unit_price at time of sale instead of joining
--  live to products.
--
--  record_stock_movements() now copies the product's current
--  supplier/unit_cost onto the row ONLY for movement_type = 'stock_in'
--  (a positive quantity) - a negative-quantity 'adjustment'/correction
--  isn't a purchase, so those stay null, same as before this migration.
--  Rows recorded before this migration also stay null (no history to
--  backfill from).
--
--  ADDITIVE ONLY - safe to run with real data. Run in a NEW query tab.
--  Also mirrored into sql/supabase_schema.sql.
-- =====================================================================

alter table stock_movements
  add column if not exists supplier  varchar(120),
  add column if not exists unit_cost numeric(12,2);

create or replace function record_stock_movements(items jsonb, reference text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
  v_ref text := nullif(trim(reference), '');
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

revoke execute on function record_stock_movements(jsonb, text) from public;
grant execute on function record_stock_movements(jsonb, text) to authenticated;
