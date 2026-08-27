// Embedding model bake-off (scanner Stage A, offline, PC-only). Builds a real
// index of art crops, generates photo-degraded queries by cropping the art out
// of full-card images and augmenting them (framing shift + rotate/shear +
// brightness + blur + JPEG), and measures top-1/top-5 retrieval per model. The
// winner + its distance separation drives the on-device migration decision.
//
//   node scripts/embed/bakeoff.mjs [indexN] [queryN]
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

const INDEX_N = parseInt(process.argv[2] || '2500', 10);
const QUERY_N = parseInt(process.argv[3] || '120', 10);
const HEADERS = { 'User-Agent': 'CommanderCodex/1.0 (research)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODELS = {
  dinov2: {
    file: 'dinov2-small.onnx',
    size: 224,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
    read: (out) => {
      // last_hidden_state (1, tokens, 384) → CLS token
      const lhs = out.last_hidden_state;
      const dim = lhs.dims[2];
      return Float32Array.from(lhs.data.slice(0, dim));
    },
  },
  clip: {
    file: 'clip-vision-q.onnx',
    size: 224,
    mean: [0.48145466, 0.4578275, 0.40821073],
    std: [0.26862954, 0.2613026, 0.2757771],
    read: (out) => Float32Array.from(out.image_embeds.data),
  },
};

function l2(v) {
  let s = 0;
  for (const x of v) s += x * x;
  s = Math.sqrt(s) || 1;
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] / s;
  return o;
}
const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

async function tensorFrom(buf, cfg) {
  const { data } = await sharp(buf).removeAlpha().resize(cfg.size, cfg.size, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  const N = cfg.size * cfg.size;
  const t = new Float32Array(3 * N);
  for (let i = 0; i < N; i++)
    for (let c = 0; c < 3; c++) t[c * N + i] = (data[i * 3 + c] / 255 - cfg.mean[c]) / cfg.std[c];
  return new ort.Tensor('float32', t, [1, 3, cfg.size, cfg.size]);
}
async function embed(session, cfg, buf) {
  const input = await tensorFrom(buf, cfg);
  const out = await session.run({ pixel_values: input });
  return l2(cfg.read(out));
}

async function fetchImg(url, cacheName) {
  const p = resolve(artDir, cacheName);
  if (existsSync(p)) return readFileSync(p);
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.ok) {
        const b = Buffer.from(await r.arrayBuffer());
        writeFileSync(p, b);
        await sleep(60);
        return b;
      }
    } catch {}
    await sleep(400);
  }
  return null;
}

// crop the art region out of a full card image (what the device does loosely)
async function artRegion(normalBuf) {
  const m = await sharp(normalBuf).metadata();
  const W = m.width, H = m.height;
  return sharp(normalBuf)
    .extract({ left: Math.round(W * 0.08), top: Math.round(H * 0.11), width: Math.round(W * 0.84), height: Math.round(H * 0.45) })
    .toBuffer();
}
// degrade an art crop to look like a phone photo of a card
async function photoAug(buf, seed) {
  const rot = ((seed * 37) % 9) - 4; // -4..4 deg
  const bright = 0.75 + ((seed * 13) % 50) / 100; // 0.75..1.25
  const blur = 0.4 + ((seed * 7) % 10) / 10; // 0.4..1.3
  return sharp(buf)
    .rotate(rot, { background: '#000' })
    .modulate({ brightness: bright })
    .blur(blur)
    .jpeg({ quality: 55 })
    .toBuffer();
}

async function main() {
  const all = JSON.parse(readFileSync(resolve(root, '.cache', 'arthash', 'unique_artwork.json'), 'utf8')).filter(
    (c) => !c.digital && c.image_uris?.art_crop && c.image_uris?.normal && !['token', 'art_series', 'emblem', 'double_faced_token'].includes(c.layout)
  );
  // deterministic spread across the catalogue
  const step = Math.floor(all.length / INDEX_N);
  const index = [];
  for (let i = 0; i < INDEX_N; i++) index.push(all[i * step]);
  const queries = [];
  for (let i = 0; i < QUERY_N; i++) queries.push(index[Math.floor((i * INDEX_N) / QUERY_N)]);

  console.log(`fetching ${index.length} art crops + ${queries.length} card images…`);
  const refBuf = [];
  for (let i = 0; i < index.length; i++) {
    refBuf[i] = await fetchImg(index[i].image_uris.art_crop, `ac_${index[i].id}.jpg`);
    if ((i + 1) % 500 === 0) console.log(`  art crops ${i + 1}/${index.length}`);
  }
  const qNormal = [];
  for (let i = 0; i < queries.length; i++) qNormal[i] = await fetchImg(queries[i].image_uris.normal, `nm_${queries[i].id}.jpg`);

  for (const [name, cfg] of Object.entries(MODELS)) {
    const session = await ort.InferenceSession.create(resolve(modelDir, cfg.file));
    console.log(`\n=== ${name} — embedding index…`);
    const t0 = Date.now();
    const idxVecs = [];
    for (let i = 0; i < index.length; i++) {
      idxVecs[i] = refBuf[i] ? await embed(session, cfg, refBuf[i]) : null;
      if ((i + 1) % 800 === 0) console.log(`  ${i + 1}/${index.length}`);
    }
    const perMs = Math.round((Date.now() - t0) / index.length);

    let top1 = 0, top5 = 0;
    const sep = [];
    for (let qi = 0; qi < queries.length; qi++) {
      if (!qNormal[qi]) continue;
      const art = await artRegion(qNormal[qi]);
      const aug = await photoAug(art, qi + 1);
      const qv = await embed(session, cfg, aug);
      const scored = idxVecs.map((v, i) => ({ i, s: v ? dot(qv, v) : -1 })).sort((a, b) => b.s - a.s);
      const correct = index.findIndex((c) => c.id === queries[qi].id);
      const rank = scored.findIndex((e) => e.i === correct);
      if (rank === 0) top1++;
      if (rank >= 0 && rank < 5) top5++;
      sep.push(scored[0].s - scored[1].s); // top1 vs top2 cosine gap
    }
    const n = queries.filter((_, i) => qNormal[i]).length;
    sep.sort((a, b) => a - b);
    console.log(
      `--- ${name}: top1=${((top1 / n) * 100).toFixed(1)}%  top5=${((top5 / n) * 100).toFixed(1)}%  ` +
        `dim=${idxVecs.find(Boolean).length}  ${perMs}ms/emb  medSep=${sep[Math.floor(sep.length / 2)].toFixed(3)}`
    );
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
