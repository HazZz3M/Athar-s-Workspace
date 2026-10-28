-- Run the sheet-sync Edge Function every 15 minutes.
-- The Authorization header carries the project's public anon key (the same
-- key the browser gets); the function treats that as a scheduled run.
-- sync_start() refuses overlapping runs, so extra calls do nothing.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'sheet-sync',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://bupgddkyfugczweqiotc.supabase.co/functions/v1/sheet-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ1cGdkZGt5ZnVnY3p3ZXFpb3RjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMwOTUwMjEsImV4cCI6MjEwODY3MTAyMX0.p3dUf2br0zKpXs9XpoASUK8l82byTdkq-DKDBk4-9Xw'
    ),
    body    := '{"trigger":"schedule"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
