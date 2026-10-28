-- Indicators 3.2-3.4 build on 3.1 (two or more days and consent), as in the
-- round sheets: round 8's sheet counts 46 for both 3.1 and 3.2, which a
-- one-day rule would not give.
create or replace view public.v_participant_indicators with (security_invoker = true) as
select rp.id as participant_id,
       e.round_id,
       e.project_id,
       e.code as enrollment_code,
       rp.person_id,
       pe.gender,
       coalesce(a.days, 0) as attended_days,
       coalesce(a.days, 0) >= 2 and rp.consent_signed as counted_3_1,
       coalesce(a.days, 0) >= 2 and rp.consent_signed and rp.post_assessment_done and rp.post_assessment_passed as counted_3_2,
       coalesce(a.days, 0) >= 2 and rp.consent_signed and rp.post_assessment_done and rp.post_assessment_passed
         and rp.business_plan_submitted as counted_3_3,
       coalesce(a.days, 0) >= 2 and rp.consent_signed and rp.post_assessment_done and rp.post_assessment_passed
         and rp.business_plan_submitted as counted_3_4,
       rp.indicator_4_1 as counted_4_1,
       rp.employment_yes as counted_4_4
from public.round_participants rp
join public.round_enrollments e on e.id = rp.enrollment_id and e.status <> 'withdrawn'
join public.people pe on pe.id = rp.person_id
left join (
  select participant_id, count(*) filter (where status in ('present', 'late')) as days
  from public.attendance group by participant_id
) a on a.participant_id = rp.id;

-- Name fallback across the whole round when the team (code) doesn't have the
-- name, used only when exactly one participant in the round has that name.
create or replace function public.attendance_unique_name(p_round smallint, p_name text)
returns bigint
language sql stable
set search_path = ''
as $$
  select case when count(*) = 1 then min(rp.id) end
  from public.round_participants rp
  join public.round_enrollments e on e.id = rp.enrollment_id and e.round_id = p_round
  join public.people pe on pe.id = rp.person_id
  where nullif(p_name, '') is not null and public.same_name(pe.full_name_ar, p_name)
$$;
revoke all on function public.attendance_unique_name(smallint, text) from public, anon, authenticated;
grant execute on function public.attendance_unique_name(smallint, text) to service_role;

-- Matching order: national ID, name within the team, unique name in the round
create or replace function public.sync_round_attendance(p_run bigint, p_round smallint, p_label text, rows jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r          jsonb;
  v_part     bigint;
  v_enr      bigint;
  v_nid      text;
  v_matched  int := 0;
  v_missing  int := 0;
  v_shifted  int := 0;
  d          int;
begin
  insert into public.sessions (round_id, day_number)
  select p_round, g from generate_series(1, 5) g
  on conflict (round_id, day_number) do nothing;

  for r in select * from jsonb_array_elements(rows) loop
    v_nid := nullif(r->>'national_id', '');
    select id into v_enr from public.round_enrollments
    where round_id = p_round and code = nullif(r->>'code', '');

    -- 1. National ID anywhere in the round
    v_part := null;
    if v_nid is not null then
      select rp.id into v_part
      from public.round_participants rp
      join public.round_enrollments e on e.id = rp.enrollment_id and e.round_id = p_round
      join public.people pe on pe.id = rp.person_id
      where pe.national_id = v_nid
      order by (e.id = v_enr) desc nulls last
      limit 1;
      if v_part is not null and v_enr is not null
         and not exists (select 1 from public.round_participants where id = v_part and enrollment_id = v_enr) then
        v_shifted := v_shifted + 1;
      end if;
    end if;

    -- 2. Name, within the team when the code is known
    if v_part is null then
      select rp.id into v_part
      from public.round_participants rp
      join public.round_enrollments e on e.id = rp.enrollment_id and e.round_id = p_round
      join public.people pe on pe.id = rp.person_id
      where (v_enr is null or e.id = v_enr)
        and public.same_name(pe.full_name_ar, r->>'name')
      limit 1;
    end if;

    -- 3. Name anywhere in the round, when only one participant has it
    if v_part is null then
      v_part := public.attendance_unique_name(p_round, r->>'name');
    end if;

    if v_part is null then
      insert into public.sync_issues (run_id, sheet_row, kind, sheet_label)
      values (p_run, (r->>'sheet_row')::int, 'attendance_unmatched', p_label);
      v_missing := v_missing + 1;
      continue;
    end if;

    for d in 1..5 loop
      insert into public.attendance (session_id, participant_id, status)
      select s.id, v_part, case when (r->'days'->>(d - 1))::boolean then 'present' else 'absent' end::public.attendance_status
      from public.sessions s where s.round_id = p_round and s.day_number = d
      on conflict (session_id, participant_id) do update
        set status = excluded.status, marked_at = now();
    end loop;

    update public.round_participants set
      kobo_code               = coalesce(nullif(r->>'kobo', ''), kobo_code),
      consent_signed          = coalesce((r->>'consent')::boolean, false),
      business_plan_submitted = coalesce((r->>'business_plan')::boolean, false),
      post_assessment_done    = coalesce((r->>'post_done')::boolean, false),
      post_assessment_passed  = coalesce((r->>'post_passed')::boolean, false),
      indicator_4_1           = coalesce((r->>'i41')::boolean, false),
      employment_yes          = coalesce((r->>'employment')::boolean, false),
      group_label             = coalesce(nullif(r->>'group', ''), group_label),
      sheet_row               = (r->>'sheet_row')::int,
      updated_at              = now()
    where id = v_part;
    v_matched := v_matched + 1;
  end loop;

  -- Finished rounds are read once; after that the app owns their attendance
  if v_matched > 0 then
    update public.rounds set attendance_source = 'app' where id = p_round and attendance_source = 'sheet_once';
  end if;

  return jsonb_build_object('matched', v_matched, 'unmatched', v_missing, 'code_differs', v_shifted);
end $$;

revoke all on function public.sync_round_attendance(bigint, smallint, text, jsonb) from public, anon, authenticated;
grant execute on function public.sync_round_attendance(bigint, smallint, text, jsonb) to service_role;

-- Clear the unmatched rows reported so far; the next run re-reports any left
update public.sync_issues set resolved = true where kind = 'attendance_unmatched' and not resolved;
