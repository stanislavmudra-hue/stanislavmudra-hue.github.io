// Okolník 3D — VÝŠKOPIS PRO MLHU (engine 370, worker k atmosfera.js).
//
// Mozaika 3×3 dlaždic DEM (Float32 256², z DemSource) → výšky 384² a „dno okolí“ (minimum po blocích ~800 m,
// minimum ±~1,6 km, dvakrát rozmazat) jako půlfloaty (R16F, HALF_FLOAT – řidič je nepřevádí). V hlavním vlákně
// stála stavba na TT 84–121 ms (sekání), tady nevadí.
'use strict';
const OBVOD = 2 * Math.PI * 6371008.8;
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
/// float → bity půlfloatu (výšky 0–2000 m: krok ~1 m; malé hodnoty → 0, velké → strop)
function pul(v) {
  f32[0] = v;
  const x = u32[0];
  const s = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 127 + 15;
  const m = x & 0x7fffff;
  if (e <= 0) return s;
  if (e >= 31) return s | 0x7bff;
  return s | ((e << 10) + ((m + 0x1000) >>> 13));
}
self.onmessage = (ev) => {
  const m = ev.data || {};
  const t0 = performance.now();
  const data = m.data || [];
  const S = 384, h = new Float32Array(S * S).fill(NaN);
  let sum = 0, cnt = 0;
  for (let tj = 0; tj < 3; tj++) {
    for (let ti = 0; ti < 3; ti++) {
      const d = data[tj * 3 + ti];
      if (!d || d.length < 65536) continue;
      for (let y = 0; y < 128; y++) {
        const r0 = 2 * y * 256, cil = (tj * 128 + y) * S + ti * 128;
        for (let x = 0; x < 128; x++) {
          const k = r0 + 2 * x;
          const v = (d[k] + d[k + 1] + d[k + 256] + d[k + 257]) * 0.25;
          if (v > -500 && v < 9000) { h[cil + x] = v; sum += v; cnt++; }
        }
      }
    }
  }
  const prum = cnt ? sum / cnt : 300;
  for (let i = 0; i < h.length; i++) if (!(h[i] === h[i])) h[i] = prum;
  // dno okolí: minimum po blocích ~800 m, pak minimum ±~1,6 km a dvakrát rozmazat
  const pxM = OBVOD * Math.cos(m.lat * Math.PI / 180) / Math.pow(2, m.zD) / 128;
  const b = Math.max(1, Math.round(800 / pxM)), G = Math.ceil(S / b);
  let A = new Float32Array(G * G).fill(1e9), B = new Float32Array(G * G);
  for (let y = 0; y < S; y++) {
    const gy = Math.floor(y / b) * G;
    for (let x = 0; x < S; x++) { const i = gy + Math.floor(x / b), v = h[y * S + x]; if (v < A[i]) A[i] = v; }
  }
  const R = Math.max(1, Math.round(1600 / (b * pxM)));
  const pruchod = (src, dst, dx, dy, r, minimum) => {
    for (let y = 0; y < G; y++) {
      for (let x = 0; x < G; x++) {
        let v0 = minimum ? 1e9 : 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = x + k * dx, yy = y + k * dy;
          if (xx < 0 || yy < 0 || xx >= G || yy >= G) continue;
          const v = src[yy * G + xx];
          if (minimum) { if (v < v0) v0 = v; } else { v0 += v; n++; }
        }
        dst[y * G + x] = minimum ? v0 : v0 / n;
      }
    }
  };
  pruchod(A, B, 1, 0, R, true); pruchod(B, A, 0, 1, R, true);
  for (let p = 0; p < 2; p++) { pruchod(A, B, 1, 0, 1, false); pruchod(B, A, 0, 1, 1, false); }
  const hH = new Uint16Array(S * S);
  for (let i = 0; i < hH.length; i++) hH[i] = pul(h[i]);
  const dH = new Uint16Array(G * G);
  for (let i = 0; i < dH.length; i++) dH[i] = pul(A[i]);
  self.postMessage({ klic: m.klic, zD: m.zD, x0: m.x0, y0: m.y0, S, G, h: hH, dno: dH,
                     hStred: h[192 * S + 192], dnoStred: A[(G >> 1) * G + (G >> 1)],
                     ms: +(performance.now() - t0).toFixed(1) }, [hH.buffer, dH.buffer]);
};
