-- Which houses each person has opened; anything newer than their account and not here shows a "New" badge.
create table if not exists seen_properties (
  user_id uuid not null references auth.users(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  seen_at timestamptz not null default now(),
  primary key (user_id, property_id)
);
alter table seen_properties enable row level security;
create policy "seen own read" on seen_properties for select to authenticated using (user_id = auth.uid());
create policy "seen own insert" on seen_properties for insert to authenticated with check (user_id = auth.uid());
