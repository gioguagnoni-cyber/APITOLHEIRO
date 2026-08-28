-- Keep the raw daily fixture map auditable without implying that every league
-- receives analysis. The base function already emits all detected fixtures;
-- a missing detailed analysis after a completed priority scan means that the
-- competition was outside the configured priority scope.
alter function public.get_public_tipster_dashboard() rename to get_public_tipster_dashboard_v6;

create function public.get_public_tipster_dashboard()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with prior as (
    select public.get_public_tipster_dashboard_v6() as payload
  ),
  clarified as (
    select coalesce(
      jsonb_agg(
        case
          when fixture ->> 'analysisStatus' = 'aguardando_priorizacao' then
            (fixture - array['analysisStatus', 'screeningReason']) || jsonb_build_object(
              'analysisStatus', 'fora_de_escopo',
              'screeningReason', 'Fora da lista de campeonatos priorizados; permanece no mapa para auditoria e não consome quota de análise.'
            )
          else fixture
        end
      ),
      '[]'::jsonb
    ) as fixtures
    from prior
    cross join lateral jsonb_array_elements(coalesce(prior.payload -> 'screenedFixtures', '[]'::jsonb)) as fixture
  )
  select (prior.payload - array['schemaVersion', 'screenedFixtures']) || jsonb_build_object(
    'schemaVersion', 7,
    'screenedFixtures', clarified.fixtures
  )
  from prior
  cross join clarified;
$$;

revoke all on function public.get_public_tipster_dashboard() from public;
grant execute on function public.get_public_tipster_dashboard() to anon, service_role;

notify pgrst, 'reload schema';
