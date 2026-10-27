-- =====================================================================
-- Athar MSMEs pipeline schema
-- Models the "Main MSMEs" Google Sheet as normalized tables:
--   intake -> projects + people -> screening -> interviews
--          -> round enrollment -> sessions & attendance
-- NOT APPLIED YET. Review before running.
-- =====================================================================

create extension if not exists citext;

-- ---------------------------------------------------------------------
-- 1. Enums (fixed workflow states)
-- ---------------------------------------------------------------------
create type public.staff_role         as enum ('admin', 'screener', 'interviewer', 'viewer');
create type public.gender             as enum ('male', 'female');
create type public.project_status     as enum (
  'new',          -- just came in from a form
  'screening',    -- calls / validation in progress
  'needs_update', -- data incomplete, waiting on the team
  'waiting',      -- on hold for review
  'rejected',
  'interviewing',
  'accepted',     -- passed interview, not yet in a round
  'enrolled',     -- assigned to a round
  'withdrawn'
);
create type public.confirmation       as enum ('pending', 'accepted', 'rejected', 'waiting');
create type public.contact_channel    as enum ('call', 'whatsapp', 'sms', 'email');
create type public.contact_outcome    as enum ('reached', 'no_answer', 'wrong_number', 'callback', 'declined');
create type public.review_status      as enum ('pending', 'done', 'waiting', 'needs_update');
create type public.interview_status   as enum ('scheduled', 'done', 'no_show', 'cancelled');
create type public.decision           as enum ('accepted', 'rejected', 'waiting');
create type public.enrollment_status  as enum ('selected', 'confirmed', 'withdrawn', 'completed');
create type public.attendance_status  as enum ('present', 'absent', 'late', 'excused');
create type public.referral_type      as enum ('new', 'referral');

-- ---------------------------------------------------------------------
-- 2. Lookup tables (editable, bilingual) - replace free-text dropdowns
-- ---------------------------------------------------------------------
create table public.governorates (
  code     smallint primary key,          -- digits 8-9 of the national ID
  name_en  text not null unique,
  name_ar  text not null unique
);

create table public.districts (           -- "مركز" level, e.g. مركز أبنوب
  id                bigint generated always as identity primary key,
  governorate_code  smallint not null references public.governorates(code),
  name_ar           text not null,
  name_en           text,
  unique (governorate_code, name_ar)
);

create table public.sectors (
  id       smallint generated always as identity primary key,
  slug     text not null unique,
  name_en  text not null,
  name_ar  text,
  sort     smallint not null default 0
);

create table public.project_stages (
  id       smallint generated always as identity primary key,
  slug     text not null unique,          -- idea, developed_idea, prototype, ...
  name_en  text not null,
  name_ar  text,
  rank     smallint not null unique       -- maturity order
);

create table public.programs (
  id       smallint generated always as identity primary key,
  slug     text not null unique,
  name_en  text not null,
  name_ar  text
);

create table public.organizations (       -- Athar, Entlaq, ICE Alex, Superfny, ...
  id    smallint generated always as identity primary key,
  name  text not null unique
);

create table public.intake_sources (      -- one per Google Form / campaign
  id        smallint generated always as identity primary key,
  slug      text not null unique,
  name      text not null,
  form_url  text,
  active    boolean not null default true
);

create table public.screening_issues (    -- the "Team Issues" checklist
  id                 smallint generated always as identity primary key,
  label_ar           text not null unique,
  label_en           text,
  is_disqualifying   boolean not null default false
);

-- ---------------------------------------------------------------------
-- 3. Staff (linked to Supabase Auth)
-- ---------------------------------------------------------------------
create table public.staff (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  role        public.staff_role not null default 'viewer',
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 4. National-ID helpers (Egyptian 14-digit ID: C YYMMDD GG SSS G K)
--    Return NULL instead of failing on malformed IDs.
-- ---------------------------------------------------------------------
create function public.nid_birthdate(nid text)
returns date language plpgsql immutable as $$
begin
  if nid !~ '^[23][0-9]{13}$' then return null; end if;
  return make_date(
    (case left(nid, 1) when '2' then 1900 else 2000 end) + substr(nid, 2, 2)::int,
    substr(nid, 4, 2)::int,
    substr(nid, 6, 2)::int);
exception when others then
  return null;
end $$;

create function public.nid_gender(nid text)
returns public.gender language sql immutable as $$
  select case when nid ~ '^[0-9]{14}$'
              then case when substr(nid, 13, 1)::int % 2 = 1 then 'male' else 'female' end::public.gender
         end
$$;

create function public.nid_governorate(nid text)
returns smallint language sql immutable as $$
  select case when nid ~ '^[0-9]{14}$' then substr(nid, 8, 2)::smallint end
$$;

-- ---------------------------------------------------------------------
-- 5. People & projects
-- ---------------------------------------------------------------------
create table public.people (
  id                         bigint generated always as identity primary key,
  national_id                text unique,
  full_name_ar               text not null,
  phone                      text check (phone ~ '^01[0-9]{9}$'),
  email                      citext,
  residence_governorate_code smallint references public.governorates(code),
  residence_district_id      bigint references public.districts(id),
  -- derived from the national ID (replaces the sheet's GOV / Birthdate / Gender formulas)
  birthdate                  date generated always as (public.nid_birthdate(national_id)) stored,
  gender                     public.gender generated always as (public.nid_gender(national_id)) stored,
  id_governorate_code        smallint generated always as (public.nid_governorate(national_id)) stored,
  nid_valid                  boolean generated always as (public.nid_birthdate(national_id) is not null) stored,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);
create index on public.people (phone);

create sequence public.project_code_seq;

create table public.projects (
  id                bigint generated always as identity primary key,
  code              text not null unique
                    default 'DAAP' || lpad(nextval('public.project_code_seq')::text, 4, '0') || 'MSMES',
  name              text not null,
  description       text,
  stage_id          smallint references public.project_stages(id),
  governorate_code  smallint references public.governorates(code),
  district_id       bigint references public.districts(id),
  sector_id         smallint references public.sectors(id),
  sector_other      text,                 -- free text when "Other"
  founded_on        date,
  social_url        text,
  source_id         smallint references public.intake_sources(id),
  university        text,                 -- GDG / TechNation forms
  track             text,                 -- e.g. Web / Flutter development
  submitted_at      timestamptz not null default now(),
  status            public.project_status not null default 'new',
  organization_id   smallint references public.organizations(id),  -- partner org, if referred
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index on public.projects (status);
create index on public.projects (sector_id);

create table public.project_members (
  id            bigint generated always as identity primary key,
  project_id    bigint not null references public.projects(id) on delete cascade,
  person_id     bigint not null references public.people(id),
  role          text,                     -- Entrepreneur, Developer, Designer, ...
  is_lead       boolean not null default false,
  position      smallint not null default 1,   -- 1..10 as on the form
  confirmation  public.confirmation not null default 'pending',
  created_at    timestamptz not null default now(),
  unique (project_id, person_id)
);
create unique index project_one_lead on public.project_members (project_id) where is_lead;
create index on public.project_members (person_id);

-- Raw form rows, kept for traceability and re-imports
create table public.intake_submissions (
  id            bigint generated always as identity primary key,
  source_id     smallint not null references public.intake_sources(id),
  submitted_at  timestamptz not null,
  payload       jsonb not null,
  project_id    bigint references public.projects(id) on delete set null,
  sheet_tab     text,
  sheet_row     int,
  imported_at   timestamptz not null default now(),
  unique (source_id, submitted_at, sheet_row)
);

-- Participation in earlier programs (OLD beneficiaries / other orgs)
create table public.prior_participations (
  id               bigint generated always as identity primary key,
  person_id        bigint references public.people(id),
  national_id      text,
  full_name        text,
  phone            text,
  project_name     text,
  organization_id  smallint references public.organizations(id),
  program_label    text,                  -- e.g. "Round 5 -2025", "Hakathon 01 -2025"
  year             smallint,
  kobo_code        text,
  referral         public.referral_type
);
create index on public.prior_participations (national_id);

-- ---------------------------------------------------------------------
-- 6. Screening
-- ---------------------------------------------------------------------
-- Every call / WhatsApp attempt (replaces Call, Call date, Whatsapp, Number of Action)
create table public.contact_attempts (
  id                 bigint generated always as identity primary key,
  project_member_id  bigint not null references public.project_members(id) on delete cascade,
  channel            public.contact_channel not null,
  outcome            public.contact_outcome,
  attempted_at       timestamptz not null default now(),
  staff_id           uuid references public.staff(user_id),
  notes              text
);
create index on public.contact_attempts (project_member_id);

-- Data validation step (the sheet's "Shoruk - Validation")
create table public.screening_reviews (
  id           bigint generated always as identity primary key,
  project_id   bigint not null references public.projects(id) on delete cascade,
  status       public.review_status not null default 'pending',
  reviewer_id  uuid references public.staff(user_id),
  reviewed_at  timestamptz not null default now(),
  notes        text
);
create index on public.screening_reviews (project_id, reviewed_at desc);

create table public.project_issues (
  project_id  bigint not null references public.projects(id) on delete cascade,
  issue_id    smallint not null references public.screening_issues(id),
  noted_by    uuid references public.staff(user_id),
  noted_at    timestamptz not null default now(),
  primary key (project_id, issue_id)
);

-- ---------------------------------------------------------------------
-- 7. Rounds & interviews
-- ---------------------------------------------------------------------
create table public.rounds (
  id          smallint generated always as identity primary key,
  program_id  smallint not null references public.programs(id),
  year        smallint not null,
  number      smallint not null,
  name        text generated always as ('Round - ' || lpad(number::text, 2, '0')) stored,
  starts_on   date,
  ends_on     date,
  capacity    int check (capacity > 0),
  unique (year, number),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);

create table public.interviews (
  id                    bigint generated always as identity primary key,
  project_id            bigint not null references public.projects(id) on delete cascade,
  scheduled_at          timestamptz,
  status                public.interview_status not null default 'scheduled',
  interviewer_id        uuid references public.staff(user_id),
  decision              public.decision,
  recommended_round_id  smallint references public.rounds(id),
  reasons               text,
  notes                 text,
  created_at            timestamptz not null default now()
);
create index on public.interviews (project_id);
create index on public.interviews (scheduled_at);

-- ---------------------------------------------------------------------
-- 8. Enrollment, sessions, attendance (replaces "Ready to Attend")
-- ---------------------------------------------------------------------
create table public.round_enrollments (
  id               bigint generated always as identity primary key,
  round_id         smallint not null references public.rounds(id),
  project_id       bigint not null references public.projects(id) on delete cascade,
  code             text unique,           -- R_05_TR001, set by trigger
  status           public.enrollment_status not null default 'selected',
  selected_at      timestamptz not null default now(),
  selected_by      uuid references public.staff(user_id),
  withdraw_reason  text,
  unique (round_id, project_id)
);

create table public.round_participants (
  id             bigint generated always as identity primary key,
  enrollment_id  bigint not null references public.round_enrollments(id) on delete cascade,
  person_id      bigint not null references public.people(id),
  unique (enrollment_id, person_id)
);

create table public.sessions (
  id            bigint generated always as identity primary key,
  round_id      smallint not null references public.rounds(id) on delete cascade,
  day_number    smallint not null check (day_number > 0),
  session_date  date not null,
  unique (round_id, day_number)
);

create table public.attendance (
  session_id      bigint not null references public.sessions(id) on delete cascade,
  participant_id  bigint not null references public.round_participants(id) on delete cascade,
  status          public.attendance_status not null,
  marked_by       uuid references public.staff(user_id),
  marked_at       timestamptz not null default now(),
  primary key (session_id, participant_id)
);

-- ---------------------------------------------------------------------
-- 9. Status history (audit of every project status change)
-- ---------------------------------------------------------------------
create table public.project_status_events (
  id           bigint generated always as identity primary key,
  project_id   bigint not null references public.projects(id) on delete cascade,
  from_status  public.project_status,
  to_status    public.project_status not null,
  changed_by   uuid default auth.uid(),
  changed_at   timestamptz not null default now()
);
create index on public.project_status_events (project_id, changed_at);

-- ---------------------------------------------------------------------
-- 10. Triggers
-- ---------------------------------------------------------------------
create function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger people_touch   before update on public.people   for each row execute function public.touch_updated_at();
create trigger projects_touch before update on public.projects for each row execute function public.touch_updated_at();

create function public.log_project_status()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.project_status_events (project_id, from_status, to_status)
    values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status);
  end if;
  return new;
end $$;

create trigger projects_status_log after insert or update of status on public.projects
  for each row execute function public.log_project_status();

-- R_<round>_TR<nnn>, numbered per round in selection order
create function public.set_enrollment_code()
returns trigger language plpgsql as $$
declare
  rnum smallint;
  seq  int;
begin
  if new.code is not null then return new; end if;
  perform pg_advisory_xact_lock(new.round_id);
  select number into rnum from public.rounds where id = new.round_id;
  select count(*) + 1 into seq from public.round_enrollments where round_id = new.round_id;
  new.code := 'R_' || lpad(rnum::text, 2, '0') || '_TR' || lpad(seq::text, 3, '0');
  return new;
end $$;

create trigger round_enrollments_code before insert on public.round_enrollments
  for each row execute function public.set_enrollment_code();

-- ---------------------------------------------------------------------
-- 11. Views (replace Counters / Reporting / Waiting tabs)
-- ---------------------------------------------------------------------
create view public.v_people_flags with (security_invoker = true) as
select
  p.id,
  p.national_id,
  p.full_name_ar,
  p.nid_valid,
  date_part('year', age(p.birthdate))::int                    as age,
  date_part('year', age(p.birthdate)) not between 15 and 35   as age_out_of_range,
  date_part('year', age(p.birthdate)) < 23                    as under_23,
  exists (select 1 from public.prior_participations pp
          where pp.person_id = p.id or pp.national_id = p.national_id) as attended_before,
  (select count(*) from public.project_members m where m.person_id = p.id) as project_count
from public.people p;

create view public.v_funnel with (security_invoker = true) as
select
  pr.status,
  count(distinct pr.id)                                      as projects,
  count(m.id)                                                as individuals,
  count(m.id) filter (where pe.gender = 'male')              as male,
  count(m.id) filter (where pe.gender = 'female')            as female,
  count(m.id) filter (where not pe.nid_valid or pe.nid_valid is null) as invalid_id
from public.projects pr
left join public.project_members m on m.project_id = pr.id
left join public.people pe on pe.id = m.person_id
group by pr.status;

create view public.v_ready_to_attend with (security_invoker = true) as
select
  e.code, r.name as round, r.year, pr.name as project, s.name_en as sector,
  d.name_ar as district, pe.full_name_ar, pe.national_id, pe.phone, pe.email,
  pe.gender, date_part('year', age(pe.birthdate))::int as age
from public.round_participants rp
join public.round_enrollments e on e.id = rp.enrollment_id and e.status <> 'withdrawn'
join public.rounds r            on r.id = e.round_id
join public.projects pr         on pr.id = e.project_id
join public.people pe           on pe.id = rp.person_id
left join public.sectors s      on s.id = pr.sector_id
left join public.districts d    on d.id = pr.district_id;

-- ---------------------------------------------------------------------
-- 12. Row Level Security: staff only (data contains national IDs & phones)
-- ---------------------------------------------------------------------
create function public.staff_role()
returns public.staff_role language sql stable security definer set search_path = '' as $$
  select role from public.staff where user_id = (select auth.uid())
$$;

do $$
declare
  t text;
  lookups text[] := array['governorates','districts','sectors','project_stages','programs',
                          'organizations','intake_sources','screening_issues'];
  data_tables text[] := array['people','projects','project_members','intake_submissions',
                              'prior_participations','contact_attempts','screening_reviews',
                              'project_issues','rounds','interviews','round_enrollments',
                              'round_participants','sessions','attendance','project_status_events'];
begin
  foreach t in array lookups || data_tables || array['staff'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.staff_role() is not null)',
      t || '_staff_read', t);
  end loop;

  foreach t in array lookups loop
    execute format(
      'create policy %I on public.%I for all to authenticated using (public.staff_role() = ''admin'') with check (public.staff_role() = ''admin'')',
      t || '_admin_write', t);
  end loop;

  foreach t in array data_tables loop
    execute format(
      'create policy %I on public.%I for all to authenticated using (public.staff_role() in (''admin'',''screener'',''interviewer'')) with check (public.staff_role() in (''admin'',''screener'',''interviewer''))',
      t || '_staff_write', t);
  end loop;
end $$;

create policy staff_admin_write on public.staff for all to authenticated
  using (public.staff_role() = 'admin') with check (public.staff_role() = 'admin');

-- ---------------------------------------------------------------------
-- 13. Seed lookups
-- ---------------------------------------------------------------------
insert into public.governorates (code, name_en, name_ar) values
  (1,'Cairo','القاهرة'),(2,'Alexandria','الإسكندرية'),(3,'Port Said','بورسعيد'),(4,'Suez','السويس'),
  (11,'Damietta','دمياط'),(12,'Dakahlia','الدقهلية'),(13,'Sharqia','الشرقية'),(14,'Qalyubia','القليوبية'),
  (15,'Kafr El Sheikh','كفر الشيخ'),(16,'Gharbia','الغربية'),(17,'Monufia','المنوفية'),(18,'Beheira','البحيرة'),
  (19,'Ismailia','الإسماعيلية'),(21,'Giza','الجيزة'),(22,'Beni Suef','بني سويف'),(23,'Fayoum','الفيوم'),
  (24,'Minya','المنيا'),(25,'Assiut','أسيوط'),(26,'Sohag','سوهاج'),(27,'Qena','قنا'),(28,'Aswan','أسوان'),
  (29,'Luxor','الأقصر'),(31,'Red Sea','البحر الأحمر'),(32,'New Valley','الوادي الجديد'),(33,'Matrouh','مطروح'),
  (34,'North Sinai','شمال سيناء'),(35,'South Sinai','جنوب سيناء'),(88,'Outside Egypt','خارج الجمهورية');

insert into public.project_stages (slug, name_en, name_ar, rank) values
  ('idea','Idea','فكرة',1),
  ('developed_idea','Developed idea','فكرة مطورة',2),
  ('prototype','Prototype','نموذج أولي',3),
  ('advanced_prototype','Advanced prototype','نموذج أولي مطور',4),
  ('product','Product','منتج',5),
  ('revenue','Revenue','إيرادات',6),
  ('profit','Profit','أرباح',7);

insert into public.sectors (slug, name_en, name_ar, sort) values
  ('technology','Technology','التكنولوجيا',1),
  ('creative_industries','Creative Industries','الصناعات الإبداعية',2),
  ('agriculture','Agriculture','القطاع الزراعي',3),
  ('ecommerce','E-commerce','التجارة الإلكترونية',4),
  ('manufacturing','Manufacturing','التصنيع',5),
  ('education','Education','قطاع التعليم',6),
  ('food_beverage','Food & Beverage','الأغذية والمشروبات',7),
  ('healthcare','Healthcare','الرعاية الصحية',8),
  ('services','Services','الخدمات',9),
  ('retail','Retail','التجارة',10),
  ('logistics','Logistics / Transportation','النقل والخدمات اللوجستية',11),
  ('sustainability','Sustainability / Environment','الاستدامة والبيئة',12),
  ('other','Other','أخرى',99);

insert into public.programs (slug, name_en) values
  ('ecommerce','E-commerce'),('agribusiness','Agribusiness'),('sustainable_fashion','Sustainable Fashion'),
  ('startup_sprint','Startup Sprint Program'),('msme_incubator','MSME Incubator');

insert into public.organizations (name) values
  ('Athar'),('Entlaq'),('ICE Alex'),('Superfny'),('Arab Academy for Science, Technology and Maritime Transport');

insert into public.intake_sources (slug, name) values
  ('smes_dark_ads','SMEs 2026 dark ads'),('facebook','Facebook'),('gdg_technation','GDG SEC TecNation'),
  ('technation','TechNation'),('ai_hackathon','Upper Egypt AI Hackathon'),('old_data','OLD Data');

insert into public.screening_issues (label_ar, label_en, is_disqualifying) values
  ('طالب','Student',false),
  ('خارج محافظة اسيوط','Outside Assiut',true),
  ('أكبر من سن 35','Over 35',true),
  ('حضروا معانا قبل كدا','Attended before',true),
  ('بيانات مكررة','Duplicate data',true),
  ('فردي لا يستطيع توفير فريق','Solo, cannot form a team',false),
  ('مشروع يعمل أكثر من عام مع إيرادات مرتفعة','Running 1y+ with high revenue',true),
  ('عنده غموض عن البرنامج','Unclear about the program',false),
  ('لا يتم الرد مع تكرار التواصل','No response after repeated contact',false),
  ('صعب الالتزام بالتدريب','Hard to commit to training',false);
