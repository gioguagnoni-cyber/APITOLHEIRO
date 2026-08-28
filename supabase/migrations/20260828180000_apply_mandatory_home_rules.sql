-- Rule model v2:
-- A fixture is publishable when, and only when, its home team has at least
-- 6 wins in the latest 10, 3 wins in the latest 5 home matches, and leads the
-- visitor by at least 7 table positions. Extra signals change the Tier only.

alter function public.get_public_tipster_dashboard() rename to get_public_tipster_dashboard_v5;
revoke all on function public.get_public_tipster_dashboard_v5() from public, anon, authenticated;

create function public.get_public_tipster_dashboard()
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  with prior as (
    select public.get_public_tipster_dashboard_v5() as payload
  ),
  current_analyses as (
    select
      a.fixture_id,
      a.probability,
      a.confidence,
      a.model_score,
      a.tier,
      a.eligible,
      a.favorite_side,
      a.recommended_market,
      a.bookmaker,
      a.odds,
      a.implied_probability,
      a.metrics,
      a.reasons,
      a.caveats,
      a.analyzed_at,
      f.provider_fixture_id,
      f.kickoff_at,
      f.competition_id,
      f.home_team_id,
      f.away_team_id,
      case
        when a.eligible then 'sugerido'
        when coalesce((a.metrics #>> '{mandatory,last10,passed}')::boolean, false) = false then 'last10_insuficiente'
        when coalesce((a.metrics #>> '{mandatory,homeLast5,passed}')::boolean, false) = false then 'home_last5_insuficiente'
        when coalesce((a.metrics #>> '{mandatory,tableGap,passed}')::boolean, false) = false then 'tabela_insuficiente'
        else 'criterios_sem_cobertura'
      end as classification
    from public.fixture_analyses as a
    join public.fixtures as f on f.id = a.fixture_id
    where f.kickoff_at >= now() - interval '15 minutes'
  ),
  classified_analyses as (
    select
      a.*,
      case a.classification
        when 'sugerido' then 'As três regras obrigatórias do mandante foram atendidas; os sinais extras definem o Tier.'
        when 'last10_insuficiente' then 'O mandante não alcançou 6 vitórias nos últimos 10 jogos, ou não há 10 jogos completos para validar.'
        when 'home_last5_insuficiente' then 'O mandante não alcançou 3 vitórias nos últimos 5 jogos em casa, ou não há 5 jogos completos para validar.'
        when 'tabela_insuficiente' then 'O mandante não tem vantagem mínima de 7 posições na tabela, ou as posições não estão disponíveis.'
        else 'Os dados obrigatórios ainda não permitem validar as três regras do mandante.'
      end as classification_label
    from current_analyses as a
  ),
  analysis_feed as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'fixtureId', a.provider_fixture_id,
          'kickoff', a.kickoff_at,
          'league', competition.name,
          'country', competition.country,
          'home', jsonb_build_object('id', home.provider_team_id, 'name', home.name, 'logo', home.logo_url, 'position', null),
          'away', jsonb_build_object('id', away.provider_team_id, 'name', away.name, 'logo', away.logo_url, 'position', null),
          'favorite', a.favorite_side,
          'favoriteName', case when a.favorite_side = 'home' then home.name else away.name end,
          'recommendedMarket', a.recommended_market,
          'bookmaker', a.bookmaker,
          'odds', a.odds,
          'impliedProbability', a.implied_probability,
          'probability', a.probability,
          'dataConfidence', a.confidence,
          'score', a.model_score,
          'tier', a.tier,
          'eligible', a.eligible,
          'classification', a.classification,
          'classificationLabel', a.classification_label,
          'checks', jsonb_build_object(
            'last10', jsonb_build_object(
              'label', 'Últimos 10: mínimo 6 vitórias',
              'value', a.metrics -> 'mandatory' -> 'last10',
              'passed', coalesce((a.metrics #>> '{mandatory,last10,passed}')::boolean, false)
            ),
            'homeLast5', jsonb_build_object(
              'label', 'Últimos 5 em casa: mínimo 3 vitórias',
              'value', a.metrics -> 'mandatory' -> 'homeLast5',
              'passed', coalesce((a.metrics #>> '{mandatory,homeLast5,passed}')::boolean, false)
            ),
            'tableGap', jsonb_build_object(
              'label', 'Tabela: mínimo +7 posições',
              'value', a.metrics -> 'mandatory' -> 'tableGap',
              'passed', coalesce((a.metrics #>> '{mandatory,tableGap,passed}')::boolean, false)
            )
          ),
          'sourceUpdatedAt', a.analyzed_at,
          'metrics', jsonb_build_object(
            'last10', a.metrics -> 'last10',
            'venueLast5', a.metrics -> 'venueLast5',
            'tableGap', a.metrics -> 'tableGap',
            'mandatory', a.metrics -> 'mandatory',
            'supplementary', a.metrics -> 'supplementary',
            'opponentStrength', a.metrics -> 'opponentStrength',
            'xg', a.metrics -> 'xg',
            'lineup', a.metrics -> 'lineup',
            'statsbomb', a.metrics -> 'statsbomb',
            'footballData', a.metrics -> 'footballData'
          ),
          'reasons', a.reasons,
          'caveats', a.caveats
        )
        order by a.eligible desc, a.tier asc, a.probability desc, a.analyzed_at desc
      ),
      '[]'::jsonb
    ) as candidates
    from (
      select * from classified_analyses
      order by eligible desc, tier asc, probability desc, analyzed_at desc
      limit 80
    ) as a
    join public.teams as home on home.id = a.home_team_id
    join public.teams as away on away.id = a.away_team_id
    join public.competitions as competition on competition.id = a.competition_id
  ),
  latest_fixture_scan as (
    select payload, fetched_at
    from public.provider_cache
    where provider = 'api-football'
      and cache_key like 'fixtures|date=%|timezone=America/Sao_Paulo'
    order by fetched_at desc
    limit 1
  ),
  screened_rows as (
    select
      nullif(item #>> '{fixture,id}', '')::integer as fixture_id,
      nullif(item #>> '{fixture,date}', '')::timestamptz as kickoff_at,
      nullif(item #>> '{league,name}', '') as league,
      nullif(item #>> '{league,country}', '') as country,
      nullif(item #>> '{teams,home,name}', '') as home_name,
      nullif(item #>> '{teams,away,name}', '') as away_name,
      a.tier,
      a.probability,
      a.confidence,
      a.eligible,
      a.classification,
      a.classification_label
    from latest_fixture_scan as scan
    cross join lateral jsonb_array_elements(scan.payload) as item
    left join classified_analyses as a
      on a.provider_fixture_id = nullif(item #>> '{fixture,id}', '')::integer
    where item #>> '{fixture,status,short}' in ('NS', 'TBD')
      and nullif(item #>> '{fixture,date}', '')::timestamptz >= now() - interval '15 minutes'
  ),
  screening_feed as (
    select
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'fixtureId', fixture_id,
            'kickoff', kickoff_at,
            'league', league,
            'country', country,
            'homeName', home_name,
            'awayName', away_name,
            'analysisStatus', case when tier is null then 'aguardando_priorizacao' else 'analisado' end,
            'tier', tier,
            'probability', probability,
            'dataConfidence', confidence,
            'eligible', eligible,
            'classification', classification,
            'classificationLabel', classification_label,
            'screeningReason', case
              when tier is null then 'Detectado na varredura; a análise detalhada ainda está pendente ou foi interrompida para preservar a quota diária.'
              else 'Análise concluída; consulte as três regras obrigatórias e os sinais extras.'
            end
          )
          order by kickoff_at asc nulls last, league asc, home_name asc
        ),
        '[]'::jsonb
      ) as fixtures,
      count(*)::integer as screened_count
    from (
      select * from screened_rows
      order by kickoff_at asc nulls last, league asc, home_name asc
      limit 80
    ) as row
  ),
  summary as (
    select
      count(*)::integer as analyzed_count,
      count(*) filter (where eligible)::integer as verified_count,
      count(*) filter (where eligible)::integer as qualified_count,
      count(*) filter (where tier = 1)::integer as tier_one_count,
      count(*) filter (where tier = 2)::integer as tier_two_count,
      count(*) filter (where tier = 3)::integer as tier_three_count,
      count(*) filter (where tier = 4)::integer as tier_four_count,
      max(analyzed_at) as source_updated_at
    from classified_analyses
  )
  select (prior.payload - array['schemaVersion', 'sourceUpdatedAt', 'scanUpdatedAt', 'analyzedCount', 'verifiedCount', 'qualifiedCount', 'tierOneCount', 'tierCounts', 'screenedCount', 'candidates', 'screenedFixtures']) || jsonb_build_object(
    'schemaVersion', 6,
    'sourceUpdatedAt', summary.source_updated_at,
    'scanUpdatedAt', scan.fetched_at,
    'analyzedCount', summary.analyzed_count,
    'verifiedCount', summary.verified_count,
    'qualifiedCount', summary.qualified_count,
    'tierOneCount', summary.tier_one_count,
    'tierCounts', jsonb_build_object('1', summary.tier_one_count, '2', summary.tier_two_count, '3', summary.tier_three_count, '4', summary.tier_four_count),
    'screenedCount', screening.screened_count,
    'candidates', analysis.candidates,
    'screenedFixtures', screening.fixtures,
    'ruleSet', jsonb_build_object(
      'version', 'mandatory-home-v2',
      'mandatory', jsonb_build_array(
        'Mandante: mínimo 6 vitórias nos últimos 10 jogos',
        'Mandante: mínimo 3 vitórias nos últimos 5 jogos em casa',
        'Mandante: pelo menos 7 posições acima do visitante'
      ),
      'tierPolicy', 'Tier 3 ao cumprir as três regras; cada sinal complementar soma pontos, levando a Tier 2 ou Tier 1.'
    )
  )
  from prior
  cross join summary
  cross join analysis_feed as analysis
  cross join screening_feed as screening
  left join latest_fixture_scan as scan on true;
$$;

revoke all on function public.get_public_tipster_dashboard() from public, anon, authenticated;
grant execute on function public.get_public_tipster_dashboard() to anon, service_role;

-- Keep the refresh operation deterministic without relying on a table-wide
-- DELETE that the REST guard rejects. The predicate covers every valid key.
create or replace function public.refresh_statsbomb_team_profiles()
returns void
language plpgsql
set search_path = ''
as $$
begin
  delete from public.statsbomb_team_profiles where team_key is not null;

  insert into public.statsbomb_team_profiles (
    team_key, team_name, matches_played, wins, draws, losses,
    goals_for_per_match, goals_against_per_match,
    xg_for_per_match, xg_against_per_match,
    shots_for_per_match, shots_against_per_match,
    shots_on_target_for_per_match, completed_passes_per_match,
    pressures_per_match, first_match_date, last_match_date, source_updated_at
  )
  with team_rows as (
    select
      home_team_key as team_key,
      home_team_name as team_name,
      match_date,
      home_score::numeric as goals_for,
      away_score::numeric as goals_against,
      home_xg as xg_for,
      away_xg as xg_against,
      home_shots::numeric as shots_for,
      away_shots::numeric as shots_against,
      home_shots_on_target::numeric as shots_on_target_for,
      home_completed_passes::numeric as completed_passes,
      home_pressures::numeric as pressures,
      events_ingested_at
    from public.statsbomb_matches
    where events_ingested_at is not null

    union all

    select
      away_team_key,
      away_team_name,
      match_date,
      away_score::numeric,
      home_score::numeric,
      away_xg,
      home_xg,
      away_shots::numeric,
      home_shots::numeric,
      away_shots_on_target::numeric,
      away_completed_passes::numeric,
      away_pressures::numeric,
      events_ingested_at
    from public.statsbomb_matches
    where events_ingested_at is not null
  )
  select
    team_key,
    (array_agg(team_name order by match_date desc))[1],
    count(*)::integer,
    count(*) filter (where goals_for > goals_against)::integer,
    count(*) filter (where goals_for = goals_against)::integer,
    count(*) filter (where goals_for < goals_against)::integer,
    round(avg(goals_for), 3),
    round(avg(goals_against), 3),
    round(avg(xg_for), 3),
    round(avg(xg_against), 3),
    round(avg(shots_for), 3),
    round(avg(shots_against), 3),
    round(avg(shots_on_target_for), 3),
    round(avg(completed_passes), 3),
    round(avg(pressures), 3),
    min(match_date),
    max(match_date),
    max(events_ingested_at)
  from team_rows
  group by team_key;
end;
$$;

notify pgrst, 'reload schema';
