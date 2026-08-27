// Builds src/data/decklists.json from MTGJSON's official precon deck files.
// One fetch per deck, cached in .cache/decks/, so re-runs are cheap.
//
//   node scripts/decklists.mjs
//
// Output shape (compact keys to keep the bundle small):
//   { [deckId]: { commanders: string[], total: number,
//                 cards: [{ n: name, c: count, id: scryfallId, m: manaValue, t: typeCat, co: colors }] } }
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');
const cacheDir = resolve(__dirname, '..', '.cache', 'decks');
mkdirSync(cacheDir, { recursive: true });

const decks = JSON.parse(readFileSync(resolve(dataDir, 'decks.json'), 'utf8'));
const HEADERS = { 'User-Agent': 'CommanderCodex/0.1 (deck browser)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normalise a deck name for matching: drop trailing "(...)", & -> and, strip punctuation.
const norm = (s) =>
  s.toLowerCase().replace(/\(.*?\)/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

// Pick one grouping category from MTGJSON's `types` array.
function category(card) {
  const t = card.types || [];
  if ((card.supertypes || []).includes('Basic')) return 'Land';
  for (const k of ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land']) {
    if (t.includes(k)) return k;
  }
  return 'Other';
}

async function getJSON(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.status === 404) return null;
      if (!r.ok) { await sleep(800); continue; }
      return await r.json();
    } catch {
      await sleep(800);
    }
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

function compact(card) {
  const o = {
    n: card.name,
    c: card.count || 1,
    id: (card.identifiers || {}).scryfallId || null,
    m: card.manaValue ?? card.convertedManaCost ?? 0,
    t: category(card),
    co: card.colors || [],
    s: card.setCode || null, // set code, for exact-printing import
    cn: card.number || null, // collector number
    r: card.rarity || null, // common | uncommon | rare | mythic
    np: (card.printings || []).length || 1, // number of printings (reprint/chase signal)
  };
  // creature subtypes (tribe), only for creatures, only when present
  const st = (card.types || []).includes('Creature') ? card.subtypes || [] : [];
  if (st.length) o.st = st;
  return o;
}

// ---- deck analysis (mana sources vs demand + functional categories) ----
const COLORS = ['W', 'U', 'B', 'R', 'G'];

function countPips(manaCost, pips, maxPip, qty) {
  if (!manaCost) return;
  const syms = manaCost.match(/\{([^}]+)\}/g) || [];
  const per = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (let s of syms) {
    s = s.slice(1, -1); // strip { }
    if (COLORS.includes(s)) per[s] += 1; // pure colored pip
    else if (s.includes('/')) {
      const parts = s.split('/');
      if (parts.includes('P')) {
        // Phyrexian: payable with life — count lightly
        parts.filter((p) => COLORS.includes(p)).forEach((p) => (per[p] += 0.5));
      } else {
        // hybrid: flexible — half-weight to each colour
        parts.filter((p) => COLORS.includes(p)).forEach((p) => (per[p] += 0.5));
      }
    }
  }
  for (const c of COLORS) {
    pips[c] += per[c] * qty;
    if (per[c] > maxPip[c]) maxPip[c] = per[c];
  }
}

function classify(card) {
  const t = (card.text || '').toLowerCase();
  const isLand = (card.types || []).includes('Land');
  const prod = card.producedMana || [];
  const tags = new Set();
  if (!isLand && (prod.length > 0 || /search your library for [^.]*\bland/.test(t) || /create [^.]*treasure/.test(t) || /put (a|up to \w+|that many)[^.]*\bland[^.]*onto the battlefield/.test(t)))
    tags.add('ramp');
  if (/\bdraw(s)? (a|one|two|three|four|five|six|seven|\d+|that many|x) card/.test(t) || /\binvestigate\b/.test(t)) tags.add('draw');
  if (/\b(destroy|exile) target\b/.test(t) || /target creature [^.]*gets -\d/.test(t) || /deals? \d+ damage to (any target|target (creature|planeswalker|permanent|battle))/.test(t) || /target player sacrifices/.test(t))
    tags.add('removal');
  if (/\b(destroy|exile) all\b/.test(t) || /each (player|opponent|other player) sacrifices/.test(t) || /deals? \d+ damage to each (creature|opponent|player)/.test(t)) tags.add('wipe');
  if (/\bcounter target (spell|ability|creature spell|noncreature spell|activated|triggered)/.test(t)) tags.add('counter');
  return tags;
}

function analyzeDeck(cards) {
  const sources = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  const pips = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const maxPip = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const tags = { ramp: 0, draw: 0, removal: 0, wipe: 0, counter: 0, fixing: 0 };
  let lands = 0;
  let mvTotal = 0;
  let mvCards = 0;
  for (const c of cards) {
    const qty = c.count || 1;
    const isLand = (c.types || []).includes('Land');
    if (isLand) lands += qty;
    else {
      mvTotal += (c.manaValue ?? c.convertedManaCost ?? 0) * qty;
      mvCards += qty;
    }
    const prod = c.producedMana || [];
    prod.forEach((col) => { if (sources[col] != null) sources[col] += qty; });
    if (prod.filter((x) => x !== 'C').length >= 2) tags.fixing += qty;
    countPips(c.manaCost, pips, maxPip, qty);
    classify(c).forEach((tag) => { if (tags[tag] != null) tags[tag] += qty; });
  }
  // round float pips for display
  for (const c of COLORS) {
    pips[c] = Math.round(pips[c]);
    maxPip[c] = Math.round(maxPip[c]);
  }
  return { sources, pips, maxPip, tags, lands, avgMv: mvCards ? Math.round((mvTotal / mvCards) * 100) / 100 : 0 };
}

// WotC "Game Changers" list (Commander brackets, 2025 — approximate).
const GAME_CHANGERS = new Set(
  [
    'Drannith Magistrate', 'Enlightened Tutor', "Serra's Sanctum", 'Smothering Tithe', "Teferi's Protection",
    'Cyclonic Rift', 'Expropriate', 'Fierce Guardianship', 'Grand Arbiter Augustin IV', 'Intuition',
    'Jin-Gitaxias, Core Augur', 'Mystical Tutor', 'Narset, Parter of Veils', 'Rhystic Study', "Thassa's Oracle",
    'Urza, Lord High Artificer', 'Mana Drain', 'Ad Nauseam', "Bolas's Citadel", 'Demonic Tutor', 'Imperial Seal',
    'Necropotence', 'Opposition Agent', 'Orcish Bowmasters', 'Vampiric Tutor', 'Tergrid, God of Fright',
    "Jeska's Will", 'Underworld Breach', 'Gamble', 'Deflecting Swat', "Gaea's Cradle", 'Survival of the Fittest',
    'Vorinclex, Voice of Hunger', 'Seedborn Muse', 'Natural Order', 'Food Chain', 'Ancient Tomb', 'Chrome Mox',
    'Mox Diamond', 'Mana Vault', 'Grim Monolith', 'The One Ring', 'The Tabernacle at Pendrell Vale', 'Trinisphere',
    'Glacial Chasm', 'Field of the Dead', "Mishra's Workshop", "Lion's Eye Diamond", 'Aura Shards', 'Crop Rotation',
    'Coalition Victory', 'Notion Thief', 'Consecrated Sphinx', 'Sway of the Stars', 'Tainted Pact',
  ].map((s) => s.toLowerCase()),
);

const FAST_MANA = new Set(
  [
    'Sol Ring', 'Mana Crypt', 'Mana Vault', 'Grim Monolith', 'Chrome Mox', 'Mox Diamond', 'Mox Opal', 'Mox Amber',
    'Jeweled Lotus', 'Lotus Petal', 'Ancient Tomb', 'City of Traitors', 'Dark Ritual', 'Cabal Ritual',
  ].map((s) => s.toLowerCase()),
);

const MASS_LAND_DENIAL = new Set(
  ['Armageddon', 'Ravages of War', 'Catastrophe', 'Jokulhaups', 'Obliterate', 'Decree of Annihilation', 'Cataclysm'].map((s) =>
    s.toLowerCase(),
  ),
);

const LAND_SUBTYPES = new Set([
  'Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Cave', 'Desert', 'Gate', 'Locus', 'Lair', 'Mine',
  'Power-Plant', 'Sphere', 'Tower', "Urza's",
]);

function analyzeInsights(cards) {
  const nonbasic = cards.filter((c) => !(c.supertypes || []).includes('Basic'));
  const ranked = nonbasic.filter((c) => c.edhrecRank != null);
  const salted = nonbasic.filter((c) => c.edhrecSaltiness != null);

  const saltTop = [...salted].sort((a, b) => b.edhrecSaltiness - a.edhrecSaltiness).slice(0, 5)
    .map((c) => ({ n: c.name, v: Math.round(c.edhrecSaltiness * 100) / 100 }));
  const avgSalt = salted.length ? salted.reduce((s, c) => s + c.edhrecSaltiness, 0) / salted.length : 0;

  const niche = [...ranked].sort((a, b) => b.edhrecRank - a.edhrecRank).slice(0, 5).map((c) => ({ n: c.name, rank: c.edhrecRank }));
  const avgRank = ranked.length ? Math.round(ranked.reduce((s, c) => s + c.edhrecRank, 0) / ranked.length) : 0;
  const spiceDen = ranked.filter((c) => !(c.types || []).includes('Land')).length || 1;
  const spicePct = Math.round((ranked.filter((c) => !(c.types || []).includes('Land') && c.edhrecRank > 5000).length / spiceDen) * 100);

  // dominant creature subtype (tribe)
  const tribeCount = {};
  cards.filter((c) => (c.types || []).includes('Creature')).forEach((c) =>
    (c.subtypes || []).forEach((st) => { if (!LAND_SUBTYPES.has(st)) tribeCount[st] = (tribeCount[st] || 0) + (c.count || 1); }),
  );
  const tribeTop = Object.entries(tribeCount).sort((a, b) => b[1] - a[1])[0];
  const tribe = tribeTop && tribeTop[1] >= 5 ? { name: tribeTop[0], count: tribeTop[1] } : null;

  const lc = (s) => (s || '').toLowerCase();
  const gameChangers = cards.filter((c) => GAME_CHANGERS.has(lc(c.name))).map((c) => c.name);
  const signals = {
    fastMana: cards.filter((c) => FAST_MANA.has(lc(c.name))).reduce((s, c) => s + (c.count || 1), 0),
    tutors: cards.filter((c) => /search your library for a card/.test(lc(c.text))).length,
    extraTurns: cards.filter((c) => /take an extra turn/.test(lc(c.text))).length,
    massLandDenial: cards.filter((c) => MASS_LAND_DENIAL.has(lc(c.name)) || /destroy all lands/.test(lc(c.text))).length,
  };

  return { salt: { top: saltTop, avg: Math.round(avgSalt * 100) / 100 }, spice: { avgRank, spicePct, niche }, tribe, gameChangers, signals };
}

const index = (await getJSON('https://mtgjson.com/api/v5/DeckList.json')).data.filter((d) =>
  /Commander/i.test(d.type || ''),
);
const byCode = {};
index.forEach((d) => (byCode[d.code] = byCode[d.code] || []).push(d));

const out = {};
const analysis = {};
const keywords = {};
const insights = {};
const gaps = [];
let done = 0;

for (const d of decks) {
  const want = norm(d.deck);
  const cands = byCode[d.code] || [];
  const entry =
    cands.find((c) => norm(c.name) === want) ||
    cands.find((c) => norm(c.name).startsWith(want) || norm(c.name).includes(want));
  if (!entry) {
    gaps.push(`${d.code} :: ${d.deck} (${d.year})`);
    continue;
  }
  const file = await getDeckFile(entry.fileName);
  if (!file || !file.data) {
    gaps.push(`${d.code} :: ${d.deck} — file missing`);
    continue;
  }
  const dd = file.data;
  const full = [...(dd.commander || []), ...(dd.mainBoard || [])];
  const cards = full.map(compact);
  out[d.id] = {
    commanders: (dd.commander || []).map((c) => c.name),
    total: cards.reduce((s, c) => s + c.c, 0),
    cards,
  };
  analysis[d.id] = analyzeDeck(full);
  insights[d.id] = analyzeInsights(full);
  const kw = {};
  full.forEach((c) => (c.keywords || []).forEach((k) => (kw[k] = (kw[k] || 0) + (c.count || 1))));
  keywords[d.id] = kw;
  done++;
  if (done % 25 === 0) console.log(`  ...${done} decks`);
}

writeFileSync(resolve(dataDir, 'decklists.json'), JSON.stringify(out), 'utf8');
writeFileSync(resolve(dataDir, 'analysis.json'), JSON.stringify(analysis), 'utf8');
writeFileSync(resolve(dataDir, 'keywords.json'), JSON.stringify(keywords), 'utf8');
writeFileSync(resolve(dataDir, 'insights.json'), JSON.stringify(insights), 'utf8');
const bytes = readFileSync(resolve(dataDir, 'decklists.json')).length;
const abytes = readFileSync(resolve(dataDir, 'analysis.json')).length;
const kbytes = readFileSync(resolve(dataDir, 'keywords.json')).length;
console.log(`\nWrote decklists for ${done}/${decks.length} decks (${(bytes / 1024 / 1024).toFixed(2)} MB).`);
console.log(`Wrote analysis (${(abytes / 1024).toFixed(0)} KB) and keywords (${(kbytes / 1024).toFixed(0)} KB).`);
if (gaps.length) {
  console.log(`\nNo decklist for ${gaps.length}:`);
  gaps.forEach((g) => console.log('  ' + g));
}
