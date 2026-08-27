-- APITOLHEIRO v1: server-owned operational data.
-- Remote migration history version: 20260827195018.
-- No provider credential is persisted here. The service role is used only in server routes.

create extension if not exists pgcrypto;

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  provider_team_id integer not null unique,
  name text not null,
  logo_url text,
  country text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.competitions (
  id uuid primary key default gen_random_uuid(),
  provider_league_id integer not null,
  season integer not null,
  name text not null,
  country text,
  logo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_league_id, season)
);

create table public.fixtures (
  id uuid primary key default gen_random_uuid(),
  provider_fixture_id integer not null unique,
  competition_id uuid not null references public.competitions(id) on delete restrict,
  home_team_id uuid not null references public.teams(id) on delete restrict,
  away_team_id uuid not null references public.teams(id) on delete restrict,
  kickoff_at timestamptz not null,
  status_short text not null,
  status_long text not null,
  venue_name text,
  home_goals smallint,
  away_goals smallint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (home_team_id <> away_team_id)
);

create table public.fixture_analyses (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null unique references public.fixtures(id) on delete cascade,
  model_version text not null,
  probability numeric(5,2) not null check (probability >= 0 and probability <= 100),
  confidence numeric(4,2) not null check (confidence >= 0 and confidence <= 1),
  model_score numeric(5,2) not null check (model_score >= 0 and model_score <= 100),
  tier smallint not null check (tier between 1 and 4),
  eligible boolean not null default false,
  favorite_side text not null check (favorite_side in ('home', 'away')),
  recommended_market text not null,
  bookmaker text,
  odds numeric(6,3) check (odds is null or odds > 1),
  implied_probability numeric(5,2) check (implied_probability is null or (implied_probability >= 0 and implied_probability <= 100)),
  metrics jsonb not null default '{}'::jsonb,
  reasons jsonb not null default '[]'::jsonb,
  caveats jsonb not null default '[]'::jsonb,
  analyzed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.provider_cache (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  cache_key text not null,
  payload jsonb not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, cache_key),
  check (expires_at > fetched_at)
);

create table public.api_usage_daily (
  provider text not null,
  usage_date date not null,
  requests_made integer not null default 0 check (requests_made >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, usage_date)
);

create table public.ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  run_type text not null,
  status text not null check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null,
  completed_at timestamptz,
  records_written integer not null default 0 check (records_written >= 0),
  error_message text,
  created_at timestamptz not null default now(),
  check ((status = 'running' and completed_at is null) or (status in ('completed', 'failed') and completed_at is not null))
);

create index fixtures_kickoff_at_idx on public.fixtures (kickoff_at);
create index fixture_analyses_dashboard_idx on public.fixture_analyses (eligible desc, probability desc, analyzed_at desc);
create index provider_cache_expiry_idx on public.provider_cache (expires_at);
create index ingestion_runs_recent_idx on public.ingestion_runs (started_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger teams_set_updated_at before update on public.teams
for each row execute function public.set_updated_at();
create trigger competitions_set_updated_at before update on public.competitions
for each row execute function public.set_updated_at();
create trigger fixtures_set_updated_at before update on public.fixtures
for each row execute function public.set_updated_at();
create trigger fixture_analyses_set_updated_at before update on public.fixture_analyses
for each row execute function public.set_updated_at();
create trigger provider_cache_set_updated_at before update on public.provider_cache
for each row execute function public.set_updated_at();
create trigger api_usage_daily_set_updated_at before update on public.api_usage_daily
for each row execute function public.set_updated_at();

-- Atomically reserve a request before an external API call.
-- It is intentionally callable only by the server's service role.
create or replace function public.reserve_api_quota(
  p_provider text,
  p_usage_date date,
  p_limit integer,
  p_count integer default 1
)
returns table(allowed boolean, requests_made integer, remaining integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_requests integer;
begin
  if p_provider !~ '^[a-z0-9-]{1,64}$' or p_limit < 1 or p_limit > 100 or p_count < 1 or p_count > 10 then
    raise exception 'Invalid quota reservation';
  end if;

  insert into public.api_usage_daily as usage (provider, usage_date, requests_made)
  values (p_provider, p_usage_date, p_count)
  on conflict (provider, usage_date) do update
    set requests_made = usage.requests_made + excluded.requests_made,
        updated_at = now()
    where usage.requests_made + excluded.requests_made <= p_limit
  returning requests_made into current_requests;

  if found then
    return query select true, current_requests, greatest(p_limit - current_requests, 0);
    return;
  end if;

  select usage.requests_made
    into current_requests
    from public.api_usage_daily as usage
   where usage.provider = p_provider
     and usage.usage_date = p_usage_date;

  return query select false, coalesce(current_requests, 0), greatest(p_limit - coalesce(current_requests, 0), 0);
end;
$$;

revoke all on function public.reserve_api_quota(text, date, integer, integer) from public, anon, authenticated;
grant execute on function public.reserve_api_quota(text, date, integer, integer) to service_role;

alter table public.teams enable row level security;
alter table public.competitions enable row level security;
alter table public.fixtures enable row level security;
alter table public.fixture_analyses enable row level security;
alter table public.provider_cache enable row level security;
alter table public.api_usage_daily enable row level security;
alter table public.ingestion_runs enable row level security;

revoke all on table public.teams from anon, authenticated;
revoke all on table public.competitions from anon, authenticated;
revoke all on table public.fixtures from anon, authenticated;
revoke all on table public.fixture_analyses from anon, authenticated;
revoke all on table public.provider_cache from anon, authenticated;
revoke all on table public.api_usage_daily from anon, authenticated;
revoke all on table public.ingestion_runs from anon, authenticated;

grant all on table public.teams, public.competitions, public.fixtures, public.fixture_analyses,
  public.provider_cache, public.api_usage_daily, public.ingestion_runs to service_role;
