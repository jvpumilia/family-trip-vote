-- Family Trip Vote: schema
create extension if not exists pgcrypto;

-- Where each family is travelling from
create table if not exists origins (
  key text primary key,
  label text not null,
  airports text not null,
  lat double precision not null,
  lng double precision not null,
  sort int not null default 0
);

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text not null,
  household text not null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists destinations (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  region text not null,          -- e.g. "Pigeon Forge, TN"
  state text not null,
  lat double precision not null,
  lng double precision not null,
  summary text,
  pros jsonb not null default '[]',
  cons jsonb not null default '[]',
  scores jsonb not null default '{}',   -- {lodging:{score,max,why},amenities,travel,kids,nature,overflow,june}
  total int not null default 0,
  gate_pass boolean not null default false,
  travel jsonb not null default '{}',   -- {origin_key:{difficulty,hours,route,nonstop,notes}}
  attractions jsonb not null default '[]',
  source text not null default 'ai',    -- 'packet' | 'ai'
  status text not null default 'scored',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists properties (
  id uuid primary key default gen_random_uuid(),
  destination_id uuid not null references destinations(id) on delete cascade,
  url text,
  source text,                   -- airbnb | vrbo | other
  title text not null,
  city text,
  state text,
  lat double precision,
  lng double precision,
  bedrooms int,
  bathrooms numeric,
  sleeps int,
  price_night numeric,
  price_total numeric,
  image_url text,
  description text,
  rating numeric,
  review_count int,
  notes text,
  details jsonb not null default '{}',
  scores jsonb not null default '{}',
  total int not null default 0,
  gate_pass boolean not null default false,
  ai_summary text,
  red_flags jsonb not null default '[]',
  verify_checklist jsonb not null default '[]',
  submitted_by uuid references auth.users(id) on delete set null,
  is_finalist boolean not null default false,
  status text not null default 'scored',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists properties_destination_idx on properties(destination_id);
create index if not exists properties_submitted_by_idx on properties(submitted_by);

create table if not exists votes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  ranking jsonb not null default '[]',  -- ordered array of property ids
  updated_at timestamptz not null default now()
);

create table if not exists settings (
  key text primary key,
  value jsonb not null
);
insert into settings(key,value) values
  ('trip', '{"title":"Family Trip — June 2027","people":14,"kids":"11, 8, 4 and 2","book_by":"2026-09-30","min_bedrooms":7}'),
  ('voting', '{"open":true,"closes":"2026-09-28T23:59:00-04:00","results_public":false,"max_finalists_per_household":2}')
on conflict (key) do nothing;

-- helpers
create or replace function is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from profiles where id = auth.uid()), false);
$$;
create or replace function my_household() returns text language sql stable security definer set search_path = public as $$
  select household from profiles where id = auth.uid();
$$;

-- finalist cap: each household may flag at most N finalists
create or replace function enforce_finalist_cap() returns trigger language plpgsql security definer set search_path = public as $$
declare
  hh text; n int; capn int;
begin
  if new.is_finalist and (tg_op = 'INSERT' or not old.is_finalist) then
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
drop trigger if exists properties_finalist_cap on properties;
create trigger properties_finalist_cap before insert or update on properties
  for each row execute function enforce_finalist_cap();

-- votes may only reference finalist properties; voting must be open
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
    where p.id is null or not p.is_finalist;
  if bad > 0 then
    raise exception 'not_finalist: ranking contains a property that is not on the ballot.';
  end if;
  new.updated_at = now();
  return new;
end $$;
drop trigger if exists votes_validate on votes;
create trigger votes_validate before insert or update on votes
  for each row execute function validate_vote();

-- RLS
alter table origins enable row level security;
alter table profiles enable row level security;
alter table destinations enable row level security;
alter table properties enable row level security;
alter table votes enable row level security;
alter table settings enable row level security;

create policy "origins read" on origins for select to authenticated using (true);
create policy "settings read" on settings for select to authenticated using (true);
create policy "settings admin write" on settings for all to authenticated using (is_admin()) with check (is_admin());

create policy "profiles read" on profiles for select to authenticated using (true);
create policy "profiles self update" on profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid() and is_admin() = (select is_admin from profiles where id = auth.uid()));

create policy "destinations read" on destinations for select to authenticated using (true);
create policy "destinations admin write" on destinations for all to authenticated using (is_admin()) with check (is_admin());

create policy "properties read" on properties for select to authenticated using (true);
create policy "properties owner update" on properties for update to authenticated
  using (submitted_by = auth.uid() or is_admin()) with check (submitted_by = auth.uid() or is_admin());
create policy "properties owner delete" on properties for delete to authenticated
  using (submitted_by = auth.uid() or is_admin());

create policy "votes read" on votes for select to authenticated using (true);
create policy "votes self insert" on votes for insert to authenticated with check (user_id = auth.uid());
create policy "votes self update" on votes for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "votes self delete" on votes for delete to authenticated using (user_id = auth.uid());

-- Origins: the five places the family is coming from
insert into origins(key,label,airports,lat,lng,sort) values
  ('florida','Southwest Florida','RSW / TPA',26.53,-81.75,1),
  ('gigharbor','Gig Harbor, WA','SEA',47.33,-122.58,2),
  ('nashville','Nashville, TN','BNA',36.16,-86.78,3),
  ('rockford','Rockford, IL','ORD / RFD / MKE',42.27,-89.09,4),
  ('janesville','Janesville, WI','MSN / MKE / ORD',42.68,-89.02,5)
on conflict (key) do nothing;

-- realtime for live updates
do $$ begin
  alter publication supabase_realtime add table properties;
  alter publication supabase_realtime add table destinations;
  alter publication supabase_realtime add table votes;
exception when others then null; end $$;
