// Step 3: load data/out/import.json in one transaction.
//
//   node load.mjs --target=pglite --dry-run    rehearse on an in-memory Postgres
//                                               built from supabase/migrations
//   node --env-file=../../.env load.mjs --target=supabase --dry-run
//   node --env-file=../../.env load.mjs --target=supabase
//
// --dry-run loads everything, prints the checks, then rolls back.
// Refuses to run when public.projects already has rows.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const target = args.target ?? 'pglite';
const dryRun = 'dry-run' in args;

const data = JSON.parse(fs.readFileSync(path.join(root, 'data/out/import.json'), 'utf8'));

// ---------------------------------------------------------------------
// Connections: both expose query(text, params) -> rows and close()
// ---------------------------------------------------------------------
async function connectPglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { citext } = await import('@electric-sql/pglite/contrib/citext');
  const db = new PGlite({ extensions: { citext } });
  // What Supabase provides out of the box
  await db.exec(`
    create schema extensions;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create role anon;
    create role authenticated;
  `);
  const dir = path.join(root, 'supabase/migrations');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  return {
    query: async (text, params) => (await db.query(text, params)).rows,
    close: () => db.close(),
  };
}

async function connectSupabase() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error('SUPABASE_DB_URL is not set. Add it to .env at the repo root (Project Settings → Database → connection string).');
    process.exit(1);
  }
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const conn = await sql.reserve();
  return {
    query: (text, params = []) => conn.unsafe(text, params),
    close: async () => {
      conn.release();
      await sql.end();
    },
  };
}

// ---------------------------------------------------------------------
// Inserts: each table is one INSERT ... SELECT FROM json_to_recordset($1)
// Lookups are resolved by slug/label inside SQL.
// ---------------------------------------------------------------------
const CAIRO = (col) => `(${col}::timestamp at time zone 'Africa/Cairo')`;

const steps = [
  ['people', `
    insert into public.people (id, national_id, full_name_ar, phone, email)
    overriding system value
    select id, national_id, full_name_ar, phone, email
    from json_to_recordset($1::json)
      as x(id bigint, national_id text, full_name_ar text, phone text, email text)`],

  ['projects', `
    insert into public.projects (id, code, name, description, stage_id, governorate_code, district_id,
                                 sector_id, sector_other, founded_on, social_url, source_id, university,
                                 track, submitted_at, status)
    overriding system value
    select x.id, x.code, x.name, x.description, st.id, x.governorate_code, d.id,
           s.id, x.sector_other, x.founded_on, x.social_url, src.id, x.university,
           x.track, ${CAIRO('x.submitted_at')}, x.status::public.project_status
    from json_to_recordset($1::json)
      as x(id bigint, code text, name text, description text, stage_slug text, governorate_code smallint,
           district_name text, sector_slug text, sector_other text, founded_on date, social_url text,
           source_slug text, university text, track text, submitted_at text, status text)
    join public.intake_sources src on src.slug = x.source_slug
    left join public.project_stages st on st.slug = x.stage_slug
    left join public.sectors s on s.slug = x.sector_slug
    left join public.districts d on d.governorate_code = 25 and d.name_ar = x.district_name`],

  ['intake_submissions', `
    insert into public.intake_submissions (id, source_id, submitted_at, payload, project_id, sheet_tab, sheet_row)
    overriding system value
    select x.id, src.id, ${CAIRO('x.submitted_at')}, x.payload, x.project_id, x.sheet_tab, x.sheet_row
    from json_to_recordset($1::json)
      as x(id bigint, source_slug text, submitted_at text, payload jsonb, project_id bigint,
           sheet_tab text, sheet_row int)
    join public.intake_sources src on src.slug = x.source_slug`],

  ['project_members', `
    insert into public.project_members (id, project_id, person_id, is_lead, position, confirmation, notes)
    overriding system value
    select id, project_id, person_id, is_lead, position, confirmation::public.confirmation, notes
    from json_to_recordset($1::json)
      as x(id bigint, project_id bigint, person_id bigint, is_lead boolean, position smallint,
           confirmation text, notes text)`],

  ['contact_attempts', `
    insert into public.contact_attempts (project_member_id, channel, attempted_at, notes)
    select project_member_id, channel::public.contact_channel, ${CAIRO('attempted_at')}, notes
    from json_to_recordset($1::json)
      as x(project_member_id bigint, channel text, attempted_at text, notes text)`],

  ['screening_reviews', `
    insert into public.screening_reviews (project_id, status, notes)
    select project_id, status::public.review_status, 'Imported from sheet (Shoruk - Validation)'
    from json_to_recordset($1::json) as x(project_id bigint, status text)`],

  ['project_issues', `
    insert into public.project_issues (project_id, issue_id)
    select x.project_id, i.id
    from json_to_recordset($1::json) as x(project_id bigint, issue_label text)
    join public.screening_issues i on i.label_ar = x.issue_label`],

  ['interviews', `
    insert into public.interviews (project_id, scheduled_at, status, decision, recommended_round_id, reasons)
    select x.project_id, ${CAIRO('x.scheduled_at')}, x.status::public.interview_status,
           x.decision::public.decision, r.id, x.reasons
    from json_to_recordset($1::json)
      as x(project_id bigint, scheduled_at text, status text, decision text,
           recommended_round_number smallint, reasons text)
    left join public.rounds r on r.year = 2026 and r.number = x.recommended_round_number`],

  ['round_enrollments', `
    insert into public.round_enrollments (id, round_id, project_id, code)
    overriding system value
    select x.id, r.id, x.project_id, x.code
    from json_to_recordset($1::json)
      as x(id bigint, project_id bigint, round_number smallint, code text)
    join public.rounds r on r.year = 2026 and r.number = x.round_number`],

  ['round_participants', `
    insert into public.round_participants (enrollment_id, person_id)
    select enrollment_id, person_id
    from json_to_recordset($1::json) as x(enrollment_id bigint, person_id bigint)`],

  ['prior_participations', `
    insert into public.prior_participations (person_id, national_id, full_name, phone, birthdate, project_name,
                                             organization_id, program_label, year, kobo_code, referral)
    select x.person_id, x.national_id, x.full_name, x.phone, x.birthdate, x.project_name,
           o.id, x.program_label, x.year, x.kobo_code, x.referral::public.referral_type
    from json_to_recordset($1::json)
      as x(person_id bigint, national_id text, full_name text, phone text, birthdate date, project_name text,
           organization_name text, program_label text, year smallint, kobo_code text, referral text)
    left join public.organizations o on o.name = x.organization_name`],
];

const IDENTITY_TABLES = ['people', 'projects', 'project_members', 'intake_submissions', 'round_enrollments'];

// ---------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------
const db = target === 'supabase' ? await connectSupabase() : await connectPglite();
let failed = false;

try {
  const [{ n }] = await db.query('select count(*)::int as n from public.projects');
  if (n > 0) throw new Error(`public.projects already has ${n} rows; refusing to import twice.`);

  await db.query('begin');
  console.log(`Target: ${target}${dryRun ? ' (dry run, will roll back)' : ''}\n`);
  console.log('table                  expected   inserted');

  for (const [table, sql] of steps) {
    const rows = data[table];
    await db.query(sql, [JSON.stringify(rows)]);
    const [{ n: inserted }] = await db.query(`select count(*)::int as n from public.${table}`);
    const ok = inserted === rows.length;
    if (!ok) failed = true;
    console.log(`${table.padEnd(22)} ${String(rows.length).padStart(8)} ${String(inserted).padStart(10)}${ok ? '' : '   <-- MISMATCH'}`);
  }

  for (const table of IDENTITY_TABLES) {
    await db.query(`select setval(pg_get_serial_sequence('public.${table}', 'id'), (select max(id) from public.${table}))`);
  }
  await db.query(`select setval('public.project_code_seq', (select max(id) from public.projects))`);

  // Checks
  const checks = {
    'status history events': 'select count(*)::int as n from public.project_status_events',
    'people with an invalid / missing ID': 'select count(*)::int as n from public.people where not nid_valid',
    'projects without a sector': 'select count(*)::int as n from public.projects where sector_id is null',
    'projects without a stage': 'select count(*)::int as n from public.projects where stage_id is null',
    'enrollments with generated codes': `select count(*)::int as n from public.round_enrollments where code !~ '^R_\\d{2}_TR\\d+$'`,
    'rows in v_ready_to_attend': 'select count(*)::int as n from public.v_ready_to_attend',
    'prior participations linked to people': 'select count(*)::int as n from public.prior_participations where person_id is not null',
  };
  console.log('\nchecks');
  for (const [label, q] of Object.entries(checks)) {
    const [{ n: value }] = await db.query(q);
    console.log(`  ${label.padEnd(40)} ${value}`);
  }

  console.log('\nv_funnel');
  const funnel = await db.query('select status::text, projects::int, individuals::int, male::int, female::int, invalid_id::int from public.v_funnel order by projects desc');
  console.log('  status        projects  people  male  female  invalid_id');
  for (const f of funnel) {
    console.log(`  ${f.status.padEnd(13)} ${String(f.projects).padStart(8)} ${String(f.individuals).padStart(7)} ${String(f.male).padStart(5)} ${String(f.female).padStart(7)} ${String(f.invalid_id).padStart(11)}`);
  }

  console.log('\nround enrollments');
  const rounds = await db.query(`
    select r.name, p.name_en as program, count(distinct e.id)::int as projects, count(rp.id)::int as people
    from public.rounds r join public.programs p on p.id = r.program_id
    left join public.round_enrollments e on e.round_id = r.id
    left join public.round_participants rp on rp.enrollment_id = e.id
    group by r.number, r.name, p.name_en order by r.number`);
  for (const r of rounds) console.log(`  ${r.name}  ${r.program.padEnd(24)} ${String(r.projects).padStart(4)} projects ${String(r.people).padStart(5)} people`);

  if (failed) throw new Error('Row counts did not match; rolling back.');
  await db.query(dryRun ? 'rollback' : 'commit');
  console.log(dryRun ? '\nDry run complete: rolled back, nothing saved.' : '\nCommitted.');
} catch (err) {
  await db.query('rollback').catch(() => {});
  console.error(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
