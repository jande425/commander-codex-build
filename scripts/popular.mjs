// Builds src/data/popular.json: a snapshot of popular community Commander decks
// from Archidekt (most-viewed), each with its full maindeck so we can score how
// close the user's collection is to building real, non-precon decks.
//
//   npm run popular            # default target (240 decks)
//   node scripts/popular.mjs 80
//
// Courtesy: paced requests, cached per deck in .cache/archidekt, attributed to
// Archidekt in the UI. Run server-side here (Archidekt blocks browser CORS).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');
const cacheDir = resolve(__dirname, '..', '.cache', 'archidekt');
mkdirSync(cacheDir, { recursive: true });

const TARGET = process.argv[2] ? parseInt(process.argv[2], 10) : 240;
const HEADERS = { 'User-Agent': 'CommanderCodex/0.1 (deck builder)', Accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Collect popular Commander (format 3) deck ids, most-viewed first.
async function collectIds(target) {
  const ids = [];
  let url = `https://archidekt.com/api/decks/v3/?formats=3&orderBy=-viewCount&pageSize=50`;
  while (url && ids.length < target) {
    let j = null;
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(url, { headers: HEADERS });
        if (!r.ok) { await sleep(1000); continue; }
        j = await r.json();
        break;
      } catch { await sleep(800); }
    }
    if (!j) break;
    for (const d of j.results || []) ids.push(d.id);
    url = j.next;
    await sleep(200);
  }
  return ids.slice(0, target);
}

async function getDeck(id) {
  const cached = resolve(cacheDir, id + '.json');
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
  const url = `https://archidekt.com/api/decks/${id}/`;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.status === 404) return null;
      if (!r.ok) { await sleep(1000); continue; }
      const j = await r.json();
      writeFileSync(cached, JSON.stringify(j), 'utf8');
      await sleep(220);
      return j;
    } catch { await sleep(800); }
  }
  return null;
}

// Reduce an Archidekt deck to { id, name, commanders, colors, viewCount,
// bracket, cards:[{n,q,id}] }. Excludes maybeboard / non-included categories.
function reduceDeck(j) {
  if (!j || !Array.isArray(j.cards)) return null;
  const excluded = new Set((j.categories || []).filter((c) => !c.includedInDeck).map((c) => c.name));
  const premier = new Set((j.categories || []).filter((c) => c.isPremier).map((c) => c.name));

  const cards = [];
  const commanders = [];
  for (const c of j.cards) {
    const cats = c.categories || [];
    if (cats.some((cat) => excluded.has(cat))) continue; // maybeboard / extras
    const oc = c.card && c.card.oracleCard;
    const name = oc && oc.name;
    if (!name) continue;
    const entry = { n: name, q: c.quantity || 1, id: (c.card && c.card.uid) || null };
    cards.push(entry);
    if (cats.some((cat) => premier.has(cat))) commanders.push(name);
  }
  if (!cards.length || !commanders.length) return null;

  return {
    id: j.id,
    name: j.name,
    commanders,
    viewCount: j.viewCount || 0,
    bracket: j.edhBracket ?? null,
    cardCount: cards.reduce((a, c) => a + c.q, 0),
    cards,
  };
}

const ids = await collectIds(TARGET);
console.log(`Collected ${ids.length} popular deck ids.`);

const out = [];
let done = 0;
const seenNames = new Set();
for (const id of ids) {
  const j = await getDeck(id);
  const deck = reduceDeck(j);
  if (deck) {
    // de-dupe near-identical reposts by (commander + name)
    const key = deck.commanders.join('+') + '::' + deck.name.toLowerCase().trim();
    if (!seenNames.has(key)) {
      seenNames.add(key);
      out.push(deck);
    }
  }
  if (++done % 20 === 0 || done === ids.length) console.log(`  ${done}/${ids.length}`);
}

out.sort((a, b) => b.viewCount - a.viewCount);
writeFileSync(resolve(dataDir, 'popular.json'), JSON.stringify(out), 'utf8');
const bytes = readFileSync(resolve(dataDir, 'popular.json')).length;
console.log(
  `\nWrote ${out.length} popular decks (${(bytes / 1024).toFixed(0)} KB), ` +
    `avg ${Math.round(out.reduce((a, d) => a + d.cards.length, 0) / (out.length || 1))} cards each.`
);
