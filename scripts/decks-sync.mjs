// Discovers newly released preconstructed Commander decks from MTGJSON and
// appends them to src/data/decks.json — preserving the existing curated decks
// and their stable ids (collection status, decklists and enrichment are keyed by
// id, so ids must never churn). Idempotent: a deck already present (matched by
// set code + normalised name) is skipped, so only genuinely new decks are added.
//
//   node scripts/decks-sync.mjs
//
// After it adds decks, run `npm run decklists` and `npm run enrich` to fill in
// each new deck's card list and commander art. The deck-sync GitHub workflow
// does all three and commits the result when the list actually changed.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');
const cacheDir = resolve(__dirname, '..', '.cache', 'decks');
mkdirSync(cacheDir, { recursive: true });

const HEADERS = { 'User-Agent': 'CommanderCodex/1.0 (deck browser)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// same normalisation decklists.mjs uses to match our decks to MTGJSON entries
const norm = (s) => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
const kebab = (s) => s.replace(/['’]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

async function getJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.status === 404) return null;
      if (!r.ok) { await sleep(800); continue; }
      return await r.json();
    } catch { await sleep(800); }
  }
  return null;
}
async function getDeckFile(fileName) {
  const cached = resolve(cacheDir, fileName + '.json');
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
  const j = await getJSON(`https://mtgjson.com/api/v5/decks/${fileName}.json`);
  await sleep(80);
  if (j) writeFileSync(cached, JSON.stringify(j), 'utf8');
  return j;
}

const decks = JSON.parse(readFileSync(resolve(dataDir, 'decks.json'), 'utf8'));

// set code -> display name (Scryfall), to fill a new deck's `set` field
const setNames = {};
const sets = await getJSON('https://api.scryfall.com/sets');
for (const s of sets?.data || []) setNames[s.code.toUpperCase()] = s.name;

const have = new Set(decks.map((d) => `${d.code}|${norm(d.deck)}`));
const haveNames = new Set(decks.map((d) => norm(d.deck))); // for reprint dedupe
const haveIds = new Set(decks.map((d) => d.id));

// Reprint compilations / anthologies re-release old decks under a new code; we
// keep one entry per precon, so skip these set codes entirely.
const REPRINT_CODES = new Set(['CMA', 'CM1', 'CM2', 'TD0', 'CMB1', 'CMB2', 'PZ1', 'PZ2']);

const index = (await getJSON('https://mtgjson.com/api/v5/DeckList.json'))?.data?.filter((d) => /Commander/i.test(d.type || '')) || [];
console.log(`MTGJSON: ${index.length} commander decks · we have ${decks.length}`);

const added = [];
for (const entry of index) {
  if (have.has(`${entry.code}|${norm(entry.name)}`)) continue; // already curated
  // "Collector's Edition" listings are premium reprints of a standard deck
  if (/collector'?s edition/i.test(entry.name)) continue;
  if (REPRINT_CODES.has(entry.code)) continue; // anthology/reprint compilation
  if (haveNames.has(norm(entry.name))) continue; // same deck name we already have (reprint)
  const dd = (await getDeckFile(entry.fileName))?.data;
  const commanders = (dd?.commander || []).map((c) => c.name).filter(Boolean);
  if (!commanders.length) continue; // can't represent without a commander

  let id = `${entry.code}-${kebab(entry.name)}`;
  for (let n = 2; haveIds.has(id); n++) id = `${entry.code}-${kebab(entry.name)}-${n}`;
  haveIds.add(id);

  const deck = {
    id,
    year: parseInt((entry.releaseDate || dd.releaseDate || '').slice(0, 4)) || 0,
    commander: commanders.join(' & '),
    deck: entry.name,
    set: setNames[entry.code] || dd.name || entry.code,
    code: entry.code,
  };
  decks.push(deck);
  have.add(`${entry.code}|${norm(entry.name)}`);
  haveNames.add(norm(entry.name));
  added.push(deck);
}

if (added.length) {
  writeFileSync(resolve(dataDir, 'decks.json'), JSON.stringify(decks, null, 2) + '\n', 'utf8');
}
console.log(`\ndecks.json: ${decks.length} total (${added.length} newly added)`);
for (const d of added) console.log(`  + ${d.year} ${d.code} :: ${d.deck} — ${d.commander}`);
if (added.length) console.log('\nNext: npm run decklists && npm run enrich');
