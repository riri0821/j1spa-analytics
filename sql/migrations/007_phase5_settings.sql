-- =====================================================================
--  Settings: staff account management.
--
--  Deleting a staff account can't cascade-delete their sale/stock-movement
--  history (that would falsify past reports), so it needs to be reassigned
--  first. The original Flask app reassigned to a synthetic "_former_staff"
--  user row; here user_id is just made nullable instead - simpler, and a
--  deleted staff member's old rows read as "Former staff" in the UI via
--  a fallback in the query rather than a synthetic account.
--
--  ADDITIVE ONLY - safe to run with real data. Run in a NEW query tab.
--  Also mirrored into sql/supabase_schema.sql.
-- =====================================================================

alter table sales alter column user_id drop not null;
alter table stock_movements alter column user_id drop not null;

-- Owners can reassign stock_movements.user_id when deleting a staff
-- account (sales already had this via sales_owner_write).
create policy "stock_movements_owner_write" on stock_movements for update
  using (current_user_role() = 'owner');

-- Correctness fix while touching this: `<>` against a NULL user_id (a
-- former staff member's old sale) evaluates to NULL, not TRUE, silently
-- skipping the "not your sale" check. IS DISTINCT FROM handles NULLs
-- correctly.
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
    v_sale.user_id is distinct from v_uid or v_sale.sale_ts::date <> current_date
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
