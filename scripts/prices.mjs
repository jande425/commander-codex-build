// Builds src/data/prices.json: per-card prices keyed by scryfallId, across
// providers — TCGplayer USD + Cardmarket EUR + MTGO tix (via Scryfall) and
// Card Kingdom retail + buylist (via MTGJSON). Run on demand to refresh.
//
//   npm run prices
//
// Needs the MTGJSON deck cache (.cache/decks/*) — run `npm run decklists` first.
import { readFileSync, writeFileSync, readdirSync, existsSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');
const cacheDir = resolve(__dirname, '..', '.cache');
const deckDir = resolve(cacheDir, 'decks');
const HEADERS = { 'User-Agent': 'CommanderCodex/0.1 (deck browser)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v) => (v == null ? undefined : Math.round(Number(v) * 100) / 100);
const num = (v) => (v == null || v === '' ? undefined : Number(v));

// 1. Collect unique scryfallIds + a uuid -> scryfallId map from the deck cache.
if (!existsSync(deckDir)) {
  console.error('No deck cache found. Run `npm run decklists` first.');
  process.exit(1);
}
const uuid2s = {};
const sIds = new Set();
for (const f of readdirSync(deckDir)) {
  const d = JSON.parse(readFileSync(resolve(deckDir, f), 'utf8')).data;
  [...(d.commander || []), ...(d.mainBoard || [])].forEach((c) => {
    const s = (c.identifiers || {}).scryfallId;
    if (s) {
      sIds.add(s);
      if (c.uuid) uuid2s[c.uuid] = s;
    }
  });
}
const ids = [...sIds];
console.log(`${ids.length} unique cards.`);

const prices = {};
const put = (sId, k, v) => {
  if (v === undefined) return;
  (prices[sId] = prices[sId] || {})[k] = v;
};

// 2. Scryfall collection endpoint (USD / EUR / tix), 75 ids per POST.
for (let i = 0; i < ids.length; i += 75) {
  const batch = ids.slice(i, i + 75).map((id) => ({ id }));
  let j = null;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch('https://api.scryfall.com/cards/collection', {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers: batch }),
      });
      if (r.status === 429) { await sleep(1500); continue; }
      j = await r.json();
      break;
    } catch {
      await sleep(800);
    }
  }
  (j?.data || []).forEach((c) => {
    const p = c.prices || {};
    put(c.id, 'usd', round(p.usd));
    put(c.id, 'usdf', round(p.usd_foil));
    put(c.id, 'eur', round(p.eur));
    put(c.id, 'eurf', round(p.eur_foil));
    put(c.id, 'tix', round(p.tix));
  });
  if ((i / 75) % 10 === 0) console.log(`  scryfall ${Math.min(i + 75, ids.length)}/${ids.length}`);
  await sleep(110);
}

// 3. MTGJSON AllPricesToday for Card Kingdom retail + buylist. Refresh each run.
console.log('Downloading MTGJSON AllPricesToday…');
const allFile = resolve(cacheDir, 'AllPricesToday.json');
const res = await fetch('https://mtgjson.com/api/v5/AllPricesToday.json', { headers: HEADERS });
await new Promise((ok, err) => {
  const out = createWriteStream(allFile);
  const reader = res.body.getReader();
  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.write(Buffer.from(value));
    }
    out.end();
  })().then(() => out.on('close', ok)).catch(err);
});
const all = JSON.parse(readFileSync(allFile, 'utf8')).data;
const latest = (o) => (o ? Object.values(o).pop() : undefined); // last date's price
for (const [uuid, sId] of Object.entries(uuid2s)) {
  const ck = all[uuid]?.paper?.cardkingdom;
  if (!ck) continue;
  put(sId, 'ck', round(num(latest(ck.retail?.normal)) ?? num(latest(ck.retail?.foil))));
  put(sId, 'ckf', round(num(latest(ck.retail?.foil))));
  put(sId, 'ckb', round(num(latest(ck.buylist?.normal)) ?? num(latest(ck.buylist?.foil))));
  put(sId, 'ckbf', round(num(latest(ck.buylist?.foil))));
}

writeFileSync(resolve(dataDir, 'prices.json'), JSON.stringify(prices), 'utf8');
const bytes = readFileSync(resolve(dataDir, 'prices.json')).length;
const have = (k) => ids.filter((id) => prices[id]?.[k] !== undefined).length;
console.log(`\nWrote prices for ${Object.keys(prices).length}/${ids.length} cards (${(bytes / 1024 / 1024).toFixed(2)} MB).`);
console.log(`coverage — usd:${have('usd')} eur:${have('eur')} tix:${have('tix')} ck:${have('ck')} ckBuy:${have('ckb')}`);
