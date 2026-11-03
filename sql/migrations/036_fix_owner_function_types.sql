-- =====================================================================
--  036 - owner_* return types that did not match what the query returns.
--
--  ALREADY APPLIED BY HAND on 3 Nov 2026, directly against the live
--  database, because the owner dashboard and the Stock-In Tracker were
--  empty in production. This file is the record of it: running it again
--  changes nothing, which is the point of writing it down.
--
--  A plpgsql `return query` is checked at run time, per row returned. If a
--  returned column's type is not the declared column's type, the call fails
--  with
--
--    structure of query does not match function result type
--
--  and the screen gets an error instead of rows. Type here means the TYPE,
--  not the length: varchar(128) against text fails, varchar(80) against
--  varchar(120) does not. Zero rows never fails, which is why this survived
--  every test that ran against an empty window.
--
--    owner_product_performance()  units_90d was declared numeric and
--                                 arrived as bigint: vw_product_velocity
--                                 computes it as sum(si.quantity), and
--                                 sum(integer) is bigint.
--    owner_stockin_log()          recorded_by was declared text and arrived
--                                 as varchar(128), the type of
--                                 profiles.full_name.
--
--  Both are recreated below with the casts that were applied. ONLY the
--  select lists change - the guards, the signatures, the ordering and the
--  grants are identical to 033 and 035, which are left alone.
--
--  The other six `return query` functions were audited the same way and are
--  correct: dashboard_gross_net_range, owner_gross_net_range and
--  owner_stockin_by_supplier cast every column already; owner_product_catalog
--  returns products columns straight through; owner_sales_kpi_summary and
--  owner_margin_trend return numeric sums against numeric declarations, and
--  owner_margin_trend's period_start is a date on both sides. The
--  `language sql` table functions cannot carry this bug at all: Postgres
--  checks those when the function is created, not when it runs.
--
--  Idempotent. SAFE TO RUN against real data - it replaces two function
--  bodies and touches no table. Run in a NEW query tab. Mirrored into
--  sql/supabase_schema.sql.
-- =====================================================================


-- ---------------------------------------------------------------------
--  1. owner_product_performance() - units_90d::numeric
-- ---------------------------------------------------------------------

create or replace function owner_product_performance()
returns table(
  sku varchar(40),
  name varchar(160),
  category varchar(80),
  stock_on_hand integer,
  reorder_point integer,
  units_90d numeric,
  revenue_90d numeric,
  gross_profit_90d numeric
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
    select p.sku, p.name, p.category, p.stock_on_hand, p.reorder_point,
           -- ::numeric on all three. units_90d is the one that was wrong:
           -- vw_product_velocity computes it as coalesce(sum(si.quantity), 0),
           -- and sum(integer) is BIGINT, against a numeric declaration. The
           -- other two are already numeric - cast anyway, so the three figures
           -- that must agree in type say so in one place.
           coalesce(v.units_90d, 0)::numeric        as units_90d,
           coalesce(v.revenue_90d, 0)::numeric      as revenue_90d,
           coalesce(v.gross_profit_90d, 0)::numeric as gross_profit_90d
    from products p
    left join vw_product_velocity v on v.sku = p.sku
    where p.is_active
    order by p.sku;
end;
$$;

revoke execute on function owner_product_performance() from public;
revoke execute on function owner_product_performance() from anon;
grant execute on function owner_product_performance() to authenticated, service_role;


-- ---------------------------------------------------------------------
--  2. owner_stockin_log() - recorded_by::text, and the rest made explicit
--
--  The order by is the one from 035 (movement_ts desc, movement_id desc),
--  unchanged.
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
      -- Every column whose source type is not already identical to the
      -- declaration is cast to it. recorded_by is the one that was wrong:
      -- profiles.full_name is varchar(128) and the declaration says text,
      -- which are different types, not a different length - so the whole
      -- Stock-In Tracker came back empty. movement_id, movement_ts, quantity
      -- and balance_after need no cast: bigint, timestamptz, integer and
      -- integer match exactly.
      m.movement_id,
      m.movement_ts,
      m.sku::varchar(40),
      p.name::varchar(160) as product_name,
      m.quantity,
      m.balance_after,
      m.supplier::varchar(120),
      m.unit_cost::numeric(12,2),
      case when m.unit_cost is null then null
           else m.unit_cost * m.quantity end::numeric as spent,
      m.reference::varchar(120),
      pr.full_name::text as recorded_by
    from stock_movements m
    left join products p  on p.product_id = m.product_id
    left join profiles pr on pr.id = m.user_id
    where m.movement_type = 'stock_in'
      and m.movement_ts >= p_start
      and m.movement_ts <  p_end
    -- by time, not by id: the October gap fill inserted the highest ids
    -- with the earliest timestamps, so "newest id" stopped meaning
    -- "most recent". movement_id is the tie-break only.
    order by m.movement_ts desc, m.movement_id desc;
end;
$$;

revoke execute on function owner_stockin_log(timestamptz, timestamptz) from public;
revoke execute on function owner_stockin_log(timestamptz, timestamptz) from anon;
grant execute on function owner_stockin_log(timestamptz, timestamptz) to authenticated, service_role;


-- ---------------------------------------------------------------------
--  VERIFY (read-only). Uncomment and run after the above.
-- ---------------------------------------------------------------------

-- a. The casts are in both bodies. Both columns must be true.

/*
select p.proname,
       p.prosrc like '%units_90d, 0)::numeric%' as perf_cast,
       p.prosrc like '%full_name::text%'        as log_name_cast
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('owner_product_performance', 'owner_stockin_log')
order by p.proname;
*/

-- b. Every `return query` function's declared result, to read against what
--    its query hands back. A varchar against a text, or an int8 against a
--    numeric, is this bug. Lengths may differ freely.

/*
select p.proname, pg_get_function_result(p.oid) as declared
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosrc like '%return query%'
order by p.proname;
*/

-- c. End to end, as a real owner session - this is the check that would
--    have caught both of these, and it covers the staff side too:
--      cd web && node scripts/check-staff-access.mjs --expect=after
