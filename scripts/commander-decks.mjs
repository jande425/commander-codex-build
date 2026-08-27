// Builds src/data/commander-decks.json: for EVERY legal commander, its EDHREC
// average deck (card names + inclusion %) plus its theme tags — in one request
// each (the average-deck JSON carries both). This powers instant completion %,
// cost-to-build, and tag filtering across the whole commander list.
//
//   npm run commander-decks
//   node scripts/commander-decks.mjs 20   # quick test
//
// Courtesy: paced + cached in .cache/edhrec-avg (shared with averages.mjs).
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
const canon = (n) => n.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const all = JSON.parse(readFileSync(resolve(dataDir, 'commanders-all.json'), 'utf8')).slice(0, limit);

function slugCandidates(slug, name) {
  const base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '');
  const fromName = base.replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [...new Set([slug, fromName])].filter(Boolean);
}

async function getAvg(slug) {
  const cached = resolve(cacheDir, slug + '.json');
  if (existsSync(cached)) {
    try { return JSON.parse(readFileSync(cached, 'utf8')); } catch { return null; }
  }
  const url = `https://json.edhrec.com/pages/average-decks/${slug}.json`;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.status === 404) { writeFileSync(cached, 'null', 'utf8'); return null; }
      if (!r.ok) { await sleep(900); continue; }
      const j = await r.json();
      writeFileSync(cached, JSON.stringify(j), 'utf8');
      await sleep(160);
      return j;
    } catch { await sleep(700); }
  }
  return null;
}

// Compact shape: cards as plain name strings, tags as plain value strings. The
// build list only needs names (for ownership), tags (for filtering), colors and
// deck count — inclusion %, ids and slugs are fetched live when a deck is opened.
function reduce(json, c) {
  const lists = json?.container?.json_dict?.cardlists;
  if (!Array.isArray(lists)) return null;
  const cmdCanon = canon(c.name);
  const cards = [];
  for (const l of lists)
    for (const cv of l.cardviews || []) {
      if (!cv.name || canon(cv.name) === cmdCanon) continue;
      cards.push(cv.name);
    }
  if (!cards.length) return null;
  const tags = (json?.panels?.taglinks || []).filter((t) => t.value).map((t) => t.value);
  return {
    name: c.name,
    slug: c.slug,
    colors: c.colors,
    deckCount: json?.container?.json_dict?.card?.num_decks ?? null,
    tags,
    cards,
  };
}

const out = {};
let done = 0, kept = 0;
for (const c of all) {
  let json = null;
  for (const cand of slugCandidates(c.slug, c.name)) {
    json = await getAvg(cand);
    if (json) break;
  }
  const deck = json && reduce(json, c);
  if (deck) { out[c.slug] = deck; kept++; }
  if (++done % 50 === 0 || done === all.length) console.log(`  ${done}/${all.length} (kept ${kept})`);
}

writeFileSync(resolve(dataDir, 'commander-decks.json'), JSON.stringify(out), 'utf8');
const bytes = readFileSync(resolve(dataDir, 'commander-decks.json')).length;
const tagSet = new Set();
Object.values(out).forEach((d) => d.tags.forEach((t) => tagSet.add(t.value)));
console.log(`\nWrote ${kept} commander decks (${(bytes / 1024 / 1024).toFixed(2)} MB), ${tagSet.size} distinct tags.`);
