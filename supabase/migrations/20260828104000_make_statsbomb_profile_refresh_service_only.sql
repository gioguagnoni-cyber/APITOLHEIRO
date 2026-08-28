-- The profile rebuild is invoked only by the Edge Function's service role.
-- SECURITY INVOKER avoids depending on the migration-owner role while keeping
-- the function inaccessible to every browser-facing database role.
create or replace function public.refresh_statsbomb_team_profiles()
returns void
language plpgsql
security invoker
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

revoke all on function public.refresh_statsbomb_team_profiles() from public, anon, authenticated;
grant execute on function public.refresh_statsbomb_team_profiles() to service_role;
