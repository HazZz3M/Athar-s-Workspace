-- Round attendance and the program indicators (Counted 3.1 - 4.4), from the
-- per-round "Attendance R_XX" sheets in Drive folder 02_Training.
--
-- Each round records where its attendance is kept:
--   'sheet_once'  import once from the sheet, then switch to 'app' (finished rounds 1-7)
--   'sheet'       keep reading the sheet every sync; the app shows it read-only
--   'app'         recorded in the app; the sheet is no longer read
-- An admin switches a 'sheet' round to 'app' with "Manage in app".

-- ---------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------
alter table public.sessions alter column session_date drop not null;

alter table public.rounds
  add column attendance_sheet_id text,
  add column attendance_source   text not null default 'app'
             check (attendance_source in ('sheet', 'sheet_once', 'app'));

alter table public.round_participants
  add column kobo_code               text,
  add column consent_signed          boolean not null default false,
  add column business_plan_submitted boolean not null default false,
  add column post_assessment_done    boolean not null default false,
  add column post_assessment_passed  boolean not null default false,
  add column indicator_4_1           boolean not null default false,
  add column employment_yes          boolean not null default false,  -- "Counted 4.4"
  add column group_label             text,
  add column sheet_row               int,
  add column updated_at              timestamptz;

-- Issues found while reading a sheet other than the main intake one
alter table public.sync_issues add column sheet_label text;

-- ---------------------------------------------------------------------
-- 2. Attendance sheets of rounds 1-10 (Drive folder 02_Training)
-- ---------------------------------------------------------------------
update public.rounds r set attendance_sheet_id = s.sheet_id,
       attendance_source = case when r.number <= 7 then 'sheet_once' else 'sheet' end
from (values
  (1,  '1uOrYtF5oA9KJD5oIO-Yu2s_tQfaE2EF23idBuFZY6is'),
  (2,  '18p_Ffn8s2LpmVl5BWetdHnojr2iKYRQH2kBeIH64O94'),
  (3,  '1H3wt574u8CXgFAwphAf0V73tH_SytzWxr5LrzeNeJzg'),
  (4,  '19rddyumf1LeVIBsQBDEdY16iqIhNLkt0yKupVJfsr8U'),
  (5,  '1YVmFlFkje7ncUy4TOKQhwxKrrkjxseU8u4_Rk7fGzeM'),
  (6,  '1ct7qbYmgt5ZfDTvm70dzLvlba3_-_LB8B8C9VGK7l9Q'),
  (7,  '1HSZoJzz7u3KZVa-dR51PlKxNyCrBkG2R2rrc0C0bB4c'),
  (8,  '1AmOg9J3Pm8nZTyDJt4muPrZIEvCwYZjvGMqBGkbZXaI'),
  (9,  '1IZ294-L0e83l2UzfoT-Evbb0XTE1OAK6OCjVx7Earqk'),
  (10, '1jf37h6fa9OkFKTy2Mw5VWQiJxgkVVZ4KD_OnV5qslXI')
) as s(number, sheet_id)
where r.year = 2026 and r.number = s.number;

-- ---------------------------------------------------------------------
-- 3. Indicators, with the same rules as the sheet's formulas
--    3.1  attended 2+ days and signed the consent form
--    3.2  attended, consent, did the post assessment and passed it
--    3.3  3.2 + business plan submitted (3.4 uses the same rule in the sheet)
--    4.1  ticked by hand;  4.4  "yes" in the follow-up survey
-- ---------------------------------------------------------------------
create view public.v_participant_indicators with (security_invoker = true) as
select
  rp.id            as participant_id,
  e.round_id,
  e.project_id,
  e.code           as enrollment_code,
  rp.person_id,
  pe.gender,
  coalesce(a.days, 0) as attended_days,
  coalesce(a.days, 0) >= 2 and rp.consent_signed as counted_3_1,
  coalesce(a.days, 0) > 0 and rp.consent_signed and rp.post_assessment_done and rp.post_assessment_passed as counted_3_2,
  coalesce(a.days, 0) > 0 and rp.consent_signed and rp.post_assessment_done and rp.post_assessment_passed
    and rp.business_plan_submitted as counted_3_3,
  coalesce(a.days, 0) > 0 and rp.consent_signed and rp.post_assessment_done and rp.post_assessment_passed
    and rp.business_plan_submitted as counted_3_4,
  rp.indicator_4_1 as counted_4_1,
  rp.employment_yes as counted_4_4
from public.round_participants rp
join public.round_enrollments e on e.id = rp.enrollment_id and e.status <> 'withdrawn'
join public.people pe           on pe.id = rp.person_id
left join (select participant_id, count(*) filter (where status in ('present', 'late')) as days
           from public.attendance group by participant_id) a on a.participant_id = rp.id;

-- ---------------------------------------------------------------------
-- 4. Sync: one round's Attendance sheet rows, matched to participants by
--    enrollment code + national ID (then name). Service role only.
--    rows: [{sheet_row, code, name, national_id, kobo, days:[b,b,b,b,b],
--            consent, post_done, post_passed, business_plan, i41, employment, group}]
-- ---------------------------------------------------------------------
create function public.sync_round_attendance(p_run bigint, p_round smallint, p_label text, rows jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  r         jsonb;
  v_part    bigint;
  v_enr     bigint;
  v_matched int := 0;
  v_missing int := 0;
  d         int;
begin
  insert into public.sessions (round_id, day_number)
  select p_round, g from generate_series(1, 5) g
  on conflict (round_id, day_number) do nothing;

  for r in select * from jsonb_array_elements(rows) loop
    select id into v_enr from public.round_enrollments
    where round_id = p_round and code = nullif(r->>'code', '');

    -- National ID first, then the name; within the team when the code is known
    select rp.id into v_part
    from public.round_participants rp
    join public.round_enrollments e on e.id = rp.enrollment_id and e.round_id = p_round
    join public.people pe on pe.id = rp.person_id
    where (v_enr is null or e.id = v_enr)
      and (pe.national_id = nullif(r->>'national_id', '') or public.same_name(pe.full_name_ar, r->>'name'))
    order by (pe.national_id = nullif(r->>'national_id', '')) desc nulls last, (e.id = v_enr) desc nulls last
    limit 1;

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
  update public.rounds set attendance_source = 'app' where id = p_round and attendance_source = 'sheet_once';

  return jsonb_build_object('matched', v_matched, 'unmatched', v_missing);
end $$;

revoke execute on function public.sync_round_attendance(bigint, smallint, text, jsonb) from public, anon, authenticated;
grant execute on function public.sync_round_attendance(bigint, smallint, text, jsonb) to service_role;
