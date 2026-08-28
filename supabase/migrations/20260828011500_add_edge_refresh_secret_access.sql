-- Edge Functions read these narrowly scoped secrets only through the service role.
-- The encrypted values themselves are inserted into Supabase Vault outside Git.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.get_api_football_key()
returns text
language sql
security definer
set search_path = vault, pg_temp
stable
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'apitolheiro_api_football_key'
  limit 1;
$$;

create or replace function public.get_cron_refresh_secret()
returns text
language sql
security definer
set search_path = vault, pg_temp
stable
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = 'apitolheiro_cron_secret'
  limit 1;
$$;

revoke all on function public.get_api_football_key() from public, anon, authenticated;
revoke all on function public.get_cron_refresh_secret() from public, anon, authenticated;
grant execute on function public.get_api_football_key() to service_role;
grant execute on function public.get_cron_refresh_secret() to service_role;
