// Alternative to load.mjs when there is no direct database connection:
// split data/out/import.json into compact INSERT statements for staging.chunks
// (see staging.sql), each small enough to send through the Supabase MCP tools.
//
// Usage: node stage-chunks.mjs [maxCharsPerChunk=40000]
// Output: data/out/chunks/NNN_<table>.sql
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Fingerprint of a chunk's values, reproducible in SQL (see manifest check in staging.sql):
// every cell as text (null -> '∅'), joined with '|' in row/column order, md5.
const fingerprint = (rows) =>
  crypto.createHash('md5')
    .update(rows.flatMap((r) => r.map((v) => (v === null || v === undefined ? '∅' : String(v)))).join('|'))
    .digest('hex');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const maxChars = +(process.argv[2] ?? 40000);
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/out/import.json'), 'utf8'));

const actionsOf = (note) => note?.match(/Number of Action: ([^)]+)\)/)?.[1] ?? null;

// Column order must match staging.run_import()
const SHAPES = {
  people: (r) => [r.id, r.national_id, r.full_name_ar, r.phone, r.email],
  projects: (r) => [r.id, r.name, r.description, r.stage_slug, r.governorate_code, r.district_name, r.sector_slug,
    r.sector_other, r.founded_on, r.social_url, r.source_slug, r.university, r.track, r.submitted_at, r.status],
  project_members: (r) => [r.id, r.project_id, r.person_id, r.is_lead, r.position, r.confirmation, r.notes],
  contact_attempts: (r) => [r.project_member_id, r.channel === 'call' ? 'c' : 'w', r.attempted_at, actionsOf(r.notes)],
  screening_reviews: (r) => [r.project_id, r.status],
  project_issues: (r) => [r.project_id, r.issue_label],
  interviews: (r) => [r.project_id, r.scheduled_at, r.status, r.decision, r.recommended_round_number, r.reasons],
  round_enrollments: (r) => [r.id, r.project_id, r.round_number, r.code],
  round_participants: (r) => [r.enrollment_id, r.person_id],
  prior_participations: (r) => [r.person_id, r.national_id, r.full_name, r.phone, r.birthdate, r.organization_name,
    r.program_label, r.project_name, r.year ?? null, r.kobo_code ?? null, r.referral ?? null],
};

// Combining marks (Arabic harakat etc.) and invisible/format characters are
// written as \uXXXX escapes so they survive being copied by hand or by a model
// without being reordered, normalized or dropped. Values are unchanged.
const FRAGILE = /[\p{M}\p{Cf}\u180e\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/gu;
const escapeFragile = (json) =>
  json.replace(FRAGILE, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

// Trim trailing nulls to save space; positional reads return null for them anyway
const compact = (arr) => {
  let end = arr.length;
  while (end > 0 && (arr[end - 1] === null || arr[end - 1] === undefined)) end--;
  return arr.slice(0, end);
};

const outDir = path.join(root, 'data/out/chunks');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

let fileNo = 0;
let total = 0;
const manifest = [];
for (const [table, shape] of Object.entries(SHAPES)) {
  const rows = data[table].map((r) => escapeFragile(JSON.stringify(compact(shape(r)))));
  let chunk = [];
  let size = 0;
  let n = 0;
  const flush = () => {
    if (!chunk.length) return;
    const json = `[${chunk.join(',')}]`;
    manifest.push({ tbl: table, n, rows: chunk.length, md5: fingerprint(JSON.parse(json)) });
    if (json.includes('$j$')) throw new Error(`chunk for ${table} contains the $j$ delimiter`);
    const sql = `insert into staging.chunks (tbl, n, rows) values ('${table}', ${n}, $j$${json}$j$::jsonb);\n`;
    fs.writeFileSync(path.join(outDir, `${String(++fileNo).padStart(3, '0')}_${table}.sql`), sql);
    total += sql.length;
    n++;
    chunk = [];
    size = 0;
  };
  for (const row of rows) {
    if (size + row.length > maxChars) flush();
    chunk.push(row);
    size += row.length + 1;
  }
  flush();
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`${fileNo} chunk files, ${total} chars, in data/out/chunks (+ manifest.json)`);
