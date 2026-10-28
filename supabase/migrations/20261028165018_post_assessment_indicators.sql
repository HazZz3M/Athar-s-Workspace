-- Indicators take "post assessment done / passed" from the scored responses
-- when a participant has one, and fall back to the attendance sheet's flags
-- otherwise. Same 3.2 as the sheets in rounds 2-4 and 6-8; round 1 gains
-- one person whose pasted sheet score was wrong; round 5's attendance sheet
-- has a broken Pass column (#REF!), so its 3.2 goes from 0 to 121.
create or replace view public.v_participant_indicators with (security_invoker = true) as
select rp.id as participant_id,
       e.round_id,
       e.project_id,
       e.code as enrollment_code,
       rp.person_id,
       pe.gender,
       coalesce(a.days, 0) as attended_days,
       coalesce(a.days, 0) >= 2 and rp.consent_signed as counted_3_1,
       coalesce(a.days, 0) >= 2 and rp.consent_signed and p.done and p.passed as counted_3_2,
       coalesce(a.days, 0) >= 2 and rp.consent_signed and p.done and p.passed and rp.business_plan_submitted as counted_3_3,
       coalesce(a.days, 0) >= 2 and rp.consent_signed and p.done and p.passed and rp.business_plan_submitted as counted_3_4,
       rp.indicator_4_1 as counted_4_1,
       rp.employment_yes as counted_4_4,
       pp.score as post_score
from public.round_participants rp
join public.round_enrollments e on e.id = rp.enrollment_id and e.status <> 'withdrawn'
join public.people pe on pe.id = rp.person_id
left join (
  select participant_id, count(*) filter (where status in ('present', 'late')) as days
  from public.attendance group by participant_id
) a on a.participant_id = rp.id
left join public.v_participant_post pp on pp.participant_id = rp.id
cross join lateral (
  select pp.participant_id is not null or rp.post_assessment_done as done,
         coalesce(pp.passed, rp.post_assessment_passed) as passed
) p;
