// Enriches every deck's commander with Scryfall data (color identity, types,
// image, price) and writes src/data/enriched.json. Reuses successful commander
// records from that file and .cache/scryfall.json, including on fresh CI runners.
//
//   node scripts/enrich.mjs
//
// Fetch only missing cards, pace requests, and respect Scryfall's Retry-After.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');
const cacheDir = resolve(__dirname, '..', '.cache');
const cacheFile = resolve(cacheDir, 'scryfall.json');
const enrichedFile = resolve(dataDir, 'enriched.json');

const decks = JSON.parse(readFileSync(resolve(dataDir, 'decks.json'), 'utf8'));
mkdirSync(cacheDir, { recursive: true });
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};

const HEADERS = { 'User-Agent': 'CommanderCodex/0.1 (deck browser)', Accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mirror the HTML's name normalisation for fuzzy lookups.
function normalize(name) {
  return name
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '')
    .replace(/"/g, '')
    .trim();
}
// Split partner / pair commanders ("A & B") into individual card names.
function names(commander) {
  return commander.split(' & ').map(normalize);
}

function isCachedCard(card) {
  return card && !card.error && typeof card.name === 'string' && card.name.trim()
    && Array.isArray(card.colorIdentity) && typeof card.typeLine === 'string' && card.typeLine.trim();
}

// GitHub runners start without .cache, but already check out successful
// enrichment. Index by card name, not deck ID, so changed commanders are fetched
// and reprints can reuse the same card. A local cache takes precedence.
const previous = existsSync(enrichedFile) ? JSON.parse(readFileSync(enrichedFile, 'utf8')) : {};
for (const deck of Object.values(previous)) {
  if (!Array.isArray(deck?.commanders)) continue;
  for (const card of deck.commanders) {
    if (!isCachedCard(card)) continue;
    const fullName = normalize(card.name);
    for (const name of new Set([fullName, fullName.split(' // ')[0]])) {
      if (!isCachedCard(cache[name])) cache[name] = card;
    }
  }
}
const requiredNames = [...new Set(decks.flatMap((deck) => names(deck.commander)))];
const missingNames = requiredNames.filter((name) => !isCachedCard(cache[name]));
console.log(`Reusing ${requiredNames.length - missingNames.length} commander cards; ${missingNames.length} Scryfall lookup(s) needed.`);

function retryDelay(response, attempt) {
  // A short retry loop cannot recover from a sustained rate limit. Give the
  // service a cooldown and never retry before its requested time.
  const backoff = (response.status === 429 ? 30_000 : 1500) * 2 ** attempt;
  const retryAfter = response.headers.get('Retry-After');
  if (!retryAfter) return backoff;
  const seconds = Number(retryAfter);
  const requestedDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
  return Number.isFinite(requestedDelay) ? Math.max(backoff, requestedDelay) : backoff;
}

async function fetchCard(name) {
  if (isCachedCard(cache[name])) return cache[name];
  // Failed lookups (including null entries written by older runs) must be retried.
  delete cache[name];
  const url = 'https://api.scryfall.com/cards/named?fuzzy=' + encodeURIComponent(name);
  let card = { error: 'Scryfall lookup failed', name };
  let retryableFailure = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 429 || res.status >= 500) {
        // Keep an error result even when every attempt is rate-limited, and
        // back off before retrying instead of returning/caching null.
        card = { error: `Scryfall HTTP ${res.status} after ${attempt + 1} attempt(s)`, name };
        retryableFailure = true;
        if (attempt < 2) await sleep(retryDelay(res, attempt));
        continue;
      }
      const j = await res.json();
      retryableFailure = false;
      if (res.ok && j?.object === 'card') {
        const face = j.card_faces && !j.image_uris ? j.card_faces[0] : j;
        card = {
          name: j.name,
          colorIdentity: j.color_identity || [],
          typeLine: j.type_line || face.type_line || '',
          cmc: j.cmc ?? 0,
          manaCost: face.mana_cost || j.mana_cost || '',
          image: (face.image_uris || j.image_uris || {}).normal || null,
          artCrop: (face.image_uris || j.image_uris || {}).art_crop || null,
          priceUsd: j.prices ? Number(j.prices.usd) || null : null,
          scryfallUri: j.scryfall_uri || null,
        };
      } else {
        card = { error: j?.details || `Scryfall lookup failed (HTTP ${res.status})`, name };
      }
      break;
    } catch (e) {
      card = { error: String(e), name };
      retryableFailure = true;
      if (attempt < 2) await sleep(800 * 2 ** attempt);
    }
  }
  if (card.error && retryableFailure) {
    // Keep completed lookups, but never publish partial enrichment during an
    // outage: deck-sync only retries regeneration while the deck list differs.
    writeFileSync(cacheFile, JSON.stringify(cache), 'utf8');
    throw new Error(`Unable to enrich "${name}": ${card.error}. Enrichment was not written; rerun when Scryfall is available.`);
  }
  // Cache only successful cards so an outage cannot poison later runs.
  if (!card.error) cache[name] = card;
  await sleep(250); // conservative pacing for the remaining uncached lookups
  return card;
}

// Subtypes (tribes) come after the em dash in a type line: "Legendary Creature — Cat Beast"
function subtypes(typeLine) {
  const i = typeLine.indexOf('—');
  if (i === -1) return [];
  return typeLine.slice(i + 1).trim().split(/\s+/).filter(Boolean);
}

const enriched = {};
let done = 0;
const errors = [];

for (const d of decks) {
  const parts = names(d.commander);
  const cards = [];
  for (const n of parts) {
    const c = await fetchCard(n);
    if (c.error) errors.push({ deck: d.id, name: n, error: c.error });
    cards.push(c);
  }
  // Union the color identity across partners.
  const ci = new Set();
  cards.forEach((c) => (c.colorIdentity || []).forEach((x) => ci.add(x)));
  const tribes = new Set();
  cards.forEach((c) => subtypes(c.typeLine || '').forEach((t) => tribes.add(t)));

  enriched[d.id] = {
    colorIdentity: ['W', 'U', 'B', 'R', 'G'].filter((c) => ci.has(c)),
    isColorless: ci.size === 0,
    types: [...tribes],
    commanders: cards,
    // commander-level price now; full-deck price arrives with decklists later
    priceUsd: cards.reduce((sum, c) => sum + (c.priceUsd || 0), 0) || null,
  };

  done++;
  if (done % 20 === 0) {
    writeFileSync(cacheFile, JSON.stringify(cache), 'utf8');
    console.log(`  ...${done}/${decks.length}`);
  }
}

writeFileSync(cacheFile, JSON.stringify(cache), 'utf8');
writeFileSync(enrichedFile, JSON.stringify(enriched, null, 2) + '\n', 'utf8');
console.log(`Wrote enrichment for ${done} decks to src/data/enriched.json`);
if (errors.length) {
  console.log(`\n${errors.length} lookup issue(s) to review:`);
  errors.forEach((e) => console.log(`  ${e.deck}: "${e.name}" -> ${e.error}`));
} else {
  console.log('No lookup errors.');
}
