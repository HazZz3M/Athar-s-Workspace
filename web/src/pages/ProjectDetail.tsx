import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../supabase';
import { STATUS_LABEL, fmtDate, fmtDateTime, humanize, maskId, type Status } from '../labels';

type Project = {
  id: number;
  code: string;
  name: string;
  description: string | null;
  status: Status;
  submitted_at: string;
  founded_on: string | null;
  social_url: string | null;
  university: string | null;
  track: string | null;
  sector_other: string | null;
  sector: { name_en: string } | null;
  stage: { name_en: string } | null;
  source: { name: string } | null;
  district: { name_ar: string } | null;
  governorate: { name_en: string } | null;
};
type Member = {
  id: number;
  position: number;
  is_lead: boolean;
  role: string | null;
  confirmation: string;
  notes: string | null;
  person: {
    full_name_ar: string;
    phone: string | null;
    email: string | null;
    national_id: string | null;
    gender: string | null;
    birthdate: string | null;
  };
};
type Interview = {
  id: number;
  scheduled_at: string | null;
  status: string;
  decision: string | null;
  reasons: string | null;
  notes: string | null;
};
type Review = { id: number; status: string; reviewed_at: string; notes: string | null };
type Issue = { noted_at: string; issue: { label_ar: string; label_en: string | null; is_disqualifying: boolean } };
type Enrollment = { id: number; code: string | null; status: string; round: { name: string; year: number; program: { name_en: string } | null } };
type Contact = { id: number; channel: string; attempted_at: string; outcome: string | null; notes: string | null };
type StatusEvent = { id: number; from_status: Status | null; to_status: Status; changed_at: string };

type Data = {
  project: Project;
  members: Member[];
  interviews: Interview[];
  reviews: Review[];
  issues: Issue[];
  enrollments: Enrollment[];
  contacts: Contact[];
  events: StatusEvent[];
};

const age = (birthdate: string | null) => {
  if (!birthdate) return '—';
  const b = new Date(birthdate);
  const now = new Date();
  return now.getFullYear() - b.getFullYear() - (now < new Date(now.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0);
};

export default function ProjectDetail() {
  const { id } = useParams();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showIds, setShowIds] = useState(false);

  useEffect(() => {
    const pid = Number(id);
    Promise.all([
      supabase
        .from('projects')
        .select(
          'id, code, name, description, status, submitted_at, founded_on, social_url, university, track, sector_other, sector:sectors(name_en), stage:project_stages(name_en), source:intake_sources(name), district:districts(name_ar), governorate:governorates(name_en)',
        )
        .eq('id', pid)
        .single(),
      supabase
        .from('project_members')
        .select(
          'id, position, is_lead, role, confirmation, notes, person:people(full_name_ar, phone, email, national_id, gender, birthdate)',
        )
        .eq('project_id', pid)
        .order('position'),
      supabase.from('interviews').select('id, scheduled_at, status, decision, reasons, notes').eq('project_id', pid).order('scheduled_at'),
      supabase.from('screening_reviews').select('id, status, reviewed_at, notes').eq('project_id', pid).order('reviewed_at'),
      supabase.from('project_issues').select('noted_at, issue:screening_issues(label_ar, label_en, is_disqualifying)').eq('project_id', pid),
      supabase
        .from('round_enrollments')
        .select('id, code, status, round:rounds(name, year, program:programs(name_en))')
        .eq('project_id', pid),
      supabase
        .from('contact_attempts')
        .select('id, channel, attempted_at, outcome, notes, member:project_members!inner(project_id)')
        .eq('member.project_id', pid)
        .order('attempted_at'),
      supabase.from('project_status_events').select('id, from_status, to_status, changed_at').eq('project_id', pid).order('changed_at'),
    ]).then((results) => {
      const failed = results.find((r) => r.error);
      if (failed) return setError(failed.error!.message);
      const [p, m, i, r, is, e, c, ev] = results.map((x) => x.data);
      setData({
        project: p as unknown as Project,
        members: m as unknown as Member[],
        interviews: i as Interview[],
        reviews: r as Review[],
        issues: is as unknown as Issue[],
        enrollments: e as unknown as Enrollment[],
        contacts: c as unknown as Contact[],
        events: ev as StatusEvent[],
      });
    });
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const { project: p } = data;

  return (
    <>
      <p>
        <Link to="/projects">← All projects</Link>
      </p>
      <div className="title-row">
        <h1 dir="auto">{p.name}</h1>
        <span className={`badge status-${p.status}`}>{STATUS_LABEL[p.status]}</span>
      </div>
      <p className="muted mono">{p.code}</p>

      <div className="grid">
        <Section title="Details">
          <dl>
            <Item label="Submitted">{fmtDate(p.submitted_at)}</Item>
            <Item label="Source">{p.source?.name}</Item>
            <Item label="Sector">{p.sector?.name_en ?? p.sector_other}</Item>
            {p.track && <Item label="Track">{p.track}</Item>}
            <Item label="Stage">{p.stage?.name_en}</Item>
            <Item label="Founded">{fmtDate(p.founded_on)}</Item>
            <Item label="Governorate">{p.governorate?.name_en}</Item>
            <Item label="District">{p.district?.name_ar}</Item>
            {p.university && <Item label="University">{p.university}</Item>}
            <Item label="Link">{p.social_url}</Item>
          </dl>
        </Section>

        <Section title="Round">
          {data.enrollments.length === 0 ? (
            <p className="muted">Not enrolled in a round.</p>
          ) : (
            data.enrollments.map((e) => (
              <dl key={e.id}>
                <Item label="Round">
                  {e.round.name} · {e.round.year}
                </Item>
                <Item label="Program">{e.round.program?.name_en}</Item>
                <Item label="Code">{e.code}</Item>
                <Item label="Status">{humanize(e.status)}</Item>
              </dl>
            ))
          )}
        </Section>
      </div>

      {p.description && (
        <Section title="Description">
          <p className="prose" dir="auto">
            {p.description}
          </p>
        </Section>
      )}

      <Section
        title={`Team (${data.members.length})`}
        action={
          <button className="link" onClick={() => setShowIds((v) => !v)}>
            {showIds ? 'Hide national IDs' : 'Show national IDs'}
          </button>
        }
      >
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>Phone</th>
              <th>Email</th>
              <th>National ID</th>
              <th>Gender</th>
              <th className="num">Age</th>
              <th>Confirmation</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.position}
                  {m.is_lead && <span className="tag">Lead</span>}
                </td>
                <td dir="auto">{m.person.full_name_ar}</td>
                <td className="mono">{m.person.phone ?? '—'}</td>
                <td>{m.person.email ?? '—'}</td>
                <td className="mono">{showIds ? m.person.national_id ?? '—' : maskId(m.person.national_id)}</td>
                <td>{humanize(m.person.gender)}</td>
                <td className="num">{age(m.person.birthdate)}</td>
                <td>{humanize(m.confirmation)}</td>
                <td dir="auto">{m.notes ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <div className="grid">
        <Section title="Screening">
          {data.reviews.length === 0 && data.contacts.length === 0 && data.issues.length === 0 ? (
            <p className="muted">No screening recorded.</p>
          ) : (
            <ul className="timeline">
              {data.contacts.map((c) => (
                <li key={`c${c.id}`}>
                  <b>{humanize(c.channel)}</b> · {fmtDate(c.attempted_at)}
                  {c.outcome && ` · ${humanize(c.outcome)}`}
                  {c.notes && <div className="muted">{c.notes}</div>}
                </li>
              ))}
              {data.reviews.map((r) => (
                <li key={`r${r.id}`}>
                  <b>Validation:</b> {humanize(r.status)} · {fmtDate(r.reviewed_at)}
                  {r.notes && <div className="muted">{r.notes}</div>}
                </li>
              ))}
              {data.issues.map((i, n) => (
                <li key={`i${n}`}>
                  <b>Issue:</b> <span dir="auto">{i.issue.label_en ?? i.issue.label_ar}</span>
                  {i.issue.is_disqualifying && <span className="tag danger">Disqualifying</span>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Interviews">
          {data.interviews.length === 0 ? (
            <p className="muted">No interviews.</p>
          ) : (
            <ul className="timeline">
              {data.interviews.map((i) => (
                <li key={i.id}>
                  <b>{fmtDateTime(i.scheduled_at)}</b> · {humanize(i.status)}
                  {i.decision && ` · Decision: ${humanize(i.decision)}`}
                  {i.reasons && (
                    <div className="muted" dir="auto">
                      {i.reasons}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title="Status history">
        <ul className="timeline">
          {data.events.map((e) => (
            <li key={e.id}>
              {fmtDateTime(e.changed_at)} ·{' '}
              {e.from_status ? `${STATUS_LABEL[e.from_status]} → ` : 'Imported as '}
              <b>{STATUS_LABEL[e.to_status]}</b>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd dir="auto">{children || '—'}</dd>
    </>
  );
}
