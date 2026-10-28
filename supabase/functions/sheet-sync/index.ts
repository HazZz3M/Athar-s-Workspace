// sheet-sync: read the Main MSMEs Google Sheet (read-only) and add new
// Total Responces rows as new projects. Rules match scripts/import/transform.mjs.
//
// Called by pg_cron every 15 minutes (anon key, trigger "schedule") and by the
// app's "Sync now" button (staff user token, trigger "manual").
// POST {"check": true} from a staff user returns whether Google access is set up.
//
// Secret: GOOGLE_SERVICE_ACCOUNT_JSON — the service account key JSON. Share the
// sheet with the service account's e-mail as Viewer.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SHEET_ID = '1KARk6a0UVheuS2yzcLJD8zmyLXz_WnOHEuj4eSCAeBw';
const TR_TAB = 'Total Responces';
const MAX_MEMBERS = 10;
const LAST_COL = 'AV'; // 8 project columns + 10 members x 4

// Intake tabs whose timestamps tell which form a submission came from
const SOURCE_TABS: Record<string, string> = {
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

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// ---------------------------------------------------------------------
// Normalizers (same as the import)
// ---------------------------------------------------------------------
const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const toLatinDigits = (s: unknown) =>
  String(s ?? '')
    .replace(/[٠-٩]/g, (c) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)))
    .replace(/[۰-۹]/g, (c) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)));

const normNid = (raw: unknown) => toLatinDigits(raw).replace(/[\s\-.]/g, '') || null;

function normPhone(raw: unknown): string | null | undefined {
  let s = toLatinDigits(raw).replace(/[^\d]/g, '');
  if (s === '') return null;
  if (s.startsWith('0020')) s = s.slice(4);
  else if (s.startsWith('20') && s.length === 12) s = s.slice(2);
  if (/^1\d{9}$/.test(s)) return '0' + s;
  if (/^01\d{9}$/.test(s)) return s;
  return undefined; // present but invalid
}

function normEmail(raw: unknown) {
  const s = clean(raw).toLowerCase();
  return s && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null;
}

// "3/12/2026 4:39:34" -> "2026-03-12 04:39:34" (Cairo local)
function sheetTimestamp(raw: unknown) {
  const m = clean(raw).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [, mo, d, y, h = '0', mi = '00', se = '00'] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')} ${h.padStart(2, '0')}:${mi}:${se}`;
}

const STAGES: [string, string][] = [
  ['نموذج أولي مطور', 'advanced_prototype'], ['نموذج أولي', 'prototype'], ['فكرة مطورة', 'developed_idea'],
  ['فكرة', 'idea'], ['منتج', 'product'], ['إيرادات', 'revenue'], ['أرباح', 'profit'],
  ['Advanced Prototype', 'advanced_prototype'], ['Prototype', 'prototype'], ['Developed Idea', 'developed_idea'],
  ['Idea', 'idea'], ['Product', 'product'], ['Revenue', 'revenue'], ['Profit', 'profit'],
];
const stageSlug = (raw: unknown) => STAGES.find(([p]) => clean(raw).startsWith(p))?.[1] ?? null;

const SECTORS_AR: [string, string][] = [
  ['التكنولوجيا', 'technology'], ['الصناعات الإبداعية', 'creative_industries'], ['القطاع الزراعي', 'agriculture'],
  ['التجارة الإلكترونية', 'ecommerce'], ['التصنيع', 'manufacturing'], ['قطاع التعليم', 'education'],
];

const GOVERNORATES: Record<string, number> = {
  cairo: 1, alexandria: 2, 'port said': 3, suez: 4, damietta: 11, dakahlia: 12, sharqia: 13,
  'ash sharqia': 13, qalyubia: 14, 'kafr el sheikh': 15, gharbia: 16, monufia: 17, beheira: 18,
  ismailia: 19, giza: 21, 'beni suef': 22, fayoum: 23, minya: 24, assiut: 25, sohag: 26, qena: 27,
  aswan: 28, luxor: 29, 'red sea': 31, 'new valley': 32, matrouh: 33, 'north sinai': 34, 'south sinai': 35,
};
function governorateCode(location: string) {
  if (!location || /^(hackathon|technation)$/i.test(location)) return null;
  const en = (location.split('/')[1] ?? location).replace(/-.*$/, '').trim().toLowerCase();
  return GOVERNORATES[en] ?? null;
}

// ---------------------------------------------------------------------
// One Total Responces row -> the shape public.sync_ingest_row expects
// ---------------------------------------------------------------------
function parseRow(row: string[], sheetRow: number, header: string[], sources: Map<string, string>) {
  const location = clean(row[4]);
  const isGdg = /tecknation/i.test(location);
  const issues: string[] = [];

  let sector_slug: string | null = null, sector_other: string | null = null, track: string | null = null;
  const sectorRaw = clean(row[6]);
  if (isGdg) {
    track = sectorRaw || null;
    sector_slug = 'technology';
  } else if (/^(web|flutter|mobile|ai|ui)/i.test(sectorRaw)) {
    track = sectorRaw;
    sector_slug = 'technology';
  } else if (sectorRaw && sectorRaw !== 'undefined') {
    sector_slug = SECTORS_AR.find(([p]) => sectorRaw.startsWith(p))?.[1] ?? 'other';
    if (sector_slug === 'other' && !/^other$/i.test(sectorRaw)) sector_other = sectorRaw;
  }

  let source_slug = sources.get(clean(row[0])) ?? 'manual';
  if (/tecknation/i.test(location)) source_slug = 'gdg_technation';
  else if (/^hackathon$/i.test(location)) source_slug = 'ai_hackathon';
  else if (/^technation$/i.test(location)) source_slug = 'technation';

  const members = [];
  for (let k = 0; k < MAX_MEMBERS; k++) {
    const name = clean(row[8 + 4 * k]);
    const nid = normNid(row[9 + 4 * k]);
    if (!name && !nid) continue;
    const phone = normPhone(row[10 + 4 * k]);
    if (phone === undefined) issues.push('invalid_phone');
    if (!nid) issues.push('missing_national_id');
    else if (!/^[23]\d{13}$/.test(nid)) issues.push('invalid_national_id');
    members.push({
      name: name || '—',
      national_id: nid,
      phone: phone ?? null,
      email: normEmail(row[11 + 4 * k]),
      position: k + 1,
    });
  }

  return {
    sheet_tab: TR_TAB,
    sheet_row: sheetRow,
    submitted_at: sheetTimestamp(row[0]),
    name: clean(row[1]) || '—',
    description: String(row[2] ?? '').trim() || null,
    stage_slug: isGdg ? null : stageSlug(row[3]),
    governorate_code: governorateCode(location),
    sector_slug,
    sector_other,
    founded_on: sheetTimestamp(row[5])?.slice(0, 10) ?? null,
    social_url: clean(row[7]) || null,
    source_slug,
    university: isGdg ? clean(row[3]) || null : null,
    track,
    payload: Object.fromEntries(header.map((h, i) => [clean(h) || `col_${i}`, row[i] ?? ''])),
    members,
    issues: [...new Set(issues)],
  };
}

// ---------------------------------------------------------------------
// Google: service account -> read-only access token -> sheet values
// ---------------------------------------------------------------------
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function googleToken(sa: { client_email: string; private_key: string }) {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Google sign-in failed: ${body.error_description ?? body.error ?? res.status}`);
  return body.access_token as string;
}

async function readSheet(token: string) {
  const api = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;
  const headers = { Authorization: `Bearer ${token}` };
  const meta = await fetch(`${api}?fields=sheets.properties.title`, { headers });
  if (!meta.ok) {
    throw new Error(meta.status === 403 || meta.status === 404
      ? 'The service account cannot open the sheet. Share the sheet with its e-mail as Viewer.'
      : `Google Sheets error ${meta.status}`);
  }
  const titles = new Set(((await meta.json()).sheets ?? []).map((s: { properties: { title: string } }) => s.properties.title));
  if (!titles.has(TR_TAB)) throw new Error(`Tab "${TR_TAB}" not found in the sheet`);
  const sourceTabs = Object.keys(SOURCE_TABS).filter((t) => titles.has(t));

  const params = new URLSearchParams();
  params.append('ranges', `'${TR_TAB}'!A1:${LAST_COL}`);
  for (const t of sourceTabs) params.append('ranges', `'${t}'!A2:A`);
  const res = await fetch(`${api}/values:batchGet?${params}`, { headers });
  if (!res.ok) throw new Error(`Google Sheets error ${res.status}`);
  const ranges: { values?: string[][] }[] = (await res.json()).valueRanges;

  const sources = new Map<string, string>();
  sourceTabs.forEach((t, i) => {
    for (const [ts] of ranges[i + 1].values ?? []) {
      const key = clean(ts);
      if (key && !sources.has(key)) sources.set(key, SOURCE_TABS[t]);
    }
  });
  return { rows: ranges[0].values ?? [], sources };
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const body = await req.json().catch(() => ({}));

  // A staff user's token means a manual run; the anon key means the schedule
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await caller.auth.getUser();
  let role: string | null = null;
  if (user) {
    role = (await caller.rpc('staff_role')).data;
    if (!role) return json({ error: 'Not on the staff list' }, 403);
  }

  let sa: { client_email: string; private_key: string } | null = null;
  try {
    sa = JSON.parse(Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON') ?? 'null');
  } catch {
    sa = null;
  }
  const configured = !!sa?.client_email && !!sa?.private_key;

  if (body.check) {
    if (!user) return json({ error: 'Sign in required' }, 401);
    return json({ configured, service_account: sa?.client_email ?? null });
  }
  if (user && role === 'viewer') return json({ error: 'Viewers cannot run the sync' }, 403);
  if (!configured) {
    return json({ error: 'Google access is not set up yet (GOOGLE_SERVICE_ACCOUNT_JSON secret missing)' }, user ? 400 : 200);
  }

  const { data: runId, error: startError } = await admin.rpc('sync_start', {
    p_trigger: user ? 'manual' : 'schedule',
    p_user: user?.id ?? null,
  });
  if (startError) return json({ error: startError.message }, 500);
  if (!runId) return json({ skipped: 'A sync ran less than a minute ago or is still running' });

  let rowsRead = 0, rowsNew = 0, rowsFailed = 0;
  try {
    const { rows, sources } = await readSheet(await googleToken(sa!));
    const header = rows[0] ?? [];
    const known = new Set<string>((await admin.rpc('sync_known_keys')).data ?? []);

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!clean(row[0]) && !clean(row[1])) continue;
      rowsRead++;
      const r = parseRow(row, i + 1, header, sources);
      if (!r.submitted_at) {
        await admin.from('sync_issues').insert({ run_id: runId, sheet_row: i + 1, kind: 'unreadable_timestamp' });
        rowsFailed++;
        continue;
      }
      if (known.has(`${r.submitted_at}|${r.name}`)) continue;

      const { data: projectId, error } = await admin.rpc('sync_ingest_row', { p_run: runId, r });
      if (error) {
        await admin.from('sync_issues').insert({ run_id: runId, sheet_row: i + 1, kind: 'row_failed' });
        rowsFailed++;
      } else if (projectId) {
        rowsNew++;
        known.add(`${r.submitted_at}|${r.name}`);
      }
    }
    await admin.rpc('sync_finish', {
      p_run: runId, p_status: 'ok', p_rows_read: rowsRead, p_rows_new: rowsNew, p_rows_failed: rowsFailed, p_error: null,
    });
    return json({ run: runId, rows_read: rowsRead, rows_new: rowsNew, rows_failed: rowsFailed });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await admin.rpc('sync_finish', {
      p_run: runId, p_status: 'failed', p_rows_read: rowsRead, p_rows_new: rowsNew, p_rows_failed: rowsFailed, p_error: message,
    });
    return json({ run: runId, error: message }, 500);
  }
});
