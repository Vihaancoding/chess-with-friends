-- Run once in Supabase: SQL Editor -> New query -> paste -> Run
create table if not exists kv (
  key text primary key,
  value jsonb not null,
  expires_at timestamptz
);

-- Lock the table: only the server (service_role key) can touch it.
alter table kv enable row level security;
