-- Only qualified publications can be presented as model Green/Red. Tier 4
-- analyses remain visible in the radar but are not suggestions or results.
alter function public.get_public_tipster_dashboard() rename to get_public_tipster_dashboard_v10;
revoke all on function public.get_public_tipster_dashboard_v10() from public, anon, authenticated;

create function public.get_public_tipster_dashboard()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with prior as (
    select public.get_public_tipster_dashboard_v10() as payload
  ),
  settlement_summary as (
    select
      count(*) filter (where snapshot.settlement_status = 'green')::integer as green_count,
      count(*) filter (where snapshot.settlement_status = 'red')::integer as red_count,
      count(*) filter (where snapshot.settlement_status = 'void')::integer as void_count,
      count(*) filter (where snapshot.settlement_status = 'pending')::integer as pending_count
    from public.published_analysis_snapshots as snapshot
    where snapshot.eligible
  ),
  settlement_history as (
    select coalesce(jsonb_agg(item order by (item ->> 'settledAt')::timestamptz desc), '[]'::jsonb) as items
    from (
      select jsonb_build_object(
        'fixtureId', fixture.provider_fixture_id,
        'kickoff', fixture.kickoff_at,
        'league', competition.name,
        'country', competition.country,
        'homeName', home.name,
        'awayName', away.name,
        'favoriteName', case when snapshot.favorite_side = 'home' then home.name else away.name end,
        'market', snapshot.recommended_market,
        'tier', snapshot.tier,
        'probability', snapshot.probability,
        'settlement', snapshot.settlement_status,
        'rule', snapshot.settlement_rule,
        'homeScore90', snapshot.home_score_90,
        'awayScore90', snapshot.away_score_90,
        'providerStatus', snapshot.provider_status,
        'settledAt', snapshot.settled_at,
        'note', snapshot.settlement_note
      ) as item
      from public.published_analysis_snapshots as snapshot
      join public.fixtures as fixture on fixture.id = snapshot.fixture_id
      join public.competitions as competition on competition.id = fixture.competition_id
      join public.teams as home on home.id = fixture.home_team_id
      join public.teams as away on away.id = fixture.away_team_id
      where snapshot.eligible
        and snapshot.settlement_status in ('green', 'red', 'void')
      order by snapshot.settled_at desc
      limit 30
    ) as history
  )
  select (prior.payload - array['schemaVersion', 'results']) || jsonb_build_object(
    'schemaVersion', 11,
    'results', jsonb_build_object(
      'greenCount', settlement_summary.green_count,
      'redCount', settlement_summary.red_count,
      'voidCount', settlement_summary.void_count,
      'pendingCount', settlement_summary.pending_count,
      'history', settlement_history.items
    )
  )
  from prior
  cross join settlement_summary
  cross join settlement_history;
$$;

revoke all on function public.get_public_tipster_dashboard() from public;
grant execute on function public.get_public_tipster_dashboard() to anon, service_role;

notify pgrst, 'reload schema';
