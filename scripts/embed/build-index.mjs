// Stage B — build the on-device art embedding index (DINOv2-small fp32).
// Produces a drop-in parallel to src/data/art-hashes.json: the SAME 47,703 rows
// in the SAME order, but each row is a 384-dim DINOv2 embedding (int8-quantized
// for storage) instead of a 64-bit pHash. Scoring changes from Hamming distance
// to cosine similarity; everything downstream (row → card identity) is unchanged.
//
//   node scripts/embed/build-index.mjs [--limit N] [--concurrency 12]
//
// Two phases, both resumable:
//   1. download every art crop to .cache/embed/artfull/<cardId>.jpg (concurrent)
//   2. embed each crop → int8 row, checkpointed to .cache/embed/art-embeddings.*
// Parity: the fp32 ONNX model here is byte-identical to the one that will run on
// device via onnxruntime-react-native, so indexed vectors == on-device vectors.
import ort from 'onnxruntime-node';
import jpeg from 'jpeg-js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const cropDir = resolve(root, '.cache', 'embed', 'artfull');
const embedDir = resolve(root, '.cache', 'embed');
mkdirSync(cropDir, { recursive: true });

const args = process.argv.slice(2);
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const CONC = args.includes('--concurrency') ? Number(args[args.indexOf('--concurrency') + 1]) : 12;
const MODEL = 'dinov2-small.onnx';
const DIM = 384, SIZE = 224;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
const HEADERS = { 'User-Agent': 'CommanderCodex/1.0 (collection scanner)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const binFile = resolve(embedDir, 'art-embeddings.i8');
const manFile = resolve(embedDir, 'art-embeddings.manifest.json');
const progFile = resolve(embedDir, 'art-embeddings.progress.json');

const l2 = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; for (let i = 0; i < v.length; i++) v[i] /= s; return v; };
const qenc = (v, out, off) => { for (let i = 0; i < v.length; i++) { let x = Math.round(v[i] * 127); out[off + i] = x > 127 ? 127 : x < -128 ? -128 : x; } };

// PARITY-CRITICAL: identical to src/lib/embedPreprocess.ts on device. Pure-JS
// jpeg-js decode + center-aligned bilinear stretch to 224² is deterministic on
// both V8 (this builder) and Hermes (the app), so index vectors == on-device
// query vectors for the same image. sharp's lanczos resize was NOT reproducible
// on device (measured cosine gap up to 0.13) — never use it in the parity path.
function bilinearRGB(rgba, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 3);
  for (let y = 0; y < dh; y++) {
    let fy = (y + 0.5) * sh / dh - 0.5; let y0 = Math.floor(fy); const wy = fy - y0; let y1 = y0 + 1;
    if (y0 < 0) y0 = 0; if (y0 > sh - 1) y0 = sh - 1; if (y1 < 0) y1 = 0; if (y1 > sh - 1) y1 = sh - 1;
    for (let x = 0; x < dw; x++) {
      let fx = (x + 0.5) * sw / dw - 0.5; let x0 = Math.floor(fx); const wx = fx - x0; let x1 = x0 + 1;
      if (x0 < 0) x0 = 0; if (x0 > sw - 1) x0 = sw - 1; if (x1 < 0) x1 = 0; if (x1 > sw - 1) x1 = sw - 1;
      for (let c = 0; c < 3; c++) {
        const p00 = rgba[(y0 * sw + x0) * 4 + c], p01 = rgba[(y0 * sw + x1) * 4 + c];
        const p10 = rgba[(y1 * sw + x0) * 4 + c], p11 = rgba[(y1 * sw + x1) * 4 + c];
        const top = p00 + (p01 - p00) * wx, bot = p10 + (p11 - p10) * wx;
        out[(y * dw + x) * 3 + c] = top + (bot - top) * wy;
      }
    }
  }
  return out;
}

async function embed(session, buf) {
  const dec = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  const rgb = bilinearRGB(dec.data, dec.width, dec.height, SIZE, SIZE);
  const N = SIZE * SIZE, t = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) t[c * N + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  const out = await session.run({ pixel_values: new ort.Tensor('float32', t, [1, 3, SIZE, SIZE]) });
  const lhs = out.last_hidden_state;
  return l2(Float32Array.from(lhs.data.slice(0, lhs.dims[2]))); // CLS token, L2-normed
}

// resolve a row's art_crop url from the bulk catalogue (front or DFC face 0)
function cropUrl(card) {
  if (card?.image_uris?.art_crop) return card.image_uris.art_crop;
  const f = card?.card_faces?.[0];
  return f?.image_uris?.art_crop ?? null;
}

async function downloadAll(rows, byId) {
  let done = 0, fetched = 0, failed = 0, skipped = 0;
  const queue = rows.filter((r) => !existsSync(resolve(cropDir, `${r.id}.jpg`)));
  console.log(`phase 1: ${queue.length} crops to download (${rows.length - queue.length} cached), conc=${CONC}`);
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      const r = queue[idx++];
      const url = cropUrl(byId.get(r.id));
      if (!url) { failed++; done++; continue; }
      const p = resolve(cropDir, `${r.id}.jpg`);
      let ok = false;
      for (let a = 0; a < 3 && !ok; a++) {
        try {
          const res = await fetch(url, { headers: HEADERS });
          if (res.status === 429) { await sleep(1500); continue; }
          if (res.ok) { writeFileSync(p, Buffer.from(await res.arrayBuffer())); ok = true; fetched++; }
          else break;
        } catch { await sleep(400); }
      }
      if (!ok) failed++;
      if (++done % 1000 === 0) console.log(`  …${done}/${queue.length} (fetched ${fetched}, failed ${failed})`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`phase 1 done: fetched ${fetched}, failed ${failed}, skipped ${skipped}`);
}

async function embedAll(rows) {
  const total = rows.length;
  const buf = existsSync(binFile) ? new Int8Array(readFileSync(binFile).buffer.slice(0)) : new Int8Array(total * DIM);
  let start = existsSync(progFile) ? JSON.parse(readFileSync(progFile, 'utf8')).done : 0;
  const missing = existsSync(progFile) ? (JSON.parse(readFileSync(progFile, 'utf8')).missing ?? []) : [];
  if (buf.length !== total * DIM) { console.log('bin size mismatch — restarting embed from 0'); start = 0; }
  console.log(`phase 2: embedding ${total - start}/${total} rows (resume @${start})`);
  const session = await ort.InferenceSession.create(resolve(embedDir, 'models', MODEL));
  const t0 = Date.now();
  const flush = (done) => { writeFileSync(binFile, Buffer.from(buf.buffer)); writeFileSync(progFile, JSON.stringify({ done, missing })); };
  for (let i = start; i < total; i++) {
    const p = resolve(cropDir, `${rows[i].id}.jpg`);
    if (existsSync(p)) {
      try { qenc(await embed(session, readFileSync(p)), buf, i * DIM); }
      catch { missing.push(i); }
    } else missing.push(i);
    if ((i + 1) % 500 === 0) {
      flush(i + 1);
      const rate = (i + 1 - start) / ((Date.now() - t0) / 1000);
      console.log(`  …${i + 1}/${total}  ${rate.toFixed(1)}/s  eta ${Math.round((total - i - 1) / rate / 60)}min  missing ${missing.length}`);
    }
  }
  flush(total);

  const man = {
    v: 1, model: 'dinov2-small', precision: 'fp32', dim: DIM, quant: 'int8/127',
    count: total, missing: missing.length,
    rows: rows.map((r) => [r.id, r.name, r.set, r.cn]),
  };
  writeFileSync(manFile, JSON.stringify(man));
  console.log(`\nphase 2 done. bin=${(statSync(binFile).size / 1e6).toFixed(1)}MB manifest=${(statSync(manFile).size / 1e6).toFixed(1)}MB missing=${missing.length}`);

  // install the artifacts into the app (skipped for smoke --limit runs): the
  // int8 vectors ship as a bundled binary asset; the manifest is bundled JSON.
  if (!Number.isFinite(LIMIT)) {
    const assetsModels = resolve(root, 'assets', 'models');
    mkdirSync(assetsModels, { recursive: true });
    copyFileSync(binFile, resolve(assetsModels, 'art-embeddings.i8'));
    copyFileSync(resolve(embedDir, 'models', MODEL), resolve(assetsModels, MODEL));
    copyFileSync(manFile, resolve(root, 'src', 'data', 'art-embeddings.manifest.json'));
    console.log('installed → assets/models/art-embeddings.i8, assets/models/' + MODEL + ', src/data/art-embeddings.manifest.json');
  }
}

async function main() {
  const ah = JSON.parse(readFileSync(resolve(root, 'src', 'data', 'art-hashes.json'), 'utf8')).cards;
  let rows = ah.map(([, id, name, set, cn]) => ({ id, name, set, cn })); // drop hash; keep order
  if (Number.isFinite(LIMIT)) { rows = rows.slice(0, LIMIT); console.log(`--limit ${LIMIT}: smoke run on first ${rows.length} rows`); }
  const uniq = JSON.parse(readFileSync(resolve(root, '.cache', 'arthash', 'unique_artwork.json'), 'utf8'));
  const byId = new Map();
  for (const c of uniq) if (c.id) byId.set(c.id.replace(/-/g, ''), c);
  console.log(`${rows.length} rows (aligned to art-hashes.json)`);
  await downloadAll(rows, byId);
  await embedAll(rows);
}
main().catch((e) => { console.error(e); process.exit(1); });
