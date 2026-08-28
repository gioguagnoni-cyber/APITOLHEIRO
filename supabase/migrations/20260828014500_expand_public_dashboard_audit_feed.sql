-- A public, bounded audit feed: every detailed analysis is visible, including
-- low-confidence and non-eligible tiers. A second, sanitised list identifies
-- fixtures discovered in the latest provider scan that were not deep-analysed.

create index if not exists provider_cache_provider_fetched_at_idx
  on public.provider_cache (provider, fetched_at desc);

create or replace function public.get_public_tipster_dashboard()
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  with current_analyses as (
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
        when a.eligible then 'qualificado'
        when a.confidence < 0.65 then 'cobertura_insuficiente'
        when a.odds is null then 'mercado_indisponivel'
        when a.odds < 1.30 or a.odds > 2.90 then 'odd_fora_da_faixa'
        when a.probability < 75 then 'probabilidade_abaixo_meta'
        else 'monitorar'
      end as classification
    from public.fixture_analyses as a
    join public.fixtures as f on f.id = a.fixture_id
    where f.kickoff_at >= now() - interval '15 minutes'
  ),
  classified_analyses as (
    select
      a.*,
      case a.classification
        when 'qualificado' then 'Qualificado para atenção; não é garantia de resultado.'
        when 'cobertura_insuficiente' then 'Dados insuficientes para uma leitura verificável.'
        when 'mercado_indisponivel' then 'Sem odd disponível para validar o mercado.'
        when 'odd_fora_da_faixa' then 'Odd fora da faixa operacional de 1,30–2,90.'
        when 'probabilidade_abaixo_meta' then 'Estimativa abaixo da referência de 75%.'
        else 'Manter em monitoramento; os sinais não fecharam uma indicação.'
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
            'modelThreshold', jsonb_build_object('label', 'Modelo ≥ 75%', 'value', a.probability, 'passed', a.probability >= 75),
            'coverageThreshold', jsonb_build_object('label', 'Cobertura ≥ 65%', 'value', a.confidence, 'passed', a.confidence >= 0.65),
            'oddsRange', jsonb_build_object('label', 'Odd 1,30–2,90', 'value', a.odds, 'passed', coalesce(a.odds between 1.30 and 2.90, false))
          ),
          'sourceUpdatedAt', a.analyzed_at,
          'metrics', jsonb_build_object(
            'last10', a.metrics -> 'last10',
            'venueLast5', a.metrics -> 'venueLast5',
            'tableGap', a.metrics -> 'tableGap',
            'opponentStrength', a.metrics -> 'opponentStrength',
            'xg', a.metrics -> 'xg',
            'lineup', a.metrics -> 'lineup'
          ),
          'reasons', a.reasons,
          'caveats', a.caveats
        )
        order by a.eligible desc, a.probability desc, a.analyzed_at desc
      ),
      '[]'::jsonb
    ) as candidates
    from (
      select * from classified_analyses
      order by eligible desc, probability desc, analyzed_at desc
      limit 32
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
              when tier is null then 'Detectado na varredura; ainda sem análise detalhada para preservar a quota diária.'
              else 'Análise detalhada concluída; consulte os critérios de decisão.'
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
      count(*) filter (where confidence >= 0.65)::integer as verified_count,
      count(*) filter (where eligible)::integer as qualified_count,
      count(*) filter (where tier = 1)::integer as tier_one_count,
      count(*) filter (where tier = 2)::integer as tier_two_count,
      count(*) filter (where tier = 3)::integer as tier_three_count,
      count(*) filter (where tier = 4)::integer as tier_four_count,
      max(analyzed_at) as source_updated_at
    from classified_analyses
  )
  select jsonb_build_object(
    'schemaVersion', 2,
    'generatedAt', now(),
    'sourceUpdatedAt', summary.source_updated_at,
    'scanUpdatedAt', scan.fetched_at,
    'analyzedCount', summary.analyzed_count,
    'verifiedCount', summary.verified_count,
    'qualifiedCount', summary.qualified_count,
    'tierOneCount', summary.tier_one_count,
    'tierCounts', jsonb_build_object('1', summary.tier_one_count, '2', summary.tier_two_count, '3', summary.tier_three_count, '4', summary.tier_four_count),
    'screenedCount', screening.screened_count,
    'candidates', analysis.candidates,
    'screenedFixtures', screening.fixtures
  )
  from summary
  cross join analysis_feed as analysis
  cross join screening_feed as screening
  left join latest_fixture_scan as scan on true;
$$;

revoke all on function public.get_public_tipster_dashboard() from public, anon, authenticated;
grant execute on function public.get_public_tipster_dashboard() to anon, service_role;

notify pgrst, 'reload schema';
