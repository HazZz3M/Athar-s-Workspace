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
  error: string | null;
};
type Issue = {
  id: number;
  kind: string;
  sheet_row: number | null;
  created_at: string;
  project: { id: number; code: string; name: string } | null;
};
type Check = { configured: boolean; service_account: string | null };

const ISSUE_LABEL: Record<string, string> = {
  id_conflict: 'Same national ID as another person with a different name (ID kept on the first person only)',
  duplicate_member_skipped: 'Same person listed twice in one team (second one skipped)',
  invalid_phone: 'Phone number not readable (left empty)',
  invalid_national_id: 'National ID is not a valid 14-digit ID',
  missing_national_id: 'A member has no national ID',
  no_members: 'No team members in the row',
  unreadable_timestamp: 'Timestamp not readable (row not added)',
  row_failed: 'Row could not be added',
};

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
        .select('id, started_at, finished_at, trigger, status, rows_read, rows_new, rows_failed, error')
        .order('started_at', { ascending: false })
        .limit(20),
      supabase
        .from('sync_issues')
        .select('id, kind, sheet_row, created_at, project:projects(id, code, name)')
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
    else setMessage(`Done: ${data.rows_new} new project(s) added from ${data.rows_read} sheet rows.`);
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
        New rows in the Google Sheet are added here every 15 minutes as new projects. The sheet is only read, never
        changed, and edits made in this app are never overwritten.
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
                  <th className="num">New</th>
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
                  {i.project ? <Link to={`/projects/${i.project.id}`}>{i.project.name}</Link> : '—'}
                </td>
                <td>{ISSUE_LABEL[i.kind] ?? humanize(i.kind)}</td>
                <td className="num">{i.sheet_row ?? '—'}</td>
                <td>{fmtDateTime(i.created_at)}</td>
                {canEdit && (
                  <td>
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
