-- pg_net grants outbound HTTP execution to PUBLIC by default. Keep that
-- capability solely with the job owner (supabase_admin) used by pg_cron.

revoke usage on schema net from public, anon, authenticated;
revoke execute on function net.http_get(text, jsonb, jsonb, integer) from public, anon, authenticated;
revoke execute on function net.http_post(text, jsonb, jsonb, jsonb, integer) from public, anon, authenticated;
revoke execute on function net.http_delete(text, jsonb, jsonb, integer, jsonb) from public, anon, authenticated;
revoke execute on function net.http_collect_response(bigint, boolean) from public, anon, authenticated;
