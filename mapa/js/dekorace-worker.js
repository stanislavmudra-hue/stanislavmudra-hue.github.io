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
// ⭐ engine 343 (výtka T 23. 9.: „proč neukazuješ stále všechny stromy? Působí to zvláštně,
// když něco mizí a zase se objevuje“): plná jemná mřížka už od z14 (dřív jen z15 – pod z15
// zmizely 3/4 stromů a u hranice je při posunu kolébal zoom terénu). Ztenčení na sudé
// buňky až v z13 (strom má tam ~8 px) s plynulým přechodem z14,45 → z14,0.
const Z_PLNE = 14;
const KES_VYSTUP = 200;             // vygenerovaných dlaždic v paměti (~100 kB kus); engine 355: 120 → 200 (předgenerování)
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
      let typ = 0; const vl = {}; let g0 = 0, g1 = 0, id = null;
      while (p.pos < kf) {
        const t3 = cVarint(p), f3 = t3 >> 3, w3 = t3 & 7;
        if (f3 === 1 && w3 === 0) id = cVarint(p);                   // engine 357: id prvku
        else if (f3 === 2 && w3 === 2) {
          const n = cVarint(p), ke = p.pos + n;
          while (p.pos < ke) { const ki = cVarint(p), vi = cVarint(p); vl[klice[ki]] = hodnoty[vi]; }
        } else if (f3 === 3 && w3 === 0) typ = cVarint(p);
        else if (f3 === 4 && w3 === 2) { const n = cVarint(p); g0 = p.pos; g1 = p.pos + n; p.pos = g1; }
        else preskoc(p, w3);
      }
      prvky.push({ typ, vl, g0, g1, geom: null, id });
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
/// engine 354: bod komínu UVNITŘ půdorysu (V = [x0,y0,x1,y1,…] v souřadnicích dlaždice) s odstupem
/// `min` od všech hran: těžiště, jinak středy hran (od nejdelší) posunuté o 2–4 m dovnitř; nic → null
function bodNaStrese(V, cx, cy, min) {
  const n = V.length / 2;
  const uvnitr = (px, py) => {
    let u = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = V[2 * i], yi = V[2 * i + 1], xj = V[2 * j], yj = V[2 * j + 1];
      if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) u = !u;
    }
    return u;
  };
  const odstup = (px, py) => {
    let d = Infinity;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = V[2 * i], ay = V[2 * i + 1], bx = V[2 * j], by = V[2 * j + 1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      d = Math.min(d, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
    }
    return d;
  };
  if (uvnitr(cx, cy) && odstup(cx, cy) >= min) return [cx, cy];
  const hrany = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    hrany.push([Math.hypot(V[2 * j] - V[2 * i], V[2 * j + 1] - V[2 * i + 1]), i, j]);
  }
  hrany.sort((p, q) => q[0] - p[0]);
  for (const [l, i, j] of hrany) {
    if (!l) continue;
    const mx = (V[2 * i] + V[2 * j]) / 2, my = (V[2 * i + 1] + V[2 * j + 1]) / 2;
    const nx = -(V[2 * j + 1] - V[2 * i + 1]) / l, ny = (V[2 * j] - V[2 * i]) / l;
    for (const k of [2.5, 4]) {
      for (const s of [1, -1]) {
        const qx = mx + s * nx * k * min, qy = my + s * ny * k * min;
        if (uvnitr(qx, qy) && odstup(qx, qy) >= min) return [qx, qy];
      }
    }
  }
  return null;
}
/// ⭐ engine 354: komíny → vrstva 'k' (mnohoúhelníky pro fill-extrusion): tělo (b..h) a širší hlava
/// (c = 1). Čtverec natočený podle domu (uh), MVT v2: vnější prstenec po směru hodinových ručiček
/// v souřadnicích dlaždice (y dolů) = kladná plocha. Rozsah vrstvy 8192 (MapLibre si každou vrstvu
/// přepočítá na svých 8192) – při 4096 na z15 (~0,19 m) zaokrouhlení deformovalo komín i hlavu.
const KOMIN_S = 0.45, KOMIN_HLAVA_S = 0.56, KOMIN_NAD = 1.5, KOMIN_HLAVA = 0.22, KOMIN_EXT = 8192;
function vrstvaKominu(kominy) {
  const vr = new Zapis(kominy.length * 96 + 64);
  vr.tVarint(15, 2);
  vr.tText(1, 'k');
  const hodn = [], hIdx = new Map();
  const hi = (v) => {
    const k = 'n' + v;
    let i = hIdx.get(k);
    if (i === undefined) { i = hodn.length; hodn.push(v); hIdx.set(k, i); }
    return i;
  };
  const fz = new Zapis(64);
  const kx = KOMIN_EXT / EXT;
  const prvek = (cx0, cy0, s0, uh, tagy) => {
    const cx = cx0 * kx, cy = cy0 * kx, s = s0 * kx;
    const c = Math.cos(uh), sn = Math.sin(uh);
    const r = [[-s, -s], [s, -s], [s, s], [-s, s]]
      .map(([u, w]) => [Math.round(cx + u * c - w * sn), Math.round(cy + u * sn + w * c)]);
    const g = [9, zzZ(r[0][0]), zzZ(r[0][1]), 26];                     // MoveTo(1), LineTo(3)
    for (let j = 1; j < 4; j++) g.push(zzZ(r[j][0] - r[j - 1][0]), zzZ(r[j][1] - r[j - 1][1]));
    g.push(15);                                                         // ClosePath
    fz.p = 0;
    fz.tPacked(2, tagy);
    fz.tVarint(3, 3);                                                   // POLYGON
    fz.tPacked(4, g);
    vr.tZprava(2, fz);
  };
  for (const km of kominy) {
    const vrch = +(km.H + KOMIN_NAD).toFixed(2);
    prvek(km.px, km.py, KOMIN_S / km.mpx, km.uh, [0, hi(vrch), 1, hi(+(km.H - 1).toFixed(2))]);
    prvek(km.px, km.py, KOMIN_HLAVA_S / km.mpx, km.uh,
          [0, hi(+(vrch + 0.05).toFixed(2)), 1, hi(+(vrch - KOMIN_HLAVA).toFixed(2)), 2, hi(1)]);
  }
  for (const k of ['h', 'b', 'c']) vr.tText(3, k);
  const hz = new Zapis(32);
  for (const v of hodn) {
    hz.p = 0;
    if (Number.isInteger(v) && v >= 0) hz.tVarint(5, v);
    else hz.tDouble(3, v);
    vr.tZprava(4, hz);
  }
  vr.tVarint(5, KOMIN_EXT);
  return vr;
}
/// body → MVT (vrstva 'd', body v souřadnicích 0..4095) + engine 354: komíny (vrstva 'k')
function zakodujMVT(body, kominy) {
  if (!body.length && !(kominy && kominy.length)) return new ArrayBuffer(0);
  const dl = new Zapis(64);
  if (body.length) dl.tZprava(3, vrstvaBodu(body));
  if (kominy && kominy.length) dl.tZprava(3, vrstvaKominu(kominy));
  return dl.b.slice(0, dl.p).buffer;
}
function vrstvaBodu(body) {
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
  return vr;
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
            useky.push({ ax, ay, bx, by, w, c: f.vl.class,           // engine 359: třída (led jen na zpevněných)
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
    if (cfg.mesice && N.mesic && cfg.mesice.indexOf(N.mesic) < 0) continue;     // engine 363: sezónní drobnosti
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
  // ⭐ engine 349: drobnosti z OSM (archiv `drobnosti`, vrstva body, jen z14) do dlaždic z14 a z15;
  // engine 350: + lampy z dat měst (archiv `lampymesta`)
  if (z >= 14 && N.zdroje.drobnosti && N.drobnosti) potreba.set('drobnosti', new Set(['body']));
  if (z >= 14 && N.zdroje.lampymesta && N.drobnosti) potreba.set('lampymesta', new Set(['body']));
  if (z >= 14 && N.zdroje.dtmbody && N.drobnosti) potreba.set('dtmbody', new Set(['body']));   // engine 356
  if (z === 15 && N.zdroje.dtmbody && N.ploty) potreba.set('dtmbody', new Set(['body', 'cary']));   // engine 358
  // engine 357: elektrické vedení – ZABAGED od z12 (větrníky; stožáry a rozpětí v archivu od z13), OSM od z14
  if (z >= 12 && N.zdroje.vedenizab && N.vedeni) potreba.set('vedenizab', new Set(['s', 'r', 'w']));
  if (z >= 14 && N.zdroje.vedeniosm && N.vedeni) potreba.set('vedeniosm', new Set(['s', 'r']));
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
  const K = { lon: [], lat: [], px: [], py: [], ik: [], k: [], z0: [], sv: [], id: [], lic: [], uh: [] };
  // engine 342/343: `lic` = lichá buňka jemné mřížky v dlaždici z14 – v dlaždicích z13 chybí
  // engine 354: `uh` = natočení komínu podle domu (rad, souřadnice dlaždice)
  const pridej = (lon, lat, px, py, ik, k, z0, sv, id, lic, uh) => {
    K.lon.push(lon); K.lat.push(lat); K.px.push(px); K.py.push(py); K.ik.push(idxRetezce(ik));
    K.k.push(k); K.z0.push(z0); K.sv.push(sv); K.id.push(id); K.lic.push(lic ? 1 : 0); K.uh.push(uh || 0);
  };
  const vPx = (lon, lat) => [(mercX(lon) * n - x) * EXT, (mercY(lat) * n - y) * EXT];
  for (const [druh, cfg] of druhy) {
    const jemne = z >= Z_PLNE || !cfg.zjemnit;         // všechny buňky (engine 343: od z14)
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
        if (cfg.ikonyMesic && cfg.ikonyMesic[N.mesic]) ikony = cfg.ikonyMesic[N.mesic];   // engine 363 (lekníny v květnu jen listy)
        // ⭐ engine 363: lekníny jen U BŘEHU – voda do všech 8 směrů aspoň 1,5 m, ale ne dál než ~9 m od souše
        if (cfg.uBrehu) {
          const pxNaM = 1 / mNaPx;
          let dosah = 0;
          for (const d of [1.5, 2.5, 4, 6, 9]) {
            let vse = true;
            for (let a = 0; a < 8 && vse; a++) {
              const q2 = plochyPod(idx, px + Math.cos(a * 0.7854) * d * pxNaM, py + Math.sin(a * 0.7854) * d * pxNaM);
              if (q2.indexOf('voda') < 0) vse = false;
            }
            if (!vse) break;
            dosah = d;
          }
          if (dosah < 1.5 || dosah >= 9) continue;
        }
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
               z === Z_PLNE && cfg.zjemnit && ((ix & 1) || (iy & 1)));
      }
    }
  }
  // ⭐ engine 340 (animace nad mapou): KOMÍNY pro kouř – těžiště domů velikosti
  // rodinného domu (40–450 m², celý obrys v dlaždici), ~35 % podle hashe
  // polohy (stejný výběr na všech úrovních). Nekreslí se: sv:3 jde přes mlhu do
  // evidence, kouř kreslí animace.js.
  // ⭐ engine 354 (T 24. 9.: „ten kouř nad domy působí zvláštně, když nemají komíny“): kotva u KAŽDÉHO
  // rodinného domu = komín na střeše (vrstva 'k' dlaždice, viz vrstvaKominu); `k` = výška domu
  // (render_height, jinak 6 m) se znaménkem: kladná = z komínu se kouří (~35 % jako dřív), záporná
  // = komín bez kouře; `uh` = směr nejdelší hrany domu.
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
        if (komnu >= 1500) break;
        if (f.typ !== 3 || !dB.fn(f.vl, f.typ)) continue;
        const vyskaDomu = Math.max(3, Math.min(15, +(f.vl && f.vl.render_height) || 6));
        for (const r of geomPrvku(vBud, f)) {
          if (komnu >= 1500) break;
          let a = 0, cx = 0, cy = 0, venku = false, hrana = 0, uh = 0;
          const V = [];                              // engine 354: vrcholy (bod komínu uvnitř půdorysu)
          for (let i = 0; i < r.length; i += 2) {
            const x0 = r[i] * kB * zdB.m + zdB.ox, y0 = r[i + 1] * kB * zdB.m + zdB.oy;
            if (x0 < 0 || x0 > EXT || y0 < 0 || y0 > EXT) { venku = true; break; }
            V.push(x0, y0);
            const j = (i + 2) % r.length;
            const x1 = r[j] * kB * zdB.m + zdB.ox, y1 = r[j + 1] * kB * zdB.m + zdB.oy;
            const c = x0 * y1 - x1 * y0;
            a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
            const d2 = (x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0);
            if (d2 > hrana) { hrana = d2; uh = Math.atan2(y1 - y0, x1 - x0); }
          }
          if (venku || a <= 1e-6) continue;          // díra (záporná) nebo mimo dlaždici
          const plocha = (a / 2) * m2NaPx2;
          if (plocha < 40 || plocha > 450) continue;
          // ⛔ engine 354: těžiště domu do L / U leží mimo střechu (komín visel nad dvorkem) → bod
          // uvnitř půdorysu aspoň 1 m od okraje, jinak dům bez komínu
          const bod = bodNaStrese(V, cx / (3 * a), cy / (3 * a), 1.0 / mNaPx);
          if (!bod) continue;
          const px = bod[0], py = bod[1];
          const lon = lonZ((x + px / EXT) / n), lat = latZ((y + py / EXT) / n);
          const ha = Math.round(lon * 1e5), hb = Math.round(lat * 1e5);
          const kouri = hash(ha, hb, 11) <= 0.35;
          pridej(lon, lat, px, py, 'svetluska-zare', kouri ? vyskaDomu : -vyskaDomu, 15.2, 3,
                 ((ha * 92821 + hb * 31397 + 3 * 7451) >>> 0), false, uh);
          komnu++;
        }
      }
    }
  }
  // engine 350: buňky pro vyřazení dvojníků (stromy ZABAGED × OSM, lampy měst × OSM)
  const kxM = 111320 * Math.cos(latStred * Math.PI / 180);
  const bunkaM = (lon, lat, m) => Math.floor(lon * kxM / m) + ':' + Math.floor(lat * 111320 / m);
  const blizkoBunky = (mn, lon, lat, m) => {
    if (!mn.size) return false;
    const gx = Math.floor(lon * kxM / m), gy = Math.floor(lat * 111320 / m);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (mn.has((gx + a) + ':' + (gy + b))) return true;
    return false;
  };
  const zabStromy = new Set();
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
          zabStromy.add(bunkaM(lon, lat, 6));                              // engine 350
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
  // ⭐ engine 349 (přání T 23. 9.: „lampy, posedy, krmelce, lavičky, studny a poštovní schránky“):
  // DROBNOSTI SE ZNÁMOU POLOHOU z OpenStreetMap – stojí přesně tam, kde jsou (žádná mřížka ani
  // kontrola ploch), velikost ±8 % podle hashe polohy. Lampa má navíc noční svit (sv 5 → evidence,
  // hlavní vlákno ho kreslí vrstvou `dekorace-lampy`, jen v noci) se STEJNÝM k jako kresba.
  // ⭐ engine 350: + LAMPY Z OTEVŘENÝCH DAT MĚST (Brno, Plzeň, Děčín – archiv `lampymesta`, zvlášť od
  // ODbL); OSM lampa do 15 m od městské se vynechá (táž lampa). + STROMY z OSM (natural=tree, `j` =
  // jehličnatý) – dvojník stromu ZABAGED do 6 m se vynechá; ikony jako u stromů ZABAGED.
  if (z >= 14 && N.drobnosti && (zdrojove.drobnosti || zdrojove.lampymesta || zdrojove.dtmbody)) {
    const mestske = new Set();          // buňky 15 m s lampou z dat města
    // engine 356: buňky 20 m s OSM studnou / křížem / pomníkem – dvojník z DTM se nekreslí
    const osmBunky = { studna: new Set(), kriz: new Set(), pomnik: new Set() };
    const KONTROLA_OSM = { studna: 'studna', x_studna: 'studna', x_kriz: 'kriz', x_pomnik: 'pomnik' };
    let pocetD = 0;
    const zpracuj = (zd, osm) => {
      const vD = zd && zd.vrstvy.body;
      if (!vD) return;
      const kD = EXT / vD.extent;
      for (const f of vD.prvky) {
        if (pocetD >= 4000) break;
        const kontrola = osm && KONTROLA_OSM[f.vl.t];
        if (kontrola) {
          for (const c of geomPrvku(vD, f)) {
            const qx = c[0] * kD * zd.m + zd.ox, qy = c[1] * kD * zd.m + zd.oy;
            osmBunky[kontrola].add(bunkaM(lonZ((x + qx / EXT) / n), latZ((y + qy / EXT) / n), 20));
          }
        }
        const cfg = N.drobnosti[f.vl.t];
        if (!cfg) continue;
        for (const c of geomPrvku(vD, f)) {
          const px = c[0] * kD * zd.m + zd.ox, py = c[1] * kD * zd.m + zd.oy;
          if (px < 0 || px >= EXT || py < 0 || py >= EXT) continue;
          const lon = lonZ((x + px / EXT) / n), lat = latZ((y + py / EXT) / n);
          const a = Math.round(lon * 1e6), b = Math.round(lat * 1e6);
          if (cfg.sv) {
            if (osm && blizkoBunky(mestske, lon, lat, 15)) continue;      // lampu už má město
            if (!osm) mestske.add(bunkaM(lon, lat, 15));
          }
          if (cfg.strom) {
            if (blizkoBunky(zabStromy, lon, lat, 6)) continue;             // týž strom ze ZABAGED
            const ik = f.vl.j ? N.jehlicnate : N.listnate;
            pridej(lon, lat, px, py, ik[Math.floor(hash(a, b, 13) * ik.length)], cfg.k * (0.85 + hash(a, b, 14) * 0.3), cfg.z0, 0, 0);
            pocetD++;
            continue;
          }
          const kk = cfg.k * (0.92 + hash(a, b, 14) * 0.16);
          if (cfg.ikony.length) pridej(lon, lat, px, py, cfg.ikony[Math.floor(hash(a, b, 13) * cfg.ikony.length)], kk, cfg.z0, 0, 0);
          // engine 352: `zare` smí být seznam (semafor: červená / zelená podle hashe polohy)
          const zare = Array.isArray(cfg.zare) ? cfg.zare[Math.floor(hash(a, b, 15) * cfg.zare.length)] : cfg.zare;
          if (cfg.sv) pridej(lon, lat, px, py, zare, kk, cfg.z0, cfg.sv, ((a * 92821 + b * 31397 + cfg.sv * 7451) >>> 0));
          pocetD++;
        }
      }
    };
    zpracuj(zdrojove.lampymesta, false);
    zpracuj(zdrojove.drobnosti, true);
    // ⭐ engine 356: BODY DTM ČR (veřejná ZPS) – studny, kříže a boží muka, pomníky; jen kde je OSM nemá (buňky 20 m
    // se sousedy). Velikost ±8 % podle hashe polohy jako ostatní drobnosti.
    const zdD = zdrojove.dtmbody;
    const vDt = zdD && zdD.vrstvy.body;
    if (vDt) {
      // typ DTM → [druh kresby, sada OSM pro vyřazení dvojníka]
      const DRUH_DTM = { studna: ['studna_dtm', 'studna'], sakralni: ['kriz', 'kriz'], kulturni: ['pomnik', 'pomnik'] };
      const kDt = EXT / vDt.extent;
      for (const f of vDt.prvky) {
        if (pocetD >= 4000) break;
        const dr = DRUH_DTM[f.vl.t];
        const cfg = dr && N.drobnosti[dr[0]];
        if (!cfg || !cfg.ikony || !cfg.ikony.length) continue;
        for (const c of geomPrvku(vDt, f)) {
          const px = c[0] * kDt * zdD.m + zdD.ox, py = c[1] * kDt * zdD.m + zdD.oy;
          if (px < 0 || px >= EXT || py < 0 || py >= EXT) continue;
          const lon = lonZ((x + px / EXT) / n), lat = latZ((y + py / EXT) / n);
          if (blizkoBunky(osmBunky[dr[1]], lon, lat, 20)) continue;
          // uvnitř půdorysu budovy = kaplička / studna v domku – stavbu už kreslí 3D budova (TT Rtyně: kříž v kapli)
          if (plochyPod(idx, px, py).indexOf('budovy-vypln') >= 0) continue;
          const a = Math.round(lon * 1e6), b = Math.round(lat * 1e6);
          const kk = cfg.k * (0.92 + hash(a, b, 14) * 0.16);
          pridej(lon, lat, px, py, cfg.ikony[Math.floor(hash(a, b, 13) * cfg.ikony.length)], kk, cfg.z0, 0, 0);
          pocetD++;
        }
      }
    }
  }
  // ⭐⭐ engine 357 (T 24. 9.: „udělej … i to vedení a stožáry atd.“): ELEKTRICKÉ VEDENÍ. Podpěry (stožáry VVN,
  // sloupy VN a NN, podpěry lanovek) a větrné elektrárny jako kresbičky ve skutečné výšce (měřítko světa jako
  // stromy); rozpětí vodičů a vrtule větrníků do evidence dlaždice (dráty kreslí 3D vrstva vedeni3d.js, listy
  // animace.js). Mlha jako u všeho.
  // DVOJNÍCI OSM × ZABAGED (tatáž linka v obou zdrojích) – vyhrává PODROBNĚJŠÍ: ⛔ prohlížeč 24. 9. (Kryštofovy
  // Hamry): ZABAGED měl VN linku zjednodušenou (rozpětí 130–250 m, vrcholy jen v lomech), OSM tutéž se sloupy po
  // 65 m. Rozpětí ZABAGED, podél kterého stojí podpěra OSM (VN+, ≤ 6 m od linky, > 15 m od obou konců), je
  // HRUBÉ → jeho drát nahradí rozpětí OSM. Jinak se OSM podél linky ZABAGED (vzorky ¼, ½, ¾ do 10 m) zahodí.
  // Podpěra OSM do 12 m (NN 6 m) od podpěry ZABAGED je tatáž → kreslí se ZABAGED a konce OSM rozpětí se na ni
  // PŘICHYTÍ (drát končí na kresbičce). OSM rozpětí NN > 120 m a VN > 350 m = linka kreslená bez sloupů → pryč.
  // Obě zdrojové dlaždice se čtou CELÉ (i za hranou výstupní) – jinak na hranách unikali dvojníci.
  if (N.vedeni && (zdrojove.vedenizab || zdrojove.vedeniosm)) {
    const V = N.vedeni;
    K.draty = []; K.vrtule = [];
    let pocetV = 0;
    const MR = 40, MB = 12;
    const nacti = (zd) => {
      const out = { s: [], r: [] };
      if (!zd) return out;
      const vs = zd.vrstvy.s, vr = zd.vrstvy.r;
      if (vs) {
        const kS = EXT / vs.extent;
        for (const f of vs.prvky) {
          const t = +f.vl.t;
          if (!V.tridy[t]) continue;
          for (const c of geomPrvku(vs, f)) {
            const px = c[0] * kS * zd.m + zd.ox, py = c[1] * kS * zd.m + zd.oy;
            const lon = lonZ((x + px / EXT) / n), lat = latZ((y + py / EXT) / n);
            out.s.push({ t, lon, lat, px, py, h: +f.vl.h || 0, X: lon * kxM, Y: lat * 111320,
                         uvnitr: px >= 0 && px < EXT && py >= 0 && py < EXT });
          }
        }
      }
      if (vr) {
        const kR = EXT / vr.extent;
        for (const f of vr.prvky) {
          const t = +f.vl.t;
          if (!V.tridy[t]) continue;
          const a = +f.vl.a, b = +f.vl.b, cc = +f.vl.c, d = +f.vl.d;
          if (!isFinite(a) || !isFinite(b) || !isFinite(cc) || !isFinite(d)) continue;
          for (const g of geomPrvku(vr, f)) {
            const px = g[0] * kR * zd.m + zd.ox, py = g[1] * kR * zd.m + zd.oy;
            out.r.push({ t, a, b, c: cc, d, ha: +f.vl.ha || 0, hb: +f.vl.hb || 0, px, py,
                         u: [a * kxM, b * 111320, cc * kxM, d * 111320],
                         uvnitr: px >= 0 && px < EXT && py >= 0 && py < EXT });
          }
        }
      }
      return out;
    };
    const Zv = nacti(zdrojove.vedenizab), Ov = nacti(zdrojove.vedeniosm);
    // mřížky: rozpětí ZABAGED po 40 m, podpěry ZABAGED po 12 m (metry: lon·kxM, lat·111320)
    const segZ = new Map(), podZ = new Map();
    for (const r of Zv.r) {
      const u = r.u;
      const gx0 = Math.floor(Math.min(u[0], u[2]) / MR), gx1 = Math.floor(Math.max(u[0], u[2]) / MR);
      const gy0 = Math.floor(Math.min(u[1], u[3]) / MR), gy1 = Math.floor(Math.max(u[1], u[3]) / MR);
      if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > 400) continue;
      for (let gx = gx0; gx <= gx1; gx++) for (let gy = gy0; gy <= gy1; gy++) {
        const k = gx + ':' + gy;
        let l = segZ.get(k);
        if (!l) { l = []; segZ.set(k, l); }
        l.push(r);
      }
    }
    for (const q of Zv.s) {
      const k = Math.floor(q.X / MB) + ':' + Math.floor(q.Y / MB);
      let l = podZ.get(k);
      if (!l) { l = []; podZ.set(k, l); }
      l.push(q);
    }
    const bodNaUsek = (px, py, u) => {
      const dx = u[2] - u[0], dy = u[3] - u[1], l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - u[0]) * dx + (py - u[1]) * dy) / l2)) : 0;
      return Math.hypot(px - (u[0] + t * dx), py - (u[1] + t * dy));
    };
    const kolemUseku = (px, py, m, fn) => {               // všechna rozpětí ZABAGED do m metrů
      const gx = Math.floor(px / MR), gy = Math.floor(py / MR);
      const vid = new Set();
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const l = segZ.get((gx + a) + ':' + (gy + b));
        if (l) for (const r of l) if (!vid.has(r)) { vid.add(r); const dd = bodNaUsek(px, py, r.u); if (dd <= m) fn(r, dd); }
      }
    };
    const nejblizsiUsek = (px, py, m) => { let nej = null, nd = Infinity; kolemUseku(px, py, m, (r, dd) => { if (dd < nd) { nd = dd; nej = r; } }); return nej; };
    const blizkaPodpera = (px, py, m) => {                // nejbližší podpěra ZABAGED do m (≤ 12) metrů
      const gx = Math.floor(px / MB), gy = Math.floor(py / MB);
      let nej = null, nd = m;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const l = podZ.get((gx + a) + ':' + (gy + b));
        if (l) for (const q of l) { const dd = Math.hypot(q.X - px, q.Y - py); if (dd <= nd) { nd = dd; nej = q; } }
      }
      return nej;
    };
    if (Ov.s.length || Ov.r.length) {
      // 1) hrubá rozpětí ZABAGED: podpěra OSM (VN+) podél nich, dál než 15 m od obou konců
      for (const q of Ov.s) {
        if (q.t < 1) continue;
        kolemUseku(q.X, q.Y, 6, (r) => {
          if (Math.hypot(q.X - r.u[0], q.Y - r.u[1]) > 15 && Math.hypot(q.X - r.u[2], q.Y - r.u[3]) > 15) r.hrube = true;
        });
      }
      // 2) podpěry OSM: tatáž jako ZABAGED, nebo na (podrobné) lince ZABAGED → pryč
      for (const q of Ov.s) {
        if (blizkaPodpera(q.X, q.Y, q.t === 0 ? 6 : MB)) { q.pryc = true; continue; }
        const r = nejblizsiUsek(q.X, q.Y, 6);
        if (r && !r.hrube) q.pryc = true;
      }
      // 3) rozpětí OSM: podél podrobné linky ZABAGED → pryč; konce u podpěr ZABAGED → přichytit
      const MAX_OSM = [120, 350];
      for (const r of Ov.r) {
        const u = r.u;
        if ([0.25, 0.5, 0.75].every((f) => {
          const z0 = nejblizsiUsek(u[0] + (u[2] - u[0]) * f, u[1] + (u[3] - u[1]) * f, 10);
          return z0 && !z0.hrube;
        })) { r.pryc = true; continue; }
        if (r.t <= 1 && Math.hypot(u[2] - u[0], u[3] - u[1]) > MAX_OSM[r.t]) { r.pryc = true; continue; }
        const zA = blizkaPodpera(u[0], u[1], MB), zB = blizkaPodpera(u[2], u[3], MB);
        if (zA) { r.a = zA.lon; r.b = zA.lat; if (zA.h) r.ha = zA.h; }
        if (zB) { r.c = zB.lon; r.d = zB.lat; if (zB.h) r.hb = zB.h; }
      }
    }
    const kresliV = (src) => {
      for (const q of src.s) {
        if (!q.uvnitr || q.pryc) continue;
        const cfg = V.tridy[q.t];
        if (z < cfg.zMin) continue;
        const h = Math.max(4, Math.min(90, q.h || cfg.h));
        pridej(q.lon, q.lat, q.px, q.py, cfg.ikona, h / (cfg.H * 0.1167), cfg.z0, 0, 0);
        if (++pocetV > 6000) return;
      }
      for (const r of src.r) {
        if (!r.uvnitr || r.pryc || r.hrube) continue;                  // rozpětí patří dlaždici se středem
        const cfg = V.tridy[r.t];
        if (z < cfg.zMin) continue;
        const i = K.lon.length;
        pridej(lonZ((x + r.px / EXT) / n), latZ((y + r.py / EXT) / n), r.px, r.py, '', 0, 0, 7, 0);
        K.draty.push({ i, a: r.a, b: r.b, c: r.c, d: r.d, ha: r.ha || cfg.h, hb: r.hb || cfg.h, t: r.t });
      }
    };
    kresliV(Zv);
    kresliV(Ov);
    const zw = zdrojove.vedenizab, vw = zw && zw.vrstvy.w;
    if (vw) {
      const kW = EXT / vw.extent;
      for (const f of vw.prvky) {
        for (const c of geomPrvku(vw, f)) {
          const px = c[0] * kW * zw.m + zw.ox, py = c[1] * kW * zw.m + zw.oy;
          if (px < 0 || px >= EXT || py < 0 || py >= EXT) continue;
          const lon = lonZ((x + px / EXT) / n), lat = latZ((y + py / EXT) / n);
          const h = Math.max(40, Math.min(200, +f.vl.h || 120));
          const cfg = V.vetrnik;
          pridej(lon, lat, px, py, cfg.ikona, h / (cfg.H * 0.1167 * cfg.podilVezeH), cfg.z0, 0, 0);
          const i = K.lon.length;
          pridej(lon, lat, px, py, '', 0, 0, 8, 0);
          K.vrtule.push({ i, lon, lat, h });
        }
      }
    }
  }
  // ⭐ engine 358 (T 24. 9.: „Ty ploty jsem myslel, že budou ve 3D.“): PLOTY A ZDI DTM ve 3D – úseky s výškou terénu
  let ploty = null, voda = null, zem = null, cesty = null;
  if (z === 15 && N.ploty) {
    let dem13 = null;
    try { dem13 = await demDlazdice(13, x >> 2, y >> 2); } catch (e) { dem13 = null; }
    if (zdrojove.dtmbody && zdrojove.dtmbody.vrstvy && zdrojove.dtmbody.vrstvy.cary) ploty = plotyZDlazdice(zdrojove.dtmbody, x, y, dem13);
    voda = mistaVPlochach(idx, x, y, dem13, ODL_VODA_IDS, 7, 6000, 71);   // engine 358: místa odlesků na hladinách
    zem = mistaVPlochach(idx, x, y, dem13, ODL_ZEM_IDS, 12, 5000, 81);     // engine 359: sníh, jinovatka
    cesty = mistaNaCestach(idx, x, y, dem13, 9, 3000);                     // engine 359: led na silnicích
    if (ploty || voda || zem || cesty) {              // jedna mřížka mlhy pro vše
      const obj = new Uint8Array(PLOT_BUNEK * PLOT_BUNEK);
      for (const Q of [ploty, voda, zem, cesty]) if (Q) Q.obj = obj;
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
    uh: Float32Array.from(K.uh), mpx: mNaPx,           // engine 354: komíny (natočení, m na jednotku)
    draty: K.draty || null, vrtule: K.vrtule || null,  // engine 357: rozpětí vodičů a vrtule větrníků
    ploty,                                             // engine 358: 3D ploty (úseky + buňky mlhy)
    voda, zem, cesty,                                  // engine 358–359: místa odlesků (voda, sníh/jinovatka, led)
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
// ⭐ engine 358: 3D PLOTY Z ČAR DTM ČR
// ---------------------------------------------------------------------------
// T 24. 9. 2026: „Ty ploty jsem myslel, že budou ve 3D.“ Čáry DTM (vrstva `cary`: plot s druhem `d`, zeď, zábradlí,
// svodidlo, protihluková stěna) se v dlaždici z15 ořežou na dlaždici, rozdělí po ≤ 8 m (sledují terén) a každý vrchol
// dostane výšku z DEM z13 – TÉHOŽ, ze kterého MapLibre staví terén (maxzoom 13, bilineárně jako shader terénu:
// pixel i = poloha i/256). Kreslí je ploty3d.js (vlastní 3D vrstva). Kód: 0 drátěný (i neurčený/jiný), 1 dřevěný,
// 2 kovový, 3 zděný, 4 živý plot, 5 zeď, 6 zábradlí, 7 svodidlo, 8 protihluková stěna (DruhPlotu DTM: 1 dřevěný,
// 2 drátěný, 3 kovový, 4 zděný, 5 živý, 98 jiný, 99 nezjištěno). Úsek: [fx0, fy0, e0, fx1, fy1, e1, s0, kod] ve
// zlomcích dlaždice (Float32 stačí) a metrech; s0 = poloha začátku na přímce úseku v GLOBÁLNÍCH metrech mod 20 m –
// sloupky na sebe navazují i přes hranu dlaždice (všechny rozestupy vzoru dělí 20 m). Mlha po buňkách 24 × 24 (~33 m).
const PLOT_DRUH = { 1: 1, 2: 0, 3: 2, 4: 3, 5: 4 };
const PLOT_TYP = { zed: 5, zabradli: 6, svodidlo: 7, protihluk: 8 };
const PLOT_BUNEK = 24, PLOT_KROK_M = 8, PLOT_MAX = 40000;
const PLOT_C_REF = 40075016.686 * Math.cos(50 * Math.PI / 180);   // globální metry vzoru (±2 % v ČR nevadí)
/// výška terénu (m, bez převýšení) ve zlomku (fx, fy) dlaždice z15 x/y z DEM z13 – bilineárně jako shader terénu
function vyskaDem13(dem, x, y, fx, fy) {
  if (!dem) return NaN;
  const u = ((x + fx) / 4 - (x >> 2)) * 256, w = ((y + fy) / 4 - (y >> 2)) * 256;
  const i0 = Math.max(0, Math.min(255, Math.floor(u))), j0 = Math.max(0, Math.min(255, Math.floor(w)));
  const i1 = Math.min(255, i0 + 1), j1 = Math.min(255, j0 + 1);
  const a = Math.max(0, Math.min(1, u - i0)), b = Math.max(0, Math.min(1, w - j0));
  const e00 = dem[j0 * 256 + i0], e10 = dem[j0 * 256 + i1], e01 = dem[j1 * 256 + i0], e11 = dem[j1 * 256 + i1];
  if (!(e00 > -500 && e10 > -500 && e01 > -500 && e11 > -500)) return NaN;
  return (e00 * (1 - a) + e10 * a) * (1 - b) + (e01 * (1 - a) + e11 * a) * b;
}
// ⭐ engine 358 (T 24. 9.: „šly by dodělat na různé kovové části a na vodu efekt 2D Additive Blending (Aditivní míchání
// a záře)? Odlesky.“ → „Ty odlesky taky uděláš jako stíny? Aby se nemusely dopočítávat.“): MÍSTA ODLESKŮ NA VODĚ se
// spočítají JEDNOU S DLAŽDICÍ z15 (jako stíny): mřížka ~7 m s rozptylem, jen uvnitř ploch `voda` indexu dlaždice,
// výška z DEM z13. Animace (animace.js) z nich jen vybírá, kde se podle slunce a kamery zablýskne. [fx, fy, e]…
// engine 359 (T: „Tyto odlesky budou v zimě i na sněhu a případně na silnici a podobně, pokud bude −°C“): stejná místa
// i na OTEVŘENÉ ZEMI (pole, louky, zahrady, sady, parky – sníh a jinovatka, ~12 m) a na ZPEVNĚNÝCH SILNICÍCH (led, ~9 m,
// v šířce vozovky). Počasí worker nezná – místa jsou vždy, animace je použije jen za sněhu/mrazu.
const ODL_VODA_IDS = new Set(['voda']);
const ODL_ZEM_IDS = new Set(['pole', 'louka', 'zahrada', 'sad', 'park', 'zelen']);
const ODL_CESTY_TRIDY = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'busway']);
function mistaVPlochach(idx, x, y, dem, ids, krokM, max, sul) {
  const pol = new Set();
  for (const b of idx.mrizka) if (b) for (const p of b) if (ids.has(p.id)) pol.add(p);
  for (const p of idx.velke) if (ids.has(p.id)) pol.add(p);
  if (!pol.size || !dem) return null;
  const nZ = 32768;
  const latS = latZ((y + 0.5) / nZ);
  const mNaPxT = 40075016.686 * Math.cos(latS * Math.PI / 180) / (nZ * EXT);
  const krok = krokM / mNaPxT;
  const G = Math.ceil(EXT / krok);
  const vzate = new Uint8Array(G * G);
  const bod = [], bunka = [];
  for (const p of pol) {
    const gx0 = Math.max(0, Math.floor(p.x0 / krok)), gx1 = Math.min(G - 1, Math.floor(p.x1 / krok));
    const gy0 = Math.max(0, Math.floor(p.y0 / krok)), gy1 = Math.min(G - 1, Math.floor(p.y1 / krok));
    for (let gy = gy0; gy <= gy1 && bod.length < max * 3; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const i = gy * G + gx;
        if (vzate[i]) continue;
        const px = (gx + 0.5 + (hash(gx, gy, sul) - 0.5) * 0.8) * krok, py = (gy + 0.5 + (hash(gx, gy, sul + 1) - 0.5) * 0.8) * krok;
        if (px < 0 || px >= EXT || py < 0 || py >= EXT || !vBodu(p, px, py)) continue;
        vzate[i] = 1;
        const fx = px / EXT, fy = py / EXT, e = vyskaDem13(dem, x, y, fx, fy);
        if (!isFinite(e)) continue;
        bod.push(fx, fy, e);
        bunka.push(Math.min(PLOT_BUNEK - 1, Math.floor(fy * PLOT_BUNEK)) * PLOT_BUNEK + Math.min(PLOT_BUNEK - 1, Math.floor(fx * PLOT_BUNEK)));
      }
    }
  }
  if (!bod.length) return null;
  return { bod: Float32Array.from(bod), bunka: Uint16Array.from(bunka), n: bunka.length, obj: null, x, y };
}
function mistaNaCestach(idx, x, y, dem, krokM, max) {
  if (!dem || !idx.mrizkaCar) return null;
  const useky = new Set();
  for (const b of idx.mrizkaCar) if (b) for (const u of b) if (ODL_CESTY_TRIDY.has(u.c)) useky.add(u);
  if (!useky.size) return null;
  const nZ = 32768;
  const latS = latZ((y + 0.5) / nZ);
  const mNaPxT = 40075016.686 * Math.cos(latS * Math.PI / 180) / (nZ * EXT);
  const krok = krokM / mNaPxT;
  const bod = [], bunka = [];
  let j = 0;
  for (const u of useky) {
    const dx = u.bx - u.ax, dy = u.by - u.ay, L = Math.hypot(dx, dy);
    if (L < 1) continue;
    const nx = -dy / L, ny = dx / L;
    const kroku = Math.max(1, Math.round(L / krok));
    for (let k = 0; k < kroku && bod.length < max * 3; k++) {
      j++;
      const t = (k + 0.5 + (hash(j, kroku, 91) - 0.5) * 0.6) / kroku;
      const bok = (hash(j, kroku, 92) - 0.5) * 0.8 * u.w;
      const px = u.ax + dx * t + nx * bok, py = u.ay + dy * t + ny * bok;
      if (px < 0 || px >= EXT || py < 0 || py >= EXT) continue;
      const fx = px / EXT, fy = py / EXT, e = vyskaDem13(dem, x, y, fx, fy);
      if (!isFinite(e)) continue;
      bod.push(fx, fy, e);
      bunka.push(Math.min(PLOT_BUNEK - 1, Math.floor(fy * PLOT_BUNEK)) * PLOT_BUNEK + Math.min(PLOT_BUNEK - 1, Math.floor(fx * PLOT_BUNEK)));
    }
  }
  if (!bod.length) return null;
  return { bod: Float32Array.from(bod), bunka: Uint16Array.from(bunka), n: bunka.length, obj: null, x, y };
}
function plotyZDlazdice(zd, x, y, dem) {
  const v = zd.vrstvy.cary;
  if (!v || !v.prvky.length) return null;
  const kS = EXT / v.extent;
  const nZ = 32768;
  const latS = latZ((y + 0.5) / nZ);
  const mNaFr = 40075016.686 * Math.cos(latS * Math.PI / 180) / nZ;       // metrů na zlomek dlaždice
  const vyska = (fx, fy) => vyskaDem13(dem, x, y, fx, fy);
  const orez = (x0, y0, x1, y1) => {                // Liang–Barsky na [0,1]²
    let t0 = 0, t1 = 1;
    const dx = x1 - x0, dy = y1 - y0;
    const p = [-dx, dx, -dy, dy], q = [x0, 1 - x0, y0, 1 - y0];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return null; continue; }
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return t1 > t0 ? [t0, t1] : null;
  };
  const seg = new Float32Array(PLOT_MAX * 8), bunka = new Uint16Array(PLOT_MAX);
  let n = 0;
  for (const f of v.prvky) {
    if (f.typ !== 2) continue;
    const t = f.vl.t;
    let kod;
    if (t === 'plot') { const d = PLOT_DRUH[+f.vl.d]; kod = d === undefined ? 0 : d; }
    else { kod = PLOT_TYP[t]; if (kod === undefined) continue; }        // vjezd a spol. zůstávají ploché
    for (const r of geomPrvku(v, f)) {
      const m = r.length >> 1;
      for (let i = 0; i + 1 < m; i++) {
        const ax = (r[2 * i] * kS * zd.m + zd.ox) / EXT, ay = (r[2 * i + 1] * kS * zd.m + zd.oy) / EXT;
        const bx = (r[2 * i + 2] * kS * zd.m + zd.ox) / EXT, by = (r[2 * i + 3] * kS * zd.m + zd.oy) / EXT;
        const o = orez(ax, ay, bx, by);
        if (!o) continue;
        const Lcel = Math.hypot(bx - ax, by - ay) * mNaFr;
        if (Lcel < 0.05) continue;
        // globální přímka úseku: s = (P · směr) v metrech, mod 20 (návaznost vzoru přes hrany dlaždic)
        const ux = (bx - ax) / (Math.hypot(bx - ax, by - ay) || 1), uy = (by - ay) / (Math.hypot(bx - ax, by - ay) || 1);
        const sA = (((x + ax) * ux + (y + ay) * uy) / nZ) * PLOT_C_REF;
        const L = Lcel * (o[1] - o[0]);
        const kroku = Math.max(1, Math.ceil(L / PLOT_KROK_M));
        let px = ax + (bx - ax) * o[0], py = ay + (by - ay) * o[0], pe = vyska(px, py);
        let ps = sA + Lcel * o[0] * (PLOT_C_REF / (mNaFr * nZ));
        for (let k = 1; k <= kroku; k++) {
          const tt = o[0] + (o[1] - o[0]) * k / kroku;
          const qx = ax + (bx - ax) * tt, qy = ay + (by - ay) * tt, qe = vyska(qx, qy);
          if (isFinite(pe) && isFinite(qe) && n < PLOT_MAX) {
            const j = n * 8;
            seg[j] = px; seg[j + 1] = py; seg[j + 2] = pe; seg[j + 3] = qx; seg[j + 4] = qy; seg[j + 5] = qe;
            seg[j + 6] = ((ps % 20) + 20) % 20; seg[j + 7] = kod;
            const mx = Math.min(PLOT_BUNEK - 1, Math.max(0, Math.floor((px + qx) * 0.5 * PLOT_BUNEK)));
            const my = Math.min(PLOT_BUNEK - 1, Math.max(0, Math.floor((py + qy) * 0.5 * PLOT_BUNEK)));
            bunka[n] = my * PLOT_BUNEK + mx;
            n++;
          }
          ps += (L / kroku) * (PLOT_C_REF / (mNaFr * nZ));
          px = qx; py = qy; pe = qe;
        }
      }
    }
  }
  if (!n) return null;
  return { seg: seg.slice(0, n * 8), bunka: bunka.slice(0, n), n, obj: null, x, y };
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
async function doplnMlhuPlotu(v) {
  const P = v.ploty || v.voda || v.zem || v.cesty;   // všechny sdílí mřížku mlhy (obj, x, y)
  if (!P || !P.obj) return false;
  const G = PLOT_BUNEK, nZ = 32768;
  const pouzite = new Set();
  for (const Q of [v.ploty, v.voda, v.zem, v.cesty]) {
    if (!Q) continue;
    for (let i = 0; i < Q.n; i++) if (!P.obj[Q.bunka[i]]) pouzite.add(Q.bunka[i]);
  }
  if (!pouzite.size) return false;
  const bunky = [...pouzite];
  const lon = new Float64Array(bunky.length), lat = new Float64Array(bunky.length);
  const kde = [];
  for (let j = 0; j < bunky.length; j++) {
    const b = bunky[j], bx = b % G, by = (b / G) | 0;
    lon[j] = lonZ((P.x + (bx + 0.5) / G) / nZ); lat[j] = latZ((P.y + (by + 0.5) / G) / nZ);
    if (objevenoKes.has(lon[j] + ',' + lat[j])) { P.obj[b] = 1; continue; }
    kde.push(j);
  }
  let zmena = false;
  for (let a = 0; a < kde.length; a += 400) {
    const cast = kde.slice(a, a + 400);
    const body = new Float64Array(cast.length * 2);
    for (let j = 0; j < cast.length; j++) { body[2 * j] = lon[cast[j]]; body[2 * j + 1] = lat[cast[j]]; }
    const m = await dotaz({ typ: 'mlha', body }, [body.buffer]);
    const maska = m && m.maska ? new Uint8Array(m.maska) : null;
    if (!maska) continue;
    for (let j = 0; j < cast.length; j++) {
      if (!maska[j]) continue;
      const jj = cast[j];
      P.obj[bunky[jj]] = 1; zmena = true;
      objevenoKes.add(lon[jj] + ',' + lat[jj]);
    }
  }
  return zmena;
}
async function doplnMlhu(v) {
  if (v.ploty || v.voda || v.zem || v.cesty) await doplnMlhuPlotu(v);   // engine 358–359
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
/// ⭐ engine 343: plná mřížka už od z14 → totéž o úroveň níž (14,45 → 14,0).
/// Zarážky 15,0/15,45 jsou v ZOOMU MAPY (pevné, hranice dlaždic), rampa je posunutá
/// o dohled → hodnota pro zarážku = nástup v základním zoomu (zoom + dz).
/// ⭐ engine 349: zarážky rampy NAD z15,65 (o11–o14: 16,0 / 16,35 / 16,7 / 17,05) – drobnosti
/// (lavičky, schránky, studny) nastupují až zblízka; posílají se jen prvkům, které do z15,65
/// nejsou plně vidět (ostatní v hlavním vlákně spadnou přes coalesce na o8)
const oKesV = new Map();
function nastupVys(z0) {
  let o = oKesV.get(z0);
  if (!o) {
    o = (N.rampaVys || []).map((z) => Math.max(0, Math.min(1, (z - z0) / N.sirkaNastupu)));
    oKesV.set(z0, o);
  }
  return o;
}
const oKesX = new Map();
function nastupX(z0) {
  let o = oKesX.get(z0);
  if (!o) {
    const w = N.sirkaNastupu, dz = N.dz || 0;
    o = [14.0, 14.45].map((z) => Math.max(0, Math.min(1, (z + dz - z0) / w)));
    oKesX.set(z0, o);
  }
  return o;
}
function vystupDlazdice(v) {
  const body = [];
  const sv = [], stromy = [];
  const kominy = [];                  // engine 354
  for (let i = 0; i < v.n; i++) {
    if (!v.maska[i]) continue;
    const ik = retezce[v.ik[i]];
    if (v.sv[i]) {
      if (v.sv[i] === 7 || v.sv[i] === 8) continue;   // engine 357: dráty a vrtule jdou zvlášť (níž)
      // engine 341: `r` = u ryb dosah vody (m), jinak velikost druhu
      sv.push({ id: v.id[i], sv: v.sv[i], ik, lon: v.lon[i], lat: v.lat[i], r: v.k[i] });
      // engine 354: komín na střeše (jen odkryté – maska mlhy platí i tady)
      if (v.sv[i] === 3 && v.mpx) {
        kominy.push({ px: v.px[i], py: v.py[i], uh: v.uh ? v.uh[i] : 0, H: Math.abs(v.k[i]), mpx: v.mpx });
      }
      continue;
    }
    const o = nastup(v.z0[i]);
    const vl = { ik, k: v.k[i], rot: 0 };
    if (v.ev[i]) vl.ev = v.ev[i];
    const lic = v.lic && v.lic[i];
    const dzV = N.dz || 0;
    for (let j = 0; j < o.length; j++) vl['o' + (j + 1)] = (lic && N.rampa[j] - dzV < 14.0) ? 0 : o[j];
    const ox = nastupX(v.z0[i]);
    vl.o9 = lic ? 0 : ox[0];
    vl.o10 = ox[1];
    if (N.rampaVys && v.z0[i] + N.sirkaNastupu > N.rampa[N.rampa.length - 1]) {
      const ov = nastupVys(v.z0[i]);
      for (let j = 0; j < ov.length; j++) vl['o' + (11 + j)] = ov[j];
    }
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
  // engine 357: rozpětí vodičů [a,b,c,d,ha,hb,t]… a vrtule [lon,lat,h]… – jen odkryté (maska mlhy středu)
  let draty = null, vrtule = null;
  if (v.draty && v.draty.length) {
    const o = [];
    for (const q of v.draty) if (v.maska[q.i]) o.push(q.a, q.b, q.c, q.d, q.ha, q.hb, q.t);
    if (o.length) draty = Float64Array.from(o);
  }
  if (v.vrtule && v.vrtule.length) {
    const o = [];
    for (const q of v.vrtule) if (v.maska[q.i]) o.push(q.lon, q.lat, q.h);
    if (o.length) vrtule = Float64Array.from(o);
  }
  // engine 358: 3D ploty – úseky v odkrytých buňkách (null = dlaždice bez plotů; z15)
  let ploty = null;
  if (v.ploty) {
    const P = v.ploty;
    let k = 0;
    for (let i = 0; i < P.n; i++) if (P.obj[P.bunka[i]]) k++;
    if (k) {
      ploty = new Float32Array(k * 8);
      let o = 0;
      for (let i = 0; i < P.n; i++) {
        if (!P.obj[P.bunka[i]]) continue;
        ploty.set(P.seg.subarray(i * 8, i * 8 + 8), o);
        o += 8;
      }
    }
  }
  // engine 358: místa odlesků na vodě v odkrytých buňkách [fx, fy, e]… (null = bez vody; z15)
  const odkryta = (Q) => {
    if (!Q || !Q.obj) return null;
    const o = [];
    for (let i = 0; i < Q.n; i++) if (Q.obj[Q.bunka[i]]) o.push(Q.bod[3 * i], Q.bod[3 * i + 1], Q.bod[3 * i + 2]);
    return o.length ? Float32Array.from(o) : null;
  };
  const voda = odkryta(v.voda), zem = odkryta(v.zem), cesty = odkryta(v.cesty);    // engine 359: + sníh/jinovatka, led
  return { data: zakodujMVT(body, kominy), ev: { sv, stromy: S, prvku: body.length, draty, vrtule, ploty, voda, zem, cesty } };
}

/// engine 357: vygenerovaná dlaždice dekorací (keš, jinak vyrobit + maska mlhy) – pro stíny stromů
async function ziskejVystup(z, x, y) {
  if (!N || !N.herni || z < Z_MIN || z > Z_MAX) return null;
  const klic = z + '/' + x + '/' + y;
  const kfg = cfgKlic;
  let v = vystup.get(klic);
  if (v && v.cfg !== kfg) v = null;
  if (!v) {
    v = await generuj(z, x, y);
    v.cfg = kfg;
    await doplnMlhu(v);
    if (kfg !== cfgKlic) return v;
    if (!vystup.has(klic)) {
      vystup.set(klic, v);
      while (vystup.size > KES_VYSTUP) vystup.delete(vystup.keys().next().value);
    } else v = vystup.get(klic);
  } else if (!v.maska || v.mlhaStara) { v.mlhaStara = false; await doplnMlhu(v); }
  return v;
}

async function vyridDlazdici(m) {
  const klic = m.z + '/' + m.x + '/' + m.y;
  posledniPozadavek.set(klic, performance.now());
  posledniSkutecny = performance.now();          // engine 355: předgenerování počká
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

/// ⭐ engine 355 (T 24. 9. 2026: „chtěl bych, aby to už všechno bylo načtené a já jen létal nad hotovou krajinou“):
/// PŘEDGENEROVÁNÍ. Hlavní vlákno po zklidnění mapy pošle dlaždice kolem výřezu a sousedních úrovní zoomu; worker
/// je vyrobí do keše (i s maskou mlhy), nic neposílá. Až je MapLibre při posunu/zoomu vyžádá, jdou z keše (jen
/// kódování) – objekty na okrajích a po přechodu úrovně nenaskakují. Skutečné požadavky mají přednost: pumpa počká,
/// dokud 150 ms žádný nepřišel; prázdný seznam (začátek pohybu) frontu zastaví.
let predFronta = [];
let predBezi = false;
let posledniSkutecny = 0;
const predSpanek = (ms) => new Promise((res) => setTimeout(res, ms));
async function pumpujPredgen() {
  if (predBezi) return;
  predBezi = true;
  let hotovo = 0;
  try {
    while (predFronta.length) {
      if (performance.now() - posledniSkutecny < 150) { await predSpanek(120); continue; }
      const t = predFronta.shift();
      if (!N || !N.herni || t.z < Z_MIN || t.z > Z_MAX) continue;
      const klic = t.z + '/' + t.x + '/' + t.y;
      const kfg = cfgKlic;
      const v0 = vystup.get(klic);
      if (v0 && v0.cfg === kfg) continue;
      const v = await generuj(t.z, t.x, t.y);
      v.cfg = kfg;
      if (kfg !== cfgKlic || !predFronta) continue;
      if (vystup.has(klic)) continue;              // mezitím ji vyrobil skutečný požadavek
      await doplnMlhu(v);
      vystup.set(klic, v);
      while (vystup.size > KES_VYSTUP) vystup.delete(vystup.keys().next().value);
      hotovo++;
    }
  } catch (e) { /* předgenerování je jen pohodlí navíc */ }
  finally {
    predBezi = false;
    casy.predgen = (casy.predgen || 0) + hotovo;
  }
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
  if (m.typ === 'mlha' || m.typ === 'dem' || m.typ === 'silueta') {
    const res = dotazy.get(m.id);
    if (res) { dotazy.delete(m.id); res(m); }
    return;
  }
  // ⭐ engine 357: STÍNY PO DLAŽDICÍCH (js/stiny-dlazdice.js)
  if (m.typ === 'svetlo') { if (self.StinyDlazdice) self.StinyDlazdice.nastavSvetlo(m); return; }
  if (m.typ === 'stin') {
    posledniSkutecny = performance.now();
    if (!self.StinyDlazdice) { self.postMessage({ typ: 'stin', id: m.id, bmp: null, chyba: 'bez modulu' }); return; }
    self.StinyDlazdice.dlazdice(m.z, m.x, m.y, m.verze).then((o) => {
      if (o && o.bmp) self.postMessage({ typ: 'stin', id: m.id, bmp: o.bmp, odkryte: o.odkryte, prazdna: !!o.prazdna }, [o.bmp]);
      else self.postMessage({ typ: 'stin', id: m.id, bmp: null, odkryte: o ? o.odkryte : null });
    }).catch((e) => self.postMessage({ typ: 'stin', id: m.id, bmp: null, chyba: String((e && e.message) || e) }));
    return;
  }
  if (m.typ === 'predstin') { if (self.StinyDlazdice) self.StinyDlazdice.predstin(m); return; }
  if (m.typ === 'stiny-stav') {
    self.postMessage({ typ: 'stav', id: m.id, stiny: self.StinyDlazdice ? self.StinyDlazdice.stav() : null });
    return;
  }
  if (m.typ === 'predgeneruj') {                // engine 355
    predFronta = Array.isArray(m.dlazdice) ? m.dlazdice.slice(0, 64) : [];
    if (predFronta.length) pumpujPredgen();
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
      vrstvyZdroju.get('krajina').add('stavby');              // engine 357: stíny staveb ZABAGED
      vrstvyZdroju.get('krajina').add('vertikaly');
      vrstvyZdroju.set('drobnosti', new Set(['body']));       // engine 349
      vrstvyZdroju.set('lampymesta', new Set(['body']));      // engine 350
      vrstvyZdroju.set('dtmbody', new Set(['body', 'cary'])); // engine 356, 358: čáry = 3D ploty
      vrstvyZdroju.set('vedenizab', new Set(['s', 'r', 'w'])); // engine 357
      vrstvyZdroju.set('vedeniosm', new Set(['s', 'r']));
      zdrojDl.clear();
      oKesV.clear();
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
    if (self.StinyDlazdice) self.StinyDlazdice.zmenaMlhy();   // engine 357
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

// ⭐ engine 357: STÍNY PO DLAŽDICÍCH – kresba týmž kódem jako dřív (StinyGL / StinyKresba), data z tohoto workeru
try {
  const Qs = self.location.search || '';
  importScripts('stiny-kresba.js' + Qs, 'stiny-gl.js' + Qs, 'stiny-dlazdice.js' + Qs);
} catch (e) { /* bez stínů – dekorace jedou dál */ }
