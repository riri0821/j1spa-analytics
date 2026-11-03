-- =====================================================================
--  Rollback for 035_hide_provenance_and_names.sql.
--
--  Puts the tags back in `note` and drops data_origin. After this the
--  Sales screen's Note column and both CSV exports show "simulated" again,
--  which is the thing 035 was for - so this is for the case where
--  something downstream turns out to depend on the old shape, not a
--  resting state.
--
--  Only STEP 1 is undone. profile_names() and the reordered
--  owner_stockin_log() are left alone: nothing depends on them being
--  absent, and dropping profile_names() would send every Cashier column
--  back to "Former staff".
--
--  Safe to run whether or not 035 was applied. Run in a NEW query tab.
-- =====================================================================


-- The note each row used to carry, back from data_origin. 'seed' was
-- 'seed-backfill'; 'simulated' was itself. Only rows whose note is still
-- empty are written, so a note typed since 035 is not overwritten.
update sales
   set note = 'seed-backfill'
 where data_origin = 'seed' and note is null;
update sales
   set note = 'simulated'
 where data_origin = 'simulated' and note is null;

update stock_movements
   set note = 'seed-backfill'
 where data_origin = 'seed' and note is null;
update stock_movements
   set note = 'simulated'
 where data_origin = 'simulated' and note is null;

-- services never had a note column, so its tag has nowhere to go back to.
-- The id ranges in web/scripts/simulated-ids.json remain the record, which
-- is what they were before 035.

alter table sales           drop constraint if exists sales_data_origin_check;
alter table services        drop constraint if exists services_data_origin_check;
alter table stock_movements drop constraint if exists stock_movements_data_origin_check;

alter table sales           drop column if exists data_origin;
alter table services        drop column if exists data_origin;
alter table stock_movements drop column if exists data_origin;


-- ---------------------------------------------------------------------
--  VERIFY (read-only). Uncomment and run after the above.
-- ---------------------------------------------------------------------

-- The notes are back and the column is gone. Expect the dry-run figures
-- from 035 step 0, and no data_origin column anywhere.

/*
select 'sales' as table_name, note, count(*)
from sales where note is not null group by note
union all
select 'stock_movements', note, count(*)
from stock_movements where note is not null group by note
order by table_name, note;
*/

/*
select table_name, column_name
from information_schema.columns
where table_schema = 'public' and column_name = 'data_origin';
*/
