# Sheet sync: Google Sheet → Supabase (one way)

The "Main MSMEs" Google Sheet stays the raw intake source. Every 15 minutes the `sheet-sync` Edge Function reads it and adds the **new** rows of `Total Responces` to Supabase as projects with status **New**, together with their team members. All follow-up work happens in the app.

- **Read-only.** The function uses a Google service account with Viewer access and the `spreadsheets.readonly` scope. It never writes to the sheet.
- **New rows only.** A row counts as already imported when a project with the same submitted time and project name exists. Existing projects are never updated from the sheet, so changes made in the app are kept.
- **Operational columns in Main are not synced.** Calls, interviews, selection and rounds are recorded in the app from now on.
- **Source per row.** The intake tabs' timestamps decide each project's source, the same way the original import did (`docs/import-plan.md` §2).
- **People are matched by national ID.** A member whose ID is already in the system is linked to that person, even if the name is written differently. Such cases are listed as "ID already known under a differently written name" for review. This rule was decided on 2026-10-28; the earlier rule created a second person without an ID.
- **Data issues.** Rows with problems are still added. The problem is listed on the app's **Data sync** page by sheet row number, with no names or IDs. Examples: an invalid phone, a missing or invalid national ID, a name that differs from the one already stored for that ID.

## Phase 2: Company Profile 2026 (interview form)

The same function also reads **Company Profile 2026 (Responses)** (`11YQFJI7SxQ4rZ7op9GxaJlwLh8MNSpEN4teTjMMUDpg`).

- **Form Responses 1 → `company_profiles`.**
  - One row per interview form. All answers are stored as question → answer.
  - Team size, employees, funding, revenue and monthly income are also stored as numbers.
  - Each profile is linked to the project with the same name, the same matching the sheet's `VLOOKUP`s use.
  - When no project or several projects match, the profile is listed on **Data sync** so staff can link it by project code.
- **Description, column B (summary) → `company_profiles.summary`.** Description lists the form's responses in time order, so summaries are paired by position and kept only when the project names agree.
- **Description, Paid ? / Amount → project commitment deposit (جدية حضور).** These are imported **once**, and only into projects that have no deposit yet. After that, deposits are recorded in the app.
- **Selection, Round and Explanation are not read from Description.** They were already imported through the main sheet, and decisions are now made in the app.
- **Not read:** `Interveiw Data` (a lookup helper), `Sheet6`, `Sheet5` (expenses) and `Sheet2` (round agenda).

The service account needs **Viewer** access on this sheet too.

## Phase 3: round attendance (Drive folder 02_Training)

Each round has its own `Attendance R_XX` sheet. The function reads its **Attendance** tab: D1–D5, consent form, post assessment, pass, business plan, 4.1 and Counted 4.4, plus Kobo code and Group (round 8). The sheet IDs are stored in `rounds.attendance_sheet_id`.

- **Who is read (`rounds.attendance_source`):**
  - `sheet`: read on every run. Used for rounds 8–10, which are still running.
  - `sheet_once`: read once, then switched to `app`. Used for the finished rounds 1–7. It only switches after a read that matched someone, so a broken tab is retried.
  - `app`: no longer read. Attendance is managed on the round's page in the app.
  - An admin can press **Manage in app** on a round page to stop reading its sheet. While a round is read from its sheet, its page is read-only, because the next sync would replace any edit.
- **Matching a row to a participant:**
  1. National ID anywhere in the round.
  2. If that fails, the name within the team with the row's code.
  3. If that fails, a name only one participant in the round has.
  - The code alone isn't trusted. From sheet row 8 on, round 9's codes are shifted by one against the imported enrollments.
  - Rows that still don't match are listed on **Data sync** as "Attendance sheet: nobody in the round…" with the sheet name and row number.
- **Indicators** (`v_participant_indicators` per person, `v_round_indicators` per round) follow the sheets' Counted columns:
  - **3.1:** two or more days attended and the consent form signed.
  - **3.2:** 3.1, plus the post assessment done and passed.
  - **3.3 and 3.4:** 3.2, plus the business plan submitted.
  - **4.1 and 4.4:** the sheet's 4.1 and Counted 4.4 flags.
  - Withdrawn enrollments are not counted.
- **Broken tabs:** if the tab starts with a formula error such as `#REF!`, the run reports it and skips that round. As of 2026-10-28, `Attendance R_05` shows `#REF!`. A tab showing `#N/A` means the round has nobody in it yet, and is skipped quietly.
- **Not read:** Analysis, Zoom Attendance Log, Keep hidden, and round 9's Day form tabs.

Each round sheet also needs the service account as **Viewer**.

## One-time setup (Google access)

1. Open https://console.cloud.google.com/ with the Google account that owns the sheet. Create a project, for example `athar-sheet-sync`.
2. Go to **APIs & Services → Library**, search for **Google Sheets API** and click **Enable**.
3. Go to **APIs & Services → Credentials → Create credentials → Service account**. Give it a name, for example `sheet-sync`, then click **Done**. No roles are needed.
4. Open the new service account, go to the **Keys** tab, and choose **Add key → Create new key → JSON**. A `.json` file downloads. Keep it private: don't email it or paste it into chat.
5. In **both** Google Sheets (Main MSMEs and Company Profile 2026), click **Share** and add the service account's e-mail (it ends in `iam.gserviceaccount.com`) as **Viewer**. Untick "Notify people".
6. In Supabase, open **Edge Functions → Secrets**: https://supabase.com/dashboard/project/bupgddkyfugczweqiotc/functions/secrets
   - Add a secret named `GOOGLE_SERVICE_ACCOUNT_JSON`.
   - For the value, open the downloaded `.json` file in Notepad and paste its **entire contents**.
   - Save.
7. In the app, open **Data sync**. The status should show the service account e-mail. Then click **Sync now**.

You can delete the downloaded `.json` file once the secret is saved.

## How it runs

| Part | Where |
|---|---|
| Edge Function | `supabase/functions/sheet-sync/index.ts` |
| Tables `sync_runs`, `sync_issues`; functions `sync_start`, `sync_finish`, `sync_known_keys`, `sync_ingest_row` | `supabase/migrations/20261028150808_sheet_sync.sql` |
| Schedule (pg_cron, every 15 minutes) | `supabase/migrations/20261028151051_sheet_sync_schedule.sql` |
| Attendance columns, `sync_round_attendance`, indicator views | `supabase/migrations/20261028161345_attendance_tracking.sql` and the three `2026102816*_attendance_*` / `round_indicators_view` migrations after it |

- **Who can run it:**
  - The schedule calls the function with the public anon key.
  - Staff with edit rights can press **Sync now**.
  - Viewers can see the page but can't run a sync.
- **No overlapping runs:** only one run at a time, and at most one start per minute.
- **Atomic rows:** each row is added in a single transaction, so a failing row is recorded and skipped without stopping the run.

To pause the schedule:

```sql
select cron.unschedule('sheet-sync');
```

To turn it back on, run the schedule migration again.
