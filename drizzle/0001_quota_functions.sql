-- Custom SQL migration file, put your code below! --
create or replace function reserve_usage(p_reservation_id text, p_organization_id text, p_usage_period_id text, p_conversion_id text, p_units integer default 1)
returns usage_reservations
language plpgsql
set search_path = public, pg_temp
as $$
declare
  reservation usage_reservations%rowtype;
begin
  if p_units <= 0 then
    raise exception 'invalid_usage_units' using errcode = '22023';
  end if;

  select * into reservation
  from usage_reservations
  where organization_id = p_organization_id and conversion_id = p_conversion_id
  for update;

  if found then
    if reservation.usage_period_id <> p_usage_period_id or reservation.units <> p_units then
      raise exception 'usage_reservation_conflict' using errcode = 'P0001';
    end if;
    return reservation;
  end if;

  update usage_periods
  set reserved = reserved + p_units, updated_at = now()
  where id = p_usage_period_id
    and organization_id = p_organization_id
    and reserved + confirmed + p_units <= "limit";

  if not found then
    raise exception 'quota_exceeded' using errcode = 'P0001';
  end if;

  insert into usage_reservations (id, organization_id, usage_period_id, conversion_id, units, status)
  values (p_reservation_id, p_organization_id, p_usage_period_id, p_conversion_id, p_units, 'RESERVED')
  returning * into reservation;

  return reservation;
exception
  when unique_violation then
    select * into reservation
    from usage_reservations
    where organization_id = p_organization_id and conversion_id = p_conversion_id;
    if not found then
      raise;
    end if;
    if reservation.usage_period_id <> p_usage_period_id or reservation.units <> p_units then
      raise exception 'usage_reservation_conflict' using errcode = 'P0001';
    end if;
    return reservation;
end;
$$;
--> statement-breakpoint
create or replace function confirm_usage(p_reservation_id text, p_organization_id text)
returns usage_reservations
language plpgsql
set search_path = public, pg_temp
as $$
declare
  reservation usage_reservations%rowtype;
begin
  select * into reservation
  from usage_reservations
  where id = p_reservation_id and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'usage_reservation_not_found' using errcode = 'P0002';
  end if;
  if reservation.status = 'CONFIRMED' then
    return reservation;
  end if;
  if reservation.status <> 'RESERVED' then
    raise exception 'usage_reservation_already_released' using errcode = 'P0001';
  end if;

  update usage_periods
  set reserved = reserved - reservation.units,
      confirmed = confirmed + reservation.units,
      updated_at = now()
  where id = reservation.usage_period_id and organization_id = reservation.organization_id;

  update usage_reservations
  set status = 'CONFIRMED', confirmed_at = now(), updated_at = now()
  where id = reservation.id
  returning * into reservation;
  return reservation;
end;
$$;
--> statement-breakpoint
create or replace function release_usage(p_reservation_id text, p_organization_id text)
returns usage_reservations
language plpgsql
set search_path = public, pg_temp
as $$
declare
  reservation usage_reservations%rowtype;
begin
  select * into reservation
  from usage_reservations
  where id = p_reservation_id and organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'usage_reservation_not_found' using errcode = 'P0002';
  end if;
  if reservation.status = 'RELEASED' then
    return reservation;
  end if;
  if reservation.status <> 'RESERVED' then
    raise exception 'usage_reservation_already_confirmed' using errcode = 'P0001';
  end if;

  update usage_periods
  set reserved = reserved - reservation.units, updated_at = now()
  where id = reservation.usage_period_id and organization_id = reservation.organization_id;

  update usage_reservations
  set status = 'RELEASED', released_at = now(), updated_at = now()
  where id = reservation.id
  returning * into reservation;
  return reservation;
end;
$$;
