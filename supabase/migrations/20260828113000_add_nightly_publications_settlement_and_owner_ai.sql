-- Nightly publication is deliberately separate from the mutable current analysis.
-- A published row is never overwritten: Green/Red always refers to the original
-- pre-match recommendation, not to a later refresh of the model.

create table public.analysis_runs (
  id uuid primary key default gen_random_uuid(),
  target_date date not null,
  run_kind text not null check (run_kind in ('next_day_scan', 'result_settlement')),
  status text not null check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  fixtures_detected integer not null default 0 check (fixtures_detected >= 0),
  analyses_published integer not null default 0 check (analyses_published >= 0),
  error_message text,
  created_at timestamptz not null default now(),
  check ((status = 'running' and completed_at is null) or (status in ('completed', 'failed') and completed_at is not null))
);

create table public.published_analysis_snapshots (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid references public.analysis_runs(id) on delete set null,
  fixture_id uuid not null references public.fixtures(id) on delete cascade,
  target_date date not null,
  market_code text not null default 'match_winner_90'
    check (market_code in ('match_winner_90')),
  favorite_side text not null check (favorite_side in ('home', 'away')),
  recommended_market text not null,
  model_version text not null,
  probability numeric(5,2) not null check (probability between 0 and 100),
  confidence numeric(4,2) not null check (confidence between 0 and 1),
  tier smallint not null check (tier between 1 and 4),
  eligible boolean not null,
  odds numeric(6,3) check (odds is null or odds > 1),
  bookmaker text,
  model_snapshot jsonb not null,
  published_at timestamptz not null default now(),
  settlement_status text not null default 'pending'
    check (settlement_status in ('pending', 'green', 'red', 'void')),
  settlement_rule text not null default '90_minutos_acrescimos'
    check (settlement_rule = '90_minutos_acrescimos'),
  home_score_90 smallint,
  away_score_90 smallint,
  provider_status text,
  settled_at timestamptz,
  settlement_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (fixture_id, target_date, market_code),
  check (
    (settlement_status = 'pending' and settled_at is null)
    or (settlement_status in ('green', 'red', 'void') and settled_at is not null)
  )
);

create index analysis_runs_target_recent_idx
  on public.analysis_runs (target_date desc, started_at desc);
create index published_analysis_snapshots_pending_idx
  on public.published_analysis_snapshots (target_date, settlement_status)
  where settlement_status = 'pending';
create index published_analysis_snapshots_history_idx
  on public.published_analysis_snapshots (settled_at desc)
  where settlement_status in ('green', 'red', 'void');

create trigger published_analysis_snapshots_set_updated_at before update
on public.published_analysis_snapshots for each row execute function public.set_updated_at();

-- Owner-only AI configuration. The account e-mail was explicitly provided by
-- the owner; it is never returned by any public RPC. Provider keys are encrypted
-- inside Postgres with a Vault-held master key and cannot be selected by clients.
create table public.dashboard_admins (
  email text primary key check (email = lower(email)),
  created_at timestamptz not null default now()
);
insert into public.dashboard_admins (email) values ('gioguagnoni@gmail.com')
on conflict (email) do nothing;

create table public.ai_provider_credentials (
  provider text primary key check (provider in ('openai', 'deepseek', 'google')),
  encrypted_api_key bytea not null,
  model text not null check (length(model) between 1 and 160),
  enabled boolean not null default false,
  max_reviews_per_run smallint not null default 0 check (max_reviews_per_run between 0 and 80),
  configured_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ai_fixture_reviews (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references public.fixtures(id) on delete cascade,
  publication_id uuid references public.published_analysis_snapshots(id) on delete cascade,
  provider text not null check (provider in ('openai', 'deepseek', 'google')),
  model text not null,
  status text not null check (status in ('completed', 'unavailable', 'failed')),
  review jsonb,
  score_delta numeric(4,3) check (score_delta between -0.02 and 0.02),
  latency_ms integer check (latency_ms >= 0),
  created_at timestamptz not null default now()
);
create index ai_fixture_reviews_publication_idx on public.ai_fixture_reviews (publication_id, created_at desc);

create schema if not exists private;
revoke all on schema private from public;

create or replace function private.is_dashboard_admin()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.dashboard_admins as admin
    where admin.email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function private.get_ai_config_key()
returns text
language sql
security definer
set search_path = ''
stable
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'apitolheiro_ai_config_key'
  limit 1;
$$;

create or replace function public.get_ai_provider_settings()
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  credential public.ai_provider_credentials%rowtype;
begin
  if not private.is_dashboard_admin() then
    return jsonb_build_object('isAdmin', false);
  end if;

  select * into credential
  from public.ai_provider_credentials
  order by configured_at desc
  limit 1;

  return jsonb_build_object(
    'isAdmin', true,
    'configured', credential.provider is not null,
    'provider', credential.provider,
    'model', credential.model,
    'enabled', coalesce(credential.enabled, false),
    'maxReviewsPerRun', coalesce(credential.max_reviews_per_run, 0),
    'configuredAt', credential.configured_at,
    'encryptionReady', private.get_ai_config_key() is not null
  );
end;
$$;

create or replace function public.save_ai_provider_credential(
  p_provider text,
  p_api_key text,
  p_model text,
  p_enabled boolean default false,
  p_max_reviews_per_run smallint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  encryption_key text;
begin
  if not private.is_dashboard_admin() then
    raise exception 'Owner access is required';
  end if;
  if p_provider not in ('openai', 'deepseek', 'google') then
    raise exception 'Unsupported AI provider';
  end if;
  if length(trim(coalesce(p_api_key, ''))) < 12 or length(p_api_key) > 4096 then
    raise exception 'Invalid AI API key';
  end if;
  if length(trim(coalesce(p_model, ''))) not between 1 and 160 then
    raise exception 'Invalid AI model';
  end if;
  if p_max_reviews_per_run not between 0 and 80 then
    raise exception 'Invalid review limit';
  end if;

  encryption_key := private.get_ai_config_key();
  if encryption_key is null then
    raise exception 'AI encryption key is not configured';
  end if;

  insert into public.ai_provider_credentials as credential (
    provider, encrypted_api_key, model, enabled, max_reviews_per_run, configured_at, updated_at
  ) values (
    p_provider,
    pgp_sym_encrypt(p_api_key, encryption_key, 'cipher-algo=aes256,compress-algo=1'),
    trim(p_model), p_enabled, p_max_reviews_per_run, now(), now()
  ) on conflict (provider) do update set
    encrypted_api_key = excluded.encrypted_api_key,
    model = excluded.model,
    enabled = excluded.enabled,
    max_reviews_per_run = excluded.max_reviews_per_run,
    configured_at = now(),
    updated_at = now();

  return public.get_ai_provider_settings();
end;
$$;

create or replace function public.get_ai_provider_credential_for_worker()
returns table(provider text, api_key text, model text, enabled boolean, max_reviews_per_run smallint)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  encryption_key text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Worker access is required';
  end if;
  encryption_key := private.get_ai_config_key();
  if encryption_key is null then return; end if;
  return query
    select credential.provider,
           pgp_sym_decrypt(credential.encrypted_api_key, encryption_key),
           credential.model,
           credential.enabled,
           credential.max_reviews_per_run
    from public.ai_provider_credentials as credential
    where credential.enabled
    order by credential.configured_at desc
    limit 1;
end;
$$;

revoke all on function private.is_dashboard_admin() from public, anon, authenticated;
revoke all on function private.get_ai_config_key() from public, anon, authenticated;
revoke all on function public.get_ai_provider_settings() from public, anon;
grant execute on function public.get_ai_provider_settings() to authenticated, service_role;
revoke all on function public.save_ai_provider_credential(text, text, text, boolean, smallint) from public, anon;
grant execute on function public.save_ai_provider_credential(text, text, text, boolean, smallint) to authenticated;
revoke all on function public.get_ai_provider_credential_for_worker() from public, anon, authenticated;
grant execute on function public.get_ai_provider_credential_for_worker() to service_role;

alter table public.analysis_runs enable row level security;
alter table public.published_analysis_snapshots enable row level security;
alter table public.dashboard_admins enable row level security;
alter table public.ai_provider_credentials enable row level security;
alter table public.ai_fixture_reviews enable row level security;
revoke all on table public.analysis_runs, public.published_analysis_snapshots, public.dashboard_admins,
  public.ai_provider_credentials, public.ai_fixture_reviews from anon, authenticated;
grant all on table public.analysis_runs, public.published_analysis_snapshots, public.dashboard_admins,
  public.ai_provider_credentials, public.ai_fixture_reviews to service_role;

-- Cron uses UTC. 02:30 UTC is 23:30 of the preceding day in America/Sao_Paulo.
select cron.unschedule(jobid) from cron.job where jobname = 'refresh-apitolheiro-radar';
select cron.unschedule(jobid) from cron.job where jobname = 'settle-apitolheiro-published-bets';

select cron.schedule(
  'refresh-apitolheiro-next-day-radar',
  '30 2 * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'apitolheiro_project_url' limit 1)
        || '/functions/v1/refresh-radar',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'apitolheiro_cron_secret' limit 1)
      ),
      body := jsonb_build_object('mode', 'next_day_scan', 'scheduled_at', now()),
      timeout_milliseconds := 120000
    );
  $$
);

-- First check is 02:10 BRT. Two later retries deal with late North-American
-- fixtures and delayed provider settlement without polling throughout the day.
select cron.schedule(
  'settle-apitolheiro-published-bets',
  '10 5,7,11 * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'apitolheiro_project_url' limit 1)
        || '/functions/v1/settle-published-bets',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'apitolheiro_cron_secret' limit 1)
      ),
      body := jsonb_build_object('scheduled_at', now()),
      timeout_milliseconds := 60000
    );
  $$
);

notify pgrst, 'reload schema';
