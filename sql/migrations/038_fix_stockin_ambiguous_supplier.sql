-- =====================================================================
--  Change: confirming a batch on /stockin fails outright with
--
--      column reference "supplier" is ambiguous
--
--  record_stock_movements(items jsonb, reference text, supplier text) has a
--  PARAMETER called `supplier`, and inside the per-item loop it reads
--  products.supplier in an unqualified select:
--
--      select product_id, sku, name, stock_on_hand, supplier, unit_cost
--        into v_product
--        from products where product_id = v_pid;
--
--  In plpgsql a bare name that could be either a parameter or a column of a
--  table in scope is an error (SQLSTATE 42702), not a silent preference. So
--  the function raises on the first item of every batch and no stock is ever
--  recorded. The owner-only check above it is reached first, so staff still
--  get the role error rather than this one.
--
--  Introduced by migration 019, which added the `supplier` parameter to a
--  body that already had this select - not by 026, which only added the
--  owner check. Stock In has therefore been broken since 019; 026 and the
--  copy in sql/supabase_schema.sql both carried the same select forward.
--
--  Fix: alias the table and qualify every column in that one select. That
--  is the whole change. The parameter names stay (web/src/app/stockin calls
--  this with named arguments - items/reference/supplier - so renaming them
--  would break the client), as do `security definer`, `set search_path`,
--  the owner-only check, the row locking, the supplier update, the movement
--  inserts and the return shape.
--
--  Nothing else in this body needs it:
--    - `update products set supplier = v_sup` is safe. The left-hand side of
--      an UPDATE ... SET is always resolved as a column of the target table,
--      never as a variable, and Postgres does not allow aliasing the target
--      there anyway.
--    - `insert into stock_movements (..., reference, supplier, ...)` is safe:
--      names in an INSERT column list are always columns, and the VALUES
--      expressions use v_ref / v_product.supplier, not the parameters.
--    - `where product_id in (...)`, `order by product_id` and
--      `jsonb_array_elements(items)` share no name with a parameter.
--
--  The other plpgsql functions were checked for the same class of bug - a
--  parameter sharing a name with a column the function reads. Only three
--  take unprefixed parameters at all; every other function uses the p_
--  prefix, which cannot collide:
--
--    confirm_sale(items, note, customer_name, customer_contact,
--                 customer_address, customer_vehicle_brand)
--      `note` and the customer_* names are columns of `sales`, but they are
--      only ever used in an INSERT column list and its VALUES expressions,
--      where the target table's columns are not in scope. Its one select
--      from products reads product_id/sku/unit_price/unit_cost/
--      stock_on_hand, none of which is a parameter. Safe.
--
--    record_service(service_type, total_amount, customer_name, ...)
--      same shape: `service_type` and `total_amount` are columns of
--      `services`, used only in an INSERT and in scalar tests
--      (`total_amount is null`) with no table in scope. Safe.
--
--    edit_sale(p_sale_id, items, p_note, ...)
--      `items` is the only unprefixed one and no table has an `items`
--      column. Safe.
--
--  FUNCTION BODY ONLY - no table, column, policy or grant changes, and no
--  data is touched. `create or replace function` keeps the existing
--  privileges; the revoke/grant block below is repeated verbatim from
--  sql/supabase_schema.sql so the end state is explicit, and is a no-op on
--  a database where 026 has already run. Run in a NEW query tab in the
--  Supabase SQL editor. Also mirrored into sql/supabase_schema.sql.
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

    -- Aliased and fully qualified: `supplier` on its own is ambiguous here
    -- because this function has a parameter of that name. This is the fix -
    -- see the header. v_product.supplier below is unaffected, the record's
    -- field is still named supplier.
    select p.product_id, p.sku, p.name, p.stock_on_hand, p.supplier, p.unit_cost
      into v_product
      from products p
      where p.product_id = v_pid;
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
revoke execute on function record_stock_movements(jsonb, text, text) from anon;
grant execute on function record_stock_movements(jsonb, text, text) to authenticated, service_role;

-- Verify, after running:
--
--   -- 1. The select inside the loop is now qualified. Must print
--   --    "from products p" and no bare ", supplier,".
--   select pg_get_functiondef(p.oid)
--   from pg_proc p
--   where p.proname = 'record_stock_movements';
--
--   -- 2. Signature, definer flag and search_path are unchanged:
--   --    record_stock_movements(items jsonb, reference text, supplier text),
--   --    prosecdef = true, proconfig = {search_path=public}
--   select p.proname, pg_get_function_arguments(p.oid) as args,
--          p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner
--   from pg_proc p
--   where p.proname = 'record_stock_movements';
--
--   -- 3. The grants: authenticated and service_role, not anon or PUBLIC.
--   select grantee, privilege_type
--   from information_schema.routine_privileges
--   where routine_name = 'record_stock_movements';
--
--   -- 4. As the OWNER, record one unit against a real product and then undo
--   --    it. The first call must return {"ok": true, ...} rather than the
--   --    ambiguity error. Replace 1 with a real product_id.
--   -- select record_stock_movements(
--   --   '[{"product_id":1,"qty":1}]'::jsonb, 'ambiguity fix check', null);
--   -- ...then put the unit back:
--   -- select record_stock_movements(
--   --   '[{"product_id":1,"qty":-1}]'::jsonb, 'ambiguity fix check undo', null);
--
--   -- 5. The owner-only check still bites. From a STAFF session this must
--   --    raise 'Only the owner can record stock movements.'
--   -- select record_stock_movements('[{"product_id":1,"qty":1}]'::jsonb, 'test');
