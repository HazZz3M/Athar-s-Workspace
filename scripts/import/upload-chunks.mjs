// Upload the chunk files in data/out/chunks that staging.chunks doesn't have
// yet, then compare every staged chunk's fingerprint with manifest.json.
// Prints table/chunk numbers and counts only, never row contents.
//
//   node upload-chunks.mjs
//
// Uses SUPABASE_DB_URL if set, otherwise asks only for the Athar project's
// database password and tries the session pooler, then the direct host.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'data/out/chunks');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const key = (tbl, n) => `${tbl}/${n}`;

// Only the Athar project; the password is the only thing asked for
const PROJECT = 'bupgddkyfugczweqiotc';
const REGION = 'eu-west-1';

// Ask for the database password without echoing it
async function askPassword(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => rl.output.write(s.startsWith(prompt) ? prompt : '');
  const answer = await rl.question(prompt);
  rl.close();
  process.stdout.write('\n');
  return answer.trim();
}

const options = { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 15, database: 'postgres', ssl: 'require' };
let candidates;
if (process.env.SUPABASE_DB_URL) {
  candidates = [{ label: 'SUPABASE_DB_URL', connect: () => postgres(process.env.SUPABASE_DB_URL, options) }];
} else {
  const password = await askPassword('Database password for the Athar project (typing stays hidden): ');
  const via = (host, user) => ({
    label: host,
    connect: () => postgres({ ...options, host, port: 5432, user, password }),
  });
  // Session pooler hosts first (work on IPv4 home networks), then the direct host
  candidates = [
    via(`aws-0-${REGION}.pooler.supabase.com`, `postgres.${PROJECT}`),
    via(`aws-1-${REGION}.pooler.supabase.com`, `postgres.${PROJECT}`),
    via(`db.${PROJECT}.supabase.co`, 'postgres'),
  ];
}

let sql;
for (const c of candidates) {
  const attempt = c.connect();
  try {
    await attempt`select 1`;
    sql = attempt;
    console.log(`Connected via ${c.label}`);
    break;
  } catch (err) {
    console.log(`  could not connect via ${c.label}: ${err.message}`);
    await attempt.end({ timeout: 1 });
  }
}
if (!sql) {
  console.log('\nFAILED: could not connect. If the messages above mention the password, reset it in');
  console.log('Supabase > Project Settings > Database > Reset database password, then run this again.');
  process.exit(1);
}

try {
  const staged = new Set((await sql`select tbl, n from staging.chunks`).map((r) => key(r.tbl, r.n)));

  // Map each chunk file to its (tbl, n) from the insert header
  const files = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const m = fs.readFileSync(path.join(dir, f), 'utf8').match(/values \('(\w+)', (\d+),/);
    if (m) files[key(m[1], +m[2])] = f;
  }

  const missing = manifest.filter((c) => !staged.has(key(c.tbl, c.n)));
  console.log(`${staged.size} chunks already staged, uploading ${missing.length}`);
  for (const c of missing) {
    const f = files[key(c.tbl, c.n)];
    if (!f) throw new Error(`no chunk file for ${key(c.tbl, c.n)}`);
    await sql.unsafe(fs.readFileSync(path.join(dir, f), 'utf8'));
    console.log(`  uploaded ${f}`);
  }

  const remote = Object.fromEntries(
    (await sql`select tbl, n, rows, md5 from staging.chunk_fingerprints`).map((r) => [key(r.tbl, r.n), r]),
  );
  let bad = 0;
  for (const c of manifest) {
    const r = remote[key(c.tbl, c.n)];
    if (!r || r.rows !== c.rows || r.md5 !== c.md5) {
      bad++;
      console.log(`  MISMATCH ${key(c.tbl, c.n)}: expected ${c.rows} rows ${c.md5}, got ${r ? `${r.rows} rows ${r.md5}` : 'nothing'}`);
    }
  }
  console.log(bad ? `${bad} of ${manifest.length} chunks do not match` : `All ${manifest.length} chunks match manifest.json`);
  process.exitCode = bad ? 1 : 0;
} catch (err) {
  console.log(`\nFAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
