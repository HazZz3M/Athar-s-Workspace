// Display order follows the pipeline, not the alphabet
export const STATUSES = [
  'new',
  'screening',
  'needs_update',
  'waiting',
  'interviewing',
  'accepted',
  'enrolled',
  'rejected',
  'withdrawn',
] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<Status, string> = {
  new: 'New',
  screening: 'Screening',
  needs_update: 'Needs update',
  waiting: 'Waiting',
  interviewing: 'Interviewing',
  accepted: 'Accepted',
  enrolled: 'Enrolled',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export const humanize = (s: string | null | undefined) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : '—';

export const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export const fmtDateTime = (d: string | null | undefined) =>
  d
    ? new Date(d).toLocaleString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Africa/Cairo',
      })
    : '—';

// Show only the last 4 digits of a national ID
export const maskId = (id: string | null | undefined) => (id ? '•••• ' + id.slice(-4) : '—');
