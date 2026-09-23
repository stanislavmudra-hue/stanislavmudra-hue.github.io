// Okolník 3D — DEKORACE KRAJINY VE WORKERU (engine 336, krok 3 plánu výkonu).
//
// Dřív se stromy, kytky, kameny a světla generovaly na HLAVNÍM vlákně
// (js/dekorace.js): index ploch z `querySourceFeatures` + převod geometrie
// stál 59–219 ms na jedno sestavení (TT 23. 9.) a výsledných až 7 000 bodů
// šlo do mapy jedním `setData`. Teď:
//   · worker si SÁM čte vektorové dlaždice krajiny (PMTiles přes tutéž
//     proxy s keší na disku jako mapa), staví index ploch a generuje body
//     TOUŽ deterministickou mřížkou (hash) jako dřív – strom stojí navěky
//     na témže místě,
//   · mapa je dostává jako VEKTOROVÉ DLAŽDICE přes protokol dekorace://
//     (z12–15, z15 = vše včetně jemné mřížky) – bez setData, s keší MapLibre,
//   · na mlhu a výšku terénu se ptá hlavního vlákna (Mlha.jeObjeveno,
//     DEM dlaždice) – logika mlhy zůstává na jednom místě,
//   · světla sídel, světlušky (kotvy roje) a stromy pro stíny posílá hlavnímu
//     vláknu jako „evidenci“ dlaždice.
//
// Zprávy z hlavního vlákna:
//   {typ:'nastav', ...}                      konfigurace (DRUHY, plochy ze stylu, zdroje…)
//   {typ:'dlazdice', id, z, x, y}           → {typ:'dlazdice', id, data: ArrayBuffer MVT, ev, chyba}
//   {typ:'mlha', id, maska}                  odpověď na dotaz na mlhu
//   {typ:'dem', id, data}                    odpověď na dotaz na výšku (Float32 256×256 | null)
//   {typ:'mlha-zmena', o}                    odkrytí (o = kruh) / null = reset
// Worker posílá: {typ:'mlha', id, body}, {typ:'dem', id, z, x, y}, {typ:'obnov', dlazdice},
// {typ:'chyba', msg} (hlavní vlákno přejde na zálohu).
'use strict';
importScripts('../vendor/pmtiles.js');

const EXT = 4096;                   // rozsah výstupních dlaždic (MVT)
const Z_MIN = 12, Z_MAX = 15;       // výstupní úrovně (z15 = vše, jemná mřížka)
const KES_VYSTUP = 120;             // vygenerovaných dlaždic v paměti (~100 kB kus)
const KES_ZDROJ = 24;               // dekódovaných zdrojových dlaždic (výřez ≈ 6 × 3 zdroje)
const MRIZKA_IDX = 16;              // index ploch: 16×16 buněk na dlaždici

let N = null;                       // konfigurace z hlavního vlákna
let cfgKlic = '';
const archivy = new Map();          // zdroj → { pm, hlavicka (Promise) }
const zdrojDl = new Map();          // 'zdroj|z/x/y' → Promise<vrstvy>
let vrstvyZdroju = new Map();       // zdroj → Set vrstev, které kdy budou potřeba
const vystup = new Map();           // 'z/x/y' → výsledek (kandidáti + maska mlhy)
const demKes = new Map();           // 'z/x/y' → Promise<Float32Array|null>
const posledniPozadavek = new Map(); // 'z/x/y' → čas (pro odkrytí mlhy)
let dotazId = 0;
const dotazy = new Map();           // id → resolve (mlha, dem)
const retezce = [], retezecIdx = new Map();   // tabulka jmen obrázků (ik)
const casy = { gen: [], mlha: [], zdroj: [], rozpad: [] };
function zapisCas(k, ms) { const a = casy[k]; a.push(Math.round(ms * 10) / 10); if (a.length > 20) a.shift(); }
function idxRetezce(s) {
  let i = retezecIdx.get(s);
  if (i === undefined) { i = retezce.length; retezce.push(s); retezecIdx.set(s, i); }
  return i;
}

// ---------------------------------------------------------------------------
// Protobuf / MVT – čtení
// ---------------------------------------------------------------------------
function cVarint(p) {
  const b = p.buf;
  let v, x = b[p.pos++];
  v = x & 0x7f; if (x < 0x80) return v;
  x = b[p.pos++]; v |= (x & 0x7f) << 7; if (x < 0x80) return v;
  x = b[p.pos++]; v |= (x & 0x7f) << 14; if (x < 0x80) return v;
  x = b[p.pos++]; v |= (x & 0x7f) << 21; if (x < 0x80) return v;
  x = b[p.pos]; v |= (x & 0x0f) << 28;
  let h;
  x = b[p.pos++]; h = (x & 0x70) >> 4; if (x < 0x80) return (h >>> 0) * 4294967296 + (v >>> 0);
  x = b[p.pos++]; h |= (x & 0x7f) << 3; if (x < 0x80) return (h >>> 0) * 4294967296 + (v >>> 0);
  x = b[p.pos++]; h |= (x & 0x7f) << 10; if (x < 0x80) return (h >>> 0) * 4294967296 + (v >>> 0);
  x = b[p.pos++]; h |= (x & 0x7f) << 17; if (x < 0x80) return (h >>> 0) * 4294967296 + (v >>> 0);
  x = b[p.pos++]; h |= (x & 0x7f) << 24; if (x < 0x80) return (h >>> 0) * 4294967296 + (v >>> 0);
  x = b[p.pos++]; h |= (x & 0x01) << 31; if (x < 0x80) return (h >>> 0) * 4294967296 + (v >>> 0);
  throw new Error('varint');
}
function preskoc(p, w) {
  if (w === 0) cVarint(p);
  else if (w === 1) p.pos += 8;
  else if (w === 2) { const n = cVarint(p); p.pos += n; }
  else if (w === 5) p.pos += 4;
  else throw new Error('wire ' + w);
}
const dek = new TextDecoder();
function utf8(p, n) { const s = dek.decode(p.buf.subarray(p.pos, p.pos + n)); p.pos += n; return s; }
function cHodnota(p, konec) {
  let v = null;
  while (p.pos < konec) {
    const t = cVarint(p), f = t >> 3, w = t & 7;
    if (f === 1 && w === 2) v = utf8(p, cVarint(p));
    else if (f === 2 && w === 5) { v = p.dv.getFloat32(p.pos, true); p.pos += 4; }
    else if (f === 3 && w === 1) { v = p.dv.getFloat64(p.pos, true); p.pos += 8; }
    else if ((f === 4 || f === 5) && w === 0) v = cVarint(p);
    else if (f === 6 && w === 0) { const n = cVarint(p); v = (n % 2) ? -(n + 1) / 2 : n / 2; }
    else if (f === 7 && w === 0) v = !!cVarint(p);
    else preskoc(p, w);
  }
  return v;
}
function zz(n) { return (n >>> 1) ^ -(n & 1); }
/// geometrie prvku → pole částí [x,y,x,y…] v souřadnicích dlaždice
function cGeometrie(p, konec) {
  const casti = [];
  let cur = null, x = 0, y = 0, cmd = 0, pocet = 0;
  while (p.pos < konec) {
    if (pocet <= 0) { const ci = cVarint(p); cmd = ci & 7; pocet = ci >> 3; }
    pocet--;
    if (cmd === 1 || cmd === 2) {
      x += zz(cVarint(p)); y += zz(cVarint(p));
      if (cmd === 1) { cur = [x, y]; casti.push(cur); } else if (cur) cur.push(x, y);
    } else if (cmd === 7) {
      if (cur && cur.length >= 2) cur.push(cur[0], cur[1]);
    }
  }
  return casti;
}
/// geometrie prvku až na požádání (většinu prvků filtr vyřadí dřív)
function geomPrvku(v, f) {
  if (f.geom === null) f.geom = f.g1 > f.g0 ? cGeometrie({ buf: v.b, pos: f.g0 }, f.g1) : [];
  return f.geom;
}
/// dlaždice → { jméno vrstvy: { extent, prvky:[{typ, vl, g0, g1}], b } } jen pro chtěné vrstvy
function dekodujMVT(buf, chci) {
  const b = new Uint8Array(buf);
  const p = { buf: b, pos: 0, dv: new DataView(b.buffer, b.byteOffset, b.byteLength) };
  const out = {};
  while (p.pos < b.length) {
    const t = cVarint(p), f = t >> 3, w = t & 7;
    if (f !== 3 || w !== 2) { preskoc(p, w); continue; }
    const len = cVarint(p), konec = p.pos + len, zac = p.pos;
    let nazev = null;
    while (p.pos < konec) {
      const t2 = cVarint(p), f2 = t2 >> 3, w2 = t2 & 7;
      if (f2 === 1 && w2 === 2) { nazev = utf8(p, cVarint(p)); break; }
      preskoc(p, w2);
    }
    if (nazev === null || (chci && !chci.has(nazev))) { p.pos = konec; continue; }
    p.pos = zac;
    const klice = [], hodnoty = [], rozsahy = [];
    let extent = 4096;
    while (p.pos < konec) {
      const t2 = cVarint(p), f2 = t2 >> 3, w2 = t2 & 7;
      if (f2 === 2 && w2 === 2) { const n = cVarint(p); rozsahy.push(p.pos, p.pos + n); p.pos += n; }
      else if (f2 === 3 && w2 === 2) klice.push(utf8(p, cVarint(p)));
      else if (f2 === 4 && w2 === 2) { const n = cVarint(p); hodnoty.push(cHodnota(p, p.pos + n)); }
      else if (f2 === 5 && w2 === 0) extent = cVarint(p);
      else preskoc(p, w2);
    }
    const prvky = [];
    for (let i = 0; i < rozsahy.length; i += 2) {
      p.pos = rozsahy[i];
      const kf = rozsahy[i + 1];
      let typ = 0; const vl = {}; let g0 = 0, g1 = 0;
      while (p.pos < kf) {
        const t3 = cVarint(p), f3 = t3 >> 3, w3 = t3 & 7;
        if (f3 === 2 && w3 === 2) {
          const n = cVarint(p), ke = p.pos + n;
          while (p.pos < ke) { const ki = cVarint(p), vi = cVarint(p); vl[klice[ki]] = hodnoty[vi]; }
        } else if (f3 === 3 && w3 === 0) typ = cVarint(p);
        else if (f3 === 4 && w3 === 2) { const n = cVarint(p); g0 = p.pos; g1 = p.pos + n; p.pos = g1; }
        else preskoc(p, w3);
      }
      prvky.push({ typ, vl, g0, g1, geom: null });
    }
    out[nazev] = { extent, prvky, b };
    p.pos = konec;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Protobuf / MVT – zápis
// ---------------------------------------------------------------------------
const enk = new TextEncoder();
class Zapis {
  constructor(n) { this.b = new Uint8Array(n || 256); this.p = 0; }
  misto(k) {
    if (this.p + k <= this.b.length) return;
    const nb = new Uint8Array(Math.max(this.b.length * 2, this.p + k));
    nb.set(this.b.subarray(0, this.p));
    this.b = nb;
  }
  varint(v) { this.misto(10); while (v >= 0x80) { this.b[this.p++] = (v & 0x7f) | 0x80; v = Math.floor(v / 128); } this.b[this.p++] = v; }
  tag(f, w) { this.varint((f << 3) | w); }
  tVarint(f, v) { this.tag(f, 0); this.varint(v); }
  tDouble(f, v) { this.tag(f, 1); this.misto(8); new DataView(this.b.buffer).setFloat64(this.p, v, true); this.p += 8; }
  tBajty(f, u8) { this.tag(f, 2); this.varint(u8.length); this.misto(u8.length); this.b.set(u8, this.p); this.p += u8.length; }
  tText(f, s) { this.tBajty(f, enk.encode(s)); }
  tZprava(f, z) { this.tBajty(f, z.b.subarray(0, z.p)); }
  tPacked(f, arr) {
    const z = new Zapis(arr.length * 3 + 4);
    for (const v of arr) z.varint(v);
    this.tZprava(f, z);
  }
}
function zzZ(n) { return ((n << 1) ^ (n >> 31)) >>> 0; }
/// body → MVT (vrstva 'd', body v souřadnicích 0..4095)
function zakodujMVT(body) {
  if (!body.length) return new ArrayBuffer(0);
  const klice = [], kIdx = new Map(), hodn = [], hIdx = new Map();
  const vr = new Zapis(body.length * 24 + 64);
  vr.tVarint(15, 2);
  vr.tText(1, 'd');
  const fz = new Zapis(64);
  for (const f of body) {
    fz.p = 0;
    const tagy = [];
    for (const k in f.vl) {
      const v = f.vl[k];
      if (v === undefined || v === null) continue;
      let ki = kIdx.get(k);
      if (ki === undefined) { ki = klice.length; klice.push(k); kIdx.set(k, ki); }
      const hk = (typeof v === 'string' ? 's' : 'n') + v;
      let hi = hIdx.get(hk);
      if (hi === undefined) { hi = hodn.length; hodn.push(v); hIdx.set(hk, hi); }
      tagy.push(ki, hi);
    }
    fz.tPacked(2, tagy);
    fz.tVarint(3, 1);                                   // POINT
    fz.tPacked(4, [9, zzZ(f.px), zzZ(f.py)]);           // MoveTo(1)
    vr.tZprava(2, fz);
  }
  for (const k of klice) vr.tText(3, k);
  const hz = new Zapis(32);
  for (const v of hodn) {
    hz.p = 0;
    if (typeof v === 'string') hz.tText(1, v);
    else if (Number.isInteger(v) && v >= 0 && v < 4294967296) hz.tVarint(5, v);
    else if (Number.isInteger(v) && v < 0 && v > -2147483648) hz.tVarint(6, zzZ(v));
    else hz.tDouble(3, v);
    vr.tZprava(4, hz);
  }
  vr.tVarint(5, EXT);
  const dl = new Zapis(vr.p + 16);
  dl.tZprava(3, vr);
  return dl.b.slice(0, dl.p).buffer;
}

// ---------------------------------------------------------------------------
// Filtry vrstev ze stylu (podmnožina výrazů MapLibre + starý zápis)
// ---------------------------------------------------------------------------
function jeVyraz(f) {
  if (f === true || f === false) return true;
  if (!Array.isArray(f) || !f.length) return false;
  switch (f[0]) {
    case 'has': return f.length >= 2 && f[1] !== '$id' && f[1] !== '$type';
    case 'in': return f.length >= 3 && (typeof f[1] !== 'string' || Array.isArray(f[2]));
    case '!in': case '!has': case 'none': return false;
    case '==': case '!=': case '>': case '>=': case '<': case '<=':
      return f.length !== 3 || Array.isArray(f[1]) || Array.isArray(f[2]);
    case 'any': case 'all':
      for (let i = 1; i < f.length; i++) if (!jeVyraz(f[i]) && typeof f[i] !== 'boolean') return false;
      return true;
    default: return true;
  }
}
const TYPY = ['Unknown', 'Point', 'LineString', 'Polygon'];
function porovnej(op, a, b) {
  switch (op) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    default: return a >= b;
  }
}
function vyraz(e, vl, typ) {
  if (!Array.isArray(e)) return e;
  const op = e[0];
  switch (op) {
    case 'get': return vl[e[1]] === undefined ? null : vl[e[1]];
    case 'has': return e[1] in vl;
    case 'literal': return e[1];
    case 'geometry-type': return TYPY[typ] || 'Unknown';
    case '!': return !vyraz(e[1], vl, typ);
    case 'all': for (let i = 1; i < e.length; i++) if (!vyraz(e[i], vl, typ)) return false; return true;
    case 'any': for (let i = 1; i < e.length; i++) if (vyraz(e[i], vl, typ)) return true; return false;
    case '==': case '!=': case '<': case '>': case '<=': case '>=':
      return porovnej(op, vyraz(e[1], vl, typ), vyraz(e[2], vl, typ));
    case 'in': {
      const a = vyraz(e[1], vl, typ), h = vyraz(e[2], vl, typ);
      if (Array.isArray(h)) return h.indexOf(a) >= 0;
      if (typeof h === 'string') return a != null && h.indexOf(String(a)) >= 0;
      return false;
    }
    case 'match': {
      const a = vyraz(e[1], vl, typ);
      for (let i = 2; i < e.length - 1; i += 2) {
        const l = e[i];
        if (Array.isArray(l) ? l.indexOf(a) >= 0 : l === a) return vyraz(e[i + 1], vl, typ);
      }
      return vyraz(e[e.length - 1], vl, typ);
    }
    case 'coalesce': for (let i = 1; i < e.length; i++) { const v = vyraz(e[i], vl, typ); if (v != null) return v; } return null;
    case 'to-string': { const v = vyraz(e[1], vl, typ); return v == null ? '' : String(v); }
    case 'to-number': { const v = Number(vyraz(e[1], vl, typ)); return isNaN(v) ? 0 : v; }
    case 'string': case 'number': case 'boolean': return vyraz(e[1], vl, typ);
    default: throw new Error('filtr neznám: ' + op);
  }
}
function legacy(f, vl, typ) {
  const op = f[0];
  const hod = (k) => (k === '$type' ? TYPY[typ] : (vl[k] === undefined ? null : vl[k]));
  switch (op) {
    case 'all': for (let i = 1; i < f.length; i++) if (!legacy(f[i], vl, typ)) return false; return true;
    case 'any': for (let i = 1; i < f.length; i++) if (legacy(f[i], vl, typ)) return true; return false;
    case 'none': for (let i = 1; i < f.length; i++) if (legacy(f[i], vl, typ)) return false; return true;
    case 'has': return f[1] === '$type' || f[1] in vl;
    case '!has': return !(f[1] in vl);
    case 'in': { const v = hod(f[1]); for (let i = 2; i < f.length; i++) if (f[i] === v) return true; return false; }
    case '!in': { const v = hod(f[1]); for (let i = 2; i < f.length; i++) if (f[i] === v) return false; return true; }
    case '==': case '!=': case '<': case '>': case '<=': case '>=': return porovnej(op, hod(f[1]), f[2]);
    default: throw new Error('filtr neznám: ' + op);
  }
}
/// filtr → funkce (vl, typ) → bool; neznámý výraz = výjimka hned tady
function prelozFiltr(f) {
  if (f == null) return () => true;
  const vyr = jeVyraz(f);
  const fn = vyr ? (vl, typ) => !!vyraz(f, vl, typ) : (vl, typ) => legacy(f, vl, typ);
  fn({ class: 'x', t: 'x', d: 'x' }, 3);           // zkouška: neznámý operátor vyhodí hned
  return fn;
}

// ---------------------------------------------------------------------------
// Zdrojové dlaždice (PMTiles přes proxy)
// ---------------------------------------------------------------------------
function archiv(zdroj) {
  let a = archivy.get(zdroj);
  if (a) return a;
  const url = N.zdroje[zdroj];
  if (!url) return null;
  const pm = new pmtiles.PMTiles(url);
  a = { pm, hlavicka: pm.getHeader() };
  archivy.set(zdroj, a);
  return a;
}
/// vrstvy zdroje pro dlaždici (sz ≤ z): { vrstva: {extent, prvky} } + transformace do výstupních px
async function zdrojovaDlazdice(zdroj, z, x, y, vrstvy) {
  const a = archiv(zdroj);
  if (!a) return null;
  const h = await a.hlavicka;
  if (z < h.minZoom) return null;
  const sz = Math.min(z, h.maxZoom);
  const d = z - sz;
  const sx = x >> d, sy = y >> d;
  const klic = zdroj + '|' + sz + '/' + sx + '/' + sy;
  vrstvy = vrstvyZdroju.get(zdroj) || vrstvy;
  let pr = zdrojDl.get(klic);
  if (!pr) {
    pr = (async () => {
      const t0 = performance.now();
      const r = await a.pm.getZxy(sz, sx, sy);
      const v = r && r.data ? dekodujMVT(r.data, vrstvy) : {};
      zapisCas('zdroj', performance.now() - t0);
      return v;
    })();
    zdrojDl.set(klic, pr);
    pr.catch(() => zdrojDl.delete(klic));
    while (zdrojDl.size > KES_ZDROJ) zdrojDl.delete(zdrojDl.keys().next().value);
  } else { zdrojDl.delete(klic); zdrojDl.set(klic, pr); }   // LRU
  const vr = await pr;
  // výstupní px = src px · (EXT / extent) · m + ox, kde m = 2^d a
  // ox = (sx·m − x) · EXT (výstupní dlaždice uvnitř zdrojové)
  const m = Math.pow(2, d);
  return { vrstvy: vr, m, ox: (sx * m - x) * EXT, oy: (sy * m - y) * EXT };
}

// ---------------------------------------------------------------------------
// Index ploch výstupní dlaždice (px 0..4096, buňky 256 px)
// ---------------------------------------------------------------------------
function plocha(r) {
  let s = 0;
  for (let i = 0, n = r.length; i < n - 2; i += 2) s += r[i] * r[i + 3] - r[i + 2] * r[i + 1];
  return s;
}
function postavIndex(z, zdrojove, defs, sirkaPxNaM) {
  const B = EXT / MRIZKA_IDX;
  const mrizka = new Array(MRIZKA_IDX * MRIZKA_IDX);
  const velke = [];
  const useky = [];                                  // silnice/cesty: {ax,ay,bx,by,w (px), x0..y1}
  const pridejDoMrizky = (pol) => {
    const gx0 = Math.max(0, Math.floor(pol.x0 / B)), gx1 = Math.min(MRIZKA_IDX - 1, Math.floor(pol.x1 / B));
    const gy0 = Math.max(0, Math.floor(pol.y0 / B)), gy1 = Math.min(MRIZKA_IDX - 1, Math.floor(pol.y1 / B));
    if (gx1 < gx0 || gy1 < gy0) return;
    if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > 64) { velke.push(pol); return; }
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const i = gy * MRIZKA_IDX + gx;
        (mrizka[i] || (mrizka[i] = [])).push(pol);
      }
    }
  };
  for (const d of defs) {
    const zd = zdrojove[d.zdroj];
    if (!zd) continue;
    const v = zd.vrstvy[d.vrstva];
    if (!v) continue;
    const k = EXT / v.extent;
    const m = zd.m;
    const tx = (gx) => gx * k * m + zd.ox;            // src px → výstupní px
    const ty = (gy) => gy * k * m + zd.oy;
    for (const f of v.prvky) {
      if (d.cara ? f.typ !== 2 : f.typ !== 3) continue;
      if (!d.fn(f.vl, f.typ)) continue;
      const geom = geomPrvku(v, f);
      if (!geom.length) continue;
      if (d.cara) {
        const w = (N.sirkyCar[f.vl.class] || 2.5) * sirkaPxNaM;
        for (const cast of geom) {
          for (let i = 2; i < cast.length; i += 2) {
            const ax = tx(cast[i - 2]), ay = ty(cast[i - 1]), bx = tx(cast[i]), by = ty(cast[i + 1]);
            useky.push({ ax, ay, bx, by, w,
                         x0: Math.min(ax, bx) - w, x1: Math.max(ax, bx) + w,
                         y0: Math.min(ay, by) - w, y1: Math.max(ay, by) + w });
          }
        }
        continue;
      }
      // prstence → polygony (vnější kladná plocha, díry záporná – MVT v2)
      let pol = null;
      for (const r of geom) {
        if (r.length < 8) continue;
        const a = plocha(r);
        if (a === 0) continue;
        const pr = new Float64Array(r.length);
        for (let i = 0; i < r.length; i += 2) { pr[i] = tx(r[i]); pr[i + 1] = ty(r[i + 1]); }
        if (a > 0 || !pol) {
          if (pol) pridejDoMrizky(pol);
          let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
          for (let i = 0; i < pr.length; i += 2) {
            if (pr[i] < x0) x0 = pr[i]; if (pr[i] > x1) x1 = pr[i];
            if (pr[i + 1] < y0) y0 = pr[i + 1]; if (pr[i + 1] > y1) y1 = pr[i + 1];
          }
          pol = { id: d.id, x0, y0, x1, y1, k: [pr], rady: null };
        } else pol.k.push(pr);
      }
      if (pol) pridejDoMrizky(pol);
    }
  }
  // ⭐ velké polygony (les, pole – tisíce vrcholů): hrany do vodorovných
  // pásů, test bodu projde jen hrany svého pásu (dřív celý obrys pro každý
  // kandidátní strom = ~1 s na dlaždici na TT)
  const hotove = new Set();
  const pasy = (pol) => {
    if (hotove.has(pol)) return;
    hotove.add(pol);
    let nv = 0;
    for (const r of pol.k) nv += r.length / 2;
    if (nv < 48) return;
    const R = Math.min(128, Math.max(8, Math.ceil(nv / 12)));
    const h = Math.max(1e-6, (pol.y1 - pol.y0) / R);
    const pas = new Array(R);
    for (const r of pol.k) {
      for (let i = 0, n = r.length; i < n - 2; i += 2) {
        const ya = r[i + 1], yb = r[i + 3];
        let a = Math.floor((Math.min(ya, yb) - pol.y0) / h), b = Math.floor((Math.max(ya, yb) - pol.y0) / h);
        if (a < 0) a = 0; if (b > R - 1) b = R - 1;
        for (let q = a; q <= b; q++) (pas[q] || (pas[q] = [])).push(r[i], ya, r[i + 2], yb);
      }
    }
    for (let q = 0; q < R; q++) pas[q] = pas[q] ? Float64Array.from(pas[q]) : null;
    pol.rady = { h, R, pas };
  };
  for (const b of mrizka) if (b) for (const pol of b) pasy(pol);
  for (const pol of velke) pasy(pol);
  // úseky do mřížky
  const mrizkaCar = new Array(MRIZKA_IDX * MRIZKA_IDX);
  for (const u of useky) {
    const gx0 = Math.max(0, Math.floor(u.x0 / B)), gx1 = Math.min(MRIZKA_IDX - 1, Math.floor(u.x1 / B));
    const gy0 = Math.max(0, Math.floor(u.y0 / B)), gy1 = Math.min(MRIZKA_IDX - 1, Math.floor(u.y1 / B));
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const i = gy * MRIZKA_IDX + gx;
        (mrizkaCar[i] || (mrizkaCar[i] = [])).push(u);
      }
    }
  }
  return { mrizka, velke, mrizkaCar, B };
}
function vBodu(pol, x, y) {
  let uvnitr = false;
  const rd = pol.rady;
  if (rd) {
    let q = Math.floor((y - pol.y0) / rd.h);
    if (q < 0) q = 0; else if (q >= rd.R) q = rd.R - 1;
    const e = rd.pas[q];
    if (!e) return false;
    for (let i = 0, n = e.length; i < n; i += 4) {
      const ya = e[i + 1], yb = e[i + 3];
      if ((ya > y) === (yb > y)) continue;
      if (x < (e[i + 2] - e[i]) * (y - ya) / (yb - ya) + e[i]) uvnitr = !uvnitr;
    }
    return uvnitr;
  }
  const prstence = pol.k;
  for (let ri = 0; ri < prstence.length; ri++) {
    const r = prstence[ri], n = r.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const yi = r[i + 1], yj = r[j + 1];
      if ((yi > y) === (yj > y)) continue;
      if (x < (r[j] - r[i]) * (y - yi) / (yj - yi) + r[i]) uvnitr = !uvnitr;
    }
  }
  return uvnitr;
}
function plochyPod(idx, x, y) {
  const nalez = [];
  const gx = Math.min(MRIZKA_IDX - 1, Math.max(0, Math.floor(x / idx.B)));
  const gy = Math.min(MRIZKA_IDX - 1, Math.max(0, Math.floor(y / idx.B)));
  const sesbirej = (pole) => {
    for (let i = 0; i < pole.length; i++) {
      const p = pole[i];
      if (x < p.x0 || x > p.x1 || y < p.y0 || y > p.y1) continue;
      if (nalez.indexOf(p.id) >= 0) continue;
      if (vBodu(p, x, y)) nalez.push(p.id);
    }
  };
  const b = idx.mrizka[gy * MRIZKA_IDX + gx];
  if (b) sesbirej(b);
  if (idx.velke.length) sesbirej(idx.velke);
  return nalez;
}
function naCare(idx, x, y) {
  const gx = Math.min(MRIZKA_IDX - 1, Math.max(0, Math.floor(x / idx.B)));
  const gy = Math.min(MRIZKA_IDX - 1, Math.max(0, Math.floor(y / idx.B)));
  const useky = idx.mrizkaCar[gy * MRIZKA_IDX + gx];
  if (!useky) return false;
  for (let i = 0; i < useky.length; i++) {
    const u = useky[i];
    if (x < u.x0 || x > u.x1 || y < u.y0 || y > u.y1) continue;
    const dx = u.bx - u.ax, dy = u.by - u.ay;
    const px = x - u.ax, py = y - u.ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? (px * dx + py * dy) / l2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const ddx = px - t * dx, ddy = py - t * dy;
    if (ddx * ddx + ddy * ddy < u.w * u.w) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Generování (TÁŽ mřížka jako dekorace.js doplnJadro / presneDekorace)
// ---------------------------------------------------------------------------
function hash(ix, iy, sul) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(sul, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function mercX(lon) { return (lon + 180) / 360; }
function mercY(lat) { const s = Math.sin(lat * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); }
function lonZ(mx) { return mx * 360 - 180; }
function latZ(my) { return 360 / Math.PI * Math.atan(Math.exp((0.5 - my) * 2 * Math.PI)) - 90; }

/// Které druhy patří na úroveň z: z15 vše (i jemná mřížka), níž jen sudé
/// buňky a druhy viditelné před další úrovní (práh − dohled < z + 1).
function druhyProUroven(z) {
  const out = [];
  for (const [druh, cfg] of Object.entries(N.druhy)) {
    if (cfg.sezony && cfg.sezony.indexOf(N.sezona) < 0) continue;
    if (z < Z_MAX && cfg.z0 - N.dz >= z + 1) continue;
    out.push([druh, cfg]);
  }
  return out;
}
/// Aktivní plochy pro úroveň z (zoomový rozsah vrstvy stylu). Výstup z15
/// (z14 u nejvyšší úrovně zdroje) platí i pro všechna větší přiblížení,
/// proto tam platí i vrstvy od z14,5/15 (domy, účelové cesty).
function defsProUroven(z) {
  const zDo = z >= Z_MAX ? Infinity : z + 1;          // úroveň z se kreslí v ⟨z, z+1)
  return N.plochy.filter((d) => {
    if (d.id === 'budovy-vypln' && z < 14) return false;
    return (d.zmin == null || d.zmin < zDo) && (d.zmax == null || d.zmax > z);
  });
}

async function generuj(z, x, y) {
  const t0 = performance.now();
  const n = Math.pow(2, z);
  const west = lonZ(x / n), east = lonZ((x + 1) / n);
  const north = latZ(y / n), south = latZ((y + 1) / n);
  const latStred = (north + south) / 2;
  const mNaPx = 40075016.686 * Math.cos(latStred * Math.PI / 180) / (n * EXT);
  const druhy = druhyProUroven(z);
  const defs = defsProUroven(z);
  const presne = z >= 13;
  // zdrojové dlaždice (paralelně)
  const potreba = new Map();
  for (const d of defs) { if (!potreba.has(d.zdroj)) potreba.set(d.zdroj, new Set()); potreba.get(d.zdroj).add(d.vrstva); }
  if (presne && N.zdroje.krajina) {
    if (!potreba.has('krajina')) potreba.set('krajina', new Set());
    potreba.get('krajina').add('body');
    if (z >= 14) potreba.get('krajina').add('cary');
  }
  // výška terénu se začne shánět hned (hlavní vlákno bývá při startu mapy
  // vytížené – na TT čekání až 0,5 s), souběžně se zdrojovými dlaždicemi
  const zD = Math.min(12, z), dD = z - zD;
  const demP = demDlazdice(zD, x >> dD, y >> dD).catch(() => null);
  const zdrojove = {};
  await Promise.all([...potreba].map(async ([zd, vrstvy]) => {
    zdrojove[zd] = await zdrojovaDlazdice(zd, z, x, y, vrstvy);
  }));
  const tZdroj = performance.now();
  const idx = postavIndex(z, zdrojove, defs, 1 / mNaPx);
  const tIdx = performance.now();
  // kandidáti
  const K = { lon: [], lat: [], px: [], py: [], ik: [], k: [], z0: [], sv: [], id: [], lic: [] };
  // engine 342: `lic` = lichá buňka jemné mřížky (jen z15) – ta v dlaždicích z14 chybí
  const pridej = (lon, lat, px, py, ik, k, z0, sv, id, lic) => {
    K.lon.push(lon); K.lat.push(lat); K.px.push(px); K.py.push(py); K.ik.push(idxRetezce(ik));
    K.k.push(k); K.z0.push(z0); K.sv.push(sv); K.id.push(id); K.lic.push(lic ? 1 : 0);
  };
  const vPx = (lon, lat) => [(mercX(lon) * n - x) * EXT, (mercY(lat) * n - y) * EXT];
  for (const [druh, cfg] of druhy) {
    const jemne = z >= Z_MAX || !cfg.zjemnit;          // všechny buňky
    const dLat = cfg.rozestup / 111320;
    const iy0 = Math.floor(south / dLat) - 1, iy1 = Math.ceil(north / dLat) + 1;
    for (let iy = iy0; iy <= iy1; iy++) {
      if (!jemne && (iy & 1)) continue;
      const latR = iy * dLat;
      const dLon = cfg.rozestup / (111320 * Math.cos(latR * Math.PI / 180));
      const ix0 = Math.floor(west / dLon) - 1, ix1 = Math.ceil(east / dLon) + 1;
      for (let ix = ix0; ix <= ix1; ix++) {
        if (!jemne && (ix & 1)) continue;
        if (hash(ix, iy, 7) > cfg.hustota) continue;
        const lon = (ix + 0.2 + hash(ix, iy, 1) * 0.6) * dLon;
        const lat = (iy + 0.2 + hash(ix, iy, 2) * 0.6) * dLat;
        if (lon < west || lon >= east || lat <= south || lat > north) continue;   // bod patří jen jedné dlaždici
        const [px, py] = vPx(lon, lat);
        const q = plochyPod(idx, px, py);
        if (!cfg.naVode && q.indexOf('voda') >= 0) continue;
        if (druh !== 'svetlo' && (q.indexOf('budovy-vypln') >= 0 || naCare(idx, px, py))) continue;
        let uvnitr = false;
        for (let vi = 0; vi < cfg.vrstvy.length; vi++) { if (q.indexOf(cfg.vrstvy[vi]) >= 0) { uvnitr = true; break; } }
        if (!uvnitr) continue;
        let ikony = cfg.ikony;
        if (druh === 'strom') {
          if (q.indexOf('les-jehlicnaty') >= 0) ikony = N.jehlicnate;
          else if (q.indexOf('les-listnaty') >= 0 || q.indexOf('sad') >= 0) ikony = N.listnate;
        }
        const ikona = ikony[Math.floor(hash(ix, iy, 3) * ikony.length)];
        // engine 340: `cfg.sv` = kotvy animací (ryba 4); jinak světla 1 a světlušky 2
        const sv = cfg.sv || (druh === 'svetlo' ? 1 : (druh === 'svetluska' ? 2 : 0));
        // ⭐ engine 341 (výtka T: „žbluňknutí na řece lezou i na louku“): u kotvy
        // ryby DOSAH VODY – největší poloměr (m), na kterém je voda do 8 směrů;
        // kroužek ho nesmí přerůst. Pod 2 m (úzký potok) kotva nevznikne.
        let kRyba = cfg.k;
        if (sv === 4) {
          const pxNaM = 1 / mNaPx;
          let dosah = 0;
          for (const d of [2, 3, 4.5, 6, 8, 10, 13]) {
            let vse = true;
            for (let a = 0; a < 8 && vse; a++) {
              const q2 = plochyPod(idx, px + Math.cos(a * 0.7854) * d * pxNaM, py + Math.sin(a * 0.7854) * d * pxNaM);
              if (q2.indexOf('voda') < 0) vse = false;
            }
            if (!vse) break;
            dosah = d;
          }
          if (dosah < 2) continue;
          kRyba = dosah;
        }
        const id = sv ? ((ix * 92821 + iy * 31397 + sv * 7451) >>> 0) : 0;
        pridej(lon, lat, px, py, ikona, sv === 4 ? kRyba : cfg.k, cfg.z0, sv, id,
               z >= Z_MAX && cfg.zjemnit && ((ix & 1) || (iy & 1)));
      }
    }
  }
  // ⭐ engine 340 (animace nad mapou): KOMÍNY pro kouř – těžiště domů velikosti
  // rodinného domu (40–450 m², celý obrys v dlaždici), ~35 % podle hashe
  // polohy (stejný výběr na všech úrovních). Nekreslí se: sv:3 jde přes mlhu do
  // evidence, kouř kreslí animace.js.
  if (z === Z_MAX) {
    const dB = defs.find((d) => d.id === 'budovy-vypln');
    const zdB = dB && zdrojove[dB.zdroj];
    const vBud = zdB && zdB.vrstvy[dB.vrstva];
    if (vBud) {
      const kB = EXT / vBud.extent;
      const m2NaPx2 = mNaPx * mNaPx;
      let komnu = 0;
      // ⛔ budovy jsou v dlaždicích SLOUČENÉ do pár multipolygonů (5 prvků =
      // stovky domů) → každý VNĚJŠÍ prstenec (kladná plocha, MVT v2) je dům
      for (const f of vBud.prvky) {
        if (komnu >= 400) break;
        if (f.typ !== 3 || !dB.fn(f.vl, f.typ)) continue;
        for (const r of geomPrvku(vBud, f)) {
          if (komnu >= 400) break;
          let a = 0, cx = 0, cy = 0, venku = false;
          for (let i = 0; i < r.length; i += 2) {
            const x0 = r[i] * kB * zdB.m + zdB.ox, y0 = r[i + 1] * kB * zdB.m + zdB.oy;
            if (x0 < 0 || x0 > EXT || y0 < 0 || y0 > EXT) { venku = true; break; }
            const j = (i + 2) % r.length;
            const x1 = r[j] * kB * zdB.m + zdB.ox, y1 = r[j + 1] * kB * zdB.m + zdB.oy;
            const c = x0 * y1 - x1 * y0;
            a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
          }
          if (venku || a <= 1e-6) continue;          // díra (záporná) nebo mimo dlaždici
          const plocha = (a / 2) * m2NaPx2;
          if (plocha < 40 || plocha > 450) continue;
          const px = cx / (3 * a), py = cy / (3 * a);
          const lon = lonZ((x + px / EXT) / n), lat = latZ((y + py / EXT) / n);
          const ha = Math.round(lon * 1e5), hb = Math.round(lat * 1e5);
          if (hash(ha, hb, 11) > 0.35) continue;
          pridej(lon, lat, px, py, 'svetluska-zare', 0, 15.2, 3, ((ha * 92821 + hb * 31397 + 3 * 7451) >>> 0));
          komnu++;
        }
      }
    }
  }
  // ⭐ přesné dekorace ze ZABAGED (osamělé stromy, lesíky, balvany; aleje
  // od z14) – totéž jako presneDekorace v dekorace.js
  if (presne && zdrojove.krajina) {
    const zk = zdrojove.krajina;
    const volno = (px, py) => {
      const q = plochyPod(idx, px, py);
      return q.indexOf('budovy-vypln') < 0 && !naCare(idx, px, py);
    };
    const listnaty = (a, b) => N.listnate[Math.floor(hash(a, b, 5) * N.listnate.length)];
    const vB = zk.vrstvy.body;
    let pocet = 0;
    if (vB) {
      const k = EXT / vB.extent;
      for (const f of vB.prvky) {
        if (pocet >= 600) break;
        const t = f.vl.t;
        if (t !== 'strom' && t !== 'balvan') continue;
        for (const c of geomPrvku(vB, f)) {
          const px = c[0] * k * zk.m + zk.ox, py = c[1] * k * zk.m + zk.oy;
          if (px < 0 || px >= EXT || py < 0 || py >= EXT) continue;
          if (!volno(px, py)) continue;
          const lon = lonZ((x + px / EXT) / n), lat = latZ((y + py / EXT) / n);
          const a = Math.round(lon * 1e5), b = Math.round(lat * 1e5);
          pocet++;
          if (t === 'balvan') { pridej(lon, lat, px, py, 'deko-kamen-' + (1 + Math.floor(hash(a, b, 6) * 3)), 0.4, 14.2, 0, 0); continue; }
          const lesik = f.vl.s === 'L';
          pridej(lon, lat, px, py, listnaty(a, b), lesik ? 1.0 : 1.15, 12.8, 0, 0);
          if (lesik) {
            const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 111320;
            for (const [dx, dy, kk, sa, sb] of [[9, 4, 0.95, 1, 0], [-7, 8, 0.9, 0, 1]]) {
              const lon2 = lon + dx / kx, lat2 = lat + dy / ky;
              const [qx, qy] = vPx(lon2, lat2);
              pridej(lon2, lat2, qx, qy, listnaty(a + sa, b + sb), kk, 12.8, 0, 0);
            }
          }
        }
      }
    }
    const vC = zk.vrstvy.cary;
    if (z >= 14 && vC) {
      // aleje po 13 m, dedup 8m buňkou; od z14 (dřív od z14,6 kvůli počtu –
      // nastoupí rampou jako stromy, práh 14,25)
      const kE = EXT / vC.extent;
      const vid = new Set();
      const mPx = mNaPx;
      for (const f of vC.prvky) {
        if (pocet >= 1200) break;
        if (f.vl.t !== 'stromoradi' || f.typ !== 2) continue;
        for (const cast of geomPrvku(vC, f)) {
          let zbytek = 13 / 2;
          for (let j = 2; j < cast.length; j += 2) {
            const ax = cast[j - 2] * kE * zk.m + zk.ox, ay = cast[j - 1] * kE * zk.m + zk.oy;
            const bx = cast[j] * kE * zk.m + zk.ox, by = cast[j + 1] * kE * zk.m + zk.oy;
            const delka = Math.hypot(bx - ax, by - ay) * mPx;
            // přepočet na metry jako presneDekorace: cos šířky ZAČÁTKU úseku
            const kxUseku = 111320 * Math.cos(latZ((y + ay / EXT) / n) * Math.PI / 180);
            if (delka < 0.01) continue;
            let sD = zbytek;
            while (sD <= delka) {
              const px = ax + (bx - ax) * sD / delka, py = ay + (by - ay) * sD / delka;
              sD += 13;
              if (px < 0 || px >= EXT || py < 0 || py >= EXT) continue;
              const lon = lonZ((x + px / EXT) / n), lat = latZ((y + py / EXT) / n);
              const gx = Math.floor(lon * kxUseku / 8), gy = Math.floor(lat * 111320 / 8);
              const kk = gx + ':' + gy;
              if (vid.has(kk)) continue;
              vid.add(kk);
              if (!volno(px, py)) continue;
              pridej(lon, lat, px, py, listnaty(gx, gy), 0.85, 14.25, 0, 0);
              pocet++;
            }
            zbytek = sD - delka;
          }
        }
      }
    }
  }
  const pocetK = K.lon.length;
  const tKand = performance.now();
  const vysl = {
    z, x, y, n: pocetK,
    lon: Float64Array.from(K.lon), lat: Float64Array.from(K.lat),
    px: Float32Array.from(K.px), py: Float32Array.from(K.py),
    ik: Uint16Array.from(K.ik), k: Float32Array.from(K.k), z0: Float32Array.from(K.z0),
    sv: Uint8Array.from(K.sv), id: Uint32Array.from(K.id), lic: Uint8Array.from(K.lic),
    ev: new Float32Array(pocetK), maska: null,
  };
  // výška terénu → velikost (vyskovyFaktor: 1 ve 400 m, ±1 % na 30 m)
  await doplnVysku(vysl, demP);
  const tKon = performance.now();
  zapisCas('gen', tKon - t0);
  casy.rozpad.push([z, Math.round(tZdroj - t0), Math.round(tIdx - tZdroj), Math.round(tKand - tIdx), Math.round(tKon - tKand), pocetK]);
  if (casy.rozpad.length > 16) casy.rozpad.shift();
  return vysl;
}

// ---------------------------------------------------------------------------
// Dotazy na hlavní vlákno (mlha, výška)
// ---------------------------------------------------------------------------
function dotaz(zprava, prenos) {
  return new Promise((res) => {
    const id = ++dotazId;
    dotazy.set(id, res);
    zprava.id = id;
    self.postMessage(zprava, prenos || []);
  });
}
function demDlazdice(z, x, y) {
  const k = z + '/' + x + '/' + y;
  let p = demKes.get(k);
  if (!p) {
    p = dotaz({ typ: 'dem', z, x, y }).then((m) => (m && m.data) ? new Float32Array(m.data) : null);
    demKes.set(k, p);
    while (demKes.size > 24) demKes.delete(demKes.keys().next().value);
  }
  return p;
}
async function doplnVysku(v, demP) {
  if (!v.n) return;
  const zD = Math.min(12, v.z), d = v.z - zD;
  const dx = v.x >> d, dy = v.y >> d;
  let dem = null;
  try { dem = await demP; } catch (e) { dem = null; }
  if (!dem || dem.length < 65536) return;
  const nD = Math.pow(2, zD);
  for (let i = 0; i < v.n; i++) {
    const gx = Math.floor((mercX(v.lon[i]) * nD - dx) * 256), gy = Math.floor((mercY(v.lat[i]) * nD - dy) * 256);
    if (gx < 0 || gy < 0 || gx > 255 || gy > 255) continue;
    const h = dem[gy * 256 + gx];
    if (!isFinite(h) || h < -1000) continue;
    v.ev[i] = +Math.max(0.9, Math.min(1.35, 1 + (h * N.ex - 400) / 3000)).toFixed(3);
  }
}
/// maska mlhy pro body, které ji ještě nemají jistou (1 = objeveno, navěky)
const objevenoKes = new Set();      // 'lon,lat' objevených bodů (mlha jen roste)
async function doplnMlhu(v) {
  if (!v.n) { v.maska = new Uint8Array(0); return false; }
  if (!v.maska) v.maska = new Uint8Array(v.n);
  const kde = [];
  for (let i = 0; i < v.n; i++) {
    if (v.maska[i]) continue;
    if (objevenoKes.has(v.lon[i] + ',' + v.lat[i])) { v.maska[i] = 1; continue; }
    kde.push(i);
  }
  if (!kde.length) return false;
  const t0 = performance.now();
  let zmena = false;
  // ⚠️ po 400 bodech: jeObjeveno stojí na TT ~20 µs/bod a hlavní vlákno
  // nesmí dostat dlouhou úlohu
  for (let a = 0; a < kde.length; a += 400) {
    const cast = kde.slice(a, a + 400);
    const body = new Float64Array(cast.length * 2);
    for (let j = 0; j < cast.length; j++) { body[2 * j] = v.lon[cast[j]]; body[2 * j + 1] = v.lat[cast[j]]; }
    const m = await dotaz({ typ: 'mlha', body }, [body.buffer]);
    const maska = m && m.maska ? new Uint8Array(m.maska) : null;
    if (!maska) continue;
    for (let j = 0; j < cast.length; j++) {
      if (!maska[j]) continue;
      const i = cast[j];
      v.maska[i] = 1; zmena = true;
      objevenoKes.add(v.lon[i] + ',' + v.lat[i]);
    }
  }
  if (objevenoKes.size > 200000) objevenoKes.clear();
  zapisCas('mlha', performance.now() - t0);
  return zmena;
}
// ---------------------------------------------------------------------------
// Výstup: MVT (jen kreslené dekorace) + evidence (světla, kotvy roje, stromy)
// ---------------------------------------------------------------------------
const oKes = new Map();
function nastup(z0) {
  let o = oKes.get(z0);
  if (!o) {
    o = N.rampa.map((z) => Math.max(0, Math.min(1, (z - z0) / N.sirkaNastupu)));
    oKes.set(z0, o);
  }
  return o;
}
/// ⭐ engine 342 (výtka T: „při oddálení mizí stromy“): dlaždice z15 nesou celou jemnou
/// mřížku, z14 jen sudé buňky – při oddálení pod z15 zmizely 3/4 stromů NARÁZ a u hranice
/// (zoom se s terénem kolébe ±0,2) blikaly i při posunu. Liché buňky proto mezi zoomem
/// 15,45 a 15,0 plynule zeslábnou: o9 (zoom 15,0) = 0, o10 (15,45) = běžná hodnota,
/// a pod 15,0 mají 0 i na zarážkách rampy (z15 dlaždice jako záskok při oddálení).
/// Zarážky 15,0/15,45 jsou v ZOOMU MAPY (pevné, hranice dlaždic), rampa je posunutá
/// o dohled → hodnota pro zarážku = nástup v základním zoomu (zoom + dz).
const oKesX = new Map();
function nastupX(z0) {
  let o = oKesX.get(z0);
  if (!o) {
    const w = N.sirkaNastupu, dz = N.dz || 0;
    o = [15.0, 15.45].map((z) => Math.max(0, Math.min(1, (z + dz - z0) / w)));
    oKesX.set(z0, o);
  }
  return o;
}
function vystupDlazdice(v) {
  const body = [];
  const sv = [], stromy = [];
  for (let i = 0; i < v.n; i++) {
    if (!v.maska[i]) continue;
    const ik = retezce[v.ik[i]];
    if (v.sv[i]) {
      // engine 341: `r` = u ryb dosah vody (m), jinak velikost druhu
      sv.push({ id: v.id[i], sv: v.sv[i], ik, lon: v.lon[i], lat: v.lat[i], r: v.k[i] });
      continue;
    }
    const o = nastup(v.z0[i]);
    const vl = { ik, k: v.k[i], rot: 0 };
    if (v.ev[i]) vl.ev = v.ev[i];
    const lic = v.lic && v.lic[i];
    const dzV = N.dz || 0;
    for (let j = 0; j < o.length; j++) vl['o' + (j + 1)] = (lic && N.rampa[j] - dzV < 15.0) ? 0 : o[j];
    const ox = nastupX(v.z0[i]);
    vl.o9 = lic ? 0 : ox[0];
    vl.o10 = ox[1];
    if (lic) vl.l = 1;
    const px = Math.max(0, Math.min(EXT - 1, Math.round(v.px[i]))), py = Math.max(0, Math.min(EXT - 1, Math.round(v.py[i])));
    body.push({ px, py, vl });
    if ((ik.startsWith('deko-strom') || ik.startsWith('deko-ker')) && v.k[i] >= 0.3) stromy.push(i);
  }
  // stromy pro stíny v typových polích
  const m = stromy.length;
  const S = { lon: new Float64Array(m), lat: new Float64Array(m), ik: [], k: new Float32Array(m),
              ev: new Float32Array(m), z0: new Float32Array(m), lic: new Uint8Array(m) };
  for (let j = 0; j < m; j++) {
    const i = stromy[j];
    S.lon[j] = v.lon[i]; S.lat[j] = v.lat[i]; S.ik.push(retezce[v.ik[i]]);
    S.k[j] = v.k[i]; S.ev[j] = v.ev[i]; S.z0[j] = v.z0[i]; S.lic[j] = v.lic ? v.lic[i] : 0;
  }
  return { data: zakodujMVT(body), ev: { sv, stromy: S, prvku: body.length } };
}

async function vyridDlazdici(m) {
  const klic = m.z + '/' + m.x + '/' + m.y;
  posledniPozadavek.set(klic, performance.now());
  if (!N || !N.herni || m.z < Z_MIN || m.z > Z_MAX) {
    self.postMessage({ typ: 'dlazdice', id: m.id, data: new ArrayBuffer(0), ev: null });
    return;
  }
  const kfg = cfgKlic;
  let v = vystup.get(klic);
  if (v && v.cfg !== kfg) v = null;
  if (!v) {
    v = await generuj(m.z, m.x, m.y);
    v.cfg = kfg;
    await doplnMlhu(v);
    if (kfg !== cfgKlic) {             // mezitím nová konfigurace – nekešovat
      const o = vystupDlazdice(v);
      self.postMessage({ typ: 'dlazdice', id: m.id, data: o.data, ev: o.ev }, [o.data]);
      return;
    }
    vystup.set(klic, v);
    while (vystup.size > KES_VYSTUP) vystup.delete(vystup.keys().next().value);
  } else {
    vystup.delete(klic); vystup.set(klic, v);   // LRU
    if (!v.maska || v.mlhaStara) { v.mlhaStara = false; await doplnMlhu(v); }
  }
  const o = vystupDlazdice(v);
  self.postMessage({ typ: 'dlazdice', id: m.id, data: o.data, ev: o.ev }, [o.data]);
}

/// Odkrytí mlhy: dlaždice žádané v poslední době se neobjevenými body se
/// přeptají; kde něco přibylo, pošle se seznam k obnovení (refreshTiles).
let mlhaBezi = false, mlhaZnovu = false;
async function zmenaMlhy() {
  if (mlhaBezi) { mlhaZnovu = true; return; }
  mlhaBezi = true;
  try {
    do {
      mlhaZnovu = false;
      const ted = performance.now();
      const obnov = [];
      for (const [klic, v] of vystup) {
        const t = posledniPozadavek.get(klic) || 0;
        if (ted - t > 120000) { v.mlhaStara = true; continue; }   // mimo obraz – přeptá se při příští žádosti
        if (!v.maska) continue;
        let neobjeveno = false;
        for (let i = 0; i < v.n; i++) if (!v.maska[i]) { neobjeveno = true; break; }
        if (!neobjeveno) continue;
        if (await doplnMlhu(v)) obnov.push({ z: v.z, x: v.x, y: v.y });
      }
      if (obnov.length) self.postMessage({ typ: 'obnov', dlazdice: obnov });
    } while (mlhaZnovu);
  } finally { mlhaBezi = false; }
}

/// Ladění: proč (ne)vznikla dekorace u bodu – plochy, silnice, mlha, kandidát (z15)
async function diagnostika(lon, lat) {
  const z = Z_MAX, n = Math.pow(2, z);
  const x = Math.floor(mercX(lon) * n), y = Math.floor(mercY(lat) * n);
  const defs = defsProUroven(z);
  const potreba = new Map();
  for (const d of defs) { if (!potreba.has(d.zdroj)) potreba.set(d.zdroj, new Set()); potreba.get(d.zdroj).add(d.vrstva); }
  const zdrojove = {};
  for (const [zd, vr] of potreba) zdrojove[zd] = await zdrojovaDlazdice(zd, z, x, y, vr);
  const latStred = (latZ(y / n) + latZ((y + 1) / n)) / 2;
  const mNaPx = 40075016.686 * Math.cos(latStred * Math.PI / 180) / (n * EXT);
  const idx = postavIndex(z, zdrojove, defs, 1 / mNaPx);
  const px = (mercX(lon) * n - x) * EXT, py = (mercY(lat) * n - y) * EXT;
  const v = vystup.get(z + '/' + x + '/' + y);
  let nej = -1, nd = 1e9;
  if (v) for (let i = 0; i < v.n; i++) { const d = Math.hypot((v.lon[i] - lon) * 71000, (v.lat[i] - lat) * 111320); if (d < nd) { nd = d; nej = i; } }
  return { dlazdice: z + '/' + x + '/' + y, plochy: plochyPod(idx, px, py), naCare: naCare(idx, px, py),
           kandidat: nej >= 0 ? { m: +nd.toFixed(2), ik: retezce[v.ik[nej]], maska: v.maska ? v.maska[nej] : null } : null,
           defs: defs.map((d) => d.id) };
}

// ---------------------------------------------------------------------------
self.onmessage = (ev) => {
  const m = ev.data || {};
  if (m.typ === 'mlha' || m.typ === 'dem') {
    const res = dotazy.get(m.id);
    if (res) { dotazy.delete(m.id); res(m); }
    return;
  }
  if (m.typ === 'dlazdice') {
    vyridDlazdici(m).catch((e) => {
      self.postMessage({ typ: 'dlazdice', id: m.id, data: null, chyba: String((e && e.message) || e) });
    });
    return;
  }
  if (m.typ === 'nastav') {
    try {
      const plochy = m.plochy.map((d) => Object.assign({}, d, { fn: prelozFiltr(d.filtr) }));
      const noveZdroje = JSON.stringify(m.zdroje) !== JSON.stringify(N && N.zdroje);
      N = Object.assign({}, m, { plochy });
      vrstvyZdroju = new Map();
      for (const d of plochy) {
        if (!vrstvyZdroju.has(d.zdroj)) vrstvyZdroju.set(d.zdroj, new Set());
        vrstvyZdroju.get(d.zdroj).add(d.vrstva);
      }
      if (!vrstvyZdroju.has('krajina')) vrstvyZdroju.set('krajina', new Set());
      vrstvyZdroju.get('krajina').add('body');
      vrstvyZdroju.get('krajina').add('cary');
      zdrojDl.clear();
      cfgKlic = JSON.stringify([m.verze, m.sezona, m.dz, m.ex, m.herni, m.zdroje, m.plochy, Object.keys(m.druhy)]);
      oKes.clear();
      if (noveZdroje) { archivy.clear(); zdrojDl.clear(); }
      self.postMessage({ typ: 'nastaveno', ok: true });
    } catch (e) {
      self.postMessage({ typ: 'chyba', msg: 'nastav: ' + String((e && e.message) || e) });
    }
    return;
  }
  if (m.typ === 'mlha-zmena') {
    if (m.o === null) {                  // reset mlhy: generování platí dál, masky znovu
      objevenoKes.clear();
      for (const v of vystup.values()) { v.maska = null; v.mlhaStara = false; }
      return;
    }
    zmenaMlhy().catch(() => {});
    return;
  }
  if (m.typ === 'diag') {
    diagnostika(m.lon, m.lat).then((d) => self.postMessage(Object.assign({ typ: 'stav', id: m.id }, d)))
      .catch((e) => self.postMessage({ typ: 'stav', id: m.id, chyba: String(e && e.message || e) }));
    return;
  }
  if (m.typ === 'stav') {
    self.postMessage({ typ: 'stav', id: m.id, vystup: vystup.size, zdroj: zdrojDl.size, casy });
  }
};
