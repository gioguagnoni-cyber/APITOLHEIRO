-- Cover the relationships used by fixture persistence and dashboard joins.
-- Remote migration history version: 20260827195912.
create index fixtures_competition_id_idx on public.fixtures (competition_id);
create index fixtures_home_team_id_idx on public.fixtures (home_team_id);
create index fixtures_away_team_id_idx on public.fixtures (away_team_id);
