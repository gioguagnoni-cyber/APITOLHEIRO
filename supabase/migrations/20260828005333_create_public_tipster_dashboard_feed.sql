-- Remote migration history version: 20260828005333.
-- Public, read-only contract consumed by docs/index.html on GitHub Pages.
-- The underlying operational tables remain server-owned and RLS-protected.

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
      f.away_team_id
    from public.fixture_analyses as a
    join public.fixtures as f on f.id = a.fixture_id
    where f.kickoff_at >= now() - interval '15 minutes'
  ),
  verified_candidates as (
    select *
    from current_analyses
    where confidence >= 0.65
    order by eligible desc, probability desc, analyzed_at desc
    limit 32
  ),
  feed as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'fixtureId', a.provider_fixture_id,
          'kickoff', a.kickoff_at,
          'league', competition.name,
          'country', competition.country,
          'home', jsonb_build_object(
            'id', home.provider_team_id,
            'name', home.name,
            'logo', home.logo_url,
            'position', null
          ),
          'away', jsonb_build_object(
            'id', away.provider_team_id,
            'name', away.name,
            'logo', away.logo_url,
            'position', null
          ),
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
    from verified_candidates as a
    join public.teams as home on home.id = a.home_team_id
    join public.teams as away on away.id = a.away_team_id
    join public.competitions as competition on competition.id = a.competition_id
  ),
  summary as (
    select
      count(*)::integer as analyzed_count,
      count(*) filter (where confidence >= 0.65)::integer as verified_count,
      count(*) filter (where confidence >= 0.65 and tier = 1)::integer as tier_one_count,
      max(analyzed_at) as source_updated_at
    from current_analyses
  )
  select jsonb_build_object(
    'schemaVersion', 1,
    'generatedAt', now(),
    'sourceUpdatedAt', summary.source_updated_at,
    'analyzedCount', summary.analyzed_count,
    'verifiedCount', summary.verified_count,
    'tierOneCount', summary.tier_one_count,
    'candidates', feed.candidates
  )
  from summary
  cross join feed;
$$;

-- New database functions otherwise inherit EXECUTE for PUBLIC. This one is
-- deliberately the sole anonymous data surface and returns a fixed, bounded
-- and sanitised JSON contract; it accepts no caller-controlled SQL parameters.
revoke all on function public.get_public_tipster_dashboard() from public, anon, authenticated;
grant execute on function public.get_public_tipster_dashboard() to anon, service_role;

notify pgrst, 'reload schema';
