-- One-way sync: Google Sheet (raw intake) -> Supabase.
-- The sheet is only ever read. New Total Responces rows become new projects
-- with status 'new'; rows already here (same submitted time + project name)
-- are skipped, so edits made in the app are never overwritten.
--
-- The sheet-sync Edge Function reads the sheet and calls these functions with
-- the service role. Staff can read the run log and issues; nobody else can
-- write them.

-- ---------------------------------------------------------------------
-- 1. Run log and data issues
-- ---------------------------------------------------------------------
create table public.sync_runs (
  id            bigint generated always as identity primary key,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  trigger       text not null check (trigger in ('schedule', 'manual')),
  triggered_by  uuid references public.staff(user_id) on delete set null,
  status        text not null default 'running' check (status in ('running', 'ok', 'failed')),
  rows_read     int,
  rows_new      int,
  rows_failed   int,
  error         text
);
create index on public.sync_runs (started_at desc);

-- Sheet row numbers and issue kinds only; never names, IDs or phones
create table public.sync_issues (
  id          bigint generated always as identity primary key,
  run_id      bigint not null references public.sync_runs(id) on delete cascade,
  project_id  bigint references public.projects(id) on delete set null,
  sheet_row   int,
  kind        text not null,
  resolved    boolean not null default false,
  created_at  timestamptz not null default now()
);
create index on public.sync_issues (run_id);
create index on public.sync_issues (project_id);

alter table public.sync_runs enable row level security;
alter table public.sync_issues enable row level security;
create policy sync_runs_select on public.sync_runs for select to authenticated
  using (public.staff_role() is not null);
create policy sync_issues_select on public.sync_issues for select to authenticated
  using (public.staff_role() is not null);
-- Staff with edit rights can mark an issue as resolved
create policy sync_issues_update on public.sync_issues for update to authenticated
  using (public.staff_role() in ('admin', 'screener', 'interviewer'))
  with check (public.staff_role() in ('admin', 'screener', 'interviewer'));

-- ---------------------------------------------------------------------
-- 2. Name matching (same rule as scripts/import/transform.mjs)
--    Two names are the same person when one equals the other or is a shorter
--    form of it, after unifying alef / taa marbuta / yaa forms.
-- ---------------------------------------------------------------------
create function public.name_tokens(s text)
returns text[] language sql immutable set search_path = '' as $$
  select coalesce(array_remove(regexp_split_to_array(trim(regexp_replace(
           translate(coalesce(s, ''), 'أإآةى', 'اااهي'),
           '[^؀-ۿa-zA-Z ]', ' ', 'g')), '\s+'), ''), '{}')
$$;

create function public.same_name(a text, b text)
returns boolean language sql immutable set search_path = '' as $$
  with t as (select public.name_tokens(a) as ta, public.name_tokens(b) as tb),
       o as (select case when cardinality(ta) <= cardinality(tb) then ta else tb end as x,
                    case when cardinality(ta) <= cardinality(tb) then tb else ta end as y
             from t)
  select cardinality(x) >= 2 and x = y[1:cardinality(x)] from o
$$;

-- ---------------------------------------------------------------------
-- 3. Run bookkeeping
-- ---------------------------------------------------------------------
-- Returns the new run id, or null when a run is in progress or one started
-- less than a minute ago (keeps scheduled and manual runs from overlapping).
create function public.sync_start(p_trigger text, p_user uuid)
returns bigint language plpgsql set search_path = '' as $$
declare
  v_id bigint;
begin
  perform pg_advisory_xact_lock(hashtext('sheet_sync'));
  if exists (select 1 from public.sync_runs
             where (status = 'running' and started_at > now() - interval '10 minutes')
                or started_at > now() - interval '1 minute') then
    return null;
  end if;
  update public.sync_runs set status = 'failed', finished_at = now(), error = 'Timed out'
  where status = 'running';
  insert into public.sync_runs (trigger, triggered_by) values (p_trigger, p_user) returning id into v_id;
  return v_id;
end $$;

create function public.sync_finish(p_run bigint, p_status text, p_rows_read int, p_rows_new int,
                                   p_rows_failed int, p_error text)
returns void language sql set search_path = '' as $$
  update public.sync_runs
  set finished_at = now(), status = p_status, rows_read = p_rows_read, rows_new = p_rows_new,
      rows_failed = p_rows_failed, error = p_error
  where id = p_run
$$;

-- Keys of every project already in the database: "YYYY-MM-DD HH:MM:SS|name"
-- in Cairo local time, the same form the sync builds from the sheet.
create function public.sync_known_keys()
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(to_char(submitted_at at time zone 'Africa/Cairo', 'YYYY-MM-DD HH24:MI:SS') || '|' || name), '[]')
  from public.projects
$$;

-- ---------------------------------------------------------------------
-- 4. Add one sheet row (project + submission + members) atomically.
--    Returns the new project id, or null when the row is already here.
-- ---------------------------------------------------------------------
create function public.sync_ingest_row(p_run bigint, r jsonb)
returns bigint language plpgsql set search_path = '' as $$
declare
  v_ts       timestamptz := (r->>'submitted_at')::timestamp at time zone 'Africa/Cairo';
  v_row      int := (r->>'sheet_row')::int;
  v_source   smallint;
  v_project  bigint;
  v_person   bigint;
  v_found    record;
  v_nid      text;
  v_members  int := 0;
  m          jsonb;
  k          jsonb;
begin
  if exists (select 1 from public.projects where submitted_at = v_ts and name = r->>'name') then
    return null;
  end if;

  select id into v_source from public.intake_sources where slug = coalesce(r->>'source_slug', 'manual');

  insert into public.projects (name, description, stage_id, governorate_code, sector_id, sector_other,
                               founded_on, social_url, source_id, university, track, submitted_at)
  values (r->>'name', r->>'description',
          (select id from public.project_stages where slug = r->>'stage_slug'),
          (select code from public.governorates where code = (r->>'governorate_code')::smallint),
          (select id from public.sectors where slug = r->>'sector_slug'),
          r->>'sector_other', (r->>'founded_on')::date, r->>'social_url', v_source,
          r->>'university', r->>'track', v_ts)
  returning id into v_project;

  insert into public.intake_submissions (source_id, submitted_at, payload, project_id, sheet_tab, sheet_row)
  values (v_source, v_ts, coalesce(r->'payload', '{}'), v_project, r->>'sheet_tab', v_row)
  on conflict do nothing;

  for m in select * from jsonb_array_elements(coalesce(r->'members', '[]')) loop
    v_person := null;
    v_nid := m->>'national_id';
    if v_nid is not null then
      select id, full_name_ar into v_found from public.people where national_id = v_nid;
      if found then
        if public.same_name(v_found.full_name_ar, m->>'name') then
          v_person := v_found.id;
          update public.people
          set phone = coalesce(phone, m->>'phone'),
              email = coalesce(email, (m->>'email')::extensions.citext)
          where id = v_person;
        else
          -- Same ID, different name: keep the ID on the existing person only
          insert into public.sync_issues (run_id, project_id, sheet_row, kind)
          values (p_run, v_project, v_row, 'id_conflict');
          v_nid := null;
        end if;
      end if;
    end if;

    if v_person is null then
      insert into public.people (national_id, full_name_ar, phone, email)
      values (v_nid, m->>'name', m->>'phone', (m->>'email')::extensions.citext)
      returning id into v_person;
    end if;

    if exists (select 1 from public.project_members where project_id = v_project and person_id = v_person) then
      insert into public.sync_issues (run_id, project_id, sheet_row, kind)
      values (p_run, v_project, v_row, 'duplicate_member_skipped');
      continue;
    end if;

    insert into public.project_members (project_id, person_id, is_lead, position)
    values (v_project, v_person, v_members = 0, (m->>'position')::smallint);
    v_members := v_members + 1;
  end loop;

  if v_members = 0 then
    insert into public.sync_issues (run_id, project_id, sheet_row, kind) values (p_run, v_project, v_row, 'no_members');
  end if;

  -- Issues the function found while reading the row (invalid phone, ID, ...)
  for k in select * from jsonb_array_elements(coalesce(r->'issues', '[]')) loop
    insert into public.sync_issues (run_id, project_id, sheet_row, kind) values (p_run, v_project, v_row, k #>> '{}');
  end loop;

  return v_project;
end $$;

-- Only the Edge Function (service role) may run the sync functions
revoke execute on function public.sync_start(text, uuid) from public, anon, authenticated;
revoke execute on function public.sync_finish(bigint, text, int, int, int, text) from public, anon, authenticated;
revoke execute on function public.sync_known_keys() from public, anon, authenticated;
revoke execute on function public.sync_ingest_row(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.sync_start(text, uuid) to service_role;
grant execute on function public.sync_finish(bigint, text, int, int, int, text) to service_role;
grant execute on function public.sync_known_keys() to service_role;
grant execute on function public.sync_ingest_row(bigint, jsonb) to service_role;
