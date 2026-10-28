# Sheet sync: Google Sheet → Supabase (one way)

The "Main MSMEs" Google Sheet stays the raw intake source. Every 15 minutes the `sheet-sync` Edge Function reads it and adds the **new** rows of `Total Responces` to Supabase as projects with status **New**, together with their team members. All follow-up work happens in the app.

- **Read-only.** The function uses a Google service account with Viewer access and the `spreadsheets.readonly` scope. It never writes to the sheet.
- **New rows only.** A row counts as already imported when a project with the same submitted time and project name exists. Existing projects are never updated from the sheet, so changes made in the app are kept.
- **Operational columns in Main are not synced.** Calls, interviews, selection and rounds are recorded in the app from now on.
- **Source per row.** The intake tabs' timestamps decide each project's source, the same way the original import did (`docs/import-plan.md` §2).
- **Data issues.** Rows with problems are still added. The problem is listed on the app's **Data sync** page by sheet row number, with no names or IDs. Examples: an invalid phone, a missing or invalid national ID, an ID that belongs to another person with a different name.

## One-time setup (Google access)

1. Open https://console.cloud.google.com/ with the Google account that owns the sheet. Create a project, for example `athar-sheet-sync`.
2. Go to **APIs & Services → Library**, search for **Google Sheets API** and click **Enable**.
3. Go to **APIs & Services → Credentials → Create credentials → Service account**. Give it a name, for example `sheet-sync`, then click **Done**. No roles are needed.
4. Open the new service account, go to the **Keys** tab, and choose **Add key → Create new key → JSON**. A `.json` file downloads. Keep it private: don't email it or paste it into chat.
5. In the Google Sheet, click **Share** and add the service account's e-mail (it ends in `iam.gserviceaccount.com`) as **Viewer**. Untick "Notify people".
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
