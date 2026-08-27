// Builds src/data/art-hashes.json: a perceptual-hash fingerprint of every unique
// Magic card artwork, so the scanner can identify a card from its art alone
// (independent of OCR). Uses Scryfall's `unique_artwork` bulk (one entry per
// illustration), downloads each art crop, and pHashes it with the SAME pipeline
// the app runs on-device (scripts/lib/phash.mjs === src/lib/phash.ts).
//
//   node scripts/arthash.mjs [--limit N] [--refresh]
//
// Resumable: computed hashes are cached in .cache/arthash/hashes.json keyed by
// illustration id, so re-runs skip finished art and only fetch what's missing.
// Scryfall asks for a User-Agent, image caching, and ~10 requests/second.
import { readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream, createReadStream, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { hashJpeg } from './lib/phash.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, '..', 'src', 'data');
const cacheDir = resolve(__dirname, '..', '.cache', 'arthash');
const bulkFile = resolve(cacheDir, 'unique_artwork.json');
const hashFile = resolve(cacheDir, 'hashes.json');
const outFile = resolve(dataDir, 'art-hashes.json');
mkdirSync(cacheDir, { recursive: true });

const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const refresh = args.includes('--refresh');

const HEADERS = { 'User-Agent': 'CommanderCodex/1.0 (collection scanner)', Accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400e3;

// 1. Get the unique_artwork bulk file (cached; refreshed weekly or with --refresh).
async function ensureBulk() {
  const fresh = existsSync(bulkFile) && Date.now() - statSync(bulkFile).mtimeMs < 7 * DAY;
  if (fresh && !refresh) return;
  console.log('Fetching bulk-data catalogue…');
  const bd = await (await fetch('https://api.scryfall.com/bulk-data', { headers: HEADERS })).json();
  const entry = (bd.data || []).find((x) => x.type === 'unique_artwork');
  if (!entry) throw new Error('unique_artwork bulk not found');
  // Scryfall now serves bulk as gzip-compressed JSONL (`jsonl_download_uri`); the
  // .gz has no Content-Encoding, so gunzip it ourselves. bulkFile ends up as JSONL
  // (parsed line-by-line in main()).
  const url = entry.jsonl_download_uri || entry.download_uri;
  if (!url) throw new Error('no download URI on unique_artwork bulk entry');
  const size = entry.compressed_size ?? entry.size ?? 0;
  console.log(`Downloading unique_artwork (~${Math.round(size / 1e6)} MB)…`);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok || !res.body) throw new Error(`bulk download failed: HTTP ${res.status}`);
  const src = Readable.fromWeb(res.body);
  const stages = /\.gz(\?|$)/i.test(url) ? [src, createGunzip(), createWriteStream(bulkFile)] : [src, createWriteStream(bulkFile)];
  await pipeline(...stages);
  console.log('Bulk saved.');
}

// A single art crop to fingerprint (handles single- and double-faced cards).
function artTargets(c) {
  if (c.digital) return [];
  if (['token', 'double_faced_token', 'emblem', 'art_series'].includes(c.layout)) return [];
  const out = [];
  const front = c.image_uris?.art_crop;
  if (front) out.push({ illId: c.illustration_id || c.id, url: front, name: c.name });
  else {
    const face = c.card_faces?.[0];
    if (face?.image_uris?.art_crop) out.push({ illId: face.illustration_id || c.id, url: face.image_uris.art_crop, name: face.name || c.name });
  }
  return out.map((t) => ({ ...t, id: c.id, set: c.set, cn: c.collector_number }));
}

async function main() {
  await ensureBulk();
  console.log('Reading bulk…');
  // Bulk is JSONL (one card object per line). Parse line-by-line so a multi-hundred-
  // MB file never becomes one giant string. Tolerates a legacy JSON-array file too.
  const cards = [];
  const rl = createInterface({ input: createReadStream(bulkFile, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    let s = line.trim();
    if (!s || s === '[' || s === ']') continue;
    if (s.endsWith(',')) s = s.slice(0, -1);
    try { cards.push(JSON.parse(s)); } catch {}
  }
  console.log(`${cards.length} artwork entries.`);

  const hashes = existsSync(hashFile) ? JSON.parse(readFileSync(hashFile, 'utf8')) : {};
  const targets = [];
  for (const c of cards) for (const t of artTargets(c)) targets.push(t);
  console.log(`${targets.length} art crops to fingerprint (${Object.keys(hashes).length} already cached).`);

  let done = 0;
  let fetched = 0;
  let failed = 0;
  const save = () => writeFileSync(hashFile, JSON.stringify(hashes), 'utf8');

  for (const t of targets) {
    if (fetched >= limit) break;
    if (!hashes[t.illId]) {
      try {
        const r = await fetch(t.url, { headers: HEADERS });
        if (r.status === 429) { await sleep(2000); continue; }
        if (!r.ok) { failed++; continue; }
        const buf = Buffer.from(await r.arrayBuffer());
        hashes[t.illId] = { h: hashJpeg(buf), id: t.id, n: t.name, s: t.set, cn: t.cn };
        fetched++;
        await sleep(90);
      } catch {
        failed++;
        await sleep(300);
      }
    }
    done++;
    if (fetched > 0 && fetched % 200 === 0) { save(); console.log(`  …${done}/${targets.length} (fetched ${fetched}, failed ${failed})`); }
  }
  save();

  // 2. Pack into the app asset: compact tuples [hash, idDashless, name, set, cn].
  const packed = [];
  for (const t of targets) {
    const e = hashes[t.illId];
    if (e) packed.push([e.h, e.id.replace(/-/g, ''), e.n, e.s, e.cn]);
  }
  // dedupe identical (hash,id) rows that DFC faces or reprints can produce
  const seen = new Set();
  const cardsOut = packed.filter(([h, id]) => {
    const k = h + id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  writeFileSync(outFile, JSON.stringify({ v: 1, size: 32, cards: cardsOut }) + '\n', 'utf8');
  console.log(`\nWrote ${cardsOut.length} art hashes to src/data/art-hashes.json (${(statSync(outFile).size / 1e6).toFixed(1)} MB).`);
  if (fetched < targets.length && limit === Infinity) console.log(`${targets.length - Object.keys(hashes).length} still missing — re-run to continue.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
