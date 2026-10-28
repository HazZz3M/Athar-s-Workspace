import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../supabase';
import { useAuth } from '../auth';
import { STATUS_LABEL, fmtDate, fmtDateTime, humanize, maskId, type Status } from '../labels';
import {
  ConfirmationSelect, ContactForm, DEPOSIT_LABEL, DepositEditor, DetailsEditor, EnrollForm, InterviewResult,
  InterviewScheduler, IssueAdder, ReviewForm, StatusEditor, WithdrawForm, removeIssue, type Lookup,
} from '../components/Editors';

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
  stage_id: number | null;
  sector_id: number | null;
  district_id: number | null;
  deposit_method: string | null;
  deposit_amount: number | null;
  deposit_note: string | null;
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
  person_id: number;
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
  round: { name: string } | null;
};
type Review = { id: number; status: string; reviewed_at: string; notes: string | null };
type Issue = { issue_id: number; noted_at: string; issue: { label_ar: string; label_en: string | null; is_disqualifying: boolean } };
type Enrollment = {
  id: number;
  code: string | null;
  status: string;
  withdraw_reason: string | null;
  round: { name: string; year: number; program: { name_en: string } | null };
};
type Contact = { id: number; channel: string; attempted_at: string; outcome: string | null; notes: string | null };
type StatusEvent = { id: number; from_status: Status | null; to_status: Status; changed_at: string; by: { full_name: string } | null };
type Profile = {
  id: number;
  submitted_at: string;
  summary: string | null;
  founders: number | null;
  female_founders: number | null;
  founders_under_35: number | null;
  employees: number | null;
  female_employees: number | null;
  freelancers: number | null;
  funding_amount: number | null;
  annual_revenue: number | null;
  monthly_income: number | null;
  answers: Record<string, string>;
};

type Data = {
  project: Project;
  members: Member[];
  interviews: Interview[];
  reviews: Review[];
  issues: Issue[];
  enrollments: Enrollment[];
  contacts: Contact[];
  events: StatusEvent[];
  profiles: Profile[];
};
type Lookups = { stages: Lookup[]; sectors: Lookup[]; districts: Lookup[]; issues: Lookup[]; rounds: Lookup[] };

const age = (birthdate: string | null) => {
  if (!birthdate) return '—';
  const b = new Date(birthdate);
  const now = new Date();
  return now.getFullYear() - b.getFullYear() - (now < new Date(now.getFullYear(), b.getMonth(), b.getDate()) ? 1 : 0);
};

export default function ProjectDetail() {
  const { id } = useParams();
  const { session, role } = useAuth();
  const canEdit = role === 'admin' || role === 'screener' || role === 'interviewer';
  const userId = session!.user.id;
  const pid = Number(id);

  const [data, setData] = useState<Data | null>(null);
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showIds, setShowIds] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      supabase
        .from('projects')
        .select(
          'id, code, name, description, status, submitted_at, founded_on, social_url, university, track, sector_other, stage_id, sector_id, district_id, deposit_method, deposit_amount, deposit_note, sector:sectors(name_en), stage:project_stages(name_en), source:intake_sources(name), district:districts(name_ar), governorate:governorates(name_en)',
        )
        .eq('id', pid)
        .single(),
      supabase
        .from('project_members')
        .select(
          'id, position, is_lead, role, confirmation, notes, person_id, person:people(full_name_ar, phone, email, national_id, gender, birthdate)',
        )
        .eq('project_id', pid)
        .order('position'),
      supabase
        .from('interviews')
        .select('id, scheduled_at, status, decision, reasons, notes, round:rounds(name)')
        .eq('project_id', pid)
        .order('scheduled_at'),
      supabase.from('screening_reviews').select('id, status, reviewed_at, notes').eq('project_id', pid).order('reviewed_at'),
      supabase
        .from('project_issues')
        .select('issue_id, noted_at, issue:screening_issues(label_ar, label_en, is_disqualifying)')
        .eq('project_id', pid),
      supabase
        .from('round_enrollments')
        .select('id, code, status, withdraw_reason, round:rounds(name, year, program:programs(name_en))')
        .eq('project_id', pid),
      supabase
        .from('contact_attempts')
        .select('id, channel, attempted_at, outcome, notes, member:project_members!inner(project_id)')
        .eq('member.project_id', pid)
        .order('attempted_at'),
      supabase
        .from('project_status_events')
        .select('id, from_status, to_status, changed_at, by:staff(full_name)')
        .eq('project_id', pid)
        .order('changed_at'),
      supabase
        .from('company_profiles')
        .select(
          'id, submitted_at, summary, founders, female_founders, founders_under_35, employees, female_employees, freelancers, funding_amount, annual_revenue, monthly_income, answers',
        )
        .eq('project_id', pid)
        .order('submitted_at', { ascending: false }),
    ]).then((results) => {
      const failed = results.find((r) => r.error);
      if (failed) return setError(failed.error!.message);
      const [p, m, i, r, is, e, c, ev, pr] = results.map((x) => x.data);
      setData({
        project: p as unknown as Project,
        members: m as unknown as Member[],
        interviews: i as unknown as Interview[],
        reviews: r as Review[],
        issues: is as unknown as Issue[],
        enrollments: e as unknown as Enrollment[],
        contacts: c as unknown as Contact[],
        events: ev as unknown as StatusEvent[],
        profiles: pr as Profile[],
      });
    });
  }, [pid]);

  useEffect(load, [load]);

  // Lists for the edit forms (only needed by staff who can edit)
  useEffect(() => {
    if (!canEdit) return;
    Promise.all([
      supabase.from('project_stages').select('id, name_en').order('rank'),
      supabase.from('sectors').select('id, name_en').order('sort'),
      supabase.from('districts').select('id, name_ar').order('name_ar'),
      supabase.from('screening_issues').select('id, label_en, label_ar').order('id'),
      supabase.from('rounds').select('id, name, year, program:programs(name_en)').order('year').order('number'),
    ]).then(([st, se, di, is, ro]) => {
      setLookups({
        stages: (st.data ?? []).map((x) => ({ id: x.id, label: x.name_en })),
        sectors: (se.data ?? []).map((x) => ({ id: x.id, label: x.name_en })),
        districts: (di.data ?? []).map((x) => ({ id: x.id, label: x.name_ar })),
        issues: (is.data ?? []).map((x) => ({ id: x.id, label: x.label_en ?? x.label_ar })),
        rounds: (ro.data ?? []).map((x) => ({
          id: x.id,
          label: `${x.name} · ${x.year} · ${(x.program as unknown as { name_en: string } | null)?.name_en ?? ''}`,
        })),
      });
    });
  }, [canEdit]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const { project: p } = data;
  const activeEnrollment = data.enrollments.find((e) => e.status !== 'withdrawn');
  const issueOptions = lookups?.issues.filter((o) => !data.issues.some((i) => i.issue_id === o.id)) ?? [];
  const memberOptions = data.members.map((m) => ({ id: m.id, label: `${m.position}. ${m.person.full_name_ar}` }));

  return (
    <>
      <p>
        <Link to="/projects">← All projects</Link>
      </p>
      <div className="title-row">
        <h1 dir="auto">{p.name}</h1>
        <span className={`badge status-${p.status}`}>{STATUS_LABEL[p.status]}</span>
        {canEdit && <StatusEditor key={p.status} projectId={p.id} status={p.status} onDone={load} />}
      </div>
      <p className="muted mono">{p.code}</p>

      <div className="grid">
        <Section
          title="Details"
          action={canEdit && !editing && lookups && <button className="link" onClick={() => setEditing(true)}>Edit</button>}
        >
          {editing && lookups ? (
            <DetailsEditor
              projectId={p.id}
              initial={{
                name: p.name, description: p.description, stage_id: p.stage_id, sector_id: p.sector_id,
                sector_other: p.sector_other, district_id: p.district_id, social_url: p.social_url,
              }}
              stages={lookups.stages}
              sectors={lookups.sectors}
              districts={lookups.districts}
              onCancel={() => setEditing(false)}
              onDone={() => { setEditing(false); load(); }}
            />
          ) : (
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
          )}
        </Section>

        <Section title="Round">
          {data.enrollments.length === 0 && <p className="muted">Not enrolled in a round.</p>}
          {data.enrollments.map((e) => (
            <dl key={e.id}>
              <Item label="Round">{e.round.name} · {e.round.year}</Item>
              <Item label="Program">{e.round.program?.name_en}</Item>
              <Item label="Code">{e.code}</Item>
              <Item label="Status">{humanize(e.status)}</Item>
              {e.withdraw_reason && <Item label="Reason">{e.withdraw_reason}</Item>}
            </dl>
          ))}
          <h3>Commitment deposit</h3>
          <dl>
            <Item label="Deposit">{p.deposit_method ? DEPOSIT_LABEL[p.deposit_method] : 'Not recorded'}</Item>
            {p.deposit_amount !== null && <Item label="Amount">{`${p.deposit_amount} EGP`}</Item>}
            {p.deposit_note && <Item label="Note">{p.deposit_note}</Item>}
          </dl>
          {canEdit && (
            <DepositEditor
              key={`${p.deposit_method}-${p.deposit_amount}-${p.deposit_note}`}
              projectId={p.id}
              method={p.deposit_method}
              amount={p.deposit_amount}
              note={p.deposit_note}
              onDone={load}
            />
          )}
          {canEdit && lookups && (activeEnrollment ? (
            <WithdrawForm enrollmentId={activeEnrollment.id} projectId={p.id} onDone={load} />
          ) : (
            <EnrollForm
              projectId={p.id}
              personIds={data.members.map((m) => m.person_id)}
              rounds={lookups.rounds}
              userId={userId}
              onDone={load}
            />
          ))}
        </Section>
      </div>

      {p.description && !editing && (
        <Section title="Description">
          <p className="prose" dir="auto">{p.description}</p>
        </Section>
      )}

      {data.profiles.map((pf) => <ProfileSection key={pf.id} profile={pf} />)}

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
                <td>
                  {canEdit ? (
                    <ConfirmationSelect memberId={m.id} value={m.confirmation} onDone={load} />
                  ) : (
                    humanize(m.confirmation)
                  )}
                </td>
                <td dir="auto">{m.notes ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <div className="grid">
        <Section title="Screening">
          {data.reviews.length === 0 && data.contacts.length === 0 && data.issues.length === 0 && (
            <p className="muted">No screening recorded.</p>
          )}
          <ul className="timeline">
            {data.contacts.map((c) => (
              <li key={`c${c.id}`}>
                <b>{humanize(c.channel)}</b> · {fmtDate(c.attempted_at)}
                {c.outcome && ` · ${humanize(c.outcome)}`}
                {c.notes && <div className="muted" dir="auto">{c.notes}</div>}
              </li>
            ))}
            {data.reviews.map((r) => (
              <li key={`r${r.id}`}>
                <b>Validation:</b> {humanize(r.status)} · {fmtDate(r.reviewed_at)}
                {r.notes && <div className="muted" dir="auto">{r.notes}</div>}
              </li>
            ))}
            {data.issues.map((i) => (
              <li key={`i${i.issue_id}`}>
                <b>Issue:</b> <span dir="auto">{i.issue.label_en ?? i.issue.label_ar}</span>
                {i.issue.is_disqualifying && <span className="tag danger">Disqualifying</span>}
                {canEdit && (
                  <button className="link" onClick={() => removeIssue(p.id, i.issue_id).then(load)}>Remove</button>
                )}
              </li>
            ))}
          </ul>
          {canEdit && lookups && (
            <div className="edit-stack">
              <ContactForm members={memberOptions} userId={userId} onDone={load} />
              <ReviewForm projectId={p.id} userId={userId} onDone={load} />
              <IssueAdder projectId={p.id} userId={userId} options={issueOptions} onDone={load} />
            </div>
          )}
        </Section>

        <Section title="Interviews">
          {data.interviews.length === 0 && <p className="muted">No interviews.</p>}
          <ul className="timeline">
            {data.interviews.map((i) => (
              <li key={i.id}>
                <b>{fmtDateTime(i.scheduled_at)}</b> · {humanize(i.status)}
                {i.decision && ` · Decision: ${humanize(i.decision)}`}
                {i.round && ` · Recommended: ${i.round.name}`}
                {i.reasons && <div className="muted" dir="auto">{i.reasons}</div>}
                {canEdit && lookups && i.status === 'scheduled' && (
                  <InterviewResult interviewId={i.id} rounds={lookups.rounds} onDone={load} />
                )}
              </li>
            ))}
          </ul>
          {canEdit && (
            <div className="edit-stack">
              <InterviewScheduler projectId={p.id} userId={userId} onDone={load} />
            </div>
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
              {e.by && <span className="muted"> · by {e.by.full_name}</span>}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

// Interview form (Company Profile sheet): summary, key numbers, all answers
function ProfileSection({ profile: pf }: { profile: Profile }) {
  const [open, setOpen] = useState(false);
  const money = (n: number | null) => (n === null ? null : `${n.toLocaleString()} EGP`);
  const stats: [string, ReactNode][] = [
    ['Founders', pf.founders],
    ['Female founders', pf.female_founders],
    ['Founders under 35', pf.founders_under_35],
    ['Employees', pf.employees],
    ['Female employees', pf.female_employees],
    ['Freelancers', pf.freelancers],
    ['Funding raised', money(pf.funding_amount)],
    ['Annual revenue', money(pf.annual_revenue)],
    ['Monthly income', money(pf.monthly_income)],
  ];
  return (
    <Section
      title={`Company profile · ${fmtDate(pf.submitted_at)}`}
      action={<button className="link" onClick={() => setOpen((v) => !v)}>{open ? 'Hide answers' : 'Show all answers'}</button>}
    >
      {pf.summary && <p className="prose" dir="auto">{pf.summary}</p>}
      <dl className="stats-dl">
        {stats.filter(([, v]) => v !== null).map(([k, v]) => <Item key={k} label={k}>{v}</Item>)}
      </dl>
      {open && (
        <dl className="answers">
          {Object.entries(pf.answers).map(([q, a]) => <Item key={q} label={q}>{a}</Item>)}
        </dl>
      )}
    </Section>
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
