-- The vault values are configured before this migration is applied. The job runs
-- once daily at 11:00 UTC (08:00 BRT), leaving the free API-Football quota intact.

select cron.unschedule(jobid)
from cron.job
where jobname = 'refresh-apitolheiro-radar';

select cron.schedule(
  'refresh-apitolheiro-radar',
  '0 11 * * *',
  $$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'apitolheiro_project_url'
        limit 1
      ) || '/functions/v1/refresh-radar',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'apitolheiro_cron_secret'
          limit 1
        )
      ),
      body := jsonb_build_object('scheduled_at', now()),
      timeout_milliseconds := 60000
    );
  $$
);
