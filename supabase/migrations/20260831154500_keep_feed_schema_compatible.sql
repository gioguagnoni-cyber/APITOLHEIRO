-- The v11 feed only narrowed the meaning of the existing `results` field; its
-- shape did not change. Keep schemaVersion 10 so an older cached GitHub Pages
-- bundle can continue reading the feed during a deployment transition.
alter function public.get_public_tipster_dashboard() rename to get_public_tipster_dashboard_v11;
revoke all on function public.get_public_tipster_dashboard_v11() from public, anon, authenticated;

create function public.get_public_tipster_dashboard()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select (payload - 'schemaVersion') || jsonb_build_object('schemaVersion', 10)
  from (select public.get_public_tipster_dashboard_v11() as payload) as prior;
$$;

revoke all on function public.get_public_tipster_dashboard() from public;
grant execute on function public.get_public_tipster_dashboard() to anon, service_role;

notify pgrst, 'reload schema';
