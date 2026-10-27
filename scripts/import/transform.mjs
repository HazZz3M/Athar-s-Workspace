// Step 2: data/raw/sheets.json -> data/out/import.json + data/out/import-report.md
// Pure and re-runnable. Rules are documented in docs/import-plan.md.
// The report refers to sheet rows only; it never prints names, IDs or phones.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sheets = JSON.parse(fs.readFileSync(path.join(root, 'data/raw/sheets.json'), 'utf8'));

const TR = sheets['Total Responces'];
const MAIN = sheets['Main (Veiw Only!)'];
const RTA = sheets['Ready to Attend'];
const OLD = sheets['OLD beneficiaries'];

const MAX_MEMBERS = 10;
const IMPORT_YEAR = 2026;

// ---------------------------------------------------------------------
// Report helpers
// ---------------------------------------------------------------------
const report = { counts: {}, notes: [], lists: {} };
const bump = (key, n = 1) => (report.counts[key] = (report.counts[key] ?? 0) + n);
const listAdd = (key, item) => (report.lists[key] ??= []).push(item);
const tally = {};
const tallyAdd = (key, value) => {
  const t = (tally[key] ??= {});
  t[value] = (t[value] ?? 0) + 1;
};

// ---------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const toLatinDigits = (s) =>
  String(s ?? '')
    .replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c))
    .replace(/[۰-۹]/g, (c) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c));

function normNid(raw) {
  const s = toLatinDigits(raw).replace(/[\s\-.]/g, '');
  return s === '' ? null : s;
}

function normPhone(raw) {
  let s = toLatinDigits(raw).replace(/[^\d]/g, '');
  if (s === '') return { value: null, fix: 'blank' };
  if (s.startsWith('0020')) s = s.slice(4);
  else if (s.startsWith('20') && s.length === 12) s = s.slice(2);
  if (/^1\d{9}$/.test(s)) return { value: '0' + s, fix: 'added leading 0' };
  if (/^01\d{9}$/.test(s)) return { value: s, fix: s === String(raw).trim() ? 'ok' : 'cleaned' };
  return { value: null, fix: 'invalid, dropped' };
}

function normEmail(raw) {
  const s = clean(raw).toLowerCase();
  if (!s) return null;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null;
}

// Compare names loosely: unify alef/taa marbuta/yaa forms
const nameTokens = (s) =>
  clean(s)
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^؀-ۿa-zA-Z ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
const nameKey = (s) => nameTokens(s).slice(0, 2).join(' ');
// Same person when one name is the other, or a shorter form of it
// ("محمد أحمد" vs "محمد أحمد علي"); a different third name means a different person.
function sameName(a, b) {
  const [x, y] = [nameTokens(a), nameTokens(b)].sort((p, q) => p.length - q.length);
  return x.length >= 2 && x.every((tok, i) => tok === y[i]);
}

// "3/12/2026 4:39:34" -> "2026-03-12 04:39:34" (Cairo local; cast in SQL)
function sheetTimestamp(raw) {
  const m = clean(raw).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, mo, d, y, h = '0', mi = '00', se = '00'] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')} ${h.padStart(2, '0')}:${mi}:${se}`;
}
const sheetDate = (raw) => sheetTimestamp(raw)?.slice(0, 10) ?? null;

// Birthdate from a national ID (same rule as public.nid_birthdate)
function nidBirthdate(nid) {
  if (!nid || !/^[23]\d{13}$/.test(nid)) return null;
  const y = (nid[0] === '2' ? 1900 : 2000) + +nid.slice(1, 3);
  const mo = +nid.slice(3, 5);
  const d = +nid.slice(5, 7);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// Lookup maps (slugs/labels resolved to ids by the loader)
// ---------------------------------------------------------------------
const STAGES = [
  ['نموذج أولي مطور', 'advanced_prototype'],
  ['نموذج أولي', 'prototype'],
  ['فكرة مطورة', 'developed_idea'],
  ['فكرة', 'idea'],
  ['منتج', 'product'],
  ['إيرادات', 'revenue'],
  ['أرباح', 'profit'],
  ['Advanced Prototype', 'advanced_prototype'],
  ['Prototype', 'prototype'],
  ['Developed Idea', 'developed_idea'],
  ['Idea', 'idea'],
  ['Product', 'product'],
  ['Revenue', 'revenue'],
  ['Profit', 'profit'],
];
function stageSlug(raw) {
  const s = clean(raw);
  if (!s) return null;
  const hit = STAGES.find(([prefix]) => s.startsWith(prefix));
  if (!hit) tallyAdd('Stage values not mapped', s.slice(0, 50));
  return hit?.[1] ?? null;
}

const SECTORS_AR = [
  ['التكنولوجيا', 'technology'],
  ['الصناعات الإبداعية', 'creative_industries'],
  ['القطاع الزراعي', 'agriculture'],
  ['التجارة الإلكترونية', 'ecommerce'],
  ['التصنيع', 'manufacturing'],
  ['قطاع التعليم', 'education'],
];
const SECTORS_EN = {
  'technology': 'technology',
  'creative industries': 'creative_industries',
  'agriculture': 'agriculture',
  'e-commerce': 'ecommerce',
  'manufacturing': 'manufacturing',
  'education': 'education',
  'food & beverage': 'food_beverage',
  'healthcare': 'healthcare',
  'services': 'services',
  'retail': 'retail',
  'logistics / transportation': 'logistics',
  'sustainability / environment': 'sustainability',
};

const GOVERNORATES = {
  cairo: 1, alexandria: 2, 'port said': 3, suez: 4, damietta: 11, dakahlia: 12, sharqia: 13,
  'ash sharqia': 13, qalyubia: 14, 'kafr el sheikh': 15, gharbia: 16, monufia: 17, beheira: 18,
  ismailia: 19, giza: 21, 'beni suef': 22, fayoum: 23, minya: 24, assiut: 25, sohag: 26, qena: 27,
  aswan: 28, luxor: 29, 'red sea': 31, 'new valley': 32, matrouh: 33, 'north sinai': 34, 'south sinai': 35,
};
function governorateCode(raw) {
  const s = clean(raw);
  if (!s || /^(hackathon|technation)$/i.test(s)) return null;
  const en = (s.split('/')[1] ?? s).replace(/-.*$/, '').trim().toLowerCase();
  const code = GOVERNORATES[en];
  if (!code) tallyAdd('Project location not mapped', s);
  return code ?? null;
}

const DISTRICTS = [
  [/أبنوب|ابنوب/, 'مركز أبنوب'],
  [/منفلوط/, 'مركز منفلوط'],
  [/القوصي/, 'مركز القوصية'],
  [/أبو ?تيج|ابو ?تيج/, 'مركز أبو تيج'],
  [/الفتح/, 'مركز الفتح'],
  [/ديروط/, 'مركز ديروط'],
  [/ساحل سليم/, 'مركز ساحل سليم'],
  [/صدفا/, 'مركز صدفا'],
  [/البداري/, 'مركز البداري'],
  [/الغنايم/, 'مركز الغنايم'],
  [/أسيوط|اسيوط/, 'مركز أسيوط'],
];
function districtName(raw) {
  const s = clean(raw);
  if (!s || s === 'undefined') return null;
  const hit = DISTRICTS.find(([re]) => re.test(s));
  if (!hit) tallyAdd('District values not mapped', s);
  return hit?.[1] ?? null;
}

const ORGANIZATIONS = {
  'athar': 'Athar',
  'entlaq': 'Entlaq',
  'ice alex': 'ICE Alex',
  'superfny': 'Superfny',
  'arab academy for science, technology and maritime transport':
    'Arab Academy for Science, Technology and Maritime Transport',
};
const orgName = (raw) => ORGANIZATIONS[clean(raw).toLowerCase()] ?? null;

const ISSUE_LABELS = [
  'طالب', 'خارج محافظة اسيوط', 'أكبر من سن 35', 'حضروا معانا قبل كدا', 'بيانات مكررة',
  'فردي لا يستطيع توفير فريق', 'مشروع يعمل أكثر من عام مع إيرادات مرتفعة', 'عنده غموض عن البرنامج',
  'لا يتم الرد مع تكرار التواصل', 'صعب الالتزام بالتدريب',
  'AI Hackathon 1', 'TechNation', 'جاء من جمعية بهيج بأبنوب', 'طلاب احمد ضيف الله',
];

// ---------------------------------------------------------------------
// Intake source per submission: location markers first, then timestamps
// ---------------------------------------------------------------------
const SOURCE_TABS = {
  'SMEs 2026 dark ads': 'smes_dark_ads',
  'Facebook': 'facebook',
  'OLD Data': 'old_data',
  'GDG SEC TecNation': 'gdg_technation',
  'TechNation ( Hidden Dont Delete)': 'technation',
  'Hackathon (Hidden Dont delete)': 'ai_hackathon',
  'Mamdouh': 'ai_hackathon',
  'Campus | Upper Egypt AI Hackathon': 'ai_hackathon',
  'AI Dark Ads': 'ai_hackathon',
  'AI organic': 'ai_hackathon',
};
const timestampSources = new Map();
for (const [tab, slug] of Object.entries(SOURCE_TABS)) {
  for (const row of (sheets[tab] ?? []).slice(1)) {
    const ts = clean(row[0]);
    if (ts && !timestampSources.has(ts)) timestampSources.set(ts, slug);
  }
}
function sourceSlug(location, ts) {
  if (/tecknation/i.test(location)) return 'gdg_technation';
  if (/^hackathon$/i.test(location)) return 'ai_hackathon';
  if (/^technation$/i.test(location)) return 'technation';
  return timestampSources.get(clean(ts)) ?? 'manual';
}

// ---------------------------------------------------------------------
// Main: team-level values sit on each project's first slot row.
// Main row (1-based data index) i belongs to TR row floor((i-1)/10)+1,
// slot (i-1)%10. Verified for all rows; checked again here.
// ---------------------------------------------------------------------
const M = {
  name: 8, nid: 9, call: 15, callDate: 16, whatsapp: 17, actions: 18, confirmation: 19,
  interviewDate: 20, interviewTime: 21, shoruk: 23, notes: 24, issues: 25, round: 26,
  selection: 27, reasons: 28, org: 30,
};
function mainRow(trIndex, slot) {
  const row = MAIN[trIndex * MAX_MEMBERS + slot + 1] ?? [];
  const tr = TR[trIndex + 1];
  if (clean(row[1]) !== clean(tr[1]) || clean(row[M.name]) !== clean(tr[8 + 4 * slot])) {
    throw new Error(`Main row ${trIndex * MAX_MEMBERS + slot + 2} does not line up with Total Responces row ${trIndex + 2}`);
  }
  return row;
}

function projectStatus(team) {
  const { selection, round, interviewDate, confirmation, shoruk, reasons } = team;
  let status;
  if (/منسحب/.test(reasons)) status = 'withdrawn';
  else if (selection === 'Accepted' && round) status = 'enrolled';
  else if (selection === 'Accepted') status = 'accepted';
  else if (selection === 'Rejected') status = 'rejected';
  else if (selection === 'Waiting') status = 'waiting';
  else if (interviewDate && confirmation === 'Accepted') status = 'interviewing';
  else if (confirmation === 'Rejected') status = 'rejected';
  else if (confirmation === 'Waiting') status = 'waiting';
  else if (confirmation === 'Accepted') status = 'screening';
  else status = 'new';
  if (shoruk === 'Need to Update' && ['screening', 'interviewing', 'accepted', 'waiting'].includes(status)) {
    status = 'needs_update';
  }
  return status;
}

// Interview times were typed without AM/PM: 1:00-7:00 means afternoon,
// 0:00 means no time given (stored as 12:00).
function interviewTimestamp(date, time) {
  const d = sheetDate(date);
  if (!d) return null;
  const m = clean(time).match(/^(\d{1,2}):(\d{2})/);
  let h = m ? +m[1] : 0;
  const mi = m ? m[2] : '00';
  if (h === 0) {
    h = 12;
    bump('Interviews with no time (set to 12:00)');
  } else if (h >= 1 && h <= 7) {
    h += 12;
    bump('Interview times read as PM (1:00-7:00 → 13:00-19:00)');
  }
  return `${d} ${String(h).padStart(2, '0')}:${mi}:00`;
}

// ---------------------------------------------------------------------
// Build entities
// ---------------------------------------------------------------------
const out = {
  projects: [], intake_submissions: [], people: [], project_members: [], contact_attempts: [],
  screening_reviews: [], project_issues: [], interviews: [], round_enrollments: [],
  round_participants: [], prior_participations: [],
};

const header = TR[0];
const personByNid = new Map(); // nid -> person
const membersByProject = new Map(); // project id -> [{member, person}]

function newPerson(fields) {
  const person = { id: out.people.length + 1, ...fields };
  out.people.push(person);
  return person;
}

for (let t = 0; t < TR.length - 1; t++) {
  const row = TR[t + 1];
  const sheetRow = t + 2;
  const projectId = t + 1;
  const location = clean(row[4]);
  const isGdg = /tecknation/i.test(location);
  const submittedAt = sheetTimestamp(row[0]);
  if (!submittedAt) listAdd('Rows with an unreadable timestamp', sheetRow);

  // Sector / track
  let sectorSlug = null, sectorOther = null, track = null;
  const sectorRaw = clean(row[6]);
  if (isGdg) {
    track = sectorRaw || null;
    sectorSlug = 'technology';
  } else if (/^(web|flutter|mobile|ai|ui)/i.test(sectorRaw)) {
    track = sectorRaw;
    sectorSlug = 'technology';
  } else if (sectorRaw && sectorRaw !== 'undefined') {
    const hit = SECTORS_AR.find(([prefix]) => sectorRaw.startsWith(prefix));
    if (hit) sectorSlug = hit[1];
    else if (/^other$/i.test(sectorRaw)) sectorSlug = 'other';
    else {
      sectorSlug = 'other';
      sectorOther = sectorRaw;
      bump('Sectors kept as "other" + free text');
    }
  }

  const slot0 = mainRow(t, 0);
  const team = {
    call: clean(slot0[M.call]) === 'TRUE',
    callDate: sheetDate(slot0[M.callDate]),
    whatsapp: clean(slot0[M.whatsapp]) === 'TRUE',
    actions: clean(slot0[M.actions]),
    confirmation: clean(slot0[M.confirmation]),
    interviewDate: clean(slot0[M.interviewDate]),
    interviewTime: clean(slot0[M.interviewTime]),
    shoruk: clean(slot0[M.shoruk]),
    issues: clean(slot0[M.issues]),
    round: clean(slot0[M.round]),
    selection: clean(slot0[M.selection]),
    reasons: clean(slot0[M.reasons]),
  };
  const status = projectStatus(team);
  tallyAdd('Project status', status);

  const founded = sheetDate(row[5]);
  if (clean(row[5]) && !founded) listAdd('Founded dates not readable (left empty)', sheetRow);

  const project = {
    id: projectId,
    code: `DAAP${String(projectId).padStart(4, '0')}MSMES`,
    name: clean(row[1]) || '—',
    description: String(row[2] ?? '').trim() || null,
    stage_slug: isGdg ? null : stageSlug(row[3]),
    governorate_code: governorateCode(location),
    district_name: null,
    sector_slug: sectorSlug,
    sector_other: sectorOther,
    founded_on: founded,
    social_url: clean(row[7]) || null,
    source_slug: sourceSlug(location, row[0]),
    university: isGdg ? clean(row[3]) || null : null,
    track,
    submitted_at: submittedAt,
    status,
    sheet_row: sheetRow,
  };
  out.projects.push(project);
  tallyAdd('Intake source', project.source_slug);

  out.intake_submissions.push({
    id: projectId,
    source_slug: project.source_slug,
    submitted_at: submittedAt,
    payload: Object.fromEntries(header.map((h, i) => [clean(h) || `col_${i}`, row[i] ?? ''])),
    project_id: projectId,
    sheet_tab: 'Total Responces',
    sheet_row: sheetRow,
  });

  // Members
  const members = [];
  for (let k = 0; k < MAX_MEMBERS; k++) {
    const rawName = clean(row[8 + 4 * k]);
    const nid = normNid(row[9 + 4 * k]);
    if (!rawName && !nid) continue;
    const name = rawName || '—';
    if (!rawName) listAdd('Members with an ID but no name (name set to "—")', `row ${sheetRow} slot ${k + 1}`);
    const phone = normPhone(row[10 + 4 * k]);
    tallyAdd('Phone numbers', phone.fix);
    const email = normEmail(row[11 + 4 * k]);
    if (clean(row[11 + 4 * k]) && !email) bump('E-mails dropped as invalid');
    if (!nid) bump('Members without a national ID');
    else if (!/^[23]\d{13}$/.test(nid)) listAdd('National IDs kept but invalid (not a 14-digit ID)', `row ${sheetRow} slot ${k + 1}`);

    let person = null;
    if (nid && personByNid.has(nid)) {
      const existing = personByNid.get(nid);
      if (sameName(existing.full_name_ar, name)) {
        person = existing;
        existing.phone ??= phone.value;
        existing.email ??= email;
        bump('Members matched to an existing person (same ID + name)');
      } else {
        const sameProject = members.some((m) => m.person === existing);
        listAdd(
          sameProject
            ? 'ID conflicts inside one team (ID kept on first member only)'
            : 'ID conflicts across projects (ID kept on first person only)',
          `row ${sheetRow} slot ${k + 1} (ID first seen at row ${existing.first_row})`,
        );
        person = newPerson({ national_id: null, full_name_ar: name, phone: phone.value, email, first_row: sheetRow });
      }
    } else {
      person = newPerson({ national_id: nid, full_name_ar: name, phone: phone.value, email, first_row: sheetRow });
      if (nid) personByNid.set(nid, person);
    }

    if (members.some((m) => m.person === person)) {
      listAdd('Same person listed twice in one team (second slot skipped)', `row ${sheetRow} slot ${k + 1}`);
      continue;
    }

    const confirmation = { Accepted: 'accepted', Rejected: 'rejected', Waiting: 'waiting' }[team.confirmation] ?? 'pending';
    const member = {
      id: out.project_members.length + 1,
      project_id: projectId,
      person_id: person.id,
      is_lead: members.length === 0,
      position: k + 1,
      confirmation,
      notes: clean(mainRow(t, k)[M.notes]) || null,
    };
    out.project_members.push(member);
    members.push({ member, person, slot: k });

    const org = clean(mainRow(t, k)[M.org]);
    if (org && org !== '#NUM!') {
      if (orgName(org)) {
        out.prior_participations.push({
          person_id: person.id, national_id: person.national_id, full_name: person.full_name_ar,
          phone: person.phone, birthdate: nidBirthdate(person.national_id), organization_name: orgName(org),
          program_label: 'Main sheet ORG column', project_name: project.name,
        });
      } else tallyAdd('ORG values not mapped', org);
    }
  }
  if (!members.length) listAdd('Projects with no members', sheetRow);
  membersByProject.set(projectId, members);
  const lead = members[0]?.member;

  // Screening: contact attempts on the lead
  if (lead) {
    const at = team.callDate ? `${team.callDate} 12:00:00` : submittedAt;
    const note = team.actions ? `Imported from sheet (Number of Action: ${team.actions})` : 'Imported from sheet';
    if (team.call || team.callDate) out.contact_attempts.push({ project_member_id: lead.id, channel: 'call', attempted_at: at, notes: note });
    if (team.whatsapp) out.contact_attempts.push({ project_member_id: lead.id, channel: 'whatsapp', attempted_at: at, notes: note });
  }

  const review = { 'Done': 'done', 'Waiting': 'waiting', 'Need to Update': 'needs_update' }[team.shoruk];
  if (review) out.screening_reviews.push({ project_id: projectId, status: review });
  else if (team.shoruk) tallyAdd('Shoruk values not mapped', team.shoruk);

  for (const label of team.issues.split(/[,،]/).map(clean).filter(Boolean)) {
    if (ISSUE_LABELS.includes(label)) out.project_issues.push({ project_id: projectId, issue_label: label });
    else tallyAdd('Team Issues labels not mapped', label);
  }

  const roundNumber = team.round.match(/Round\s*-\s*0?(\d+)/)?.[1];
  if (team.interviewDate) {
    const decision = { Accepted: 'accepted', Rejected: 'rejected', Waiting: 'waiting' }[team.selection] ?? null;
    out.interviews.push({
      project_id: projectId,
      scheduled_at: interviewTimestamp(team.interviewDate, team.interviewTime),
      status: decision ? 'done' : 'scheduled',
      decision,
      recommended_round_number: roundNumber ? +roundNumber : null,
      reasons: team.reasons || null,
    });
  }
  if (status === 'enrolled') {
    out.round_enrollments.push({ id: out.round_enrollments.length + 1, project_id: projectId, round_number: +roundNumber, code: null });
  }
}

// ---------------------------------------------------------------------
// Ready to Attend -> participants, codes, sector and district overrides
// ---------------------------------------------------------------------
const R = { code: 0, project: 1, name: 8, nid: 9, round: 15, sector: 17, region: 18 };
const projectsByName = new Map();
for (const p of out.projects) {
  const key = clean(p.name);
  (projectsByName.get(key) ?? projectsByName.set(key, []).get(key)).push(p);
}
const enrollmentByProject = new Map(out.round_enrollments.map((e) => [e.project_id, e]));
const sectorFromRta = new Map();

for (let i = 1; i < RTA.length; i++) {
  const row = RTA[i];
  const sheetRow = i + 1;
  if (!clean(row[R.project])) continue;
  const nid = normNid(row[R.nid]);
  const name = clean(row[R.name]);
  const candidates = projectsByName.get(clean(row[R.project])) ?? [];
  let project = null, match = null;
  for (const p of candidates) {
    const ms = membersByProject.get(p.id);
    match = (nid && ms.find((m) => m.person.national_id === nid)) || ms.find((m) => nameKey(m.person.full_name_ar) === nameKey(name));
    if (match) { project = p; break; }
  }
  if (!project) {
    listAdd('Ready to Attend rows with no matching project member', sheetRow);
    continue;
  }

  // Sector: one clean English value wins over the form answer
  const sectors = clean(row[R.sector]).split(',').map((s) => s.trim().toLowerCase()).filter((s) => s && s !== 'undefined');
  if (sectors.length === 1 && SECTORS_EN[sectors[0]]) sectorFromRta.set(project.id, SECTORS_EN[sectors[0]]);
  project.district_name ??= districtName(row[R.region]);

  const enrollment = enrollmentByProject.get(project.id);
  if (!enrollment) {
    listAdd('Ready to Attend rows whose project has no round (not enrolled)', sheetRow);
    continue;
  }
  enrollment.code ??= clean(row[R.code]) || null;
  out.round_participants.push({ enrollment_id: enrollment.id, person_id: match.person.id });
}

for (const p of out.projects) {
  const s = sectorFromRta.get(p.id);
  if (s && s !== p.sector_slug) {
    bump('Sectors replaced by the validated Ready to Attend sector');
    p.sector_slug = s;
    p.sector_other = null;
  }
}

// ---------------------------------------------------------------------
// OLD beneficiaries -> prior participations
// Left list (A-G): Athar 2025 rounds with national IDs.
// Right list (I-L): all organizations. "DOP+PHONE" is DDMMYYYY + digits 7-9 of
// the 11-digit phone (verified against all 45 of the sheet's own "New Org"
// matches). Kobo code =
// <digit><initials><digit><DDMMYYYY><3 digits> (checked against 714 rows
// that also carry a national ID).
// ---------------------------------------------------------------------
const peopleByBirthPhone = new Map();
for (const p of out.people) {
  const b = nidBirthdate(p.national_id);
  if (b && p.phone) peopleByBirthPhone.set(`${b}|${p.phone.slice(6, 9)}`, p);
}
function birthPhoneKey(raw) {
  const m = toLatinDigits(raw).replace(/\D/g, '').match(/^(\d{2})(\d{2})(\d{4})(\d{3})$/);
  const birthdate = m && ddmmyyyy(m[1], m[2], m[3]);
  return birthdate ? { birthdate, phoneTail: m[4] } : null;
}
function ddmmyyyy(d, mo, y) {
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  if (+y < 1940 || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) return null;
  return dt.toISOString().slice(0, 10);
}
function koboBirthdate(code) {
  const m = clean(code).match(/^\d[a-z]+\d(\d{2})(\d{2})(\d{4})/i);
  return m ? ddmmyyyy(m[1], m[2], m[3]) : null;
}

for (let i = 1; i < OLD.length; i++) {
  const row = OLD[i];
  // Left list
  if (clean(row[1]) || clean(row[3])) {
    const nid = normNid(row[3]);
    const person = nid ? personByNid.get(nid) : null;
    const label = clean(row[6]);
    out.prior_participations.push({
      person_id: person?.id ?? null, national_id: nid, full_name: clean(row[1]) || null,
      phone: normPhone(row[2]).value, birthdate: nidBirthdate(nid), project_name: clean(row[0]) || null,
      organization_name: 'Athar', program_label: label || null,
      year: /20\d\d/.test(label) ? +label.match(/20\d\d/)[0] : null, kobo_code: clean(row[4]) || null,
      referral: { New: 'new', Refferal: 'referral', Referral: 'referral' }[clean(row[5])] ?? null,
    });
    if (person) bump('Prior participations linked to a person (by ID)');
  }
  // Right list
  if (clean(row[8]) || clean(row[9])) {
    const key = birthPhoneKey(row[10]);
    const birthdate = koboBirthdate(row[9]) ?? key?.birthdate ?? null;
    const phone = null; // only 3 digits of it are known
    const person = key ? peopleByBirthPhone.get(`${key.birthdate}|${key.phoneTail}`) : null;
    const org = orgName(row[11]);
    if (!org && clean(row[11])) tallyAdd('ORG values not mapped', clean(row[11]));
    out.prior_participations.push({
      person_id: person?.id ?? null, national_id: null, full_name: clean(row[8]) || null, phone, birthdate,
      organization_name: org, program_label: null, year: null, kobo_code: clean(row[9]) || null,
    });
    if (!birthdate) bump('Prior participations without a readable birthdate in the Kobo code');
    if (person) bump('Prior participations linked to a person (by birthdate + phone)');
  }
}

// ---------------------------------------------------------------------
// Write output + report
// ---------------------------------------------------------------------
for (const p of out.people) delete p.first_row;
const enrolledWithoutCode = out.round_enrollments.filter((e) => !e.code).length;
if (enrolledWithoutCode) report.notes.push(`${enrolledWithoutCode} enrollments had no Ready to Attend code; the database will number them.`);

const outDir = path.join(root, 'data/out');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'import.json'), JSON.stringify(out));

const lines = ['# Import report', '', `Generated ${new Date().toISOString()} from data/raw/sheets.json.`, '', '## Rows to load', '', '| Table | Rows |', '|---|---|'];
for (const [table, rows] of Object.entries(out)) lines.push(`| ${table} | ${rows.length} |`);
lines.push('', '## Counts', '', '| What | Count |', '|---|---|');
for (const [k, v] of Object.entries(report.counts)) lines.push(`| ${k} | ${v} |`);
for (const [title, t] of Object.entries(tally)) {
  lines.push('', `## ${title}`, '', '| Value | Count |', '|---|---|');
  for (const [v, n] of Object.entries(t).sort((a, b) => b[1] - a[1])) lines.push(`| ${v} | ${n} |`);
}
for (const [title, items] of Object.entries(report.lists)) {
  lines.push('', `## ${title} (${items.length})`, '', 'Total Responces / Ready to Attend sheet rows:', '', items.join(', '));
}
if (report.notes.length) lines.push('', '## Notes', '', ...report.notes.map((n) => `- ${n}`));
fs.writeFileSync(path.join(outDir, 'import-report.md'), lines.join('\n') + '\n');

for (const [table, rows] of Object.entries(out)) console.log(`${table.padEnd(22)} ${rows.length}`);
console.log('report: data/out/import-report.md');
