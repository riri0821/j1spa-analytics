-- =====================================================================
--  J1SPA  Postgres/Supabase schema (PERN migration)
--
--  Single-schema design: replaces the old MySQL ops+warehouse split.
--  There is no scheduler/ETL anymore, so:
--    - the `synced_dw` watermark columns and `etl_runs` table are gone
--    - the old star schema (fact_transactions, dim_date, ...) is gone
--    - the three reporting views it fed (vw_daily_sales, vw_monthly_sales,
--      vw_product_velocity) are kept, but now query the operational
--      tables directly, computed on read instead of synced on a timer.
--
--  Phase 1: auth moves to Supabase Auth. The old `users` table (with its
--  own password_hash/bcrypt) is gone - `profiles` now stores role/name,
--  keyed 1:1 on Supabase's built-in `auth.users`. Every table has Row
--  Level Security turned on (Phase 0 shipped without it - anyone holding
--  the publishable key had full read/write access to every row).
--
--  Run this in the Supabase SQL Editor (Project -> SQL Editor -> New
--  query -> paste -> Run). Safe to re-run: it drops and recreates.
--  Since no real data exists yet, this rewrite doesn't try to preserve
--  Phase 0 rows.
-- =====================================================================

drop view  if exists vw_product_velocity;
drop view  if exists vw_monthly_sales;
drop view  if exists vw_daily_sales;
drop table if exists alerts;
drop table if exists stock_movements;
drop table if exists sale_items;
drop table if exists sales;
drop table if exists products;
drop table if exists profiles;
drop table if exists users;

drop function if exists public.handle_new_user() cascade;
drop function if exists current_user_role() cascade;
drop function if exists set_updated_at() cascade;
drop function if exists confirm_sale(jsonb, text) cascade;
drop function if exists undo_sale(bigint) cascade;
drop function if exists record_stock_movements(jsonb, text) cascade;
drop function if exists monthly_demand(text) cascade;
drop function if exists monthly_demand_all() cascade;
drop function if exists monthly_sales_totals() cascade;
drop function if exists sales_kpi_summary() cascade;

drop type if exists user_role;
drop type if exists sale_status;
drop type if exists movement_type;
drop type if exists alert_type;
drop type if exists alert_severity;

create type user_role      as enum ('owner', 'staff');
create type sale_status    as enum ('confirmed', 'voided');
create type movement_type  as enum ('stock_in', 'adjustment', 'sale_decrement', 'void_increment');
create type alert_type     as enum ('low_stock', 'stockout_imminent', 'demand_spike', 'overstock');
create type alert_severity as enum ('info', 'warning', 'critical');

-- Postgres has no `ON UPDATE CURRENT_TIMESTAMP` column option like MySQL;
-- this trigger function does the equivalent, attached to any table with
-- an `updated_at` column below.
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- =====================================================================
--  RBAC (owner / staff), backed by Supabase Auth
-- =====================================================================

-- One row per Supabase Auth user. `id` IS the auth.users id - there's no
-- separate profile id, so joining/filtering by the logged-in user is just
-- `id = auth.uid()`.
create table profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   varchar(64)  not null unique,
  full_name  varchar(128) not null,
  role       user_role    not null default 'staff',
  is_active  boolean      not null default true,
  created_at timestamptz  not null default now()
);

-- Auto-creates a profile row whenever someone signs up in Supabase Auth.
-- Role/username/full_name come from the signup call's `options.data`
-- (see web/src/app/login) - if that's missing (e.g. a user added by hand
-- from the Supabase dashboard, which has no such field), it falls back to
-- the email's local part. Role is ALWAYS 'staff' - there is deliberately no
-- code path anywhere that creates an owner. To make your own account the
-- owner: create yourself as a user in the dashboard, then run
--   update profiles set role = 'owner' where username = 'you@example.com';
-- Keep "Allow new users to sign up" OFF in Supabase Auth settings; staff
-- accounts are created by the owner through /settings instead.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, full_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    -- Hard-coded, NOT read from raw_user_meta_data: that metadata is
    -- supplied by whoever makes the sign-up request, so reading a role out
    -- of it let a /auth/v1/signup call create its own owner account. See
    -- sql/migrations/030_fix_profiles_role_escalation.sql.
    'staff'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Reads the caller's own role, bypassing RLS (security definer) so RLS
-- policies below can call this without recursing back into `profiles`.
create or replace function current_user_role()
returns user_role
language sql
security definer
set search_path = public
stable
as $$
  select role from profiles where id = auth.uid();
$$;

-- ---------- item catalog ----------
create table products (
  product_id     bigint generated always as identity primary key,
  sku            varchar(40)  not null unique,
  name           varchar(160) not null,
  category       varchar(80)  not null default 'Uncategorized',
  brand          varchar(80)  not null default 'Generic',
  vehicle_compat varchar(160),
  supplier       varchar(120) not null default 'Unknown',
  unit_cost      numeric(12,2) not null default 0,
  unit_price     numeric(12,2) not null default 0,
  reorder_point  integer not null default 0,
  stock_on_hand  integer not null default 0,
  is_active      boolean not null default true,
  source_type    varchar(40) not null default 'Direct Sales Entry',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index ix_products_name on products (name);
create index ix_products_active on products (is_active);
create trigger trg_products_updated_at
  before update on products
  for each row execute function set_updated_at();

-- ---------- sales header (one row per confirmed sale) ----------
create table sales (
  sale_id       bigint generated always as identity primary key,
  sale_ts       timestamptz not null default now(),
  -- nullable: a deleted staff account's old sales get reassigned to null
  -- (read as "Former staff" in the UI) rather than blocked from deletion
  user_id       uuid references profiles (id),
  user_role     user_role not null,
  total_amount  numeric(14,2) not null default 0,
  total_cost    numeric(14,2) not null default 0,
  status        sale_status not null default 'confirmed',
  voided_ts     timestamptz,
  note          varchar(255),
  source_type   varchar(40) not null default 'Direct Sales Entry',
  customer_name     varchar(255),
  customer_contact  varchar(100),
  customer_address  varchar(255),
  customer_vehicle_brand varchar(100)
);
create index ix_sales_ts on sales (sale_ts);

-- ---------- sale line items (one row per product per sale) ----------
create table sale_items (
  sale_item_id  bigint generated always as identity primary key,
  sale_id       bigint not null references sales (sale_id) on delete cascade,
  product_id    bigint not null references products (product_id),
  sku           varchar(40) not null,
  quantity      integer not null,
  unit_price    numeric(12,2) not null,
  unit_cost     numeric(12,2) not null,
  line_revenue  numeric(14,2) not null,
  line_cost     numeric(14,2) not null
);
create index ix_si_sale on sale_items (sale_id);
create index ix_si_product on sale_items (product_id);

-- ---------- stock movements ----------
create table stock_movements (
  movement_id   bigint generated always as identity primary key,
  movement_ts   timestamptz not null default now(),
  product_id    bigint not null references products (product_id),
  sku           varchar(40) not null,
  movement_type movement_type not null,
  quantity      integer not null,
  balance_after integer not null,
  user_id       uuid references profiles (id),
  reference     varchar(80),
  note          varchar(255),
  -- snapshots of products.supplier/unit_cost at the moment of a 'stock_in'
  -- movement only (null for 'adjustment' and other types) - see
  -- sql/migrations/018_add_stockin_supplier_cost.sql for the full rationale.
  supplier      varchar(120),
  unit_cost     numeric(12,2)
);
create index ix_sm_ts on stock_movements (movement_ts);

-- ---------- services (manual entry, not tied to inventory/products) ----------
create table services (
  service_id    bigint generated always as identity primary key,
  service_ts    timestamptz not null default now(),
  -- nullable: a deleted staff account's old service records get
  -- reassigned to null (read as "Former staff" in the UI), same as sales
  user_id       uuid references profiles (id),
  user_role     user_role not null,
  service_type  varchar(255) not null,
  total_amount  numeric(14,2) not null default 0,
  status        sale_status not null default 'confirmed',
  voided_ts     timestamptz,
  customer_name     varchar(255),
  customer_contact  varchar(100),
  customer_address  varchar(255),
  customer_vehicle_brand varchar(100)
);
create index ix_services_ts on services (service_ts);

-- ---------- rule-based DSS alert snapshot ----------
create table alerts (
  alert_id          bigint generated always as identity primary key,
  generated_ts      timestamptz not null default now(),
  batch_id          varchar(32) not null,
  product_id        bigint not null references products (product_id),
  sku               varchar(40) not null,
  product_name      varchar(160) not null,
  alert_type        alert_type not null,
  severity          alert_severity not null,
  stock_on_hand     integer not null,
  reorder_point     integer not null,
  forecast_30d      numeric(12,2),
  days_to_depletion numeric(8,2),
  recommendation    varchar(255) not null,
  rule_trace        varchar(255) not null
);
create index ix_alert_batch on alerts (batch_id);
create index ix_alert_gen on alerts (generated_ts);

-- owner's override of which Decision Support advisory type shows for a
-- SKU. See sql/migrations/020_add_advisory_overrides.sql for the full rationale
-- - the rule engine's own evaluation is never hidden or faked when a
-- manual_type is set, just outranked.
create table advisory_overrides (
  product_id  bigint primary key references products (product_id) on delete cascade,
  manual_type varchar(20) not null check (manual_type in ('low_stock', 'demand_spike', 'overstock')),
  updated_by  uuid references auth.users (id),
  updated_at  timestamptz not null default now()
);

-- Escalating brute-force login lockout state, keyed on login email. See
-- sql/migrations/022_add_login_lockouts.sql for the full policy/rationale. No
-- RLS policies are defined below (RLS enabled, none granted) - only the
-- service-role key, used exclusively from /api/auth/login-guard, can
-- touch this table.
create table login_lockouts (
  identifier            text primary key,
  fail_count            integer not null default 0,
  locked_until          timestamptz,
  lockout_stage         integer not null default -1,
  last_lockout_ended_at timestamptz,
  updated_at            timestamptz not null default now()
);

-- =====================================================================
--  Reporting views — replace the old synced star schema. These compute
--  straight from sale_items/sales/products on every query instead of
--  from a nightly/15-min ETL job. Fine at this data volume (small shop);
--  if it's ever too slow, turn one into a materialized view + a Supabase
--  scheduled refresh — still no app-level scheduler needed.
-- =====================================================================

-- security_invoker: a view is NOT subject to the RLS of the tables under
-- it. Since PG15 it runs as its OWNER unless this is set, and the owner
-- here is `postgres`, which bypasses RLS - so without it the publishable
-- anon key could read this view's figures with no login.
create view vw_daily_sales with (security_invoker = true) as
select
  s.sale_ts::date                       as full_date,
  extract(year  from s.sale_ts)::int    as year,
  extract(quarter from s.sale_ts)::int  as quarter,
  extract(month from s.sale_ts)::int    as month,
  to_char(s.sale_ts, 'Month')           as month_name,
  to_char(s.sale_ts, 'Day')             as day_name,
  extract(isodow from s.sale_ts) in (6, 7) as is_weekend,
  p.sku,
  p.name                                as product_name,
  p.category                            as category_name,
  p.brand                               as brand_name,
  p.supplier                            as supplier_name,
  p.source_type,
  sum(si.quantity)                      as units,
  sum(si.line_revenue)                  as revenue,
  sum(si.line_cost)                     as cost,
  sum(si.line_revenue - si.line_cost)   as gross_profit
from sale_items si
join sales s    on s.sale_id = si.sale_id
join products p on p.product_id = si.product_id
where s.status = 'confirmed'
group by s.sale_ts::date, year, quarter, month, month_name, day_name,
         is_weekend, p.sku, p.name, p.category, p.brand, p.supplier, p.source_type;

-- security_invoker: a view is NOT subject to the RLS of the tables under
-- it. Since PG15 it runs as its OWNER unless this is set, and the owner
-- here is `postgres`, which bypasses RLS - so without it the publishable
-- anon key could read this view's figures with no login.
create view vw_monthly_sales with (security_invoker = true) as
select
  extract(year  from s.sale_ts)::int as year,
  extract(month from s.sale_ts)::int as month,
  min(s.sale_ts::date)               as month_start,
  p.sku,
  p.name                             as product_name,
  p.category                         as category_name,
  sum(si.quantity)                   as units,
  sum(si.line_revenue)               as revenue,
  sum(si.line_revenue - si.line_cost) as gross_profit
from sale_items si
join sales s    on s.sale_id = si.sale_id
join products p on p.product_id = si.product_id
where s.status = 'confirmed'
group by year, month, p.sku, p.name, p.category;

-- security_invoker: a view is NOT subject to the RLS of the tables under
-- it. Since PG15 it runs as its OWNER unless this is set, and the owner
-- here is `postgres`, which bypasses RLS - so without it the publishable
-- anon key could read this view's figures with no login.
create view vw_product_velocity with (security_invoker = true) as
select
  p.sku,
  p.name     as product_name,
  p.category as category_name,
  coalesce(sum(si.quantity), 0)                     as units_90d,
  coalesce(sum(si.line_revenue), 0)                 as revenue_90d,
  coalesce(sum(si.line_revenue - si.line_cost), 0)  as gross_profit_90d
from products p
-- sale_items is pre-filtered to qualifying sales *before* the join to
-- products, not after - joining sale_items to products first and only
-- then filtering sales.status in the second join's ON clause (the
-- original version of this view) left a voided/old sale's line items
-- attached to the product regardless, since sale_items itself was never
-- excluded.
left join (
  select si.*
  from sale_items si
  join sales s on s.sale_id = si.sale_id
  where s.status = 'confirmed' and s.sale_ts >= now() - interval '90 days'
) si on si.product_id = p.product_id
group by p.sku, p.name, p.category;

-- =====================================================================
--  Row Level Security
--
--  Baseline for Phase 1: block all anonymous access, allow any signed-in
--  user (owner or staff) to read the shared operational data, and keep
--  writes to products/deletes restricted to owners. Column-level
--  restrictions (staff not seeing unit_cost/gross_profit) are NOT done
--  here - that mirrors the original Flask app, which enforced it in
--  Python route handlers, not MySQL grants. Phase 2 (building the real
--  sales/stock-in/products screens) is where that gets enforced, via
--  which columns the API route selects for a staff session.
-- =====================================================================

alter table profiles        enable row level security;
alter table products        enable row level security;
alter table sales           enable row level security;
alter table sale_items      enable row level security;
alter table stock_movements enable row level security;
alter table services        enable row level security;
alter table alerts          enable row level security;
alter table advisory_overrides enable row level security;
alter table login_lockouts     enable row level security;

-- Three of the policies below are owner-only at the row level, and one
-- table-and-column grant block at the end of this file takes the cost
-- columns away from `authenticated` entirely. Both are migration 034; see
-- sql/migrations/034_lock_cost_columns.sql for why column privileges are the
-- only tool that works here, and 034_rollback.sql to undo it.

-- profiles: everyone can read their own row; owners can read every row
-- (needed for a future staff-management screen).
create policy "profiles_select" on profiles for select
  using (auth.uid() = id or current_user_role() = 'owner');

-- products: any signed-in user can read; only owners can write.
create policy "products_select" on products for select
  using (auth.role() = 'authenticated');
create policy "products_write" on products for all
  using (current_user_role() = 'owner')
  with check (current_user_role() = 'owner');

-- sales / sale_items: any signed-in user can read and insert (both roles
-- record sales); only owners can update or delete (e.g. voiding a sale).
-- stock_movements is read by both roles but inserted only by the owner -
-- staff sales reach it through security-definer functions instead.
create policy "sales_select" on sales for select
  using (auth.role() = 'authenticated');
create policy "sales_insert" on sales for insert
  with check (auth.role() = 'authenticated');
create policy "sales_owner_write" on sales for update
  using (current_user_role() = 'owner');

create policy "sale_items_select" on sale_items for select
  using (auth.role() = 'authenticated');
create policy "sale_items_insert" on sale_items for insert
  with check (auth.role() = 'authenticated');

create policy "stock_movements_select" on stock_movements for select
  using (current_user_role() = 'owner');
-- inserts are owner-only: staff sales/voids reach this table through the
-- security-definer functions (confirm_sale, undo_sale, edit_sale), which
-- bypass RLS, so staff never need direct insert rights. See
-- sql/migrations/026_fix_stockin_owner_only.sql.
create policy "stock_movements_insert" on stock_movements for insert
  with check (current_user_role() = 'owner');
-- owners can reassign user_id when deleting a staff account
create policy "stock_movements_owner_write" on stock_movements for update
  using (current_user_role() = 'owner');

-- services: same shape as sales - any signed-in user can read/insert,
-- only owners can update (voiding a service record).
create policy "services_select" on services for select
  using (auth.role() = 'authenticated');
create policy "services_insert" on services for insert
  with check (auth.role() = 'authenticated');
create policy "services_owner_write" on services for update
  using (current_user_role() = 'owner');

-- alerts: read-only for everyone signed in; written by the owner-triggered
-- rules engine (Decision Support screen).
create policy "alerts_select" on alerts for select
  using (current_user_role() = 'owner');
create policy "alerts_insert" on alerts for insert
  with check (current_user_role() = 'owner');

-- advisory_overrides: same shape as products - any signed-in user can
-- read, only owners can write.
drop policy if exists "advisory_overrides_select" on advisory_overrides;
create policy "advisory_overrides_select" on advisory_overrides for select
  using (current_user_role() = 'owner');
drop policy if exists "advisory_overrides_write" on advisory_overrides;
create policy "advisory_overrides_write" on advisory_overrides for all
  using (current_user_role() = 'owner')
  with check (current_user_role() = 'owner');

-- =====================================================================
--  RPC functions for atomic multi-table writes.
--
--  Recording or undoing a sale touches sales + sale_items + products +
--  stock_movements together, and needs to lock the product rows while
--  checking stock so two simultaneous sales can't oversell the same
--  item. PostgREST (what the Supabase client talks to) can't do a
--  locking, multi-statement transaction in one call, so this is a
--  Postgres function instead - it runs as a single transaction, and
--  SECURITY DEFINER lets it write across tables regardless of the
--  per-table RLS policies above (it enforces its own auth checks
--  instead, using auth.uid()/current_user_role()).
-- =====================================================================

create or replace function confirm_sale(
  items jsonb,
  note text default null,
  customer_name text default null,
  customer_contact text default null,
  customer_address text default null,
  customer_vehicle_brand text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
  v_sale_id bigint;
  v_total_rev numeric(14,2) := 0;
  v_total_cost numeric(14,2) := 0;
  v_item jsonb;
  v_pid bigint;
  v_qty integer;
  v_product record;
  v_new_bal integer;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;

  v_role := current_user_role();
  if v_role is null then
    raise exception 'No profile found for this account.';
  end if;

  if items is null or jsonb_array_length(items) = 0 then
    raise exception 'No items to record.';
  end if;

  -- Lock every touched product row up front, in a deterministic order,
  -- so two simultaneous sales sharing a product can't deadlock or both
  -- read the same pre-decrement stock_on_hand.
  perform 1 from products
    where product_id in (
      select (elem ->> 'product_id')::bigint from jsonb_array_elements(items) elem
    )
    order by product_id
    for update;

  insert into sales (user_id, user_role, total_amount, total_cost, note,
      customer_name, customer_contact, customer_address, customer_vehicle_brand)
  values (v_uid, v_role, 0, 0, nullif(note, ''),
      nullif(customer_name, ''), nullif(customer_contact, ''), nullif(customer_address, ''),
      nullif(customer_vehicle_brand, ''))
  returning sale_id into v_sale_id;

  for v_item in select * from jsonb_array_elements(items)
  loop
    v_pid := (v_item ->> 'product_id')::bigint;
    v_qty := (v_item ->> 'qty')::integer;

    if v_qty is null or v_qty <= 0 then
      raise exception 'Bad line item.';
    end if;

    select product_id, sku, unit_price, unit_cost, stock_on_hand
      into v_product
      from products where product_id = v_pid;

    if not found then
      raise exception 'Product % not found.', v_pid;
    end if;
    if v_qty > v_product.stock_on_hand then
      raise exception 'Not enough stock for % (on hand %, requested %).',
        v_product.sku, v_product.stock_on_hand, v_qty;
    end if;

    v_new_bal := v_product.stock_on_hand - v_qty;

    insert into sale_items (sale_id, product_id, sku, quantity, unit_price,
        unit_cost, line_revenue, line_cost)
    values (v_sale_id, v_pid, v_product.sku, v_qty, v_product.unit_price,
        v_product.unit_cost, round(v_qty * v_product.unit_price, 2),
        round(v_qty * v_product.unit_cost, 2));

    update products set stock_on_hand = v_new_bal where product_id = v_pid;

    insert into stock_movements (product_id, sku, movement_type, quantity,
        balance_after, user_id, reference)
    values (v_pid, v_product.sku, 'sale_decrement', -v_qty, v_new_bal, v_uid,
        'sale:' || v_sale_id);

    v_total_rev := v_total_rev + round(v_qty * v_product.unit_price, 2);
    v_total_cost := v_total_cost + round(v_qty * v_product.unit_cost, 2);
  end loop;

  update sales set total_amount = v_total_rev, total_cost = v_total_cost
    where sale_id = v_sale_id;

  return jsonb_build_object('sale_id', v_sale_id, 'total_amount', v_total_rev);
end;
$$;

revoke execute on function confirm_sale(jsonb, text, text, text, text, text) from public;
revoke execute on function confirm_sale(jsonb, text, text, text, text, text) from anon;
grant execute on function confirm_sale(jsonb, text, text, text, text, text) to authenticated, service_role;

create or replace function undo_sale(p_sale_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
  v_sale record;
  v_item record;
  v_new_bal integer;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;
  v_role := current_user_role();

  select * into v_sale from sales where sale_id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found.';
  end if;
  if v_sale.status = 'voided' then
    raise exception 'Already undone.';
  end if;

  -- staff may undo only their own sale on the same day; owner may undo any.
  -- Manila, not UTC: a timestamptz cast to date uses the session's TimeZone,
  -- which for PostgREST is UTC, and so is current_date - which put "the same
  -- day" eight hours out of step with the trading day. See
  -- sql/migrations/031_fix_audit_batch_1.sql.
  if v_role <> 'owner' and (
    v_sale.user_id is distinct from v_uid
    or (v_sale.sale_ts at time zone 'Asia/Manila')::date
       <> (now() at time zone 'Asia/Manila')::date
  ) then
    raise exception 'Not allowed to undo this sale.';
  end if;

  for v_item in select product_id, sku, quantity from sale_items where sale_id = p_sale_id
  loop
    update products set stock_on_hand = stock_on_hand + v_item.quantity
      where product_id = v_item.product_id
      returning stock_on_hand into v_new_bal;

    insert into stock_movements (product_id, sku, movement_type, quantity,
        balance_after, user_id, reference)
    values (v_item.product_id, v_item.sku, 'void_increment', v_item.quantity,
        v_new_bal, v_uid, 'undo:' || p_sale_id);
  end loop;

  update sales set status = 'voided', voided_ts = now() where sale_id = p_sale_id;

  return jsonb_build_object('ok', true, 'sale_id', p_sale_id);
end;
$$;

revoke execute on function undo_sale(bigint) from public;
revoke execute on function undo_sale(bigint) from anon;
grant execute on function undo_sale(bigint) to authenticated, service_role;

-- edit_sale(): corrects a confirmed sale's line items/note/customer info
-- in place (owner: any sale; staff: only their own, no same-day limit,
-- unlike undo_sale - see sql/migrations/014_add_edit_sale.sql for the full
-- rationale). Reverses the sale's old stock impact, then re-applies the
-- new item list exactly like confirm_sale, re-pricing at products'
-- CURRENT unit_price/unit_cost.
create or replace function edit_sale(
  p_sale_id bigint,
  items jsonb,
  p_note text default null,
  p_customer_name text default null,
  p_customer_contact text default null,
  p_customer_address text default null,
  p_customer_vehicle_brand text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
  v_sale record;
  v_old record;
  v_item jsonb;
  v_pid bigint;
  v_qty integer;
  v_product record;
  v_new_bal integer;
  v_total_rev numeric(14,2) := 0;
  v_total_cost numeric(14,2) := 0;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;
  v_role := current_user_role();
  if v_role is null then
    raise exception 'No profile found for this account.';
  end if;

  select * into v_sale from sales where sale_id = p_sale_id for update;
  if not found then
    raise exception 'Sale not found.';
  end if;
  if v_sale.status = 'voided' then
    raise exception 'Cannot edit a voided sale.';
  end if;

  if v_role <> 'owner' and v_sale.user_id is distinct from v_uid then
    raise exception 'Not allowed to edit this sale.';
  end if;

  if items is null or jsonb_array_length(items) = 0 then
    raise exception 'A sale needs at least one line item.';
  end if;

  perform 1 from products
    where product_id in (
      select product_id from sale_items where sale_id = p_sale_id
      union
      select (elem ->> 'product_id')::bigint from jsonb_array_elements(items) elem
    )
    order by product_id
    for update;

  for v_old in select product_id, sku, quantity from sale_items where sale_id = p_sale_id
  loop
    update products set stock_on_hand = stock_on_hand + v_old.quantity
      where product_id = v_old.product_id
      returning stock_on_hand into v_new_bal;

    insert into stock_movements (product_id, sku, movement_type, quantity,
        balance_after, user_id, reference)
    values (v_old.product_id, v_old.sku, 'void_increment', v_old.quantity,
        v_new_bal, v_uid, 'edit:' || p_sale_id);
  end loop;

  delete from sale_items where sale_id = p_sale_id;

  for v_item in select * from jsonb_array_elements(items)
  loop
    v_pid := (v_item ->> 'product_id')::bigint;
    v_qty := (v_item ->> 'qty')::integer;

    if v_qty is null or v_qty <= 0 then
      raise exception 'Bad line item.';
    end if;

    select product_id, sku, unit_price, unit_cost, stock_on_hand
      into v_product
      from products where product_id = v_pid;

    if not found then
      raise exception 'Product % not found.', v_pid;
    end if;
    if v_qty > v_product.stock_on_hand then
      raise exception 'Not enough stock for % (on hand %, requested %).',
        v_product.sku, v_product.stock_on_hand, v_qty;
    end if;

    v_new_bal := v_product.stock_on_hand - v_qty;

    insert into sale_items (sale_id, product_id, sku, quantity, unit_price,
        unit_cost, line_revenue, line_cost)
    values (p_sale_id, v_pid, v_product.sku, v_qty, v_product.unit_price,
        v_product.unit_cost, round(v_qty * v_product.unit_price, 2),
        round(v_qty * v_product.unit_cost, 2));

    update products set stock_on_hand = v_new_bal where product_id = v_pid;

    insert into stock_movements (product_id, sku, movement_type, quantity,
        balance_after, user_id, reference)
    values (v_pid, v_product.sku, 'sale_decrement', -v_qty, v_new_bal, v_uid,
        'edit:' || p_sale_id);

    v_total_rev := v_total_rev + round(v_qty * v_product.unit_price, 2);
    v_total_cost := v_total_cost + round(v_qty * v_product.unit_cost, 2);
  end loop;

  update sales set
      total_amount = v_total_rev,
      total_cost = v_total_cost,
      note = nullif(p_note, ''),
      customer_name = nullif(p_customer_name, ''),
      customer_contact = nullif(p_customer_contact, ''),
      customer_address = nullif(p_customer_address, ''),
      customer_vehicle_brand = nullif(p_customer_vehicle_brand, '')
    where sale_id = p_sale_id;

  return jsonb_build_object('ok', true, 'sale_id', p_sale_id, 'total_amount', v_total_rev);
end;
$$;

revoke execute on function edit_sale(bigint, jsonb, text, text, text, text, text) from public;
revoke execute on function edit_sale(bigint, jsonb, text, text, text, text, text) from anon;
grant execute on function edit_sale(bigint, jsonb, text, text, text, text, text) to authenticated, service_role;

-- Services: manual entry, no inventory/stock involvement, so no locking
-- or line items - just a stamped record of what was recorded and by whom.
create or replace function record_service(
  service_type text,
  total_amount numeric,
  customer_name text default null,
  customer_contact text default null,
  customer_address text default null,
  customer_vehicle_brand text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
  v_service_id bigint;
  v_type text := nullif(trim(service_type), '');
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;

  v_role := current_user_role();
  if v_role is null then
    raise exception 'No profile found for this account.';
  end if;

  if v_type is null then
    raise exception 'Service type is required.';
  end if;
  if total_amount is null or total_amount < 0 then
    raise exception 'Bad total amount.';
  end if;

  insert into services (user_id, user_role, service_type, total_amount,
      customer_name, customer_contact, customer_address, customer_vehicle_brand)
  values (v_uid, v_role, v_type, total_amount,
      nullif(customer_name, ''), nullif(customer_contact, ''), nullif(customer_address, ''),
      nullif(customer_vehicle_brand, ''))
  returning service_id into v_service_id;

  return jsonb_build_object('service_id', v_service_id, 'total_amount', total_amount);
end;
$$;

revoke execute on function record_service(text, numeric, text, text, text, text) from public;
revoke execute on function record_service(text, numeric, text, text, text, text) from anon;
grant execute on function record_service(text, numeric, text, text, text, text) to authenticated, service_role;

create or replace function undo_service(p_service_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
  v_service record;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;
  v_role := current_user_role();

  select * into v_service from services where service_id = p_service_id for update;
  if not found then
    raise exception 'Service record not found.';
  end if;
  if v_service.status = 'voided' then
    raise exception 'Already undone.';
  end if;

  -- staff may undo only their own record on the same day; owner may undo
  -- any. Manila, not UTC - see undo_sale above, and
  -- sql/migrations/031_fix_audit_batch_1.sql.
  if v_role <> 'owner' and (
    v_service.user_id is distinct from v_uid
    or (v_service.service_ts at time zone 'Asia/Manila')::date
       <> (now() at time zone 'Asia/Manila')::date
  ) then
    raise exception 'Not allowed to undo this service record.';
  end if;

  update services set status = 'voided', voided_ts = now() where service_id = p_service_id;

  return jsonb_build_object('ok', true, 'service_id', p_service_id);
end;
$$;

revoke execute on function undo_service(bigint) from public;
revoke execute on function undo_service(bigint) from anon;
grant execute on function undo_service(bigint) to authenticated, service_role;

-- set_product_supplier: lets any signed-in profile (not just owner) tag a
-- product's supplier - an operational label like reference/note, not a
-- priced field, so it isn't behind the owner-only products_write policy
-- unit_cost/unit_price get. Needed because Stock In is also used by staff.
create or replace function set_product_supplier(p_product_id bigint, p_supplier text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;
  v_role := current_user_role();
  if v_role is null then
    raise exception 'No profile found for this account.';
  end if;
  -- Stock In, the one screen that calls this, is owner-only now; without
  -- this a staff session could rename any product's supplier straight from
  -- the browser, because a security-definer function bypasses the
  -- products_write RLS policy that would otherwise stop it.
  if v_role <> 'owner' then
    raise exception 'Only the owner can change a product''s supplier.';
  end if;

  update products set supplier = coalesce(nullif(trim(p_supplier), ''), 'Unknown')
    where product_id = p_product_id;

  if not found then
    raise exception 'Product not found.';
  end if;
end;
$$;

revoke execute on function set_product_supplier(bigint, text) from public;
revoke execute on function set_product_supplier(bigint, text) from anon;
grant execute on function set_product_supplier(bigint, text) to authenticated, service_role;

create or replace function record_stock_movements(items jsonb, reference text default null, supplier text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role user_role;
  v_ref text := nullif(trim(reference), '');
  v_sup text := nullif(trim(supplier), '');
  v_item jsonb;
  v_pid bigint;
  v_qty integer;
  v_product record;
  v_new_bal integer;
  v_mt movement_type;
  v_recorded jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;
  v_role := current_user_role();
  if v_role is null then
    raise exception 'No profile found for this account.';
  end if;
  -- Stock In is an owner-only screen; without this a staff session could
  -- call this RPC straight from the browser and move stock anyway, because
  -- a security-definer function bypasses the table's RLS policies.
  if v_role <> 'owner' then
    raise exception 'Only the owner can record stock movements.';
  end if;

  if items is null or jsonb_array_length(items) = 0 then
    raise exception 'Nothing to record.';
  end if;

  perform 1 from products
    where product_id in (
      select (elem ->> 'product_id')::bigint from jsonb_array_elements(items) elem
    )
    order by product_id
    for update;

  if v_sup is not null then
    update products set supplier = v_sup
      where product_id in (
        select (elem ->> 'product_id')::bigint from jsonb_array_elements(items) elem
      );
  end if;

  for v_item in select * from jsonb_array_elements(items)
  loop
    v_pid := (v_item ->> 'product_id')::bigint;
    v_qty := (v_item ->> 'qty')::integer;

    if v_qty is null or v_qty = 0 then
      continue;
    end if;

    select product_id, sku, name, stock_on_hand, supplier, unit_cost into v_product
      from products where product_id = v_pid;
    if not found then
      raise exception 'Product % not found.', v_pid;
    end if;

    v_new_bal := v_product.stock_on_hand + v_qty;
    if v_new_bal < 0 then
      raise exception 'Adjustment would make % negative (% + %).',
        v_product.name, v_product.stock_on_hand, v_qty;
    end if;

    v_mt := case when v_qty > 0 then 'stock_in' else 'adjustment' end;

    update products set stock_on_hand = v_new_bal where product_id = v_pid;

    insert into stock_movements (product_id, sku, movement_type, quantity,
        balance_after, user_id, reference, supplier, unit_cost)
    values (
      v_pid, v_product.sku, v_mt, v_qty, v_new_bal, v_uid, v_ref,
      case when v_mt = 'stock_in' then v_product.supplier else null end,
      case when v_mt = 'stock_in' then v_product.unit_cost else null end
    );

    v_recorded := v_recorded || jsonb_build_object(
      'sku', v_product.sku, 'name', v_product.name,
      'change', v_qty, 'balance', v_new_bal
    );
  end loop;

  if jsonb_array_length(v_recorded) = 0 then
    raise exception 'Nothing to record.';
  end if;

  return jsonb_build_object('ok', true, 'recorded', v_recorded);
end;
$$;

revoke execute on function record_stock_movements(jsonb, text, text) from public;
revoke execute on function record_stock_movements(jsonb, text, text) from anon;
grant execute on function record_stock_movements(jsonb, text, text) to authenticated, service_role;

-- Read-only, no security definer needed: authenticated already has SELECT
-- on sale_items/sales/products via the RLS policies above, and the
-- forecasting service calls this with the service_role key, which
-- bypasses RLS entirely regardless.
create or replace function monthly_demand(p_sku text)
returns table(year int, month int, units numeric)
language sql
stable
as $$
  select
    extract(year from (s.sale_ts at time zone 'Asia/Manila'))::int as year,
    extract(month from (s.sale_ts at time zone 'Asia/Manila'))::int as month,
    sum(si.quantity)::numeric as units
  from sale_items si
  join sales s    on s.sale_id = si.sale_id
  join products p on p.product_id = si.product_id
  where p.sku = p_sku and s.status = 'confirmed'
  group by year, month
  order by year, month;
$$;

revoke execute on function monthly_demand(text) from public;
revoke execute on function monthly_demand(text) from anon;
grant execute on function monthly_demand(text) to authenticated, service_role;

-- Same idea as monthly_demand(), but for every SKU in one query - used by
-- Decision Support, which otherwise needed one round trip per product.
create or replace function monthly_demand_all()
returns table(sku text, year int, month int, units numeric)
language sql
stable
as $$
  select
    p.sku,
    extract(year from (s.sale_ts at time zone 'Asia/Manila'))::int as year,
    extract(month from (s.sale_ts at time zone 'Asia/Manila'))::int as month,
    sum(si.quantity)::numeric as units
  from sale_items si
  join sales s    on s.sale_id = si.sale_id
  join products p on p.product_id = si.product_id
  where s.status = 'confirmed'
  group by p.sku, year, month
  order by p.sku, year, month;
$$;

revoke execute on function monthly_demand_all() from public;
revoke execute on function monthly_demand_all() from anon;
grant execute on function monthly_demand_all() to authenticated, service_role;

-- Shop-wide monthly totals for the dashboard's Sales Volume Heatmap, grouped
-- by year/month only (not per-sku like monthly_demand_all() above) - this
-- card never needs a sku breakdown, and selecting straight from
-- vw_monthly_sales for every sku x month combination returns 40,000+ rows
-- for the real catalog, which PostgREST silently truncates to its default
-- 1000-row page unless the caller paginates. Aggregating in SQL instead
-- caps this at one row per calendar month (a few dozen, ever) - correct by
-- construction instead of "paginate correctly," not just a bigger ceiling.
create or replace function monthly_sales_totals()
returns table(year int, month int, units numeric)
language sql
stable
as $$
  select
    extract(year from s.sale_ts)::int as year,
    extract(month from s.sale_ts)::int as month,
    sum(si.quantity)::numeric as units
  from sale_items si
  join sales s on s.sale_id = si.sale_id
  where s.status = 'confirmed'
  group by year, month
  order by year, month;
$$;

revoke execute on function monthly_sales_totals() from public;
revoke execute on function monthly_sales_totals() from anon;
grant execute on function monthly_sales_totals() to authenticated, service_role;

-- Current-vs-previous-90-day revenue/cost totals for the dashboard's Gross
-- Profit Margin tile, aggregated in SQL instead of summed client-side over
-- every confirmed sale in the last 180 days - at real sales volume that
-- raw fetch exceeds PostgREST's default 1000-row page (with no order-by,
-- landing on an arbitrary leading slice instead of the real last-90-days
-- data). This always returns exactly one row.
create or replace function sales_kpi_summary()
returns table(
  current_revenue numeric,
  current_cost numeric,
  previous_revenue numeric,
  previous_cost numeric
)
language sql
stable
as $$
  -- "Sales" = sales + services combined (services at zero cost), matching
  -- the Gross & Net chart. See sql/migrations/024_fix_kpi_include_services.sql.
  with combined as (
    select sale_ts as ts, total_amount as amount, total_cost as cost
    from sales
    where status = 'confirmed' and sale_ts >= now() - interval '180 days'
    union all
    select service_ts as ts, total_amount as amount, 0::numeric as cost
    from services
    where status = 'confirmed' and service_ts >= now() - interval '180 days'
  )
  select
    coalesce(sum(amount) filter (where ts >= now() - interval '90 days'), 0) as current_revenue,
    coalesce(sum(cost)   filter (where ts >= now() - interval '90 days'), 0) as current_cost,
    coalesce(sum(amount) filter (where ts <  now() - interval '90 days'), 0) as previous_revenue,
    coalesce(sum(cost)   filter (where ts <  now() - interval '90 days'), 0) as previous_cost
  from combined;
$$;

revoke execute on function sales_kpi_summary() from public;
revoke execute on function sales_kpi_summary() from anon;
grant execute on function sales_kpi_summary() to authenticated, service_role;

-- dashboard_gross_net_summary() was dropped in
-- sql/migrations/032_fix_batch_2.sql: superseded by
-- dashboard_gross_net_range() below, which the Gross & Net chart has
-- called since migration 028, and nothing referenced it any more. It
-- bucketed on a UTC date cast, so keeping it would have left a function
-- answering the same question wrongly for whoever found it next.


-- dashboard_gross_net_range(): the same revenue definition as
-- the Gross & Net chart needs, for an arbitrary date range in
-- explicit buckets, driven by the chart's calendar period picker.
-- Buckets on Manila local time rather than a UTC date cast, so a sale made
-- between midnight and 8 AM Manila is counted on the day it happened. Empty buckets come back as zero rows.
-- See sql/migrations/028_add_gross_net_range.sql.

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

revoke execute on function dashboard_gross_net_range(date, date, text) from public;
revoke execute on function dashboard_gross_net_range(date, date, text) from anon;
grant execute on function dashboard_gross_net_range(date, date, text) to authenticated, service_role;


-- =====================================================================
--  Add: dashboard_margin_trend() - trailing 12 calendar months (including
--  the current one) of sales + services gross & net, for the hero card's
--  margin sparkline. Separate from the Gross & Net chart's own series on
--  purpose: that function's 'month' branch is calendar-year-to-date and the
--  Gross & Net chart depends on that behavior.
--
--  Same definition as the rest of the dashboard: services count at their
--  full amount with zero cost.
--
--  ADDITIVE ONLY. Run in a NEW query tab in the Supabase SQL editor.
--  Also mirrored into sql/supabase_schema.sql.
-- =====================================================================

create or replace function dashboard_margin_trend()
returns table(
  period_start date,
  gross numeric,
  net numeric
)
language sql
stable
as $$
  with combined as (
    select (sale_ts at time zone 'Asia/Manila')::date as ts, total_amount as amount, total_cost as cost
    from sales where status = 'confirmed'
    union all
    select (service_ts at time zone 'Asia/Manila')::date as ts, total_amount as amount, 0::numeric as cost
    from services where status = 'confirmed'
  ),
  today as (
    select (now() at time zone 'Asia/Manila')::date as d
  ),
  points as (
    select (date_trunc('month', today.d) - make_interval(months => n) - interval '1 day')::date as p
    from generate_series(0, 10) as n, today
    union all
    select today.d from today
  )
  select
    points.p as period_start,
    coalesce(sum(combined.amount), 0) as gross,
    coalesce(sum(combined.amount - combined.cost), 0) as net
  from points
  left join combined on combined.ts between points.p - 89 and points.p
  group by points.p
  order by points.p asc;
$$;

revoke execute on function dashboard_margin_trend() from public;
revoke execute on function dashboard_margin_trend() from anon;
grant execute on function dashboard_margin_trend() to authenticated, service_role;

-- =====================================================================
--  Owner-only reads of cost and profit.
--
--  Every one of these is security definer with a fixed search_path and
--  opens with its own `current_user_role() is distinct from 'owner'`
--  check. They are how the owner screens reach cost once the grants
--  further down have taken the columns away from `authenticated`.
--
--  `is distinct from` rather than `<>`: current_user_role() returns NULL
--  for an authenticated user with no profile row, and `NULL <> 'owner'` is
--  NULL, which a plpgsql IF treats as false - so the plain form would skip
--  the guard and return the cost data. The policies below use the positive
--  `= 'owner'` form, where NULL filters the row out and fails closed.
--
--  See sql/migrations/033_add_owner_cost_access.sql.
-- =====================================================================

-- 1. The product catalog WITH costs, for the Products screen.
--
--    Search and category filtering move into the function because the
--    screen can no longer read the cost columns directly. p_search is a
--    parameter, not interpolated text, and the LIKE metacharacters are
--    escaped so a '%' in the box matches a literal per cent.
create or replace function owner_product_catalog(
  p_search text default null,
  p_category text default null,
  p_limit integer default 500
)
returns table(
  product_id bigint,
  sku varchar(40),
  name varchar(160),
  category varchar(80),
  supplier varchar(120),
  unit_cost numeric(12,2),
  unit_price numeric(12,2),
  reorder_point integer,
  stock_on_hand integer,
  is_active boolean
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_term text;
begin
  if current_user_role() is distinct from 'owner' then
    raise exception 'Owner access only.';
  end if;

  v_term := nullif(btrim(coalesce(p_search, '')), '');
  if v_term is not null then
    v_term := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
    select p.product_id, p.sku, p.name, p.category, p.supplier, p.unit_cost,
           p.unit_price, p.reorder_point, p.stock_on_hand, p.is_active
    from products p
    where (p_category is null or p.category = p_category)
      and (
        v_term is null
        or p.name     ilike v_term escape '\'
        or p.sku      ilike v_term escape '\'
        or p.supplier ilike v_term escape '\'
        or p.category ilike v_term escape '\'
      )
    order by p.name
    limit greatest(1, least(coalesce(p_limit, 500), 2000));
end;
$$;

revoke execute on function owner_product_catalog(text, text, integer) from public;
revoke execute on function owner_product_catalog(text, text, integer) from anon;
grant execute on function owner_product_catalog(text, text, integer) to authenticated, service_role;


-- 2. Product performance, replacing the direct vw_product_velocity read.
--
--    One row per active product: the velocity figures plus the catalog
--    fields the dashboard's Tracking table shows. lib/analytics.js joined
--    these two itself; doing it here keeps gross_profit_90d from ever
--    leaving the function.
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
           coalesce(v.units_90d, 0)        as units_90d,
           coalesce(v.revenue_90d, 0)      as revenue_90d,
           coalesce(v.gross_profit_90d, 0) as gross_profit_90d
    from products p
    left join vw_product_velocity v on v.sku = p.sku
    where p.is_active
    order by p.sku;
end;
$$;

revoke execute on function owner_product_performance() from public;
revoke execute on function owner_product_performance() from anon;
grant execute on function owner_product_performance() to authenticated, service_role;


-- 3. The KPI summary. Same body as sales_kpi_summary(), behind the check.
create or replace function owner_sales_kpi_summary()
returns table(
  current_revenue numeric,
  current_cost numeric,
  previous_revenue numeric,
  previous_cost numeric
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
    with combined as (
      select sale_ts as ts, total_amount as amount, total_cost as cost
      from sales
      where status = 'confirmed' and sale_ts >= now() - interval '180 days'
      union all
      -- Services are labour: the full amount, no recorded cost.
      select service_ts as ts, total_amount as amount, 0::numeric as cost
      from services
      where status = 'confirmed' and service_ts >= now() - interval '180 days'
    )
    select
      coalesce(sum(amount) filter (where ts >= now() - interval '90 days'), 0) as current_revenue,
      coalesce(sum(cost)   filter (where ts >= now() - interval '90 days'), 0) as current_cost,
      coalesce(sum(amount) filter (where ts <  now() - interval '90 days'), 0) as previous_revenue,
      coalesce(sum(cost)   filter (where ts <  now() - interval '90 days'), 0) as previous_cost
    from combined;
end;
$$;

revoke execute on function owner_sales_kpi_summary() from public;
revoke execute on function owner_sales_kpi_summary() from anon;
grant execute on function owner_sales_kpi_summary() to authenticated, service_role;


-- 4. The margin sparkline. Same body as dashboard_margin_trend(), Manila
--    dates and all (migration 032), behind the check.
create or replace function owner_margin_trend()
returns table(
  period_start date,
  gross numeric,
  net numeric
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
    with combined as (
      select (sale_ts at time zone 'Asia/Manila')::date as ts, total_amount as amount, total_cost as cost
      from sales where status = 'confirmed'
      union all
      select (service_ts at time zone 'Asia/Manila')::date as ts, total_amount as amount, 0::numeric as cost
      from services where status = 'confirmed'
    ),
    today as (
      select (now() at time zone 'Asia/Manila')::date as d
    ),
    points as (
      select (date_trunc('month', today.d) - make_interval(months => n) - interval '1 day')::date as p
      from generate_series(0, 10) as n, today
      union all
      select today.d from today
    )
    select
      points.p as period_start,
      coalesce(sum(combined.amount), 0) as gross,
      coalesce(sum(combined.amount - combined.cost), 0) as net
    from points
    left join combined on combined.ts between points.p - 89 and points.p
    group by points.p
    order by points.p asc;
end;
$$;

revoke execute on function owner_margin_trend() from public;
revoke execute on function owner_margin_trend() from anon;
grant execute on function owner_margin_trend() to authenticated, service_role;


-- 5. Gross & Net for a calendar period. Same body as
--    dashboard_gross_net_range(), behind the check.
create or replace function owner_gross_net_range(
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
security definer
set search_path = public
stable
as $$
declare
  v_step interval;
begin
  if current_user_role() is distinct from 'owner' then
    raise exception 'Owner access only.';
  end if;

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

revoke execute on function owner_gross_net_range(date, date, text) from public;
revoke execute on function owner_gross_net_range(date, date, text) from anon;
grant execute on function owner_gross_net_range(date, date, text) to authenticated, service_role;


-- 6. The Stock-In Tracker's log, with unit_cost and the spend it implies.
--
--    `spent` is computed here rather than in the browser, so the screen
--    never needs the per-unit figure at all - but unit_cost is returned
--    too, because the tracker shows it.
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
    order by m.movement_id desc;
end;
$$;

revoke execute on function owner_stockin_log(timestamptz, timestamptz) from public;
revoke execute on function owner_stockin_log(timestamptz, timestamptz) from anon;
grant execute on function owner_stockin_log(timestamptz, timestamptz) to authenticated, service_role;


-- 7. One SKU's whole supplier history, aggregated.
--
--    Deliberately not date-filtered, like the query it replaces: this is
--    "from what supplier is that item", over all time. Aggregating in SQL
--    also means the per-row costs never leave the database - the browser
--    only ever sees the totals.
create or replace function owner_stockin_by_supplier(p_sku text)
returns table(
  supplier text,
  units bigint,
  spent numeric,
  batches bigint
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
      coalesce(nullif(m.supplier, ''), 'Unknown')::text as supplier,
      sum(m.quantity)::bigint                           as units,
      coalesce(sum(coalesce(m.unit_cost, 0) * m.quantity), 0)::numeric as spent,
      count(*)::bigint                                  as batches
    from stock_movements m
    where m.sku = p_sku
      and m.movement_type = 'stock_in'
    group by coalesce(nullif(m.supplier, ''), 'Unknown')
    order by units desc;
end;
$$;

revoke execute on function owner_stockin_by_supplier(text) from public;
revoke execute on function owner_stockin_by_supplier(text) from anon;
grant execute on function owner_stockin_by_supplier(text) to authenticated, service_role;

-- =====================================================================
--  Cost and profit are owner-only, enforced here rather than in the UI.
--
--  Owner and staff are both the Postgres role `authenticated` and RLS is
--  row-level, so there is no row-level way to say "this column, but only
--  for one of these two". Column privileges can say "not for this role",
--  which takes the column from the owner too - and that is the point: the
--  owner_* functions above are security definer, run as their own owner,
--  are not subject to column privileges, and check current_user_role()
--  themselves.
--
--  service_role is untouched throughout: the forecast service, the seed
--  scripts and the CSV export routes all hold their privileges separately.
--
--  See sql/migrations/034_lock_cost_columns.sql, and 034_rollback.sql.
-- =====================================================================

revoke select on products from authenticated;
grant select (
  product_id, sku, name, category, brand, vehicle_compat, supplier,
  unit_price, reorder_point, stock_on_hand, is_active, source_type,
  created_at, updated_at
) on products to authenticated;

revoke select on sales from authenticated;
grant select (
  sale_id, sale_ts, user_id, user_role, total_amount, status, voided_ts,
  note, source_type, customer_name, customer_contact, customer_address,
  customer_vehicle_brand
) on sales to authenticated;

revoke select on sale_items from authenticated;
grant select (
  sale_item_id, sale_id, product_id, sku, quantity, unit_price, line_revenue
) on sale_items to authenticated;

revoke select on stock_movements from authenticated;
grant select (
  movement_id, movement_ts, product_id, sku, movement_type, quantity,
  balance_after, user_id, reference, note, supplier
) on stock_movements to authenticated;

-- vw_product_velocity carries gross_profit_90d, so the whole view is
-- owner-only through owner_product_performance() instead.
revoke select on vw_product_velocity from authenticated;

-- The three originals stay for service_role; the app calls their owner_*
-- equivalents.
revoke execute on function sales_kpi_summary() from authenticated;
revoke execute on function dashboard_margin_trend() from authenticated;
revoke execute on function dashboard_gross_net_range(date, date, text) from authenticated;


-- =====================================================================
--  Default privileges.
--
--  Postgres grants EXECUTE on a newly created function to PUBLIC, and
--  Supabase's `anon` role is a member of PUBLIC - so every function above
--  revokes it explicitly. These two lines stop the NEXT function added to
--  this schema from arriving with that grant in the first place, which is
--  the failure the explicit revokes are papering over.
--
--  See sql/migrations/031_fix_audit_batch_1.sql.
-- =====================================================================

alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from public;
