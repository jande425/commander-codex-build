// Builds src/data/commanders-all.json: every legal Commander (legendary creature
// or "can be your commander" card) from Scryfall, as a lightweight picker list —
// name, color identity, an art id, and the EDHREC slug. ~3.3k entries. This lets
// the user choose ANY commander; the deck data is then fetched live from EDHREC.
//
//   npm run commander-list
//
// Scryfall: User-Agent, ~100ms between pages, paginated search.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');
const HEADERS = { 'User-Agent': 'CommanderCodex/0.1 (deck builder)', Accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function slug(name) {
  const base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '');
  return base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const out = [];
let url = 'https://api.scryfall.com/cards/search?q=' + encodeURIComponent('is:commander legal:commander') + '&unique=cards&order=edhrec';
let page = 0;
while (url) {
  let j = null;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.status === 429) { await sleep(1500); continue; }
      j = await r.json();
      break;
    } catch { await sleep(800); }
  }
  if (!j || !j.data) break;
  for (const c of j.data) {
    out.push({
      name: c.name,
      colors: c.color_identity || [],
      id: c.id, // a printing id, for art
      slug: slug(c.name),
    });
  }
  page++;
  console.log(`  page ${page}: ${out.length} so far`);
  url = j.has_more ? j.next_page : null;
  await sleep(110);
}

// De-dupe by name (unique=cards should already, but be safe), keep first.
const seen = new Set();
const dedup = out.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
writeFileSync(resolve(dataDir, 'commanders-all.json'), JSON.stringify(dedup), 'utf8');
console.log(`\nWrote ${dedup.length} commanders.`);
