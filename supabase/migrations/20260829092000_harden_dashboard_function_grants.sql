-- Old dashboard feed versions are implementation details.  The browser may
-- call only the current, bounded projection; historical SQL functions must not
-- remain callable through PostgREST after a rename.

revoke all on function public.get_public_tipster_dashboard_v5() from public, anon, authenticated;
revoke all on function public.get_public_tipster_dashboard_v6() from public, anon, authenticated;
revoke all on function public.get_public_tipster_dashboard_v7() from public, anon, authenticated;

notify pgrst, 'reload schema';
