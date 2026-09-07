create table if not exists favorites (
  user_id uuid not null references auth.users(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, property_id)
);
alter table favorites enable row level security;
create policy "favorites own read" on favorites for select to authenticated using (user_id = auth.uid());
create policy "favorites own insert" on favorites for insert to authenticated with check (user_id = auth.uid());
create policy "favorites own delete" on favorites for delete to authenticated using (user_id = auth.uid());
