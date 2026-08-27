// TEMP bake-off (small vs base, CLS vs mean-pool). One forward pass per image;
// both pooled vectors scored. Relative model comparison (sharp fit:fill preproc,
// same for all). Delete after use.
//   node scripts/embed/_bakeoff2.mjs [indexN] [queryN]
import ort from 'onnxruntime-node';
import sharp from 'sharp';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const artDir = resolve(root, '.cache', 'embed', 'art');
const modelDir = resolve(root, '.cache', 'embed', 'models');
mkdirSync(artDir, { recursive: true });

const INDEX_N = parseInt(process.argv[2] || '3000', 10);
const QUERY_N = parseInt(process.argv[3] || '200', 10);
const HEADERS = { 'User-Agent': 'CommanderCodex/1.0 (research)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225], SIZE = 224;

const MODELS = [
  { key: 'small', file: 'dinov2-small.onnx' },
  { key: 'base', file: 'dinov2-base.onnx' },
  { key: 'base-int8', file: 'dinov2-base-int8.onnx' },
];

const l2 = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / s; return o; };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

async function tensorFrom(buf) {
  const { data } = await sharp(buf).removeAlpha().resize(SIZE, SIZE, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const N = SIZE * SIZE, t = new Float32Array(3 * N);
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) t[c * N + i] = (data[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  return t;
}
// one forward pass -> { cls, mean } (both L2-normed). mean = patch tokens (excl CLS)
async function embedBoth(session, inName, outName, buf) {
  const t = await tensorFrom(buf);
  const out = await session.run({ [inName]: new ort.Tensor('float32', t, [1, 3, SIZE, SIZE]) });
  const lhs = out[outName];
  const [, T, D] = lhs.dims;
  const d = lhs.data;
  const cls = l2(Float32Array.from(d.slice(0, D)));
  const mean = new Float32Array(D);
  for (let ti = 1; ti < T; ti++) { const base = ti * D; for (let k = 0; k < D; k++) mean[k] += d[base + k]; }
  for (let k = 0; k < D; k++) mean[k] /= (T - 1);
  return { cls, mean: l2(mean) };
}

async function fetchImg(url, name) {
  const p = resolve(artDir, name);
  if (existsSync(p)) return readFileSync(p);
  for (let i = 0; i < 3; i++) { try { const r = await fetch(url, { headers: HEADERS }); if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); writeFileSync(p, b); await sleep(55); return b; } } catch {} await sleep(400); }
  return null;
}
async function artRegion(buf) {
  const m = await sharp(buf).metadata();
  const W = m.width, H = m.height;
  return sharp(buf).extract({ left: Math.round(W * 0.08), top: Math.round(H * 0.11), width: Math.round(W * 0.84), height: Math.round(H * 0.45) }).toBuffer();
}
async function photoAug(buf, seed) {
  const rot = ((seed * 37) % 9) - 4, bright = 0.75 + ((seed * 13) % 50) / 100, blur = 0.4 + ((seed * 7) % 10) / 10;
  return sharp(buf).rotate(rot, { background: '#000' }).modulate({ brightness: bright }).blur(blur).jpeg({ quality: 55 }).toBuffer();
}

async function main() {
  const all = JSON.parse(readFileSync(resolve(root, '.cache', 'arthash', 'unique_artwork.json'), 'utf8')).filter(
    (c) => !c.digital && c.image_uris?.art_crop && c.image_uris?.normal && !['token', 'art_series', 'emblem', 'double_faced_token'].includes(c.layout)
  );
  const step = Math.floor(all.length / INDEX_N);
  const index = []; for (let i = 0; i < INDEX_N; i++) index.push(all[i * step]);
  const queries = []; for (let i = 0; i < QUERY_N; i++) queries.push(index[Math.floor((i * INDEX_N) / QUERY_N)]);

  console.log(`fetching ${index.length} art crops + ${queries.length} card images…`);
  const refBuf = [];
  for (let i = 0; i < index.length; i++) { refBuf[i] = await fetchImg(index[i].image_uris.art_crop, `ac_${index[i].id}.jpg`); if ((i + 1) % 800 === 0) console.log(`  crops ${i + 1}/${index.length}`); }
  const qNormal = [];
  for (let i = 0; i < queries.length; i++) qNormal[i] = await fetchImg(queries[i].image_uris.normal, `nm_${queries[i].id}.jpg`);
  // pre-make degraded query art buffers once (shared across models)
  const qBuf = [];
  for (let qi = 0; qi < queries.length; qi++) qBuf[qi] = qNormal[qi] ? await photoAug(await artRegion(qNormal[qi]), qi + 1) : null;

  const results = [];
  for (const m of MODELS) {
    const mp = resolve(modelDir, m.file);
    if (!existsSync(mp)) { console.log(`skip ${m.key} (missing ${m.file})`); continue; }
    const session = await ort.InferenceSession.create(mp, { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: 4 });
    const inName = session.inputNames[0];
    const outName = session.outputNames.includes('last_hidden_state') ? 'last_hidden_state' : session.outputNames[0];
    console.log(`\n=== ${m.key} (${m.file}) in=${inName} out=${outName} — embedding ${index.length} index…`);
    const t0 = Date.now();
    const idxCls = [], idxMean = [];
    for (let i = 0; i < index.length; i++) {
      if (!refBuf[i]) { idxCls[i] = null; idxMean[i] = null; continue; }
      const { cls, mean } = await embedBoth(session, inName, outName, refBuf[i]);
      idxCls[i] = cls; idxMean[i] = mean;
      if ((i + 1) % 1000 === 0) console.log(`  ${i + 1}/${index.length}  ${Math.round((Date.now() - t0) / (i + 1))}ms/emb`);
    }
    const perMs = Math.round((Date.now() - t0) / index.length);
    const D = (idxCls.find(Boolean) || []).length;

    for (const pool of ['cls', 'mean']) {
      const idx = pool === 'cls' ? idxCls : idxMean;
      let top1 = 0, top5 = 0, n = 0; const sep = [];
      for (let qi = 0; qi < queries.length; qi++) {
        if (!qBuf[qi]) continue;
        const { cls, mean } = await embedBoth(session, inName, outName, qBuf[qi]);
        const qv = pool === 'cls' ? cls : mean;
        const scored = idx.map((v, i) => ({ i, s: v ? dot(qv, v) : -1 })).sort((a, b) => b.s - a.s);
        const correct = index.findIndex((c) => c.id === queries[qi].id);
        const rank = scored.findIndex((e) => e.i === correct);
        if (rank === 0) top1++; if (rank >= 0 && rank < 5) top5++;
        sep.push(scored[0].s - scored[1].s); n++;
      }
      sep.sort((a, b) => a - b);
      const row = { model: `${m.key}/${pool}`, dim: D, top1: (top1 / n) * 100, top5: (top5 / n) * 100, medSep: sep[Math.floor(sep.length / 2)], perMs };
      results.push(row);
      console.log(`--- ${row.model}: top1=${row.top1.toFixed(1)}% top5=${row.top5.toFixed(1)}% dim=${D} medSep=${row.medSep.toFixed(3)} ${perMs}ms/emb`);
    }
  }
  console.log('\n================ SUMMARY (higher top1/top5/medSep better) ================');
  results.sort((a, b) => b.top1 - a.top1);
  for (const r of results) console.log(`${r.model.padEnd(16)} top1=${r.top1.toFixed(1)}%  top5=${r.top5.toFixed(1)}%  dim=${String(r.dim).padStart(3)}  medSep=${r.medSep.toFixed(3)}  ${r.perMs}ms/emb`);
  writeFileSync(resolve(root, '.cache', 'embed', 'bakeoff2-results.json'), JSON.stringify(results, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
