-- =====================================================================
--  Decision Support: allow owners to write to the alerts table.
--
--  Phase 1 only added a SELECT policy on alerts (it was written by the
--  ETL back then). Now the owner-triggered rules engine writes batches
--  of advisories directly, so it needs an INSERT policy.
--
--  ADDITIVE ONLY - safe to run with real data. Run in a NEW query tab.
--  Also mirrored into sql/supabase_schema.sql.
-- =====================================================================

create policy "alerts_insert" on alerts for insert
  with check (current_user_role() = 'owner');
