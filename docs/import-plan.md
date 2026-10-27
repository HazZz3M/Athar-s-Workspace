# Import plan: Main MSMEs sheet → Supabase

Status: **loaded into Supabase on 2026-10-27** through a staging schema (§4b). Every table holds exactly the expected row count, and the staging schema has been dropped.
Decisions taken: add `project_members.notes` and `prior_participations.birthdate`; Counters round → program map with References dates; the four source/referral labels added as non-disqualifying issues; conflicting national IDs kept on the first slot only.
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

Why Total Responces and not Main: Main builds its `DAAP###` code by *project name*, so the 12 project names used more than once (28 rows) collapse into 9 fewer projects there (1,093 vs 1,102). Importing per Total Responces row keeps them apart. Main lists exactly 10 slots per Total Responces row in the same order (verified for all 11,020 rows), so its operational data is joined **by position**: Main data row *i* = Total Responces row ⌊(i−1)/10⌋, slot (i−1) mod 10. The transform re-checks this and stops if the two ever drift apart.

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

**De-duplicating people** by national ID. Two names count as the same person when one equals the other or is a shorter form of it (after unifying أ/إ/آ, ة/ه, ى/ي); a different third name means a different person.
- Same ID + same name in another submission → **one person**, several memberships (358 slots).
- Same ID + same name repeated inside one team (the leader filling several slots with their own details) → the repeat slot is **skipped** (233 slots). Ready to Attend never lists these twice either.
- Same ID, different name, same team (108 slots) or another project (26 slots) → that member is created **without** an ID and listed in the report.
- 47 members have no ID; 30 IDs are kept but aren't valid 14-digit IDs; 6 members have an ID but no name (name set to "—").

Result: 2,719 slots → 2,486 memberships of 2,361 people.

### Screening, interviews, selection ← Main (team-level values on each project's first row)

| Main column | Target | Rule |
|---|---|---|
| Call + Call date | `contact_attempts` (channel `call`) | one attempt on the lead at that date; outcome null |
| Whatsapp | `contact_attempts` (channel `whatsapp`) | one attempt on the lead |
| Number of Action | `contact_attempts.notes` | "imported: N actions" (individual attempts weren't recorded) |
| Shoruk - Validation | `screening_reviews` | Done → done, Waiting → waiting, Need to Update → needs_update |
| Team Issues | `project_issues` | comma-separated, matched to `screening_issues`; 4 extra labels need a decision (§5) |
| Interview date + Time | `interviews.scheduled_at` | Cairo time. Times were typed without AM/PM: 1:00–7:00 are read as 13:00–19:00 (204), 0:00 means no time and becomes 12:00 (97). Status `done` when a selection exists, otherwise `scheduled` |
| Selection | `interviews.decision` | Accepted / Rejected / Waiting |
| Reasons? | `interviews.reasons` | as-is |
| Round | `round_enrollments` | see below |
| ORG / New Org | `prior_participations` | organization per member |

### Rounds, enrollments, participants ← Main Round + Ready to Attend

- Rounds 01–09 of 2026 are created (Round 10 has no projects yet). Dates come from References, programs from the Counters round map — **please confirm, §5**.
- Every project with a Round becomes a `round_enrollment` (558). Ready to Attend's round agrees with Main for all 1,003 rows. Codes are regenerated by the trigger in the same order, so they'll match `R_05_TR001`-style codes from the sheet.
- Every Ready to Attend row becomes a `round_participant`, matched to people by national ID, else by name within the project. 996 load; the other 7 belong to the 2 projects accepted without a round.

### prior_participations ← OLD beneficiaries

The tab holds two lists side by side:
- **Columns A–G** (Athar 2025 rounds, ~720 rows): project, name, phone, national ID, Kobo code, New/Referral, round label → organization Athar, year 2025.
- **Columns I–L** (all orgs, 2,967 rows): name, Kobo code, "DOP+PHONE" key, organization (Athar, Entlaq, ICE Alex, Superfny). The key is DDMMYYYY + **digits 7–9** of the 11-digit phone (checked against all 45 of the sheet's own "New Org" matches), so only the birthdate is stored; the phone stays empty. The Kobo code also embeds the birthdate: `<digit><initials><digit><DDMMYYYY><3 digits>`.

People are linked by national ID, otherwise by birthdate + phone digits 7–9 (the same match the sheet's "New Org" column uses). The Main ORG column adds one row per member that has it; "New Org" is skipped because it is a lookup into this same list.

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

All commands run from `scripts/import/` (`npm install` once).

1. **Extract**: a Sheets API `spreadsheets.get` dump of the needed ranges (with `formattedValue`) → `node extract.mjs <dump.json>` → `data/raw/sheets.json`. The `data/` folder is gitignored; it holds national IDs and phone numbers and never gets committed.
2. **Transform**: `npm run transform` applies the rules above and writes `data/out/import.json` plus `data/out/import-report.md`. The report lists every conflict by sheet row number, with no names or IDs.
3. **Rehearse**: `npm run rehearse` builds an in-memory Postgres from `supabase/migrations/`, loads everything, prints checks and rolls back.
4. **Dry run on Supabase**: `npm run dry-run`, the same against the real database, rolled back.
5. **Load**: `npm run load` commits. It refuses to run if `projects` already has rows, so it can't double-import.

Steps 4–5 read `SUPABASE_DB_URL` from `.env` at the repo root (Project Settings → Database → connection string). Sending ~3 MB of personal data row by row through chat tools would be slow and would copy it into the conversation, so the loader connects directly.

**Counts from the rehearsal:** projects 1,102 · intake_submissions 1,102 · people 2,361 · project_members 2,486 · contact_attempts 1,466 · screening_reviews 661 · project_issues 349 · interviews 351 · round_enrollments 558 · round_participants 996 · prior_participations 3,739. The 7 Ready to Attend rows that aren't loaded belong to the 2 projects accepted without a round. The dry run checks these against the sheet's own totals (1,102 outreach / 1,003 in rounds).

## 4b. How the load was actually done

`SUPABASE_DB_URL` was never set in `.env`, so steps 4–5 above weren't used. The data went in through a temporary `staging` schema instead. Each step is checked with an md5 fingerprint, so nothing reaches the real tables unless every chunk arrived intact.

1. **Staging objects**: `staging.sql` creates schema `staging` (no access for `anon` / `authenticated`), table `staging.chunks (tbl, n, rows jsonb)`, view `staging.chunk_fingerprints` and function `staging.run_import(dry_run)`.
   - Fingerprint: md5 of every cell as text, nulls as `∅`, joined with `|` in row/column order.
   - `run_import` inserts into the public tables from the chunks in dependency order, resets the identity and `project_code_seq` sequences and builds a report (tables expected vs inserted, checks, funnel, rounds).
   - It raises `IMPORT FAILED` on any count mismatch. With `dry_run = true` it always raises `DRY RUN OK (rolled back): <report>`, so nothing is kept.
2. **Chunk files**: `node stage-chunks.mjs` splits `data/out/import.json` into 41 files of positional JSON arrays in `data/out/chunks/` (≤ 40,000 chars each), plus `manifest.json` with the expected row count and fingerprint per chunk. Combining marks, format characters and unusual spaces (NBSP etc.) are written as `\uXXXX` so they survive copying; the values don't change.
3. **Local rehearsal**: `node rehearse-staging.mjs` runs the same objects on pglite. All 41 fingerprints matched and the dry run passed.
4. **Upload**: the first 18 chunks were inserted through the Supabase MCP connection. The other 23 were uploaded with `node upload-chunks.mjs`, which:
   - asks only for the Athar database password and never echoes it;
   - can only connect to project `bupgddkyfugczweqiotc`, trying the session pooler first and then the direct host;
   - skips chunks that are already staged and finishes by checking all 41 fingerprints against the manifest.

   If a chunk mismatches, `node diff-chunk.mjs <chunk.sql> <remote.json>` finds the differing rows.
5. **Dry run**: `select staging.run_import(true);` passed with every table count equal to the expected count.
6. **Load**: `select staging.run_import(false);` run in the SQL Editor, then `drop schema staging cascade;`.

**Loaded counts:** people 2,361 · projects 1,102 · intake_submissions 1,102 · project_members 2,486 · contact_attempts 1,466 · screening_reviews 661 · project_issues 349 · interviews 351 · round_enrollments 558 · round_participants 996 · prior_participations 3,739.

**Funnel (projects / members):** enrolled 558 / 1,000 · rejected 324 / 879 · waiting 100 / 271 · new 45 / 117 · interviewing 34 / 101 · withdrawn 18 / 47 · screening 12 / 38 · needs_update 9 / 26 · accepted 2 / 7.

**Data gaps carried over from the sheet:** 926 projects without a district, 368 without a stage, 35 without a sector; 247 people with a missing or invalid national ID; 94 of 3,739 prior participations linked to a person.

**Advisors after the load:** no new findings.
- Security: `staff_role()` is callable by signed-in users, which is intended because RLS uses it. `rls_auto_enable()` is callable by `anon`; it isn't in our migrations.
- Performance: 30 unused-index notices, expected until an app queries the data.

## 5. Decisions (taken)

1. **Small schema addition** (one migration): `project_members.notes` (199 projects have different notes per member) and `prior_participations.birthdate` (needed for the OLD beneficiaries match).
2. **Round → program and dates.** Counters maps MSME Incubator → Rounds 01, 03, 04, 06; Startup Sprint → 02, 05, 07; Sustainable Fashion → 08; Agribusiness → 09; E-commerce → 10. References lists dates per round (e.g. R1 04 Apr–02 May, R9 18 Sep–10 Oct), but its program/capacity list doesn't line up with Counters. Which is right?
3. **Four "Team Issues" labels that aren't issues**: "AI Hackathon 1", "TechNation" (where the team came from) and "جاء من جمعية بهيج بأبنوب", "طلاب احمد ضيف الله" (who referred them). Add them as non-disqualifying screening issues (simplest), or as organizations/referrals?
4. **Conflicting national IDs** (146 slots): the rule in §2 keeps the ID on the first slot only. OK, or should those projects be held back until fixed?
