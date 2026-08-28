-- StatsBomb Open Data is historical, selective research data. This schema
-- persists only match metadata and derived aggregates; raw event payloads are
-- processed in memory by the Edge Function and are never exposed publicly.

create table public.statsbomb_seasons (
  statsbomb_competition_id integer not null,
  statsbomb_season_id integer not null,
  country_name text not null,
  competition_name text not null,
  season_name text not null,
  competition_gender text not null,
  is_international boolean not null default false,
  source_match_updated_at timestamptz,
  source_match_available_at timestamptz,
  catalog_synced_at timestamptz not null default now(),
  matches_ingested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (statsbomb_competition_id, statsbomb_season_id)
);

create table public.statsbomb_matches (
  statsbomb_match_id bigint primary key,
  statsbomb_competition_id integer not null,
  statsbomb_season_id integer not null,
  match_date date not null,
  kickoff_time time,
  home_team_name text not null,
  away_team_name text not null,
  home_team_key text not null,
  away_team_key text not null,
  home_score smallint,
  away_score smallint,
  source_updated_at timestamptz,
  home_xg numeric(8,3),
  away_xg numeric(8,3),
  home_shots smallint,
  away_shots smallint,
  home_shots_on_target smallint,
  away_shots_on_target smallint,
  home_completed_passes smallint,
  away_completed_passes smallint,
  home_pressures smallint,
  away_pressures smallint,
  events_ingested_at timestamptz,
  event_error_at timestamptz,
  event_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (statsbomb_competition_id, statsbomb_season_id)
    references public.statsbomb_seasons (statsbomb_competition_id, statsbomb_season_id)
    on delete cascade,
  check (home_team_key <> away_team_key),
  check (home_xg is null or home_xg >= 0),
  check (away_xg is null or away_xg >= 0)
);

create table public.statsbomb_team_profiles (
  team_key text primary key,
  team_name text not null,
  matches_played integer not null check (matches_played > 0),
  wins integer not null check (wins >= 0),
  draws integer not null check (draws >= 0),
  losses integer not null check (losses >= 0),
  goals_for_per_match numeric(8,3) not null,
  goals_against_per_match numeric(8,3) not null,
  xg_for_per_match numeric(8,3) not null,
  xg_against_per_match numeric(8,3) not null,
  shots_for_per_match numeric(8,3) not null,
  shots_against_per_match numeric(8,3) not null,
  shots_on_target_for_per_match numeric(8,3) not null,
  completed_passes_per_match numeric(8,3) not null,
  pressures_per_match numeric(8,3) not null,
  first_match_date date not null,
  last_match_date date not null,
  source_updated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index statsbomb_seasons_pending_matches_idx
  on public.statsbomb_seasons (source_match_updated_at desc nulls last)
  where matches_ingested_at is null;

create index statsbomb_matches_pending_events_idx
  on public.statsbomb_matches (match_date desc, statsbomb_match_id)
  where events_ingested_at is null and event_error_at is null;

create index statsbomb_matches_team_key_idx
  on public.statsbomb_matches (home_team_key, away_team_key);

create trigger statsbomb_seasons_set_updated_at before update on public.statsbomb_seasons
for each row execute function public.set_updated_at();

create trigger statsbomb_matches_set_updated_at before update on public.statsbomb_matches
for each row execute function public.set_updated_at();

create trigger statsbomb_team_profiles_set_updated_at before update on public.statsbomb_team_profiles
for each row execute function public.set_updated_at();

create or replace function public.refresh_statsbomb_team_profiles()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.statsbomb_team_profiles;

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
    (array_agg(team_name order by match_date desc))[1] as team_name,
    count(*)::integer as matches_played,
    count(*) filter (where goals_for > goals_against)::integer as wins,
    count(*) filter (where goals_for = goals_against)::integer as draws,
    count(*) filter (where goals_for < goals_against)::integer as losses,
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

revoke all on function public.refresh_statsbomb_team_profiles() from public, anon, authenticated;
grant execute on function public.refresh_statsbomb_team_profiles() to service_role;

alter table public.statsbomb_seasons enable row level security;
alter table public.statsbomb_matches enable row level security;
alter table public.statsbomb_team_profiles enable row level security;

revoke all on table public.statsbomb_seasons from anon, authenticated;
revoke all on table public.statsbomb_matches from anon, authenticated;
revoke all on table public.statsbomb_team_profiles from anon, authenticated;

grant all on table public.statsbomb_seasons, public.statsbomb_matches, public.statsbomb_team_profiles to service_role;

-- Contract v3 extends the public feed with bounded source health only. It does
-- not return StatsBomb raw events, match payloads, ingestion errors or tables.
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
            'lineup', a.metrics -> 'lineup',
            'statsbomb', a.metrics -> 'statsbomb'
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
  ),
  statsbomb_summary as (
    select
      (select count(*)::integer from public.statsbomb_seasons) as seasons_discovered,
      (select count(*)::integer from public.statsbomb_seasons where matches_ingested_at is not null) as seasons_with_matches,
      (select count(*)::integer from public.statsbomb_matches) as matches_discovered,
      (select count(*)::integer from public.statsbomb_matches where events_ingested_at is not null) as matches_aggregated,
      (select count(*)::integer from public.statsbomb_team_profiles) as team_profiles,
      (select max(events_ingested_at) from public.statsbomb_matches) as source_updated_at
  )
  select jsonb_build_object(
    'schemaVersion', 3,
    'generatedAt', now(),
    'sourceUpdatedAt', summary.source_updated_at,
    'scanUpdatedAt', scan.fetched_at,
    'analyzedCount', summary.analyzed_count,
    'verifiedCount', summary.verified_count,
    'qualifiedCount', summary.qualified_count,
    'tierOneCount', summary.tier_one_count,
    'tierCounts', jsonb_build_object('1', summary.tier_one_count, '2', summary.tier_two_count, '3', summary.tier_three_count, '4', summary.tier_four_count),
    'screenedCount', screening.screened_count,
    'statsbomb', jsonb_build_object(
      'source', 'StatsBomb Open Data',
      'mode', 'histórico seletivo · agregados derivados',
      'attribution', 'Dados históricos StatsBomb Open Data; não representam cobertura ao vivo.',
      'seasonsDiscovered', statsbomb.seasons_discovered,
      'seasonsWithMatches', statsbomb.seasons_with_matches,
      'matchesDiscovered', statsbomb.matches_discovered,
      'matchesAggregated', statsbomb.matches_aggregated,
      'teamProfiles', statsbomb.team_profiles,
      'updatedAt', statsbomb.source_updated_at
    ),
    'candidates', analysis.candidates,
    'screenedFixtures', screening.fixtures
  )
  from summary
  cross join analysis_feed as analysis
  cross join screening_feed as screening
  cross join statsbomb_summary as statsbomb
  left join latest_fixture_scan as scan on true;
$$;

revoke all on function public.get_public_tipster_dashboard() from public, anon, authenticated;
grant execute on function public.get_public_tipster_dashboard() to anon, service_role;

select cron.unschedule(jobid)
from cron.job
where jobname = 'refresh-apitolheiro-statsbomb-history';

select cron.schedule(
  'refresh-apitolheiro-statsbomb-history',
  '7,37 * * * *',
  $$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'apitolheiro_project_url'
        limit 1
      ) || '/functions/v1/refresh-statsbomb-history',
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
      timeout_milliseconds := 120000
    );
  $$
);

notify pgrst, 'reload schema';
