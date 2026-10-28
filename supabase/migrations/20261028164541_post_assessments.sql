-- Post assessments: one row per form response in each round's
-- "Post assessment R_XX" sheet (02_Training/Round_XX/01_Post Assessment).
-- Scores are recomputed here from the answers with the sheets' answer key
-- (1 point per correct answer, 9 questions, pass = 6 or more), because
-- rounds 1-7 hold pasted scores that don't always follow that rule. The
-- sheet's own Total Score / Pass/Not are kept next to it for comparison.

-- The 9 quiz questions and 3 survey questions, with the correct answers
-- (Reference!A2:A10 in every round's sheet)
create table public.assessment_questions (
  no             smallint primary key,
  kind           text not null check (kind in ('quiz', 'survey')),
  question       text not null,
  correct_answer text
);
alter table public.assessment_questions enable row level security;
create policy assessment_questions_staff_read on public.assessment_questions
  for select to authenticated using (public.staff_role() is not null);

insert into public.assessment_questions (no, kind, question, correct_answer) values
  (1,  'quiz',   'ما هو الهدف الرئيسي من نموذج العمل التجاري؟',      'شرح كيف تنشئ الشركة وتقدم القيمة'),
  (2,  'quiz',   'بماذا يساعد نموذج العمل التجاري؟',                 'فهم كيفية عمل الشركة'),
  (3,  'quiz',   'أي من التالي هو جزء من نموذج العمل التجاري؟',      'شرائح العملاء'),
  (4,  'quiz',   'ما هو الهدف من القيمة المقترحة؟',                  'شرح كيف يساعد المنتج العملاء'),
  (5,  'quiz',   'أي من التالي مثال جيد على القيمة المقترحة؟',       '"نساعد الأشخاص المشغولين على توفير الوقت من خلال التوصيل السريع."'),
  (6,  'quiz',   'لماذا تعتبر القيمة المقترحة مهمة؟',                'تخبر العملاء لماذا يجب أن يختاروا منتجك'),
  (7,  'quiz',   'ما هو أهم شيء في التقييم المالي؟',                 'معرفة كم تكسب الشركة وتنفق'),
  (8,  'quiz',   'لماذا تحسب الشركات تكاليفها؟',                     'لمعرفة كم يحتاجون من المال للعمل'),
  (9,  'quiz',   'ما هو الربح؟',                                     'المال المتبقي بعد دفع التكاليف'),
  (10, 'survey', 'هل لديك معلومة عن الجهات التى تقدم خدمات ماليه للمشروعات الناشئة فى محافظتك ؟', null),
  (11, 'survey', 'ما هى الجهات التى تقدم خدمات مالية للمشروعات الناشئة فى محافظتك', null),
  (12, 'survey', 'ما هى متطلبات الحصول على فرصة تمويل مالى من احد جهات التمويل( يمكنك اختيار اكثر من اجابه واحده )', null);

-- Answer text compared without extra spaces or quote marks
create or replace function public.assessment_norm(t text)
returns text
language sql immutable
set search_path = ''
as $$ select nullif(regexp_replace(btrim(regexp_replace(coalesce(t, ''), '\s+', ' ', 'g')), '["“”]', '', 'g'), '') $$;

alter table public.rounds
  add column post_sheet_id text,
  add column post_source text not null default 'app'
    check (post_source in ('sheet', 'sheet_once', 'app'));

update public.rounds r set post_sheet_id = v.sheet_id, post_source = v.source
from (values
  (1, '19gOn3cnstPIqPaTPQGXXLBR3o1wrHKMcmTQiDTEgIgc', 'sheet_once'),
  (2, '11PPsGRxKq4lX2Y8srAT_9IPManjuWpFQWr8vClIyUtg', 'sheet_once'),
  (3, '1NC78-HvT4H_sUWsuyOqEHoDw_Zr5lDVHeyWuzPIlJoU', 'sheet_once'),
  (4, '1pSY3EUWA5Y9ZjzAPL2fgA2i_aIfvSg-pegNyz6mIuEI', 'sheet_once'),
  (5, '1UJm6tHKsiiiMsgovuboInragvRhUedsyZXWkvj0Zcio', 'sheet_once'),
  (6, '140CTiZcKlFDqNt7RinKSeH1xBTIiHKe8l-wP23fmINI', 'sheet_once'),
  (7, '1t34-HPE-y3-Uwj_1ThNpPpAeJXHDo2bcqXmBS_jFQ1w', 'sheet_once'),
  (8, '1dQWa9wOf-kWDinXTWT55nBP2QOtluh4eNlwGAsZAazU', 'sheet'),
  (9, '1fDJeYDU2mrJHUDW1IvU9GTmN9OpqoQ0FN5636MptLo0', 'sheet')
) v(number, sheet_id, source)
where r.number = v.number;

create table public.assessment_responses (
  id             bigint generated always as identity primary key,
  round_id       smallint not null references public.rounds(id),
  participant_id bigint references public.round_participants(id) on delete set null,
  kind           text not null default 'post' check (kind in ('post')),
  sheet_tab      text,
  sheet_row      int,
  submitted_at   timestamptz,
  name           text,          -- as typed in the form, for linking unmatched rows
  quiz           text[] not null default '{}',   -- answers to questions 1-9
  survey         jsonb not null default '{}',    -- question no -> answer, 10-12
  score          smallint,      -- recomputed: correct answers out of 9
  passed         boolean generated always as (score >= 6) stored,
  sheet_score    smallint,      -- the sheet's Total Score, as found
  sheet_passed   boolean,       -- the sheet's Pass/Not, as found
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (round_id, kind, sheet_tab, sheet_row)
);
create index on public.assessment_responses (participant_id);
alter table public.assessment_responses enable row level security;
create policy assessment_responses_staff_read on public.assessment_responses
  for select to authenticated using (public.staff_role() is not null);
create policy assessment_responses_update on public.assessment_responses
  for update to authenticated
  using (public.staff_role() in ('admin', 'screener', 'interviewer'))
  with check (public.staff_role() in ('admin', 'screener', 'interviewer'));

create or replace function public.assessment_score(p_quiz text[])
returns smallint
language sql stable
set search_path = ''
as $$
  select case when cardinality(p_quiz) = 0 then null else count(*)::smallint end
  from public.assessment_questions q
  where q.kind = 'quiz'
    and public.assessment_norm(p_quiz[q.no]) = public.assessment_norm(q.correct_answer)
$$;

-- One round's responses. Matching: national ID, Kobo code, phone, then a
-- name only one participant in the round has. A row already linked keeps
-- its participant, so a link made in the app survives later syncs.
create or replace function public.sync_post_assessment(p_run bigint, p_round smallint, p_label text, rows jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r         jsonb;
  v_part    bigint;
  v_matched int := 0;
  v_missing int := 0;
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

    if v_part is null then
      insert into public.sync_issues (run_id, sheet_row, kind, sheet_label)
      values (p_run, (r->>'sheet_row')::int, 'assessment_unmatched', p_label);
      v_missing := v_missing + 1;
    else
      v_matched := v_matched + 1;
    end if;
  end loop;

  if v_matched > 0 then
    update public.rounds set post_source = 'app' where id = p_round and post_source = 'sheet_once';
  end if;
  return jsonb_build_object('matched', v_matched, 'unmatched', v_missing);
end $$;

revoke all on function public.sync_post_assessment(bigint, smallint, text, jsonb) from public, anon, authenticated;
grant execute on function public.sync_post_assessment(bigint, smallint, text, jsonb) to service_role;

-- Best response per participant (highest score, then latest), for the round page
create or replace view public.v_participant_post with (security_invoker = true) as
select distinct on (a.participant_id)
       a.participant_id, a.round_id, a.score, a.passed, a.sheet_score, a.sheet_passed, a.submitted_at,
       count(*) over (partition by a.participant_id) as responses
from public.assessment_responses a
where a.participant_id is not null and a.kind = 'post'
order by a.participant_id, a.score desc nulls last, a.submitted_at desc nulls last, a.id desc;
