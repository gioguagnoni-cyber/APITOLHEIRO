-- Private owner ledger, direct AI configuration and the four requested daily
-- analysis cycles. Browser clients never receive service/provider secrets.

create table public.owner_bankroll_settings (
  owner_scope text primary key default 'primary' check (owner_scope = 'primary'),
  initial_amount numeric(14,2) not null default 0 check (initial_amount >= 0),
  currency text not null default 'BRL' check (currency = 'BRL'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.owner_bankroll_settings (owner_scope, initial_amount)
values ('primary', 0)
on conflict (owner_scope) do nothing;

create table public.owner_bets (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references public.fixtures(id) on delete restrict,
  provider_fixture_id integer not null,
  league_name text not null,
  country_name text,
  kickoff_at timestamptz not null,
  home_team_name text not null,
  away_team_name text not null,
  suggested_side text not null check (suggested_side in ('home', 'away')),
  chosen_side text not null check (chosen_side in ('home', 'away')),
  chosen_team_name text not null,
  stake numeric(14,2) not null check (stake > 0 and stake <= 1000000000),
  offered_odds numeric(8,3) not null check (offered_odds > 1 and offered_odds <= 1000),
  status text not null default 'open' check (status in ('open', 'green', 'red')),
  settled_at timestamptz,
  settlement_note text,
  suggested_probability numeric(5,2) check (suggested_probability between 0 and 100),
  suggested_tier smallint check (suggested_tier between 1 and 4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  profit_loss numeric(14,2) generated always as (
    case status
      when 'green' then round(stake * (offered_odds - 1), 2)
      when 'red' then -stake
      else 0
    end
  ) stored,
  constraint owner_bets_settlement_consistency check (
    (status = 'open' and settled_at is null) or
    (status in ('green', 'red') and settled_at is not null)
  ),
  unique (fixture_id)
);

create index owner_bets_status_created_idx on public.owner_bets (status, created_at desc);
create index owner_bets_kickoff_idx on public.owner_bets (kickoff_at desc);

create table public.owner_bet_events (
  id bigint generated always as identity primary key,
  bet_id uuid not null references public.owner_bets(id) on delete cascade,
  event_type text not null check (event_type in ('created', 'settled', 'corrected')),
  previous_status text check (previous_status is null or previous_status in ('open', 'green', 'red')),
  next_status text not null check (next_status in ('open', 'green', 'red')),
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index owner_bet_events_bet_created_idx on public.owner_bet_events (bet_id, created_at desc);

create table public.owner_access_attempts (
  fingerprint text primary key check (length(fingerprint) = 64),
  attempts smallint not null default 0 check (attempts between 0 and 100),
  window_started_at timestamptz not null default now(),
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);

create trigger owner_bankroll_settings_set_updated_at before update
on public.owner_bankroll_settings for each row execute function public.set_updated_at();

create trigger owner_bets_set_updated_at before update
on public.owner_bets for each row execute function public.set_updated_at();

alter table public.owner_bankroll_settings enable row level security;
alter table public.owner_bets enable row level security;
alter table public.owner_bet_events enable row level security;
alter table public.owner_access_attempts enable row level security;

revoke all on table public.owner_bankroll_settings, public.owner_bets,
  public.owner_bet_events, public.owner_access_attempts from anon, authenticated;
grant all on table public.owner_bankroll_settings, public.owner_bets,
  public.owner_bet_events, public.owner_access_attempts to service_role;
grant usage, select on sequence public.owner_bet_events_id_seq to service_role;

-- Use a dedicated Vault name for owner access. For backward compatibility the
-- initial value is copied from the already-known cron secret, without exposing
-- either value in a migration, repository or SQL result.
do $$
declare
  existing_owner_secret text;
  existing_cron_secret text;
begin
  select decrypted_secret into existing_owner_secret
  from vault.decrypted_secrets where name = 'apitolheiro_owner_secret' limit 1;
  if existing_owner_secret is null then
    select decrypted_secret into existing_cron_secret
    from vault.decrypted_secrets where name = 'apitolheiro_cron_secret' limit 1;
    if existing_cron_secret is null then
      raise exception 'Cron secret must exist before owner access can be configured';
    end if;
    perform vault.create_secret(existing_cron_secret, 'apitolheiro_owner_secret', 'APITOLHEIRO private dashboard owner access');
  end if;
end;
$$;

create or replace function public.get_owner_access_secret()
returns text
language plpgsql
security definer
set search_path = ''
stable
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Worker access is required';
  end if;
  return (
    select decrypted_secret from vault.decrypted_secrets
    where name = 'apitolheiro_owner_secret' limit 1
  );
end;
$$;

revoke all on function public.get_owner_access_secret() from public, anon, authenticated;
grant execute on function public.get_owner_access_secret() to service_role;

-- Disable the e-mail/magic-link owner surface without deleting the historical
-- administrator row. The old RPCs remain for migration compatibility but are
-- no longer callable by browser roles.
revoke all on function public.get_ai_provider_settings() from authenticated;
revoke all on function public.save_ai_provider_credential(text, text, text, boolean, smallint) from authenticated;

alter table public.ai_provider_credentials
  drop constraint if exists ai_provider_credentials_provider_check;
alter table public.ai_provider_credentials
  add constraint ai_provider_credentials_provider_check
  check (provider in ('openai', 'deepseek', 'google', 'grok'));

alter table public.ai_fixture_reviews
  drop constraint if exists ai_fixture_reviews_provider_check;
alter table public.ai_fixture_reviews
  add constraint ai_fixture_reviews_provider_check
  check (provider in ('openai', 'deepseek', 'google', 'grok'));

create or replace function public.get_ai_provider_settings_for_owner()
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  credential public.ai_provider_credentials%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Worker access is required';
  end if;
  select * into credential
  from public.ai_provider_credentials
  order by configured_at desc
  limit 1;
  return jsonb_build_object(
    'configured', credential.provider is not null,
    'provider', credential.provider,
    'model', credential.model,
    'enabled', coalesce(credential.enabled, false),
    'maxReviewsPerRun', coalesce(credential.max_reviews_per_run, 0),
    'configuredAt', credential.configured_at,
    'encryptionReady', private.get_ai_config_key() is not null,
    'keyPresent', credential.encrypted_api_key is not null
  );
end;
$$;

create or replace function public.save_ai_provider_credential_for_owner(
  p_provider text,
  p_api_key text,
  p_model text,
  p_enabled boolean default true,
  p_max_reviews_per_run smallint default 10
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  encryption_key text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Worker access is required';
  end if;
  if p_provider not in ('openai', 'deepseek', 'google', 'grok') then
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
  -- Only one provider is active at a time in the dashboard.
  update public.ai_provider_credentials
  set enabled = false, updated_at = now()
  where provider <> p_provider and enabled;
  return public.get_ai_provider_settings_for_owner();
end;
$$;

revoke all on function public.get_ai_provider_settings_for_owner() from public, anon, authenticated;
grant execute on function public.get_ai_provider_settings_for_owner() to service_role;
revoke all on function public.save_ai_provider_credential_for_owner(text, text, text, boolean, smallint) from public, anon, authenticated;
grant execute on function public.save_ai_provider_credential_for_owner(text, text, text, boolean, smallint) to service_role;

-- Distinguish the same-day refreshes from the 23:00 next-day publication.
alter table public.analysis_runs drop constraint if exists analysis_runs_run_kind_check;
alter table public.analysis_runs add constraint analysis_runs_run_kind_check
  check (run_kind in ('next_day_scan', 'current_day_scan', 'result_settlement'));

-- Publish the new schedule without exposing any owner ledger data.
alter function public.get_public_tipster_dashboard() rename to get_public_tipster_dashboard_v9;
revoke all on function public.get_public_tipster_dashboard_v9() from public, anon, authenticated;

create function public.get_public_tipster_dashboard()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select (payload - array['schemaVersion', 'schedule']) || jsonb_build_object(
    'schemaVersion', 10,
    'schedule', jsonb_build_object(
      'timezone', 'America/Sao_Paulo',
      'analysisTimes', jsonb_build_array('01:00', '11:00', '16:00', '23:00'),
      'nextDayScan', '23:00',
      'sameDayRefreshes', jsonb_build_array('01:00', '11:00', '16:00'),
      'lineupReview', 'automática entre 25 e 0 minutos antes; prioridade em 20 minutos',
      'resultChecks', jsonb_build_array('02:10', '04:10', '08:10')
    )
  )
  from (select public.get_public_tipster_dashboard_v9() as payload) as prior;
$$;

revoke all on function public.get_public_tipster_dashboard() from public;
grant execute on function public.get_public_tipster_dashboard() to anon, service_role;

-- pg_cron uses UTC. Sao Paulo currently uses UTC-3: 01:00=04:00 UTC,
-- 11:00=14:00 UTC, 16:00=19:00 UTC, and 23:00=02:00 UTC next day.
select cron.unschedule(jobid) from cron.job
where jobname in (
  'refresh-apitolheiro-radar',
  'refresh-apitolheiro-next-day-radar',
  'refresh-apitolheiro-0100',
  'refresh-apitolheiro-1100',
  'refresh-apitolheiro-1600',
  'refresh-apitolheiro-2300',
  'refresh-apitolheiro-lineup-review'
);

select cron.schedule(
  'refresh-apitolheiro-0100', '0 4 * * *',
  $$select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'apitolheiro_project_url' limit 1) || '/functions/v1/refresh-radar',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'apitolheiro_cron_secret' limit 1)),
    body := jsonb_build_object('mode','current_day_scan','target_offset_days',0,'scheduled_at',now()),
    timeout_milliseconds := 120000
  );$$
);

select cron.schedule(
  'refresh-apitolheiro-1100', '0 14 * * *',
  $$select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'apitolheiro_project_url' limit 1) || '/functions/v1/refresh-radar',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'apitolheiro_cron_secret' limit 1)),
    body := jsonb_build_object('mode','current_day_scan','target_offset_days',0,'scheduled_at',now()),
    timeout_milliseconds := 120000
  );$$
);

select cron.schedule(
  'refresh-apitolheiro-1600', '0 19 * * *',
  $$select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'apitolheiro_project_url' limit 1) || '/functions/v1/refresh-radar',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'apitolheiro_cron_secret' limit 1)),
    body := jsonb_build_object('mode','current_day_scan','target_offset_days',0,'scheduled_at',now()),
    timeout_milliseconds := 120000
  );$$
);

select cron.schedule(
  'refresh-apitolheiro-2300', '0 2 * * *',
  $$select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'apitolheiro_project_url' limit 1) || '/functions/v1/refresh-radar',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'apitolheiro_cron_secret' limit 1)),
    body := jsonb_build_object('mode','next_day_scan','target_offset_days',1,'scheduled_at',now()),
    timeout_milliseconds := 120000
  );$$
);

-- Two-minute polling does not consume provider quota by itself: the worker
-- returns without an API call unless an eligible fixture is 0-25 minutes away.
select cron.schedule(
  'refresh-apitolheiro-lineup-review', '*/2 * * * *',
  $$select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'apitolheiro_project_url' limit 1) || '/functions/v1/refresh-lineup-review',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'apitolheiro_cron_secret' limit 1)),
    body := jsonb_build_object('scheduled_at',now(),'target_minutes_before',20),
    timeout_milliseconds := 60000
  );$$
);

notify pgrst, 'reload schema';
