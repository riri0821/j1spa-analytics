-- =====================================================================
--  Cleanup: the `alerts` table had grown to ~149,000 rows of mostly
--  identical repeats.
--
--  Cause: evaluateDecisionSupport() inserted its whole advisory set as a
--  new batch every time the owner opened /decision-support or pressed
--  Refresh - three or four hundred rows a time, almost always saying
--  exactly what the batch before it said. Nothing displays alerts; its
--  only reader is api/products/delete/route.js, which counts a product's
--  rows to decide "deactivate instead of delete".
--
--  The app side is fixed separately (web/src/lib/alertsBatch.js - a run
--  now records a batch only when the sorted set of
--  (product_id, alert_type, severity) differs from the last one recorded).
--  This file clears out the history that was already written.
--
--  What it keeps: the FIRST batch of every run of identical batches, so
--  the history still shows each point at which the advice actually
--  changed, and every product that had a row still has one - a deleted
--  batch is by definition identical to the kept batch in front of it, so
--  it names the same products. api/products/delete therefore behaves
--  exactly as it did before. STEP 4 verifies that against the backup.
--
--  DESTRUCTIVE - deletes rows. Run in a NEW query tab, step by step, in
--  the order below. STEP 1 takes a full backup first; STEP 2 is read-only
--  and reports what STEP 3 would delete.
--
--  Not mirrored into sql/supabase_schema.sql: it changes no schema, and a
--  from-scratch setup has no duplicate history to clean up.
-- =====================================================================


-- ---------------------------------------------------------------------
--  STEP 1 - back up the whole table first. Run this on its own.
--
--  `create table as select` copies the rows but no indexes, constraints
--  or RLS policies, which is all a backup needs. It fails rather than
--  overwriting if the table already exists, so re-running this file in
--  the same day cannot clobber the first backup - that is deliberate.
--
--  The `backup` schema is not exposed to the API (Supabase serves only
--  the schemas listed in Settings -> API, normally just `public`), so
--  these rows stay out of PostgREST.
--
--  Change the date suffix if you run this on a different day.
-- ---------------------------------------------------------------------

create schema if not exists backup;

create table backup.alerts_20261103 as
select * from alerts;


-- ---------------------------------------------------------------------
--  STEP 2 - PREVIEW (read-only). Uncomment and run this BEFORE STEP 3,
--  and check the figures look like what you expect: batches_to_delete
--  should be nearly all of them, and batches_to_keep should be a small
--  number - the handful of moments the advice really did change.
--
--  A batch's fingerprint is its rows' (product_id, alert_type, severity)
--  triples, sorted. Ordered by product_id numerically here, which is not
--  the string order the app's own fingerprint uses - that is fine and
--  deliberate: these fingerprints are only ever compared with each
--  other, never with one built in JavaScript.
--
--  min(generated_ts) is the batch's own timestamp: generated_ts defaults
--  to now() per INSERT statement, so a batch written in chunks carries a
--  few values microseconds apart.
-- ---------------------------------------------------------------------

/*
with batches as (
  select
    batch_id,
    min(generated_ts) as ts,
    count(*)          as row_count,
    string_agg(
      product_id::text || '|' || alert_type::text || '|' || severity::text,
      E'\n' order by product_id, alert_type, severity
    ) as fingerprint
  from alerts
  group by batch_id
),
flagged as (
  select
    batch_id,
    row_count,
    -- lag() is null for the very first batch, so `= lag(...)` is null
    -- there, not true: the first batch is always kept.
    fingerprint = lag(fingerprint) over (order by ts, batch_id) as same_as_previous
  from batches
)
select
  count(*)                                              as total_batches,
  count(*) filter (where same_as_previous is not true)   as batches_to_keep,
  count(*) filter (where same_as_previous)               as batches_to_delete,
  coalesce(sum(row_count) filter (where same_as_previous), 0) as rows_to_delete,
  coalesce(sum(row_count), 0)                           as total_rows
from flagged;
*/

-- Optional: the same thing batch by batch, oldest first, to eyeball where
-- the advice changed. Uncomment and run on its own.

/*
with batches as (
  select
    batch_id,
    min(generated_ts) as ts,
    count(*)          as row_count,
    string_agg(
      product_id::text || '|' || alert_type::text || '|' || severity::text,
      E'\n' order by product_id, alert_type, severity
    ) as fingerprint
  from alerts
  group by batch_id
)
select
  batch_id,
  ts,
  row_count,
  case
    when fingerprint = lag(fingerprint) over (order by ts, batch_id) then 'delete'
    else 'keep'
  end as action
from batches
order by ts, batch_id
limit 100;
*/


-- ---------------------------------------------------------------------
--  STEP 3 - the delete. One set-based statement over the ~414 batches,
--  not a loop over 149,000 rows.
--
--  A batch goes only if its fingerprint equals that of the batch
--  immediately before it in generated_ts order. In a run of identical
--  batches A1, A2, A3 that deletes A2 (same as A1) and A3 (same as A2)
--  and keeps A1. The next batch that says something different is
--  compared against A3 - its original predecessor, before any of this
--  ran - so it differs, and is kept. A batch that differs from its
--  predecessor is never deleted.
--
--  There is no DELETE policy on `alerts` (see sql/supabase_schema.sql:
--  the app may only select and insert), so this works because the SQL
--  editor runs as the table's owner, which bypasses RLS. Nothing here
--  grants the app a delete it did not have.
-- ---------------------------------------------------------------------

with batches as (
  select
    batch_id,
    min(generated_ts) as ts,
    string_agg(
      product_id::text || '|' || alert_type::text || '|' || severity::text,
      E'\n' order by product_id, alert_type, severity
    ) as fingerprint
  from alerts
  group by batch_id
),
flagged as (
  select
    batch_id,
    fingerprint = lag(fingerprint) over (order by ts, batch_id) as same_as_previous
  from batches
)
delete from alerts a
using flagged f
where f.batch_id = a.batch_id
  and f.same_as_previous;


-- ---------------------------------------------------------------------
--  STEP 4 - VERIFY (read-only). Uncomment and run each of these after
--  STEP 3.
-- ---------------------------------------------------------------------

-- 4a. What is left, against what was there. rows_remaining should equal
--     the preview's total_rows minus its rows_to_delete, and
--     batches_remaining its batches_to_keep.

/*
select
  (select count(distinct batch_id) from alerts) as batches_remaining,
  (select count(*)                 from alerts) as rows_remaining,
  (select count(distinct batch_id) from backup.alerts_20261103) as batches_before,
  (select count(*)                 from backup.alerts_20261103) as rows_before;
*/

-- 4b. The one that matters for api/products/delete: every product that
--     had an alert row still has one. MUST return 0.

/*
select count(*) as products_missing_from_alerts
from (select distinct product_id from backup.alerts_20261103) b
where not exists (
  select 1 from alerts a where a.product_id = b.product_id
);
*/

-- 4c. If 4b is not 0, this lists the products that lost their last row,
--     so they can be restored from the backup. Should return nothing.

/*
select b.product_id, p.sku, p.name
from (select distinct product_id from backup.alerts_20261103) b
left join products p on p.product_id = b.product_id
where not exists (
  select 1 from alerts a where a.product_id = b.product_id
)
order by b.product_id;
*/

-- 4d. Re-run STEP 2's preview: batches_to_delete must now be 0 - no
--     batch is left that repeats the one before it. (Copy the preview
--     query above and run it again.)


-- ---------------------------------------------------------------------
--  STEP 5 - reclaim the space. Uncomment and run this ON ITS OWN in a
--  NEW query tab: VACUUM cannot run inside a transaction block, and the
--  SQL editor wraps a multi-statement script in one.
--
--  The delete only marks rows dead; this returns their space to the
--  table and refreshes the planner's statistics, which now describe a
--  table two orders of magnitude smaller.
-- ---------------------------------------------------------------------

-- vacuum (analyze) alerts;
