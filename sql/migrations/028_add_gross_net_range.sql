-- =====================================================================
--  Adds dashboard_gross_net_range() - the function behind the Dashboard's
--  Gross & Net chart once it gained a calendar start-date picker. The
--  existing dashboard_gross_net_summary() answers "the last N fixed
--  windows"; this one answers "this exact range, in these buckets", which
--  is what a user-chosen start date needs.
--
--  Same revenue definition as dashboard_gross_net_summary(): confirmed
--  sales contribute gross = total_amount and net = total_amount -
--  total_cost; confirmed services contribute their full amount at zero
--  cost (services are manual entry with no cost tracked).
--
--  TIMEZONE FIX, and the reason this is not just a parameter change:
--  dashboard_gross_net_summary() buckets on `sale_ts::date`, which casts a
--  timestamptz in UTC. Manila is UTC+8, so every sale recorded between
--  00:00 and 08:00 Manila time lands on the PREVIOUS calendar day in that
--  function's output. This one buckets on
--  (sale_ts at time zone 'Asia/Manila'), the same local-time basis the
--  stock ledger and the rest of the dashboard report in, so a day's totals
--  match the day the shop actually traded. Expect this function to
--  disagree with the old one for exactly that reason - see the last verify
--  query below.
--
--  Buckets are generated with generate_series and LEFT JOINed, so a period
--  with no sales comes back as a zero row rather than being absent. The
--  chart relies on that to keep a complete x-axis.
--
--  ADDITIVE ONLY - safe to run against real data, and it does not touch
--  dashboard_gross_net_summary() or dashboard_margin_trend(), both of
--  which stay exactly as they are. Run in a NEW SQL Editor query tab.
--  Also mirrored into sql/supabase_schema.sql, which stays the source of
--  truth for a from-scratch setup. Depends on sql/migrations/013_add_services.sql
--  already having been run (needs the services table).
-- =====================================================================

create or replace function dashboard_gross_net_range(
  p_start date,
  p_end date,
  p_bucket text
)
returns table(
  period_start timestamp,
  gross numeric,
  net numeric
)
language plpgsql
stable
as $$
declare
  v_step interval;
begin
  -- Validate up front: a bad bucket would otherwise reach date_trunc() as
  -- a confusing internal error, and an unbounded range could ask Postgres
  -- for millions of buckets.
  if p_bucket is null or p_bucket not in ('hour', 'day', 'month') then
    raise exception 'Unknown bucket %. Use ''hour'', ''day'' or ''month''.', coalesce(p_bucket, '(null)');
  end if;
  if p_start is null or p_end is null then
    raise exception 'p_start and p_end are both required.';
  end if;
  if p_end < p_start then
    raise exception 'p_end (%) is before p_start (%).', p_end, p_start;
  end if;
  if (p_end - p_start) > 400 then
    raise exception 'Range too wide: % days (maximum 400).', (p_end - p_start);
  end if;

  v_step := case p_bucket
              when 'hour' then interval '1 hour'
              when 'day' then interval '1 day'
              else interval '1 month'
            end;

  return query
    with combined as (
      -- `at time zone 'Asia/Manila'` turns each timestamptz into Manila
      -- local wall-clock time (a plain timestamp), which is the basis every
      -- bucket boundary below is also expressed in.
      select
        (sale_ts at time zone 'Asia/Manila') as ts,
        total_amount                         as amount,
        total_cost                           as cost
      from sales
      where status = 'confirmed'
      union all
      select
        (service_ts at time zone 'Asia/Manila') as ts,
        total_amount                            as amount,
        0::numeric                              as cost
      from services
      where status = 'confirmed'
    ),
    buckets as (
      -- The series runs to the last bucket that starts inside the range:
      -- p_end is inclusive, so the ceiling is one microsecond before the
      -- start of the day after p_end.
      select generate_series(
        date_trunc(p_bucket, p_start::timestamp),
        date_trunc(p_bucket, (p_end + 1)::timestamp - interval '1 microsecond'),
        v_step
      ) as bucket_start
    )
    select
      buckets.bucket_start::timestamp                          as period_start,
      coalesce(sum(combined.amount), 0)::numeric               as gross,
      coalesce(sum(combined.amount - combined.cost), 0)::numeric as net
    from buckets
    left join combined
      on combined.ts >= buckets.bucket_start
     and combined.ts <  buckets.bucket_start + v_step
    group by buckets.bucket_start
    order by buckets.bucket_start asc;
end;
$$;

grant execute on function dashboard_gross_net_range(date, date, text) to authenticated, service_role;

-- =====================================================================
--  Verify, after running. Every query below is read-only - none of them
--  insert, update or delete anything.
--
--  1. 24 hourly buckets for one day, empty hours included as zeros:
--       select period_start, gross, net
--       from dashboard_gross_net_range(current_date, current_date, 'hour');
--     -- expect exactly 24 rows
--
--  2. A 7-day window, one row per day even where nothing was sold:
--       select period_start, gross, net
--       from dashboard_gross_net_range(current_date - 6, current_date, 'day');
--     -- expect exactly 7 rows
--
--  3. 12 monthly buckets:
--       select count(*) from dashboard_gross_net_range(
--         date_trunc('month', current_date - interval '11 months')::date,
--         (date_trunc('month', current_date) + interval '1 month' - interval '1 day')::date,
--         'month');
--     -- expect 12
--
--  4. The input guards all raise rather than return nonsense:
--       select * from dashboard_gross_net_range(current_date, current_date, 'week');
--         -- expect: Unknown bucket week. Use 'hour', 'day' or 'month'.
--       select * from dashboard_gross_net_range(current_date, current_date - 1, 'day');
--         -- expect: p_end (...) is before p_start (...)
--       select * from dashboard_gross_net_range(current_date - 500, current_date, 'day');
--         -- expect: Range too wide: 500 days (maximum 400).
--
--  5. New vs old for the SAME calendar month. The only expected difference
--     is the timezone fix: the old function buckets on a UTC date cast, so
--     sales recorded 00:00-08:00 Manila are counted a day earlier there.
--     Within a single month that usually cancels out internally and the
--     month totals agree; they differ when a sale falls in the first 8
--     hours of the 1st of the month (the old function pushes it into the
--     previous month) or in the first 8 hours of the 1st of NEXT month
--     (the old function pulls it into this one).
--
--       with new_total as (
--         select sum(gross) as gross, sum(net) as net
--         from dashboard_gross_net_range(
--           date_trunc('month', current_date)::date,
--           (date_trunc('month', current_date) + interval '1 month' - interval '1 day')::date,
--           'day')
--       ),
--       old_total as (
--         select sum(gross) as gross, sum(net) as net
--         from dashboard_gross_net_summary('month', 12)
--         where period_start = date_trunc('month', current_date)::date
--       )
--       select
--         new_total.gross as new_gross, old_total.gross as old_gross,
--         new_total.gross - old_total.gross as gross_diff,
--         new_total.net   as new_net,   old_total.net   as old_net,
--         new_total.net   - old_total.net   as net_diff
--       from new_total, old_total;
--
--     To see the rows responsible for any difference - the sales whose
--     Manila date and UTC date disagree:
--       select sale_id, sale_ts,
--              (sale_ts at time zone 'Asia/Manila')::date as manila_date,
--              sale_ts::date                              as utc_date,
--              total_amount
--       from sales
--       where status = 'confirmed'
--         and (sale_ts at time zone 'Asia/Manila')::date <> sale_ts::date
--       order by sale_ts desc
--       limit 20;
-- =====================================================================
