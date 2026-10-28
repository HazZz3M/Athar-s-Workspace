-- Trust the national ID (decided by the team on 2026-10-28).
-- When a sheet row carries a national ID that already belongs to someone, the
-- member is linked to that person even if the name is written differently,
-- and the row is listed as 'id_name_mismatch' for review. Before, a new person
-- without an ID was created ('id_conflict').
--
-- Also re-links the 29 members the first sync created that way (GDG teams of
-- 2026-10-26) and removes their duplicate person records.

-- ---------------------------------------------------------------------
-- 1. New rule in sync_ingest_row
-- ---------------------------------------------------------------------
create or replace function public.sync_ingest_row(p_run bigint, r jsonb)
returns bigint language plpgsql set search_path = '' as $$
declare
  v_ts       timestamptz := (r->>'submitted_at')::timestamp at time zone 'Africa/Cairo';
  v_row      int := (r->>'sheet_row')::int;
  v_source   smallint;
  v_project  bigint;
  v_person   bigint;
  v_found    record;
  v_members  int := 0;
  m          jsonb;
  k          jsonb;
begin
  if exists (select 1 from public.projects where submitted_at = v_ts and name = r->>'name') then
    return null;
  end if;

  select id into v_source from public.intake_sources where slug = coalesce(r->>'source_slug', 'manual');

  insert into public.projects (name, description, stage_id, governorate_code, sector_id, sector_other,
                               founded_on, social_url, source_id, university, track, submitted_at)
  values (r->>'name', r->>'description',
          (select id from public.project_stages where slug = r->>'stage_slug'),
          (select code from public.governorates where code = (r->>'governorate_code')::smallint),
          (select id from public.sectors where slug = r->>'sector_slug'),
          r->>'sector_other', (r->>'founded_on')::date, r->>'social_url', v_source,
          r->>'university', r->>'track', v_ts)
  returning id into v_project;

  insert into public.intake_submissions (source_id, submitted_at, payload, project_id, sheet_tab, sheet_row)
  values (v_source, v_ts, coalesce(r->'payload', '{}'), v_project, r->>'sheet_tab', v_row)
  on conflict do nothing;

  for m in select * from jsonb_array_elements(coalesce(r->'members', '[]')) loop
    v_person := null;
    if m->>'national_id' is not null then
      select id, full_name_ar into v_found from public.people where national_id = m->>'national_id';
      if found then
        -- Same ID = same person; a differently written name is flagged for review
        v_person := v_found.id;
        update public.people
        set phone = coalesce(phone, m->>'phone'),
            email = coalesce(email, (m->>'email')::extensions.citext)
        where id = v_person;
        if not public.same_name(v_found.full_name_ar, m->>'name') then
          insert into public.sync_issues (run_id, project_id, sheet_row, kind)
          values (p_run, v_project, v_row, 'id_name_mismatch');
        end if;
      end if;
    end if;

    if v_person is null then
      insert into public.people (national_id, full_name_ar, phone, email)
      values (m->>'national_id', m->>'name', m->>'phone', (m->>'email')::extensions.citext)
      returning id into v_person;
    end if;

    if exists (select 1 from public.project_members where project_id = v_project and person_id = v_person) then
      insert into public.sync_issues (run_id, project_id, sheet_row, kind)
      values (p_run, v_project, v_row, 'duplicate_member_skipped');
      continue;
    end if;

    insert into public.project_members (project_id, person_id, is_lead, position)
    values (v_project, v_person, v_members = 0, (m->>'position')::smallint);
    v_members := v_members + 1;
  end loop;

  if v_members = 0 then
    insert into public.sync_issues (run_id, project_id, sheet_row, kind) values (p_run, v_project, v_row, 'no_members');
  end if;

  for k in select * from jsonb_array_elements(coalesce(r->'issues', '[]')) loop
    insert into public.sync_issues (run_id, project_id, sheet_row, kind) values (p_run, v_project, v_row, k #>> '{}');
  end loop;

  return v_project;
end $$;

revoke execute on function public.sync_ingest_row(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.sync_ingest_row(bigint, jsonb) to service_role;

-- ---------------------------------------------------------------------
-- 2. Re-link members created without an ID under the old rule
--    The raw row keeps each member's ID under "ما هو الرقم القومي الخاص بالفرد <ordinal>؟".
-- ---------------------------------------------------------------------
create temporary table relink on commit drop as
with ord(pos, w) as (values (1,'الأول'),(2,'الثاني'),(3,'الثالث'),(4,'الرابع'),(5,'الخامس'),
                            (6,'السادس'),(7,'السابع'),(8,'الثامن'),(9,'التاسع'),(10,'العاشر'))
select distinct m.id as member_id, m.project_id, m.is_lead, m.person_id as dup_person, ex.id as existing_person
from public.project_members m
join public.people dup on dup.id = m.person_id and dup.national_id is null
join public.intake_submissions s on s.project_id = m.project_id
join ord on ord.pos = m.position
join public.people ex on ex.national_id = regexp_replace(
       translate(s.payload->>('ما هو الرقم القومي الخاص بالفرد ' || ord.w || '؟'), '٠١٢٣٤٥٦٧٨٩', '0123456789'),
       '[\s\-.]', '', 'g')
where m.project_id in (select project_id from public.sync_issues where kind = 'id_conflict');

-- Person already in the same team: drop the extra row (handing over the lead if needed)
update public.project_members m set is_lead = false
from relink r
where m.id = r.member_id and r.is_lead
  and exists (select 1 from public.project_members x where x.project_id = r.project_id and x.person_id = r.existing_person);
update public.project_members x set is_lead = true
from relink r
where r.is_lead and x.project_id = r.project_id and x.person_id = r.existing_person;
delete from public.project_members m
using relink r
where m.id = r.member_id
  and exists (select 1 from public.project_members x where x.project_id = r.project_id and x.person_id = r.existing_person);

-- Two slots of one team carrying the same ID are the same person: keep one
-- membership (the lead's, if either is the lead) and drop the other
delete from public.project_members m
using (select member_id, row_number() over (partition by project_id, existing_person
                                            order by is_lead desc, member_id) as rn
       from relink) d
where m.id = d.member_id and d.rn > 1;

-- Everyone else: point the membership at the existing person
update public.project_members m set person_id = r.existing_person
from relink r
where m.id = r.member_id;

-- Remove the duplicate person records, now unused
delete from public.people p
using relink r
where p.id = r.dup_person
  and not exists (select 1 from public.project_members x where x.person_id = p.id)
  and not exists (select 1 from public.round_participants x where x.person_id = p.id)
  and not exists (select 1 from public.prior_participations x where x.person_id = p.id);

-- Keep them on the review list under the new meaning
update public.sync_issues set kind = 'id_name_mismatch' where kind = 'id_conflict';
