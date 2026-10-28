// Small edit forms for the project page. Each one writes a single change and
// calls onDone() so the page reloads. Row Level Security decides who may write
// (admin, screener, interviewer); the page hides these forms for viewers.
import { useState, type FormEvent, type ReactNode } from 'react';
import { supabase } from '../supabase';
import { STATUSES, STATUS_LABEL, type Status } from '../labels';

export type Lookup = { id: number; label: string };

function useSave(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => PromiseLike<{ error: { message: string } | null }>) => {
    setBusy(true);
    setError(null);
    const { error } = await fn();
    setBusy(false);
    if (error) setError(error.message);
    else onDone();
    return !error;
  };
  return { busy, error, run };
}

// `disabled` blocks submitting (nothing to save yet); `busy` means a save is running
function Form({ onSubmit, busy, disabled = false, error, label, children }: {
  onSubmit: () => void; busy: boolean; disabled?: boolean; error: string | null; label: string; children: ReactNode;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!busy && !disabled) onSubmit();
  };
  return (
    <form className="edit-form" onSubmit={submit}>
      {children}
      <button type="submit" disabled={busy || disabled}>{busy ? 'Saving…' : label}</button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

// ---------------------------------------------------------------------
export function StatusEditor({ projectId, status, onDone }: { projectId: number; status: Status; onDone: () => void }) {
  const [value, setValue] = useState<Status>(status);
  const { busy, error, run } = useSave(onDone);
  return (
    <Form
      label="Change status"
      busy={busy}
      disabled={value === status}
      error={error}
      onSubmit={() => run(() => supabase.from('projects').update({ status: value }).eq('id', projectId))}
    >
      <select value={value} onChange={(e) => setValue(e.target.value as Status)}>
        {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
      </select>
    </Form>
  );
}

// ---------------------------------------------------------------------
export type ProjectFields = {
  name: string;
  description: string | null;
  stage_id: number | null;
  sector_id: number | null;
  sector_other: string | null;
  district_id: number | null;
  social_url: string | null;
};

export function DetailsEditor({ projectId, initial, stages, sectors, districts, onDone, onCancel }: {
  projectId: number; initial: ProjectFields; stages: Lookup[]; sectors: Lookup[]; districts: Lookup[];
  onDone: () => void; onCancel: () => void;
}) {
  const [f, setF] = useState(initial);
  const set = (k: keyof ProjectFields) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value === '' ? null : ['stage_id', 'sector_id', 'district_id'].includes(k) ? Number(e.target.value) : e.target.value });
  const { busy, error, run } = useSave(onDone);
  const pick = (k: 'stage_id' | 'sector_id' | 'district_id', list: Lookup[]) => (
    <select value={f[k] ?? ''} onChange={set(k)}>
      <option value="">—</option>
      {list.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
    </select>
  );
  return (
    <Form label="Save details" busy={busy} error={error}
      onSubmit={() => run(() => supabase.from('projects').update({ ...f, name: f.name.trim() || initial.name }).eq('id', projectId))}>
      <label>Project name<input value={f.name} onChange={set('name')} dir="auto" required /></label>
      <label>Stage{pick('stage_id', stages)}</label>
      <label>Sector{pick('sector_id', sectors)}</label>
      <label>Sector (other)<input value={f.sector_other ?? ''} onChange={set('sector_other')} dir="auto" /></label>
      <label>District{pick('district_id', districts)}</label>
      <label>Link<input value={f.social_url ?? ''} onChange={set('social_url')} /></label>
      <label>Description<textarea rows={5} value={f.description ?? ''} onChange={set('description')} dir="auto" /></label>
      <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
    </Form>
  );
}

// ---------------------------------------------------------------------
export function ContactForm({ members, userId, onDone }: {
  members: { id: number; label: string }[]; userId: string; onDone: () => void;
}) {
  const [member, setMember] = useState(members[0]?.id ?? 0);
  const [channel, setChannel] = useState('call');
  const [outcome, setOutcome] = useState('reached');
  const [notes, setNotes] = useState('');
  const { busy, error, run } = useSave(() => { setNotes(''); onDone(); });
  if (!members.length) return null;
  return (
    <Form label="Log contact" busy={busy} error={error}
      onSubmit={() => run(() => supabase.from('contact_attempts').insert({
        project_member_id: member, channel, outcome, notes: notes.trim() || null, staff_id: userId,
      }))}>
      <div className="row">
        <select value={member} onChange={(e) => setMember(Number(e.target.value))}>
          {members.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="call">Call</option><option value="whatsapp">WhatsApp</option>
          <option value="sms">SMS</option><option value="email">Email</option>
        </select>
        <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="reached">Reached</option><option value="no_answer">No answer</option>
          <option value="callback">Call back later</option><option value="wrong_number">Wrong number</option>
          <option value="declined">Declined</option>
        </select>
      </div>
      <input placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} dir="auto" />
    </Form>
  );
}

// ---------------------------------------------------------------------
export function ReviewForm({ projectId, userId, onDone }: { projectId: number; userId: string; onDone: () => void }) {
  const [status, setStatus] = useState('done');
  const [notes, setNotes] = useState('');
  const { busy, error, run } = useSave(() => { setNotes(''); onDone(); });
  return (
    <Form label="Save validation" busy={busy} error={error}
      onSubmit={() => run(() => supabase.from('screening_reviews').insert({
        project_id: projectId, status, notes: notes.trim() || null, reviewer_id: userId,
      }))}>
      <div className="row">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="done">Done</option><option value="waiting">Waiting</option>
          <option value="needs_update">Needs update</option><option value="pending">Pending</option>
        </select>
        <input placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} dir="auto" />
      </div>
    </Form>
  );
}

// ---------------------------------------------------------------------
export function IssueAdder({ projectId, userId, options, onDone }: {
  projectId: number; userId: string; options: Lookup[]; onDone: () => void;
}) {
  const [issue, setIssue] = useState(0);
  const { busy, error, run } = useSave(() => { setIssue(0); onDone(); });
  if (!options.length) return null;
  return (
    <Form label="Add issue" busy={busy} disabled={!issue} error={error}
      onSubmit={() => run(() => supabase.from('project_issues').insert({ project_id: projectId, issue_id: issue, noted_by: userId }))}>
      <select value={issue} onChange={(e) => setIssue(Number(e.target.value))}>
        <option value={0}>Choose an issue…</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </Form>
  );
}

export async function removeIssue(projectId: number, issueId: number) {
  return supabase.from('project_issues').delete().eq('project_id', projectId).eq('issue_id', issueId);
}

// ---------------------------------------------------------------------
export function InterviewScheduler({ projectId, userId, onDone }: { projectId: number; userId: string; onDone: () => void }) {
  const [when, setWhen] = useState('');
  const { busy, error, run } = useSave(() => { setWhen(''); onDone(); });
  return (
    <Form label="Schedule interview" busy={busy} disabled={!when} error={error}
      onSubmit={() => run(() => supabase.from('interviews').insert({
        project_id: projectId, scheduled_at: new Date(when).toISOString(), status: 'scheduled', interviewer_id: userId,
      }))}>
      <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
    </Form>
  );
}

export function InterviewResult({ interviewId, rounds, onDone }: { interviewId: number; rounds: Lookup[]; onDone: () => void }) {
  const [status, setStatus] = useState('done');
  const [decision, setDecision] = useState('accepted');
  const [round, setRound] = useState(0);
  const [reasons, setReasons] = useState('');
  const { busy, error, run } = useSave(onDone);
  return (
    <Form label="Save result" busy={busy} error={error}
      onSubmit={() => run(() => supabase.from('interviews').update({
        status,
        decision: status === 'done' ? decision : null,
        recommended_round_id: status === 'done' && decision === 'accepted' && round ? round : null,
        reasons: reasons.trim() || null,
      }).eq('id', interviewId))}>
      <div className="row">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="done">Done</option><option value="no_show">No show</option><option value="cancelled">Cancelled</option>
        </select>
        {status === 'done' && (
          <select value={decision} onChange={(e) => setDecision(e.target.value)}>
            <option value="accepted">Accepted</option><option value="rejected">Rejected</option><option value="waiting">Waiting</option>
          </select>
        )}
        {status === 'done' && decision === 'accepted' && (
          <select value={round} onChange={(e) => setRound(Number(e.target.value))}>
            <option value={0}>Recommended round…</option>
            {rounds.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        )}
      </div>
      <input placeholder="Reasons / notes (optional)" value={reasons} onChange={(e) => setReasons(e.target.value)} dir="auto" />
    </Form>
  );
}

// ---------------------------------------------------------------------
// Enroll: creates the enrollment (code set by the database), adds every team
// member as a participant and moves the project to Enrolled.
export function EnrollForm({ projectId, personIds, rounds, userId, onDone }: {
  projectId: number; personIds: number[]; rounds: Lookup[]; userId: string; onDone: () => void;
}) {
  const [round, setRound] = useState(0);
  const { busy, error, run } = useSave(onDone);
  const enroll = () => run(async () => {
    const { data, error } = await supabase.from('round_enrollments')
      .insert({ round_id: round, project_id: projectId, selected_by: userId }).select('id').single();
    if (error) return { error };
    if (personIds.length) {
      const res = await supabase.from('round_participants')
        .insert(personIds.map((person_id) => ({ enrollment_id: data.id, person_id })));
      if (res.error) return res;
    }
    return supabase.from('projects').update({ status: 'enrolled' }).eq('id', projectId);
  });
  return (
    <Form label="Enroll in round" busy={busy} disabled={!round} error={error} onSubmit={enroll}>
      <select value={round} onChange={(e) => setRound(Number(e.target.value))}>
        <option value={0}>Choose a round…</option>
        {rounds.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
      </select>
    </Form>
  );
}

export function WithdrawForm({ enrollmentId, projectId, onDone }: { enrollmentId: number; projectId: number; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, error, run } = useSave(onDone);
  const withdraw = () => run(async () => {
    const res = await supabase.from('round_enrollments')
      .update({ status: 'withdrawn', withdraw_reason: reason.trim() || null }).eq('id', enrollmentId);
    if (res.error) return res;
    return supabase.from('projects').update({ status: 'withdrawn' }).eq('id', projectId);
  });
  return (
    <Form label="Withdraw from round" busy={busy} error={error} onSubmit={withdraw}>
      <input placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} dir="auto" />
    </Form>
  );
}

// ---------------------------------------------------------------------
// Commitment deposit (جدية حضور), kept as a note on the project
export const DEPOSIT_LABEL: Record<string, string> = {
  not_paid: 'Not paid', office: 'Paid at the office', instapay: 'InstaPay', vodafone_cash: 'Vodafone Cash', other: 'Other',
};

export function DepositEditor({ projectId, method, amount, note, onDone }: {
  projectId: number; method: string | null; amount: number | null; note: string | null; onDone: () => void;
}) {
  const [m, setM] = useState(method ?? '');
  const [a, setA] = useState(amount?.toString() ?? '');
  const [n, setN] = useState(note ?? '');
  const { busy, error, run } = useSave(onDone);
  return (
    <Form label="Save deposit" busy={busy} error={error}
      onSubmit={() => run(() => supabase.from('projects').update({
        deposit_method: m || null,
        deposit_amount: m && m !== 'not_paid' && a ? Number(a) : null,
        deposit_note: n.trim() || null,
      }).eq('id', projectId))}>
      <div className="row">
        <select value={m} onChange={(e) => setM(e.target.value)}>
          <option value="">Not recorded</option>
          {Object.entries(DEPOSIT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {m && m !== 'not_paid' && (
          <input type="number" min="0" step="1" placeholder="Amount (EGP)" value={a} onChange={(e) => setA(e.target.value)} />
        )}
      </div>
      <input placeholder="Note (optional)" value={n} onChange={(e) => setN(e.target.value)} dir="auto" />
    </Form>
  );
}

// ---------------------------------------------------------------------
export function ConfirmationSelect({ memberId, value, onDone }: { memberId: number; value: string; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const change = async (next: string) => {
    const { error } = await supabase.from('project_members').update({ confirmation: next }).eq('id', memberId);
    if (error) setError(error.message);
    else onDone();
  };
  return (
    <>
      <select className="compact" value={value} onChange={(e) => change(e.target.value)}>
        <option value="pending">Pending</option><option value="accepted">Accepted</option>
        <option value="rejected">Rejected</option><option value="waiting">Waiting</option>
      </select>
      {error && <div className="error small">{error}</div>}
    </>
  );
}
