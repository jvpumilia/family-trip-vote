alter table messages add column if not exists reply_to uuid references messages(id) on delete set null;
