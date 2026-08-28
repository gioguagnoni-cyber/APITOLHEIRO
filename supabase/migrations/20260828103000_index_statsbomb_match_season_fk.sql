-- Supports the season-to-match foreign key during incremental StatsBomb syncs
-- and removes the database advisor's missing-FK-index finding.
create index if not exists statsbomb_matches_season_fk_idx
  on public.statsbomb_matches (statsbomb_competition_id, statsbomb_season_id);
