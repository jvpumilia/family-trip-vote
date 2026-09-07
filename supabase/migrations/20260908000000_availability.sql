-- Availability / disqualification, set by any family member, recorded with who and when.
alter table properties add column if not exists avail_status text not null default 'unknown'; -- unknown | available | unavailable
alter table properties add column if not exists avail_note text;
alter table properties add column if not exists avail_by uuid references auth.users(id) on delete set null;
alter table properties add column if not exists avail_at timestamptz;

update settings set value = value || '{"check_in":null,"check_out":null}' where key='trip' and not (value ? 'check_in');

create or replace function set_availability(p_id uuid, p_status text, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if p_status not in ('unknown','available','unavailable') then raise exception 'bad status'; end if;
  update properties set avail_status = p_status, avail_note = nullif(trim(coalesce(p_note,'')),''), avail_by = auth.uid(), avail_at = now(),
    is_finalist = case when p_status = 'unavailable' then false else is_finalist end
  where id = p_id;
end $$;
grant execute on function set_availability(uuid, text, text) to authenticated;

-- finalist rules: a disqualified house cannot be starred; un-starring because of disqualification is always allowed
create or replace function enforce_finalist_cap() returns trigger language plpgsql security definer set search_path = public as $$
declare
  hh text; n int; capn int;
begin
  if tg_op = 'INSERT' and nominations_locked() then
    raise exception 'nominations_locked: nominations closed; the ballot is set.';
  end if;
  if tg_op = 'UPDATE' and new.is_finalist <> old.is_finalist and nominations_locked() and not (new.avail_status = 'unavailable' and not new.is_finalist) then
    raise exception 'nominations_locked: nominations closed; finalists can no longer change.';
  end if;
  if new.is_finalist and (tg_op = 'INSERT' or not old.is_finalist) then
    if new.avail_status = 'unavailable' then
      raise exception 'disqualified: this house is marked not available for our week.';
    end if;
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

-- ballots may not rank a disqualified house
create or replace function validate_vote() returns trigger language plpgsql security definer set search_path = public as $$
declare
  v jsonb; bad int; closes timestamptz; isopen boolean;
begin
  select value into v from settings where key='voting';
  isopen := coalesce((v->>'open')::boolean, true);
  closes := nullif(v->>'closes','')::timestamptz;
  if not isopen or (closes is not null and now() > closes) then
    raise exception 'voting_closed: voting is closed.';
  end if;
  if jsonb_typeof(new.ranking) <> 'array' then
    raise exception 'bad_ranking';
  end if;
  select count(*) into bad from jsonb_array_elements_text(new.ranking) r
    left join properties p on p.id::text = r
    where p.id is null or not p.is_finalist or p.avail_status = 'unavailable';
  if bad > 0 then
    raise exception 'not_finalist: ranking contains a house that is not on the ballot.';
  end if;
  new.updated_at = now();
  return new;
end $$;
