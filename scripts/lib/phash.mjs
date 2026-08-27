// pHash core — MUST stay identical to src/lib/phash.ts (same maths, same bit
// order) or the shipped art-hash DB won't match what the app computes on-device.
// Also provides hashJpeg(): decode a JPEG buffer → grayscale → box-resize → hash,
// using the pure-JS jpeg-js so node and the app share the exact same pipeline.
import jpeg from 'jpeg-js';

export const PHASH_SIZE = 32;
const N = PHASH_SIZE;
const K = 8;

const COS = [];
for (let k = 0; k < K; k++) {
  const row = new Array(N);
  for (let y = 0; y < N; y++) row[y] = Math.cos(((2 * y + 1) * k * Math.PI) / (2 * N));
  COS.push(row);
}

export function grayFromRGBA(rgba, px) {
  const out = new Float64Array(px);
  for (let i = 0; i < px; i++) {
    const j = i * 4;
    out[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  }
  return out;
}

export function resizeGrayToN(gray, srcW, srcH) {
  const out = new Float64Array(N * N);
  for (let ty = 0; ty < N; ty++) {
    const y0 = Math.floor((ty * srcH) / N);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * srcH) / N));
    for (let tx = 0; tx < N; tx++) {
      const x0 = Math.floor((tx * srcW) / N);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * srcW) / N));
      let sum = 0;
      let cnt = 0;
      for (let y = y0; y < y1 && y < srcH; y++) {
        const base = y * srcW;
        for (let x = x0; x < x1 && x < srcW; x++) {
          sum += gray[base + x];
          cnt++;
        }
      }
      out[ty * N + tx] = cnt ? sum / cnt : 0;
    }
  }
  return out;
}

export function phashFromGrayN(gray) {
  const tmp = new Float64Array(N * K);
  for (let x = 0; x < N; x++) {
    const base = x * N;
    for (let v = 0; v < K; v++) {
      let s = 0;
      const cv = COS[v];
      for (let y = 0; y < N; y++) s += gray[base + y] * cv[y];
      tmp[x * K + v] = s;
    }
  }
  const F = new Float64Array(K * K);
  for (let u = 0; u < K; u++) {
    const cu = COS[u];
    for (let v = 0; v < K; v++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += tmp[x * K + v] * cu[x];
      F[u * K + v] = s;
    }
  }
  const vals = [];
  for (let i = 1; i < K * K; i++) vals.push(F[i]);
  vals.sort((a, b) => a - b);
  const median = vals[31];
  let hi = 0;
  let lo = 0;
  for (let p = 0; p < 64; p++) {
    if (F[p] > median) {
      if (p < 32) hi |= 1 << (31 - p);
      else lo |= 1 << (31 - (p - 32));
    }
  }
  return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

/** Decode a JPEG buffer and hash it exactly as the app does on-device. */
export function hashJpeg(buffer) {
  const img = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true });
  const gray = grayFromRGBA(img.data, img.width * img.height);
  const small = resizeGrayToN(gray, img.width, img.height);
  return phashFromGrayN(small);
}

export function popcount32(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

export function hammingHex(a, b) {
  const aHi = parseInt(a.slice(0, 8), 16);
  const aLo = parseInt(a.slice(8, 16), 16);
  const bHi = parseInt(b.slice(0, 8), 16);
  const bLo = parseInt(b.slice(8, 16), 16);
  return popcount32((aHi ^ bHi) >>> 0) + popcount32((aLo ^ bLo) >>> 0);
}
