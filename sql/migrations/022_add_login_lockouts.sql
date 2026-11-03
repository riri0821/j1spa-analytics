-- =====================================================================
--  Escalating brute-force login lockout, tracked server-side so it
--  survives Vercel's stateless/cold-started serverless functions (an
--  in-memory dict, like the old Flask app used, would reset on every
--  cold start and wouldn't be shared across instances).
--
--  Policy (enforced in web/src/lib/loginLockout.js, not here):
--    - 3 failed attempts locks the account out for 30 seconds.
--    - If another lockout is triggered within 5 minutes of the previous
--      lockout ENDING, the duration escalates: 5min -> 15min -> 30min
--      -> 1hr, then stays at 1hr. If more than 5 minutes pass with no
--      new lockout, the ladder resets back to 30s next time.
--
--  Keyed on the login email (identifier), not IP - this app has a
--  single owner account plus a handful of staff, not a large public
--  user base, so per-account is the meaningful unit, consistent with
--  how the old Flask app did it.
--
--  No RLS policies are defined (RLS is enabled with none), so only the
--  service-role key - used exclusively from the server-only
--  /api/auth/login-guard route - can read or write this table. Never
--  reference it from a browser/anon/authenticated client.
--
--  ADDITIVE ONLY - safe to run with real data. Run in a NEW query tab.
--  Also mirrored into sql/supabase_schema.sql.
-- =====================================================================

create table if not exists login_lockouts (
  identifier            text primary key,
  fail_count            integer not null default 0,
  locked_until          timestamptz,
  lockout_stage         integer not null default -1,
  last_lockout_ended_at timestamptz,
  updated_at            timestamptz not null default now()
);

alter table login_lockouts enable row level security;
