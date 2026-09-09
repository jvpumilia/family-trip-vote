-- Dates poll: each person marks each Sat-to-Sat week as can't / could / prefer.
create table if not exists week_votes (
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  choice text not null check (choice in ('no','ok','prefer')),
  updated_at timestamptz not null default now(),
  primary key (user_id, week_start)
);
alter table week_votes enable row level security;
create policy "week_votes read" on week_votes for select to authenticated using (true);
create policy "week_votes own upsert" on week_votes for insert to authenticated with check (user_id = auth.uid());
create policy "week_votes own update" on week_votes for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "week_votes own delete" on week_votes for delete to authenticated using (user_id = auth.uid());
do $$ begin alter publication supabase_realtime add table week_votes; exception when others then null; end $$;
