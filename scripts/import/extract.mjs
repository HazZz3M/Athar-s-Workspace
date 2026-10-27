// Step 1: turn a Google Sheets API `spreadsheets.get` dump (includeGridData,
// formattedValue) into data/raw/sheets.json: { "<tab>": [[cell, ...], ...] }.
// Several ranges of the same tab are merged into one grid by their offsets.
//
// Usage: node extract.mjs <spreadsheets.get dump.json>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const input = process.argv[2];
if (!input) {
  console.error('usage: node extract.mjs <spreadsheets.get dump.json>');
  process.exit(1);
}

const dump = JSON.parse(fs.readFileSync(input, 'utf8'));
const grids = {};

for (const sheet of dump.sheets) {
  const title = sheet.properties.title;
  const grid = (grids[title] ??= []);
  for (const block of sheet.data ?? []) {
    const r0 = block.startRow ?? 0;
    const c0 = block.startColumn ?? 0;
    (block.rowData ?? []).forEach((row, i) => {
      const target = (grid[r0 + i] ??= []);
      (row.values ?? []).forEach((cell, j) => {
        target[c0 + j] = cell.formattedValue ?? '';
      });
    });
  }
}

// Fill holes so every row is a dense array of strings
for (const grid of Object.values(grids)) {
  for (let i = 0; i < grid.length; i++) {
    const row = grid[i] ?? [];
    grid[i] = Array.from(row, (v) => v ?? '');
  }
}

const outDir = path.join(root, 'data/raw');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'sheets.json'), JSON.stringify(grids));
for (const [title, grid] of Object.entries(grids)) {
  console.log(`${title.padEnd(40)} ${grid.length} rows`);
}
