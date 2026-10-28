-- Phase 2 (interview) data from the "Company Profile 2026 (Responses)" sheet.
--   * company_profiles: one row per interview form response (raw answers), plus
--     the summary written in the sheet's Description tab. Linked to a project
--     by project name; unmatched ones are listed for staff to link in the app.
--   * Commitment deposit (جدية حضور) on projects: recorded in the app from now
--     on; filled once from the sheet's Description tab (Paid ? / Amount).
--   * Round 9 belongs to the Startup Sprint Program (confirmed by the team).

-- ---------------------------------------------------------------------
-- 1. Round 9 program
-- ---------------------------------------------------------------------
update public.rounds
set program_id = (select id from public.programs where slug = 'startup_sprint')
where year = 2026 and number = 9;

-- ---------------------------------------------------------------------
-- 2. Commitment deposit
-- ---------------------------------------------------------------------
alter table public.projects
  add column deposit_method text check (deposit_method in ('not_paid', 'office', 'instapay', 'vodafone_cash', 'other')),
  add column deposit_amount numeric(10, 2) check (deposit_amount >= 0),
  add column deposit_note   text;

-- ---------------------------------------------------------------------
-- 3. Company profiles
-- ---------------------------------------------------------------------
create table public.company_profiles (
  id                 bigint generated always as identity primary key,
  project_id         bigint references public.projects(id) on delete set null,
  submitted_at       timestamptz not null,
  project_name       text not null,              -- as typed in the form
  summary            text,                       -- Description tab, column B
  founders           smallint,
  female_founders    smallint,
  founders_under_35  smallint,
  employees          smallint,
  female_employees   smallint,
  freelancers        smallint,
  funding_amount     numeric(14, 2),
  annual_revenue     numeric(14, 2),
  monthly_income     numeric(14, 2),
  answers            jsonb not null,             -- every question -> answer
  sheet_row          int,
  imported_at        timestamptz not null default now(),
  unique (submitted_at, project_name)
);
create index on public.company_profiles (project_id);

alter table public.company_profiles enable row level security;
create policy company_profiles_select on public.company_profiles for select to authenticated
  using (public.staff_role() is not null);
-- Staff with edit rights can link a profile to the right project
create policy company_profiles_update on public.company_profiles for update to authenticated
  using (public.staff_role() in ('admin', 'screener', 'interviewer'))
  with check (public.staff_role() in ('admin', 'screener', 'interviewer'));

alter table public.sync_issues
  add column profile_id bigint references public.company_profiles(id) on delete cascade;
create index on public.sync_issues (profile_id);

alter table public.sync_runs add column profiles_new int;

-- One-time steps the sync has already done (e.g. the deposit import)
create table public.sync_flags (
  key     text primary key,
  done_at timestamptz not null default now()
);
alter table public.sync_flags enable row level security;  -- service role only

-- ---------------------------------------------------------------------
-- 4. Sync functions (service role only)
-- ---------------------------------------------------------------------
-- Project names compare with collapsed spaces, case-insensitive (the sheets'
-- own VLOOKUPs use TRIM/CLEAN on the name)
create function public.name_key(s text)
returns text language sql immutable set search_path = '' as $$
  select lower(trim(regexp_replace(coalesce(s, ''), '\s+', ' ', 'g')))
$$;

create index on public.projects (public.name_key(name));

-- Insert a profile if new; fill its summary later if the sheet adds one.
-- Returns 'new', 'updated' or 'unchanged'.
create function public.sync_ingest_profile(p_run bigint, r jsonb)
returns text language plpgsql set search_path = '' as $$
declare
  v_ts       timestamptz := (r->>'submitted_at')::timestamp at time zone 'Africa/Cairo';
  v_id       bigint;
  v_summary  text;
  v_matches  bigint[];
begin
  select id, summary into v_id, v_summary
  from public.company_profiles where submitted_at = v_ts and project_name = r->>'project_name';

  if found then
    if v_summary is null and r->>'summary' is not null then
      update public.company_profiles set summary = r->>'summary' where id = v_id;
      return 'updated';
    end if;
    return 'unchanged';
  end if;

  select array_agg(id order by submitted_at desc) into v_matches
  from public.projects where public.name_key(name) = public.name_key(r->>'project_name');

  insert into public.company_profiles (project_id, submitted_at, project_name, summary, founders, female_founders,
    founders_under_35, employees, female_employees, freelancers, funding_amount, annual_revenue, monthly_income,
    answers, sheet_row)
  values (case when cardinality(v_matches) = 1 then v_matches[1] end, v_ts, r->>'project_name', r->>'summary',
    (r->>'founders')::smallint, (r->>'female_founders')::smallint, (r->>'founders_under_35')::smallint,
    (r->>'employees')::smallint, (r->>'female_employees')::smallint, (r->>'freelancers')::smallint,
    (r->>'funding_amount')::numeric, (r->>'annual_revenue')::numeric, (r->>'monthly_income')::numeric,
    coalesce(r->'answers', '{}'), (r->>'sheet_row')::int)
  returning id into v_id;

  if coalesce(cardinality(v_matches), 0) <> 1 then
    insert into public.sync_issues (run_id, profile_id, sheet_row, kind)
    values (p_run, v_id, (r->>'sheet_row')::int,
            case when v_matches is null then 'profile_unmatched' else 'profile_ambiguous' end);
  end if;
  return 'new';
end $$;

-- One-time deposit import: set the deposit only where the app has none yet.
-- r = [{name, method, amount, note}]; returns the number of projects updated.
create function public.sync_import_deposits(r jsonb)
returns int language plpgsql set search_path = '' as $$
declare
  n int := 0;
  d jsonb;
  v_ids bigint[];
begin
  if exists (select 1 from public.sync_flags where key = 'deposits_imported') then
    return 0;
  end if;
  for d in select * from jsonb_array_elements(r) loop
    select array_agg(id) into v_ids from public.projects where public.name_key(name) = public.name_key(d->>'name');
    if cardinality(v_ids) = 1 then
      update public.projects
      set deposit_method = d->>'method', deposit_amount = (d->>'amount')::numeric, deposit_note = d->>'note'
      where id = v_ids[1] and deposit_method is null;
      if found then n := n + 1; end if;
    end if;
  end loop;
  insert into public.sync_flags (key) values ('deposits_imported');
  return n;
end $$;

create function public.sync_set_profiles_new(p_run bigint, p_count int)
returns void language sql set search_path = '' as $$
  update public.sync_runs set profiles_new = p_count where id = p_run
$$;

revoke execute on function public.sync_ingest_profile(bigint, jsonb) from public, anon, authenticated;
revoke execute on function public.sync_import_deposits(jsonb) from public, anon, authenticated;
revoke execute on function public.sync_set_profiles_new(bigint, int) from public, anon, authenticated;
grant execute on function public.sync_ingest_profile(bigint, jsonb) to service_role;
grant execute on function public.sync_import_deposits(jsonb) to service_role;
grant execute on function public.sync_set_profiles_new(bigint, int) to service_role;
