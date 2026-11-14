-- The morning sender for owner updates. Every 15 minutes the database asks the sponsor-email
-- server function to send any update whose time has come (a second same-day update waits for
-- 9am Eastern the next day, see 20261114060000_item_updates.sql).
--
-- The call carries a shared secret (x-cron-secret) so only this job can trigger sending. The
-- secret lives in Supabase Vault as "cover_cron_secret" and in the function's CRON_SECRET setting;
-- both are set outside this file so the value never appears in code.
--
-- Only runs where the scheduling extensions exist (the real Supabase project), so the test
-- database skips it.

do $outer$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron with schema pg_catalog;
    create extension if not exists pg_net with schema extensions;

    perform cron.unschedule(jobid) from cron.job where jobname = 'cover-send-due-updates';
    perform cron.schedule(
      'cover-send-due-updates',
      '*/15 * * * *',
      $job$
        select net.http_post(
          url := 'https://qclasffvdviuugczaway.supabase.co/functions/v1/sponsor-email',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-cron-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'cover_cron_secret'), '')
          ),
          body := '{"action": "send_due"}'::jsonb
        )
        where exists (select 1 from public.item_updates where status = 'queued' and send_after <= now());
      $job$
    );
  end if;
end;
$outer$;
