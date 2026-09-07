-- Date windows members find on a host's calendar, per house.
create table if not exists availability (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  status text not null check (status in ('available','booked')),
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);
create index if not exists availability_property_idx on availability(property_id);
alter table availability enable row level security;
create policy "availability read" on availability for select to authenticated using (true);
create policy "availability insert" on availability for insert to authenticated with check (created_by = auth.uid());
create policy "availability delete own" on availability for delete to authenticated using (created_by = auth.uid() or is_admin());
do $$ begin
  alter publication supabase_realtime add table availability;
exception when others then null; end $$;
update settings set value = value || '{"season_start":"2027-05-01","season_end":"2027-08-20"}' where key='trip';
