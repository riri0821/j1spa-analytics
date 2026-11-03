-- =====================================================================
--  Adds the Services feature: manual-entry service records (service
--  type + total + the same optional customer fields as Sales Entry),
--  separate from sales/inventory. Backs the new "Services" tab on the
--  Sales page, and is also included in the Sales Tracker tab.
--
--  ADDITIVE ONLY - safe to run against real data. Run in a NEW SQL
--  Editor query tab, after the two customer-fields migrations. Mirrors
--  sql/supabase_schema.sql, which stays the source of truth for a
--  from-scratch setup - keep them in sync if you change either.
-- =====================================================================

create table if not exists services (
  service_id    bigint generated always as identity primary key,
  service_ts    timestamptz not null default now(),
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
create index if not exists ix_services_ts on services (service_ts);

alter table services enable row level security;

drop policy if exists "services_select" on services;
create policy "services_select" on services for select
  using (auth.role() = 'authenticated');

drop policy if exists "services_insert" on services;
create policy "services_insert" on services for insert
  with check (auth.role() = 'authenticated');

drop policy if exists "services_owner_write" on services;
create policy "services_owner_write" on services for update
  using (current_user_role() = 'owner');

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
grant execute on function record_service(text, numeric, text, text, text, text) to authenticated;

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

  if v_role <> 'owner' and (
    v_service.user_id is distinct from v_uid or v_service.service_ts::date <> current_date
  ) then
    raise exception 'Not allowed to undo this service record.';
  end if;

  update services set status = 'voided', voided_ts = now() where service_id = p_service_id;

  return jsonb_build_object('ok', true, 'service_id', p_service_id);
end;
$$;

revoke execute on function undo_service(bigint) from public;
grant execute on function undo_service(bigint) to authenticated;
