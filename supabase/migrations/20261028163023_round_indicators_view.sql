-- Per-round totals of the training indicators, for the Rounds page
create or replace view public.v_round_indicators with (security_invoker = true) as
select r.id as round_id,
       count(v.participant_id)                         as participants,
       count(*) filter (where v.attended_days > 0)     as attended_any,
       count(*) filter (where v.counted_3_1)           as counted_3_1,
       count(*) filter (where v.counted_3_2)           as counted_3_2,
       count(*) filter (where v.counted_3_3)           as counted_3_3,
       count(*) filter (where v.counted_3_4)           as counted_3_4,
       count(*) filter (where v.counted_4_1)           as counted_4_1,
       count(*) filter (where v.counted_4_4)           as counted_4_4
from public.rounds r
left join public.v_participant_indicators v on v.round_id = r.id
group by r.id;
