// Builds src/data/averages.json: EDHREC's "average deck" for each commander — a
// concrete ~99-card recommended list (not just inclusion stats), so the user can
// browse a buildable EDHREC deck idea per commander and see completion.
//
//   npm run averages
//   node scripts/averages.mjs 5   # quick test
//
// Courtesy: paced requests, cached in .cache/edhrec-avg, attributed to EDHREC.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');
const cacheDir = resolve(__dirname, '..', '.cache', 'edhrec-avg');
mkdirSync(cacheDir, { recursive: true });

const limit = process.argv[2] ? parseInt(process.argv[2], 10) : Infinity;
const HEADERS = { 'User-Agent': 'CommanderCodex/0.1 (deck builder)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const decks = JSON.parse(readFileSync(resolve(dataDir, 'decks.json'), 'utf8'));
const seedFile = resolve(dataDir, 'commanders-seed.json');
const extra = existsSync(seedFile) ? JSON.parse(readFileSync(seedFile, 'utf8')) : [];
const names = new Set();
for (const d of decks) for (const part of String(d.commander).split(' & ')) names.add(part.trim());
for (const n of extra) names.add(String(n).trim());
const seed = [...names].filter(Boolean).slice(0, limit);

function slugCandidates(name) {
  const base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '');
  const fmt = (x) => x.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [...new Set([fmt(base.replace(/&/g, 'and')), fmt(base.replace(/&/g, ''))])];
}
const canon = (name) =>
  name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

async function getAvg(slug) {
  const cached = resolve(cacheDir, slug + '.json');
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
  const url = `https://json.edhrec.com/pages/average-decks/${slug}.json`;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.status === 404) return null;
      if (!r.ok) { await sleep(1000); continue; }
      const j = await r.json();
      writeFileSync(cached, JSON.stringify(j), 'utf8');
      await sleep(200);
      return j;
    } catch { await sleep(800); }
  }
  return null;
}

function collect(json, commanderName) {
  const lists = json?.container?.json_dict?.cardlists || [];
  const cmdCanon = canon(commanderName);
  const cards = [];
  for (const l of lists) {
    for (const cv of l.cardviews || []) {
      if (!cv.name || canon(cv.name) === cmdCanon) continue;
      const pct = cv.potential_decks > 0 ? Math.round((cv.num_decks / cv.potential_decks) * 100) : null;
      cards.push({ n: cv.name, q: 1, pct });
    }
  }
  return cards;
}

const out = {};
const gaps = [];
let done = 0;
for (const name of seed) {
  let json = null;
  let usedSlug = slugCandidates(name)[0];
  for (const cand of slugCandidates(name)) {
    json = await getAvg(cand);
    if (json) { usedSlug = cand; break; }
  }
  if (!json) gaps.push(name);
  else {
    const cards = collect(json, name);
    if (cards.length) {
      const deckCount = json?.container?.json_dict?.card?.num_decks ?? null;
      out[canon(name)] = { name, slug: usedSlug, deckCount, cards };
    }
  }
  if (++done % 10 === 0 || done === seed.length) console.log(`  ${done}/${seed.length}`);
}

writeFileSync(resolve(dataDir, 'averages.json'), JSON.stringify(out), 'utf8');
const bytes = readFileSync(resolve(dataDir, 'averages.json')).length;
const counts = Object.values(out).map((c) => c.cards.length);
console.log(
  `\nWrote ${Object.keys(out).length} average decks (${(bytes / 1024).toFixed(0)} KB), ` +
    `avg ${Math.round(counts.reduce((a, b) => a + b, 0) / (counts.length || 1))} cards each.`
);
if (gaps.length) console.log(`No average deck for ${gaps.length}: ${gaps.slice(0, 8).join(', ')}${gaps.length > 8 ? '…' : ''}`);
