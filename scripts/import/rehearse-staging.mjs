// Rehearse the staging path (staging.sql + data/out/chunks) on an in-memory
// Postgres built from supabase/migrations, then call staging.run_import(true).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const db = new PGlite({ extensions: { citext } });

await db.exec(`
  create schema extensions;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  create role anon;
  create role authenticated;
`);
const migrations = path.join(root, 'supabase/migrations');
for (const f of fs.readdirSync(migrations).sort()) await db.exec(fs.readFileSync(path.join(migrations, f), 'utf8'));
await db.exec(fs.readFileSync(path.join(here, 'staging.sql'), 'utf8'));

const chunks = path.join(root, 'data/out/chunks');
for (const f of fs.readdirSync(chunks).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(fs.readFileSync(path.join(chunks, f), 'utf8'));
}

const manifest = JSON.parse(fs.readFileSync(path.join(chunks, 'manifest.json'), 'utf8'));
const prints = (await db.query('select tbl, n, rows, md5 from staging.chunk_fingerprints')).rows;
const bad = manifest.filter((m) => !prints.some((p) => p.tbl === m.tbl && p.n === m.n && p.rows === m.rows && p.md5 === m.md5));
console.log(`fingerprints: ${manifest.length - bad.length}/${manifest.length} chunks match`);

try {
  await db.query('select staging.run_import(true)');
  console.log('unexpected: dry run returned without raising');
} catch (err) {
  console.log(err.message);
}
const { rows } = await db.query('select count(*)::int as n from public.projects');
console.log(`projects after dry run: ${rows[0].n}`);
await db.close();
