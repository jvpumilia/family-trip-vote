alter table destinations add column if not exists elevation_ft int;
alter table properties add column if not exists elevation_ft int;
update settings set value = value || '{"max_elevation_ft":5000}' where key='trip';
