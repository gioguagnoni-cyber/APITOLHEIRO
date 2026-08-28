-- Keep the existing feed bounded and append only display-safe publication and
-- settlement data. Provider payloads, audit errors and configuration remain
-- server-only.
alter function public.get_public_tipster_dashboard() rename to get_public_tipster_dashboard_v4;
revoke all on function public.get_public_tipster_dashboard_v4() from public, anon, authenticated;

create function public.get_public_tipster_dashboard()
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  with prior as (
    select public.get_public_tipster_dashboard_v4() as payload
  ),
  publication as (
    select
      run.target_date,
      run.status,
      run.started_at,
      run.completed_at,
      run.fixtures_detected,
      run.analyses_published
    from public.analysis_runs as run
    where run.run_kind = 'next_day_scan'
    order by run.started_at desc
    limit 1
  ),
  settlement_summary as (
    select
      count(*) filter (where snapshot.settlement_status = 'green')::integer as green_count,
      count(*) filter (where snapshot.settlement_status = 'red')::integer as red_count,
      count(*) filter (where snapshot.settlement_status = 'void')::integer as void_count,
      count(*) filter (where snapshot.settlement_status = 'pending')::integer as pending_count
    from public.published_analysis_snapshots as snapshot
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
        'odds', snapshot.odds,
        'bookmaker', snapshot.bookmaker,
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
      where snapshot.settlement_status in ('green', 'red', 'void')
      order by snapshot.settled_at desc
      limit 18
    ) as history
  )
  select (prior.payload - 'schemaVersion') || jsonb_build_object(
    'schemaVersion', 5,
    'schedule', jsonb_build_object(
      'timezone', 'America/Sao_Paulo',
      'nextDayScan', '23:30',
      'resultChecks', jsonb_build_array('02:10', '04:10', '08:10'),
      'settlementRule', 'Vitória mandante/visitante: 90 minutos + acréscimos; prorrogação e pênaltis não contam.'
    ),
    'publication', jsonb_build_object(
      'targetDate', publication.target_date,
      'status', publication.status,
      'startedAt', publication.started_at,
      'completedAt', publication.completed_at,
      'fixturesDetected', publication.fixtures_detected,
      'analysesPublished', publication.analyses_published
    ),
    'results', jsonb_build_object(
      'greenCount', settlement_summary.green_count,
      'redCount', settlement_summary.red_count,
      'voidCount', settlement_summary.void_count,
      'pendingCount', settlement_summary.pending_count,
      'history', settlement_history.items
    )
  )
  from prior
  left join publication on true
  cross join settlement_summary
  cross join settlement_history;
$$;

revoke all on function public.get_public_tipster_dashboard() from public, anon, authenticated;
grant execute on function public.get_public_tipster_dashboard() to anon, service_role;
notify pgrst, 'reload schema';
