import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '../supabase';
import { STATUSES, STATUS_LABEL, fmtDate, type Status } from '../labels';

const PAGE = 50;

type Row = {
  id: number;
  code: string;
  name: string;
  status: Status;
  submitted_at: string;
  sector: { name_en: string } | null;
  stage: { name_en: string } | null;
  source: { name: string } | null;
};

export default function Projects() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const q = params.get('q') ?? '';
  const page = Number(params.get('page') ?? 0);

  const [search, setSearch] = useState(q);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [count, setCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const update = (next: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) v ? p.set(k, v) : p.delete(k);
    setParams(p);
  };

  // Search box updates the URL after a short pause
  useEffect(() => {
    const t = setTimeout(() => search !== q && update({ q: search, page: '' }), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setRows(null);
    let query = supabase
      .from('projects')
      .select(
        'id, code, name, status, submitted_at, sector:sectors(name_en), stage:project_stages(name_en), source:intake_sources(name)',
        { count: 'exact' },
      )
      .order('submitted_at', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (status) query = query.eq('status', status);
    // Characters that would break PostgREST's or() syntax are dropped
    const term = q.replace(/[,()*%\\]/g, ' ').trim();
    if (term) query = query.or(`name.ilike.*${term}*,code.ilike.*${term}*`);
    query.then(({ data, count, error }) => {
      if (error) return setError(error.message);
      setError(null);
      setRows(data as unknown as Row[]);
      setCount(count ?? 0);
    });
  }, [status, q, page]);

  const pages = Math.max(1, Math.ceil(count / PAGE));

  return (
    <>
      <h1>Projects</h1>
      <div className="filters">
        <input
          type="search"
          placeholder="Search by name or code…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          dir="auto"
        />
        <select value={status} onChange={(e) => update({ status: e.target.value, page: '' })}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <span className="muted">{count.toLocaleString()} projects</span>
      </div>

      {error && <p className="error">{error}</p>}
      {!rows ? (
        <p className="muted">Loading…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Project</th>
              <th>Status</th>
              <th>Sector</th>
              <th>Stage</th>
              <th>Source</th>
              <th>Submitted</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono">
                  <Link to={`/projects/${r.id}`}>{r.code}</Link>
                </td>
                <td dir="auto">
                  <Link to={`/projects/${r.id}`}>{r.name}</Link>
                </td>
                <td>
                  <span className={`badge status-${r.status}`}>{STATUS_LABEL[r.status]}</span>
                </td>
                <td>{r.sector?.name_en ?? '—'}</td>
                <td>{r.stage?.name_en ?? '—'}</td>
                <td>{r.source?.name ?? '—'}</td>
                <td>{fmtDate(r.submitted_at)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  No projects match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      <div className="pager">
        <button disabled={page === 0} onClick={() => update({ page: String(page - 1) })}>
          ← Previous
        </button>
        <span className="muted">
          Page {page + 1} of {pages}
        </span>
        <button disabled={page + 1 >= pages} onClick={() => update({ page: String(page + 1) })}>
          Next →
        </button>
      </div>
    </>
  );
}
