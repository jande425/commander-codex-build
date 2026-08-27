// Builds src/data/commanders.json: a per-commander "virtual deck" of the cards
// EDHREC's community most often plays, with each card's inclusion % (share of
// that commander's decks running it). Used to score how close the user's
// collection is to a typical strong build of any given commander.
//
//   npm run commanders            # scrape the full seed list
//   node scripts/commanders.mjs 5 # scrape only the first 5 (quick test)
//
// Courtesy: paced requests, cached in .cache/edhrec-cmd, attributed to EDHREC.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');
const cacheDir = resolve(__dirname, '..', '.cache', 'edhrec-cmd');
mkdirSync(cacheDir, { recursive: true });

const limit = process.argv[2] ? parseInt(process.argv[2], 10) : Infinity;
const HEADERS = { 'User-Agent': 'CommanderCodex/0.1 (deck builder)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seed commander list: every distinct commander that leads a precon (we already
// ship these), split on partner pairs. Extra names can be added in
// src/data/commanders-seed.json (an array of commander display names).
const decks = JSON.parse(readFileSync(resolve(dataDir, 'decks.json'), 'utf8'));
const seedFile = resolve(dataDir, 'commanders-seed.json');
const extra = existsSync(seedFile) ? JSON.parse(readFileSync(seedFile, 'utf8')) : [];

const names = new Set();
for (const d of decks) {
  for (const part of String(d.commander).split(' & ')) names.add(part.trim());
}
for (const n of extra) names.add(String(n).trim());
const seed = [...names].filter(Boolean).slice(0, limit);

function slugCandidates(name) {
  // strip diacritics so "Éowyn" -> "eowyn", "Clavileño" -> "clavileno"
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '');
  const fmt = (x) => x.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [...new Set([fmt(base.replace(/&/g, 'and')), fmt(base.replace(/&/g, ''))])];
}

const canon = (name) =>
  name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

async function getCommander(slug) {
  const cached = resolve(cacheDir, slug + '.json');
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
  const url = `https://json.edhrec.com/pages/commanders/${slug}.json`;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.status === 404) return null;
      if (!r.ok) { await sleep(1000); continue; }
      const j = await r.json();
      writeFileSync(cached, JSON.stringify(j), 'utf8');
      await sleep(200);
      return j;
    } catch {
      await sleep(800);
    }
  }
  return null;
}

// Sections that are duplicate "highlight" reels rather than real categories;
// their cards also appear in the type sections, so we skip them when collecting
// (we still dedupe defensively).
const SKIP_HEADERS = /^(new cards|game changers)/i;

function collectCards(json, commanderName) {
  const lists = json?.container?.json_dict?.cardlists || [];
  const cmdCanon = canon(commanderName);
  const byName = new Map();
  for (const l of lists) {
    if (SKIP_HEADERS.test(l.header || '')) continue;
    for (const cv of l.cardviews || []) {
      if (!cv.name) continue;
      if (canon(cv.name) === cmdCanon) continue; // the commander itself
      const pct =
        cv.potential_decks > 0 ? Math.round((cv.num_decks / cv.potential_decks) * 100) : null;
      const prev = byName.get(cv.name);
      if (!prev || (pct ?? -1) > (prev.pct ?? -1)) byName.set(cv.name, { n: cv.name, pct });
    }
  }
  // Highest-inclusion first.
  return [...byName.values()].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
}

const out = {};
const gaps = [];
let done = 0;

for (const name of seed) {
  const candidates = slugCandidates(name);
  let json = null;
  let usedSlug = candidates[0];
  for (const cand of candidates) {
    json = await getCommander(cand);
    if (json) { usedSlug = cand; break; }
  }
  if (!json) {
    gaps.push(name);
  } else {
    const cards = collectCards(json, name);
    const deckCount = json?.container?.json_dict?.card?.num_decks ?? null;
    out[canon(name)] = { name, slug: usedSlug, deckCount, cards };
  }
  done++;
  if (done % 10 === 0 || done === seed.length) console.log(`  ${done}/${seed.length}`);
}

writeFileSync(resolve(dataDir, 'commanders.json'), JSON.stringify(out), 'utf8');
const bytes = readFileSync(resolve(dataDir, 'commanders.json')).length;
const counts = Object.values(out).map((c) => c.cards.length);
console.log(
  `\nWrote ${Object.keys(out).length} commanders (${(bytes / 1024).toFixed(0)} KB), ` +
    `avg ${Math.round(counts.reduce((a, b) => a + b, 0) / (counts.length || 1))} cards each.`
);
if (gaps.length) console.log(`No EDHREC page for ${gaps.length}: ${gaps.slice(0, 10).join(', ')}${gaps.length > 10 ? '…' : ''}`);
