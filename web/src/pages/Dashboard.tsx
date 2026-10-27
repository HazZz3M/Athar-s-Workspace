import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { STATUSES, STATUS_LABEL, fmtDate, type Status } from '../labels';

type FunnelRow = { status: Status; projects: number; individuals: number; male: number; female: number };
type RoundRow = {
  id: number;
  name: string;
  year: number;
  starts_on: string | null;
  ends_on: string | null;
  capacity: number | null;
  program: { name_en: string } | null;
  round_enrollments: { count: number }[];
};

export default function Dashboard() {
  const [funnel, setFunnel] = useState<FunnelRow[] | null>(null);
  const [rounds, setRounds] = useState<RoundRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      supabase.from('v_funnel').select('status, projects, individuals, male, female'),
      supabase
        .from('rounds')
        .select('id, name, year, starts_on, ends_on, capacity, program:programs(name_en), round_enrollments(count)')
        .order('year')
        .order('number'),
    ]).then(([f, r]) => {
      if (f.error || r.error) return setError((f.error ?? r.error)!.message);
      setFunnel(f.data as FunnelRow[]);
      setRounds(r.data as unknown as RoundRow[]);
    });
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!funnel || !rounds) return <p className="muted">Loading…</p>;

  const byStatus = new Map(funnel.map((r) => [r.status, r]));
  const total = funnel.reduce((s, r) => s + r.projects, 0);
  const people = funnel.reduce((s, r) => s + r.individuals, 0);

  return (
    <>
      <h1>Dashboard</h1>

      <div className="stats">
        <div className="stat">
          <span className="stat-value">{total.toLocaleString()}</span>
          <span className="stat-label">Projects</span>
        </div>
        <div className="stat">
          <span className="stat-value">{people.toLocaleString()}</span>
          <span className="stat-label">Team members</span>
        </div>
        <div className="stat">
          <span className="stat-value">{(byStatus.get('enrolled')?.projects ?? 0).toLocaleString()}</span>
          <span className="stat-label">Enrolled in a round</span>
        </div>
      </div>

      <h2>Pipeline</h2>
      <div className="funnel">
        {STATUSES.map((s) => {
          const row = byStatus.get(s);
          const n = row?.projects ?? 0;
          return (
            <Link key={s} to={`/projects?status=${s}`} className="funnel-row">
              <span className={`badge status-${s}`}>{STATUS_LABEL[s]}</span>
              <span className="bar">
                <span style={{ width: `${total ? (n / total) * 100 : 0}%` }} />
              </span>
              <span className="num">{n.toLocaleString()}</span>
              <span className="num muted">{(row?.individuals ?? 0).toLocaleString()} people</span>
            </Link>
          );
        })}
      </div>

      <h2>Rounds</h2>
      <table>
        <thead>
          <tr>
            <th>Round</th>
            <th>Program</th>
            <th>Dates</th>
            <th className="num">Enrolled projects</th>
          </tr>
        </thead>
        <tbody>
          {rounds.map((r) => (
            <tr key={r.id}>
              <td>
                {r.name} · {r.year}
              </td>
              <td>{r.program?.name_en ?? '—'}</td>
              <td>
                {fmtDate(r.starts_on)} – {fmtDate(r.ends_on)}
              </td>
              <td className="num">
                {r.round_enrollments[0]?.count ?? 0}
                {r.capacity ? <span className="muted"> / {r.capacity}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
