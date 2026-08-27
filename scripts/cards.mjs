// Builds a self-hosted snapshot of the card data the app repeatedly pulls from
// Scryfall (the set list + every set's card list), so the app can be pointed at
// our own CDN instead of hammering Scryfall forever. Consumes Scryfall's daily
// `default_cards` bulk (one object per printing) + the /sets endpoint, and emits
// compact per-set JSON matching the app's SetCard/ScrySet shapes.
//
//   node scripts/cards.mjs [--refresh]
//
// Output (data-dist/, deployed to GitHub Pages by .github/workflows/cards.yml):
//   meta.json          build time + counts
//   sets.json          set index (ScrySet[])
//   set/<code>.json     that set's cards (SetCard[])
//
// Scryfall regenerates bulk ~daily and asks callers to download it at most once
// a day, cache it, and send a real User-Agent — all of which we do.
import { writeFileSync, mkdirSync, existsSync, createWriteStream, createReadStream, statSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const cacheDir = resolve(root, '.cache', 'cards');
const bulkFile = resolve(cacheDir, 'default_cards.json');
const outDir = resolve(root, 'data-dist');
const setDir = resolve(outDir, 'set');
mkdirSync(cacheDir, { recursive: true });
mkdirSync(setDir, { recursive: true });

const refresh = process.argv.includes('--refresh');
const HEADERS = { 'User-Agent': 'CommanderCodex/1.0 (collection app)', Accept: 'application/json' };
const DAY = 86400e3;
const num = (v) => (v == null || v === '' ? null : Number(v));

// --- mapping (mirrors src/lib/scryfallSets.ts) ------------------------------
const TYPE_ORDER = ['Land', 'Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment'];
function primaryType(typeLine) {
  const front = (typeLine || '').split('//')[0];
  for (const t of TYPE_ORDER) if (front.includes(t)) return t;
  return 'Other';
}
function subtypesOf(typeLine) {
  const front = (typeLine || '').split('//')[0];
  const i = front.indexOf('—');
  if (i === -1) return [];
  return front.slice(i + 1).trim().split(/\s+/).filter(Boolean);
}
function mapCard(c) {
  const p = c.prices || {};
  const typeLine = c.type_line ?? c.card_faces?.[0]?.type_line ?? '';
  return {
    id: c.id,
    name: c.name,
    cn: c.collector_number ?? '',
    rarity: c.rarity ?? '',
    type: primaryType(typeLine),
    usd: num(p.usd) ?? num(p.usd_foil),
    eur: num(p.eur) ?? num(p.eur_foil),
    tix: num(p.tix),
    scryUri: c.scryfall_uri ?? null,
    tcg: c.purchase_uris?.tcgplayer ?? null,
    flavorName: c.flavor_name ?? c.card_faces?.[0]?.flavor_name ?? null,
    colors: c.colors ?? c.card_faces?.[0]?.colors ?? [],
    cmc: c.cmc ?? c.card_faces?.[0]?.cmc ?? 0,
    subtypes: subtypesOf(typeLine),
  };
}

async function ensureBulk() {
  const fresh = existsSync(bulkFile) && Date.now() - statSync(bulkFile).mtimeMs < DAY;
  if (fresh && !refresh) return;
  console.log('Fetching bulk-data catalogue…');
  const bd = await (await fetch('https://api.scryfall.com/bulk-data', { headers: HEADERS })).json();
  const entry = (bd.data || []).find((x) => x.type === 'default_cards');
  if (!entry) throw new Error('default_cards bulk not found');
  // Scryfall now serves bulk as gzip-compressed JSONL via `jsonl_download_uri`
  // (the old uncompressed-JSON `download_uri` is gone). The .jsonl.gz is served as
  // application/gzip with no Content-Encoding, so fetch won't inflate it — gunzip
  // it ourselves. The object-boundary parser below reads JSON-array OR JSONL, so
  // no downstream change is needed.
  const url = entry.jsonl_download_uri || entry.download_uri;
  if (!url) throw new Error('no download URI on default_cards bulk entry');
  const size = entry.compressed_size ?? entry.size ?? 0;
  console.log(`Downloading default_cards (~${Math.round(size / 1e6)} MB)…`);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok || !res.body) throw new Error(`bulk download failed: HTTP ${res.status}`);
  const src = Readable.fromWeb(res.body);
  const stages = /\.gz(\?|$)/i.test(url) ? [src, createGunzip(), createWriteStream(bulkFile)] : [src, createWriteStream(bulkFile)];
  await pipeline(...stages);
  console.log('Bulk saved.');
}

async function fetchSets() {
  const j = await (await fetch('https://api.scryfall.com/sets', { headers: HEADERS })).json();
  return (j.data || []).map((s) => ({
    code: s.code,
    name: s.name,
    cardCount: s.card_count ?? 0,
    released: s.released_at ?? null,
    setType: s.set_type ?? '',
    digital: !!s.digital,
    iconUri: s.icon_svg_uri ?? null,
  }));
}

// Stream a JSON array of objects, invoking onObject(obj) for each top-level
// element — without ever holding the whole file (or a whole-file string) in
// memory. The bulk is ~556 MB, past V8's max string length, so a plain
// readFileSync/JSON.parse throws ERR_STRING_TOO_LONG. We scan bytes for object
// boundaries (structural { } " \ are single-byte ASCII even inside UTF-8, so
// this is multibyte-safe) and JSON.parse each small object on its own.
export function streamJsonArray(path, onObject, hwm = 1 << 20) {
  return new Promise((resolve2, reject) => {
    const stream = createReadStream(path, { highWaterMark: hwm });
    let depth = 0, inStr = false, esc = false, capturing = false;
    let parts = [];
    stream.on('data', (chunk) => {
      let segStart = capturing ? 0 : -1; // where the in-progress object starts in THIS chunk
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i];
        if (inStr) {
          if (esc) esc = false;
          else if (b === 0x5c) esc = true; // backslash
          else if (b === 0x22) inStr = false; // closing quote
          continue;
        }
        if (b === 0x22) { inStr = true; continue; } // opening quote
        if (b === 0x7b) { // {
          if (depth === 0) { capturing = true; segStart = i; }
          depth++;
        } else if (b === 0x7d) { // }
          depth--;
          if (depth === 0 && capturing) {
            parts.push(chunk.subarray(segStart, i + 1));
            const buf = parts.length === 1 ? parts[0] : Buffer.concat(parts);
            parts = [];
            capturing = false;
            segStart = -1;
            try { onObject(JSON.parse(buf.toString('utf8'))); }
            catch (e) { stream.destroy(); reject(e); return; }
          }
        }
      }
      if (capturing && segStart !== -1) parts.push(chunk.subarray(segStart));
    });
    stream.on('end', resolve2);
    stream.on('error', reject);
  });
}

async function main() {
  await ensureBulk();
  console.log('Streaming bulk…');
  // group by set as we stream
  const bySet = new Map();
  let n = 0;
  await streamJsonArray(bulkFile, (c) => {
    n++;
    const code = c.set;
    if (!code) return;
    (bySet.get(code) ?? bySet.set(code, []).get(code)).push(mapCard(c));
  });
  console.log(`${n} printings.`);

  // fresh set list — but make each set's advertised count match the cards we
  // actually publish for it. Scryfall's set.card_count and the default_cards
  // grouping disagree for some sets, which showed up as the sets-list badge not
  // matching the number of cards on the set page.
  const sets = await fetchSets();
  for (const s of sets) {
    const list = bySet.get(s.code);
    if (list && list.length) s.cardCount = list.length;
  }
  writeFileSync(resolve(outDir, 'sets.json'), JSON.stringify(sets));

  // clear stale per-set files, then write current ones
  rmSync(setDir, { recursive: true, force: true });
  mkdirSync(setDir, { recursive: true });
  let files = 0;
  for (const [code, list] of bySet) {
    list.sort((a, b) => (parseInt(a.cn) || 1e9) - (parseInt(b.cn) || 1e9) || a.cn.localeCompare(b.cn));
    writeFileSync(resolve(setDir, `${code}.json`), JSON.stringify(list));
    files++;
  }

  writeFileSync(
    resolve(outDir, 'meta.json'),
    JSON.stringify({ builtAt: new Date().toISOString(), source: 'scryfall default_cards', printings: n, sets: sets.length, setFiles: files }, null, 2)
  );
  console.log(`Wrote ${files} set files + sets.json (${sets.length} sets) to data-dist/.`);
}

// Only run the pipeline when executed directly (so the parser can be imported
// and unit-tested without triggering the 556 MB download).
const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((e) => { console.error(e); process.exit(1); });
