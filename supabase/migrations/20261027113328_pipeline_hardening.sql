-- =====================================================================
-- Follow-up to pipeline_schema: addresses Supabase advisor findings
--   * staff_role() must not be callable by anonymous users
--   * one permissive policy per role/action (no overlapping SELECT)
--   * covering indexes for foreign keys
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. staff_role(): signed-in users only (RLS policies need it)
-- ---------------------------------------------------------------------
revoke execute on function public.staff_role() from public, anon;
grant execute on function public.staff_role() to authenticated;

-- ---------------------------------------------------------------------
-- 2. Replace "for all" write policies with insert/update/delete ones
-- ---------------------------------------------------------------------
do $$
declare
  t    text;
  cond text;
  lookups text[] := array['governorates','districts','sectors','project_stages','programs',
                          'organizations','intake_sources','screening_issues'];
  data_tables text[] := array['people','projects','project_members','intake_submissions',
                              'prior_participations','contact_attempts','screening_reviews',
                              'project_issues','rounds','interviews','round_enrollments',
                              'round_participants','sessions','attendance','project_status_events'];
begin
  foreach t in array lookups || array['staff'] loop
    execute format('drop policy %I on public.%I', t || '_admin_write', t);
  end loop;
  foreach t in array data_tables loop
    execute format('drop policy %I on public.%I', t || '_staff_write', t);
  end loop;

  foreach t in array lookups || data_tables || array['staff'] loop
    cond := case when t = any (data_tables)
                 then 'public.staff_role() in (''admin'',''screener'',''interviewer'')'
                 else 'public.staff_role() = ''admin''' end;
    execute format('create policy %I on public.%I for insert to authenticated with check (%s)', t || '_insert', t, cond);
    execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)', t || '_update', t, cond, cond);
    execute format('create policy %I on public.%I for delete to authenticated using (%s)', t || '_delete', t, cond);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. Foreign-key indexes
-- ---------------------------------------------------------------------
create index on public.attendance (participant_id);
create index on public.attendance (marked_by);
create index on public.contact_attempts (staff_id);
create index on public.intake_submissions (project_id);
create index on public.interviews (interviewer_id);
create index on public.interviews (recommended_round_id);
create index on public.people (residence_governorate_code);
create index on public.people (residence_district_id);
create index on public.prior_participations (person_id);
create index on public.prior_participations (organization_id);
create index on public.project_issues (issue_id);
create index on public.project_issues (noted_by);
create index on public.projects (stage_id);
create index on public.projects (governorate_code);
create index on public.projects (district_id);
create index on public.projects (source_id);
create index on public.projects (organization_id);
create index on public.round_enrollments (project_id);
create index on public.round_enrollments (selected_by);
create index on public.round_participants (person_id);
create index on public.rounds (program_id);
create index on public.screening_reviews (reviewer_id);
