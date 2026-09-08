create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  body text not null check (length(body) between 1 and 4000),
  property_id uuid references properties(id) on delete set null,
  destination_id uuid references destinations(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists messages_created_idx on messages(created_at);
create index if not exists messages_property_idx on messages(property_id);
alter table messages enable row level security;
create policy "messages read" on messages for select to authenticated using (true);
create policy "messages insert own" on messages for insert to authenticated with check (user_id = auth.uid());
create policy "messages delete own" on messages for delete to authenticated using (user_id = auth.uid() or is_admin());
do $$ begin alter publication supabase_realtime add table messages; exception when others then null; end $$;
