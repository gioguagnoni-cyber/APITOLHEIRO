-- Cover delete joins and worker lookups on the foreign keys introduced by the
-- nightly publication / AI review subsystem.
create index if not exists published_analysis_snapshots_analysis_run_id_idx
  on public.published_analysis_snapshots (analysis_run_id);
create index if not exists ai_fixture_reviews_fixture_id_idx
  on public.ai_fixture_reviews (fixture_id);
