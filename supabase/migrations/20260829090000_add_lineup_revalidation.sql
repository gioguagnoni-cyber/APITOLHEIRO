-- Pre-kickoff lineup revalidation is append-only.  The original publication
-- remains immutable in published_analysis_snapshots; this log records every
-- later provider check and any conservative model adjustment it caused.

create table public.fixture_lineup_reviews (
  id uuid primary key default gen_random_uuid(),
  fixture_id uuid not null references public.fixtures(id) on delete cascade,
  review_status text not null check (review_status in (
    'awaiting_lineup', 'confirmed', 'unchanged', 'downgraded', 'suspended', 'unavailable'
  )),
  provider text not null default 'api-football' check (provider = 'api-football'),
  official_lineup jsonb not null default '{}'::jsonb,
  lineup_fingerprint text,
  previous_fingerprint text,
  changes jsonb not null default '[]'::jsonb,
  probability_before numeric(5,2) check (probability_before between 0 and 100),
  probability_after numeric(5,2) check (probability_after between 0 and 100),
  probability_delta numeric(5,2) check (probability_delta between -100 and 100),
  analysis_before jsonb not null default '{}'::jsonb,
  analysis_after jsonb not null default '{}'::jsonb,
  source_fetched_at timestamptz not null default now(),
  reviewed_at timestamptz not null default now(),
  note text,
  created_at timestamptz not null default now()
);

create index fixture_lineup_reviews_fixture_reviewed_idx
  on public.fixture_lineup_reviews (fixture_id, reviewed_at desc);

alter table public.fixture_lineup_reviews enable row level security;
revoke all on table public.fixture_lineup_reviews from anon, authenticated;
grant all on table public.fixture_lineup_reviews to service_role;

-- The public feed exposes only the factual lineup summary and decision status,
-- never credentials, provider-cache rows, or the private review log itself.
alter function public.get_public_tipster_dashboard() rename to get_public_tipster_dashboard_v7;
revoke all on function public.get_public_tipster_dashboard_v7() from public, anon, authenticated;

create function public.get_public_tipster_dashboard()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with prior as (
    select public.get_public_tipster_dashboard_v7() as payload
  ),
  reviewed_candidates as (
    select coalesce(
      jsonb_agg(
        (
          case candidate #>> '{metrics,lineup,lineupReview,status}'
          when 'suspended' then
            jsonb_set(
              jsonb_set(
                jsonb_set(
                  jsonb_set(candidate, '{classification}', to_jsonb('lineup_suspended'::text)),
                  '{classificationLabel}', to_jsonb('Sugestão suspensa: a reconsulta pré-jogo identificou alteração material na escalação oficial e reduziu a estimativa.'::text)
                ),
                '{eligible}', 'false'::jsonb
              ),
              '{tier}', '4'::jsonb
            )
          when 'downgraded' then
            jsonb_set(
              jsonb_set(
                jsonb_set(candidate, '{classification}', to_jsonb('lineup_downgraded'::text)),
                '{classificationLabel}', to_jsonb('Probabilidade reduzida após reconsulta da escalação oficial; confira a variação antes de qualquer decisão.'::text)
              ),
              '{eligible}', 'false'::jsonb
            )
          else candidate
          end
        ) || jsonb_build_object(
          'metrics', coalesce(candidate -> 'metrics', '{}'::jsonb) || jsonb_build_object(
            'table', a.metrics -> 'table',
            'market', a.metrics -> 'market',
            'prediction', a.metrics -> 'prediction',
            'injuries', a.metrics -> 'injuries',
            'sources', a.metrics -> 'sources'
          )
        )
        order by (candidate ->> 'eligible')::boolean desc,
                 (candidate ->> 'tier')::smallint asc,
                 (candidate ->> 'probability')::numeric desc
      ),
      '[]'::jsonb
    ) as candidates
    from prior
    cross join lateral jsonb_array_elements(coalesce(prior.payload -> 'candidates', '[]'::jsonb)) as candidate
    left join public.fixtures as f
      on f.provider_fixture_id = nullif(candidate ->> 'fixtureId', '')::integer
    left join public.fixture_analyses as a
      on a.fixture_id = f.id
  )
  select (prior.payload - array['schemaVersion', 'candidates']) || jsonb_build_object(
    'schemaVersion', 8,
    'candidates', reviewed_candidates.candidates
  )
  from prior
  cross join reviewed_candidates;
$$;

revoke all on function public.get_public_tipster_dashboard() from public;
grant execute on function public.get_public_tipster_dashboard() to anon, service_role;

-- The function itself limits checks to suggested fixtures in the official
-- lineup window and uses the shared API quota ledger.  The cron merely invokes
-- it; it carries no provider key in SQL or in the public dashboard.
select cron.unschedule(jobid)
from cron.job
where jobname = 'refresh-apitolheiro-lineup-review';

select cron.schedule(
  'refresh-apitolheiro-lineup-review',
  '*/10 * * * *',
  $$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'apitolheiro_project_url'
        limit 1
      ) || '/functions/v1/refresh-lineup-review',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'apitolheiro_cron_secret'
          limit 1
        )
      ),
      body := jsonb_build_object('scheduled_at', now()),
      timeout_milliseconds := 60000
    );
  $$
);

notify pgrst, 'reload schema';
