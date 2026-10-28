-- Rounds read on every sync (attendance_source / post_source = 'sheet')
-- logged each unmatched row again on every run: 25 rows of round 9 had
-- become 75 open issues after three runs. Now a row is logged only when it
-- has no open issue yet, and an open issue is resolved once its row matches.

-- Log an unmatched sheet row once
create or replace function public.sync_note_unmatched(p_run bigint, p_kind text, p_label text, p_row int)
returns void
language sql
set search_path = ''
as $$
  insert into public.sync_issues (run_id, sheet_row, kind, sheet_label)
  select p_run, p_row, p_kind, p_label
  where not exists (
    select 1 from public.sync_issues
    where kind = p_kind and sheet_label = p_label and sheet_row = p_row and not resolved
  )
$$;

-- Resolve this sheet's open issues for rows that now match
create or replace function public.sync_resolve_matched(p_kind text, p_label text, p_unmatched int[])
returns void
language sql
set search_path = ''
as $$
  update public.sync_issues set resolved = true
  where kind = p_kind and sheet_label = p_label and not resolved
    and not (sheet_row = any (coalesce(p_unmatched, '{}')))
$$;

revoke all on function public.sync_note_unmatched(bigint, text, text, int) from public, anon, authenticated;
revoke all on function public.sync_resolve_matched(text, text, int[]) from public, anon, authenticated;
grant execute on function public.sync_note_unmatched(bigint, text, text, int) to service_role;
grant execute on function public.sync_resolve_matched(text, text, int[]) to service_role;

-- Keep one open issue per row from the repeated runs so far
update public.sync_issues i set resolved = true
where not i.resolved and i.kind in ('attendance_unmatched', 'assessment_unmatched')
  and exists (
    select 1 from public.sync_issues j
    where j.kind = i.kind and j.sheet_label = i.sheet_label and j.sheet_row = i.sheet_row
      and not j.resolved and j.id < i.id
  );

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
  v_missing  int[] := '{}';
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
      perform public.sync_note_unmatched(p_run, 'attendance_unmatched', p_label, (r->>'sheet_row')::int);
      v_missing := v_missing || (r->>'sheet_row')::int;
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

  perform public.sync_resolve_matched('attendance_unmatched', p_label, v_missing);

  -- Finished rounds are read once; after that the app owns their attendance
  if v_matched > 0 then
    update public.rounds set attendance_source = 'app' where id = p_round and attendance_source = 'sheet_once';
  end if;

  return jsonb_build_object('matched', v_matched, 'unmatched', cardinality(v_missing), 'code_differs', v_shifted);
end $$;

create or replace function public.sync_post_assessment(p_run bigint, p_round smallint, p_label text, rows jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r         jsonb;
  v_part    bigint;
  v_matched int := 0;
  v_missing int[] := '{}';
  v_quiz    text[];
begin
  for r in select * from jsonb_array_elements(rows) loop
    v_part := null;
    if nullif(r->>'national_id', '') is not null then
      select rp.id into v_part from public.round_participants rp
      join public.round_enrollments e on e.id = rp.enrollment_id and e.round_id = p_round
      join public.people pe on pe.id = rp.person_id
      where pe.national_id = r->>'national_id' limit 1;
    end if;
    if v_part is null and nullif(r->>'kobo', '') is not null then
      select rp.id into v_part from public.round_participants rp
      join public.round_enrollments e on e.id = rp.enrollment_id and e.round_id = p_round
      where upper(rp.kobo_code) = upper(r->>'kobo') limit 1;
    end if;
    if v_part is null and nullif(r->>'phone', '') is not null then
      select case when count(*) = 1 then min(rp.id) end into v_part from public.round_participants rp
      join public.round_enrollments e on e.id = rp.enrollment_id and e.round_id = p_round
      join public.people pe on pe.id = rp.person_id
      where pe.phone = r->>'phone';
    end if;
    if v_part is null then
      v_part := public.attendance_unique_name(p_round, r->>'name');
    end if;

    v_quiz := array(select jsonb_array_elements_text(coalesce(r->'quiz', '[]')));
    insert into public.assessment_responses as a
      (round_id, participant_id, sheet_tab, sheet_row, submitted_at, name, quiz, survey, score, sheet_score, sheet_passed)
    values (
      p_round, v_part, r->>'tab', (r->>'sheet_row')::int, (r->>'submitted_at')::timestamp at time zone 'Africa/Cairo',
      nullif(r->>'name', ''), v_quiz, coalesce(r->'survey', '{}'), public.assessment_score(v_quiz),
      (r->>'sheet_score')::smallint, (r->>'sheet_passed')::boolean)
    on conflict (round_id, kind, sheet_tab, sheet_row) do update set
      participant_id = coalesce(a.participant_id, excluded.participant_id),
      submitted_at = excluded.submitted_at, name = excluded.name, quiz = excluded.quiz,
      survey = excluded.survey, score = excluded.score, sheet_score = excluded.sheet_score,
      sheet_passed = excluded.sheet_passed, updated_at = now()
    returning a.participant_id into v_part;

    -- A response linked by hand in the app counts as matched
    if v_part is null then
      perform public.sync_note_unmatched(p_run, 'assessment_unmatched', p_label, (r->>'sheet_row')::int);
      v_missing := v_missing || (r->>'sheet_row')::int;
    else
      v_matched := v_matched + 1;
    end if;
  end loop;

  perform public.sync_resolve_matched('assessment_unmatched', p_label, v_missing);

  if v_matched > 0 then
    update public.rounds set post_source = 'app' where id = p_round and post_source = 'sheet_once';
  end if;
  return jsonb_build_object('matched', v_matched, 'unmatched', cardinality(v_missing));
end $$;

revoke all on function public.sync_round_attendance(bigint, smallint, text, jsonb) from public, anon, authenticated;
revoke all on function public.sync_post_assessment(bigint, smallint, text, jsonb) from public, anon, authenticated;
grant execute on function public.sync_round_attendance(bigint, smallint, text, jsonb) to service_role;
grant execute on function public.sync_post_assessment(bigint, smallint, text, jsonb) to service_role;
