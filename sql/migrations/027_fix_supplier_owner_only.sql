-- =====================================================================
--  Change: the same hole sql/migrations/026_fix_stockin_owner_only.sql closed in
--  record_stock_movements(), in the second security-definer function that
--  writes to products. set_product_supplier() is `security definer`,
--  granted to `authenticated`, and checks only that the caller has a
--  profile - never that they are the owner. Because a security-definer
--  function bypasses RLS, the "products_write" policy (owner-only) does not
--  stop it, so any staff account could rename any product's supplier by
--  calling the RPC straight from the browser with the anon key.
--
--  It was written that way deliberately, back when Stock In was shared with
--  staff (see sql/migrations/019_fix_stockin_supplier_rls.sql: "Anyone signed in
--  with a profile may now set a product's supplier"). Stock In is owner-only
--  now, so that reasoning no longer holds.
--
--  Fix: raise unless the caller is the owner. Nothing in the app loses a
--  working path - the only caller is saveSupplier() in
--  web/src/app/stockin/StockInScreen.js, reached solely from
--  web/src/app/stockin/page.js, which redirects every non-owner to /sales.
--  No API route or server helper calls this function.
--
--  The body below is the current definition from sql/supabase_schema.sql,
--  unchanged apart from the added owner check - same signature, same
--  `security definer`, same revoke/grant, so nothing about how it is called
--  changes.
--
--  ADDITIVE ONLY - safe to run with real data. Run in a NEW query tab in
--  the Supabase SQL editor. Also mirrored into sql/supabase_schema.sql.
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
  -- Stock In, the one screen that calls this, is owner-only now; without
  -- this a staff session could rename any product's supplier straight from
  -- the browser, because a security-definer function bypasses the
  -- products_write RLS policy that would otherwise stop it.
  if v_role <> 'owner' then
    raise exception 'Only the owner can change a product''s supplier.';
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

-- Verify, after running. All read-only - none of these write a row:
--
--   -- the owner check is in the deployed body, and the security/grant
--   -- settings are untouched
--   select p.prosecdef as security_definer,
--          pg_get_userbyid(p.proowner) as owner,
--          pg_get_functiondef(p.oid) like '%Only the owner can change%' as has_owner_check
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'set_product_supplier';
--
--   -- execute is still granted to `authenticated` (the check is in the
--   -- body, not the grant)
--   select grantee, privilege_type
--   from information_schema.routine_privileges
--   where specific_schema = 'public' and routine_name = 'set_product_supplier';
--
-- Deliberately no "call it and see it fail" example here: as the owner that
-- same call succeeds and renames a real product's supplier. If you want to
-- confirm the raise, do it from a staff session against a product whose
-- supplier you already know, and check it afterwards.
