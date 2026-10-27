-- =====================================================================
-- Support for importing the Main MSMEs sheet (see docs/import-plan.md)
--   * per-member notes, birthdate on prior participations
--   * lookup rows the sheet data needs: manual source, extra issues,
--     Assiut districts, 2026 rounds
-- =====================================================================

alter table public.project_members add column notes text;

alter table public.prior_participations add column birthdate date;
create index on public.prior_participations (birthdate, phone);

insert into public.intake_sources (slug, name) values
  ('manual', 'Manual / unknown source');

-- Team Issues labels that record where a team came from (not disqualifying)
insert into public.screening_issues (label_ar, label_en, is_disqualifying) values
  ('AI Hackathon 1', 'Came from AI Hackathon 1', false),
  ('TechNation', 'Came from TechNation', false),
  ('جاء من جمعية بهيج بأبنوب', 'Referred by the Bahig association (Abnoub)', false),
  ('طلاب احمد ضيف الله', 'Students referred by Ahmed Dayfallah', false);

insert into public.districts (governorate_code, name_ar, name_en) values
  (25, 'مركز أسيوط', 'Assiut'),
  (25, 'مركز أبنوب', 'Abnoub'),
  (25, 'مركز منفلوط', 'Manfalut'),
  (25, 'مركز القوصية', 'El Qusiya'),
  (25, 'مركز أبو تيج', 'Abu Tig'),
  (25, 'مركز الفتح', 'El Fath'),
  (25, 'مركز ديروط', 'Dairut'),
  (25, 'مركز ساحل سليم', 'Sahel Selim'),
  (25, 'مركز صدفا', 'Sidfa'),
  (25, 'مركز البداري', 'El Badari'),
  (25, 'مركز الغنايم', 'El Ghanayem');

-- 2026 rounds: programs from the Counters round map, dates from References
insert into public.rounds (program_id, year, number, starts_on, ends_on)
select p.id, 2026, r.number, r.starts_on, r.ends_on
from (values
  (1,  'msme_incubator',      date '2026-04-04', date '2026-05-02'),
  (2,  'startup_sprint',      date '2026-04-05', date '2026-05-03'),
  (3,  'msme_incubator',      date '2026-06-07', date '2026-07-05'),
  (4,  'msme_incubator',      date '2026-07-18', date '2026-08-09'),
  (5,  'startup_sprint',      date '2026-04-06', date '2026-05-04'),
  (6,  'msme_incubator',      date '2026-07-13', date '2026-08-10'),
  (7,  'startup_sprint',      date '2026-06-06', date '2026-07-04'),
  (8,  'sustainable_fashion', date '2026-08-15', date '2026-09-12'),
  (9,  'agribusiness',        date '2026-09-18', date '2026-10-10'),
  (10, 'ecommerce',           date '2026-07-11', date '2026-08-08')
) as r(number, program_slug, starts_on, ends_on)
join public.programs p on p.slug = r.program_slug
order by r.number;
