// Worker STÍNŮ KOPCŮ (engine 234). Hlavní vlákno posílá dlaždice DEM
// ({typ:'dem', klic, data: Float32Array 256×256 m | null}) a požadavky
// ({typ:'stiny', id, klice, zD, x0, y0, x1, y1, G, cx0, cy0, cdx, cdy, dpx,
// dpy, stoupani, ex, KROKU_BLIZKO, KROKU_DALEKO, HRUBOST}). Worker slepí
// mozaiku a z každé buňky mřížky G×G pošle paprsek KE SLUNCI; když terén
// (× převýšení) paprsek převýší, buňka je ve stínu. Odpověď: {typ:'hotovo',
// id, G, px: ArrayBuffer RGBA G×G, veStinu, ms}; chybí-li dlaždice:
// {typ:'chybi', id, klice}. Dřív to běželo na hlavním vlákně (14–220 ms po
// každém posunu = trhnutí po gestu).
'use strict';
const DEM = new Map();
let cekajici = null;

function mozaika(r) {
  const nx = r.x1 - r.x0 + 1, ny = r.y1 - r.y0 + 1;
  const S = nx * 256, V = ny * 256;
  const data = new Float32Array(S * V);
  data.fill(-10000);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const d = DEM.get(r.zD + '/' + (r.x0 + i) + '/' + (r.y0 + j));
      if (!d) continue;
      for (let row = 0; row < 256; row++) data.set(d.subarray(row * 256, row * 256 + 256), (j * 256 + row) * S + i * 256);
    }
  }
  return { data, S, V };
}

function spocitej(r) {
  const { data, S, V } = mozaika(r);
  const G = r.G;
  const px = new Uint8ClampedArray(G * G * 4);
  const ex = r.ex;
  let veStinu = 0;
  for (let gy = 0; gy < G; gy++) {
    const fy0 = r.cy0 + (gy + 0.5) * r.cdy;
    for (let gx = 0; gx < G; gx++) {
      const fx0 = r.cx0 + (gx + 0.5) * r.cdx;
      let ix = fx0 | 0, iy = fy0 | 0;
      if (ix < 0 || iy < 0 || ix >= S || iy >= V) continue;
      const h0 = data[iy * S + ix];
      if (h0 < -9000) continue;
      let fx = fx0, fy = fy0, ray = h0 * ex + 0.8;
      let stin = 0, sx = r.dpx, sy = r.dpy, st = r.stoupani;
      const n = r.KROKU_BLIZKO + r.KROKU_DALEKO;
      for (let k = 1; k <= n; k++) {
        if (k === r.KROKU_BLIZKO + 1) { sx *= r.HRUBOST; sy *= r.HRUBOST; st *= r.HRUBOST; }
        fx += sx; fy += sy; ray += st;
        ix = fx | 0; iy = fy | 0;
        if (ix < 0 || iy < 0 || ix >= S || iy >= V) break;
        const h = data[iy * S + ix];
        if (h < -9000) break;
        if (h * ex > ray) { stin = 1; break; }
      }
      if (stin) {
        const i = (gy * G + gx) * 4;
        px[i] = 42; px[i + 1] = 29; px[i + 2] = 16; px[i + 3] = 140;   // alfa 0,55
        veStinu++;
      }
    }
  }
  return { px, veStinu };
}

function zkus() {
  if (!cekajici) return;
  const r = cekajici;
  const chybi = r.klice.filter((k) => !DEM.has(k));
  if (chybi.length) { postMessage({ typ: 'chybi', id: r.id, klice: chybi }); return; }
  cekajici = null;
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const v = spocitej(r);
  const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
  postMessage({ typ: 'hotovo', id: r.id, G: r.G, px: v.px.buffer, veStinu: v.veStinu, ms }, [v.px.buffer]);
}

onmessage = (ev) => {
  const m = ev.data || {};
  if (m.typ === 'dem') {
    DEM.set(m.klic, m.data ? new Float32Array(m.data) : null);
    while (DEM.size > 64) DEM.delete(DEM.keys().next().value);
    zkus();
  } else if (m.typ === 'stiny') {
    cekajici = m;
    zkus();
  }
};
