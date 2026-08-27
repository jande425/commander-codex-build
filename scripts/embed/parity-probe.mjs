// Preprocessing parity probe. The index is built with sharp (libjpeg-turbo
// decode + lanczos resize); the device will use jpeg-js decode + a pure-JS
// bilinear resize (no sharp on a phone). This measures whether those two paths
// yield the SAME embedding for the same crop — cosine ~1.0 means they're
// interchangeable (keep the sharp index); a low cosine means we must rebuild the
// index with the shared jpeg-js+bilinear path for true parity.
import ort from 'onnxruntime-node';
import sharp from 'sharp';
import jpeg from 'jpeg-js';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..', '..');
const cropDir = resolve(root, '.cache', 'embed', 'artfull');
const modelDir = resolve(root, '.cache', 'embed', 'models');
const SIZE = 224, MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

const l2 = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; for (let i = 0; i < v.length; i++) v[i] /= s; return v; };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// the EXACT bilinear stretch we'll ship on device (center-aligned sampling)
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
const toTensor = (rgb) => { const N = SIZE * SIZE, t = new Float32Array(3 * N); for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) t[c * N + i] = (rgb[i * 3 + c] / 255 - MEAN[c]) / STD[c]; return new ort.Tensor('float32', t, [1, 3, SIZE, SIZE]); };

async function main() {
  const ses = await ort.InferenceSession.create(resolve(modelDir, 'dinov2-small.onnx'));
  const run = async (t) => { const o = await ses.run({ pixel_values: t }); const l = o.last_hidden_state; return l2(Float32Array.from(l.data.slice(0, l.dims[2]))); };
  const files = readdirSync(cropDir).filter((f) => f.endsWith('.jpg')).slice(0, 50);
  const sims = [];
  for (const f of files) {
    const bytes = readFileSync(resolve(cropDir, f));
    // path A — sharp (matches the index builder)
    const { data: rgbA } = await sharp(bytes).removeAlpha().resize(SIZE, SIZE, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    const vA = await run(toTensor(rgbA));
    // path B — jpeg-js decode + JS bilinear (matches the device)
    const dec = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    const rgbB = bilinearRGB(dec.data, dec.width, dec.height, SIZE, SIZE);
    const vB = await run(toTensor(rgbB));
    sims.push(dot(vA, vB));
  }
  sims.sort((a, b) => a - b);
  const mean = sims.reduce((s, x) => s + x, 0) / sims.length;
  console.log(`n=${sims.length}  min=${sims[0].toFixed(4)}  p10=${sims[Math.floor(sims.length * 0.1)].toFixed(4)}  median=${sims[Math.floor(sims.length / 2)].toFixed(4)}  mean=${mean.toFixed(4)}`);
  console.log(sims[0] > 0.98 ? 'PARITY OK — sharp index is interchangeable with jpeg-js+bilinear device' : 'PARITY GAP — rebuild index with shared jpeg-js+bilinear preprocessing');
}
main().catch((e) => { console.error(e); process.exit(1); });
