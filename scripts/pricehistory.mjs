// Builds the self-hosted price-history snapshot: a downsampled 90-day series for
// EVERY paper printing MTGJSON prices, sharded by scryfallId so the app fetches
// only the slice it needs.
//
//   npm run pricehistory
//
// Output (data-dist/price/, published by .github/workflows/cards.yml alongside
// the card snapshot):
//   price/meta.json     build date, provider, axis
//   price/<xx>.json     printings whose scryfallId starts with <xx> (256 shards)
//
// Sources, both MIT-licensed MTGJSON bulk files, both streamed and scanned
// incrementally because neither fits in memory as parsed JSON:
//   AllIdentifiers (~229 MB gz)  uuid -> scryfallId, for every printing
//   AllPrices      (~147 MB gz)  90 days of daily prices, keyed by uuid
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

// 90 days sampled every 3rd day = 30 points: enough for a sparkline, small
// enough that a shard stays in the tens of kilobytes.
const DAYS = 90;
const STEP = 3;
// First provider with a usable retail series wins. Both quote USD, so the app
// converts once with the user's rates.
const PROVIDERS = ['tcgplayer', 'cardkingdom'];
const BASE = 'USD';
/** Shard key length in hex chars: 2 -> 256 shards. */
const SHARD = 2;

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

/** The retail date->price map for the best available provider. Prefers the
 *  normal printing, falling back to foil and then etched — some printings exist
 *  in only one finish (Commander Masters etched, say), and that finish's price
 *  is then the card's price. Mirrors the foil fallback in src/lib/prices.ts. */
export function pickSeries(paper) {
  if (!paper) return null;
  for (const name of PROVIDERS) {
    const retail = paper[name]?.retail;
    if (!retail) continue;
    const s = retail.normal ?? retail.foil ?? retail.etched;
    if (s && Object.keys(s).length) return s;
  }
  return null;
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
    return JSON.parse(text)?.identifiers?.scryfallId ?? null;
  } catch {
    return null;
  }
}

/** Shard a scryfallId lands in. */
export const shardOf = (scryfallId) => scryfallId.slice(0, SHARD).toLowerCase();

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
  let seenIds = 0;
  for await (const [uuid, text] of streamDataEntries(ids)) {
    seenIds++;
    const sId = pickScryfallId(text);
    if (sId) uuid2s.set(uuid, sId);
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

  const shards = new Map(); // shard key -> { [scryfallId]: number[] }
  let scanned = 0;
  let kept = 0;
  let axis = null;
  for await (const [uuid, text] of streamDataEntries(prices)) {
    scanned++;
    if (scanned % 20000 === 0) console.log(`  prices ${scanned.toLocaleString()} · kept ${kept.toLocaleString()}`);
    const sId = uuid2s.get(uuid);
    if (!sId) continue;
    let v;
    try {
      v = JSON.parse(text);
    } catch {
      continue;
    }
    const series = pickSeries(v.paper);
    if (!series) continue;
    axis ??= buildAxis(metaDate ?? Object.keys(series).sort().pop());
    const s = sample(series, axis);
    if (!s) continue;
    const key = shardOf(sId);
    let bucket = shards.get(key);
    if (!bucket) shards.set(key, (bucket = {}));
    // A scryfallId is one printing, so a later duplicate would be the same card.
    if (bucket[sId]) continue;
    bucket[sId] = s;
    kept++;
  }

  if (!axis) throw new Error('No usable price series found — did the AllPrices format change?');

  // 3. Write the shards.
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [key, bucket] of shards) {
    writeFileSync(resolve(outDir, `${key}.json`), JSON.stringify({ d: axis, p: bucket }));
  }
  writeFileSync(
    resolve(outDir, 'meta.json'),
    JSON.stringify({
      date: metaDate,
      provider: PROVIDERS[0],
      base: BASE,
      step: STEP,
      days: DAYS,
      shard: SHARD,
      shards: shards.size,
      count: kept,
      source: 'MTGJSON AllPrices',
    })
  );

  const bytes = readdirSync(outDir).reduce((n, f) => n + statSync(resolve(outDir, f)).size, 0);
  const biggest = Math.max(...readdirSync(outDir).map((f) => statSync(resolve(outDir, f)).size));
  console.log(`Scanned ${scanned.toLocaleString()} priced printings.`);
  console.log(
    `Wrote ${kept.toLocaleString()} series × ${axis.length} points -> ${shards.size} shards ` +
      `(${(bytes / 1024 / 1024).toFixed(1)} MB total, largest ${(biggest / 1024).toFixed(0)} KB)`
  );
}

// Run only when invoked directly, so the parser can be unit-tested.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await build();
}
