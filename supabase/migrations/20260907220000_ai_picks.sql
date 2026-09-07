-- System ("AI") recommendations live in the same properties table, with no submitter.
alter table properties add column if not exists ai_pick boolean not null default false;
alter table properties add column if not exists ai_note text;
alter table properties add column if not exists adopted_from uuid references properties(id) on delete set null;
create index if not exists properties_url_idx on properties(url);

-- a house with no household behind it can never be a finalist; adopt it first
create or replace function enforce_finalist_cap() returns trigger language plpgsql security definer set search_path = public as $$
declare
  hh text; n int; capn int;
begin
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

insert into settings(key,value) values ('ai_recs', '{"intro":"","top":[],"updated_at":null}') on conflict (key) do nothing;
