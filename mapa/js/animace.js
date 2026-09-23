/* ⭐ ANIMACE NAD MAPOU (engine 340, 23. 9. 2026; přání „udělej stromy 2× a animace
 * nad mapou“ po zátěžovém testu – PLAN 150. kolo, paměť sarcher-zatez-stromy-animace).
 *
 * Vlastní PLÁTNO nad mapou – mapa se kvůli animacím NEPŘEKRESLUJE (animace uvnitř
 * mapy: TT stihne jen ~30 překreslení/s a CPU +50 %). Pravidla ze zátěžového testu:
 *  - takt: při pohybu mapy každý snímek v události `render` (týž snímek jako mapa),
 *    v klidu 24 Hz, po minutě bez pohybu 12 Hz;
 *    plátno v nižším rozlišení (≤ 1,5 px na CSS px),
 *  - polohy LEVNOU projekcí: výška terénu kotvy jednou (queryTerrainElevation), pak
 *    `transform.locationToScreenPoint(ll, {getElevationForLngLat: () => h})` – jako káně
 *    (⛔ `mapa.project` s terénem je 200× dražší),
 *  - smyčka spí, když není co kreslit (mimo hru, schovaná mapa, pozadí, nic v záběru),
 *  - po 5 min bez pohybu kamery a dotyku se animace zastaví (baterie),
 *  - hlídá si cenu snímku a při > 6 ms ubere kouře.
 * Efekty (jen v herním stylu s mlhou; kotvy jen v OBJEVENÉ krajině – pouští je worker
 * dekorací přes mlhu):
 *  1. KOUŘ Z KOMÍNŮ – kotvy sv:3 (těžiště domů 40–450 m², ~35 %), od z15,5, v topné
 *     sezóně (teplota < 13 °C; bez dat říjen–duben); obláčky stoupají a unáší je vítr.
 *  2. PTÁCI (engine 342: DRUHY) – ve dne bez deště/sněhu/mlhy, od z13,5; kachna, vrabec,
 *     špaček, holub, vrána, volavka, čáp, labuť, husa kreslení shora a natočení podle
 *     směru letu; druh podle okolí, měsíce a zoomu; sami, v párech, v řadě, v klínu
 *     i v mračnu; nejvýš 2 lety naráz, další za 20–45 s; stín na zemi.
 *  3. KROUŽKY NA VODĚ – kotvy sv:4 (body ve vodních plochách), od z15, nad nulou;
 *     tu a tam „ryba“: 2–3 soustředné kroužky zploštělé náklonem.
 *  4. VÍTR (engine 342) – kudrlinky z poryvů vitr.js (Vitr → AnimaceNadMapou.poryv):
 *     ukotvené v mapě, tah jako štětec (hlava postupuje do spirály, ocas mizí).
 * Ladění (CDP): `window.__animaceVynut = {kour: true, ptaci: true}`,
 * `AnimaceNadMapou._ladeni.stav()`, `AnimaceNadMapou._ladeni.hejnoTed(0.4, 'kachna')`,
 * `window.__animaceVynut = {ptaci: true, druh: 'husa'}`.
 */
const AnimaceNadMapou = (() => {
  'use strict';
  const KOUR_OD_Z = 15.5, VODA_OD_Z = 15, PTACI_OD_Z = 13.5;
  const MAX_VODNICH = 60, MAX_KROUZKU = 10;
  const NECINNOST_MS = 5 * 60 * 1000;
  const UROVNE = [{ kominu: 24, oblacku: 150 }, { kominu: 16, oblacku: 90 }, { kominu: 10, oblacku: 50 }];
  let mapa = null, platno = null, ctx = null, hustota = 1, prazdne = true;
  let raf = 0, posledni = 0, aktivitaMs = performance.now(), kontrolaT = null;
  let uroven = 0, cenaEma = 0, levneOd = 0;
  let kominy = [], vodni = [], kotvySig = '', kamSig = '';
  const vysky = new Map();
  const oblacky = [], krouzky = [];
  const lety = [];
  let dalsiLetMs = performance.now() + 8000 + Math.random() * 15000, posledniDruh = '';
  let dalsiRybaMs = 0, stKes = null, stKesMs = 0;
  let spriteSvetly = null, spriteTmavy = null;

  const T = () => { try { return mapa._camera.transform; } catch (e) { return null; } };
  function bod(lon, lat, h) {
    return T().locationToScreenPoint(new maplibregl.LngLat(lon, lat), { getElevationForLngLat: () => h });
  }
  function vyskaTerenu(lon, lat) {
    try {
      if (!mapa.getTerrain || !mapa.getTerrain()) return 0;
      const v = mapa.queryTerrainElevation([lon, lat]);
      return (typeof v === 'number' && isFinite(v)) ? v : null;
    } catch (e) { return null; }
  }
  function vyskaKotvy(a) {
    const k = a.sv + ':' + a.id;
    let h = vysky.get(k);
    if (h === undefined) {
      h = vyskaTerenu(a.lon, a.lat);
      if (h === null) return null;                 // DEM ještě není – příště
      if (vysky.size > 4000) vysky.clear();
      vysky.set(k, h);
    }
    return h;
  }
  function vHre() {
    return typeof STYLY !== 'undefined' && typeof aktualniKod !== 'undefined'
        && STYLY[aktualniKod] && !!STYLY[aktualniKod].mlha;
  }
  function smi() {
    if (!mapa || !platno || document.visibilityState !== 'visible' || !vHre()) return false;
    try { if (window.__nastaveniMapy && window.__nastaveniMapy.animace === false) return false; } catch (e) { /* nic */ }
    const c = mapa.getContainer && mapa.getContainer();
    if (!c || c.clientWidth < 80 || c.clientHeight < 80) return false;    // schovaná mapa (1×1 px)
    return performance.now() - aktivitaMs < NECINNOST_MS;
  }
  function pocasi(t) {
    if (stKes && t - stKesMs < 2000) return stKes;
    try { stKes = (typeof Pocasi !== 'undefined' && Pocasi.stavSvetla) ? Pocasi.stavSvetla() : null; } catch (e) { stKes = null; }
    stKesMs = t;
    return stKes;
  }
  const vynut = () => window.__animaceVynut || {};
  function mesic() { return new Date().getMonth() + 1; }
  function topnaSezona(st) {
    if (vynut().kour) return true;
    const t = st && typeof st.teplota === 'number' ? st.teplota : null;
    if (t !== null) return t < 13;
    const m = mesic();
    return m >= 10 || m <= 4;
  }
  function vodaZamrzla(st) {
    const t = st && typeof st.teplota === 'number' ? st.teplota : null;
    if (t !== null) return t < 1;
    const m = mesic();
    return m === 12 || m <= 2;
  }
  function ptaciSmi(st) {
    if (vynut().ptaci) return true;
    if (!st) return true;
    if (typeof st.slunceEl === 'number' && st.slunceEl < 3) return false;
    return !(st.druh && /dest|snih|bourka|mlha/.test(String(st.druh)));
  }
  const noc = (st) => !!(st && typeof st.slunceEl === 'number' && st.slunceEl < -4);

  // ------------------------------------------------------------------ plátno
  // obláček: světlé jádro a šedší okraj – na béžové mapě by čistě světle šedý
  // kouř zanikl (TT 23. 9.), okraj ho oddělí od podkladu
  function sprite(jadro, okraj) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(' + jadro + ',0.95)');
    gr.addColorStop(0.55, 'rgba(' + okraj + ',0.5)');
    gr.addColorStop(1, 'rgba(' + okraj + ',0)');
    x.fillStyle = gr;
    x.fillRect(0, 0, 64, 64);
    return c;
  }
  function velikost() {
    if (!platno || !mapa) return;
    const c = mapa.getCanvas();
    const w = c.clientWidth, h = c.clientHeight;
    hustota = Math.min(1.5, window.devicePixelRatio || 1);
    const W = Math.max(1, Math.round(w * hustota)), H = Math.max(1, Math.round(h * hustota));
    if (platno.width !== W || platno.height !== H) { platno.width = W; platno.height = H; }
    platno.style.width = w + 'px';
    platno.style.height = h + 'px';
    prazdne = true;
    kamSig = '';
  }
  function zajistiPlatno() {
    if (platno && platno.isConnected) return true;
    const kont = mapa.getCanvasContainer && mapa.getCanvasContainer();
    if (!kont) return false;
    platno = document.createElement('canvas');
    platno.className = 'okolnik-animace';
    platno.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
    kont.appendChild(platno);
    ctx = platno.getContext('2d');
    if (!spriteSvetly) { spriteSvetly = sprite('255,255,255', '160,165,176'); spriteTmavy = sprite('150,152,162', '90,92,104'); }
    velikost();
    return true;
  }
  function vycisti(uplne) {
    if (ctx && !prazdne) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, platno.width, platno.height); }
    prazdne = true;
    if (uplne) { oblacky.length = 0; krouzky.length = 0; lety.length = 0; kudrlinky.length = 0; }
  }
  function naplanuj() { if (!raf && mapa) raf = requestAnimationFrame(snimek); }
  function aktivita() { aktivitaMs = performance.now(); naplanuj(); }

  // ------------------------------------------------------------------ kotvy
  function obnovKotvy(vynutit) {
    // ⛔ `Dekorace` je `const` ve skriptu (globální vazba, NE vlastnost window)
    if (typeof Dekorace === 'undefined' || !Dekorace.kotvyAnimaci) return;
    const z = mapa.getZoom(), c = mapa.getCenter();
    const sig = Dekorace.kotvyVerze() + '|' + c.lng.toFixed(4) + ',' + c.lat.toFixed(4) + '|' + z.toFixed(1) + '|' + uroven;
    if (!vynutit && sig === kotvySig) return;
    kotvySig = sig;
    const k = Dekorace.kotvyAnimaci();
    const b = mapa.getBounds();
    const pw = (b.getEast() - b.getWest()) * 0.1, ph = (b.getNorth() - b.getSouth()) * 0.1;
    const w = b.getWest() - pw, e = b.getEast() + pw, s = b.getSouth() - ph, n = b.getNorth() + ph;
    const vIn = (f) => f.lon > w && f.lon < e && f.lat > s && f.lat < n;
    const cosL = Math.cos(c.lat * Math.PI / 180);
    const d2 = (f) => ((f.lon - c.lng) * cosL) ** 2 + (f.lat - c.lat) ** 2;
    const stare = new Map(kominy.map((x) => [x.id, x]));
    kominy = z >= KOUR_OD_Z
      ? k.komin.filter(vIn).sort((a, b2) => d2(a) - d2(b2)).slice(0, UROVNE[uroven].kominu)
          .map((f) => stare.get(f.id) || { id: f.id, sv: 3, lon: f.lon, lat: f.lat, h: null, dalsi: 0, faze: (f.id % 997) / 997 })
      : [];
    vodni = z >= VODA_OD_Z
      ? k.voda.filter(vIn).slice(0, MAX_VODNICH).map((f) => ({ id: f.id, sv: 4, lon: f.lon, lat: f.lat, h: null, r: +f.r || 3 }))
      : [];
    for (const a of kominy) if (a.h === null) a.h = vyskaKotvy(a);
    for (const a of vodni) if (a.h === null) a.h = vyskaKotvy(a);
    kamSig = '';
  }
  /// polohy a měřítko kotev na obrazovce – jen po změně kamery
  function promitniKotvy() {
    const c = mapa.getCenter();
    const sig = c.lng + ',' + c.lat + ',' + mapa.getZoom() + ',' + mapa.getBearing() + ',' + mapa.getPitch();
    if (sig === kamSig) return;
    kamSig = sig;
    const W = platno.width / hustota, H = platno.height / hustota;
    for (const a of kominy.concat(vodni)) {
      if (a.h === null) { a.vidi = false; continue; }
      const p = bod(a.lon, a.lat, a.h);
      const p2 = bod(a.lon + 10 / (111320 * Math.cos(a.lat * Math.PI / 180)), a.lat, a.h);
      a.sx = p.x; a.sy = p.y;
      a.pxNaM = Math.hypot(p2.x - p.x, p2.y - p.y) / 10;
      a.vidi = p.x > -60 && p.x < W + 60 && p.y > -80 && p.y < H + 60;
    }
  }

  // ------------------------------------------------------------------ efekty
  function krokKour(t, st) {
    for (let i = oblacky.length - 1; i >= 0; i--) if ((t - oblacky[i].t0) / 1000 > oblacky[i].zivot) oblacky.splice(i, 1);
    if (mapa.getZoom() < KOUR_OD_Z || !topnaSezona(st)) return;
    const max = UROVNE[uroven].oblacku;
    for (const k of kominy) {
      if (k.h === null || !k.vidi || t < k.dalsi) continue;
      k.dalsi = t + 650 + k.faze * 650 + Math.random() * 250;
      if (oblacky.length < max) oblacky.push({ k, t0: t, zivot: 4.2 + Math.random() * 1.6, turb: Math.random() * 6.28 });
    }
  }
  function kresliKour(t, st) {
    if (!oblacky.length) return;
    const v = (typeof Pocasi !== 'undefined' && Pocasi.vitr) ? Pocasi.vitr() : { kmh: 5, smerRoj: 0 };
    const rychl = 0.5 + Math.min(5, (v.kmh || 0) * 0.15);           // m/s
    const ex = Math.cos(v.smerRoj || 0), ey = Math.sin(v.smerRoj || 0);
    const tma = noc(st);
    const spr = tma ? spriteTmavy : spriteSvetly;
    const zakl = tma ? 0.3 : (st && /dest|snih/.test(String(st.druh)) ? 0.4 : 0.58);
    for (const o of oblacky) {
      const a = (t - o.t0) / 1000, k = o.k;
      const zdvih = 7 + 3.2 * a - 0.1 * a * a;
      const d = rychl * a * (0.35 + 0.65 * Math.min(1, a / 2));
      const bok = 0.7 * Math.sin(o.turb + a * 1.3);
      const dx = d * ex - bok * ey, dy = d * ey + bok * ex;
      const p = bod(k.lon + dx / (111320 * Math.cos(k.lat * Math.PI / 180)), k.lat + dy / 111320, k.h + zdvih);
      // stylizace ×1,7 (malba, ne měřítko – jako stromy), strop 42 px
      const r = Math.min(42, (1.5 + 1.9 * a) * 1.7 * (k.pxNaM || 1));
      if (r < 0.6) continue;
      const nabeh = Math.min(1, a / 0.45);
      ctx.globalAlpha = zakl * nabeh * Math.pow(Math.max(0, 1 - a / o.zivot), 1.3);
      ctx.drawImage(spr, p.x - r, p.y - r, 2 * r, 2 * r);
    }
    ctx.globalAlpha = 1;
  }
  // ------------------------------------------------------------------ kresba druhů ptáků
  // ⭐ engine 342 (výtka T: „ptáky ještě hezčí, víc druhů, ať jsou si podobní – kachny jako
  // kachny, vrabci jako vrabci“): každý druh se KRESLÍ SHORA (letí nahoru, −y) v jednotkách,
  // kde plné rozpětí křídel = 100. Fáze mávnutí: rozpětí `sp` (průmět křídla shora se při
  // úderu zkracuje) a posun špiček dopředu/dozadu `sw`. Z toho se jednou upečou spritey.
  const FAZE = [[1.0, 0.1], [0.82, 0.28], [0.58, 0.02], [0.8, -0.22], [0.3, -0.55]];   // 4 = složená (vrabec)
  function kridlo(g, st, sp, sw, t) {
    // t: { rx, ry (rameno), del (délka křídla při sp=1), hl (hloubka u ramene), hs (hloubka u špičky),
    //      tvar: 'ostra' | 'kulata' | 'prsty', prsty: počet, dopredu (klenba náběžné hrany) }
    const L = t.del * sp, xr = st * t.rx, yr = t.ry;
    const xt = st * (t.rx + L), yt = yr - t.dopredu - sw * t.del * 0.35;
    const hs = t.hs * (0.6 + 0.4 * sp);
    g.beginPath();
    g.moveTo(xr, yr - t.hl * 0.45);
    g.bezierCurveTo(st * (t.rx + L * 0.35), yr - t.hl * 0.6 - t.dopredu, st * (t.rx + L * 0.75), yt - hs * 0.2, xt, yt);
    if (t.tvar === 'prsty') {
      const n = t.prsty || 5;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const bx = st * (t.rx + L * (0.99 - u * 0.2)), by = yt + hs * (0.15 + u * 0.95);
        const kx = st * (t.rx + L * (1.1 - u * 0.2)), ky = yt + hs * (0.05 + u * 0.95) + t.del * 0.02;
        g.quadraticCurveTo(kx, ky - hs * 0.08, bx, by);
      }
    } else if (t.tvar === 'kulata') {
      g.quadraticCurveTo(st * (t.rx + L * 1.04), yt + hs * 0.45, st * (t.rx + L * 0.9), yt + hs * 0.95);
    } else {
      g.quadraticCurveTo(st * (t.rx + L * 0.9), yt + hs * 0.35, st * (t.rx + L * 0.8), yt + hs * 0.6);
    }
    g.bezierCurveTo(st * (t.rx + L * 0.55), yr + t.hl * 0.9, st * (t.rx + L * 0.2), yr + t.hl * 0.85, xr, yr + t.hl * 0.55);
    g.closePath();
  }
  function elipsa(g, x, y, rx, ry) { g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); }
  function kapka(g, x, y, w, h, spicka) {   // tělo: vpředu kulaté, vzadu do špičky
    g.beginPath();
    g.moveTo(x, y - h);
    g.bezierCurveTo(x + w, y - h, x + w, y + h * 0.4, x, y + h * (spicka || 1));
    g.bezierCurveTo(x - w, y + h * 0.4, x - w, y - h, x, y - h);
    g.closePath();
  }
  function ocasVejir(g, y, sirka, delka, zaobl) {
    g.beginPath();
    g.moveTo(-sirka * 0.35, y);
    g.lineTo(-sirka * 0.5, y + delka * 0.85);
    g.quadraticCurveTo(0, y + delka * (1 + (zaobl || 0.15)), sirka * 0.5, y + delka * 0.85);
    g.lineTo(sirka * 0.35, y);
    g.closePath();
  }
  const DRUHY_KRESBA = {
    vrabec(g, sp, sw, stin) {
      const K = { rx: 7, ry: -3, del: 33, hl: 17, hs: 13, tvar: 'kulata', dopredu: 2 };
      const c = stin ? '#000' : null;
      g.fillStyle = c || '#9a6a3c';
      kridlo(g, -1, sp, sw, K); g.fill(); kridlo(g, 1, sp, sw, K); g.fill();
      if (!stin) {                                    // tmavé čárkování a světlá páska
        g.strokeStyle = 'rgba(55,35,20,0.75)'; g.lineWidth = 2.2; g.lineCap = 'round';
        for (const st of [-1, 1]) for (let i = 0; i < 3; i++) {
          const L = K.del * sp;
          g.beginPath(); g.moveTo(st * (K.rx + L * (0.25 + i * 0.2)), K.ry - 2); g.lineTo(st * (K.rx + L * (0.3 + i * 0.2)), K.ry + 8); g.stroke();
        }
        g.strokeStyle = 'rgba(246,236,210,0.95)'; g.lineWidth = 2.6;
        for (const st of [-1, 1]) { g.beginPath(); g.moveTo(st * (K.rx + 3), K.ry - 4); g.lineTo(st * (K.rx + K.del * sp * 0.55), K.ry - 5 - sw * 3); g.stroke(); }
      }
      g.fillStyle = c || '#5c4330'; ocasVejir(g, 10, 12, 16, 0.05); g.fill();
      g.fillStyle = c || '#a77b50'; kapka(g, 0, 2, 10.5, 14, 1.1); g.fill();
      g.fillStyle = c || '#7d4a2a'; elipsa(g, 0, -12, 7.5, 7.5); g.fill();      // kaštanová hlava
      if (!stin) { g.fillStyle = '#8f8f8f'; elipsa(g, 0, -13.5, 4.4, 4.8); g.fill(); }   // šedé temeno
      g.fillStyle = c || '#3c3228'; g.beginPath(); g.moveTo(-2, -18); g.lineTo(0, -22); g.lineTo(2, -18); g.fill();
    },
    spacek(g, sp, sw, stin) {
      const K = { rx: 5, ry: -4, del: 44, hl: 15, hs: 5, tvar: 'ostra', dopredu: 3 };
      const c = stin ? '#000' : null;
      g.fillStyle = c || '#23252e';
      kridlo(g, -1, sp, sw, K); g.fill(); kridlo(g, 1, sp, sw, K); g.fill();
      if (!stin) {                                    // kovový lesk a tečky
        g.fillStyle = 'rgba(90,70,140,0.35)';
        for (const st of [-1, 1]) { kridlo(g, st, sp * 0.6, sw, Object.assign({}, K, { del: K.del * 0.6, hl: 9 })); g.fill(); }
        g.fillStyle = 'rgba(230,220,190,0.8)';
        for (const st of [-1, 1]) for (let i = 0; i < 4; i++) { elipsa(g, st * (K.rx + K.del * sp * (0.2 + i * 0.16)), K.ry + 2 + (i % 2) * 3, 1.1, 1.1); g.fill(); }
      }
      g.fillStyle = c || '#1e2027'; ocasVejir(g, 9, 10, 11, -0.05); g.fill();
      g.fillStyle = c || '#262833'; kapka(g, 0, 1, 7.5, 12, 1.0); g.fill();
      g.fillStyle = c || '#262833'; elipsa(g, 0, -12, 5.5, 6); g.fill();
      g.fillStyle = c || '#e2c040'; g.beginPath(); g.moveTo(-1.6, -17); g.lineTo(0, -24); g.lineTo(1.6, -17); g.fill();
    },
    holub(g, sp, sw, stin) {
      const K = { rx: 6, ry: -3, del: 43, hl: 17, hs: 7, tvar: 'ostra', dopredu: 3 };
      const c = stin ? '#000' : null;
      g.fillStyle = c || '#9ea7b1';
      kridlo(g, -1, sp, sw, K); g.fill(); kridlo(g, 1, sp, sw, K); g.fill();
      if (!stin) {
        g.fillStyle = 'rgba(52,58,66,0.9)';            // tmavé konce letek
        for (const st of [-1, 1]) {
          const L = K.del * sp;
          g.beginPath();
          g.moveTo(st * (K.rx + L * 0.7), K.ry - 6 - sw * K.del * 0.25);
          g.lineTo(st * (K.rx + L), K.ry - K.dopredu - sw * K.del * 0.35);
          g.lineTo(st * (K.rx + L * 0.82), K.ry + 4);
          g.closePath(); g.fill();
        }
        g.strokeStyle = 'rgba(40,44,52,0.85)'; g.lineWidth = 2.4; g.lineCap = 'round';   // dvě pásky
        for (const st of [-1, 1]) for (const d of [4, 9]) {
          g.beginPath(); g.moveTo(st * (K.rx + 2), K.ry + d - 4); g.lineTo(st * (K.rx + K.del * sp * 0.32), K.ry + d - 2); g.stroke();
        }
      }
      g.fillStyle = c || '#8f98a3'; ocasVejir(g, 11, 13, 15, 0.1); g.fill();
      if (!stin) { g.fillStyle = '#3a3f47'; g.fillRect(-6.5, 22, 13, 3); }
      g.fillStyle = c || '#a9b2bb'; kapka(g, 0, 2, 9, 14, 1.05); g.fill();
      if (!stin) { g.fillStyle = '#d7dde2'; elipsa(g, 0, 10, 5, 4); g.fill(); }             // světlý kostřec
      g.fillStyle = c || '#6f7b88'; elipsa(g, 0, -13, 5.5, 6); g.fill();
      if (!stin) { g.fillStyle = 'rgba(110,170,120,0.7)'; elipsa(g, 0, -9.5, 6, 2.5); g.fill(); }   // lesk krku
      g.fillStyle = c || '#e8d6c8'; g.beginPath(); g.moveTo(-1.5, -18); g.lineTo(0, -22); g.lineTo(1.5, -18); g.fill();
    },
    kachna(g, sp, sw, stin) {
      const K = { rx: 7, ry: -2, del: 42, hl: 13, hs: 6, tvar: 'ostra', dopredu: 4 };
      const c = stin ? '#000' : null;
      g.fillStyle = c || '#7f786c';
      kridlo(g, -1, sp, sw, K); g.fill(); kridlo(g, 1, sp, sw, K); g.fill();
      if (!stin) {                                    // modré zrcátko s bílým lemem
        for (const st of [-1, 1]) {
          const L = K.del * sp;
          g.fillStyle = '#ffffff';
          g.beginPath(); g.moveTo(st * (K.rx + 1), K.ry + 3); g.lineTo(st * (K.rx + L * 0.36), K.ry + 2); g.lineTo(st * (K.rx + L * 0.36), K.ry + 8); g.lineTo(st * (K.rx + 1), K.ry + 9); g.closePath(); g.fill();
          g.fillStyle = '#2b55b8';
          g.beginPath(); g.moveTo(st * (K.rx + 2), K.ry + 4); g.lineTo(st * (K.rx + L * 0.34), K.ry + 3); g.lineTo(st * (K.rx + L * 0.34), K.ry + 7); g.lineTo(st * (K.rx + 2), K.ry + 8); g.closePath(); g.fill();
          g.fillStyle = 'rgba(60,54,48,0.8)';            // tmavší ruční letky
          g.beginPath(); g.moveTo(st * (K.rx + L * 0.62), K.ry - 4 - sw * 6); g.lineTo(st * (K.rx + L), K.ry - K.dopredu - sw * K.del * 0.35); g.lineTo(st * (K.rx + L * 0.78), K.ry + 3); g.closePath(); g.fill();
        }
      }
      g.fillStyle = c || '#2a2622'; ocasVejir(g, 13, 10, 9, 0.05); g.fill();
      if (!stin) { g.fillStyle = '#f0f0ea'; ocasVejir(g, 14, 11, 7, 0.02); g.fill(); g.fillStyle = '#1c1a18'; elipsa(g, 0, 17, 2.4, 3.5); g.fill(); }
      g.fillStyle = c || '#8c867c'; kapka(g, 0, 3, 8.5, 14, 1.0); g.fill();
      if (!stin) { g.fillStyle = '#6b3a28'; elipsa(g, 0, -8, 6.5, 5); g.fill(); }            // kaštanová hruď
      g.fillStyle = c || '#1f5c3d'; g.fillRect(-2.6, -22, 5.2, 12);                            // krk
      if (!stin) { g.fillStyle = '#f4f4ee'; g.fillRect(-3.2, -14.5, 6.4, 1.8); }             // bílý obojek
      g.fillStyle = c || '#1d6440'; elipsa(g, 0, -24, 4.4, 5.6); g.fill();                     // zelená hlava
      if (!stin) { g.fillStyle = 'rgba(120,220,160,0.45)'; elipsa(g, -1, -25.5, 1.8, 2.4); g.fill(); }
      g.fillStyle = c || '#d9b43c'; g.beginPath(); g.moveTo(-2.2, -28.5); g.quadraticCurveTo(0, -35, 2.2, -28.5); g.fill();
    },
    vrana(g, sp, sw, stin) {
      const K = { rx: 6, ry: -3, del: 42, hl: 22, hs: 18, tvar: 'prsty', prsty: 5, dopredu: 2 };
      const c = stin ? '#000' : null;
      g.fillStyle = c || '#1c1c20';
      kridlo(g, -1, sp, sw, K); g.fill(); kridlo(g, 1, sp, sw, K); g.fill();
      if (!stin) {
        g.fillStyle = 'rgba(95,95,110,0.35)';          // šedý lesk krovek
        for (const st of [-1, 1]) { kridlo(g, st, sp * 0.55, sw, Object.assign({}, K, { del: K.del * 0.55, hl: 12, tvar: 'kulata' })); g.fill(); }
      }
      g.fillStyle = c || '#18181c'; ocasVejir(g, 12, 14, 16, 0.3); g.fill();
      g.fillStyle = c || '#202024'; kapka(g, 0, 2, 9, 15, 1.0); g.fill();
      g.fillStyle = c || '#222226'; elipsa(g, 0, -14, 6, 6.5); g.fill();
      g.fillStyle = c || '#141416'; g.beginPath(); g.moveTo(-2.4, -19); g.lineTo(0, -27); g.lineTo(2.4, -19); g.fill();
    },
    volavka(g, sp, sw, stin) {
      const K = { rx: 7, ry: -2, del: 42, hl: 24, hs: 20, tvar: 'prsty', prsty: 5, dopredu: 5 };
      const c = stin ? '#000' : null;
      g.fillStyle = c || '#9ba5ae';
      kridlo(g, -1, sp, sw, K); g.fill(); kridlo(g, 1, sp, sw, K); g.fill();
      if (!stin) {
        // tmavé letky: ruční na konci křídla + úzký lem odtokové hrany (dřív půl křídla
        // černé – v letu napříč volavka vypadala jako dva tmavé špalky, TT 23. 9.)
        g.fillStyle = '#3a4048';
        for (const st of [-1, 1]) {
          const L = K.del * sp;
          g.beginPath();
          g.moveTo(st * (K.rx + L * 0.62), K.ry - K.dopredu * 0.6 - sw * K.del * 0.2);
          g.lineTo(st * (K.rx + L * 0.86), K.ry - K.dopredu - sw * K.del * 0.3);
          g.lineTo(st * (K.rx + L * 1.02), K.ry + K.hs * 0.4);
          g.lineTo(st * (K.rx + L * 0.8), K.ry + K.hs * 1.05);
          g.lineTo(st * (K.rx + L * 0.5), K.ry + K.hl * 0.72);
          g.lineTo(st * (K.rx + L * 0.12), K.ry + K.hl * 0.62);
          g.lineTo(st * (K.rx + L * 0.12), K.ry + K.hl * 0.42);
          g.lineTo(st * (K.rx + L * 0.55), K.ry + K.hl * 0.45);
          g.closePath(); g.fill();
        }
        g.fillStyle = 'rgba(240,240,236,0.9)';          // světlý ohbí křídla
        for (const st of [-1, 1]) { elipsa(g, st * (K.rx + 4), K.ry - 7, 3, 2); g.fill(); }
      }
      g.strokeStyle = c || '#a8894a'; g.lineWidth = 3; g.lineCap = 'round';                  // dlouhé nohy dozadu
      g.beginPath(); g.moveTo(-1.6, 14); g.lineTo(-2, 44); g.moveTo(1.6, 14); g.lineTo(2, 44); g.stroke();
      g.fillStyle = c || '#8a939c'; ocasVejir(g, 10, 10, 8, 0.1); g.fill();
      g.fillStyle = c || '#9aa3ab'; kapka(g, 0, 1, 8, 13, 1.0); g.fill();
      g.fillStyle = c || '#e9e9e4'; elipsa(g, 0, -12, 5.5, 5); g.fill();                     // zatažený krk a hlava
      if (!stin) { g.fillStyle = '#1e1e22'; g.fillRect(-4, -13, 2, 3); g.fillRect(2, -13, 2, 3); }
      g.fillStyle = c || '#e0b830'; g.beginPath(); g.moveTo(-2.4, -16); g.lineTo(0, -30); g.lineTo(2.4, -16); g.fill();   // dýkovitý zobák
    },
    cap(g, sp, sw, stin) {
      const K = { rx: 7, ry: -2, del: 42, hl: 24, hs: 20, tvar: 'prsty', prsty: 6, dopredu: 4 };
      const c = stin ? '#000' : null;
      g.fillStyle = c || '#f3f1ea';
      kridlo(g, -1, sp, sw, K); g.fill(); kridlo(g, 1, sp, sw, K); g.fill();
      if (!stin) {                                    // černé letky: celá zadní polovina křídla
        g.fillStyle = '#1b1b1e';
        for (const st of [-1, 1]) {
          const L = K.del * sp;
          g.beginPath();
          g.moveTo(st * K.rx, K.ry + K.hl * 0.2);
          g.lineTo(st * (K.rx + L * 0.35), K.ry + K.hl * 0.12);
          g.lineTo(st * (K.rx + L * 0.78), K.ry - K.dopredu - sw * K.del * 0.3 + 2);
          g.lineTo(st * (K.rx + L * 1.08), K.ry + K.hs * 0.35);
          g.lineTo(st * (K.rx + L * 0.8), K.ry + K.hs * 1.05);
          g.lineTo(st * (K.rx + L * 0.2), K.ry + K.hl * 0.85);
          g.lineTo(st * K.rx, K.ry + K.hl * 0.55);
          g.closePath(); g.fill();
        }
      }
      g.strokeStyle = c || '#d6452c'; g.lineWidth = 2.2; g.lineCap = 'round';                  // červené nohy
      g.beginPath(); g.moveTo(-1.6, 14); g.lineTo(-2, 40); g.moveTo(1.6, 14); g.lineTo(2, 40); g.stroke();
      g.fillStyle = c || '#f1efe8'; ocasVejir(g, 10, 11, 9, 0.1); g.fill();
      g.fillStyle = c || '#f6f4ee'; kapka(g, 0, 1, 8, 13, 1.0); g.fill();
      g.fillStyle = c || '#f6f4ee'; g.fillRect(-2.4, -26, 4.8, 16);                           // natažený krk
      g.fillStyle = c || '#f6f4ee'; elipsa(g, 0, -27, 3.6, 4.4); g.fill();
      g.fillStyle = c || '#d6452c'; g.beginPath(); g.moveTo(-1.5, -30); g.lineTo(0, -42); g.lineTo(1.5, -30); g.fill();   // červený zobák
    },
    labut(g, sp, sw, stin) {
      const K = { rx: 7, ry: 0, del: 42, hl: 22, hs: 16, tvar: 'kulata', dopredu: 4 };
      const c = stin ? '#000' : null;
      g.fillStyle = c || '#f7f6f1';
      kridlo(g, -1, sp, sw, K); g.fill(); kridlo(g, 1, sp, sw, K); g.fill();
      if (!stin) {                                    // jemně šedé letky
        g.strokeStyle = 'rgba(140,140,128,0.55)'; g.lineWidth = 1.4; g.lineCap = 'round';
        for (const st of [-1, 1]) for (let i = 0; i < 5; i++) {
          const L = K.del * sp, x = st * (K.rx + L * (0.3 + i * 0.14));
          g.beginPath(); g.moveTo(x, K.ry + 4); g.lineTo(x + st * 2, K.ry + K.hl * 0.8 - i * 1.5); g.stroke();
        }
      }
      g.fillStyle = c || '#efeee8'; ocasVejir(g, 13, 11, 8, 0.25); g.fill();
      g.fillStyle = c || '#f9f8f4'; kapka(g, 0, 3, 9.5, 16, 1.0); g.fill();
      g.fillStyle = c || '#f9f8f4'; g.fillRect(-2.4, -38, 4.8, 28);                          // dlouhý natažený krk
      g.fillStyle = c || '#f9f8f4'; elipsa(g, 0, -39, 3.6, 4.6); g.fill();
      g.fillStyle = c || '#e0762c'; g.beginPath(); g.moveTo(-2, -42); g.lineTo(0, -49); g.lineTo(2, -42); g.fill();   // oranžový zobák
      if (!stin) { g.fillStyle = '#1b1b1b'; elipsa(g, 0, -42.5, 1.6, 1.4); g.fill(); }       // černý hrbolek
    },
    husa(g, sp, sw, stin) {
      const K = { rx: 7, ry: -1, del: 42, hl: 18, hs: 9, tvar: 'ostra', dopredu: 3 };
      const c = stin ? '#000' : null;
      g.fillStyle = c || '#8a8171';
      kridlo(g, -1, sp, sw, K); g.fill(); kridlo(g, 1, sp, sw, K); g.fill();
      if (!stin) {
        g.fillStyle = '#b6b9b4';                        // světle šedé přední křídlo (husa velká)
        for (const st of [-1, 1]) { kridlo(g, st, sp * 0.72, sw, Object.assign({}, K, { del: K.del * 0.72, hl: 8, hs: 5 })); g.fill(); }
        g.fillStyle = 'rgba(52,50,46,0.85)';            // tmavé ruční letky
        for (const st of [-1, 1]) {
          const L = K.del * sp;
          g.beginPath(); g.moveTo(st * (K.rx + L * 0.6), K.ry - 3 - sw * 6); g.lineTo(st * (K.rx + L), K.ry - K.dopredu - sw * K.del * 0.35);
          g.lineTo(st * (K.rx + L * 0.8), K.ry + 6); g.lineTo(st * (K.rx + L * 0.55), K.ry + 8); g.closePath(); g.fill();
        }
        g.strokeStyle = 'rgba(225,220,205,0.6)'; g.lineWidth = 1.2;       // světlé lemy krovek
        for (const st of [-1, 1]) for (const d of [5, 9]) { g.beginPath(); g.moveTo(st * (K.rx + 1), K.ry + d); g.lineTo(st * (K.rx + K.del * sp * 0.45), K.ry + d - 1); g.stroke(); }
      }
      g.fillStyle = c || '#6e675c'; ocasVejir(g, 13, 11, 9, 0.12); g.fill();
      if (!stin) { g.fillStyle = '#f3f1ea'; g.fillRect(-5.5, 13, 11, 3); }                   // bílý pruh na kostřci
      g.fillStyle = c || '#8d8575'; kapka(g, 0, 2, 9, 15, 1.0); g.fill();
      g.fillStyle = c || '#857d6e'; g.fillRect(-2.5, -28, 5, 18);                             // krk
      g.fillStyle = c || '#81796b'; elipsa(g, 0, -29, 3.8, 5); g.fill();
      g.fillStyle = c || '#e59a6a'; g.beginPath(); g.moveTo(-2, -32.5); g.lineTo(0, -39); g.lineTo(2, -32.5); g.fill();   // oranžovorůžový zobák
    },
  };
  /// sprite fáze: plátno N×N, pták v měřítku `m` (jednotky → px); stín = černá silueta
  function upecDruh(druh, N, m, sStiny, amp) {
    const snimky = [], stiny = [];
    amp = amp || 1;
    for (let f = 0; f < FAZE.length; f++) {
      const sp = f === 4 ? FAZE[f][0] : 1 - (1 - FAZE[f][0]) * amp, sw = f === 4 ? FAZE[f][1] : FAZE[f][1] * amp;
      for (const stin of sStiny ? [false, true] : [false]) {
        const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(N, N) : document.createElement('canvas');
        c.width = N; c.height = N;
        const g = c.getContext('2d');
        g.translate(N / 2, N / 2);
        g.scale(m, m);
        if (!stin) { g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 1.5 * m; }
        DRUHY_KRESBA[druh](g, sp, sw, stin);
        (stin ? stiny : snimky).push(c);
      }
    }
    return { snimky, stiny };
  }
  // ------------------------------------------------------------------ ptáci: lety
  // ⭐ engine 342: letka = JEDEN druh, kresba natočená PODLE SMĚRU LETU a položená do
  // roviny letu (zkrácení náklonem kamery jako všechno na mapě) – dřív vzpřímená
  // silueta letící šikmo přes obrazovku vypadala jako let bokem (výtka T 23. 9.).
  // Druh podle okolí (kotvy z workeru dekorací: voda → kachny, volavka, labutě;
  // komíny/světla sídel → vrabci, holubi; jinak vrány, špačci, čápi; husy v klínu hlavně
  // v říjnu–březnu, čápi v dubnu–srpnu), podle zoomu (drobní až zblízka) a měsíce.
  const MAX_LETU = 2;
  const PTACI = {
    // roz = rozpětí na obrazovce (px při z16), v = m/s (stylizace ~×1,2), nad = výška nad terénem,
    // frek = mávnutí/s, let: mava | poskok (vrabec: pár mávnutí a složená křídla) | plachti (čáp),
    // klouz = délka klouzání (s), amp = rozkmit mávnutí, tvar sestavy, od = nejnižší zoom, n = počet ptáků
    kachna:  { roz: 27, v: 24, nad: [14, 40],  frek: 5.5, amp: 0.7, let: 'mava', tvar: 'rada', od: 14.5,
               n: () => vazene([[1, 12], [2, 45], [3, 16], [4, 12], [5, 9], [6, 6]]) },
    vrabec:  { roz: 20, v: 16, nad: [3, 8],    frek: 9,   let: 'poskok', tvar: 'volne', od: 15.5,
               n: () => vazene([[1, 35], [2, 30], [3, 20], [4, 15]]) },
    spacek:  { roz: 18, v: 22, nad: [25, 60],  frek: 6.5, amp: 0.9, let: 'mava', klouz: 0.35, tvar: 'mrak', od: 14.5,
               n: () => 10 + Math.floor(Math.random() * 13) },
    holub:   { roz: 22, v: 21, nad: [18, 45],  frek: 5,   amp: 0.85, let: 'mava', klouz: 0.25, tvar: 'chumel', od: 14.5,
               n: () => 4 + Math.floor(Math.random() * 8) },
    vrana:   { roz: 26, v: 14, nad: [18, 40],  frek: 3.2, amp: 0.8, let: 'mava', klouz: 0.15, tvar: 'volne', od: 14,
               n: () => (mesic() >= 11 || mesic() <= 2) ? 3 + Math.floor(Math.random() * 6) : vazene([[1, 50], [2, 30], [3, 12], [4, 8]]) },
    volavka: { roz: 35, v: 13, nad: [22, 45],  frek: 2.1, amp: 0.55, let: 'mava', tvar: 'volne', od: 13.5,
               n: () => vazene([[1, 88], [2, 12]]) },
    cap:     { roz: 37, v: 12, nad: [50, 120], frek: 1.8, amp: 0.6, let: 'plachti', tvar: 'volne', od: 13.5,
               n: () => vazene([[1, 60], [2, 30], [3, 10]]) },
    labut:   { roz: 37, v: 20, nad: [12, 30],  frek: 2.8, amp: 0.7, let: 'mava', tvar: 'rada', od: 13.5,
               n: () => vazene([[1, 20], [2, 55], [3, 15], [4, 10]]) },
    husa:    { roz: 30, v: 19, nad: [60, 130], frek: 3.4, amp: 0.75, let: 'mava', tvar: 'klin', od: 13.5,
               n: () => 5 + Math.floor(Math.random() * 9) },
  };
  const spritePtaku = {};
  function spriteDruhu(druh) {
    let s = spritePtaku[druh];
    if (!s) {
      // velká sada (rozpětí 90 px) na blízko, malá (45 px) + stíny – zmenšení nejvýš 2×
      const a = PTACI[druh].amp || 1;
      const v = upecDruh(druh, 96, 0.9, false, a), m = upecDruh(druh, 48, 0.45, true, a);
      s = spritePtaku[druh] = { v: { N: 96, m: 0.9, sn: v.snimky }, m: { N: 48, m: 0.45, sn: m.snimky },
                                stin: { N: 48, m: 0.45, sn: m.stiny } };
    }
    return s;
  }
  const nah = (a) => (Math.random() * 2 - 1) * a;
  function vazene(moznosti) {
    let s = 0;
    for (const m of moznosti) s += m[1];
    let r = Math.random() * s;
    for (const m of moznosti) { r -= m[1]; if (r <= 0) return m[0]; }
    return moznosti[0][0];
  }
  const rozpetiPx = (c, z) => c.roz * Math.max(0.45, Math.min(1.4, 1 + (z - 16) * 0.25));
  const metryNaPx = (z, lat) => 78271.52 / Math.pow(2, z) * Math.cos(lat * Math.PI / 180);
  /// rozestavení v rozpětích (podel + = dopředu, bok + = vpravo) + rozkmit kolébání
  function sestava(tvar, n) {
    const o = [];
    const volne = (Rp, Rb, minR) => {
      for (let i = 0; i < n; i++) {
        let b = null;
        for (let pokus = 0; pokus < 14 && !b; pokus++) {
          const a = Math.random() * 6.283, r = Math.sqrt(Math.random());
          const c = { podel: Math.cos(a) * r * Rp, bok: Math.sin(a) * r * Rb };
          if (o.every((q) => Math.hypot(q.podel - c.podel, q.bok - c.bok) >= minR)) b = c;
        }
        o.push(b || { podel: -i * minR, bok: nah(0.5) });
      }
    };
    if (tvar === 'klin') {
      // klín s vedoucím vpředu, jedno rameno často delší (jako u hus)
      const vlevo = Math.round((n - 1) * (0.35 + Math.random() * 0.3));
      o.push({ podel: 0, bok: 0 });
      for (let i = 1; i < n; i++) {
        const st = i <= vlevo ? -1 : 1, k = st < 0 ? i : i - vlevo;
        o.push({ podel: -k * 0.62 + nah(0.06), bok: st * k * 0.8 + nah(0.06) });
      }
    } else if (tvar === 'rada') {
      const st = Math.random() < 0.5 ? -1 : 1;
      for (let i = 0; i < n; i++) o.push({ podel: -i * 1.25 + nah(0.15), bok: st * i * 0.4 + nah(0.15) });
    } else if (tvar === 'mrak') volne(0.95 * Math.sqrt(n), 0.75 * Math.sqrt(n), 0.75);
    else if (tvar === 'chumel') volne(0.7 * Math.sqrt(n), 0.6 * Math.sqrt(n), 0.8);
    else if (n === 1) o.push({ podel: 0, bok: 0 });
    else volne(1.3 * Math.sqrt(n) + 0.8, 1.2 * Math.sqrt(n) + 0.6, 1.3);
    const kmit = { klin: 0.04, rada: 0.08, mrak: 0.28, chumel: 0.12, volne: 0.15 }[tvar] || 0.1;
    return o.map((q) => Object.assign(q, { kmit, w1: 0.4 + Math.random() * 0.6, w2: 0.3 + Math.random() * 0.6,
                                           f1: Math.random() * 6.283, f2: Math.random() * 6.283 }));
  }
  function kontextPtaku() {
    const nic = { komin: 0, voda: 0, svetla: 0 };
    try {
      if (typeof Dekorace === 'undefined' || !Dekorace.kontextPtaku) return nic;
      const b = mapa.getBounds();
      return Dekorace.kontextPtaku(b.getWest(), b.getSouth(), b.getEast(), b.getNorth()) || nic;
    } catch (e) { return nic; }
  }
  function vyberDruh(z, jine) {
    const k = kontextPtaku(), m = mesic();
    const voda = k.voda >= 3, ves = k.komin >= 6 || k.svetla >= 10;
    const vahy = {
      kachna: voda ? 6 : 0.5,
      labut: k.voda >= 12 ? 2 : (voda ? 0.8 : 0),
      volavka: voda ? 2.2 : 0.5,
      husa: (m >= 10 || m <= 3) ? (voda ? 2.5 : 1.5) : (voda ? 0.8 : 0.15),
      cap: (m >= 4 && m <= 8) ? (voda ? 1 : 2.2) : 0,
      vrana: ves ? 1.2 : 3,
      spacek: (m >= 3 && m <= 11) ? (ves ? 2.2 : 2.8) : 0.5,
      holub: ves ? 3 : 1,
      vrabec: ves ? 4.5 : 0,
    };
    let suma = 0;
    for (const d in vahy) {
      if (z < PTACI[d].od || jine.indexOf(d) >= 0) vahy[d] = 0;
      if (d === posledniDruh) vahy[d] *= 0.35;
      suma += vahy[d];
    }
    if (!(suma > 0)) return null;
    let r = Math.random() * suma;
    for (const d in vahy) { if (vahy[d] <= 0) continue; r -= vahy[d]; if (r <= 0) return d; }
    return null;
  }
  /// bod, nad kterým pták v nadmořské výšce `alt` UVIDÍ na pixelu px (oprava paralaxy)
  function bodVeVysce(px, alt) {
    const A = mapa.unproject(px);
    const p = bod(A.lng, A.lat, alt);
    return mapa.unproject([2 * px[0] - p.x, 2 * px[1] - p.y]);
  }
  function novyLet(druh) {
    const c = PTACI[druh];
    const kont = mapa.getContainer(), W = kont.clientWidth, H = kont.clientHeight;
    const nad = c.nad[0] + Math.random() * (c.nad[1] - c.nad[0]);
    const okraj = 50 + c.roz;
    const r = Math.random();
    const y = (u0, u1) => H * (u0 + Math.random() * (u1 - u0)), x = (u0, u1) => W * (u0 + Math.random() * (u1 - u0));
    let a, b;
    // vlet i odlet ZA OKRAJEM: vlevo↔vpravo (i šikmo), občas zdola nahoru / shora dolů
    if (r < 0.38) { a = [-okraj, y(0.25, 0.9)]; b = [W + okraj, y(0.2, 0.92)]; }
    else if (r < 0.76) { a = [W + okraj, y(0.25, 0.9)]; b = [-okraj, y(0.2, 0.92)]; }
    else if (r < 0.88 || mapa.getPitch() > 50) { a = [x(0.15, 0.85), H + okraj]; b = [x(0.1, 0.9), -okraj]; }
    else { a = [x(0.15, 0.85), -okraj]; b = [x(0.1, 0.9), H + okraj]; }
    let A0, B0;
    try { A0 = mapa.unproject(a); B0 = mapa.unproject(b); } catch (e) { return null; }
    if (!A0 || !B0) return null;
    // STÁLÁ VÝŠKA letu: nejvyšší terén na dráze + nad. Sledování terénu stoupalo a klesalo
    // nad kopci → pohyb po obrazovce se odchyloval od směru hlavy o 20–30° (let „bokem“)
    let hMax = null;
    for (let i = 0; i <= 6; i++) {
      const u = i / 6, h = vyskaTerenu(A0.lng + (B0.lng - A0.lng) * u, A0.lat + (B0.lat - A0.lat) * u);
      if (h !== null && (hMax === null || h > hMax)) hMax = h;
    }
    if (hMax === null) { const tr = T(); hMax = (tr && tr.elevation) || 0; }
    const alt = hMax + nad;
    let A, B;
    try { A = bodVeVysce(a, alt); B = bodVeVysce(b, alt); } catch (e) { return null; }
    if (!A || !B) return null;
    const kx = 111320 * Math.cos(A.lat * Math.PI / 180);
    const dx = (B.lng - A.lng) * kx, dy = (B.lat - A.lat) * 111320, L = Math.hypot(dx, dy);
    if (!(L > 30) || L > 20000) return null;
    const ptaci = sestava(c.tvar, c.n()).map((q) => Object.assign(q, {
      vel: 0.92 + Math.random() * 0.16, faze: Math.random(), frek: 0.9 + Math.random() * 0.2,
      rezim: 'mava', doba: Math.random() * 2, snimek: 0 }));
    let predni = 0, zadni = 0;
    for (const q of ptaci) { predni = Math.max(predni, q.podel); zadni = Math.max(zadni, -q.podel); }
    const hT = vyskaTerenu(A.lng, A.lat);
    return { druh, c, A, dx, dy, L, luk: nah(0.12) * L, nad, alt, predni, zadni, s: null,
             v: c.v * (0.9 + Math.random() * 0.2), teren: hT === null ? 0 : hT, terenCil: hT === null ? 0 : hT,
             mereni: 0, videtMs: 0, zanikMs: 0, ptaci, x: A.lng, y: A.lat, uhel: Math.atan2(dy, dx) };
  }
  /// střed letu po mírném oblouku A→B (luk = prohnutí v m), před A a za B rovně po tečně
  function polohaLetu(l, s) {
    const u = Math.max(0, Math.min(1, s / l.L));
    const ex = l.dx / l.L, ey = l.dy / l.L, nx = -ey, ny = ex;
    const oblouk = l.luk * 4 * u * (1 - u), tecna = l.luk * 4 * (1 - 2 * u) / l.L;
    let mx = l.dx * u + nx * oblouk, my = l.dy * u + ny * oblouk;
    let tx = ex + nx * tecna, ty = ey + ny * tecna;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const pres = s < 0 ? s : (s > l.L ? s - l.L : 0);
    mx += tx * pres; my += ty * pres;
    return { mx, my, uhel: Math.atan2(ty, tx) };
  }
  /// snímek kresby: 0 rozpjatá → 1 úder vpřed → 2 dole → 3 zdvih vzad; 4 složená (vrabec)
  function snimekPtaka(p, c, dt) {
    p.doba -= dt;
    if (p.doba <= 0) {
      if (c.let === 'poskok') {
        p.rezim = p.rezim === 'mava' ? 'slozeno' : 'mava';
        p.doba = p.rezim === 'mava' ? 0.3 + Math.random() * 0.2 : 0.2 + Math.random() * 0.25;
      } else if (c.let === 'plachti') {
        p.rezim = p.rezim === 'mava' ? 'klouze' : 'mava';
        p.doba = p.rezim === 'mava' ? (2 + Math.floor(Math.random() * 3)) / c.frek : 5 + Math.random() * 7;
        if (p.rezim === 'mava') p.faze = 0;
      } else if (c.klouz) {
        p.rezim = p.rezim === 'mava' ? 'klouze' : 'mava';
        p.doba = p.rezim === 'mava' ? 0.8 + Math.random() * 1.6 : c.klouz * (1 + Math.random() * 2);
      } else p.doba = 1e9;
    }
    if (p.rezim === 'slozeno') return 4;
    if (p.rezim === 'klouze') return 0;
    p.faze = (p.faze + dt * c.frek * p.frek) % 1;
    return Math.floor(p.faze * 4) % 4;
  }
  function krokPtaci(dt, t, st) {
    const z = mapa.getZoom();
    for (let i = lety.length - 1; i >= 0; i--) {
      const l = lety[i];
      const U = rozpetiPx(l.c, z) * metryNaPx(z, l.A.lat);
      if (l.s === null) l.s = -l.predni * U - 2;       // i přední ptáci začínají za okrajem
      l.s += l.v * dt;
      const P = polohaLetu(l, l.s);
      l.x = l.A.lng + P.mx / (111320 * Math.cos(l.A.lat * Math.PI / 180));
      l.y = l.A.lat + P.my / 111320;
      l.uhel = P.uhel;
      if (t > l.mereni) {                              // terén pod letem – jen pro stín
        l.mereni = t + 1000;
        const v = vyskaTerenu(l.x, l.y);
        if (v !== null) l.terenCil = v;
      }
      l.teren += (l.terenCil - l.teren) * Math.min(1, dt * 0.8);
      for (const p of l.ptaci) p.snimek = snimekPtaka(p, l.c, dt);
      if (!l.zanikMs && (!ptaciSmi(st) || z < l.c.od - 0.6)) l.zanikMs = t;   // déšť, oddálení: rychle zmizet
      // konec až za cílem i s ocasem a mimo obrazovku (kdo ujel mapou pryč, taky)
      const nevidet = t - l.videtMs > 2500;
      if ((l.s > l.L + l.zadni * U + 10 && nevidet) || (l.videtMs && nevidet && l.s > 0.4 * l.L)
          || l.s > 3 * l.L + 400 || (l.zanikMs && t - l.zanikMs > 800)) {
        lety.splice(i, 1);
        dalsiLetMs = Math.max(dalsiLetMs, t + 10000 + Math.random() * 15000);
      }
    }
  }
  /// jednotkové vektory vpravo/dopředu na obrazovce pro směr letu v daném bodě a výšce.
  /// Zkrácení náklonem jen NAPŮL (průměr s čistým otočením): v horní části obrazovky
  /// (paprsek skoro podél země) plné zkrácení placatilo ptáky letící napříč (TT 23. 9.)
  function vektoryLetu(lon, lat, h, uhel, kx) {
    const p0 = bod(lon, lat, h), c = Math.cos(uhel) * 5, s = Math.sin(uhel) * 5;
    const pf = bod(lon + c / kx, lat + s / 111320, h), pr = bod(lon + s / kx, lat - c / 111320, h);
    const Fx = pf.x - p0.x, Fy = pf.y - p0.y, Rx = pr.x - p0.x, Ry = pr.y - p0.y;
    const d = Math.max(Math.hypot(Fx, Fy), Math.hypot(Rx, Ry)) || 1, f = Math.hypot(Fx, Fy) || 1;
    const ux = Fx / f, uy = Fy / f;                   // směr letu na obrazovce; vpravo od něj (-uy, ux)
    return { Fx: (Fx / d + ux) / 2, Fy: (Fy / d + uy) / 2, Rx: (Rx / d - uy) / 2, Ry: (Ry / d + ux) / 2, lam: d / 5 };
  }
  function kresliSprite(sada, i, x, y, v, S, alfa) {
    const k = S / sada.m * hustota;                  // S = px obrazovky na jednotku kresby
    ctx.globalAlpha = alfa;
    ctx.setTransform(v.Rx * k, v.Ry * k, -v.Fx * k, -v.Fy * k, x * hustota, y * hustota);
    ctx.drawImage(sada.sn[i], -sada.N / 2, -sada.N / 2);
  }
  function kresliPtaky(t, st) {
    if (!lety.length) return;
    const z = mapa.getZoom();
    const W = platno.width / hustota, H = platno.height / hustota;
    // stín od slunce: délka podle výšky slunce (strop 400 m), slabší při oblačnu
    let smx = 0, smy = 0, stinA = 0, tanEl = 1;
    if (st && typeof st.slunceEl === 'number' && st.slunceEl > 3) {
      tanEl = Math.tan(st.slunceEl * Math.PI / 180);
      const az = (st.slunceAz || 180) * Math.PI / 180;          // odkud svítí (0 = sever)
      smx = -Math.sin(az); smy = -Math.cos(az);
      stinA = 0.18 * (1 - Math.min(0.8, st.oblacnost || 0));
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    for (const l of lety.slice().sort((a, b) => a.nad - b.nad)) {
      const sp = spriteDruhu(l.druh);
      const mPx = metryNaPx(z, l.y), rozPx = rozpetiPx(l.c, z), U = rozPx * mPx;
      const kx = 111320 * Math.cos(l.y * Math.PI / 180);
      const ex = Math.cos(l.uhel), ey = Math.sin(l.uhel);
      const alfa = l.zanikMs ? Math.max(0, 1 - (t - l.zanikMs) / 800) : 1;
      const pozice = [];
      for (const p of l.ptaci) {
        const po = p.podel + p.kmit * Math.sin(p.f1 + t / 1000 * p.w1);
        const bo = p.bok + p.kmit * Math.sin(p.f2 + t / 1000 * p.w2);
        pozice.push([l.x + (po * ex + bo * ey) * U / kx, l.y + (po * ey - bo * ex) * U / 111320, p]);
      }
      if (stinA > 0.02) {
        const dS = Math.min(400, Math.max(2, l.alt - l.teren) / tanEl), ox = smx * dS / kx, oy = smy * dS / 111320;
        const vs = vektoryLetu(l.x + ox, l.y + oy, l.teren, l.uhel, kx);
        const S = rozPx / 100 * Math.max(0.55, Math.min(1.5, vs.lam * mPx)) * 0.95;
        for (const [lon, lat, p] of pozice) {
          const q = bod(lon + ox, lat + oy, l.teren);
          kresliSprite(sp.stin, p.snimek, q.x, q.y, vs, S * p.vel, stinA * alfa);
        }
      }
      // perspektiva: vzdálenější (nahoře) menší, bližší větší – jako všechno na mapě
      const vz = vektoryLetu(l.x, l.y, l.alt, l.uhel, kx);
      const S = rozPx / 100 * Math.max(0.55, Math.min(1.5, vz.lam * mPx));
      let videt = false;
      for (const [lon, lat, p] of pozice) {
        const q = bod(lon, lat, l.alt);
        if (q.x > -40 && q.x < W + 40 && q.y > -40 && q.y < H + 40) videt = true;
        const vel = S * p.vel;
        kresliSprite(vel * 100 * hustota < 45 ? sp.m : sp.v, p.snimek, q.x, q.y, vz, vel, alfa);
      }
      if (videt) l.videtMs = t;
    }
    ctx.setTransform(hustota, 0, 0, hustota, 0, 0);
    ctx.globalAlpha = 1;
  }
  function krokVoda(t, st) {
    for (let i = krouzky.length - 1; i >= 0; i--) if ((t - krouzky[i].t0) / 1000 > krouzky[i].zivot) krouzky.splice(i, 1);
    if (mapa.getZoom() < VODA_OD_Z || !vodni.length || vodaZamrzla(st) || t < dalsiRybaMs) return;
    const f = Math.min(1.6, 0.3 + vodni.length * 0.03);               // ryb za sekundu
    dalsiRybaMs = t + (-Math.log(1 - Math.random()) / f) * 1000;
    if (krouzky.length >= MAX_KROUZKU) return;
    const k = vodni[Math.floor(Math.random() * vodni.length)];
    if (k.h === null || !k.vidi) return;
    // engine 341 (výtka T: „žbluňknutí na řece lezou i na louku“): poloměr (m, už se
    // stylizací) nejvýš 0,9 dosahu vody u kotvy (worker: voda do 8 směrů)
    const rMaxM = Math.min(k.r * 0.9, (4 + Math.random() * 3) * 2.2);
    krouzky.push({ k, t0: t, zivot: 2.6, rMaxM, pocet: Math.random() < 0.5 ? 3 : 2 });
  }
  /// kroužek = tmavší „údolí“ pod světlou linkou (na malované vodě s bílými vlnkami
  /// samotná bílá linka zanikla – TT 23. 9.) + krátké šplouchnutí uprostřed
  function kresliVodu(t, st) {
    if (!krouzky.length) return;
    const zplosteni = Math.max(0.35, Math.cos(mapa.getPitch() * Math.PI / 180));
    const zakl = noc(st) ? 0.4 : 0.85;
    for (const r of krouzky) {
      const a = (t - r.t0) / 1000, k = r.k;
      const pxm = k.pxNaM || 1;
      if (a < 0.3) {                                   // šplouchnutí
        ctx.globalAlpha = zakl * (1 - a / 0.3);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        const rs = Math.min(1.4, r.rMaxM * 0.3) * pxm;
        ctx.ellipse(k.sx, k.sy, rs, rs * zplosteni, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let i = 0; i < r.pocet; i++) {
        const ai = a - i * 0.35, zivotI = r.zivot - i * 0.35;
        if (ai <= 0 || ai >= zivotI) continue;
        const rx = Math.min(46, r.rMaxM * Math.pow(ai / zivotI, 0.7) * pxm);
        if (rx < 0.8) continue;
        const alfa = zakl * (1 - ai / zivotI);
        ctx.lineWidth = 2.2;
        ctx.globalAlpha = alfa * 0.45;
        ctx.strokeStyle = '#0d4a52';
        ctx.beginPath();
        ctx.ellipse(k.sx, k.sy + 1, rx, rx * zplosteni, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = alfa;
        ctx.strokeStyle = '#f4fbff';
        ctx.beginPath();
        ctx.ellipse(k.sx, k.sy, rx, rx * zplosteni, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
  // ------------------------------------------------------------------ vítr: kudrlinky
  // ⭐ engine 342 (výtka T 23. 9.: „vánek se nemaluje, stále letí vcelku pár čárek – ať se
  // kudrlinka NAMALUJE, začátek postupuje a konec mizí“): kudrlinky přešly z DOM/SVG
  // (krok 10 Hz, prvek letěl po obrazovce, na rovné části křivky to byly letící čárky) sem
  // na plátno: stojí V MAPĚ (kotva lon/lat), jen se nepatrně unáší po větru, a tah se kreslí
  // jako štětec – silnější hlava postupuje po čáře a zatočí se do spirály, tenký ocas ji
  // dohání a mizí. Síla, směr a rytmus poryvů dál řídí vitr.js (Vitr.stupen, poryvy).
  const kudrlinky = [];
  /// křivka v jednotkách (~px při měřítku 1): mírně stoupající náběh a spirála nahoru
  function krivkaKudrlinky(L, R0, R1, otacek, dy) {
    const b = [];
    for (let i = 0; i <= 14; i++) {
      const u = i / 14;
      b.push([u * L, dy - Math.sin(u * Math.PI) * 1.1 - u * u * 2.2]);
    }
    const E = b[b.length - 1], cx = E[0], cy = E[1] - R0;
    const n = Math.ceil(otacek * 36);
    for (let i = 1; i <= n; i++) {
      const u = i / n, th = Math.PI / 2 - u * otacek * 2 * Math.PI, r = R0 + (R1 - R0) * u;
      b.push([cx + r * Math.cos(th), cy + r * Math.sin(th)]);
    }
    const d = [0];
    for (let i = 1; i < b.length; i++) d.push(d[i - 1] + Math.hypot(b[i][0] - b[i - 1][0], b[i][1] - b[i - 1][1]));
    return { b, d, P: d[d.length - 1] };
  }
  const KRIVKY = (() => {
    const hlavni = krivkaKudrlinky(34, 7.5, 1.8, 1.45, 0), spodni = krivkaKudrlinky(24, 4.6, 1.4, 1.1, 7);
    // střed kresby do počátku (kotva je uprostřed kudrlinky)
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const k of [hlavni, spodni]) for (const [x, y] of k.b) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const sx = (x0 + x1) / 2, sy = (y0 + y1) / 2;
    for (const k of [hlavni, spodni]) for (const q of k.b) { q[0] -= sx; q[1] -= sy; }
    spodni.b.forEach((q) => { q[0] += 4; });
    return [hlavni, spodni];
  })();
  /// body křivky mezi délkami a a b (konce dopočítané)
  function usekKrivky(k, a, b) {
    const out = [];
    const bodNa = (s) => {
      let i = 1;
      while (i < k.d.length - 1 && k.d[i] < s) i++;
      const u = (s - k.d[i - 1]) / Math.max(1e-6, k.d[i] - k.d[i - 1]);
      return [k.b[i - 1][0] + (k.b[i][0] - k.b[i - 1][0]) * u, k.b[i - 1][1] + (k.b[i][1] - k.b[i - 1][1]) * u];
    };
    out.push(bodNa(a));
    for (let i = 0; i < k.d.length; i++) if (k.d[i] > a && k.d[i] < b) out.push(k.b[i]);
    out.push(bodNa(b));
    return out;
  }
  /// poryv z vitr.js: `pocet` kudrlinek, síla st (0,5/1/2), kam vítr fouká (° od severu)
  function poryv(pocet, st, kamDeg) {
    if (!mapa || !platno || !smi()) return false;
    const kont = mapa.getContainer(), W = kont.clientWidth, H = kont.clientHeight;
    const t = performance.now();
    const fi = (90 - kamDeg) * Math.PI / 180;          // směr ve světě (0 = východ, proti hodinám)
    const tma = noc(pocasi(t));
    for (let i = 0; i < pocet; i++) {
      let ll = null;
      try { ll = mapa.unproject([W * (0.15 + Math.random() * 0.7), H * (0.2 + Math.random() * 0.62)]); } catch (e) { ll = null; }
      if (!ll) continue;
      const h = vyskaTerenu(ll.lng, ll.lat);
      kudrlinky.push({
        lon: ll.lng, lat: ll.lat, h: h === null ? 0 : h, fi,
        t0: t + i * (250 + Math.random() * 350),       // ať se nemalují naráz
        zivot: 3000 + Math.random() * 900 + (st >= 2 ? 300 : 0),
        mer: (0.95 + Math.random() * 0.4 + (st >= 2 ? 0.2 : 0)) * 1.3,
        drift: st >= 2 ? 12 : (st >= 1 ? 8 : 5),       // px/s po větru – maluje se na místě
        alfa: (tma ? 0.45 : 0.92) * (st < 1 ? 0.85 : 1),
      });
    }
    while (kudrlinky.length > 8) kudrlinky.shift();
    aktivita();
    return true;
  }
  function kresliVitr(t) {
    for (let i = kudrlinky.length - 1; i >= 0; i--) if (t - kudrlinky[i].t0 > kudrlinky[i].zivot) kudrlinky.splice(i, 1);
    if (!kudrlinky.length) return;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const k of kudrlinky) {
      const a = t - k.t0;
      if (a < 0) continue;
      const f = a / k.zivot;
      const kx = 111320 * Math.cos(k.lat * Math.PI / 180);
      const p0 = bod(k.lon, k.lat, k.h);
      const p1 = bod(k.lon + Math.cos(k.fi) * 10 / kx, k.lat + Math.sin(k.fi) * 10 / 111320, k.h);
      let ux = p1.x - p0.x, uy = p1.y - p0.y;
      const ul = Math.hypot(ux, uy) || 1;
      ux /= ul; uy /= ul;
      // kolmice „nahoru“: spirála se vždy točí vzhůru (při větru doleva zrcadlově)
      let vx = -uy, vy = ux;
      if (vy < 0 || (Math.abs(vy) < 1e-3 && ux < 0)) { vx = -vx; vy = -vy; }
      const posun = k.drift * a / 1000;
      const bx = p0.x + ux * posun, by = p0.y + uy * posun, s = k.mer;
      const doz = f < 0.9 ? 1 : Math.max(0, 1 - (f - 0.9) / 0.1);
      const alfa = k.alfa * Math.min(1, a / 200) * doz;
      if (alfa <= 0.01) continue;
      ctx.setTransform(hustota * s * ux, hustota * s * uy, hustota * s * vx, hustota * s * vy, hustota * bx, hustota * by);
      KRIVKY.forEach((kr, j) => {
        // hlava a ocas po křivce: úsek 62 % délky, hlava od začátku až za konec (smoothstep)
        const fj = Math.max(0, Math.min(1, (a - j * 160) / k.zivot));
        const u = fj * fj * (3 - 2 * fj), S = kr.P * 0.62;
        const hlava = Math.min(kr.P, u * (kr.P + S)), ocas = Math.max(0, u * (kr.P + S) - S);
        if (hlava - ocas < 0.5) return;
        // štětec: od ocasu k hlavě sílí (5 dílů), pod bílou tmavý lem kvůli čitelnosti
        const N = 5, w0 = 0.5, w1 = j ? 1.6 : 2.1;
        for (const pruchod of [0, 1]) {
          ctx.strokeStyle = pruchod ? 'rgba(255,255,255,' + alfa.toFixed(3) + ')' : 'rgba(30,40,40,' + (alfa * 0.3).toFixed(3) + ')';
          for (let d = 0; d < N; d++) {
            const sa = ocas + (hlava - ocas) * d / N, sb = ocas + (hlava - ocas) * (d + 1) / N + 0.3;
            const w = (w0 + (w1 - w0) * (d + 0.5) / N) / s;
            ctx.lineWidth = pruchod ? w : w + 1.1 / s;
            const body = usekKrivky(kr, sa, Math.min(hlava, sb));
            ctx.beginPath();
            ctx.moveTo(body[0][0], body[0][1]);
            for (let q = 1; q < body.length; q++) ctx.lineTo(body[q][0], body[q][1]);
            ctx.stroke();
          }
        }
      });
    }
    ctx.setTransform(hustota, 0, 0, hustota, 0, 0);
  }
  function neco(st) {
    if (oblacky.length || krouzky.length || lety.length || kudrlinky.length) return true;
    const z = mapa.getZoom();
    if (z >= KOUR_OD_Z && kominy.length && topnaSezona(st)) return true;
    return z >= VODA_OD_Z && vodni.length > 0 && !vodaZamrzla(st);
  }

  // ------------------------------------------------------------------ smyčka
  function pohybMapy() {
    try { return (mapa.isMoving && mapa.isMoving()) || (typeof prstNaMape === 'function' && prstNaMape()); }
    catch (e) { return false; }
  }
  function vykresli(t) {
    const dt = Math.min(0.1, Math.max(0.001, (t - posledni) / 1000));
    posledni = t;
    const t0 = performance.now();
    const st = pocasi(t);
    promitniKotvy();
    krokKour(t, st);
    krokPtaci(dt, t, st);
    krokVoda(t, st);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, platno.width, platno.height);
    ctx.setTransform(hustota, 0, 0, hustota, 0, 0);
    kresliVodu(t, st);
    kresliKour(t, st);
    kresliVitr(t);
    kresliPtaky(t, st);
    prazdne = false;
    // hlídač ceny snímku: dlouhodobě > 6 ms → méně komínů, < 2,5 ms 10 s → zpět
    const cena = performance.now() - t0;
    cenaEma = cenaEma * 0.9 + cena * 0.1;
    if (cenaEma > 6 && uroven < UROVNE.length - 1) { uroven++; cenaEma = 3; kotvySig = ''; levneOd = t; }
    else if (cenaEma < 2.5 && uroven > 0) { if (!levneOd) levneOd = t; else if (t - levneOd > 10000) { uroven--; levneOd = t; kotvySig = ''; } }
    else if (cenaEma >= 2.5) levneOd = 0;
    return st;
  }
  // TAKT: v klidu 24 Hz, po minutě bez pohybu 12 Hz (každý snímek WebView = snímek
  // Flutteru, baterie: 30 Hz napořád stálo v klidu +57 % jádra – TT 23. 9.).
  // ⭐ engine 341: PŘI POHYBU MAPY se kreslí v události `render` (hned po snímku mapy,
  // s aktuální kamerou) – z vlastního rAF před vykreslením mapy by kouř a kroužky
  // o snímek zaostávaly a při tahu „plavaly“ (jako káně, výtka T 23. 9.)
  function snimek(t) {
    raf = 0;
    if (!smi()) { vycisti(true); return; }
    if (pohybMapy()) { naplanuj(); return; }
    // ptáci a vítr vždy 24 Hz (mávání i tah štětce při 12 Hz trhají); kouř a kroužky po minutě klidu 12 Hz
    const interval = t - aktivitaMs > 60000 && !lety.length && !kudrlinky.length ? 83 : 42;
    if (t - posledni < interval - 3) { naplanuj(); return; }
    const st = vykresli(t);
    if (neco(st)) naplanuj(); else vycisti(false);
  }
  function naRender() {
    if (!mapa || !platno || !pohybMapy() || !smi()) return;
    const t = performance.now();
    if (!neco(pocasi(t))) { vycisti(false); return; }
    vykresli(t);
  }
  function kontrola() {
    if (!smi()) { vycisti(true); return; }
    obnovKotvy(false);
    // výšky kotev, pro které ještě nebyl DEM (dlaždice terénu dojela později)
    for (const a of kominy.concat(vodni)) {
      if (a.h === null) { a.h = vyskaKotvy(a); if (a.h !== null) kamSig = ''; }
    }
    const t = performance.now();
    const st = pocasi(t);
    if (lety.length < MAX_LETU && (t > dalsiLetMs || vynut().ptaciHned) && mapa.getZoom() >= PTACI_OD_Z && ptaciSmi(st)) {
      const druh = vynut().druh || vyberDruh(mapa.getZoom(), lety.map((l) => l.druh));
      const l = druh && PTACI[druh] ? novyLet(druh) : null;
      if (l) { lety.push(l); posledniDruh = druh; dalsiLetMs = t + 20000 + Math.random() * 25000; }
      else dalsiLetMs = t + 10000;
      if (window.__animaceVynut) window.__animaceVynut.ptaciHned = false;
    }
    if (neco(st)) naplanuj();
  }

  function pripoj(m) {
    if (mapa === m && platno && platno.isConnected) return;
    mapa = m;
    if (!zajistiPlatno()) return;
    if (!pripoj.hotovo) {
      pripoj.hotovo = true;
      mapa.on('move', aktivita);
      mapa.on('render', naRender);
      mapa.on('moveend', () => obnovKotvy(false));
      mapa.on('resize', velikost);
      try { mapa.getCanvas().addEventListener('touchstart', aktivita, { passive: true }); } catch (e) { /* nic */ }
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') aktivita(); });
    }
    if (!kontrolaT) kontrolaT = setInterval(kontrola, 2000);
    aktivita();
  }
  return {
    pripoj,
    poryv,
    _ladeni: {
      stav: () => ({ bezi: !!raf, smi: smi(), kominu: kominy.length, vodnich: vodni.length, oblacku: oblacky.length,
                     krouzku: krouzky.length, lety: lety.map((l) => l.druh + '×' + l.ptaci.length).join(','),
                     uroven, cenaMs: +cenaEma.toFixed(2),
                     hustota, platno: platno ? platno.width + 'x' + platno.height : null }),
      // předskok 0–1 = kolik z cesty k cíli má let už za sebou (0,5 ≈ uprostřed obrazovky)
      hejnoTed: (predskok, druh) => {
        if (!mapa) return false;
        druh = druh || vyberDruh(mapa.getZoom(), []) || 'vrana';
        const l = novyLet(druh);
        if (!l) return false;
        lety.length = 0;
        lety.push(l);
        l.s = (predskok || 0) * l.L;
        naplanuj();
        return druh + '×' + l.ptaci.length;
      },
      druhy: () => Object.keys(PTACI),
      kudrlinky: () => kudrlinky.map((k) => { const p = bod(k.lon, k.lat, k.h); return [Math.round(p.x), Math.round(p.y), +((performance.now() - k.t0) / k.zivot).toFixed(2)]; }),
      nahledDruhu: (druh, N) => upecDruh(druh, N || 96, (N || 96) / 106, false).snimky.map((c) => c.toDataURL ? c.toDataURL() : null),
      krouzkyPoloha: () => krouzky.map((r) => [Math.round(r.k.sx), Math.round(r.k.sy), +((performance.now() - r.t0) / 1000).toFixed(2)]),
      hejnoPoloha: () => {
        if (!lety.length) return null;
        const l = lety[0], p = bod(l.x, l.y, l.alt);
        const v = vektoryLetu(l.x, l.y, l.alt, l.uhel, 111320 * Math.cos(l.y * Math.PI / 180));
        return { x: Math.round(p.x), y: Math.round(p.y), uleteno: Math.round(l.s), delka: Math.round(l.L),
                 teren: Math.round(l.teren), druh: l.druh, n: l.ptaci.length,
                 hlava: Math.round(Math.atan2(v.Fy, v.Fx) * 180 / Math.PI) };
      },
    },
  };
})();
window.AnimaceNadMapou = AnimaceNadMapou;
