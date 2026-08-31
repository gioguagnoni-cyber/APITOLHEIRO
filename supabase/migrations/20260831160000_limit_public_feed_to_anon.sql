-- The public dashboard is intentionally exposed to the anonymous Pages client.
-- Supabase default privileges may also grant EXECUTE to `authenticated`, so
-- revoke that role explicitly and keep the allow-list narrow.
revoke all on function public.get_public_tipster_dashboard() from public, authenticated;
grant execute on function public.get_public_tipster_dashboard() to anon, service_role;

notify pgrst, 'reload schema';
