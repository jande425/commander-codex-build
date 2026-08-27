// Builds src/data/setnames.json: { SETCODE: "Set Name" } for the set codes that
// appear in our decklists. Used to request exact printings in TCGplayer carts.
//
//   npm run setnames
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');

const decklists = JSON.parse(readFileSync(resolve(dataDir, 'decklists.json'), 'utf8'));
const codes = new Set();
for (const id of Object.keys(decklists)) {
  for (const c of decklists[id].cards) if (c.s) codes.add(c.s.toUpperCase());
}

const res = await fetch('https://api.scryfall.com/sets', { headers: { 'User-Agent': 'CommanderCodex/0.1' } });
const sets = (await res.json()).data || [];
const map = {};
const symbols = {};
for (const s of sets) {
  const code = (s.code || '').toUpperCase();
  if (codes.has(code)) map[code] = s.name;
  // set icons for every set, keyed by code (used on cards/deck pages)
  if (s.icon_svg_uri) symbols[code] = s.icon_svg_uri;
}

writeFileSync(resolve(dataDir, 'setnames.json'), JSON.stringify(map), 'utf8');
writeFileSync(resolve(dataDir, 'setsymbols.json'), JSON.stringify(symbols), 'utf8');
const missing = [...codes].filter((c) => !map[c]);
console.log(`Wrote ${Object.keys(map).length} set names (of ${codes.size} codes used) and ${Object.keys(symbols).length} set icons.`);
if (missing.length) console.log('No Scryfall name for:', missing.join(', '));
