-- Nominations (new houses, finalist stars, adoptions) lock a week before voting closes.
update settings set value = value || '{"nominations_close":"2026-09-21T23:59:00-04:00"}' where key='voting' and not (value ? 'nominations_close');

create or replace function nominations_locked() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(now() > nullif(value->>'nominations_close','')::timestamptz, false) from settings where key='voting';
$$;

create or replace function enforce_finalist_cap() returns trigger language plpgsql security definer set search_path = public as $$
declare
  hh text; n int; capn int;
begin
  if tg_op = 'INSERT' and nominations_locked() then
    raise exception 'nominations_locked: nominations closed; the ballot is set.';
  end if;
  if tg_op = 'UPDATE' and new.is_finalist <> old.is_finalist and nominations_locked() then
    raise exception 'nominations_locked: nominations closed; finalists can no longer change.';
  end if;
  if new.is_finalist and (tg_op = 'INSERT' or not old.is_finalist) then
    if new.submitted_by is null then
      raise exception 'no_household: a recommendation has to be adopted by a household before it can be a finalist.';
    end if;
    select household into hh from profiles where id = new.submitted_by;
    select coalesce((value->>'max_finalists_per_household')::int, 2) into capn from settings where key='voting';
    select count(*) into n from properties p join profiles pr on pr.id = p.submitted_by
      where p.is_finalist and pr.household = hh and p.id <> new.id;
    if n >= capn then
      raise exception 'finalist_cap: your household already has % finalists. Un-star one first.', capn;
    end if;
  end if;
  new.updated_at = now();
  return new;
end $$;

-- deleting a finalist after the lock would also change the ballot
create or replace function block_finalist_delete() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.is_finalist and nominations_locked() and not is_admin() then
    raise exception 'nominations_locked: nominations closed; a finalist cannot be removed.';
  end if;
  return old;
end $$;
drop trigger if exists properties_finalist_delete on properties;
create trigger properties_finalist_delete before delete on properties for each row execute function block_finalist_delete();
