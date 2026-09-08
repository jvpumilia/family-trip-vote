alter table messages add column if not exists mentions uuid[] not null default '{}';
alter table profiles add column if not exists chat_read_at timestamptz;
create index if not exists messages_mentions_idx on messages using gin (mentions);
