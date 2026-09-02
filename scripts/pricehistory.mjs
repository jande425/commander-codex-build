// Builds the self-hosted price-history snapshot: a downsampled 90-day series for
// EVERY paper printing MTGJSON prices, sharded by scryfallId so the app fetches
// only the slice it needs.
//
//   npm run pricehistory
//
// Output (data-dist/price/, published by .github/workflows/cards.yml alongside
// the card snapshot):
//   price/meta.json     build date, provider, axis
//   price/<xxx>.json    every printing of the cards whose oracleId starts <xxx>
//   price/now.json      TODAY's price per printing across every source — one
//                       ~3 MB gzipped file the whole app can hold in memory, so
//                       the gallery, the collection total and the set browser
//                       price per printing instead of falling back to Scryfall's
//                       TCGplayer-only figure (which cannot honour a Card
//                       Kingdom preference at all). Shards stay the source for
//                       charts; a card grid cannot fetch one per card.
//
// Sources:
//   AllIdentifiers (~229 MB gz)  uuid -> scryfallId + oracleId, every printing
//   AllPrices      (~147 MB gz)  90 days of daily prices, keyed by uuid
//   Card Kingdom pricelist (~46 MB)  today's CK retail/buylist, stock and the
//     exact product URL, keyed directly by scryfall_id. A deliberately public,
//     CORS-open API (robots.txt disallows nothing). MTGJSON only carries Card
//     Kingdom for ~60% of printings, so this roughly doubles CK coverage and
//     removes the URL-slug guessing that soft-404s on The List and Secret Lair.
//
// The two MTGJSON files are streamed and scanned incrementally because neither
// fits in memory as parsed JSON.
//
// Sharded by ORACLE id, not scryfallId: the detail sheet always wants every
// printing of one card at once (the price, the chart and the printings grid all
// read it), so one fetch serves the whole screen. Sharding by scryfallId would
// scatter a card's printings across dozens of files.
//
// An earlier version keyed off the precon deck cache, which covered only the
// 12.7k printings in official Commander decks — so a Secret Lair or Masters
// printing silently had no chart. Sharding is what makes full coverage
// affordable: ~115k printings is ~20 MB in total, far too much to bundle, but
// only ~80 KB per shard to fetch.
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '..', 'data-dist', 'price');
const HEADERS = { 'User-Agent': 'CommanderCodex/0.1 (deck browser)' };
const URL_PRICES = 'https://mtgjson.com/api/v5/AllPrices.json.gz';
const URL_IDS = 'https://mtgjson.com/api/v5/AllIdentifiers.json.gz';
const URL_CK = 'https://api.cardkingdom.com/api/pricelist';

// 90 days sampled every 3rd day = 30 points: enough for a sparkline, small
// enough that a shard stays in the tens of kilobytes.
const DAYS = 90;
const STEP = 3;
// Every provider the app can be set to prefer, keyed by the same ProviderKey
// src/lib/prices.ts uses so the client can honour the user's ordering directly.
// `base` is the currency the provider quotes in; the app converts once.
const PROVIDERS = [
  { key: 'usd', provider: 'tcgplayer', kind: 'retail', base: 'USD' },
  { key: 'ck', provider: 'cardkingdom', kind: 'retail', base: 'USD' },
  { key: 'eur', provider: 'cardmarket', kind: 'retail', base: 'EUR' },
  { key: 'ckb', provider: 'cardkingdom', kind: 'buylist', base: 'USD' },
];
/** Shard key length in hex chars: 3 -> 4096 shards. Must match SHARD in
 *  src/lib/priceHistory.ts; meta.json records it so a mismatch is diagnosable.
 *  Two chars put 200 KB in the average shard and 655 KB in the worst, which is
 *  a lot to pull just to open one card. */
const SHARD = 3;

const round = (v) => Math.round(Number(v) * 100) / 100;

/** Index of the `}` closing the `{` at `start`, or -1 if not yet in `s`. */
function matchBrace(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Yields [key, valueText] for each entry of the top-level "data" object,
 *  without ever holding the whole document. Tracks string/escape state so a
 *  brace inside a string can't unbalance the scan. */
export async function* streamDataEntries(stream) {
  let buf = '';
  let started = false;
  let done = false;
  for await (const chunk of stream) {
    if (done) break;
    buf += chunk;
    if (!started) {
      const at = buf.indexOf('"data"');
      if (at === -1) {
        // Keep a tail in case the marker straddles a chunk boundary.
        if (buf.length > 4096) buf = buf.slice(-16);
        continue;
      }
      const brace = buf.indexOf('{', at + 6);
      if (brace === -1) continue;
      buf = buf.slice(brace + 1);
      started = true;
    }
    let pos = 0;
    for (;;) {
      // Skip separators before a key.
      while (pos < buf.length && (buf[pos] === ',' || buf[pos] <= ' ')) pos++;
      if (pos >= buf.length) break;
      if (buf[pos] === '}') { done = true; break; } // end of "data"
      if (buf[pos] !== '"') break; // partial — wait for more input
      const keyEnd = buf.indexOf('"', pos + 1); // uuids never contain escapes
      if (keyEnd === -1) break;
      const key = buf.slice(pos + 1, keyEnd);
      let vs = keyEnd + 1;
      while (vs < buf.length && (buf[vs] === ':' || buf[vs] <= ' ')) vs++;
      if (vs >= buf.length || buf[vs] !== '{') break;
      const end = matchBrace(buf, vs);
      if (end === -1) break; // value not fully buffered yet
      yield [key, buf.slice(vs, end + 1)];
      pos = end + 1;
    }
    buf = buf.slice(pos);
  }
}

/** The sampled date axis: every STEP-th day of the DAYS ending at `endDate`.
 *  Counts back from a multiple of STEP so the last point lands exactly on
 *  `endDate` — the newest price is the one the sheet quotes, so it must be the
 *  one the line ends on. */
export function buildAxis(endDate) {
  const end = new Date(endDate + 'T00:00:00Z');
  const out = [];
  for (let back = STEP * (Math.ceil(DAYS / STEP) - 1); back >= 0; back -= STEP) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - back);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** One provider's date->price map for one finish.
 *
 *  'nonfoil' falls back to foil/etched so a printing that only exists foil (some
 *  Commander Masters cards) still has a price, matching src/lib/prices.ts.
 *  'foil' does NOT fall back to nonfoil — the foil toggle must not quietly show
 *  the nonfoil price and call it foil; absent means absent. */
export function pickSeries(paper, provider = 'tcgplayer', kind = 'retail', finish = 'nonfoil') {
  const byKind = paper?.[provider]?.[kind];
  if (!byKind) return null;
  const s = finish === 'foil' ? byKind.foil ?? byKind.etched : byKind.normal ?? byKind.foil ?? byKind.etched;
  return s && Object.keys(s).length ? s : null;
}

/** Every provider's sampled series for one printing, keyed by ProviderKey, with
 *  the foil finish under a trailing "f" — the same naming prices.json uses
 *  (usd/usdf, ck/ckf…). Returns null when nothing is chartable. */
export function seriesByProvider(paper, axis) {
  if (!paper) return null;
  const out = {};
  let any = false;
  for (const { key, provider, kind } of PROVIDERS) {
    for (const finish of ['nonfoil', 'foil']) {
      const raw = pickSeries(paper, provider, kind, finish);
      if (!raw) continue;
      const s = sample(raw, axis);
      if (!s) continue;
      out[finish === 'foil' ? `${key}f` : key] = s;
      any = true;
    }
  }
  return any ? out : null;
}

/** Sample `series` onto `axis`, carrying the last known price across gaps.
 *  Returns null when there is nothing worth charting. */
export function sample(series, axis) {
  const dates = Object.keys(series).sort();
  if (dates.length < 2) return null;
  const out = [];
  let di = 0;
  let last = null;
  for (const day of axis) {
    while (di < dates.length && dates[di] <= day) last = series[dates[di++]];
    out.push(last == null ? null : round(last));
  }
  const seen = out.filter((v) => v != null);
  if (seen.length < 2) return null;
  if (seen.every((v) => v === seen[0])) return null; // flat — nothing to draw
  return out;
}

/** The printing's own Scryfall id.
 *
 *  Must parse rather than regex the entry text: a card's `foreignData[]` entries
 *  carry their OWN `identifiers.scryfallId` for the foreign printing, and
 *  "foreignData" sorts before "identifiers", so a naive /"scryfallId":"…"/ scan
 *  returns the foreign printing's id and silently files the series under the
 *  wrong card. */
export function pickScryfallId(text) {
  try {
    const ids = JSON.parse(text)?.identifiers;
    return ids?.scryfallId ? { id: ids.scryfallId, oracle: ids.scryfallOracleId ?? null } : null;
  } catch {
    return null;
  }
}

/** Today's Card Kingdom listing for each printing, keyed by scryfallId.
 *  Nonfoil and foil are separate rows in the feed, folded into one record:
 *    u  product path      r/rf  retail price     q/qf  retail stock
 *                         b/bf  buylist price
 *  `null` fields are dropped so the shards stay lean. */
export function ckByPrinting(rows) {
  const out = new Map();
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  for (const r of rows ?? []) {
    const id = r.scryfall_id;
    if (!id) continue;
    let rec = out.get(id);
    if (!rec) out.set(id, (rec = {}));
    // Every row for a printing shares the product page; keep the first seen.
    if (!rec.u && r.url) rec.u = r.url;
    const foil = r.is_foil === 'true' || r.is_foil === true;
    const retail = num(r.price_retail);
    const buy = num(r.price_buy);
    const qty = Number.isFinite(Number(r.qty_retail)) ? Number(r.qty_retail) : undefined;
    if (retail !== undefined) rec[foil ? 'rf' : 'r'] = retail;
    if (buy !== undefined) rec[foil ? 'bf' : 'b'] = buy;
    if (qty !== undefined) rec[foil ? 'qf' : 'q'] = qty;
  }
  return out;
}

/** Latest non-null value of a sampled series. */
const lastOf = (series) => (Array.isArray(series) ? series.filter((v) => v != null).pop() : undefined);

/** Today's price for one printing across every source, compacted for `now.json`.
 *  Live Card Kingdom wins over the MTGJSON series: it is fresher and covers far
 *  more printings. Returns null when nothing at all is known. */
export function nowRow(row) {
  const ck = row.ck_ ?? {};
  const out = {};
  const put = (k, v) => {
    if (v != null) out[k] = v;
  };
  put('u', lastOf(row.usd));
  put('uf', lastOf(row.usdf));
  put('c', ck.r ?? lastOf(row.ck));
  put('cf', ck.rf ?? lastOf(row.ckf));
  put('e', lastOf(row.eur));
  put('ef', lastOf(row.eurf));
  put('b', ck.b ?? lastOf(row.ckb));
  put('bf', ck.bf ?? lastOf(row.ckbf));
  return Object.keys(out).length ? out : null;
}

/** Shard an ORACLE id lands in — every printing of a card shares one. */
export const shardOf = (oracleId) => oracleId.slice(0, SHARD).toLowerCase();

async function gunzipped(url, label) {
  console.log(`Streaming ${label}…`);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${label} download failed: ${res.status}`);
  const gz = createGunzip();
  Readable.fromWeb(res.body).pipe(gz);
  gz.setEncoding('utf8');
  return gz;
}

export async function build() {
  // 1. uuid -> scryfallId for every printing.
  const ids = await gunzipped(URL_IDS, 'MTGJSON AllIdentifiers (~229 MB)');
  const uuid2s = new Map();
  const sId2oracle = new Map();
  let seenIds = 0;
  for await (const [uuid, text] of streamDataEntries(ids)) {
    seenIds++;
    const rec = pickScryfallId(text);
    if (rec?.oracle) {
      uuid2s.set(uuid, rec);
      sId2oracle.set(rec.id, rec.oracle);
    }
    if (seenIds % 40000 === 0) console.log(`  identifiers ${seenIds.toLocaleString()} · mapped ${uuid2s.size.toLocaleString()}`);
  }
  console.log(`${uuid2s.size.toLocaleString()} uuid -> scryfallId mappings (of ${seenIds.toLocaleString()} printings).`);
  if (!uuid2s.size) throw new Error('No identifiers mapped — did the AllIdentifiers format change?');

  // 2. Stream prices, sampling each printing we can name onto the shared axis.
  const prices = await gunzipped(URL_PRICES, 'MTGJSON AllPrices (~147 MB)');
  let metaDate = null;
  prices.once('data', (c) => {
    metaDate = (String(c).match(/"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/) || [])[1] ?? null;
  });

  const shards = new Map(); // shard key -> { [scryfallId]: { …series, ck?: {…} } }
  /** Row for one printing, created on first use. */
  const rowFor = (sId, oracle) => {
    const key = shardOf(oracle);
    let bucket = shards.get(key);
    if (!bucket) shards.set(key, (bucket = {}));
    return (bucket[sId] ??= {});
  };
  let scanned = 0;
  let kept = 0;
  let axis = buildAxis(metaDate ?? new Date().toISOString().slice(0, 10));
  const perProvider = {};
  for await (const [uuid, text] of streamDataEntries(prices)) {
    scanned++;
    if (scanned % 20000 === 0) console.log(`  prices ${scanned.toLocaleString()} · kept ${kept.toLocaleString()}`);
    const rec = uuid2s.get(uuid);
    if (!rec) continue;
    let v;
    try {
      v = JSON.parse(text);
    } catch {
      continue;
    }
    const byProv = seriesByProvider(v.paper, axis);
    if (!byProv) continue;
    const row = rowFor(rec.id, rec.oracle);
    // A scryfallId is one printing, so a later duplicate would be the same card.
    if (Object.keys(row).length) continue;
    Object.assign(row, byProv);
    for (const k of Object.keys(byProv)) perProvider[k] = (perProvider[k] ?? 0) + 1;
    kept++;
  }

  // 3. Today's Card Kingdom listing, merged onto whatever the history produced.
  //    Adds printings MTGJSON has no Card Kingdom row for at all, so this is a
  //    coverage step as much as a freshness one.
  console.log('Fetching the Card Kingdom pricelist (~46 MB)…');
  let ckAdded = 0;
  let ckNewPrintings = 0;
  try {
    const r = await fetch(URL_CK, { headers: HEADERS });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const ck = ckByPrinting((await r.json()).data);
    for (const [sId, rec] of ck) {
      const oracle = sId2oracle.get(sId);
      if (!oracle) continue; // a printing MTGJSON does not know
      const row = rowFor(sId, oracle);
      if (!Object.keys(row).length) ckNewPrintings++;
      row.ck_ = rec;
      ckAdded++;
    }
    console.log(`  Card Kingdom: ${ckAdded.toLocaleString()} printings (${ckNewPrintings.toLocaleString()} with no MTGJSON history at all)`);
  } catch (e) {
    // Never fail the whole build over one optional source — the history is the
    // part the charts need.
    console.warn(`  Card Kingdom pricelist unavailable (${e.message}) — continuing without it.`);
  }

  if (!kept) throw new Error('No usable price series found — did the AllPrices format change?');

  // 4. Write the shards.
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [key, bucket] of shards) {
    writeFileSync(resolve(outDir, `${key}.json`), JSON.stringify({ d: axis, p: bucket }));
  }
  writeFileSync(
    resolve(outDir, 'meta.json'),
    JSON.stringify({
      date: metaDate,

      step: STEP,
      days: DAYS,
      shard: SHARD,
      shardedBy: 'oracleId',
      shards: shards.size,
      count: kept,
      cardKingdomLive: ckAdded,
      providers: PROVIDERS.map((p) => ({ key: p.key, base: p.base })),
      source: 'MTGJSON AllPrices',
    })
  );

  // Flat current-price index, for every screen that shows many cards at once.
  const now = {};
  let nowCount = 0;
  for (const bucket of shards.values()) {
    for (const [sId, row] of Object.entries(bucket)) {
      const r = nowRow(row);
      if (r) {
        now[sId] = r;
        nowCount++;
      }
    }
  }
  writeFileSync(resolve(outDir, 'now.json'), JSON.stringify({ date: metaDate, p: now }));
  console.log(`Wrote now.json: ${nowCount.toLocaleString()} printings (${(statSync(resolve(outDir, 'now.json')).size / 1024 / 1024).toFixed(1)} MB raw)`);

  // Stats over the SHARDS only — now.json is an order of magnitude larger and
  // was making "largest shard" read as 9.7 MB when no shard exceeds a fraction
  // of that.
  const shardFiles = readdirSync(outDir).filter((f) => f !== 'meta.json' && f !== 'now.json');
  const bytes = shardFiles.reduce((n, f) => n + statSync(resolve(outDir, f)).size, 0);
  const biggest = Math.max(...shardFiles.map((f) => statSync(resolve(outDir, f)).size));
  console.log(`Scanned ${scanned.toLocaleString()} priced printings.`);
  for (const { key } of PROVIDERS) {
    const n = perProvider[key] ?? 0;
    console.log(`  ${key.padEnd(4)} ${String(n).padStart(7)} printings (${Math.round((n / kept) * 100)}%)`);
  }
  console.log(
    `Wrote ${kept.toLocaleString()} series × ${axis.length} points -> ${shards.size} shards ` +
      `(${(bytes / 1024 / 1024).toFixed(1)} MB total, largest ${(biggest / 1024).toFixed(0)} KB)`
  );
}

// Run only when invoked directly, so the parser can be unit-tested.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await build();
}
