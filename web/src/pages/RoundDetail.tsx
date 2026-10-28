import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import { fmtDate } from '../labels';
import { KPIS, SOURCE_LABEL, type Indicators } from './Rounds';

type Round = {
  id: number;
  name: string;
  year: number;
  starts_on: string | null;
  ends_on: string | null;
  attendance_source: 'sheet' | 'sheet_once' | 'app';
};
type Flag =
  | 'consent_signed'
  | 'post_assessment_done'
  | 'post_assessment_passed'
  | 'business_plan_submitted'
  | 'indicator_4_1'
  | 'employment_yes';
type Participant = {
  id: number;
  group_label: string | null;
  person: { full_name_ar: string | null } | null;
  enrollment: { code: string; status: string; project: { id: number; name: string } | null };
} & Record<Flag, boolean>;
type Session = { id: number; day_number: number };
type PersonKpi = { participant_id: number; attended_days: number } & Record<string, unknown>;

const FLAGS: [Flag, string][] = [
  ['consent_signed', 'Consent'],
  ['post_assessment_done', 'Post assessment'],
  ['post_assessment_passed', 'Passed'],
  ['business_plan_submitted', 'Business plan'],
  ['indicator_4_1', '4.1'],
  ['employment_yes', '4.4'],
];
const PRESENT = new Set(['present', 'late']);

// PostgREST returns at most 1000 rows per request
async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

export default function RoundDetail() {
  const id = Number(useParams().id);
  const { role } = useAuth();
  const [round, setRound] = useState<Round | null>(null);
  const [people, setPeople] = useState<Participant[] | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [marks, setMarks] = useState<Map<string, string>>(new Map()); // `${participant}:${session}` -> status
  const [kpis, setKpis] = useState<Indicators | null>(null);
  const [days, setDays] = useState<Map<number, number>>(new Map());
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadKpis = async () => {
    const [k, p] = await Promise.all([
      supabase.from('v_round_indicators').select('*').eq('round_id', id).maybeSingle(),
      supabase.from('v_participant_indicators').select('participant_id, attended_days').eq('round_id', id).limit(1000),
    ]);
    if (k.error || p.error) return setError((k.error ?? p.error)!.message);
    setKpis(k.data as Indicators);
    setDays(new Map((p.data as PersonKpi[]).map((x) => [x.participant_id, x.attended_days])));
  };

  useEffect(() => {
    (async () => {
      try {
        const [r, s] = await Promise.all([
          supabase.from('rounds').select('id, name, year, starts_on, ends_on, attendance_source').eq('id', id).single(),
          supabase.from('sessions').select('id, day_number').eq('round_id', id).order('day_number'),
        ]);
        if (r.error || s.error) throw new Error((r.error ?? s.error)!.message);
        const list = await fetchAll<Participant>((from, to) =>
          supabase
            .from('round_participants')
            .select(
              `id, group_label, ${FLAGS.map(([f]) => f).join(', ')},
               person:people(full_name_ar),
               enrollment:round_enrollments!inner(code, status, round_id, project:projects(id, name))`,
            )
            .eq('enrollment.round_id', id)
            .order('id')
            .range(from, to) as unknown as PromiseLike<{ data: Participant[] | null; error: { message: string } | null }>,
        );
        const ids = (s.data as Session[]).map((x) => x.id);
        const att = ids.length
          ? await fetchAll<{ session_id: number; participant_id: number; status: string }>((from, to) =>
              supabase.from('attendance').select('session_id, participant_id, status').in('session_id', ids).range(from, to),
            )
          : [];
        list.sort((a, b) => a.enrollment.code.localeCompare(b.enrollment.code) || a.id - b.id);
        setRound(r.data as Round);
        setSessions(s.data as Session[]);
        setPeople(list);
        setMarks(new Map(att.map((a) => [`${a.participant_id}:${a.session_id}`, a.status])));
        await loadKpis();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [id]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!people || !q) return people ?? [];
    return people.filter(
      (p) =>
        p.enrollment.code.toLowerCase().includes(q) ||
        (p.person?.full_name_ar ?? '').toLowerCase().includes(q) ||
        (p.enrollment.project?.name ?? '').toLowerCase().includes(q),
    );
  }, [people, search]);

  if (error) return <p className="error">{error}</p>;
  if (!round || !people) return <p className="muted">Loading…</p>;

  // While the sheet is the source, edits here would be replaced on the next sync
  const editable = round.attendance_source === 'app' && role !== 'viewer';

  const manageInApp = async () => {
    if (!confirm('Stop reading this round from its sheet? Attendance will then be managed only in this app.')) return;
    const { error } = await supabase.from('rounds').update({ attendance_source: 'app' }).eq('id', id);
    if (error) return setError(error.message);
    setRound({ ...round, attendance_source: 'app' });
  };

  const toggleDay = async (p: Participant, s: Session) => {
    const key = `${p.id}:${s.id}`;
    const status = PRESENT.has(marks.get(key) ?? '') ? 'absent' : 'present';
    const { error } = await supabase
      .from('attendance')
      .upsert({ session_id: s.id, participant_id: p.id, status, marked_at: new Date().toISOString() });
    if (error) return setError(error.message);
    setMarks(new Map(marks).set(key, status));
    loadKpis();
  };

  const toggleFlag = async (p: Participant, f: Flag) => {
    const { error } = await supabase
      .from('round_participants')
      .update({ [f]: !p[f], updated_at: new Date().toISOString() })
      .eq('id', p.id);
    if (error) return setError(error.message);
    setPeople(people.map((x) => (x.id === p.id ? { ...x, [f]: !p[f] } : x)));
    loadKpis();
  };

  return (
    <>
      <p>
        <Link to="/rounds">← Rounds</Link>
      </p>
      <div className="title-row">
        <h1>
          {round.name} · {round.year}
        </h1>
        <span className={`badge source-${round.attendance_source}`}>{SOURCE_LABEL[round.attendance_source]}</span>
        {round.attendance_source !== 'app' && role === 'admin' && (
          <button className="secondary" onClick={manageInApp}>
            Manage in app
          </button>
        )}
      </div>
      <p className="muted">
        {fmtDate(round.starts_on)} – {fmtDate(round.ends_on)}
        {round.attendance_source !== 'app' &&
          ' · Read from the round’s attendance sheet every 15 minutes; editing opens once it is managed in the app.'}
      </p>

      <div className="stats">
        <div className="stat">
          <span className="stat-value">{kpis?.participants ?? 0}</span>
          <span className="stat-label">Participants</span>
        </div>
        <div className="stat">
          <span className="stat-value">{kpis?.attended_any ?? 0}</span>
          <span className="stat-label">Attended at least one day</span>
        </div>
        {KPIS.map(([k, label]) => (
          <div className="stat" key={k}>
            <span className="stat-value">{kpis?.[k] ?? 0}</span>
            <span className="stat-label">Counted {label}</span>
          </div>
        ))}
      </div>

      <h2>Attendance ({shown.length})</h2>
      <div className="filters">
        <input placeholder="Search name, code or project" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {people.length === 0 ? (
        <p className="muted">No participants in this round yet.</p>
      ) : (
        <table className="grid-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Project</th>
              {sessions.map((s) => (
                <th key={s.id} className="center-cell">
                  D{s.day_number}
                </th>
              ))}
              <th className="num">Days</th>
              {FLAGS.map(([f, label]) => (
                <th key={f} className="center-cell">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id}>
                <td className="mono">
                  {p.enrollment.code}
                  {p.group_label && <span className="tag">{p.group_label}</span>}
                  {p.enrollment.status === 'withdrawn' && <span className="tag danger">withdrawn, not counted</span>}
                </td>
                <td dir="auto">{p.person?.full_name_ar ?? '—'}</td>
                <td dir="auto">
                  {p.enrollment.project ? (
                    <Link to={`/projects/${p.enrollment.project.id}`}>{p.enrollment.project.name}</Link>
                  ) : (
                    '—'
                  )}
                </td>
                {sessions.map((s) => (
                  <td key={s.id} className="center-cell">
                    <input
                      type="checkbox"
                      checked={PRESENT.has(marks.get(`${p.id}:${s.id}`) ?? '')}
                      disabled={!editable}
                      onChange={() => toggleDay(p, s)}
                      aria-label={`Day ${s.day_number}`}
                    />
                  </td>
                ))}
                <td className="num">{days.get(p.id) ?? 0}</td>
                {FLAGS.map(([f, label]) => (
                  <td key={f} className="center-cell">
                    <input
                      type="checkbox"
                      checked={p[f]}
                      disabled={!editable}
                      onChange={() => toggleFlag(p, f)}
                      aria-label={label}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
