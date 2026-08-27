// Final validation of the SHIPPED index. Loads the exact assets the app bundles
// (art-embeddings.i8 int8 vectors + manifest) and runs photo-degraded queries
// against the full 47k index using the same ORT 1.24.3 + jpeg-js+bilinear path
// the device uses. This is the closest offline proxy to on-device retrieval.
//
//   node scripts/embed/verify-index.mjs [nQueries]
import ort from 'onnxruntime-node';
import sharp from 'sharp';
import jpeg from 'jpeg-js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const qDir = resolve(root, '.cache', 'embed', 'qnormals');
mkdirSync(qDir, { recursive: true });
const NQ = parseInt(process.argv[2] || '30', 10);
const SIZE = 224, DIM = 384, MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
const HEADERS = { 'User-Agent': 'CommanderCodex/1.0 (research)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const l2 = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; for (let i = 0; i < v.length; i++) v[i] /= s; return v; };
function bil(rgba, sw, sh, dw, dh) { const out = new Uint8Array(dw * dh * 3); for (let y = 0; y < dh; y++) { let fy = (y + 0.5) * sh / dh - 0.5; let y0 = Math.floor(fy); const wy = fy - y0; let y1 = y0 + 1; if (y0 < 0) y0 = 0; if (y0 > sh - 1) y0 = sh - 1; if (y1 < 0) y1 = 0; if (y1 > sh - 1) y1 = sh - 1; for (let x = 0; x < dw; x++) { let fx = (x + 0.5) * sw / dw - 0.5; let x0 = Math.floor(fx); const wx = fx - x0; let x1 = x0 + 1; if (x0 < 0) x0 = 0; if (x0 > sw - 1) x0 = sw - 1; if (x1 < 0) x1 = 0; if (x1 > sw - 1) x1 = sw - 1; for (let c = 0; c < 3; c++) { const p00 = rgba[(y0 * sw + x0) * 4 + c], p01 = rgba[(y0 * sw + x1) * 4 + c], p10 = rgba[(y1 * sw + x0) * 4 + c], p11 = rgba[(y1 * sw + x1) * 4 + c]; const top = p00 + (p01 - p00) * wx, bot = p10 + (p11 - p10) * wx; out[(y * dw + x) * 3 + c] = top + (bot - top) * wy; } } } return out; }
async function emb(ses, buf) { const d = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true }); const rgb = bil(d.data, d.width, d.height, SIZE, SIZE); const N = SIZE * SIZE, t = new Float32Array(3 * N); for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) t[c * N + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c]; const o = await ses.run({ pixel_values: new ort.Tensor('float32', t, [1, 3, SIZE, SIZE]) }); const lhs = o.last_hidden_state; return l2(Float32Array.from(lhs.data.slice(0, lhs.dims[2]))); }
// crop art region from a full card + degrade to a phone photo (independent of the index build)
async function query(buf, seed) { const m = await sharp(buf).metadata(), W = m.width, H = m.height; const art = await sharp(buf).extract({ left: Math.round(W * 0.08), top: Math.round(H * 0.11), width: Math.round(W * 0.84), height: Math.round(H * 0.45) }).toBuffer(); return sharp(art).rotate(((seed * 37) % 9) - 4, { background: '#000' }).modulate({ brightness: 0.75 + ((seed * 13) % 50) / 100 }).blur(0.4 + ((seed * 7) % 10) / 10).jpeg({ quality: 55 }).toBuffer(); }

async function main() {
  const man = JSON.parse(readFileSync(resolve(root, 'src', 'data', 'art-embeddings.manifest.json'), 'utf8'));
  const vecs = new Int8Array(readFileSync(resolve(root, 'assets', 'models', 'art-embeddings.i8')).buffer.slice(0));
  const n = man.count;
  console.log(`shipped index: ${n} rows × ${DIM} int8 (${(vecs.length / 1e6).toFixed(1)}M values)`);
  // pick queries spread across the manifest; join to unique_artwork for a normal image
  const uniq = JSON.parse(readFileSync(resolve(root, '.cache', 'arthash', 'unique_artwork.json'), 'utf8'));
  const byId = new Map();
  for (const c of uniq) if (c.id) byId.set(c.id.replace(/-/g, ''), c);
  const ses = await ort.InferenceSession.create(resolve(root, 'assets', 'models', 'dinov2-small.onnx'));
  const step = Math.floor(n / NQ);
  let hit1 = 0, hit5 = 0, tested = 0; const sims = [];
  for (let qi = 0; qi < NQ; qi++) {
    const row = qi * step;
    const [id, name] = man.rows[row];
    const card = byId.get(id);
    const url = card?.image_uris?.normal || card?.card_faces?.[0]?.image_uris?.normal;
    if (!url) continue;
    const p = resolve(qDir, `${id}.jpg`);
    let buf;
    if (existsSync(p)) buf = readFileSync(p);
    else { const r = await fetch(url, { headers: HEADERS }); if (!r.ok) continue; buf = Buffer.from(await r.arrayBuffer()); writeFileSync(p, buf); await sleep(60); }
    const qv = await emb(ses, await query(buf, qi + 1));
    // cosine vs full int8 index
    let best = -2, bestI = -1, second = -2;
    const scored = [];
    for (let r = 0; r < n; r++) { let acc = 0; const b = r * DIM; for (let d = 0; d < DIM; d++) acc += qv[d] * vecs[b + d]; const s = acc / 127; scored.push(s); if (s > best) { second = best; best = s; bestI = r; } else if (s > second) second = s; }
    // top5 rank of the correct row
    const correctSim = scored[row];
    let rank = 0; for (let r = 0; r < n; r++) if (scored[r] > correctSim) rank++;
    tested++;
    if (rank === 0) hit1++;
    if (rank < 5) hit5++;
    sims.push(best);
    console.log(`${(name || '').slice(0, 24).padEnd(24)} rank=${rank} bestSim=${best.toFixed(3)} margin=${(best - second).toFixed(3)}${rank === 0 ? '' : '  <-- MISS'}`);
  }
  sims.sort((a, b) => a - b);
  console.log(`\nSHIPPED INDEX: top1=${(100 * hit1 / tested).toFixed(1)}%  top5=${(100 * hit5 / tested).toFixed(1)}%  n=${tested}  bestSim median=${sims[Math.floor(sims.length / 2)].toFixed(3)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
