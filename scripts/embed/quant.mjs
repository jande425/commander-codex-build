// DINOv2 precision comparison (scanner Stage A, part 2). Same index + same
// photo-degraded queries as bakeoff.mjs, but sweeps fp32 / fp16 / int8 of the
// SAME model to measure what quantization costs in retrieval accuracy and
// confidence separation. Parity rule: whichever precision ships on device is
// ALSO the one that builds the index — so this just tells us how small we can
// go without losing matches. Reuses cached images (run bakeoff.mjs first).
//
//   node scripts/embed/quant.mjs [indexN] [queryN]
import ort from 'onnxruntime-node';
import sharp from 'sharp';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const artDir = resolve(root, '.cache', 'embed', 'art');
const modelDir = resolve(root, '.cache', 'embed', 'models');
const INDEX_N = parseInt(process.argv[2] || '2500', 10);
const QUERY_N = parseInt(process.argv[3] || '150', 10);

// all three share DINOv2 preprocessing + CLS-token pooling
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225], SIZE = 224;
const VARIANTS = [
  { name: 'fp32', file: 'dinov2-small.onnx' },
  { name: 'fp16', file: 'dinov2-small-fp16.onnx' },
  { name: 'int8', file: 'dinov2-small-q8.onnx' },
];

const l2 = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / s; return o; };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const sizeMB = (f) => (readFileSync(resolve(modelDir, f)).length / 1048576).toFixed(0);

async function tensorFrom(buf) {
  const { data } = await sharp(buf).removeAlpha().resize(SIZE, SIZE, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const N = SIZE * SIZE, t = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) t[c * N + i] = (data[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  return new ort.Tensor('float32', t, [1, 3, SIZE, SIZE]);
}
async function embed(session, buf) {
  const out = await session.run({ pixel_values: await tensorFrom(buf) });
  const lhs = out.last_hidden_state, dim = lhs.dims[2];
  return l2(Float32Array.from(lhs.data.slice(0, dim))); // CLS token
}
async function artRegion(buf) {
  const m = await sharp(buf).metadata(), W = m.width, H = m.height;
  return sharp(buf).extract({ left: Math.round(W * 0.08), top: Math.round(H * 0.11), width: Math.round(W * 0.84), height: Math.round(H * 0.45) }).toBuffer();
}
async function photoAug(buf, seed) {
  return sharp(buf).rotate(((seed * 37) % 9) - 4, { background: '#000' }).modulate({ brightness: 0.75 + ((seed * 13) % 50) / 100 }).blur(0.4 + ((seed * 7) % 10) / 10).jpeg({ quality: 55 }).toBuffer();
}

async function main() {
  const all = JSON.parse(readFileSync(resolve(root, '.cache', 'arthash', 'unique_artwork.json'), 'utf8')).filter(
    (c) => !c.digital && c.image_uris?.art_crop && c.image_uris?.normal && !['token', 'art_series', 'emblem', 'double_faced_token'].includes(c.layout)
  );
  const step = Math.floor(all.length / INDEX_N);
  const index = []; for (let i = 0; i < INDEX_N; i++) index.push(all[i * step]);
  const queries = []; for (let i = 0; i < QUERY_N; i++) queries.push(index[Math.floor((i * INDEX_N) / QUERY_N)]);
  const refBuf = index.map((c) => { const p = resolve(artDir, `ac_${c.id}.jpg`); return existsSync(p) ? readFileSync(p) : null; });
  const qBuf = queries.map((c) => { const p = resolve(artDir, `nm_${c.id}.jpg`); return existsSync(p) ? readFileSync(p) : null; });
  const missing = refBuf.filter((b) => !b).length;
  console.log(`index=${index.length} (missing ${missing}) queries=${queries.length}\n`);

  for (const v of VARIANTS) {
   try {
    let session;
    try {
      session = await ort.InferenceSession.create(resolve(modelDir, v.file));
    } catch {
      // fp16/quantized graphs can trip ORT's fusion passes — retry with graph
      // optimization disabled (matches how we'll run it if needed on device)
      session = await ort.InferenceSession.create(resolve(modelDir, v.file), { graphOptimizationLevel: 'disabled' });
    }
    const t0 = Date.now();
    const idxVecs = []; for (let i = 0; i < index.length; i++) idxVecs[i] = refBuf[i] ? await embed(session, refBuf[i]) : null;
    const perMs = ((Date.now() - t0) / index.length).toFixed(0);
    let top1 = 0, top5 = 0; const sep = [];
    for (let qi = 0; qi < queries.length; qi++) {
      if (!qBuf[qi]) continue;
      const qv = await embed(session, await photoAug(await artRegion(qBuf[qi]), qi + 1));
      const scored = idxVecs.map((vv, i) => ({ i, s: vv ? dot(qv, vv) : -1 })).sort((a, b) => b.s - a.s);
      const correct = index.findIndex((c) => c.id === queries[qi].id);
      const rank = scored.findIndex((e) => e.i === correct);
      if (rank === 0) top1++; if (rank >= 0 && rank < 5) top5++;
      sep.push(scored[0].s - scored[1].s);
    }
    const n = queries.filter((_, i) => qBuf[i]).length;
    sep.sort((a, b) => a - b);
    console.log(`${v.name.padEnd(5)} ${sizeMB(v.file).padStart(3)}MB  top1=${((top1 / n) * 100).toFixed(1)}%  top5=${((top5 / n) * 100).toFixed(1)}%  ${perMs}ms/emb  medSep=${sep[Math.floor(sep.length / 2)].toFixed(3)}  minSep=${sep[0].toFixed(3)}`);
   } catch (e) {
     console.log(`${v.name.padEnd(5)} ${sizeMB(v.file).padStart(3)}MB  FAILED: ${String(e?.message ?? e).slice(0, 90)}`);
   }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
