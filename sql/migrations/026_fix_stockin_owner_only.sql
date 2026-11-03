-- =====================================================================
--  Change: Stock In became owner-only in the UI (the sidebar shows staff
--  only Sales Entry and Service, and stockin/page.js redirects everyone
--  else), but the database still let staff record stock. Two holes:
--
--    1. record_stock_movements() is `security definer` and granted to
--       `authenticated`, and it looked up the caller's role without ever
--       checking it. A staff session could call the RPC straight from the
--       browser with the anon key and move stock anyway.
--    2. The "stock_movements_insert" policy allowed any authenticated role
--       to insert ledger rows directly, so staff could also write history
--       without going through the RPC at all.
--
--  Fix: the RPC now raises unless the caller is the owner, and direct
--  inserts are owner-only. This is what makes the README's claim that roles
--  are enforced at the database level - not just hidden in the UI - true
--  for stock-in.
--
--  Staff sales are NOT affected. confirm_sale(), undo_sale() and
--  edit_sale() are all `security definer` and run as the function owner,
--  which is also the table owner, so their inserts into stock_movements
--  bypass RLS and never consult the policy below. No table here sets FORCE
--  ROW LEVEL SECURITY, which is what would defeat that. record_service()
--  writes no stock_movements rows at all (services are not inventory-
--  linked). The one direct insert left in the app -
--  api/products/save's opening-stock row - runs behind requireOwner(), so
--  it satisfies the new policy.
--
--  The function body below is the current definition from
--  sql/supabase_schema.sql, unchanged apart from the added owner check -
--  same signature, same `security definer`, same grant, so nothing else
--  about how it is called changes.
--
--  ADDITIVE ONLY - safe to run with real data. Run in a NEW query tab in
--  the Supabase SQL editor. Also mirrored into sql/supabase_schema.sql.
-- =====================================================================

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
  -- Stock In is an owner-only screen; without this a staff session could
  -- call this RPC straight from the browser and move stock anyway, because
  -- a security-definer function bypasses the table's RLS policies.
  if v_role <> 'owner' then
    raise exception 'Only the owner can record stock movements.';
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

-- Direct inserts become owner-only. The security-definer functions above
-- are unaffected (see the header), so a staff sale still writes its
-- sale_decrement row and a staff void still writes its void_increment.
drop policy if exists "stock_movements_insert" on stock_movements;
create policy "stock_movements_insert" on stock_movements for insert
  with check (current_user_role() = 'owner');

-- Verify, after running:
--   -- staff session: must raise 'Only the owner can record stock movements.'
--   select record_stock_movements('[{"product_id":1,"qty":1}]'::jsonb, 'test');
--
--   -- the policy is in place
--   select polname, pg_get_expr(polwithcheck, polrelid) as with_check
--   from pg_policy
--   where polrelid = 'stock_movements'::regclass and polname = 'stock_movements_insert';
--
--   -- the definer functions still bypass it: this must stay 'postgres'
--   -- (or whichever role owns stock_movements)
--   select p.proname, pg_get_userbyid(p.proowner) as owner, p.prosecdef
--   from pg_proc p
--   where p.proname in ('confirm_sale','undo_sale','edit_sale','record_stock_movements');
--
--   -- then record a sale as staff and confirm the movement row appears
--   select movement_id, movement_type, quantity, balance_after
--   from stock_movements order by movement_id desc limit 5;
