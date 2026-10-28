import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { fmtDate } from '../labels';

export type Indicators = {
  round_id: number;
  participants: number;
  attended_any: number;
  counted_3_1: number;
  counted_3_2: number;
  counted_3_3: number;
  counted_3_4: number;
  counted_4_1: number;
  counted_4_4: number;
};
type RoundRow = {
  id: number;
  name: string;
  year: number;
  starts_on: string | null;
  ends_on: string | null;
  attendance_source: 'sheet' | 'sheet_once' | 'app';
  program: { name_en: string } | null;
};

export const SOURCE_LABEL: Record<RoundRow['attendance_source'], string> = {
  sheet: 'From the sheet',
  sheet_once: 'From the sheet (one import)',
  app: 'Managed in app',
};

export const KPIS: [keyof Indicators, string][] = [
  ['counted_3_1', '3.1'],
  ['counted_3_2', '3.2'],
  ['counted_3_3', '3.3'],
  ['counted_3_4', '3.4'],
  ['counted_4_1', '4.1'],
  ['counted_4_4', '4.4'],
];

export default function Rounds() {
  const [rounds, setRounds] = useState<RoundRow[] | null>(null);
  const [kpis, setKpis] = useState<Map<number, Indicators>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      supabase
        .from('rounds')
        .select('id, name, year, starts_on, ends_on, attendance_source, program:programs(name_en)')
        .order('year')
        .order('number'),
      supabase.from('v_round_indicators').select('*'),
    ]).then(([r, k]) => {
      if (r.error || k.error) return setError((r.error ?? k.error)!.message);
      setRounds(r.data as unknown as RoundRow[]);
      setKpis(new Map((k.data as Indicators[]).map((x) => [x.round_id, x])));
    });
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!rounds) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1>Rounds</h1>
      <p className="muted">
        Training attendance and indicators per round. Columns 3.1–4.4 count participants as the round sheets do
        (3.1: two or more days and consent; 3.2: also passed the post assessment; 3.3/3.4: also a business plan).
      </p>
      <table>
        <thead>
          <tr>
            <th>Round</th>
            <th>Program</th>
            <th>Dates</th>
            <th>Attendance</th>
            <th className="num">Participants</th>
            <th className="num">Attended</th>
            {KPIS.map(([k, label]) => (
              <th key={k} className="num">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rounds.map((r) => {
            const k = kpis.get(r.id);
            return (
              <tr key={r.id}>
                <td>
                  <Link to={`/rounds/${r.id}`}>{r.name}</Link> · {r.year}
                </td>
                <td>{r.program?.name_en ?? '—'}</td>
                <td>
                  {fmtDate(r.starts_on)} – {fmtDate(r.ends_on)}
                </td>
                <td>
                  <span className={`badge source-${r.attendance_source}`}>{SOURCE_LABEL[r.attendance_source]}</span>
                </td>
                <td className="num">{k?.participants ?? 0}</td>
                <td className="num">{k?.attended_any ?? 0}</td>
                {KPIS.map(([key]) => (
                  <td key={key} className="num">
                    {k?.[key] ?? 0}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
