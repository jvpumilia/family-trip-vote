-- Nominations: a household can put ANY house on the ballot (its own, an AI pick, or another household's find).
-- A house is on the ballot once no matter how many households nominate it. properties.is_finalist becomes a derived flag.
create table if not exists nominations (
  household text not null,
  property_id uuid not null references properties(id) on delete cascade,
  nominated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (household, property_id)
);
alter table nominations enable row level security;
create policy "nominations read" on nominations for select to authenticated using (true);
create policy "nominations own insert" on nominations for insert to authenticated with check (household = my_household() and nominated_by = auth.uid());
create policy "nominations own delete" on nominations for delete to authenticated using (household = my_household() or is_admin());

create or replace function nominations_guard() returns trigger language plpgsql security definer set search_path = public as $$
declare n int; capn int; p record;
begin
  if nominations_locked() and not is_admin() then raise exception 'nominations_locked: nominations closed; the ballot is set.'; end if;
  select * into p from properties where id = new.property_id;
  if p.id is null then raise exception 'no such house'; end if;
  if p.avail_status = 'unavailable' then raise exception 'disqualified: this house is marked not available for our week.'; end if;
  if p.status <> 'scored' then raise exception 'not_scored: wait for the scoring to finish.'; end if;
  select coalesce((value->>'max_finalists_per_household')::int, 2) into capn from settings where key='voting';
  select count(*) into n from nominations where household = new.household;
  if n >= capn then raise exception 'finalist_cap: your household already has % nominations. Withdraw one first.', capn; end if;
  return new;
end $$;
drop trigger if exists nominations_guard_t on nominations;
create trigger nominations_guard_t before insert on nominations for each row execute function nominations_guard();

create or replace function nominations_delete_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if nominations_locked() and not is_admin() then raise exception 'nominations_locked: nominations closed; the ballot is set.'; end if;
  return old;
end $$;
drop trigger if exists nominations_delete_guard_t on nominations;
create trigger nominations_delete_guard_t before delete on nominations for each row execute function nominations_delete_guard();

-- keep properties.is_finalist in sync (the ballot, vote validation and badges all read it)
create or replace function sync_finalist() returns trigger language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  pid := coalesce(new.property_id, old.property_id);
  update properties set is_finalist = exists (select 1 from nominations where property_id = pid) where id = pid;
  return null;
end $$;
drop trigger if exists nominations_sync_t on nominations;
create trigger nominations_sync_t after insert or delete on nominations for each row execute function sync_finalist();

-- the old per-house finalist trigger no longer owns the cap; it just stamps updated_at and blocks new houses after the lock
create or replace function enforce_finalist_cap() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and nominations_locked() and not is_admin() then
    raise exception 'nominations_locked: nominations closed; the ballot is set.';
  end if;
  new.updated_at = now();
  return new;
end $$;

-- a disqualification withdraws every nomination of that house
create or replace function set_availability(p_id uuid, p_status text, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if p_status not in ('unknown','available','unavailable') then raise exception 'bad status'; end if;
  update properties set avail_status = p_status, avail_note = nullif(trim(coalesce(p_note,'')),''), avail_by = auth.uid(), avail_at = now() where id = p_id;
  if p_status = 'unavailable' then
    delete from nominations where property_id = p_id;
  end if;
end $$;

-- realtime
do $$ begin alter publication supabase_realtime add table nominations; exception when others then null; end $$;
-- settings for the ballot rules (decided by the family; see Admin)
update settings set value = value || '{"vote_weighting":"household","min_ranked":1,"tie_break":"points_then_score"}' where key='voting' and not (value ? 'vote_weighting');
