-- =====================================================================
--  Adds sales.source_type ('Direct Sales Entry' | 'Historical Migration'),
--  matching products.source_type. sales rows had no way to distinguish
--  live entries from imported/seeded historical ones (a gap from Phase 0 -
--  the old warehouse's dim_source tracked this per-fact; the collapsed
--  schema never got an equivalent on `sales`).
--
--  ADDITIVE ONLY - adds a column with a default, backfills existing rows,
--  safe to run with real data. Run in a NEW query tab.
-- =====================================================================

alter table sales
  add column if not exists source_type varchar(40) not null default 'Direct Sales Entry';
