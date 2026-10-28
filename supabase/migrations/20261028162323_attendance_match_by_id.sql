-- Attendance matching: the national ID wins over the enrollment code.
-- Round 9's sheet codes are shifted by one against the imported enrollments
-- from sheet row 8 on, so a code can point at a different team. The ID is
-- looked up across the whole round; the code only narrows name matching for
-- rows without a usable ID. A 'sheet_once' round switches to the app only
-- after an import that matched someone, so an empty or broken tab is retried.

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

-- Clear the unmatched rows the first run reported; the next run re-reports any left
update public.sync_issues set resolved = true where kind = 'attendance_unmatched' and not resolved;
