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
 *  2. HEJNA PTÁKŮ – ve dne bez deště/sněhu/mlhy, od z13,5, jednou za 35–80 s přeletí
 *     6–12 ptáků ve volném V 60–100 m nad terénem, se stínem na zemi.
 *  3. KROUŽKY NA VODĚ – kotvy sv:4 (body ve vodních plochách), od z15, nad nulou;
 *     tu a tam „ryba“: 2–3 soustředné kroužky zploštělé náklonem.
 * Ladění (CDP): `window.__animaceVynut = {kour: true, ptaci: true}`,
 * `AnimaceNadMapou._ladeni.stav()`, `AnimaceNadMapou._ladeni.hejnoTed()`.
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
  let hejno = null, dalsiHejnoMs = performance.now() + 15000 + Math.random() * 30000;
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
    if (uplne) { oblacky.length = 0; krouzky.length = 0; hejno = null; }
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
  function noveHejno() {
    // ⭐ engine 341 (výtka T: „ptáci ať se takto nerozplynou“): hejno VLÉTNE zpoza
    // jednoho okraje obrazovky a VYLÉTNE za druhým – dřív se na začátku a konci
    // dráhy prolínalo do ztracena uprostřed obrazovky. Vlevo↔vpravo ve spodních
    // 2/3 výšky (nahoře je s náklonem daleko obzor); 90 px za okrajem (rozpětí
    // hejna). unproject dvakrát za hejno (~1×/min) nevadí.
    const kont = mapa.getContainer(), W = kont.clientWidth, H = kont.clientHeight;
    const zleva = Math.random() < 0.5, okraj = 90;
    let A = null, B = null;
    try {
      A = mapa.unproject([zleva ? -okraj : W + okraj, H * (0.35 + Math.random() * 0.5)]);
      B = mapa.unproject([zleva ? W + okraj : -okraj, H * (0.3 + Math.random() * 0.55)]);
    } catch (e) { return null; }
    if (!A || !B) return null;
    const kx = 111320 * Math.cos(A.lat * Math.PI / 180), ky = 111320;
    const dx = (B.lng - A.lng) * kx, dy = (B.lat - A.lat) * ky;
    const delka = Math.hypot(dx, dy);
    if (!(delka > 20)) return null;
    const smer = Math.atan2(dy, dx);
    const n = 6 + Math.floor(Math.random() * 7);
    const ptaci = [];
    let ocas = 0;
    for (let i = 0; i < n; i++) {
      const j = i - (n - 1) / 2;
      const podel = -Math.abs(j) * 7 + (Math.random() - 0.5) * 3;
      ocas = Math.max(ocas, -podel);
      ptaci.push({ podel, bok: j * 6 + (Math.random() - 0.5) * 2, vel: 0.9 + Math.random() * 0.2,
                   faze: Math.random() * 6.28, frek: 3 + Math.random(), klouze: false, prepni: Math.random() * 3 });
    }
    const hT = vyskaTerenu(A.lng, A.lat);
    return { x: A.lng, y: A.lat, smer, delka, ocas,
             v: 16 + Math.random() * 6, nad: 60 + Math.random() * 40,     // špačci/holubi ~20 m/s
             teren: hT === null ? 300 : hT, terenCil: hT === null ? 300 : hT, mereni: 0, uleteno: 0, ptaci };
  }
  function krokPtaci(dt, t, st) {
    if (!hejno) return;
    const h = hejno;
    const kx = 111320 * Math.cos(h.y * Math.PI / 180);
    h.x += Math.cos(h.smer) * h.v * dt / kx;
    h.y += Math.sin(h.smer) * h.v * dt / 111320;
    h.uleteno += h.v * dt;
    if (t > h.mereni) {
      h.mereni = t + 2000;
      const v = vyskaTerenu(h.x, h.y);
      if (v !== null) h.terenCil = v;
    }
    h.teren += (h.terenCil - h.teren) * Math.min(1, dt * 0.4);
    for (const p of h.ptaci) {
      p.prepni -= dt;
      if (p.prepni < 0) { p.klouze = !p.klouze; p.prepni = p.klouze ? 1 + Math.random() * 2 : 2 + Math.random() * 3; }
    }
    // konec, až je za okrajem i OCAS hejna (rozestupy rostou se zoomem → rezerva)
    if (h.uleteno > h.delka + h.ocas * 4 + 60 || !ptaciSmi(st) || mapa.getZoom() < PTACI_OD_Z - 0.5) {
      hejno = null;
      dalsiHejnoMs = t + 35000 + Math.random() * 45000;
    }
  }
  /// ⭐ engine 341 („ptáky udělej hezčí“): PLNÁ silueta – dvě srpková křídla (u ramene
  /// silná, ke špičce tenká) a malé tělo, VZPŘÍMENĚ jako v ilustrovaných mapách
  /// (natočená podle směru letu vypadala jako klikyháky); mávání zvedá ramena a
  /// spouští špičky, mírný náklon podle vodorovné složky letu
  function kresliPtaka(x, y, uhel, s, mach, barva, alfa) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(0.3 * Math.cos(uhel));
    ctx.globalAlpha = alfa;
    ctx.fillStyle = barva;
    const rameno = -s * (0.2 + 0.18 * mach);       // výška ramen (záporně = nahoru)
    const spicka = s * (0.03 - 0.13 * mach);        // špičky křídel
    const tl = s * 0.075;                            // tloušťka křídla u ramene
    ctx.beginPath();
    ctx.moveTo(0, s * 0.02);
    ctx.quadraticCurveTo(-s * 0.2, rameno - tl, -s * 0.5, spicka);        // náběžná hrana
    ctx.quadraticCurveTo(-s * 0.24, rameno + tl * 1.4, -s * 0.03, s * 0.1); // odtoková hrana
    ctx.lineTo(s * 0.03, s * 0.1);
    ctx.quadraticCurveTo(s * 0.24, rameno + tl * 1.4, s * 0.5, spicka);
    ctx.quadraticCurveTo(s * 0.2, rameno - tl, 0, s * 0.02);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();                                  // tělo a hlava
    ctx.ellipse(0, s * 0.07, s * 0.045, s * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  function kresliPtaky(t, st) {
    if (!hejno) return;
    const h = hejno, z = mapa.getZoom();
    const s = 17 * Math.max(0.55, Math.min(1.9, 0.55 + (z - 13.5) * 0.35));
    const ex = Math.cos(h.smer), ey = Math.sin(h.smer);
    const kx = 111320 * Math.cos(h.y * Math.PI / 180), ky = 111320;
    const p0 = bod(h.x, h.y, h.teren + h.nad), p1 = bod(h.x + ex * 30 / kx, h.y + ey * 30 / ky, h.teren + h.nad);
    const uhel = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    // stín: od slunce, délka podle výšky slunce (strop 400 m)
    let sx = 0, sy = 0, stin = 0;
    if (st && typeof st.slunceEl === 'number' && st.slunceEl > 3) {
      const d = Math.min(400, h.nad / Math.tan(st.slunceEl * Math.PI / 180));
      const az = (st.slunceAz || 180) * Math.PI / 180;           // odkud svítí (0 = sever)
      sx = -Math.sin(az) * d; sy = -Math.cos(az) * d;
      stin = 0.16 * (1 - Math.min(0.8, st.oblacnost || 0));
    }
    // rozestupy v hejnu aspoň ~0,8 velikosti ptáka na obrazovce (jinak se na nízkém
    // zoomu slijí do chuchvalce a na vyšším se překrývají)
    const mPx = 78271.52 / Math.pow(2, z) * Math.cos(h.y * Math.PI / 180);
    const roz = Math.max(1, 0.8 * s * mPx / 6);
    for (const p of h.ptaci) {
      const dx = (p.podel * ex - p.bok * ey) * roz, dy = (p.podel * ey + p.bok * ex) * roz;
      const lon = h.x + dx / kx, lat = h.y + dy / ky;
      const mach = p.klouze ? 0.1 : Math.sin(p.faze + t / 1000 * p.frek * 6.283);
      if (stin > 0.02) {
        const q = bod(lon + sx / kx, lat + sy / ky, h.teren);
        kresliPtaka(q.x, q.y, uhel, s * 0.9 * p.vel, mach, '#000', stin);
      }
      const q = bod(lon, lat, h.teren + h.nad + 1.5 * Math.sin(p.faze + t / 900));
      kresliPtaka(q.x, q.y, uhel, s * p.vel, mach, '#2c2621', 0.9);
    }
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
  function neco(st) {
    if (oblacky.length || krouzky.length || hejno) return true;
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
    const interval = t - aktivitaMs > 60000 ? 83 : 42;
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
    if (!hejno && (t > dalsiHejnoMs || vynut().ptaciHned) && mapa.getZoom() >= PTACI_OD_Z && ptaciSmi(st)) {
      hejno = noveHejno();
      if (!hejno) dalsiHejnoMs = t + 10000;
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
    _ladeni: {
      stav: () => ({ bezi: !!raf, smi: smi(), kominu: kominy.length, vodnich: vodni.length, oblacku: oblacky.length,
                     krouzku: krouzky.length, hejno: hejno ? hejno.ptaci.length : 0, uroven, cenaMs: +cenaEma.toFixed(2),
                     hustota, platno: platno ? platno.width + 'x' + platno.height : null }),
      // předskok 0–1 = kolik z cesty k cíli má hejno už za sebou (0,9 ≈ skoro uprostřed obrazovky)
      hejnoTed: (predskok) => {
        if (!mapa) return false;
        hejno = noveHejno();
        if (!hejno) return false;
        const d = (predskok || 0) * hejno.delka, kx = 111320 * Math.cos(hejno.y * Math.PI / 180);
        hejno.x += Math.cos(hejno.smer) * d / kx; hejno.y += Math.sin(hejno.smer) * d / 111320; hejno.uleteno = d;
        naplanuj();
        return true;
      },
      krouzkyPoloha: () => krouzky.map((r) => [Math.round(r.k.sx), Math.round(r.k.sy), +((performance.now() - r.t0) / 1000).toFixed(2)]),
      hejnoPoloha: () => {
        if (!hejno) return null;
        const p = bod(hejno.x, hejno.y, hejno.teren + hejno.nad);
        return { x: Math.round(p.x), y: Math.round(p.y), uleteno: Math.round(hejno.uleteno), delka: Math.round(hejno.delka), teren: Math.round(hejno.teren) };
      },
    },
  };
})();
window.AnimaceNadMapou = AnimaceNadMapou;
