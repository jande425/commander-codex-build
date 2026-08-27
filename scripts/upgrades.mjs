// Builds src/data/upgrades.json: the most-commonly added and cut cards for each
// precon, from EDHREC's community data (their precon page JSON). Cached per deck.
//
//   npm run upgrades
//
// Courtesy: paced requests, cached in .cache/edhrec, attributed to EDHREC in the UI.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');
const cacheDir = resolve(__dirname, '..', '.cache', 'edhrec');
mkdirSync(cacheDir, { recursive: true });

const decks = JSON.parse(readFileSync(resolve(dataDir, 'decks.json'), 'utf8'));
const HEADERS = { 'User-Agent': 'CommanderCodex/0.1 (deck browser)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// EDHREC isn't consistent about "&" (raining-cats-and-dogs vs scions-spellcraft),
// so try both an "and" and a removed variant.
function slugCandidates(name) {
  const base = name.toLowerCase().replace(/['’]/g, '');
  const fmt = (x) => x.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [...new Set([fmt(base.replace(/&/g, 'and')), fmt(base.replace(/&/g, ''))])];
}

const TOP_ADD = 20;
const TOP_CUT = 15;

async function getPrecon(slug) {
  const cached = resolve(cacheDir, slug + '.json');
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
  const url = `https://json.edhrec.com/pages/precon/${slug}.json`;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.status === 404) return null;
      if (!r.ok) { await sleep(1000); continue; }
      const j = await r.json();
      writeFileSync(cached, JSON.stringify(j), 'utf8');
      await sleep(180);
      return j;
    } catch {
      await sleep(800);
    }
  }
  return null;
}

function pick(cardlists, match, limit) {
  const lists = (cardlists || []).filter((l) => match.test(l.header || ''));
  const cards = [];
  lists.forEach((l) => (l.cardviews || []).forEach((cv) => cards.push(cv)));
  return cards
    .sort((a, b) => (b.inclusion || 0) - (a.inclusion || 0))
    .slice(0, limit)
    .map((cv) => ({
      n: cv.name,
      // share of upgrade decks that add/cut this card
      pct: cv.potential_decks ? Math.round((cv.inclusion / cv.potential_decks) * 100) : null,
    }));
}

const out = {};
const gaps = [];
let done = 0;

for (const d of decks) {
  const candidates = slugCandidates(d.deck);
  let slug = candidates[0];
  let cardlists = null;
  for (const cand of candidates) {
    const j = await getPrecon(cand);
    if (j?.container?.json_dict?.cardlists) {
      slug = cand;
      cardlists = j.container.json_dict.cardlists;
      break;
    }
  }
  if (!cardlists) {
    gaps.push(`${d.deck} (${candidates.join(' / ')})`);
    continue;
  }
  out[d.id] = {
    slug,
    add: pick(cardlists, /to Add/i, TOP_ADD),
    cut: pick(cardlists, /to Cut/i, TOP_CUT),
  };
  done++;
  if (done % 25 === 0) console.log(`  ...${done} decks`);
}

writeFileSync(resolve(dataDir, 'upgrades.json'), JSON.stringify(out), 'utf8');
const kb = readFileSync(resolve(dataDir, 'upgrades.json')).length / 1024;
console.log(`\nWrote upgrades for ${done}/${decks.length} decks (${kb.toFixed(0)} KB).`);
if (gaps.length) {
  console.log(`\nNo EDHREC precon page for ${gaps.length}:`);
  gaps.forEach((g) => console.log('  ' + g));
}
