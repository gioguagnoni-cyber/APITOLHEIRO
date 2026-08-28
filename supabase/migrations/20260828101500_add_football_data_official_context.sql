-- football-data.org is an optional server-side corroboration source. Its key
-- must reside in Supabase Vault; this migration deliberately contains no key.

create or replace function public.get_football_data_key()
returns text
language sql
security definer
set search_path = ''
stable
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'apitolheiro_football_data_key'
  limit 1;
$$;

revoke all on function public.get_football_data_key() from public, anon, authenticated;
grant execute on function public.get_football_data_key() to service_role;

-- Preserve the bounded v3 contract internally while extending the public
-- contract without exposing provider cache, request logs, or secrets.
alter function public.get_public_tipster_dashboard() rename to get_public_tipster_dashboard_v3;
revoke all on function public.get_public_tipster_dashboard_v3() from public, anon, authenticated;

create function public.get_public_tipster_dashboard()
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  with prior as (
    select public.get_public_tipster_dashboard_v3() as payload
  ),
  current_analyses as (
    select
      a.metrics,
      a.analyzed_at,
      f.provider_fixture_id
    from public.fixture_analyses as a
    join public.fixtures as f on f.id = a.fixture_id
    where f.kickoff_at >= now() - interval '15 minutes'
  ),
  candidates as (
    select coalesce(
      jsonb_agg(
        candidate || jsonb_build_object(
          'metrics', coalesce(candidate -> 'metrics', '{}'::jsonb) || jsonb_build_object(
            'footballData', analysis.metrics -> 'footballData'
          )
        )
      ),
      '[]'::jsonb
    ) as items
    from prior
    cross join lateral jsonb_array_elements(coalesce(prior.payload -> 'candidates', '[]'::jsonb)) as candidate
    left join current_analyses as analysis
      on analysis.provider_fixture_id = nullif(candidate ->> 'fixtureId', '')::integer
  ),
  football_data_summary as (
    select
      count(*) filter (where metrics -> 'footballData' ->> 'status' = 'confirmado')::integer as verified_analyses,
      count(*) filter (where metrics -> 'footballData' ->> 'status' = 'parcial')::integer as partial_analyses,
      max(nullif(metrics -> 'footballData' ->> 'updatedAt', '')::timestamptz) as updated_at
    from current_analyses
  )
  select
    (prior.payload - 'schemaVersion' - 'candidates') ||
    jsonb_build_object(
      'schemaVersion', 4,
      'footballData', jsonb_build_object(
        'source', 'football-data.org',
        'mode', 'tabela e forma por competição · cache server-side',
        'verifiedAnalyses', football_data_summary.verified_analyses,
        'partialAnalyses', football_data_summary.partial_analyses,
        'updatedAt', football_data_summary.updated_at
      ),
      'candidates', candidates.items
    )
  from prior
  cross join candidates
  cross join football_data_summary;
$$;

revoke all on function public.get_public_tipster_dashboard() from public, anon, authenticated;
grant execute on function public.get_public_tipster_dashboard() to anon, service_role;

notify pgrst, 'reload schema';
