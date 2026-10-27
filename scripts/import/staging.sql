-- Temporary staging area for loading the sheet through the Supabase MCP
-- connection (no direct database connection needed). Not a migration:
-- create it, upload chunks, run staging.run_import(), then drop schema staging.
--
-- Chunks are compact JSON arrays (one array per row, columns by position)
-- produced by stage-chunks.mjs from data/out/import.json.

create schema if not exists staging;
revoke all on schema staging from public, anon, authenticated;

create table if not exists staging.chunks (
  tbl   text not null,
  n     int  not null,
  rows  jsonb not null,
  primary key (tbl, n)
);
revoke all on staging.chunks from public, anon, authenticated;

-- Per-chunk fingerprints to compare with data/out/chunks/manifest.json
create or replace view staging.chunk_fingerprints as
select c.tbl, c.n, jsonb_array_length(c.rows) as rows,
       (select md5(string_agg(coalesce(v, '∅'), '|' order by i, j))
        from jsonb_array_elements(c.rows) with ordinality a(r, i),
             jsonb_array_elements_text(a.r) with ordinality b(v, j)) as md5
from staging.chunks c;
revoke all on staging.chunk_fingerprints from public, anon, authenticated;

-- Moves everything from staging.chunks into public in the caller's transaction.
-- dry_run => raises at the end so every insert is rolled back; the report is
-- in the error message. Otherwise returns the report.
create or replace function staging.run_import(dry_run boolean default true)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  report jsonb := '{}'::jsonb;
  expected jsonb;
  n int;
begin
  if exists (select 1 from public.projects) then
    raise exception 'public.projects already has rows; refusing to import twice';
  end if;

  select jsonb_object_agg(tbl, cnt) into expected
  from (select tbl, sum(jsonb_array_length(rows))::int as cnt from staging.chunks group by tbl) s;

  -- people: [id, national_id, full_name_ar, phone, email]
  insert into public.people (id, national_id, full_name_ar, phone, email)
  overriding system value
  select (r->>0)::bigint, r->>1, r->>2, r->>3, r->>4
  from staging.chunks c, jsonb_array_elements(c.rows) r where c.tbl = 'people';

  -- projects: [id, name, description, stage_slug, governorate_code, district_name, sector_slug,
  --            sector_other, founded_on, social_url, source_slug, university, track, submitted_at, status]
  insert into public.projects (id, code, name, description, stage_id, governorate_code, district_id, sector_id,
                               sector_other, founded_on, social_url, source_id, university, track, submitted_at, status)
  overriding system value
  select (r->>0)::bigint, 'DAAP' || lpad(r->>0, 4, '0') || 'MSMES', r->>1, r->>2, st.id, (r->>4)::smallint, d.id, s.id,
         r->>7, (r->>8)::date, r->>9, src.id, r->>11, r->>12,
         ((r->>13)::timestamp at time zone 'Africa/Cairo'), (r->>14)::public.project_status
  from staging.chunks c, jsonb_array_elements(c.rows) r
  join public.intake_sources src on src.slug = r->>10
  left join public.project_stages st on st.slug = r->>3
  left join public.sectors s on s.slug = r->>6
  left join public.districts d on d.governorate_code = 25 and d.name_ar = r->>5
  where c.tbl = 'projects';

  -- intake_submissions: rebuilt from projects (raw form rows not uploaded)
  insert into public.intake_submissions (id, source_id, submitted_at, payload, project_id, sheet_tab, sheet_row)
  overriding system value
  select p.id, p.source_id, p.submitted_at,
         jsonb_build_object('note', 'Raw form row not imported; see the Google Sheet', 'sheet_row', p.id + 1),
         p.id, 'Total Responces', p.id + 1
  from public.projects p;

  -- project_members: [id, project_id, person_id, is_lead, position, confirmation, notes]
  insert into public.project_members (id, project_id, person_id, is_lead, position, confirmation, notes)
  overriding system value
  select (r->>0)::bigint, (r->>1)::bigint, (r->>2)::bigint, (r->>3)::boolean, (r->>4)::smallint,
         (r->>5)::public.confirmation, r->>6
  from staging.chunks c, jsonb_array_elements(c.rows) r where c.tbl = 'project_members';

  -- contact_attempts: [project_member_id, 'c'|'w', attempted_at, number_of_actions]
  insert into public.contact_attempts (project_member_id, channel, attempted_at, notes)
  select (r->>0)::bigint,
         case r->>1 when 'c' then 'call' else 'whatsapp' end::public.contact_channel,
         ((r->>2)::timestamp at time zone 'Africa/Cairo'),
         'Imported from sheet' || coalesce(' (Number of Action: ' || (r->>3) || ')', '')
  from staging.chunks c, jsonb_array_elements(c.rows) r where c.tbl = 'contact_attempts';

  -- screening_reviews: [project_id, status]
  insert into public.screening_reviews (project_id, status, notes)
  select (r->>0)::bigint, (r->>1)::public.review_status, 'Imported from sheet (Shoruk - Validation)'
  from staging.chunks c, jsonb_array_elements(c.rows) r where c.tbl = 'screening_reviews';

  -- project_issues: [project_id, issue_label]
  insert into public.project_issues (project_id, issue_id)
  select (r->>0)::bigint, i.id
  from staging.chunks c, jsonb_array_elements(c.rows) r
  join public.screening_issues i on i.label_ar = r->>1
  where c.tbl = 'project_issues';

  -- interviews: [project_id, scheduled_at, status, decision, round_number, reasons]
  insert into public.interviews (project_id, scheduled_at, status, decision, recommended_round_id, reasons)
  select (r->>0)::bigint, ((r->>1)::timestamp at time zone 'Africa/Cairo'), (r->>2)::public.interview_status,
         (r->>3)::public.decision, rd.id, r->>5
  from staging.chunks c, jsonb_array_elements(c.rows) r
  left join public.rounds rd on rd.year = 2026 and rd.number = (r->>4)::smallint
  where c.tbl = 'interviews';

  -- round_enrollments: [id, project_id, round_number, code]
  insert into public.round_enrollments (id, round_id, project_id, code)
  overriding system value
  select (r->>0)::bigint, rd.id, (r->>1)::bigint, r->>3
  from staging.chunks c, jsonb_array_elements(c.rows) r
  join public.rounds rd on rd.year = 2026 and rd.number = (r->>2)::smallint
  where c.tbl = 'round_enrollments';

  -- round_participants: [enrollment_id, person_id]
  insert into public.round_participants (enrollment_id, person_id)
  select (r->>0)::bigint, (r->>1)::bigint
  from staging.chunks c, jsonb_array_elements(c.rows) r where c.tbl = 'round_participants';

  -- prior_participations: [person_id, national_id, full_name, phone, birthdate, organization_name,
  --                        program_label, project_name, year, kobo_code, referral]
  insert into public.prior_participations (person_id, national_id, full_name, phone, birthdate, organization_id,
                                           program_label, project_name, year, kobo_code, referral)
  select (r->>0)::bigint, r->>1, r->>2, r->>3, (r->>4)::date, o.id, r->>6, r->>7, (r->>8)::smallint, r->>9,
         (r->>10)::public.referral_type
  from staging.chunks c, jsonb_array_elements(c.rows) r
  left join public.organizations o on o.name = r->>5
  where c.tbl = 'prior_participations';

  perform setval(pg_get_serial_sequence('public.people', 'id'), (select max(id) from public.people));
  perform setval(pg_get_serial_sequence('public.projects', 'id'), (select max(id) from public.projects));
  perform setval(pg_get_serial_sequence('public.project_members', 'id'), (select max(id) from public.project_members));
  perform setval(pg_get_serial_sequence('public.intake_submissions', 'id'), (select max(id) from public.intake_submissions));
  perform setval(pg_get_serial_sequence('public.round_enrollments', 'id'), (select max(id) from public.round_enrollments));
  perform setval('public.project_code_seq', (select max(id) from public.projects));

  -- Report: expected vs inserted per table, checks, funnel, rounds
  select jsonb_object_agg(t, jsonb_build_array(coalesce((expected->>t)::int, (select count(*) from public.projects)::int), cnt))
  into report
  from (values
    ('people', (select count(*) from public.people)::int),
    ('projects', (select count(*) from public.projects)::int),
    ('intake_submissions', (select count(*) from public.intake_submissions)::int),
    ('project_members', (select count(*) from public.project_members)::int),
    ('contact_attempts', (select count(*) from public.contact_attempts)::int),
    ('screening_reviews', (select count(*) from public.screening_reviews)::int),
    ('project_issues', (select count(*) from public.project_issues)::int),
    ('interviews', (select count(*) from public.interviews)::int),
    ('round_enrollments', (select count(*) from public.round_enrollments)::int),
    ('round_participants', (select count(*) from public.round_participants)::int),
    ('prior_participations', (select count(*) from public.prior_participations)::int)
  ) v(t, cnt);
  report := jsonb_build_object('tables_expected_inserted', report);

  report := report || jsonb_build_object('checks', jsonb_build_object(
    'status_history_events', (select count(*) from public.project_status_events),
    'people_invalid_or_missing_id', (select count(*) from public.people where not nid_valid),
    'projects_without_sector', (select count(*) from public.projects where sector_id is null),
    'projects_without_stage', (select count(*) from public.projects where stage_id is null),
    'projects_without_district', (select count(*) from public.projects where district_id is null),
    'v_ready_to_attend_rows', (select count(*) from public.v_ready_to_attend),
    'prior_participations_linked', (select count(*) from public.prior_participations where person_id is not null)));

  report := report || jsonb_build_object('funnel', (
    select jsonb_object_agg(status, jsonb_build_array(projects, individuals, male, female, invalid_id))
    from public.v_funnel));

  report := report || jsonb_build_object('rounds', (
    select jsonb_object_agg(r.name, jsonb_build_array(p.name_en, (select count(*) from public.round_enrollments e where e.round_id = r.id),
           (select count(*) from public.round_participants rp join public.round_enrollments e on e.id = rp.enrollment_id where e.round_id = r.id)))
    from public.rounds r join public.programs p on p.id = r.program_id));

  select count(*) into n
  from jsonb_each(report->'tables_expected_inserted') e
  where (e.value->>0)::int <> (e.value->>1)::int;
  if n > 0 then
    raise exception 'IMPORT FAILED, row counts differ: %', report;
  end if;

  if dry_run then
    raise exception 'DRY RUN OK (rolled back): %', report using errcode = 'P0001';
  end if;
  return report;
end $$;

revoke all on function staging.run_import(boolean) from public, anon, authenticated;
