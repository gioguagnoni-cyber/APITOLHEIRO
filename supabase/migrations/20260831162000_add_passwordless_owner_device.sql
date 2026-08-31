-- Passwordless owner access. A one-time authorization link stores a random
-- device token in the browser; only its SHA-256 hash is stored in Postgres.
create table public.owner_devices (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  label text not null default 'Navegador principal' check (char_length(label) between 1 and 120),
  active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index owner_devices_single_active_idx
on public.owner_devices ((active))
where active;

create trigger owner_devices_set_updated_at before update
on public.owner_devices for each row execute function public.set_updated_at();

alter table public.owner_devices enable row level security;
revoke all on table public.owner_devices from anon, authenticated;
grant all on table public.owner_devices to service_role;
