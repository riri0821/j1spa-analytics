-- =====================================================================
--  Five things, four of them about what the screens show.
--
--  STEP 1  data_origin: move the seed/simulated tags out of the
--          user-visible `note` columns into a column staff cannot read.
--  STEP 2  profile_names(): let staff see who recorded a sale, without
--          widening the profiles policy.
--  STEP 3  owner_stockin_log(): order by time, not by id.
--  STEP 4  edit_sale(): owner-only. This one is not display - it takes a
--          capability away from staff, and the code that hides the Edit
--          link ships with it.
--  STEP 5  Read-only verification.
--
--  STEP 1 is the only one that touches table data. Run its dry-run count
--  first (it is the first thing in the file) and check the figures against
--  what the migration then reports.
--
--  Rollback: sql/migrations/035_rollback.sql restores the notes from
--  data_origin, drops the column, and puts edit_sale's old guard back.
--
--  SAFE TO RUN against real data. Run in a NEW query tab. Mirrored into
--  sql/supabase_schema.sql.
-- =====================================================================


-- ---------------------------------------------------------------------
--  STEP 0 - DRY RUN. Uncomment and run this FIRST. These are the rows
--  step 1 will tag and then clear. Expected, as of 3 Nov 2026:
--
--    sales            simulated      3,478
--    stock_movements  seed-backfill  271,421
--    stock_movements  simulated        7,941
--    services         simulated          138   (by id range, no note column)
--
--  `other` must be 0 on both tables. A non-zero there is a note somebody
--  typed, which step 1 must not touch - stop and look before continuing.
-- ---------------------------------------------------------------------

/*
select 'sales' as table_name, note, count(*)
from sales where note in ('seed-backfill', 'simulated') group by note
union all
select 'sales', 'other (will NOT be cleared)', count(*)
from sales where note is not null and note not in ('seed-backfill', 'simulated')
union all
select 'stock_movements', note, count(*)
from stock_movements where note in ('seed-backfill', 'simulated') group by note
union all
select 'stock_movements', 'other (will NOT be cleared)', count(*)
from stock_movements where note is not null and note not in ('seed-backfill', 'simulated')
union all
select 'services', 'in the simulated id ranges', count(*)
from services where service_id between 3 and 140
union all
select 'services', 'outside them (left as real)', count(*)
from services where service_id < 3 or service_id > 140
order by table_name, note;
*/


-- ---------------------------------------------------------------------
--  STEP 1 - data_origin
--
--  The app has always treated every sale the same, but the tags that say
--  where a row came from were sitting in `note`, which IS user-visible: the
--  Sales screen's Note column, the note field in the edit-sale panel, and
--  both CSV exports. A staff member reading "simulated" on a sale has been
--  told something about the data that the screen was not meant to say.
--
--  So the tag moves to its own column, and `note` goes back to being what
--  it says it is: a note somebody typed. Nothing is lost - every row that
--  carried a tag still carries it, just somewhere staff cannot read.
--
--  Services never had a note column, so their tag comes from the id ranges
--  recorded in web/scripts/simulated-ids.json: 3..133 from the first
--  top-up run and 134..140 from the October gap fill.
-- ---------------------------------------------------------------------

alter table sales           add column if not exists data_origin text;
alter table services        add column if not exists data_origin text;
alter table stock_movements add column if not exists data_origin text;

-- NULL means a real entry. The check allows it, which is what makes the
-- column additive: every existing row passes before anything is copied.
alter table sales           drop constraint if exists sales_data_origin_check;
alter table sales           add constraint sales_data_origin_check
  check (data_origin is null or data_origin in ('seed', 'simulated'));
alter table services        drop constraint if exists services_data_origin_check;
alter table services        add constraint services_data_origin_check
  check (data_origin is null or data_origin in ('seed', 'simulated'));
alter table stock_movements drop constraint if exists stock_movements_data_origin_check;
alter table stock_movements add constraint stock_movements_data_origin_check
  check (data_origin is null or data_origin in ('seed', 'simulated'));

-- Copy the tags across. Idempotent: re-running matches the same rows and
-- writes the same values.
update sales           set data_origin = 'seed'      where note = 'seed-backfill';
update sales           set data_origin = 'simulated'  where note = 'simulated';
update stock_movements set data_origin = 'seed'       where note = 'seed-backfill';
update stock_movements set data_origin = 'simulated'  where note = 'simulated';

-- Services, by the recorded id ranges.
update services set data_origin = 'simulated' where service_id between 3 and 140;

-- Only NOW clear the notes, and only where the note IS one of the two tag
-- values. A note somebody typed is never touched. The `data_origin is not
-- null` half means a row cannot lose its note without having gained the
-- tag first, even if this file is interrupted between statements.
update sales
   set note = null
 where note in ('seed-backfill', 'simulated')
   and data_origin is not null;
update stock_movements
   set note = null
 where note in ('seed-backfill', 'simulated')
   and data_origin is not null;

-- Not readable by `authenticated`: only the service-role scripts read
-- data_origin.
--
-- `revoke select (data_origin)` on its own would NOT do this. A column
-- revoke only removes a column-level grant; a role holding table-wide
-- SELECT still reads every column, the new one included. services has
-- exactly that table-wide grant, and so do sales and stock_movements until
-- 034 replaces theirs with per-column lists.
--
-- So the grant is converted instead: read back the columns `authenticated`
-- can select on each table RIGHT NOW, drop data_origin from that list, and
-- re-grant it per column. Nothing else about the table's readable surface
-- changes, which is what makes this safe to run either side of 034 - run
-- before it, the cost columns stay readable and 034 still narrows them
-- later; run after it, the narrow list is what gets read back, so the cost
-- columns are not quietly re-granted.
do $$
declare
  t    text;
  cols text;
begin
  foreach t in array array['sales', 'services', 'stock_movements'] loop
    select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position)
      into cols
      from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name   = t
       and c.column_name <> 'data_origin'
       and has_column_privilege('authenticated', format('public.%I', t)::regclass,
                                c.column_name, 'SELECT');

    execute format('revoke select on public.%I from authenticated', t);
    if cols is not null then
      execute format('grant select (%s) on public.%I to authenticated', cols, t);
    end if;
    raise notice '%: granted select on %', t, coalesce(cols, '(nothing)');
  end loop;
end $$;


-- ---------------------------------------------------------------------
--  STEP 2 - profile_names()
--
--  profiles_select lets a user read their own row, or every row if they are
--  the owner. That is the right shape for a table holding usernames, roles
--  and is_active - and it means every sale recorded by somebody else shows
--  "Former staff" to a staff user, because the embedded profiles(full_name)
--  comes back empty.
--
--  Widening the policy would hand staff the usernames (which are email
--  addresses), everyone's role and everyone's active flag, to fix a display
--  name. So: a definer function that returns ONLY the id and the display
--  name, for signed-in callers. The profiles policy is untouched.
--
--  No role check inside, deliberately: staff are meant to see these names.
--  anon is revoked below, so a caller has to be signed in; and there is
--  nothing here a signed-in user could not already learn from the sales
--  they can read, except the name of a colleague who has recorded none.
-- ---------------------------------------------------------------------

create or replace function profile_names()
returns table(id uuid, full_name text)
language sql
security definer
set search_path = public
stable
as $$
  select p.id, p.full_name::text from profiles p;
$$;

revoke execute on function profile_names() from public;
revoke execute on function profile_names() from anon;
grant execute on function profile_names() to authenticated, service_role;


-- ---------------------------------------------------------------------
--  STEP 3 - owner_stockin_log(), ordered by time
--
--  It ordered by movement_id desc, which stopped meaning "most recent
--  first" the moment the October gap fill inserted rows with the highest
--  ids and the earliest timestamps. Ordered by movement_ts now, with
--  movement_id as the tie-break so rows written in the same second keep a
--  stable order.
--
--  ONLY the order by changes; everything else is identical to migration
--  033's definition.
-- ---------------------------------------------------------------------

create or replace function owner_stockin_log(
  p_start timestamptz,
  p_end timestamptz
)
returns table(
  movement_id bigint,
  movement_ts timestamptz,
  sku varchar(40),
  product_name varchar(160),
  quantity integer,
  balance_after integer,
  supplier varchar(120),
  unit_cost numeric(12,2),
  spent numeric,
  reference varchar(120),
  recorded_by text
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if current_user_role() is distinct from 'owner' then
    raise exception 'Owner access only.';
  end if;

  return query
    select
      m.movement_id,
      m.movement_ts,
      m.sku,
      p.name as product_name,
      m.quantity,
      m.balance_after,
      m.supplier,
      m.unit_cost,
      case when m.unit_cost is null then null else m.unit_cost * m.quantity end as spent,
      m.reference,
      pr.full_name as recorded_by
    from stock_movements m
    left join products p  on p.product_id = m.product_id
    left join profiles pr on pr.id = m.user_id
    where m.movement_type = 'stock_in'
      and m.movement_ts >= p_start
      and m.movement_ts <  p_end
    order by m.movement_ts desc, m.movement_id desc;
end;
$$;

revoke execute on function owner_stockin_log(timestamptz, timestamptz) from public;
revoke execute on function owner_stockin_log(timestamptz, timestamptz) from anon;
grant execute on function owner_stockin_log(timestamptz, timestamptz) to authenticated, service_role;


-- ---------------------------------------------------------------------
--  STEP 4 - edit_sale(), owner-only
--
--  It allowed the owner any sale, and staff their own, on any date:
--
--    if v_role <> 'owner' and v_sale.user_id is distinct from v_uid then
--      raise exception 'Not allowed to edit this sale.';
--
--  Editing is not a correction to one row. It hands back the stock every
--  old line took, deletes and re-inserts the lines, re-decrements stock for
--  the new ones, and writes a void_increment and a sale_decrement per
--  product - so a staff edit was a staff-initiated rewrite of the ledger
--  and of products.stock_on_hand. That is owner work.
--
--  Staff keep undo: undo_sale and undo_service are UNCHANGED, still their
--  own records from the current Manila day.
--
--  `is distinct from 'owner'`, not `<> 'owner'`: `NULL <> 'owner'` is NULL
--  and a plpgsql IF treats NULL as false, so `<>` would skip the guard for
--  a caller with no profile row. The null-role guard from 033 is kept as
--  well - either one alone refuses that caller, and neither is here on the
--  assumption that the other is.
--
--  The guard also moved above the sale lookup: refusing staff should not
--  depend on the sale existing, and it means a staff caller is told the
--  same thing whatever id they pass.
--
--  ONLY the guard changes. Everything else is byte-identical to what
--  supabase_schema.sql held - verified by stripping the guard from both and
--  comparing, not by reading.
--
--  Ships WITH the code that hides the Edit link and the edit panel from
--  staff. Run either side of that deploy and nothing breaks: run first and
--  a staff member clicking Edit is refused by the database, which is the
--  state this fixes rather than a new one.
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

  -- Editing a confirmed sale is owner-only. It is not a correction to one
  -- row: it hands back the stock every old line took, deletes and re-inserts
  -- the lines, re-decrements stock for the new ones and writes a
  -- void_increment and a sale_decrement for each - so a staff edit of their
  -- own sale was a staff-initiated rewrite of the ledger, and of
  -- products.stock_on_hand with it. Staff undo instead, which is still
  -- theirs to do on their own records from the current Manila day
  -- (undo_sale, undo_service - unchanged).
  --
  -- `is distinct from` rather than `<>`: `NULL <> 'owner'` is NULL and a
  -- plpgsql IF treats NULL as false, so `<>` would skip this guard entirely
  -- for a caller with no profile row. The null-role guard above already
  -- refuses that caller; this says the same thing again rather than relying
  -- on one of them being there.
  if v_role is distinct from 'owner' then
    raise exception 'Only the owner can edit a sale.';
  end if;

  select * into v_sale from sales where sale_id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found.';
  end if;
  if v_sale.status = 'voided' then
    raise exception 'Cannot edit a voided sale.';
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
--  STEP 5 - VERIFY (read-only). Uncomment and run after the above.
-- ---------------------------------------------------------------------

-- a. The tags moved, and no note is left holding one. notes_left must be 0
--    on both rows, and the data_origin counts must match the dry run.

/*
select 'sales' as table_name,
       count(*) filter (where data_origin = 'seed')      as seed,
       count(*) filter (where data_origin = 'simulated') as simulated,
       count(*) filter (where data_origin is null)       as untagged,
       count(*) filter (where note in ('seed-backfill', 'simulated')) as notes_left
from sales
union all
select 'stock_movements',
       count(*) filter (where data_origin = 'seed'),
       count(*) filter (where data_origin = 'simulated'),
       count(*) filter (where data_origin is null),
       count(*) filter (where note in ('seed-backfill', 'simulated'))
from stock_movements
union all
select 'services',
       count(*) filter (where data_origin = 'seed'),
       count(*) filter (where data_origin = 'simulated'),
       count(*) filter (where data_origin is null),
       0
from services;
*/

-- b. `authenticated` cannot select data_origin on any of the three. MUST
--    return three rows, all with can_select = false. has_column_privilege
--    is the question that matters - it answers for table-wide and
--    column-level grants together, which a look at column_privileges alone
--    does not.

/*
select t as table_name,
       has_column_privilege('authenticated', ('public.' || t)::regclass,
                            'data_origin', 'SELECT') as can_select
from unnest(array['sales', 'services', 'stock_movements']) as t
order by t;
*/

-- b2. ...and everything else on those tables still IS readable. One row per
--     table, listing what `authenticated` can select. Compare against what
--     the screens ask for; data_origin must not appear.

/*
select c.table_name, string_agg(c.column_name, ', ' order by c.ordinal_position) as readable
from information_schema.columns c
where c.table_schema = 'public'
  and c.table_name in ('sales', 'services', 'stock_movements')
  and has_column_privilege('authenticated', ('public.' || c.table_name)::regclass,
                           c.column_name, 'SELECT')
group by c.table_name
order by c.table_name;
*/

-- c. profile_names() returns exactly two columns, and neither is a
--    username, a role or an active flag.

/*
select p.proname, pg_get_function_result(p.oid) as returns
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'profile_names';
*/

-- d. The stock-in log is ordered by time now.

/*
select p.proname,
       p.prosrc like '%order by m.movement_ts desc, m.movement_id desc%' as orders_by_time
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'owner_stockin_log';
*/

-- e. edit_sale refuses anyone who is not the owner, and says so with the
--    NULL-safe test. Both must be true.

/*
select p.proname,
       p.prosrc like '%is distinct from ''owner''%'          as null_safe_guard,
       p.prosrc like '%Only the owner can edit a sale.%'     as owner_only_message,
       p.prosrc not like '%Not allowed to edit this sale.%'  as old_guard_gone
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'edit_sale';
*/

-- f. End to end, as a real staff session:
--      cd web && node scripts/check-staff-access.mjs --expect=before
--    (--expect=after once 034 is applied.)
--
--    Its "Editing a sale" group covers step 4: a staff caller and a caller
--    with no profile row must both be refused by edit_sale.
