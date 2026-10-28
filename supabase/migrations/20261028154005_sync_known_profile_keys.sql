-- Profiles already stored: {"YYYY-MM-DD HH:MM:SS|name": has_summary}, so the
-- sync only sends rows that are new or still missing their summary.
create function public.sync_known_profile_keys()
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_object_agg(
           to_char(submitted_at at time zone 'Africa/Cairo', 'YYYY-MM-DD HH24:MI:SS') || '|' || project_name,
           summary is not null), '{}')
  from public.company_profiles
$$;
revoke execute on function public.sync_known_profile_keys() from public, anon, authenticated;
grant execute on function public.sync_known_profile_keys() to service_role;
