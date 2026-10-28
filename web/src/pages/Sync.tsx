import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import { fmtDateTime, humanize } from '../labels';

type Run = {
  id: number;
  started_at: string;
  finished_at: string | null;
  trigger: string;
  status: string;
  rows_read: number | null;
  rows_new: number | null;
  rows_failed: number | null;
  profiles_new: number | null;
  error: string | null;
};
type Issue = {
  id: number;
  kind: string;
  sheet_row: number | null;
  sheet_label: string | null;
  created_at: string;
  project: { id: number; code: string; name: string } | null;
  profile: { id: number; project_name: string } | null;
};
type Check = { configured: boolean; service_account: string | null };

const ISSUE_LABEL: Record<string, string> = {
  id_name_mismatch: 'National ID already known under a differently written name (linked to that person; check the name)',
  id_conflict: 'Same national ID as another person with a different name (ID kept on the first person only)',
  duplicate_member_skipped: 'Same person listed twice in one team (second one skipped)',
  invalid_phone: 'Phone number not readable (left empty)',
  invalid_national_id: 'National ID is not a valid 14-digit ID',
  missing_national_id: 'A member has no national ID',
  no_members: 'No team members in the row',
  unreadable_timestamp: 'Timestamp not readable (row not added)',
  row_failed: 'Row could not be added',
  profile_unmatched: 'Interview form: no project with this name (link it to the right project)',
  profile_ambiguous: 'Interview form: several projects have this name (link it to the right one)',
  profile_failed: 'Interview form row could not be added',
  assessment_unmatched: 'Post assessment: nobody in the round has this national ID, Kobo code, phone or name (link it on the round page)',
  attendance_unmatched: 'Attendance sheet: nobody in the round has this national ID or name (add them to the round or fix the row)',
};

// Link an interview-form profile to a project by its code, e.g. DAAP0123MSMES
function LinkProfile({ issueId, profileId, onDone }: { issueId: number; profileId: number; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const link = async () => {
    setError(null);
    const { data: project } = await supabase.from('projects').select('id').eq('code', code.trim().toUpperCase()).maybeSingle();
    if (!project) return setError('No project with that code');
    const res = await supabase.from('company_profiles').update({ project_id: project.id }).eq('id', profileId);
    if (res.error) return setError(res.error.message);
    await supabase.from('sync_issues').update({ resolved: true }).eq('id', issueId);
    onDone();
  };
  return (
    <span className="inline-form">
      <input className="compact" placeholder="DAAP0123MSMES" value={code} onChange={(e) => setCode(e.target.value)} />
      <button className="link" onClick={link} disabled={!code.trim()}>Link</button>
      {error && <span className="error small">{error}</span>}
    </span>
  );
}

export default function Sync() {
  const { role } = useAuth();
  const canEdit = role !== 'viewer';
  const [check, setCheck] = useState<Check | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [r, i] = await Promise.all([
      supabase
        .from('sync_runs')
        .select('id, started_at, finished_at, trigger, status, rows_read, rows_new, rows_failed, profiles_new, error')
        .order('started_at', { ascending: false })
        .limit(20),
      supabase
        .from('sync_issues')
        .select('id, kind, sheet_row, sheet_label, created_at, project:projects(id, code, name), profile:company_profiles(id, project_name)')
        .eq('resolved', false)
        .order('created_at', { ascending: false })
        .limit(200),
    ]);
    if (r.error || i.error) return setError((r.error ?? i.error)!.message);
    setRuns(r.data as Run[]);
    setIssues(i.data as unknown as Issue[]);
  };

  useEffect(() => {
    load();
    supabase.functions.invoke('sheet-sync', { body: { check: true } }).then(({ data }) => setCheck(data as Check));
  }, []);

  const syncNow = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    const { data, error } = await supabase.functions.invoke('sheet-sync', { body: {} });
    if (error) {
      // The function puts the reason in the response body
      const body = await (error as { context?: Response }).context?.json?.().catch(() => null);
      setError(body?.error ?? error.message);
    } else if (data?.skipped) setMessage(data.skipped);
    else {
      setMessage(
        `Done: ${data.rows_new} new project(s) from ${data.rows_read} intake rows, ${data.profiles_new ?? 0} new interview profile(s).`,
      );
      if (data.error) setError(data.error);
    }
    setBusy(false);
    load();
  };

  const resolve = async (id: number) => {
    const { error } = await supabase.from('sync_issues').update({ resolved: true }).eq('id', id);
    if (error) return setError(error.message);
    setIssues((list) => list?.filter((x) => x.id !== id) ?? null);
  };

  const last = runs?.find((r) => r.status !== 'running');

  return (
    <>
      <h1>Data sync</h1>
      <p className="muted">
        Every 15 minutes the app reads the Google Sheets: new intake rows (Main MSMEs) become new projects, new
        interview forms (Company Profile) are added to their projects, and rounds still read from their attendance
        sheet get their attendance and indicators. The sheets are only read, never changed, and edits
        made in this app are never overwritten.
      </p>

      <div className="grid">
        <section className="card">
          <div className="card-head">
            <h2>Status</h2>
            {canEdit && (
              <button onClick={syncNow} disabled={busy || check?.configured === false}>
                {busy ? 'Syncing…' : 'Sync now'}
              </button>
            )}
          </div>
          {!check ? (
            <p className="muted">Checking…</p>
          ) : !check.configured ? (
            <div className="notice">
              <b>Google access is not set up yet.</b> The sync needs a Google service account with Viewer access to the
              sheet. See the setup steps in <span className="mono">docs/sheet-sync.md</span>.
            </div>
          ) : (
            <dl>
              <dt>Reads as</dt>
              <dd className="mono">{check.service_account}</dd>
              <dt>Last sync</dt>
              <dd>{last ? `${fmtDateTime(last.finished_at ?? last.started_at)} · ${humanize(last.status)}` : 'Not run yet'}</dd>
              <dt>Schedule</dt>
              <dd>Every 15 minutes</dd>
            </dl>
          )}
          {message && <p>{message}</p>}
          {error && <p className="error">{error}</p>}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Recent runs</h2>
          </div>
          {!runs ? (
            <p className="muted">Loading…</p>
          ) : runs.length === 0 ? (
            <p className="muted">No sync has run yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>How</th>
                  <th>Result</th>
                  <th className="num">New projects</th>
                  <th className="num">New profiles</th>
                  <th className="num">Failed</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDateTime(r.started_at)}</td>
                    <td>{r.trigger === 'manual' ? 'Sync now' : 'Schedule'}</td>
                    <td>
                      <span className={`badge sync-${r.status}`}>{humanize(r.status)}</span>
                      {r.error && <div className="muted small">{r.error}</div>}
                    </td>
                    <td className="num">{r.rows_new ?? '—'}</td>
                    <td className="num">{r.profiles_new ?? '—'}</td>
                    <td className="num">{r.rows_failed ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <h2>Data issues to review ({issues?.length ?? 0})</h2>
      {!issues ? (
        <p className="muted">Loading…</p>
      ) : issues.length === 0 ? (
        <p className="muted">Nothing to review.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Issue</th>
              <th className="num">Sheet row</th>
              <th>Found</th>
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {issues.map((i) => (
              <tr key={i.id}>
                <td dir="auto">
                  {i.project ? (
                    <Link to={`/projects/${i.project.id}`}>{i.project.name}</Link>
                  ) : (
                    i.profile?.project_name ?? i.sheet_label ?? '—'
                  )}
                </td>
                <td>{ISSUE_LABEL[i.kind] ?? humanize(i.kind)}</td>
                <td className="num">{i.sheet_row ?? '—'}</td>
                <td>{fmtDateTime(i.created_at)}</td>
                {canEdit && (
                  <td>
                    {i.profile && i.kind.startsWith('profile_') && i.kind !== 'profile_failed' && (
                      <LinkProfile issueId={i.id} profileId={i.profile.id} onDone={load} />
                    )}
                    <button className="link" onClick={() => resolve(i.id)}>
                      Mark resolved
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
