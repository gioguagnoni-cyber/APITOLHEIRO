-- Disambiguate the table column from the RETURNS TABLE output variable.
-- This filename matches the applied remote migration history.
create or replace function public.reserve_api_quota(
  p_provider text,
  p_usage_date date,
  p_limit integer,
  p_count integer default 1
)
returns table(allowed boolean, requests_made integer, remaining integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_requests integer;
begin
  if p_provider !~ '^[a-z0-9-]{1,64}$' or p_limit < 1 or p_limit > 100 or p_count < 1 or p_count > 10 then
    raise exception 'Invalid quota reservation';
  end if;

  insert into public.api_usage_daily as usage (provider, usage_date, requests_made)
  values (p_provider, p_usage_date, p_count)
  on conflict (provider, usage_date) do update
    set requests_made = usage.requests_made + excluded.requests_made,
        updated_at = now()
    where usage.requests_made + excluded.requests_made <= p_limit
  returning usage.requests_made into current_requests;

  if found then
    return query select true, current_requests, greatest(p_limit - current_requests, 0);
    return;
  end if;

  select usage.requests_made
    into current_requests
    from public.api_usage_daily as usage
   where usage.provider = p_provider
     and usage.usage_date = p_usage_date;

  return query select false, coalesce(current_requests, 0), greatest(p_limit - coalesce(current_requests, 0), 0);
end;
$$;

revoke all on function public.reserve_api_quota(text, date, integer, integer) from public, anon, authenticated;
grant execute on function public.reserve_api_quota(text, date, integer, integer) to service_role;
