-- pg_net was created in public by the schedule migration; keep extensions
-- out of the exposed schema. Its functions live in schema net either way, so
-- the cron job's net.http_post call is unchanged.
drop extension if exists pg_net;
create extension pg_net schema extensions;
