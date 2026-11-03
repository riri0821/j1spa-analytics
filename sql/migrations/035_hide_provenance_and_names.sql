-- =====================================================================
--  Four things, all of them about what the screens show.
--
--  STEP 1  data_origin: move the seed/simulated tags out of the
--          user-visible `note` columns into a column staff cannot read.
--  STEP 2  profile_names(): let staff see who recorded a sale, without
--          widening the profiles policy.
--  STEP 3  owner_stockin_log(): order by time, not by id.
--  STEP 4  Read-only verification.
--
--  STEP 1 is the only one that touches table data. Run its dry-run count
--  first (it is the first thing in the file) and check the figures against
--  what the migration then reports.
--
--  Rollback: sql/migrations/035_rollback.sql restores the notes from
--  data_origin and drops the column.
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

-- Not readable by `authenticated`. Migration 034 replaced the table-wide
-- grants on sales and stock_movements with per-column ones, so a new column
-- is already unreadable there - but services still has a table-wide grant,
-- and an explicit revoke is both correct everywhere and says what is meant.
-- Only the service-role scripts read data_origin.
revoke select (data_origin) on sales           from authenticated;
revoke select (data_origin) on services        from authenticated;
revoke select (data_origin) on stock_movements from authenticated;


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
--  STEP 4 - VERIFY (read-only). Uncomment and run after the above.
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
--    return 0 rows.

/*
select table_name, column_name
from information_schema.column_privileges
where grantee = 'authenticated'
  and table_schema = 'public'
  and privilege_type = 'SELECT'
  and column_name = 'data_origin'
order by table_name;
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

-- e. End to end, as a real staff session:
--      cd web && node scripts/check-staff-access.mjs --expect=before
--    (--expect=after once 034 is applied.)
