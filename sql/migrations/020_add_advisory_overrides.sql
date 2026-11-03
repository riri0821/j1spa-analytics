-- =====================================================================
--  Lets the owner force which Decision Support advisory type shows for a
--  SKU - 'low_stock' | 'demand_spike' | 'overstock' - overriding whatever
--  the rule engine itself computed for that SKU (including adding an
--  advisory for a SKU the rules would otherwise leave alone entirely).
--
--  The rule engine (lib/decisionSupport.js) still evaluates every rule
--  for every product and keeps that real TRUE/FALSE trace visible even
--  when manual_type overrides which type is shown - the override is
--  never disguised as a rule-triggered result (see isManualType /
--  "MANUAL OVERRIDE" in the alerts audit log).
--
--  ADDITIVE ONLY - safe to run with real data. Run in a NEW query tab.
--  Also mirrored into sql/supabase_schema.sql.
-- =====================================================================

create table if not exists advisory_overrides (
  product_id  bigint primary key references products (product_id) on delete cascade,
  manual_type varchar(20) not null check (manual_type in ('low_stock', 'demand_spike', 'overstock')),
  updated_by  uuid references auth.users (id),
  updated_at  timestamptz not null default now()
);

alter table advisory_overrides enable row level security;

-- Same shape as products: any signed-in user can read, only owners can write.
drop policy if exists "advisory_overrides_select" on advisory_overrides;
create policy "advisory_overrides_select" on advisory_overrides for select
  using (auth.role() = 'authenticated');
drop policy if exists "advisory_overrides_write" on advisory_overrides;
create policy "advisory_overrides_write" on advisory_overrides for all
  using (current_user_role() = 'owner')
  with check (current_user_role() = 'owner');
