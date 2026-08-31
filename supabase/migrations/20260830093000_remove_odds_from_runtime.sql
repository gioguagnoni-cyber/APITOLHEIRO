-- Odds are deliberately out of scope for APITOLHEIRO. Clear all operational
-- values and cached provider responses so they cannot re-enter a new analysis,
-- then publish a projection that omits legacy fields from the browser feed.

update public.fixture_analyses
set
  bookmaker = null,
  odds = null,
  implied_probability = null,
  metrics = jsonb_set(
    coalesce(metrics, '{}'::jsonb) - 'market',
    '{sources,apiFootball,endpoints}',
    coalesce(
      (
        select jsonb_agg(endpoint.value)
        from jsonb_array_elements(
          coalesce(metrics #> '{sources,apiFootball,endpoints}', '[]'::jsonb)
        ) as endpoint(value)
        where endpoint.value <> to_jsonb('odds'::text)
      ),
      '[]'::jsonb
    ),
    false
  );

update public.published_analysis_snapshots
set
  bookmaker = null,
  odds = null,
  model_snapshot = jsonb_set(
    coalesce(model_snapshot, '{}'::jsonb) - 'impliedProbability',
    '{metrics}',
    coalesce(model_snapshot -> 'metrics', '{}'::jsonb) - 'market',
    false
  );

delete from public.provider_cache
where provider = 'api-football'
  and cache_key like 'odds|%';

alter function public.get_public_tipster_dashboard() rename to get_public_tipster_dashboard_v8;
revoke all on function public.get_public_tipster_dashboard_v8() from public, anon, authenticated;

create function public.get_public_tipster_dashboard()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with prior as (
    select public.get_public_tipster_dashboard_v8() as payload
  ),
  sanitized_candidates as (
    select coalesce(
      jsonb_agg(
        (
          candidate.value - array['bookmaker', 'odds', 'impliedProbability']
        ) || jsonb_build_object(
          'metrics',
          jsonb_set(
            coalesce(candidate.value -> 'metrics', '{}'::jsonb) - 'market',
            '{sources,apiFootball,endpoints}',
            coalesce(
              (
                select jsonb_agg(endpoint.value)
                from jsonb_array_elements(
                  coalesce(candidate.value #> '{metrics,sources,apiFootball,endpoints}', '[]'::jsonb)
                ) as endpoint(value)
                where endpoint.value <> to_jsonb('odds'::text)
              ),
              '[]'::jsonb
            ),
            false
          )
        )
        order by candidate.ordinality
      ),
      '[]'::jsonb
    ) as items
    from prior
    cross join lateral jsonb_array_elements(coalesce(prior.payload -> 'candidates', '[]'::jsonb))
      with ordinality as candidate(value, ordinality)
  ),
  sanitized_results as (
    select coalesce(
      jsonb_agg(
        (history.value - array['bookmaker', 'odds'])
        order by history.ordinality
      ),
      '[]'::jsonb
    ) as history
    from prior
    cross join lateral jsonb_array_elements(
      coalesce(prior.payload #> '{results,history}', '[]'::jsonb)
    ) with ordinality as history(value, ordinality)
  )
  select (prior.payload - array['schemaVersion', 'candidates', 'results']) || jsonb_build_object(
    'schemaVersion', 9,
    'candidates', sanitized_candidates.items,
    'results', coalesce(prior.payload -> 'results', '{}'::jsonb) || jsonb_build_object(
      'history', sanitized_results.history
    )
  )
  from prior
  cross join sanitized_candidates
  cross join sanitized_results;
$$;

revoke all on function public.get_public_tipster_dashboard() from public;
grant execute on function public.get_public_tipster_dashboard() to anon, service_role;

notify pgrst, 'reload schema';
