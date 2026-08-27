// Builds src/data/cardpool.json: a name-keyed lookup of { id, usd, eur, tix } for
// every card referenced by the browsable catalog (popular.json + averages.json).
// This gives the gallery a Scryfall id for fast CDN images and a price for every
// card — including cards that don't appear in any precon (which prices.json,
// built only from precon ids, doesn't cover).
//
//   npm run cardpool
//
// Scryfall: User-Agent + caching + paced batches (collection endpoint, 75/POST).
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');
const cacheDir = resolve(__dirname, '..', '.cache');
mkdirSync(cacheDir, { recursive: true });
const cacheFile = resolve(cacheDir, 'cardpool.json');

const HEADERS = { 'User-Agent': 'CommanderCodex/0.1 (deck builder)', Accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v) => (v == null || v === '' ? undefined : Math.round(Number(v) * 100) / 100);
const canon = (name) =>
  name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// 1. Gather every distinct card name from the catalog + commander decks.
const readJson = (f) => (existsSync(resolve(dataDir, f)) ? JSON.parse(readFileSync(resolve(dataDir, f), 'utf8')) : null);
const popular = readJson('popular.json') || [];
const averages = readJson('averages.json') || {};
const commanderDecks = readJson('commander-decks.json') || {};
const names = new Map(); // canon -> display name
for (const d of popular) for (const c of d.cards) names.set(canon(c.n), c.n);
for (const d of Object.values(averages)) for (const c of d.cards) names.set(canon(c.n), c.n);
for (const d of Object.values(commanderDecks)) for (const c of d.cards) { const nm = typeof c === 'string' ? c : c.n; names.set(canon(nm), nm); }
console.log(`${names.size} distinct cards across catalog + commander decks.`);

// Resolved cache: canon -> { id, usd, eur, tix } (or { miss: true })
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
const todo = [...names.entries()].filter(([c]) => !cache[c]);
console.log(`${todo.length} to resolve (${names.size - todo.length} cached).`);

const store = (card) => {
  const p = card.prices || {};
  return { id: card.id, usd: round(p.usd ?? p.usd_foil), eur: round(p.eur ?? p.eur_foil), tix: round(p.tix) };
};

// 2. Scryfall collection endpoint, by exact name, 75 per POST.
for (let i = 0; i < todo.length; i += 75) {
  const batch = todo.slice(i, i + 75);
  const body = { identifiers: batch.map(([, name]) => ({ name })) };
  let j = null;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch('https://api.scryfall.com/cards/collection', {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status === 429) { await sleep(1500); continue; }
      j = await r.json();
      break;
    } catch { await sleep(800); }
  }
  for (const card of j?.data || []) {
    const key = canon(card.name);
    cache[key] = store(card);
    // double-faced: also key by front face so "Fire" resolves "Fire // Ice"
    if (card.name.includes(' // ')) cache[canon(card.name.split(' // ')[0])] = store(card);
  }
  for (const nf of j?.not_found || []) {
    const key = canon(nf.name || '');
    if (key && !cache[key]) cache[key] = { miss: true };
  }
  if ((i / 75) % 10 === 0) console.log(`  ${Math.min(i + 75, todo.length)}/${todo.length}`);
  await sleep(110);
}

writeFileSync(cacheFile, JSON.stringify(cache), 'utf8');

// 3. Emit the lean runtime file (drop misses).
const out = {};
let withId = 0, withPrice = 0;
for (const key of names.keys()) {
  const e = cache[key];
  if (!e || e.miss || !e.id) continue;
  const row = { id: e.id };
  if (e.usd != null) row.usd = e.usd;
  if (e.eur != null) row.eur = e.eur;
  if (e.tix != null) row.tix = e.tix;
  out[key] = row;
  withId++;
  if (e.usd != null || e.eur != null) withPrice++;
}
writeFileSync(resolve(dataDir, 'cardpool.json'), JSON.stringify(out), 'utf8');
const bytes = readFileSync(resolve(dataDir, 'cardpool.json')).length;
console.log(`\nWrote cardpool.json: ${withId}/${names.size} cards with id, ${withPrice} with price (${(bytes / 1024).toFixed(0)} KB).`);
