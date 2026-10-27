# Import plan: Main MSMEs sheet → Supabase

Status: **draft for review, nothing loaded yet.**
Source: Google Sheet "Main MSMEs" (`1KARk6a0UVheuS2yzcLJD8zmyLXz_WnOHEuj4eSCAeBw`).
Target: Supabase project `bupgddkyfugczweqiotc`, schema from `supabase/migrations/`.

## 1. What gets imported, from where

| Sheet tab | Rows | Used for |
|---|---|---|
| Total Responces | 1,102 projects, 2,719 member slots | **Primary source**: projects, people, members, raw submissions |
| Intake tabs (SMEs dark ads, Facebook, GDG, TechNation, Hackathon, OLD Data) | timestamps only | Deciding each project's `intake_source` |
| Main (Veiw Only!) | 2,714 member rows | Screening, interview and selection data (team-level, first row of each project) and per-member notes |
| Ready to Attend | 1,003 people / 560 projects | Round enrollments and participants, sector, district |
| OLD beneficiaries | 2,967 rows | `prior_participations` |
| References / Counters | n/a | Round calendar and round → program map |

**Not imported:** Counters, Reporting, HIDDEN REPORT, Waiting (replaced by views), GWLA 2025 leads, Hack, Sheet27, New Project, and the empty AI-hackathon community tab. The Payment column (empty) and the "ATHAR 2026" tag are skipped. **Attendance is not in this sheet**: Reporting reads it from per-round files, so `sessions`/`attendance` stay empty for now.

Why Total Responces and not Main: Main builds its `DAAP###` code by *project name*, so the 12 project names used more than once (28 rows) collapse into 9 fewer projects there (1,093 vs 1,102). Importing per Total Responces row keeps them apart; Main's operational data is then matched back by project name + member national ID.

## 2. Field mapping

### projects ← Total Responces (one row each)

| Column | Target | Rule |
|---|---|---|
| A Timestamp | `submitted_at` | `m/d/yyyy h:mm:ss`, Africa/Cairo time |
| B Project name | `name` | trimmed |
| C Description | `description` | as-is |
| D Stage | `stage_id` | matched by Arabic prefix: فكرة → idea, فكرة مطورة → developed_idea, نموذج أولي → prototype, نموذج أولي مطور → advanced_prototype, منتج → product, إيرادات → revenue, أرباح → profit (also the English "Prototype / Developed Idea / Product / Revenues" variants). GDG rows: null, value goes to `university` |
| E Location | `governorate_code` | "أسيوط / Assiut" → 25, etc. "Hackathon" / "TechNation" → null. "Assiut - 2nd Tecknation" → 25 |
| F Founded | `founded_on` | `m/d/yyyy`; blank in 764 rows |
| G Sector | `sector_id` / `sector_other` / `track` | Arabic prefix → sector slug. GDG "Web development" / "Flutter development" → technology + `track`. "undefined" → null. Anything else → `other` + text in `sector_other`. **Overridden** by the Ready to Attend sector when that is one clean value |
| H Social URL | `social_url` | kept even when not a URL (349 are plain text) |
| (derived) | `source_id` | timestamp found in an intake tab → that source; 3 unmatched rows → new `manual` source |
| (derived) | `status`, `code` | see §3; code assigned in submission order (DAAP0001MSMES …) |
| Ready to Attend S Region | `district_id` | "مركز أبنوب", "ابنوب - قرية بهيج" → Abnoub, etc. (10 Assiut districts seeded) |

### people + project_members ← Total Responces member slots (up to 10 per row)

| Column group | Target | Rule |
|---|---|---|
| Name | `people.full_name_ar` | trimmed, internal spaces collapsed |
| National ID | `people.national_id` | Arabic digits → Western, spaces/dashes removed. Kept even if not 14 digits (`nid_valid` = false) |
| Phone | `people.phone` | digits only; 789 numbers missing the leading 0 get it added; `+20…` → `0…`; anything still not `01xxxxxxxxx` → null (raw kept in payload) |
| E-mail | `people.email` | null if not a valid address (6 cases) |
| Slot position | `project_members.position`, `is_lead` | slot 1 = lead |
| Main Notes (per member) | `project_members.notes` | **new column**, see §5 |
| Main Confirmation (team) | `project_members.confirmation` | copied to every member of the team |

**De-duplicating people** by national ID (2,151 distinct valid IDs):
- Same ID, same name, different submissions (180 IDs) → **one person**, several memberships.
- Same ID given to different names inside one team (55 IDs, usually the leader's ID copied) → first slot keeps the ID; the others are created **without** an ID and listed in the import report.
- Same ID, different names, different projects (11 IDs) → same treatment.
- Altogether 146 member slots lose their ID this way. 47 members have no ID at all; 6 have an ID but no name (name set to "—" and reported).

### Screening, interviews, selection ← Main (team-level values on each project's first row)

| Main column | Target | Rule |
|---|---|---|
| Call + Call date | `contact_attempts` (channel `call`) | one attempt on the lead at that date; outcome null |
| Whatsapp | `contact_attempts` (channel `whatsapp`) | one attempt on the lead |
| Number of Action | `contact_attempts.notes` | "imported: N actions" (individual attempts weren't recorded) |
| Shoruk - Validation | `screening_reviews` | Done → done, Waiting → waiting, Need to Update → needs_update |
| Team Issues | `project_issues` | comma-separated, matched to `screening_issues`; 4 extra labels need a decision (§5) |
| Interview date + Time | `interviews.scheduled_at` | Cairo time; status `done` when a selection exists, otherwise `scheduled` |
| Selection | `interviews.decision` | Accepted / Rejected / Waiting |
| Reasons? | `interviews.reasons` | as-is |
| Round | `round_enrollments` | see below |
| ORG / New Org | `prior_participations` | organization per member |

### Rounds, enrollments, participants ← Main Round + Ready to Attend

- Rounds 01–09 of 2026 are created (Round 10 has no projects yet). Dates come from References, programs from the Counters round map — **please confirm, §5**.
- Every project with a Round becomes a `round_enrollment` (558). Ready to Attend's round agrees with Main for all 1,003 rows. Codes are regenerated by the trigger in the same order, so they'll match `R_05_TR001`-style codes from the sheet.
- Every Ready to Attend row becomes a `round_participant` (1,003), matched to people by national ID (996), else by name within the project (7).

### prior_participations ← OLD beneficiaries

The tab holds two lists side by side:
- **Columns A–G** (Athar 2025 rounds, ~720 rows): project, name, phone, national ID, Kobo code, New/Referral, round label → organization Athar, year 2025.
- **Columns I–L** (all orgs, 2,967 rows): name, Kobo code, birthdate+phone key, organization (Athar, Entlaq, ICE Alex, Superfny). The key is split into birthdate + phone. **New column `birthdate`**, see §5.

People are linked by national ID, otherwise by birthdate + phone (the same match the sheet's "New Org" column uses).

## 3. Project status rules

Applied in order to the team-level values in Main:

| Condition (first match wins) | Status |
|---|---|
| Reasons mention withdrawal (منسحب) | `withdrawn` |
| Selection Accepted + Round set | `enrolled` |
| Selection Accepted, no round | `accepted` |
| Selection Rejected | `rejected` |
| Selection Waiting | `waiting` |
| Interview date set, no selection, Confirmation Accepted | `interviewing` |
| Confirmation Rejected | `rejected` |
| Confirmation Waiting | `waiting` |
| Confirmation Accepted, no interview | `screening` |
| Nothing recorded | `new` |
| Then: Shoruk "Need to Update" turns screening / interviewing / accepted / waiting into | `needs_update` |

Result on today's data (1,093 Main projects): enrolled 558 · rejected 319 · waiting 97 · new 44 · interviewing 34 · withdrawn 18 · screening 12 · needs_update 9 · accepted 2. The 9 extra projects that Main merged by name take their values from their own members' rows; if those are empty they become `new`.

The 18 withdrawn projects have no round set (they left Round 07), so they get no enrollment.

The status trigger records one history event per project at import time; `changed_by` will be empty for imported rows.

## 4. How the load runs

1. **Extract**: pull the needed ranges through the Google Sheets connection into `data/raw/*.json`. The `data/` folder is gitignored; it holds national IDs and phone numbers and never gets committed.
2. **Transform**: `scripts/import/transform.mjs` (pure, re-runnable) applies the rules above and writes `data/out/*.json` plus `data/out/import-report.md`. The report lists every conflict by sheet row number, with no names or IDs.
3. **Dry run**: `scripts/import/load.mjs --dry-run` inserts everything in one transaction, prints row counts per table and the `v_funnel` result, then **rolls back**.
4. **Load**: the same command without `--dry-run` commits. It refuses to run if `projects` already has rows, so it can't double-import.

The loader connects with a Postgres connection string you put in a local `.env` file (`SUPABASE_DB_URL=…`, from Project Settings → Database). I won't handle that string myself. Sending ~2 MB of personal data row by row through chat tools would be slow and would copy it into the conversation.

**Expected counts after load:** projects 1,102 · project_members 2,719 · round_enrollments 558 · round_participants 1,003 · interviews 351 · screening_reviews 661 · contact_attempts ≈ 1,390 (936 calls + 452 WhatsApp). People will be roughly 2,350–2,550 depending on how many repeat members share an ID; the transform prints the exact number. prior_participations ≈ 3,700. The dry run checks these against the sheet's own totals (1,102 outreach / 1,003 in rounds).

## 5. Decisions needed before building the loader

1. **Small schema addition** (one migration): `project_members.notes` (199 projects have different notes per member) and `prior_participations.birthdate` (needed for the OLD beneficiaries match).
2. **Round → program and dates.** Counters maps MSME Incubator → Rounds 01, 03, 04, 06; Startup Sprint → 02, 05, 07; Sustainable Fashion → 08; Agribusiness → 09; E-commerce → 10. References lists dates per round (e.g. R1 04 Apr–02 May, R9 18 Sep–10 Oct), but its program/capacity list doesn't line up with Counters. Which is right?
3. **Four "Team Issues" labels that aren't issues**: "AI Hackathon 1", "TechNation" (where the team came from) and "جاء من جمعية بهيج بأبنوب", "طلاب احمد ضيف الله" (who referred them). Add them as non-disqualifying screening issues (simplest), or as organizations/referrals?
4. **Conflicting national IDs** (146 slots): the rule in §2 keeps the ID on the first slot only. OK, or should those projects be held back until fixed?
