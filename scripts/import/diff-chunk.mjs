// Compare per-row fingerprints of one chunk file against fingerprints read
// back from staging (pass them as a JSON file: [{"id":1,"md5":"..."}]),
// and list rows that contain invisible/format characters.
//
// Usage: node diff-chunk.mjs <chunk.sql> [remote-rows.json]
import crypto from 'node:crypto';
import fs from 'node:fs';

const INVISIBLE = /[­؜᠎​-‏‪-‮⁠-⁩︀-️﻿]/gu;

const sql = fs.readFileSync(process.argv[2], 'utf8');
const rows = JSON.parse(sql.slice(sql.indexOf('$j$') + 3, sql.lastIndexOf('$j$')));
const remote = process.argv[3] ? Object.fromEntries(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')).map((r) => [r.id, r.md5])) : {};

for (const r of rows) {
  const md5 = crypto.createHash('md5').update(r.map((v) => (v === null || v === undefined ? '∅' : String(v))).join('|')).digest('hex');
  const odd = [...new Set((JSON.stringify(r).match(INVISIBLE) ?? []).map((c) => 'U+' + c.codePointAt(0).toString(16)))];
  const differs = remote[r[0]] && remote[r[0]] !== md5;
  if (differs || odd.length) console.log(`row ${r[0]}: ${differs ? 'DIFFERS' : 'ok'}${odd.length ? ' invisible: ' + odd.join(',') : ''}`);
}
