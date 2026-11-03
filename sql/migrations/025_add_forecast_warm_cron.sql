-- Keep the Render forecasting service awake, scheduled from Postgres itself.
--
-- Render's free tier spins forecast-service down after ~15 minutes idle, and
-- the next request then pays a cold boot - measured at 53.1s against 0.22s
-- warm. Something has to touch it on a schedule.
--
-- Why here rather than GitHub Actions: the workflow in
-- .github/workflows/keep-forecast-warm.yml is installed and works when run by
-- hand, but GitHub queues scheduled runs on a best-effort basis and never
-- fired the */5 schedule even once in the first 50 minutes. pg_cron runs on
-- infrastructure this project already owns and already pays nothing for, with
-- no third-party account in the loop.
--
-- /health is unauthenticated by design (forecast-service/main.py), so this
-- sends no key and no data - it only needs the instance to answer.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent: drop the job first so re-running this script edits the schedule
-- instead of erroring. cron.unschedule() raises if the name is absent, hence
-- the guard rather than a bare call.
select cron.unschedule('keep-forecast-warm')
where exists (select 1 from cron.job where jobname = 'keep-forecast-warm');

-- Every 5 minutes, not every 15: the idle window is 15 minutes, so pinging at
-- the boundary leaves no margin for a late or dropped request.
select cron.schedule(
  'keep-forecast-warm',
  '*/5 * * * *',
  $job$ select net.http_get('https://j1spa-dss.onrender.com/health') $job$
);

-- Verify: the job should be listed and active.
--   select jobid, jobname, schedule, active from cron.job
--   where jobname = 'keep-forecast-warm';
--
-- Recent outcomes (status should be 'succeeded'):
--   select status, return_message, start_time
--   from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'keep-forecast-warm')
--   order by start_time desc limit 10;
--
-- To stop it (after the defense, to stop spending Render instance-hours):
--   select cron.unschedule('keep-forecast-warm');
