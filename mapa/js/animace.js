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
 *  2. PTÁCI (engine 342: DRUHY, 343: anatomická kresba a velikost v metrech) – ve dne
 *     bez deště/sněhu/mlhy; kachna (i samice), vrabec (i samice), špaček, holub, hřivnáč,
 *     vrána, volavka, čáp, labuť, husa kreslení shora a natočení podle směru letu;
 *     rozpětí v metrech světa (promítá se jako stromy), druh podle okolí, měsíce a toho,
 *     zda je při daném zoomu vidět (≥ 5 px); sami, v párech, v řadě, v klínu i v mračnu;
 *     nejvýš 2 lety naráz, další za 20–45 s; stín na zemi.
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
    return true;
  }
  // ⭐ engine 344: po 5 min bez dotyku a pohybu kamery se nic nového nerodí (kouř, kroužky,
  // lety, vítr) a běžící doběhnou; plátno se NEMAŽE – sedící sovy zůstanou na stromech
  // (dřív se vše smazalo = věci by „zmizely“, výtka T k mizení)
  const necinny = () => performance.now() - aktivitaMs >= NECINNOST_MS;
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
  /// noční lety: od západu (slunce < 1°) do svítání, ne v dešti/sněhu/bouřce
  function nocniSmi(st) {
    if (vynut().noc) return true;
    if (!st || typeof st.slunceEl !== 'number' || st.slunceEl >= 1) return false;
    return !(st.druh && /dest|snih|bourka/.test(String(st.druh)));
  }
  /// sovy sedí na stromech po setmění (slunce < −2°)
  const sovySedi = (st) => !!(vynut().sovy || (st && typeof st.slunceEl === 'number' && st.slunceEl < -2));
  /// krok noci 0–3 (Pocasi.stavNoci, jako překryv noci přes krajinu) → nádech kresby ptáků
  let krokNociKes = 0, krokNociMs = -1e9;
  function tonNoci(t) {
    if (vynut().ton != null) return vynut().ton;
    if (t - krokNociMs > 2000) {
      krokNociMs = t;
      try { krokNociKes = (typeof Pocasi !== 'undefined' && Pocasi.stavNoci) ? (Pocasi.stavNoci() | 0) : 0; } catch (e) { krokNociKes = 0; }
    }
    return Math.max(0, Math.min(3, krokNociKes));
  }
  const SILA_TONU = [0, 0.15, 0.32, 0.48];      // noc: ptáci tlumení jako krajina (TT 23. 9.: sluka a sova pálená svítily)

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
    if (uplne) { oblacky.length = 0; krouzky.length = 0; lety.length = 0; kudrlinky.length = 0; sedici = []; sediciSig = ''; }
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
    if (mapa.getZoom() < KOUR_OD_Z || !topnaSezona(st) || necinny()) return;
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
  // ------------------------------------------------------------------ ptáci: anatomická kresba
  // ⭐ engine 343 (výtka T 23. 9. večer: „modely ptáků více realistické dle jejich vzhledu,
  // některé jsou odfláklé“): křídlo se staví jako skutečné – rameno (paže) k zápěstí, ruka
  // k špičce, ruční letky vějířem (u vran, volavek a čápů roztažené „prsty“), loketní letky
  // s vroubkovanou odtokovou hranou, velké krovky; vzory druhů se kreslí OŘÍZNUTÉ tvarem
  // křídla. Mávání = elevace paže a ruky (průmět shora se zkrátí) a sklopení ruky v zápěstí
  // při zdvihu. Jednotky: rozpětí v klouzání = 100, pták letí nahoru (−y), střed těla v 0.
  // Fáze: [elevace paže, elevace ruky navíc, natočení paže dozadu, sklopení ruky dozadu] (rad)
  const FAZE_LETU = [
    [0.12, 0.06, 0, 0],            // 0 rozpjatá (klouzání, začátek úderu)
    [-0.28, -0.2, -0.1, -0.12],    // 1 úder dolů, křídla vpředu
    [-0.72, -0.55, -0.06, -0.05],  // 2 konec úderu (shora nejkratší)
    [0.42, 0.34, 0.12, 0.62],      // 3 zdvih: ruka sklopená dozadu v zápěstí
  ];
  const D = (a) => a * Math.PI / 180;
  function lerp(a, b, t) { return a + (b - a) * t; }
  function bodNa(p, q, t) { return [lerp(p[0], q[0], t), lerp(p[1], q[1], t)]; }
  function polyline(g, b, zavri) {
    g.moveTo(b[0][0], b[0][1]);
    for (let i = 1; i < b.length; i++) g.lineTo(b[i][0], b[i][1]);
    if (zavri) g.closePath();
  }
  function hladka(g, b, zavri) {                 // Catmull-Rom → Bézier přes body
    const n = b.length;
    g.moveTo(b[0][0], b[0][1]);
    for (let i = 0; i < (zavri ? n : n - 1); i++) {
      const p0 = b[(i - 1 + n) % n], p1 = b[i], p2 = b[(i + 1) % n], p3 = b[(i + 2) % n];
      const q0 = zavri || i > 0 ? p0 : p1, q3 = zavri || i < n - 2 ? p3 : p2;
      g.bezierCurveTo(p1[0] + (p2[0] - q0[0]) / 6, p1[1] + (p2[1] - q0[1]) / 6,
                      p2[0] - (q3[0] - p1[0]) / 6, p2[1] - (q3[1] - p1[1]) / 6, p2[0], p2[1]);
    }
    if (zavri) g.closePath();
  }
  /// Geometrie PRAVÉHO křídla pro fázi (levé = zrcadlo x). Obrys = náběžná hrana
  /// (rameno → zápěstí → ruka), zaoblená/špičatá špička, odtoková hrana ruky a vroubkovaná
  /// odtoková hrana paže (loketní letky). U „prstů“ končí obrys ruky u základů prstů
  /// a prsty (vnější ruční letky) se kreslí zvlášť s mezerami.
  function kridloGeom(K, faze, amp) {
    const ea = faze[0] * amp, eh = faze[1] * amp, psi = faze[2] * amp, dd = faze[3] * amp;
    const ca = Math.cos(ea), ch = Math.cos(ea + eh);
    const cp = Math.cos(psi), sp = Math.sin(psi);
    const arm = (x, y) => [K.ramX + (x * cp - y * sp) * ca, K.ramY + (x * sp + y * cp)];
    const zapP = [K.paze, -K.predZap], zapZ = [K.paze - 1.2, -K.predZap + K.hlZap];
    const Zp = arm(zapP[0], zapP[1]), Zz = arm(zapZ[0], zapZ[1]);
    const sip = K.sipRuky + dd, cs = Math.cos(sip), ss = Math.sin(sip);
    // ruka: u podél, v dozadu kolmo; počátek v zápěstí
    const ruka = (u, v) => {
      const x = u * cs - v * ss, y = u * ss + v * cs;
      return [Zp[0] + (x * cp - y * sp) * ch, Zp[1] + (x * sp + y * cp)];
    };
    const R = K.ruka;
    // hloubka ruky podél (od zápěstí po špičku)
    const hl = (u) => {
      const t = u / R;
      if (K.kulata) return K.hlZap * (1 - 0.25 * t) * Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, (t - 0.55) / 0.45), 2.2))) + K.tipHl * 0.05;
      return lerp(K.hlZap, K.tipHl, Math.pow(t, 0.9));
    };
    const fz = K.prsty ? K.prstyDel : 0;                       // podíl ruky, který tvoří prsty
    const Rk = R * (1 - fz);                                   // kde končí „plná“ ruka
    const LE = [arm(0, 0), arm(K.paze * 0.5, -K.predZap * 0.75 - K.vyp), Zp];
    for (let i = 1; i <= 6; i++) { const u = Rk * i / 6; LE.push(ruka(u, -K.vypRuky * Math.sin(Math.PI * u / R))); }
    const TE = [];
    if (!K.prsty && !K.kulata) {
      TE.push(ruka(R, 0));                                     // ostrá špička
    } else if (!K.prsty) {                                     // zaoblená špička
      const r0 = hl(Rk * 0.92) * 0.5;
      for (let i = 1; i <= 5; i++) { const a = -Math.PI / 2 + i / 6 * Math.PI; TE.push(ruka(Rk - r0 + Math.cos(a) * r0 * 0.9, r0 + Math.sin(a) * r0)); }
    }
    const zpet = 8;
    for (let i = 0; i <= zpet; i++) {
      const u = lerp(K.prsty ? Rk : (K.kulata ? Rk * 0.93 : R * 0.93), 0.8, i / zpet);
      TE.push(ruka(u, hl(u)));
    }
    const SE = [];
    const m = K.loketni;
    for (let i = 0; i <= m; i++) {
      const t = i / m;
      const x = lerp(zapZ[0], 0, t), y = lerp(zapZ[1], K.hlZ, t) + Math.sin(t * Math.PI) * K.prohnuti;
      SE.push(arm(x, y));
    }
    const prsty = [];
    if (K.prsty) {
      const n = K.prsty, hk = hl(Rk);
      for (let i = 0; i < n; i++) {
        const t = n > 1 ? i / (n - 1) : 0;                     // 0 = vnější (u náběžné hrany)
        const v0 = lerp(hk * 0.08, hk * 0.82, t);
        const baze = ruka(Rk - 1.5, v0);
        const delka = R * fz * (1.3 - 0.5 * t) + 1.5;
        const uhel = lerp(-0.04, 0.6, t);                      // vějíř dozadu (rad vůči ruce)
        const spic = ruka(Rk - 1.5 + delka * Math.cos(uhel), v0 + delka * Math.sin(uhel));
        const w = Math.max(1.4, hk / n * 1.25);
        prsty.push({ baze, spic, w });
      }
    }
    const kost = [Zp, ruka(R * 0.5, hl(R * 0.5) * 0.1), ruka(Rk * 0.95, hl(Rk) * 0.08)];
    const krovky = [];
    for (let i = 0; i <= m; i++) {
      const t = i / m;
      const yZ = lerp(zapZ[1], K.hlZ, t), yP = lerp(-K.predZap, 0, t);
      krovky.push(arm(lerp(zapZ[0] * 0.99, 0, t), yP + (yZ - yP) * K.krovkyHl));
    }
    const T = K.prsty ? ruka(Rk, 0) : (K.kulata ? ruka(Rk, hl(Rk * 0.92) * 0.5) : ruka(R, 0));
    return { LE, TE, SE, T, Zp, Zz, kost, krovky, prsty, n: K.letky, m, ca, ch, ruka, hl, Rk };
  }
  function obrysKridla(G) {
    const p = new Path2D();
    hladka(p, G.LE.concat(G.TE, G.SE.slice(1)), true);
    return p;
  }
  function prstCesta(f) {
    const [bx, by] = f.baze, [sx, sy] = f.spic;
    const dx = sx - bx, dy = sy - by, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L, w = f.w;
    const p = new Path2D();
    p.moveTo(bx + nx * w * 0.5, by + ny * w * 0.5);
    p.quadraticCurveTo(bx + dx * 0.55 + nx * w * 0.56, by + dy * 0.55 + ny * w * 0.56, sx - dx / L * w * 0.3 + nx * w * 0.36, sy - dy / L * w * 0.3 + ny * w * 0.36);
    p.quadraticCurveTo(sx + dx / L * w * 0.25, sy + dy / L * w * 0.25, sx - dx / L * w * 0.3 - nx * w * 0.36, sy - dy / L * w * 0.3 - ny * w * 0.36);
    p.quadraticCurveTo(bx + dx * 0.55 - nx * w * 0.56, by + dy * 0.55 - ny * w * 0.56, bx - nx * w * 0.5, by - ny * w * 0.5);
    p.closePath();
    return p;
  }
  /// Kreslí křídlo (pravé) – barvy a vzory z druhu `B`
  function kresliKridlo(g, B, faze, amp, stin) {
    const G = kridloGeom(B.K, faze, amp);
    const obrys = obrysKridla(G);
    const prsty = G.prsty.map(prstCesta);
    if (stin) { g.fill(obrys); for (const p of prsty) g.fill(p); return; }
    for (let i = prsty.length - 1; i >= 0; i--) {                // prsty pod křídlem
      g.fillStyle = B.barvy.prsty || B.barvy.letky; g.fill(prsty[i]);
      g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 0.45; g.stroke(prsty[i]);
    }
    g.save();
    g.clip(obrys);
    const y0 = G.LE[0][1];
    const gr = g.createLinearGradient(0, y0 - B.K.predZap - 2, 0, y0 + B.K.hlZ);
    gr.addColorStop(0, B.barvy.krovkySv || B.barvy.krovky);
    gr.addColorStop(1, B.barvy.krovky);
    g.fillStyle = gr;
    g.fill(obrys);
    g.fillStyle = B.barvy.letky;                                 // ruční letky za kostí
    g.beginPath();
    hladka(g, [G.Zp].concat(G.kost.slice(1), [G.T], G.TE, [G.Zz]), true);
    g.fill();
    g.fillStyle = B.barvy.loketni || B.barvy.letky;              // loketní letky
    g.beginPath();
    polyline(g, G.krovky.concat(G.SE.slice().reverse()), true);
    g.fill();
    if (B.vzor) B.vzor(g, G, B);
    // pera: jen konce (poslední ~50 % délky), jemně
    g.strokeStyle = B.barvy.pera || 'rgba(0,0,0,0.15)';
    g.lineWidth = B.K.pero || 0.45;
    const nT = G.TE.length;
    for (let i = 1; i < G.n; i++) {
      const t = i / G.n;
      const e = G.TE[Math.min(nT - 1, Math.round(t * (nT - 1)))];
      const b = bodNa(G.kost[0], G.kost[2], 1 - t * 0.85);
      g.beginPath(); g.moveTo(lerp(b[0], e[0], 0.5), lerp(b[1], e[1], 0.5)); g.lineTo(e[0], e[1]); g.stroke();
    }
    for (let i = 1; i < G.m; i++) {
      const a = G.krovky[i], e = G.SE[i];
      if (i % 2) continue;                                       // loketní: každé druhé pero
      g.beginPath(); g.moveTo(lerp(a[0], e[0], 0.5), lerp(a[1], e[1], 0.5)); g.lineTo(e[0], e[1]); g.stroke();
    }
    if (B.barvy.lem) {                                          // světlé lemy konců loketních letek
      g.strokeStyle = B.barvy.lem; g.lineWidth = 0.7;
      for (let i = 0; i < G.m; i++) {
        const a = G.SE[i], b = G.SE[i + 1];
        g.beginPath(); g.moveTo(a[0], a[1]); g.quadraticCurveTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 1, b[0], b[1]); g.stroke();
      }
    }
    g.strokeStyle = B.barvy.krovkyCara || 'rgba(0,0,0,0.16)';  // konce velkých krovek
    g.lineWidth = 0.55;
    for (let i = 0; i < G.m; i++) {
      const a = G.krovky[i], b = G.krovky[i + 1];
      g.beginPath(); g.moveTo(a[0], a[1]); g.quadraticCurveTo((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 1.1, b[0], b[1]); g.stroke();
    }
    g.restore();
    g.strokeStyle = B.barvy.obrys || 'rgba(0,0,0,0.32)';
    g.lineWidth = 0.5;
    g.stroke(obrys);
  }
  function elipsa2(g, x, y, rx, ry, rot) { g.beginPath(); g.ellipse(x, y, rx, ry, rot || 0, 0, Math.PI * 2); }
  /// tělo jako kapka: hruď vpředu (yf), zadek (yr), šířka bw
  function teloCesta(T) {
    const p = new Path2D();
    const { bw, yf, yr } = T;
    p.moveTo(0, yf - 1);
    p.bezierCurveTo(bw * 0.75, yf, bw, yf + (yr - yf) * 0.3, bw * 0.8, yf + (yr - yf) * 0.62);
    p.bezierCurveTo(bw * 0.6, yr - 1, bw * 0.3, yr, 0, yr + 1);
    p.bezierCurveTo(-bw * 0.3, yr, -bw * 0.6, yr - 1, -bw * 0.8, yf + (yr - yf) * 0.62);
    p.bezierCurveTo(-bw, yf + (yr - yf) * 0.3, -bw * 0.75, yf, 0, yf - 1);
    p.closePath();
    return p;
  }
  /// ocas: typ vejir (kulatý), rovny, klin (špičatý), vykrojeny; roztažení r (0–1)
  function ocasCesta(O, y0, r) {
    const p = new Path2D();
    const w = O.w * (0.8 + 0.35 * r), L = O.L;
    p.moveTo(-O.w0, y0);
    if (O.typ === 'vejir') {
      p.lineTo(-w * 0.5, y0 + L * 0.8);
      p.quadraticCurveTo(0, y0 + L * 1.18, w * 0.5, y0 + L * 0.8);
    } else if (O.typ === 'klin') {
      p.lineTo(-w * 0.42, y0 + L * 0.7);
      p.lineTo(0, y0 + L);
      p.lineTo(w * 0.42, y0 + L * 0.7);
    } else if (O.typ === 'vykrojeny') {
      p.lineTo(-w * 0.5, y0 + L);
      p.lineTo(0, y0 + L * 0.86);
      p.lineTo(w * 0.5, y0 + L);
    } else {
      p.lineTo(-w * 0.48, y0 + L);
      p.quadraticCurveTo(0, y0 + L * 1.05, w * 0.48, y0 + L);
    }
    p.lineTo(O.w0, y0);
    p.closePath();
    return p;
  }
  function peraOcasu(g, O, y0, r, barva) {
    const w = O.w * (0.8 + 0.35 * r), n = O.per || 6;
    g.strokeStyle = barva; g.lineWidth = 0.5;
    for (let i = 1; i < n; i++) {
      const t = i / n - 0.5;
      g.beginPath(); g.moveTo(t * O.w0 * 2, y0 + 1); g.lineTo(t * w * 0.95, y0 + O.L * (O.typ === 'vejir' ? 0.95 : 0.92)); g.stroke();
    }
  }
  /// Celý pták: stín = černá silueta. faze: index FAZE_LETU nebo 'slozeno'
  function kresliDruh(g, B, fi, stin) {
    const amp = B.amp || 1;
    const c = stin ? '#000' : null;
    const r = fi === 0 ? 1 : 0.4;                               // roztažení ocasu při klouzání
    if (stin) { g.fillStyle = '#000'; g.strokeStyle = '#000'; }
    // nohy (pod ocasem)
    if (B.nohy) {
      g.strokeStyle = c || B.nohy.barva; g.lineWidth = B.nohy.w; g.lineCap = 'round';
      g.beginPath();
      g.moveTo(-1.6, B.T.yr - 2); g.lineTo(-B.nohy.roz, B.nohy.L);
      g.moveTo(1.6, B.T.yr - 2); g.lineTo(B.nohy.roz, B.nohy.L);
      g.stroke();
      if (!stin && B.nohy.prsty) {
        g.lineWidth = B.nohy.w * 0.6;
        for (const st of [-1, 1]) {
          g.beginPath(); g.moveTo(st * B.nohy.roz, B.nohy.L); g.lineTo(st * (B.nohy.roz + 1.4), B.nohy.L + 3);
          g.moveTo(st * B.nohy.roz, B.nohy.L); g.lineTo(st * (B.nohy.roz - 1.2), B.nohy.L + 3); g.stroke();
        }
      }
    }
    // ocas
    const oc = ocasCesta(B.O, B.T.yr - 3, r);
    g.fillStyle = c || B.barvy.ocas;
    g.fill(oc);
    if (!stin) {
      if (B.vzorOcasu) { g.save(); g.clip(oc); B.vzorOcasu(g, B, B.T.yr - 3); g.restore(); }
      peraOcasu(g, B.O, B.T.yr - 3, r, 'rgba(0,0,0,0.22)');
      g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 0.5; g.stroke(oc);
    }
    // křídla
    if (fi === 'slozeno') {
      for (const st of [-1, 1]) {
        g.save(); g.scale(st, 1);
        g.fillStyle = c || B.barvy.krovky;
        elipsa2(g, B.T.bw * 0.72, (B.T.yf + B.T.yr) / 2 + 2, B.T.bw * 0.42, (B.T.yr - B.T.yf) * 0.52, 0.08);
        g.fill();
        if (!stin) {
          g.fillStyle = B.barvy.letky;
          elipsa2(g, B.T.bw * 0.66, B.T.yr - 2, B.T.bw * 0.3, (B.T.yr - B.T.yf) * 0.35, 0.06); g.fill();
          if (B.vzorSlozene) B.vzorSlozene(g, B);
        }
        g.restore();
      }
    } else {
      const f = FAZE_LETU[fi];
      for (const st of [-1, 1]) {
        g.save(); g.scale(st, 1);
        kresliKridlo(g, B, f, amp, stin);
        g.restore();
      }
    }
    // tělo
    const tc = teloCesta(B.T);
    if (stin) g.fill(tc);
    else {
      const gr = g.createLinearGradient(-B.T.bw, 0, B.T.bw, 0);
      gr.addColorStop(0, B.barvy.teloBok || B.barvy.telo);
      gr.addColorStop(0.5, B.barvy.telo);
      gr.addColorStop(1, B.barvy.teloBok || B.barvy.telo);
      g.fillStyle = gr;
      g.fill(tc);
      if (B.vzorTela) { g.save(); g.clip(tc); B.vzorTela(g, B); g.restore(); }
      g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 0.5; g.stroke(tc);
    }
    // krk a hlava
    const H = B.H;
    if (H.krk) {
      const k = new Path2D();
      k.moveTo(-H.krkW, B.T.yf + 3);
      k.quadraticCurveTo(-H.krkW * 0.8, (B.T.yf + H.y) / 2, -H.krkW * 0.72, H.y + H.ry * 0.3);
      k.lineTo(H.krkW * 0.72, H.y + H.ry * 0.3);
      k.quadraticCurveTo(H.krkW * 0.8, (B.T.yf + H.y) / 2, H.krkW, B.T.yf + 3);
      k.closePath();
      g.fillStyle = c || B.barvy.krk || B.barvy.hlava;
      g.fill(k);
      if (!stin && B.vzorKrku) { g.save(); g.clip(k); B.vzorKrku(g, B); g.restore(); }
    }
    // zobák
    const Z = B.Z;
    g.fillStyle = c || B.barvy.zobak;
    g.beginPath();
    const yz = H.y - H.ry * 0.7;
    if (Z.typ === 'plochy') {                                    // kachna, husa: plochý, zaoblený
      g.moveTo(-Z.w * 0.5, yz + 1.5);
      g.bezierCurveTo(-Z.w * 0.62, yz - Z.L * 0.6, -Z.w * 0.4, yz - Z.L, 0, yz - Z.L);
      g.bezierCurveTo(Z.w * 0.4, yz - Z.L, Z.w * 0.62, yz - Z.L * 0.6, Z.w * 0.5, yz + 1.5);
    } else {                                                     // špičatý / kuželovitý
      g.moveTo(-Z.w * 0.5, yz + 1.2);
      g.quadraticCurveTo(-Z.w * 0.3, yz - Z.L * 0.55, 0, yz - Z.L);
      g.quadraticCurveTo(Z.w * 0.3, yz - Z.L * 0.55, Z.w * 0.5, yz + 1.2);
    }
    g.closePath(); g.fill();
    if (!stin && B.vzorZobaku) B.vzorZobaku(g, B, yz);
    // hlava
    g.fillStyle = c || B.barvy.hlava;
    elipsa2(g, 0, H.y, H.rx, H.ry);
    g.fill();
    if (!stin) {
      if (B.vzorHlavy) { g.save(); elipsa2(g, 0, H.y, H.rx, H.ry); g.clip(); B.vzorHlavy(g, B); g.restore(); }
      g.fillStyle = 'rgba(10,10,10,0.9)';                        // oči po stranách
      for (const st of [-1, 1]) { elipsa2(g, st * H.rx * 0.78, H.y - H.ry * 0.2, Math.max(0.55, H.rx * 0.13), Math.max(0.55, H.rx * 0.13)); g.fill(); }
      g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 0.5;
      elipsa2(g, 0, H.y, H.rx, H.ry); g.stroke();
    }
  }
  // ---- pomocné vzory
  function skvrny(g, n, x0, x1, y0, y1, r, barva, sul) {
    g.fillStyle = barva;
    let h = sul * 9301 + 49297;
    const rnd = () => { h = (h * 9301 + 49297) % 233280; return h / 233280; };
    for (let i = 0; i < n; i++) { elipsa2(g, lerp(x0, x1, rnd()), lerp(y0, y1, rnd()), r * (0.6 + rnd() * 0.6), r * (0.4 + rnd() * 0.5), rnd() * 3); g.fill(); }
  }
  function pasPodel(g, body, sirka, barva, posun) {
    g.strokeStyle = barva; g.lineWidth = sirka; g.lineJoin = 'round'; g.lineCap = 'butt';
    g.beginPath();
    const b = body.map((p) => [p[0], p[1] + (posun || 0)]);
    hladka(g, b, false);
    g.stroke();
  }
  function bodyMezi(A, B, t) { return A.map((p, i) => bodNa(p, B[Math.min(i, B.length - 1)], t)); }
  // ---- druhy
  const PTACI_KRESBA = {
    kachna: {
      amp: 0.7,
      K: { ramX: 5, ramY: -4, paze: 17, ruka: 29, sipRuky: 0.3, hlZ: 13, hlZap: 11, predZap: 2, vyp: 1.2, vypRuky: 0.6,
           tipHl: 2.5, letky: 10, loketni: 11, prohnuti: 0.8, krovkyHl: 0.45, pero: 0.5 },
      T: { bw: 8.2, yf: -10, yr: 15 }, H: { y: -24, rx: 4.5, ry: 5.6, krk: true, krkW: 3 },
      Z: { typ: 'plochy', L: 6.5, w: 4 }, O: { typ: 'klin', L: 7, w: 9, w0: 4, per: 6 },
      barvy: { krovky: '#8e877b', krovkySv: '#a39c8f', letky: '#6c655b', loketni: '#6c655b', telo: '#7d7063', teloBok: '#a79c8e',
               hlava: '#17583a', krk: '#17583a', zobak: '#dcc23c', ocas: '#ecebe4', lem: 'rgba(255,255,255,0.25)' },
      vzor(g, G) {                                               // zrcátko: modré s bílým lemem
        const a = bodyMezi(G.krovky, G.SE, 0.12), b = bodyMezi(G.krovky, G.SE, 0.9);
        const zr = a.slice(0, 9).concat(b.slice(0, 9).reverse());
        g.fillStyle = '#ffffff'; g.beginPath(); polyline(g, zr, true); g.fill();
        const a2 = bodyMezi(G.krovky, G.SE, 0.25), b2 = bodyMezi(G.krovky, G.SE, 0.78);
        const zr2 = a2.slice(1, 9).concat(b2.slice(1, 9).reverse());
        const gr = g.createLinearGradient(zr2[0][0], zr2[0][1], zr2[6][0], zr2[6][1]);
        gr.addColorStop(0, '#2a3fa8'); gr.addColorStop(0.5, '#3a63d0'); gr.addColorStop(1, '#5a3a9a');
        g.fillStyle = gr; g.beginPath(); polyline(g, zr2, true); g.fill();
        g.fillStyle = 'rgba(40,36,32,0.55)';                     // tmavší konce ručních letek
        g.beginPath(); polyline(g, [G.kost[1], G.T].concat(G.TE.slice(1, 5)), true); g.fill();
      },
      vzorTela(g, B) {
        g.fillStyle = '#5a4a3c'; elipsa2(g, 0, 1, B.T.bw * 0.5, 9); g.fill();          // tmavý hřbet
        g.fillStyle = '#6a3622'; elipsa2(g, 0, B.T.yf + 1, B.T.bw * 0.95, 4.5); g.fill();   // kaštanová hruď
        g.fillStyle = '#171513'; elipsa2(g, 0, B.T.yr - 1, B.T.bw * 0.55, 4); g.fill();   // černý kostřec
      },
      vzorOcasu(g, B, y0) { g.fillStyle = '#1b1917'; elipsa2(g, 0, y0 + 2.5, 1.8, 3); g.fill(); },
      vzorKrku(g, B) { g.fillStyle = '#f4f4ee'; g.fillRect(-5, B.T.yf - 1.4, 10, 1.8); },
      vzorHlavy(g, B) { g.fillStyle = 'rgba(90,200,140,0.5)'; elipsa2(g, -1.3, B.H.y - 1.8, 1.6, 2.4); g.fill(); },
    },
    vrabec: {
      amp: 1,
      K: { ramX: 9, ramY: -3, paze: 18, ruka: 23, sipRuky: 0.16, hlZ: 21, hlZap: 19, predZap: 1.5, vyp: 1.5, vypRuky: 1,
           tipHl: 12, kulata: true, letky: 9, loketni: 9, prohnuti: 0.6, krovkyHl: 0.5, pero: 0.5 },
      T: { bw: 12.5, yf: -10, yr: 14 }, H: { y: -15, rx: 8.2, ry: 8, krk: false },
      Z: { typ: 'kuzel', L: 5, w: 4.4 }, O: { typ: 'vykrojeny', L: 15, w: 13, w0: 5.5, per: 6 },
      barvy: { krovky: '#8c5a32', krovkySv: '#a0703f', letky: '#4a3524', loketni: '#5a4030', telo: '#8f6a45', teloBok: '#a8835a',
               hlava: '#8a8a8a', zobak: '#3b3530', ocas: '#5c4330', lem: 'rgba(220,190,140,0.7)' },
      vzor(g, G) {
        pasPodel(g, bodyMezi(G.krovky, [G.LE[0], G.LE[1], G.LE[2]], 0.35).slice(0, 8), 2.4, '#f2ebd8');   // bílá páska
        g.strokeStyle = 'rgba(210,170,110,0.45)'; g.lineWidth = 0.7;                // světlé lemy ručních letek
        for (let i = 1; i < G.n; i++) { const e = G.TE[i], b = bodNa(G.kost[0], G.kost[2], 1 - i / G.n * 0.9); g.beginPath(); g.moveTo(lerp(b[0], e[0], 0.3), lerp(b[1], e[1], 0.3)); g.lineTo(e[0], e[1]); g.stroke(); }
      },
      vzorTela(g) {
        g.strokeStyle = '#2e2218'; g.lineWidth = 1.3;                                // černé čárkování hřbetu
        for (const x of [-3.6, -1.2, 1.2, 3.6]) { g.beginPath(); g.moveTo(x, -6); g.lineTo(x * 1.1, 6); g.stroke(); }
        g.fillStyle = '#8d7d6b'; elipsa2(g, 0, 10, 6, 3.5); g.fill();              // šedohnědý kostřec
      },
      vzorHlavy(g, B) {
        g.fillStyle = '#7a4527'; elipsa2(g, 0, B.H.y + 3.5, 7.4, 4.5); g.fill();   // kaštanová šíje
        g.fillStyle = '#7a4527'; for (const st of [-1, 1]) { elipsa2(g, st * 5.6, B.H.y - 0.5, 1.8, 4.5, st * 0.3); g.fill(); }
      },
      vzorSlozene(g, B) { g.fillStyle = '#f2ebd8'; g.fillRect(B.T.bw * 0.45, -2, B.T.bw * 0.5, 1.2); },
    },
    spacek: {
      amp: 0.9,
      K: { ramX: 5, ramY: -4, paze: 12, ruka: 36, sipRuky: 0.48, hlZ: 17, hlZap: 15, predZap: 3, vyp: 1, vypRuky: 0.4,
           tipHl: 1.5, letky: 9, loketni: 9, prohnuti: 0.4, krovkyHl: 0.5, pero: 0.5 },
      T: { bw: 9, yf: -10, yr: 13 }, H: { y: -15, rx: 6.2, ry: 6.8, krk: false },
      Z: { typ: 'spicaty', L: 8.5, w: 2.8 }, O: { typ: 'rovny', L: 8, w: 10, w0: 4.5, per: 6 },
      barvy: { krovky: '#23232b', krovkySv: '#2d2b36', letky: '#26252b', loketni: '#2a2830', telo: '#1f2129', teloBok: '#2b2d37',
               hlava: '#22242c', zobak: '#34312e', ocas: '#23232a', lem: 'rgba(190,160,110,0.55)', pera: 'rgba(140,110,80,0.45)' },
      vzor(g, G) {
        const [x0, y0] = G.LE[0], [x1, y1] = G.Zp;
        const gr = g.createLinearGradient(x0, y0, x1, y1);
        gr.addColorStop(0, 'rgba(120,80,170,0.45)'); gr.addColorStop(1, 'rgba(60,140,110,0.35)');
        g.fillStyle = gr; g.beginPath(); polyline(g, [G.LE[0], G.LE[1], G.Zp, G.Zz].concat(G.krovky.slice().reverse()), true); g.fill();
        skvrny(g, 8, G.LE[0][0], G.Zp[0], G.LE[0][1], G.krovky[3][1], 0.55, 'rgba(235,222,190,0.7)', 3);
      },
      vzorTela(g) { skvrny(g, 12, -7, 7, -8, 11, 0.6, 'rgba(235,222,190,0.7)', 5); },
      vzorHlavy(g) { skvrny(g, 5, -4, 4, -18, -9, 0.5, 'rgba(235,222,190,0.7)', 7); },
    },
    holub: {
      amp: 0.85,
      K: { ramX: 6, ramY: -3, paze: 16, ruka: 30, sipRuky: 0.32, hlZ: 17, hlZap: 13, predZap: 3, vyp: 1.2, vypRuky: 0.6,
           tipHl: 3.5, letky: 10, loketni: 11, prohnuti: 0.7, krovkyHl: 0.5, pero: 0.5 },
      T: { bw: 10, yf: -8, yr: 12 }, H: { y: -13.5, rx: 5.8, ry: 6.2, krk: false },
      Z: { typ: 'kuzel', L: 3.6, w: 2.4 }, O: { typ: 'vejir', L: 14, w: 13, w0: 5, per: 7 },
      barvy: { krovky: '#a2abb5', krovkySv: '#b3bbc4', letky: '#7c848f', loketni: '#98a1ab', telo: '#9aa3ad', teloBok: '#b0b8c1',
               hlava: '#6f7b88', zobak: '#2f2f33', ocas: '#8f98a2' },
      vzor(g, G) {
        pasPodel(g, bodyMezi(G.krovky, G.SE, 0.25).slice(1, 9), 2.2, '#2c3138');        // dvě černé pásky
        pasPodel(g, bodyMezi(G.krovky, G.LE.slice(0, 3), 0.15).slice(1, 8), 2.0, '#2c3138');
        g.fillStyle = 'rgba(40,44,50,0.75)';                                          // tmavé konce ručních letek
        g.beginPath(); polyline(g, [G.kost[1], G.T].concat(G.TE.slice(1, 6)), true); g.fill();
      },
      vzorTela(g, B) { g.fillStyle = 'rgba(233,237,240,0.9)'; elipsa2(g, 0, B.T.yr - 1.5, 4.2, 2.2); g.fill(); },   // bílý kostřec nad ocasem
      vzorOcasu(g, B, y0) { g.fillStyle = '#30353c'; g.fillRect(-10, y0 + B.O.L * 0.78, 20, 3.5); },
      vzorHlavy(g, B) { g.fillStyle = 'rgba(90,170,120,0.55)'; elipsa2(g, 0, B.H.y + 4.5, 5.8, 2.6); g.fill();
                        g.fillStyle = 'rgba(160,90,160,0.4)'; elipsa2(g, 0, B.H.y + 5.8, 5.6, 1.6); g.fill(); },
      vzorZobaku(g, B, yz) { g.fillStyle = '#f0ece6'; elipsa2(g, 0, yz + 0.4, 1.3, 0.9); g.fill(); },
    },
    hrivnac: {
      amp: 0.85,
      K: { ramX: 6, ramY: -3, paze: 17, ruka: 30, sipRuky: 0.3, hlZ: 18, hlZap: 14, predZap: 3, vyp: 1.3, vypRuky: 0.6,
           tipHl: 4, letky: 10, loketni: 11, prohnuti: 0.7, krovkyHl: 0.5, pero: 0.5 },
      T: { bw: 10.5, yf: -9, yr: 13 }, H: { y: -14.5, rx: 5.6, ry: 6, krk: false },
      Z: { typ: 'kuzel', L: 3.6, w: 2.4 }, O: { typ: 'vejir', L: 16, w: 13, w0: 5, per: 7 },
      barvy: { krovky: '#8e98a4', krovkySv: '#9ea8b3', letky: '#4d545e', loketni: '#6b737e', telo: '#8b939c', teloBok: '#a3abb4',
               hlava: '#8a94a2', zobak: '#e8b36a', ocas: '#8d96a1' },
      vzor(g, G) {                                                // bílá páska přes ruční krovky u zápěstí
        const a = G.LE[2], b = G.Zz;
        const c = G.ruka(G.Rk * 0.3, G.hl(G.Rk * 0.3) * 0.55);
        g.strokeStyle = '#f5f5f1'; g.lineWidth = 1.8; g.lineCap = 'round';
        g.beginPath(); g.moveTo(lerp(a[0], b[0], 0.15) - 1, lerp(a[1], b[1], 0.15)); g.quadraticCurveTo(lerp(a[0], b[0], 0.5) + 1.5, lerp(a[1], b[1], 0.5), c[0], c[1]); g.stroke();
        g.fillStyle = 'rgba(40,44,50,0.5)';
        g.beginPath(); polyline(g, [G.kost[1], G.T].concat(G.TE.slice(0, 4)), true); g.fill();
      },
      vzorOcasu(g, B, y0) { g.fillStyle = '#2f343b'; g.fillRect(-10, y0 + B.O.L * 0.8, 20, 3.5); },
      vzorKrku(g) {},
      vzorHlavy(g, B) { g.fillStyle = '#f4f4f0'; for (const st of [-1, 1]) { elipsa2(g, st * 4.8, B.H.y + 4.8, 1.8, 1.3); g.fill(); }
                        g.fillStyle = 'rgba(90,170,120,0.45)'; elipsa2(g, 0, B.H.y + 4.5, 5, 1.8); g.fill(); },
    },
    vrana: {
      amp: 0.8,
      K: { ramX: 6, ramY: -3, paze: 18, ruka: 27, sipRuky: 0.1, hlZ: 21, hlZap: 20, predZap: 2, vyp: 1.4, vypRuky: 0.8,
           tipHl: 15, kulata: true, prsty: 5, prstyDel: 0.24, letky: 10, loketni: 12, prohnuti: 0.7, krovkyHl: 0.48, pero: 0.5 },
      T: { bw: 9.5, yf: -9, yr: 13 }, H: { y: -15.5, rx: 6.4, ry: 7, krk: false },
      Z: { typ: 'kuzel', L: 7.5, w: 4 }, O: { typ: 'vejir', L: 15, w: 14, w0: 5, per: 8 },
      barvy: { krovky: '#1d1d22', krovkySv: '#26262d', letky: '#151518', loketni: '#18181c', telo: '#1c1c20', teloBok: '#27272d',
               hlava: '#1f1f24', zobak: '#121214', ocas: '#18181c', pera: 'rgba(120,120,140,0.35)', obrys: 'rgba(0,0,0,0.5)' },
      vzor(g, G) {
        const gr = g.createLinearGradient(G.LE[0][0], G.LE[0][1], G.Zp[0], G.Zp[1] + 10);
        gr.addColorStop(0, 'rgba(90,100,150,0.35)'); gr.addColorStop(1, 'rgba(60,60,90,0.1)');
        g.fillStyle = gr; g.beginPath(); polyline(g, [G.LE[0], G.LE[1], G.Zp, G.Zz].concat(G.krovky.slice().reverse()), true); g.fill();
      },
      vzorTela(g) { g.fillStyle = 'rgba(90,100,150,0.22)'; elipsa2(g, 0, -2, 5, 8); g.fill(); },
    },
    volavka: {
      amp: 0.55,
      K: { ramX: 6, ramY: -2, paze: 20, ruka: 25, sipRuky: 0.14, hlZ: 24, hlZap: 23, predZap: 4, vyp: 2.2, vypRuky: 1.2,
           tipHl: 17, kulata: true, prsty: 4, prstyDel: 0.13, letky: 10, loketni: 15, prohnuti: 1, krovkyHl: 0.5, pero: 0.5 },
      T: { bw: 9, yf: -8, yr: 12 }, H: { y: -15, rx: 5.4, ry: 5, krk: false },
      Z: { typ: 'spicaty', L: 16, w: 3 }, O: { typ: 'rovny', L: 8, w: 11, w0: 4.5, per: 6 },
      nohy: { barva: '#a8884a', w: 2.6, L: 46, roz: 2.2, prsty: true },
      barvy: { krovky: '#a3adb6', krovkySv: '#b4bdc5', letky: '#25282d', loketni: '#3a3f47', telo: '#9aa4ad', teloBok: '#b2bbc3',
               hlava: '#eeeeea', zobak: '#e0b830', ocas: '#8e98a1', krovkyCara: 'rgba(0,0,0,0.25)' },
      vzor(g, G) {
        g.fillStyle = '#7f8a95';                                   // tmavší malé krovky u náběžné hrany
        g.beginPath(); polyline(g, [G.LE[0], G.LE[1], G.Zp].concat(bodyMezi([G.Zp, G.LE[1], G.LE[0]], [G.Zz, G.krovky[Math.floor(G.m / 2)], G.krovky[G.m]], 0.28)), true); g.fill();
        g.fillStyle = '#f2f2ec';                                   // bílé „světlo“ na zápěstí
        elipsa2(g, lerp(G.LE[1][0], G.Zp[0], 0.7), lerp(G.LE[1][1], G.Zp[1], 0.7) + 1.2, 3.2, 1.6, -0.1); g.fill();
      },
      vzorTela(g) { g.fillStyle = 'rgba(255,255,255,0.35)'; elipsa2(g, 0, -4, 4, 5); g.fill(); },
      vzorHlavy(g, B) { g.fillStyle = '#1e1e22'; for (const st of [-1, 1]) { g.beginPath(); g.moveTo(st * 1.8, B.H.y - 3.5); g.quadraticCurveTo(st * 4.6, B.H.y, st * 3.6, B.H.y + 4.5); g.lineWidth = 1.4; g.strokeStyle = '#1e1e22'; g.stroke(); } },
    },
    cap: {
      amp: 0.6,
      K: { ramX: 6, ramY: -2, paze: 22, ruka: 23, sipRuky: 0.04, hlZ: 22, hlZap: 22, predZap: 1.5, vyp: 1.2, vypRuky: 0.8,
           tipHl: 20, kulata: true, prsty: 6, prstyDel: 0.3, letky: 10, loketni: 18, prohnuti: 0.5, krovkyHl: 0.52, pero: 0.45 },
      T: { bw: 9, yf: -8, yr: 12 }, H: { y: -30, rx: 3.8, ry: 4.4, krk: true, krkW: 2.6 },
      Z: { typ: 'spicaty', L: 13, w: 2.6 }, O: { typ: 'vejir', L: 8, w: 11, w0: 4.5, per: 6 },
      nohy: { barva: '#d9442c', w: 2.4, L: 47, roz: 2, prsty: false },
      barvy: { krovky: '#f4f2ec', krovkySv: '#fbfaf6', letky: '#1b1b1e', loketni: '#1d1d20', telo: '#f6f4ee', teloBok: '#e4e2da',
               hlava: '#f6f4ee', krk: '#f6f4ee', zobak: '#d9442c', ocas: '#f1efe8', pera: 'rgba(255,255,255,0.18)', krovkyCara: 'rgba(0,0,0,0.12)' },
      vzorHlavy(g) {},
    },
    labut: {
      amp: 0.7,
      K: { ramX: 7, ramY: 0, paze: 21, ruka: 23, sipRuky: 0.2, hlZ: 22, hlZap: 20, predZap: 3, vyp: 1.5, vypRuky: 1,
           tipHl: 9, kulata: true, letky: 10, loketni: 18, prohnuti: 0.6, krovkyHl: 0.5, pero: 0.5 },
      T: { bw: 11, yf: -12, yr: 16 }, H: { y: -44, rx: 4, ry: 5, krk: true, krkW: 3 },
      Z: { typ: 'plochy', L: 7, w: 3.6 }, O: { typ: 'klin', L: 8, w: 11, w0: 4.5, per: 6 },
      barvy: { krovky: '#f7f6f1', krovkySv: '#ffffff', letky: '#e3e2da', loketni: '#ebeae3', telo: '#f8f7f3', teloBok: '#e6e5de',
               hlava: '#f8f7f3', krk: '#f8f7f3', zobak: '#e0762c', ocas: '#efeee8', pera: 'rgba(120,120,110,0.18)', krovkyCara: 'rgba(0,0,0,0.1)', obrys: 'rgba(0,0,0,0.3)' },
      vzorZobaku(g, B, yz) { g.fillStyle = '#1b1b1b'; elipsa2(g, 0, yz - 0.6, 1.7, 1.5); g.fill(); g.fillRect(-1.9, yz, 3.8, 1.4); },
    },
    husa: {
      amp: 0.75,
      K: { ramX: 6, ramY: -2, paze: 18, ruka: 28, sipRuky: 0.24, hlZ: 16, hlZap: 14, predZap: 3, vyp: 1.2, vypRuky: 0.6,
           tipHl: 4.5, letky: 10, loketni: 14, prohnuti: 0.7, krovkyHl: 0.48, pero: 0.5 },
      T: { bw: 10, yf: -10, yr: 15 }, H: { y: -30, rx: 4.2, ry: 5.2, krk: true, krkW: 3.1 },
      Z: { typ: 'plochy', L: 6.5, w: 3.2 }, O: { typ: 'vejir', L: 8, w: 11, w0: 4.5, per: 6 },
      barvy: { krovky: '#b6b9b3', krovkySv: '#c6c9c3', letky: '#4a4640', loketni: '#7d766a', telo: '#877f70', teloBok: '#9d9585',
               hlava: '#80786a', krk: '#80786a', zobak: '#e59a6a', ocas: '#6e675c', lem: 'rgba(225,220,205,0.55)' },
      vzor(g, G) {
        pasPodel(g, bodyMezi(G.krovky, G.SE, 0.05).slice(0, G.m), 1.1, 'rgba(230,225,210,0.7)');   // světlé lemy krovek
      },
      vzorTela(g, B) {
        g.strokeStyle = 'rgba(210,200,180,0.55)'; g.lineWidth = 0.9;                  // světlé vroubky hřbetu
        for (let y = -6; y <= 8; y += 3.2) { g.beginPath(); g.moveTo(-B.T.bw * 0.6, y); g.quadraticCurveTo(0, y + 1.6, B.T.bw * 0.6, y); g.stroke(); }
        g.fillStyle = '#f2f0e8'; elipsa2(g, 0, B.T.yr - 0.5, B.T.bw * 0.5, 2.2); g.fill();   // bílý kostřec
      },
      vzorOcasu(g, B, y0) { g.fillStyle = '#efece4'; g.fillRect(-8, y0 + B.O.L * 0.82, 16, 3); },
      vzorKrku(g, B) { g.strokeStyle = 'rgba(60,55,48,0.4)'; g.lineWidth = 0.6; for (let y = B.T.yf - 2; y > B.H.y + 2; y -= 2.2) { g.beginPath(); g.moveTo(-2.4, y); g.lineTo(2.4, y); g.stroke(); } },
      vzorZobaku(g, B, yz) { g.fillStyle = '#f3efe6'; elipsa2(g, 0, yz - B.Z.L + 0.8, 1, 0.8); g.fill(); },
    },
  };
  // samice: kachna (hnědá, kropenatá, zrcátko stejné) a vrabec (bez šedé čepičky a kaštanu)
  PTACI_KRESBA.kachna_s = Object.assign({}, PTACI_KRESBA.kachna, {
    barvy: Object.assign({}, PTACI_KRESBA.kachna.barvy, { krovky: '#8a6c4c', krovkySv: '#9c7e5c', letky: '#5e4c3a', loketni: '#5e4c3a',
      telo: '#8a6a4a', teloBok: '#a58563', hlava: '#8e7050', krk: '#8e7050', zobak: '#c9893a', ocas: '#b39a7c' }),
    vzorTela(g, B) { skvrny(g, 26, -B.T.bw, B.T.bw, B.T.yf, B.T.yr, 1.1, 'rgba(60,42,26,0.7)', 11); },
    vzorOcasu(g, B, y0) { skvrny(g, 6, -4, 4, y0, y0 + 6, 0.8, 'rgba(60,42,26,0.6)', 13); },
    vzorKrku(g, B) { skvrny(g, 6, -3, 3, B.H.y + 2, B.T.yf, 0.6, 'rgba(60,42,26,0.6)', 17); },
    vzorHlavy(g, B) { g.fillStyle = '#4f3b28'; elipsa2(g, 0, B.H.y - 0.5, 1.8, 4.6); g.fill(); },
    vzorZobaku(g, B, yz) { g.fillStyle = '#3a2c20'; elipsa2(g, 0, yz - B.Z.L * 0.45, B.Z.w * 0.25, B.Z.L * 0.28); g.fill(); },
  });
  PTACI_KRESBA.vrabec_s = Object.assign({}, PTACI_KRESBA.vrabec, {
    barvy: Object.assign({}, PTACI_KRESBA.vrabec.barvy, { krovky: '#8a6e50', krovkySv: '#9b7f60', telo: '#9a7d5a', teloBok: '#b0946e',
      hlava: '#8e7d68', zobak: '#9a8a70' }),
    vzorTela(g) {
      g.strokeStyle = '#3b2c1e'; g.lineWidth = 1.1;
      for (const x of [-3.4, 0, 3.4]) { g.beginPath(); g.moveTo(x, -6); g.lineTo(x * 1.1, 6); g.stroke(); }
      g.strokeStyle = 'rgba(230,205,160,0.9)'; g.lineWidth = 0.9;
      for (const x of [-1.8, 1.8]) { g.beginPath(); g.moveTo(x, -6); g.lineTo(x * 1.1, 6); g.stroke(); }
    },
    vzorHlavy(g, B) { g.strokeStyle = 'rgba(225,205,165,0.95)'; g.lineWidth = 1; for (const st of [-1, 1]) { g.beginPath(); g.moveTo(st * 2.5, B.H.y - 4); g.quadraticCurveTo(st * 5.2, B.H.y - 1, st * 5.8, B.H.y + 3.5); g.stroke(); } },
  });
  /// sprite fází (0–3 mávnutí, 4 složená) pro druh; N px, m px na jednotku; stín = černá silueta
  function upecDruh2(klic, N, m, sStiny) {
    const B = PTACI_KRESBA[klic];
    const snimky = [], stiny = [];
    const nove = () => { const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(N, N) : document.createElement('canvas'); c.width = N; c.height = N; return c; };
    for (let f = 0; f < 5; f++) {
      const fi = f === 4 ? 'slozeno' : f;
      const a = nove(), ga = a.getContext('2d');
      ga.translate(N / 2, N / 2); ga.scale(m, m);
      kresliDruh(ga, B, fi, false);
      // tmavý měkký lem pod kresbou (čitelnost na mapě) + kresba
      const c = nove(), gc = c.getContext('2d');
      gc.filter = 'blur(' + Math.max(0.6, m * 0.9).toFixed(2) + 'px) brightness(0)';
      gc.globalAlpha = 0.45;
      gc.drawImage(a, 0, 0);
      gc.filter = 'none'; gc.globalAlpha = 1;
      gc.drawImage(a, 0, 0);
      snimky.push(c);
      if (sStiny) {
        const s = nove(), gs = s.getContext('2d');
        gs.translate(N / 2, N / 2); gs.scale(m, m);
        kresliDruh(gs, B, fi, true);
        stiny.push(s);
      }
    }
    return { snimky, stiny };
  }
  // ------------------------------------------------------------------ noční ptáci: kresba
  // ⭐ engine 344 (přání T 23. 9. v noci: „v noci dodělej sovy, které sedí na stromech a sem
  // tam nějaká přelétne; také jiné noční ptáky dle období“): noční druhy v letu (shora, stejný
  // anatomický systém) a SEDÍCÍ SOVY zepředu (stromy jsou billboardy natočené ke kameře).
  // Pruhování letek: pásy napříč rukou (vzor oříznutý křídlem).
  function pruhyRuky(g, G, n, barva, sirka, od, doo) {
    g.strokeStyle = barva; g.lineWidth = sirka;
    for (let i = 0; i < n; i++) {
      const u = G.Rk * lerp(od || 0.15, doo || 0.95, n > 1 ? i / (n - 1) : 0.5);
      const a = G.ruka(u, -2), b = G.ruka(u - 1.5, G.hl(u) + 3);
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
    }
  }
  function pruhyLoketni(g, G, n, barva, sirka) {
    g.strokeStyle = barva; g.lineWidth = sirka;
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1);
      const a = bodyMezi(G.krovky, G.SE, t), b = a.map((p) => [p[0], p[1]]);
      g.beginPath(); hladka(g, b, false); g.stroke();
    }
  }
  Object.assign(PTACI_KRESBA, {
    pustik: {
      amp: 0.6,
      K: { ramX: 8, ramY: -3, paze: 18, ruka: 23, sipRuky: 0.1, hlZ: 23, hlZap: 22, predZap: 2, vyp: 1.6, vypRuky: 1,
           tipHl: 14, kulata: true, prsty: 4, prstyDel: 0.12, letky: 10, loketni: 12, prohnuti: 0.6, krovkyHl: 0.5, pero: 0.4 },
      T: { bw: 12.5, yf: -9, yr: 12 }, H: { y: -15.5, rx: 9.8, ry: 9.2, krk: false },
      Z: { typ: 'kuzel', L: 2.6, w: 3.2 }, O: { typ: 'vejir', L: 11, w: 14, w0: 6, per: 7 },
      barvy: { krovky: '#8a6746', krovkySv: '#9e7a55', letky: '#735538', loketni: '#7a5b3d', telo: '#7e5f42', teloBok: '#937252',
               hlava: '#86654a', zobak: '#d8c9a0', ocas: '#735538', prsty: '#6a4e34', lem: 'rgba(230,205,160,0.35)' },
      vzor(g, G) {
        pruhyRuky(g, G, 5, 'rgba(214,184,140,0.55)', 1.3);
        pruhyLoketni(g, G, 2, 'rgba(214,184,140,0.45)', 1.2);
        skvrny(g, 9, G.LE[0][0], G.Zp[0], G.LE[0][1] - 2, G.krovky[4][1], 0.75, 'rgba(60,40,24,0.6)', 21);
        skvrny(g, 5, G.LE[0][0] + 1, G.LE[1][0], G.LE[0][1], G.LE[0][1] + 6, 0.8, 'rgba(240,226,196,0.85)', 23);   // bílé skvrny ramenních
      },
      vzorTela(g, B) {
        skvrny(g, 14, -B.T.bw * 0.7, B.T.bw * 0.7, B.T.yf, B.T.yr, 0.8, 'rgba(58,40,24,0.6)', 25);
        for (const st of [-1, 1]) skvrny(g, 3, st * 5, st * 8, -6, 2, 0.9, 'rgba(240,226,196,0.85)', st > 0 ? 27 : 29);
      },
      vzorHlavy(g, B) { skvrny(g, 9, -7, 7, B.H.y - 8, B.H.y + 6, 0.7, 'rgba(58,40,24,0.55)', 31); },
      vzorOcasu(g, B, y0) { g.strokeStyle = 'rgba(214,184,140,0.5)'; g.lineWidth = 1.1; for (const d of [3.5, 7]) { g.beginPath(); g.moveTo(-6, y0 + d); g.lineTo(6, y0 + d); g.stroke(); } },
    },
    kalous: {
      amp: 0.6,
      K: { ramX: 7, ramY: -3, paze: 17, ruka: 30, sipRuky: 0.2, hlZ: 18, hlZap: 17, predZap: 2, vyp: 1.2, vypRuky: 0.8,
           tipHl: 8, kulata: true, letky: 10, loketni: 12, prohnuti: 0.6, krovkyHl: 0.5, pero: 0.4 },
      T: { bw: 10.5, yf: -9, yr: 12 }, H: { y: -14.5, rx: 8, ry: 7.8, krk: false },
      Z: { typ: 'kuzel', L: 2.4, w: 3 }, O: { typ: 'rovny', L: 12, w: 12, w0: 5, per: 7 },
      barvy: { krovky: '#9a7951', krovkySv: '#ab8a60', letky: '#8a6a45', loketni: '#8f7049', telo: '#8f704d', teloBok: '#a5845c',
               hlava: '#94744e', zobak: '#2a2420', ocas: '#8a6a45', lem: 'rgba(230,205,160,0.35)' },
      vzor(g, G) {
        // oranžová skvrna u kořene ručních letek + tmavá čárka na zápěstí + pruhy konce ruky
        g.fillStyle = 'rgba(222,160,80,0.85)';
        g.beginPath(); polyline(g, [G.ruka(G.Rk * 0.08, 1), G.ruka(G.Rk * 0.45, 0.5), G.ruka(G.Rk * 0.42, G.hl(G.Rk * 0.42) * 0.7), G.ruka(G.Rk * 0.06, G.hl(1) * 0.75)], true); g.fill();
        g.fillStyle = 'rgba(50,36,24,0.85)'; const zc = G.ruka(G.Rk * 0.12, G.hl(1) * 0.35); elipsa2(g, zc[0], zc[1], 2.2, 3.2, 0.4); g.fill();
        pruhyRuky(g, G, 4, 'rgba(50,36,24,0.7)', 1.5, 0.62, 0.95);
        skvrny(g, 10, G.LE[0][0], G.Zp[0], G.LE[0][1] - 2, G.krovky[4][1], 0.7, 'rgba(60,44,28,0.55)', 33);
      },
      vzorTela(g, B) { g.strokeStyle = 'rgba(58,42,26,0.6)'; g.lineWidth = 1; for (const x of [-4, 0, 4]) { g.beginPath(); g.moveTo(x, B.T.yf + 2); g.lineTo(x * 1.1, B.T.yr - 2); g.stroke(); } },
      vzorOcasu(g, B, y0) { g.strokeStyle = 'rgba(50,36,24,0.55)'; g.lineWidth = 1; for (const d of [3, 6, 9]) { g.beginPath(); g.moveTo(-5.5, y0 + d); g.lineTo(5.5, y0 + d); g.stroke(); } },
    },
    sova_palena: {
      amp: 0.6,
      K: { ramX: 7, ramY: -3, paze: 18, ruka: 29, sipRuky: 0.16, hlZ: 19, hlZap: 18, predZap: 2, vyp: 1.3, vypRuky: 0.8,
           tipHl: 9, kulata: true, letky: 10, loketni: 12, prohnuti: 0.6, krovkyHl: 0.5, pero: 0.35 },
      T: { bw: 10.5, yf: -9, yr: 12 }, H: { y: -14.5, rx: 8.4, ry: 8, krk: false },
      Z: { typ: 'kuzel', L: 2.4, w: 2.8 }, O: { typ: 'rovny', L: 10, w: 12, w0: 5, per: 6 },
      barvy: { krovky: '#caa066', krovkySv: '#d6ae76', letky: '#c9a26c', loketni: '#cba46e', telo: '#c69c64', teloBok: '#d2aa72',
               hlava: '#caa46c', zobak: '#e9dcc2', ocas: '#c9a26c', pera: 'rgba(120,90,50,0.18)' },
      vzor(g, G) {
        g.fillStyle = 'rgba(165,160,152,0.55)';                   // šedý závoj přes krovky
        g.beginPath(); polyline(g, [G.LE[0], G.LE[1], G.Zp, G.Zz].concat(G.krovky.slice().reverse()), true); g.fill();
        pruhyRuky(g, G, 4, 'rgba(150,140,125,0.35)', 1.1);
        skvrny(g, 14, G.LE[0][0], G.Zp[0], G.LE[0][1] - 1, G.krovky[5][1], 0.45, 'rgba(250,248,240,0.9)', 35);
        skvrny(g, 10, G.LE[0][0], G.Zp[0], G.LE[0][1] - 1, G.krovky[5][1], 0.35, 'rgba(40,30,20,0.7)', 37);
      },
      vzorTela(g, B) { g.fillStyle = 'rgba(165,160,152,0.5)'; elipsa2(g, 0, -1, B.T.bw * 0.55, 8); g.fill();
                       skvrny(g, 10, -5, 5, -8, 8, 0.4, 'rgba(250,248,240,0.9)', 39); },
      vzorHlavy(g, B) { skvrny(g, 6, -5, 5, B.H.y - 6, B.H.y + 4, 0.4, 'rgba(250,248,240,0.9)', 41); },
    },
    sycek: {
      amp: 1,
      K: { ramX: 9, ramY: -3, paze: 17, ruka: 22, sipRuky: 0.12, hlZ: 21, hlZap: 20, predZap: 1.5, vyp: 1.5, vypRuky: 1,
           tipHl: 12, kulata: true, letky: 9, loketni: 9, prohnuti: 0.6, krovkyHl: 0.5, pero: 0.4 },
      T: { bw: 13, yf: -10, yr: 13 }, H: { y: -16, rx: 9.5, ry: 8.5, krk: false },
      Z: { typ: 'kuzel', L: 2.6, w: 3 }, O: { typ: 'rovny', L: 10, w: 12, w0: 5, per: 6 },
      barvy: { krovky: '#7c6148', krovkySv: '#8b6f55', letky: '#5f4a36', loketni: '#6a533d', telo: '#7a5f46', teloBok: '#8d7258',
               hlava: '#7d624a', zobak: '#d8cda0', ocas: '#5f4a36' },
      vzor(g, G) {
        skvrny(g, 14, G.LE[0][0], G.Zp[0], G.LE[0][1] - 2, G.krovky[4][1], 0.9, 'rgba(240,232,214,0.9)', 43);
        pruhyRuky(g, G, 4, 'rgba(240,232,214,0.55)', 1.4, 0.2, 0.9);
      },
      vzorTela(g, B) { skvrny(g, 12, -B.T.bw * 0.7, B.T.bw * 0.7, B.T.yf, B.T.yr, 0.9, 'rgba(240,232,214,0.85)', 45); },
      vzorHlavy(g, B) { skvrny(g, 10, -7, 7, B.H.y - 7, B.H.y + 5, 0.55, 'rgba(240,232,214,0.9)', 47); },
      vzorSlozene(g, B) { skvrny(g, 5, B.T.bw * 0.45, B.T.bw * 0.95, -6, 8, 0.8, 'rgba(240,232,214,0.85)', 49); },
    },
    lelek: {
      amp: 0.8,
      K: { ramX: 5, ramY: -3, paze: 13, ruka: 35, sipRuky: 0.42, hlZ: 14, hlZap: 12, predZap: 2, vyp: 0.8, vypRuky: 0.3,
           tipHl: 2.5, letky: 10, loketni: 10, prohnuti: 0.3, krovkyHl: 0.5, pero: 0.35 },
      T: { bw: 7, yf: -8, yr: 10 }, H: { y: -11.5, rx: 5.8, ry: 5, krk: false },
      Z: { typ: 'kuzel', L: 1.6, w: 3.4 }, O: { typ: 'rovny', L: 20, w: 10, w0: 4, per: 6 },
      barvy: { krovky: '#80776a', krovkySv: '#90877a', letky: '#5d544a', loketni: '#6a6155', telo: '#72695c', teloBok: '#81786b',
               hlava: '#786f62', zobak: '#3a342e', ocas: '#6a6155' },
      vzor(g, G) {
        skvrny(g, 12, G.LE[0][0], G.Zp[0], G.LE[0][1] - 1, G.krovky[4][1], 0.55, 'rgba(40,34,28,0.6)', 51);
        pasPodel(g, bodyMezi(G.krovky, G.LE.slice(0, 3), 0.3).slice(1, 8), 1.2, 'rgba(210,190,150,0.7)');   // světlý pás krovek
        const a = G.ruka(G.Rk * 0.72, -1), b = G.ruka(G.Rk * 0.7, G.hl(G.Rk * 0.7) + 1);
        g.strokeStyle = 'rgba(248,246,240,0.95)'; g.lineWidth = 2.2;                  // bílá skvrna samce na ruce
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(lerp(a[0], b[0], 0.7), lerp(a[1], b[1], 0.7)); g.stroke();
      },
      vzorTela(g, B) { g.strokeStyle = 'rgba(40,34,28,0.55)'; g.lineWidth = 0.8; for (const x of [-2.5, 2.5]) { g.beginPath(); g.moveTo(x, B.T.yf + 1); g.lineTo(x, B.T.yr - 1); g.stroke(); } },
      vzorOcasu(g, B, y0) { g.fillStyle = 'rgba(248,246,240,0.95)'; for (const st of [-1, 1]) { g.fillRect(st * 4.2 - 1.2, y0 + B.O.L - 5, 2.4, 4.2); }
                            g.strokeStyle = 'rgba(40,34,28,0.45)'; g.lineWidth = 0.9; for (const d of [5, 10, 15]) { g.beginPath(); g.moveTo(-4, y0 + d); g.lineTo(4, y0 + d); g.stroke(); } },
    },
    kvakos: {
      amp: 0.6,
      K: { ramX: 6, ramY: -2, paze: 18, ruka: 25, sipRuky: 0.12, hlZ: 21, hlZap: 20, predZap: 3, vyp: 1.6, vypRuky: 1,
           tipHl: 13, kulata: true, letky: 10, loketni: 14, prohnuti: 0.7, krovkyHl: 0.5, pero: 0.4 },
      T: { bw: 10, yf: -9, yr: 12 }, H: { y: -15, rx: 6.5, ry: 6.5, krk: false },
      Z: { typ: 'spicaty', L: 8.5, w: 3 }, O: { typ: 'rovny', L: 8, w: 11, w0: 4.5, per: 6 },
      nohy: { barva: '#c9b24a', w: 2, L: 30, roz: 1.8, prsty: true },
      barvy: { krovky: '#9ea7af', krovkySv: '#abb4bb', letky: '#8e979f', loketni: '#98a1a9', telo: '#1d2830', teloBok: '#2a3640',
               hlava: '#1b252d', zobak: '#161616', ocas: '#8e979f' },
      vzorTela(g, B) { g.fillStyle = '#18222a'; elipsa2(g, 0, -2, B.T.bw * 0.72, 9.5); g.fill(); },
      vzorHlavy(g, B) { g.fillStyle = 'rgba(240,240,236,0.9)'; g.fillRect(-2.6, B.H.y - B.H.ry + 0.6, 5.2, 1.1); },
    },
    sluka: {
      amp: 0.7,
      K: { ramX: 7, ramY: -3, paze: 16, ruka: 24, sipRuky: 0.14, hlZ: 20, hlZap: 19, predZap: 2, vyp: 1.4, vypRuky: 0.9,
           tipHl: 12, kulata: true, letky: 10, loketni: 11, prohnuti: 0.6, krovkyHl: 0.5, pero: 0.4 },
      T: { bw: 10, yf: -9, yr: 11 }, H: { y: -14, rx: 6.5, ry: 6.5, krk: false },
      Z: { typ: 'spicaty', L: 15, w: 2.2 }, O: { typ: 'rovny', L: 8, w: 11, w0: 4.5, per: 6 },
      barvy: { krovky: '#9a7550', krovkySv: '#aa855e', letky: '#6d543e', loketni: '#7a5f46', telo: '#8b6a48', teloBok: '#9d7a55',
               hlava: '#83633f', zobak: '#8a7258', ocas: '#6e543d' },
      vzor(g, G) {
        pruhyLoketni(g, G, 3, 'rgba(50,36,24,0.5)', 1.1);
        pruhyRuky(g, G, 5, 'rgba(200,170,120,0.45)', 1.1);
        skvrny(g, 12, G.LE[0][0], G.Zp[0], G.LE[0][1] - 1, G.krovky[4][1], 0.7, 'rgba(50,36,24,0.55)', 53);
      },
      vzorTela(g, B) { g.strokeStyle = 'rgba(50,36,24,0.55)'; g.lineWidth = 1.2; for (let y = B.T.yf + 2; y < B.T.yr; y += 3) { g.beginPath(); g.moveTo(-B.T.bw * 0.6, y); g.lineTo(B.T.bw * 0.6, y + 0.8); g.stroke(); } },
      vzorHlavy(g, B) { g.fillStyle = 'rgba(40,28,18,0.8)'; for (const d of [-4, -1, 2]) g.fillRect(-B.H.rx, B.H.y + d, B.H.rx * 2, 1.4); },
    },
  });

  // ---- sedící sovy zepředu: jednotky – výška 100 (nohy na větvi v y = 0, temeno y = −100)
  const SOVY = {
    pustik: { r: 25, hy: -76, telo: '#7f6043', prsa: '#a88660', kridla: '#6e5238', disk: '#b89a74', okraj: '#4a3522',
              oko: '#0e0b09', duhovka: null, zobak: '#d8c8a0', lesk: '#ff9a52' },
    kalous: { r: 21, hy: -73, telo: '#9a7a52', prsa: '#c6a171', kridla: '#7a5d3e', disk: '#d39a55', okraj: '#3b2a1c',
              oko: '#0e0b09', duhovka: '#f08a1c', zobak: '#2a2420', lesk: '#ffb347', usi: true },
    sova_palena: { r: 24, hy: -76, telo: '#caa066', prsa: '#f4efe4', kridla: '#c29a62', disk: '#fbf8f2', okraj: '#b88a55',
                   oko: '#0e0b09', duhovka: null, zobak: '#e9dcc2', lesk: '#ff9a52', srdce: true },
    sycek: { r: 23, hy: -71, telo: '#806349', prsa: '#9a7d5f', kridla: '#6b523c', disk: '#cfbc9c', okraj: '#5a4430',
             oko: '#0e0b09', duhovka: '#f4d23a', zobak: '#d8cda0', lesk: '#ffe066', plocha: true },
  };
  /// kreslí sedící sovu; fr: 0 zepředu, 1 hlava vlevo, 2 vpravo, 3 týl, 4 mrknutí.
  /// Vrací polohy očí (jednotky) pro odlesk – jen viditelné oči.
  function kresliSovu(g, druh, fr, stin) {
    const S = SOVY[druh], c = stin ? '#000' : null;
    const oci = [];
    // ocas pod větví
    g.fillStyle = c || S.kridla;
    g.beginPath(); g.moveTo(-8, -10); g.lineTo(-7, 12); g.lineTo(7, 12); g.lineTo(8, -10); g.closePath(); g.fill();
    // větev
    if (!stin) {
      g.strokeStyle = '#3a2a1c'; g.lineWidth = 6; g.lineCap = 'round';
      g.beginPath(); g.moveTo(-46, 4); g.quadraticCurveTo(0, -2, 48, 6); g.stroke();
      g.strokeStyle = 'rgba(120,90,60,0.6)'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(-44, 2.5); g.quadraticCurveTo(0, -3.5, 46, 4.5); g.stroke();
    }
    // tělo a prsa
    g.fillStyle = c || S.telo;
    elipsa2(g, 0, -38, 27, 37); g.fill();
    if (!stin) {
      g.fillStyle = S.prsa; elipsa2(g, 0, -33, 17, 28); g.fill();
      if (druh === 'pustik' || druh === 'kalous') {                 // podélné čárky s příčkami
        g.strokeStyle = druh === 'pustik' ? 'rgba(70,48,28,0.75)' : 'rgba(60,42,26,0.8)'; g.lineWidth = 2;
        for (const x of [-9, -3, 3, 9]) { g.beginPath(); g.moveTo(x, -54); g.lineTo(x * 1.08, -12); g.stroke(); }
        if (druh === 'pustik') { g.lineWidth = 1.2; for (let y = -50; y < -14; y += 6) { g.beginPath(); g.moveTo(-12, y); g.lineTo(12, y + 1); g.stroke(); } }
      } else if (druh === 'sova_palena') {
        skvrny(g, 12, -12, 12, -54, -14, 0.9, 'rgba(90,70,45,0.7)', 61);
      } else {
        skvrny(g, 14, -14, 14, -56, -12, 2.2, 'rgba(236,228,210,0.9)', 63);
      }
    }
    // složená křídla po stranách
    for (const st of [-1, 1]) {
      g.fillStyle = c || S.kridla;
      elipsa2(g, st * 20, -37, 11.5, 31, st * 0.14); g.fill();
      if (!stin) {
        if (druh === 'sova_palena') { g.fillStyle = 'rgba(165,160,152,0.55)'; elipsa2(g, st * 20, -44, 9, 18, st * 0.14); g.fill(); skvrny(g, 5, st * 16, st * 24, -60, -20, 0.8, 'rgba(250,248,240,0.9)', st > 0 ? 65 : 67); }
        else skvrny(g, 6, st * 15, st * 25, -60, -16, 1.4, druh === 'kalous' ? 'rgba(50,36,24,0.6)' : 'rgba(236,222,196,0.85)', st > 0 ? 69 : 71);
        g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 0.8; elipsa2(g, st * 20, -37, 11.5, 31, st * 0.14); g.stroke();
      }
    }
    // nohy (opeřené) s drápy na větvi
    for (const st of [-1, 1]) {
      g.fillStyle = c || (druh === 'sova_palena' ? '#f1ebdf' : '#cdb898');
      elipsa2(g, st * 7, -2, 5, 4); g.fill();
      if (!stin) { g.strokeStyle = '#2a2320'; g.lineWidth = 1.2; for (const d of [-3, 0, 3]) { g.beginPath(); g.moveTo(st * 7 + d, 0.5); g.lineTo(st * 7 + d * 1.2, 4); g.stroke(); } }
    }
    // hlava
    const r = S.r, hy = S.hy;
    const ry = S.plocha ? r * 0.86 : r;
    if (S.usi && fr !== 3) {                                       // ouška kalouse
      for (const st of [-1, 1]) {
        g.fillStyle = c || '#5a432c';
        g.beginPath(); g.moveTo(st * 5, hy - ry * 0.8); g.lineTo(st * 12, hy - ry * 1.55); g.lineTo(st * 13, hy - ry * 0.7); g.closePath(); g.fill();
        if (!stin) { g.strokeStyle = 'rgba(214,170,110,0.8)'; g.lineWidth = 0.9; g.beginPath(); g.moveTo(st * 6.5, hy - ry * 0.85); g.lineTo(st * 11.5, hy - ry * 1.4); g.stroke(); }
      }
    }
    g.fillStyle = c || S.telo;
    elipsa2(g, 0, hy, r, ry); g.fill();
    if (stin) return oci;
    if (fr === 3) {                                                 // týl: jen peří hlavy
      skvrny(g, 12, -r * 0.7, r * 0.7, hy - ry * 0.7, hy + ry * 0.6, 1.3, druh === 'sova_palena' ? 'rgba(165,160,152,0.7)' : 'rgba(60,42,26,0.55)', 73);
      if (druh === 'sycek') skvrny(g, 10, -r * 0.7, r * 0.7, hy - ry * 0.7, hy + ry * 0.6, 1, 'rgba(236,228,210,0.9)', 75);
      g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 0.8; elipsa2(g, 0, hy, r, ry); g.stroke();
      return oci;
    }
    // natočení obličeje: posun a zúžení
    const posun = fr === 1 ? -0.32 : (fr === 2 ? 0.32 : 0), zuz = fr === 1 || fr === 2 ? 0.72 : 1;
    const fx = (x) => posun * r + x * zuz;
    // závoj (obličejový disk)
    g.save();
    elipsa2(g, 0, hy, r, ry); g.clip();
    if (druh !== 'sycek') skvrny(g, 8, -r, r, hy - ry, hy + ry, 1.4, 'rgba(60,42,26,0.45)', 77);
    g.fillStyle = S.disk;
    if (S.srdce) {                                                  // srdcovitý závoj sovy pálené
      g.beginPath();
      g.moveTo(fx(0), hy - ry * 0.55);
      g.bezierCurveTo(fx(-r * 0.25), hy - ry * 0.95, fx(-r * 0.98), hy - ry * 0.7, fx(-r * 0.86), hy + ry * 0.05);
      g.bezierCurveTo(fx(-r * 0.75), hy + ry * 0.6, fx(-r * 0.2), hy + ry * 0.9, fx(0), hy + ry * 0.98);
      g.bezierCurveTo(fx(r * 0.2), hy + ry * 0.9, fx(r * 0.75), hy + ry * 0.6, fx(r * 0.86), hy + ry * 0.05);
      g.bezierCurveTo(fx(r * 0.98), hy - ry * 0.7, fx(r * 0.25), hy - ry * 0.95, fx(0), hy - ry * 0.55);
      g.fill();
      g.strokeStyle = S.okraj; g.lineWidth = 1.6; g.stroke();
    } else if (!S.plocha) {                                         // dva kruhy závoje
      for (const st of [-1, 1]) { elipsa2(g, fx(st * r * 0.36), hy + 1, r * 0.46 * (st === (fr === 1 ? 1 : -1) && zuz < 1 ? 0.8 : 1), ry * 0.6); g.fill(); }
      g.strokeStyle = S.okraj; g.lineWidth = 1.4;
      g.beginPath(); g.ellipse(fx(0), hy + 2, r * 0.86 * zuz, ry * 0.78, 0, Math.PI * 0.05, Math.PI * 0.95); g.stroke();
      if (druh === 'kalous') { g.strokeStyle = 'rgba(50,34,20,0.7)'; g.lineWidth = 1.4; g.beginPath(); g.moveTo(fx(0), hy - ry * 0.6); g.lineTo(fx(0), hy + ry * 0.4); g.stroke();
                               g.strokeStyle = 'rgba(245,240,230,0.9)'; g.lineWidth = 1.2; for (const st of [-1, 1]) { g.beginPath(); g.moveTo(fx(st * 2), hy - ry * 0.55); g.lineTo(fx(st * 7), hy - ry * 0.25); g.stroke(); } }
    } else {                                                        // sýček: světlý obličej a bílé obočí
      g.fillStyle = S.disk; elipsa2(g, fx(0), hy + 2, r * 0.8 * zuz, ry * 0.62); g.fill();
      skvrny(g, 8, -r * 0.8, r * 0.8, hy - ry * 0.9, hy - ry * 0.4, 1.1, 'rgba(236,228,210,0.9)', 79);
    }
    // oči
    const oko = (st) => {
      const x = fx(st * r * 0.38), y = hy - (S.plocha ? 1 : 2), ro = r * (S.plocha ? 0.26 : 0.27);
      const daleko = zuz < 1 && ((fr === 1 && st > 0) || (fr === 2 && st < 0));
      const w = daleko ? ro * 0.55 : ro;
      if (S.plocha) { g.strokeStyle = '#f4efe2'; g.lineWidth = 2.2; g.beginPath(); g.moveTo(x - w * 1.2, y - ro * 1.25); g.lineTo(x + w * 1.1, y - ro * 1.05); g.stroke(); }
      if (fr === 4) {                                               // mrknutí: víčko
        g.strokeStyle = 'rgba(40,28,18,0.9)'; g.lineWidth = 1.6;
        g.beginPath(); g.moveTo(x - w, y); g.quadraticCurveTo(x, y + ro * 0.35, x + w, y); g.stroke();
        return;
      }
      if (S.duhovka) { g.fillStyle = S.duhovka; g.beginPath(); g.ellipse(x, y, w, ro, 0, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = S.oko; g.beginPath(); g.ellipse(x, y, S.duhovka ? w * 0.5 : w, S.duhovka ? ro * 0.5 : ro, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.8)'; g.beginPath(); g.ellipse(x - w * 0.3, y - ro * 0.35, Math.max(0.6, w * 0.22), Math.max(0.6, ro * 0.22), 0, 0, Math.PI * 2); g.fill();
      oci.push([x, y, Math.max(w, ro * 0.6)]);
    };
    oko(-1); oko(1);
    // zobák
    g.fillStyle = S.zobak;
    g.beginPath(); g.moveTo(fx(-2.6), hy + 4); g.quadraticCurveTo(fx(0), hy + 3, fx(2.6), hy + 4); g.lineTo(fx(0), hy + 10); g.closePath(); g.fill();
    g.restore();
    g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 0.8; elipsa2(g, 0, hy, r, ry); g.stroke();
    return oci;
  }
  /// noční nádech: tmavomodrý závoj jen přes kresbu (jako překryv noci přes krajinu)
  function nocniTon(c, sila) {
    if (!(sila > 0)) return;
    const g = c.getContext('2d');
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = 'rgba(11,26,58,' + sila.toFixed(3) + ')';
    g.fillRect(0, 0, c.width, c.height);
    g.restore();
  }
  /// sprite sedící sovy (5 poloh); kotva = nohy (N/2, 0,9 N); oči v px spritu
  function upecSovu(druh, N, sila) {
    const m = N / 120, snimky = [], oci = [];
    for (let fr = 0; fr < 5; fr++) {
      const a = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(N, N) : document.createElement('canvas');
      a.width = N; a.height = N;
      const g = a.getContext('2d');
      g.translate(N / 2, N * 0.9); g.scale(m, m);
      const o = kresliSovu(g, druh, fr, false);
      nocniTon(a, sila);
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(N, N) : document.createElement('canvas');
      c.width = N; c.height = N;
      const gc = c.getContext('2d');
      gc.filter = 'blur(' + Math.max(0.6, m * 1.6).toFixed(2) + 'px) brightness(0)';
      gc.globalAlpha = 0.5; gc.drawImage(a, 0, 0);
      gc.filter = 'none'; gc.globalAlpha = 1; gc.drawImage(a, 0, 0);
      snimky.push(c);
      oci.push(o.map(([x, y, r]) => [N / 2 + x * m, N * 0.9 + y * m, r * m]));
    }
    return { N, m, snimky, oci };
  }
  // ------------------------------------------------------------------ ptáci: lety
  // ⭐ engine 342: letka = JEDEN druh, kresba natočená PODLE SMĚRU LETU a položená do
  // roviny letu (zkrácení náklonem kamery jako všechno na mapě) – dřív vzpřímená
  // silueta letící šikmo přes obrazovku vypadala jako let bokem (výtka T 23. 9.).
  // Druh podle okolí (kotvy z workeru dekorací: voda → kachny, volavka, labutě;
  // komíny/světla sídel → vrabci, holubi; jinak vrány, špačci, čápi; husy v klínu hlavně
  // v říjnu–březnu, čápi v dubnu–srpnu), podle zoomu (drobní až zblízka) a měsíce.
  const MAX_LETU = 2;
  // ⭐ engine 343 (výtka T: „jejich zvětšování, když se oddaluji od povrchu, je nepřirozené,
  // měly by být nad povrchem realisticky“): velikost v METRECH světa – promítá se kamerou
  // jako stromy a domy (oddálení = menší, přiblížení = větší, výš letící = blíž kameře =
  // o kus větší). Stylizace ≈ 7 × skutečné rozpětí^0,8 (drobné víc, aby byly vidět):
  // vrabec 2,2 m, kachna 6,4 m, čáp 12,2 m (strom v mapě ≈ 25 m). Pod ~5 px se druh
  // nerodí (drobní až zblízka), nad 130 px se dál nezvětšuje.
  // v = m/s, nad = výška nad terénem (m, strop 0,3 × výšky kamery), frek = mávnutí/s,
  // let: mava | poskok (vrabec) | plachti (čáp), klouz = délka klouzání (s), samice = podíl
  const PTACI = {
    kachna:  { rozM: 6.4,  v: 22, nad: [15, 50],  frek: 6,   let: 'mava', tvar: 'rada', samice: 0.5,
               n: () => vazene([[1, 12], [2, 45], [3, 16], [4, 12], [5, 9], [6, 6]]) },
    vrabec:  { rozM: 2.2,  v: 11, nad: [3, 8],    frek: 8,   let: 'poskok', tvar: 'volne', samice: 0.5,
               n: () => vazene([[1, 35], [2, 30], [3, 20], [4, 15]]) },
    spacek:  { rozM: 3.4,  v: 20, nad: [20, 50],  frek: 7,   let: 'mava', klouz: 0.35, tvar: 'mrak',
               n: () => 10 + Math.floor(Math.random() * 13) },
    holub:   { rozM: 5.0,  v: 18, nad: [15, 40],  frek: 5.5, let: 'mava', klouz: 0.25, tvar: 'chumel',
               n: () => 4 + Math.floor(Math.random() * 8) },
    hrivnac: { rozM: 5.7,  v: 18, nad: [20, 60],  frek: 5,   let: 'mava', klouz: 0.3, tvar: 'chumel',
               n: () => vazene([[1, 20], [2, 25], [3, 15], [5, 15], [8, 15], [12, 10]]) },
    vrana:   { rozM: 6.9,  v: 12, nad: [15, 45],  frek: 3.4, let: 'mava', klouz: 0.15, tvar: 'volne',
               n: () => (mesic() >= 11 || mesic() <= 2) ? 3 + Math.floor(Math.random() * 6) : vazene([[1, 50], [2, 30], [3, 12], [4, 8]]) },
    volavka: { rozM: 11.2, v: 11, nad: [25, 60],  frek: 2.2, let: 'mava', tvar: 'volne',
               n: () => vazene([[1, 88], [2, 12]]) },
    cap:     { rozM: 12.2, v: 12, nad: [60, 160], frek: 2,   let: 'plachti', tvar: 'volne',
               n: () => vazene([[1, 60], [2, 30], [3, 10]]) },
    labut:   { rozM: 13.1, v: 18, nad: [15, 40],  frek: 2.8, let: 'mava', tvar: 'rada',
               n: () => vazene([[1, 20], [2, 55], [3, 15], [4, 10]]) },
    husa:    { rozM: 10.2, v: 17, nad: [60, 150], frek: 3.4, let: 'mava', tvar: 'klin',
               n: () => 5 + Math.floor(Math.random() * 9) },
    // ⭐ engine 344: NOČNÍ (noc: true; husa letí i v noci při tahu). Sovy mávají pomalu
    // a dlouho plachtí, nízko; lelek kličkuje (klikaty), sluka „táhne“ těsně nad lesem
    pustik:      { rozM: 6.7, v: 9,  nad: [6, 20],  frek: 3,   let: 'mava', klouz: 0.6, tvar: 'volne', noc: true, sova: true,
                   n: () => vazene([[1, 90], [2, 10]]) },
    kalous:      { rozM: 6.6, v: 9,  nad: [5, 18],  frek: 3.2, let: 'mava', klouz: 0.6, tvar: 'volne', noc: true, sova: true, n: () => 1 },
    sova_palena: { rozM: 6.4, v: 8,  nad: [3, 12],  frek: 2.8, let: 'mava', klouz: 0.7, tvar: 'volne', noc: true, sova: true, n: () => 1 },
    sycek:       { rozM: 4.3, v: 9,  nad: [2, 8],   frek: 7,   let: 'poskok', tvar: 'volne', noc: true, sova: true, n: () => 1 },
    lelek:       { rozM: 4.3, v: 8,  nad: [4, 20],  frek: 4,   let: 'mava', klouz: 0.5, tvar: 'volne', noc: true, klikaty: true,
                   n: () => vazene([[1, 80], [2, 20]]) },
    kvakos:      { rozM: 7.3, v: 11, nad: [20, 50], frek: 2.6, let: 'mava', tvar: 'volne', noc: true,
                   n: () => vazene([[1, 50], [2, 25], [3, 15], [4, 10]]) },
    sluka:       { rozM: 4.6, v: 10, nad: [28, 40], frek: 3.5, let: 'mava', tvar: 'volne', noc: true, n: () => 1 },
  };
  // výška SEDÍCÍ sovy (m, stylizace jako rozpětí: 7 × skutečná^0,8)
  const SOVA_VYSKA_M = { pustik: 3.4, kalous: 3.1, sova_palena: 3.0, sycek: 2.1 };
  const MIN_PX_DRUHU = 5, MAX_PX_PTAKA = 130;
  const metryNaPx = (z, lat) => 78271.52 / Math.pow(2, z) * Math.cos(lat * Math.PI / 180);
  /// nejnižší zoom, na kterém má druh v zeměpisné šířce lat aspoň MIN_PX_DRUHU px
  const odZoomDruhu = (c, lat) => Math.log2(MIN_PX_DRUHU * 78271.52 * Math.cos(lat * Math.PI / 180) / c.rozM);
  /// výška kamery nad středem (m) – strop výšky letu, ať pták nevletí „do objektivu“
  function vyskaKamery() {
    try {
      const tr = T(), c = mapa.getCenter();
      return tr.cameraToCenterDistance * metryNaPx(mapa.getZoom(), c.lat) * Math.cos(mapa.getPitch() * Math.PI / 180);
    } catch (e) { return 1000; }
  }
  const spritePtaku = {};
  const TRIDY_PX = [48, 96, 192];               // rozpětí v spritu ≈ 0,88 × N
  function spriteDruhu(klic, tr, ton) {
    ton = ton || 0;
    const k = klic + '|' + tr + '|' + ton;
    let s = spritePtaku[k];
    if (!s) {
      const N = TRIDY_PX[tr], m = N / 114;
      const u = upecDruh2(klic, N, m, tr === 0 && !ton);
      if (ton) for (const c of u.snimky) nocniTon(c, SILA_TONU[ton]);
      s = spritePtaku[k] = { N, m, sn: u.snimky, stin: tr === 0 && !ton ? { N, m, sn: u.stiny } : null };
    }
    return s;
  }
  const spriteSov = {};
  const TRIDY_SOV = [64, 128, 256];               // výška sovy ve spritu ≈ 0,83 × N
  function spriteSovy(druh, tr, ton) {
    const k = druh + '|' + tr + '|' + ton;
    // engine 346 (výtka T: „sovy téměř nejsou vidět“): sedící sovy tlumit méně než ptáky v letu
    return spriteSov[k] || (spriteSov[k] = upecSovu(druh, TRIDY_SOV[tr], [0, 0.08, 0.16, 0.24][ton]));
  }
  function hotovaSova(druh, tr, ton) {
    for (const t of [tr, tr - 1, tr + 1, tr - 2, tr + 2]) {
      const k = druh + '|' + t + '|' + ton;
      if (t >= 0 && t < TRIDY_SOV.length && spriteSov[k]) return spriteSov[k];
    }
    return spriteSovy(druh, tr, ton);
  }
  const tridaSovy = (px) => { const d = px * hustota; return d < 60 ? 0 : (d < 120 ? 1 : 2); };
  // pečení stojí 10–20 ms na druh a velikost (TT) → předem v nečinnosti, jakmile let
  // vznikne (ptáci startují za okrajem); při kreslení se vezme nejbližší hotová třída
  const frontaPeceni = [];
  let peceBezi = false;
  function pripravSprity(klice, tr, ton, sovy) {
    ton = ton || 0;
    for (const kl of klice) {
      for (const t of (sovy ? [tr] : [0, tr])) {
        const tn = sovy || t === tr ? ton : 0;
        const k = (sovy ? 's|' : 'p|') + kl + '|' + t + '|' + tn;
        const hotovo = sovy ? spriteSov[kl + '|' + t + '|' + tn] : spritePtaku[kl + '|' + t + '|' + tn];
        if (!hotovo && frontaPeceni.indexOf(k) < 0) frontaPeceni.push(k);
      }
    }
    if (peceBezi || !frontaPeceni.length) return;
    peceBezi = true;
    const dalsi = () => {
      const k = frontaPeceni.shift();
      if (!k) { peceBezi = false; return; }
      const [typ, kl, t, tn] = k.split('|');
      try { if (typ === 's') spriteSovy(kl, +t, +tn); else spriteDruhu(kl, +t, +tn); } catch (e) { /* nic */ }
      if (typeof requestIdleCallback === 'function') requestIdleCallback(dalsi, { timeout: 400 });
      else setTimeout(dalsi, 30);
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(dalsi, { timeout: 400 });
    else setTimeout(dalsi, 30);
  }
  function hotovySprite(klic, tr, ton) {
    ton = ton || 0;
    for (const t of [tr, tr - 1, tr + 1, tr - 2, tr + 2]) {
      const k = klic + '|' + t + '|' + ton;
      if (t >= 0 && t < TRIDY_PX.length && spritePtaku[k]) return spritePtaku[k];
    }
    return spriteDruhu(klic, tr, ton);            // nic hotového – upéct hned (výjimečně)
  }
  const tridaPx = (px) => { const d = px * hustota; return d < 50 ? 0 : (d < 100 ? 1 : 2); };
  const nah = (a) => (Math.random() * 2 - 1) * a;
  function vazene(moznosti) {
    let s = 0;
    for (const m of moznosti) s += m[1];
    let r = Math.random() * s;
    for (const m of moznosti) { r -= m[1]; if (r <= 0) return m[0]; }
    return moznosti[0][0];
  }
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
  /// kolik lesních stromů (k ≥ 0,9) je ve výřezu – les pro puštíka, lelka, sluku
  function pocetLesnichStromu() {
    try {
      if (typeof Dekorace === 'undefined' || !Dekorace.zapsane || mapa.getZoom() < 14) return 0;
      const b = mapa.getBounds(), w = b.getWest(), e = b.getEast(), so = b.getSouth(), n = b.getNorth();
      let c = 0;
      for (const f of Dekorace.zapsane()) {
        if ((+f.properties.k || 0) < 0.9) continue;
        const q = f.geometry.coordinates;
        if (q[0] > w && q[0] < e && q[1] > so && q[1] < n) c++;
      }
      return c;
    } catch (e) { return 0; }
  }
  function vyberDruh(z, jine, vNoci) {
    const k = kontextPtaku(), m = mesic();
    const voda = k.voda >= 3, ves = k.komin >= 6 || k.svetla >= 10;
    let vahy;
    if (vNoci) {
      const les = pocetLesnichStromu() >= 40;
      const st = pocasi(performance.now()), el = st && typeof st.slunceEl === 'number' ? st.slunceEl : -20;
      vahy = {
        pustik: les ? 3 : 1,
        kalous: (m === 12 || m <= 2) ? (ves ? 2 : 1.2) : (les ? 1 : 0.8),
        sova_palena: ves ? 1.8 : 0.6,
        sycek: ves ? 1 : 0.2,
        lelek: (m >= 5 && m <= 8) ? (les ? 2 : 0.8) : 0,                 // V–VIII, paseky a okraje lesa
        kvakos: (m >= 4 && m <= 9) ? (voda ? 3 : 0.15) : 0,              // IV–IX u vody
        sluka: (m >= 3 && m <= 6 && el > -10) ? (les ? 2.5 : 0.3) : 0,   // jarní tah za soumraku
        husa: ((m >= 10 && m <= 11) || (m >= 2 && m <= 3)) ? 0.8 : 0,    // noční tah hus
      };
    } else vahy = {
      kachna: voda ? 6 : 0.5,
      labut: k.voda >= 12 ? 2 : (voda ? 0.8 : 0),
      volavka: voda ? 2.2 : 0.5,
      husa: (m >= 10 || m <= 3) ? (voda ? 2.5 : 1.5) : (voda ? 0.8 : 0.15),
      cap: (m >= 4 && m <= 8) ? (voda ? 1 : 2.2) : 0,
      vrana: ves ? 1.2 : 3,
      spacek: (m >= 3 && m <= 11) ? (ves ? 2.2 : 2.8) : 0.5,
      holub: ves ? 3 : 0.3,
      hrivnac: ves ? 0.5 : 1.4,
      vrabec: ves ? 4.5 : 0,
    };
    const lat = mapa.getCenter().lat;
    let suma = 0;
    for (const d in vahy) {
      if (z < odZoomDruhu(PTACI[d], lat) || jine.indexOf(d) >= 0) vahy[d] = 0;
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
  function novyLet(druh, start) {
    const c = PTACI[druh];
    const kont = mapa.getContainer(), W = kont.clientWidth, H = kont.clientHeight;
    const nad = start ? start.nadM : c.nad[0] + Math.random() * (c.nad[1] - c.nad[0]);
    const okraj = 60;
    const r = Math.random();
    const y = (u0, u1) => H * (u0 + Math.random() * (u1 - u0)), x = (u0, u1) => W * (u0 + Math.random() * (u1 - u0));
    let a, b;
    // vlet i odlet ZA OKRAJEM: vlevo↔vpravo (i šikmo), občas zdola nahoru / shora dolů
    if (r < 0.38) { a = [-okraj, y(0.25, 0.9)]; b = [W + okraj, y(0.2, 0.92)]; }
    else if (r < 0.76) { a = [W + okraj, y(0.25, 0.9)]; b = [-okraj, y(0.2, 0.92)]; }
    else if (r < 0.88 || mapa.getPitch() > 50) { a = [x(0.15, 0.85), H + okraj]; b = [x(0.1, 0.9), -okraj]; }
    else { a = [x(0.15, 0.85), -okraj]; b = [x(0.1, 0.9), H + okraj]; }
    if (start) {
      // ⭐ engine 344: sova VZLÉTNE ZE STROMU – začátek v místě, kde seděla (výška koruny),
      // cíl za tím okrajem obrazovky, který je dál (ať přelétne přes mapu)
      a = [start.sx, start.sy];
      b = a[0] < W / 2 ? [W + okraj, y(0.15, 0.9)] : [-okraj, y(0.15, 0.9)];
    }
    let A0, B0;
    try { A0 = mapa.unproject(a); B0 = mapa.unproject(b); } catch (e) { return null; }
    if (!A0 || !B0) return null;
    // ⭐ engine 343: VÝŠKOVÝ PROFIL dráhy – terén v 17 bodech, vyhlazený (klouzavý průměr
    // 5, nikdy pod terénem). Pták sleduje krajinu plynule (vrabec i v údolí nízko, čáp
    // nevystoupá ke kameře). Engine 342 měl stálou výšku nad nejvyšším bodem dráhy (proti
    // letu „bokem“ při skokovém dorovnávání výšky) – nízcí ptáci pak v údolí letěli vysoko.
    const syrovy = [];
    for (let i = 0; i <= 16; i++) {
      const u = i / 16;
      syrovy.push(vyskaTerenu(A0.lng + (B0.lng - A0.lng) * u, A0.lat + (B0.lat - A0.lat) * u));
    }
    const zname = syrovy.filter((h) => h !== null);
    const nahr = zname.length ? zname.reduce((x, y) => x + y, 0) / zname.length : ((T() && T().elevation) || 0);
    const syr = syrovy.map((h) => (h === null ? nahr : h));
    const profil = syr.map((h, i) => {
      let sum = 0, n = 0;
      for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < syr.length) { sum += syr[j]; n++; }
      return Math.max(h, sum / n);
    });
    const nadEf = start ? nad : Math.min(nad, 0.3 * vyskaKamery());
    let A, B;
    try { A = bodVeVysce(a, profil[0] + nadEf); B = bodVeVysce(b, profil[16] + nadEf); } catch (e) { return null; }
    if (!A || !B) return null;
    const kx = 111320 * Math.cos(A.lat * Math.PI / 180);
    const dx = (B.lng - A.lng) * kx, dy = (B.lat - A.lat) * 111320, L = Math.hypot(dx, dy);
    if (!(L > 30) || L > 20000) return null;
    const ptaci = sestava(c.tvar, start ? 1 : c.n()).map((q, i, vse) => Object.assign(q, {
      vel: 0.92 + Math.random() * 0.16, faze: Math.random(), frek: 0.9 + Math.random() * 0.2,
      rezim: 'mava', doba: Math.random() * 2, snimek: 0,
      // samice (kachna, vrabec): v páru jeden a jeden, jinak podle podílu
      kl: druh + (c.samice && ((vse.length === 2 && i === 1) || (vse.length !== 2 && Math.random() < c.samice)) ? '_s' : '') }));
    let predni = 0, zadni = 0;
    for (const q of ptaci) { predni = Math.max(predni, q.podel); zadni = Math.max(zadni, -q.podel); }
    const hT = vyskaTerenu(A.lng, A.lat);
    if (c.klikaty) for (const q of ptaci) { q.kmit = 1.6; q.w2 = 1.3 + Math.random() * 1.1; q.w1 = 0.5 + Math.random() * 0.4; }
    pripravSprity(Array.from(new Set(ptaci.map((q) => q.kl))), tridaPx(c.rozM / metryNaPx(mapa.getZoom(), A.lat)), tonNoci(performance.now()));
    return { druh, c, A, dx, dy, L, luk: start ? 0 : nah(0.12) * L, nad, profil, alt: profil[0] + nadEf, predni, zadni,
             s: start ? 0 : null, noc: !!(c.noc || (druh === 'husa' && nocniSmi(pocasi(performance.now())))), zeStromu: !!start,
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
      const U = l.c.rozM;                              // rozestupy v rozpětích druhu (m)
      if (l.s === null) l.s = -l.predni * U - 2;       // i přední ptáci začínají za okrajem
      {
        const fu = Math.max(0, Math.min(1, l.s / l.L)) * 16, i0 = Math.floor(fu), i1 = Math.min(16, i0 + 1);
        const hP = l.profil[i0] + (l.profil[i1] - l.profil[i0]) * (fu - i0);
        l.alt = hP + (l.zeStromu ? l.nad : Math.min(l.nad, 0.3 * vyskaKamery()));   // přiblížení = kamera níž → strop výšky
      }
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
      const smiLet = l.noc ? nocniSmi(st) : ptaciSmi(st);
      if (!l.zanikMs && (!smiLet || z < odZoomDruhu(l.c, l.y) - 1)) l.zanikMs = t;   // déšť, rozednění, velké oddálení: rychle zmizet
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
  function kresliPtaky(t, st, ton) {
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
    for (const l of lety.slice().sort((a, b) => a.alt - b.alt)) {
      const U = l.c.rozM;
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
        const S = Math.min(MAX_PX_PTAKA, U * vs.lam) / 100;
        if (S * 100 >= 2) {
          for (const [lon, lat, p] of pozice) {
            const q = bod(lon + ox, lat + oy, l.teren);
            kresliSprite(hotovySprite(p.kl, 0).stin || spriteDruhu(p.kl, 0).stin, p.snimek, q.x, q.y, vs, S * p.vel, stinA * alfa);
          }
        }
      }
      // velikost ze SVĚTA: rozpětí (m) × px na metr v místě a výšce ptáka (perspektiva)
      const vz = vektoryLetu(l.x, l.y, l.alt, l.uhel, kx);
      const S = Math.min(MAX_PX_PTAKA, U * vz.lam) / 100;
      const tr = tridaPx(S * 100);
      let videt = false;
      for (const [lon, lat, p] of pozice) {
        const q = bod(lon, lat, l.alt);
        if (q.x > -40 && q.x < W + 40 && q.y > -40 && q.y < H + 40) videt = true;
        if (S * 100 < 2) continue;
        let v = vz;
        if (l.c.klikaty) {                             // lelek: natočení podle bočního pohybu (kličky)
          const bocni = p.kmit * p.w2 * Math.cos(p.f2 + t / 1000 * p.w2) * U;
          v = vektoryLetu(lon, lat, l.alt, l.uhel - Math.atan2(bocni, l.v), kx);
        }
        kresliSprite(hotovySprite(p.kl, tr, ton), p.snimek, q.x, q.y, v, S * p.vel, alfa);
      }
      if (videt) l.videtMs = t;
    }
    ctx.setTransform(hustota, 0, 0, hustota, 0, 0);
    ctx.globalAlpha = 1;
  }
  function krokVoda(t, st) {
    for (let i = krouzky.length - 1; i >= 0; i--) if ((t - krouzky[i].t0) / 1000 > krouzky[i].zivot) krouzky.splice(i, 1);
    if (mapa.getZoom() < VODA_OD_Z || !vodni.length || vodaZamrzla(st) || t < dalsiRybaMs || necinny()) return;
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
    if (!mapa || !platno || !smi() || necinny()) return false;
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
  // ------------------------------------------------------------------ sovy na stromech
  // ⭐ engine 344: sovy SEDÍ v korunách stromů (dekorace) – vybrané hashem polohy stromu
  // a čísla noci (každou noc jinde, během noci stále tytéž); v lese puštík (občas kalous),
  // ovocné stromy ve vsi sýček a sova pálená, v zimě (XII–II) hejnko kalousů v jednom
  // vesnickém stromě. Poloha a velikost podle billboardu stromu (ikona `bottom`, posun 8,
  // icon-size × perspektiva MapLibre 0,5 + 0,5·c2c/d), sova ~3 m (stylizace jako ptáci).
  // Mrkají, otáčejí hlavu a v noci se jim lesknou oči; kreslí se jen při změně (události),
  // ne 24 Hz. Občas sova ze stromu vzlétne (let ze stejného místa).
  let sedici = [], sediciSig = '', sovaCasovac = 0;
  const sovyPryc = new Set();
  function h32(a, b, c) {
    let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  /// číslo noci (večer i následné ráno mají totéž číslo)
  function cisloNoci() {
    const d = new Date();
    return Math.floor((d.getTime() / 3600000 - d.getTimezoneOffset() / 60 - 12) / 24);
  }
  function obnovSedici(st) {
    const z = mapa.getZoom();
    // za svítání (sovy už nesedí) zůstanou jen VIDITELNÉ sovy – ty postupně odletí (kontrola)
    if (!sovySedi(st) && z >= 15.6 && sedici.some((q) => q.vidi && !q.pryc)) {
      sedici = sedici.filter((q) => q.vidi && !q.pryc);
      return;
    }
    if (!sovySedi(st) || z < 15.6 || typeof Dekorace === 'undefined' || !Dekorace.zapsane) {
      if (sedici.length) { sedici = []; sediciSig = ''; naplanuj(); }
      return;
    }
    const b = mapa.getBounds();
    const pw = (b.getEast() - b.getWest()) * 0.15, ph = (b.getNorth() - b.getSouth()) * 0.15;
    const w = b.getWest() - pw, e = b.getEast() + pw, so = b.getSouth() - ph, n = b.getNorth() + ph;
    const noc_ = cisloNoci();
    const sig = Dekorace.kotvyVerze() + '|' + [w, so, e, n].map((v) => v.toFixed(3)).join(',') + '|' + noc_;
    if (sig === sediciSig) return;
    sediciSig = sig;
    const m = mesic(), zima = m === 12 || m <= 2;
    const kominy = [];
    try { for (const f of Dekorace.kotvyAnimaci().komin) if (f.lon > w && f.lon < e && f.lat > so && f.lat < n) kominy.push(f); } catch (er) { /* nic */ }
    const cosL = Math.cos(mapa.getCenter().lat * Math.PI / 180);
    const veVsi = (lon, lat) => kominy.some((f) => Math.hypot((f.lon - lon) * cosL, f.lat - lat) * 111320 < 150);
    const stare = new Map(sedici.map((q) => [q.key, q]));
    const nove = [];
    let hejnko = null;
    const pridej = (lon, lat, k, ev, druh, fH, dx, key) => {
      const q = stare.get(key) || { key, lon, lat, k, ev, druh, fH, dx, h: null, fr: 0, dalsi: performance.now() + Math.random() * 4000, vidi: false };
      q.pryc = sovyPryc.has(key);
      nove.push(q);
    };
    for (const f of Dekorace.zapsane()) {
      const pr = f.properties || {}, k = +pr.k || 0;
      if (k < 0.45 || !String(pr.ik || '').startsWith('deko-strom')) continue;        // stromy, ne keře
      const [lon, lat] = f.geometry.coordinates;
      if (lon < w || lon > e || lat < so || lat > n) continue;
      const ix = Math.round(lon * 1e5), iy = Math.round(lat * 1e5);
      const ovocny = k < 0.9;
      const h = h32(ix, iy, noc_);
      if (zima && (!hejnko || h < hejnko.h) && veVsi(lon, lat)) hejnko = { h, lon, lat, k, ev: +pr.ev || 1, ix, iy };
      // hustota stálá, nezávislá na zoomu (nic nenaskakuje); engine 347 (výtka T: „je jich hodně“):
      // 1/14 a 1/18 → 1/40 a 1/50 (ve vsi na z16 dřív ~5 sov ve výřezu, teď 1–2)
      if (h > (ovocny ? 1 / 40 : 1 / 50)) continue;
      const h2 = h32(ix + 7, iy - 3, noc_), h3 = h32(ix - 5, iy + 11, noc_), h4 = h32(ix + 13, iy + 17, noc_);
      let druh;
      if (ovocny) druh = veVsi(lon, lat) ? (h2 < 0.5 ? 'sycek' : 'sova_palena') : (h2 < 0.6 ? 'kalous' : 'pustik');
      else druh = h2 < 0.8 ? 'pustik' : 'kalous';
      pridej(lon, lat, k, +pr.ev || 1, druh, 0.42 + h3 * 0.2, (h4 - 0.5) * 0.36, ix + ',' + iy);
    }
    if (hejnko) {                                           // zimní hejnko kalousů ve vsi
      const pocet = 4 + Math.floor(h32(hejnko.ix, hejnko.iy, noc_ + 1) * 6);
      for (let i = 0; i < pocet; i++) {
        const fH = 0.3 + 0.45 * ((i * 0.618) % 1), dx = ((i * 0.37 + 0.13) % 1 - 0.5) * 0.6;
        pridej(hejnko.lon, hejnko.lat, hejnko.k, hejnko.ev, 'kalous', fH, dx, hejnko.ix + ',' + hejnko.iy + ':' + i);
      }
    }
    const c = mapa.getCenter();
    nove.sort((a2, b2) => Math.hypot(a2.lon - c.lng, a2.lat - c.lat) - Math.hypot(b2.lon - c.lng, b2.lat - c.lat));
    sedici = nove.slice(0, 6);                             // engine 347: 16 → 6 nejbližších
    const ton = tonNoci(performance.now());
    const hPx = 3.2 * 0.19686 * Math.pow(2, z - 13.25);
    pripravSprity(Array.from(new Set(sedici.map((q) => q.druh))), tridaSovy(hPx), ton, true);
    naplanuj();
  }
  /// mrknutí, otočení hlavy (vlevo, vpravo, výjimečně dozadu); vrací čas nejbližší změny
  function krokSovy(t) {
    let nejbl = Infinity;
    for (const q of sedici) {
      if (q.pryc) continue;
      if (t >= q.dalsi) {
        if (q.fr === 4) { q.fr = q.predMrk || 0; q.dalsi = t + 1500 + Math.random() * 5000; }
        else if (q.fr !== 0) { q.fr = 0; q.dalsi = t + 2000 + Math.random() * 6000; }
        else {
          const r = Math.random();
          if (r < 0.4) { q.predMrk = 0; q.fr = 4; q.dalsi = t + 140; }
          else if (r < 0.9) { q.fr = r < 0.65 ? 1 : 2; q.dalsi = t + 1200 + Math.random() * 3500; }
          else { q.fr = 3; q.dalsi = t + 900 + Math.random() * 1500; }
        }
      }
      nejbl = Math.min(nejbl, q.dalsi);
    }
    return nejbl;
  }
  function kresliSedici(t, st, ton) {
    let kresleno = 0;
    if (!sedici.length) return 0;
    const z = mapa.getZoom(), c = mapa.getCenter(), mPxC = metryNaPx(z, c.lat);
    const br = mapa.getBearing() * Math.PI / 180, rx = Math.cos(br), ry = -Math.sin(br);   // vodorovně na obrazovce (v, s)
    const W = platno.width / hustota, H = platno.height / hustota;
    const zakl = 0.19686 * Math.pow(2, z - 13.25);          // px na metr stromu při perspektivě 1
    // engine 346 (výtka T: „možná by jim mohly více svítit oči“): silnější odlesk + měkký svit kolem;
    // engine 347 (výtka T: „svítí až moc“): mezi 345 (0,25/0,45/0,6, bez svitu) a 346 (0,5/0,8/0,95)
    const leskA = [0, 0.35, 0.55, 0.7][ton] || 0;
    for (const q of sedici) {
      q.vidi = false;
      if (q.pryc) continue;
      if (q.h === null) { q.h = vyskaTerenu(q.lon, q.lat); if (q.h === null) continue; }
      const p0 = bod(q.lon, q.lat, q.h);
      if (p0.x < -80 || p0.x > W + 80 || p0.y < -40 || p0.y > H + 200) continue;
      const kx = 111320 * Math.cos(q.lat * Math.PI / 180);
      const p1 = bod(q.lon + rx * 5 / kx, q.lat + ry * 5 / 111320, q.h);
      // engine 345: stromy mají PLNOU perspektivu (záplata bundlu OKOLNIK_PERSPEKTIVA)
      const pr = Math.max(0, Math.min(4, (Math.hypot(p1.x - p0.x, p1.y - p0.y) / 5) * mPxC));
      const sPx = q.k * 0.046 * Math.pow(2, z - 13.25) * pr;          // px na CSS px obrázku stromu (bez ev)
      const hS = 90 * sPx;                                 // kresba stromu bez okrajů
      const x = p0.x + q.dx * hS, y = p0.y + 8 * sPx - 4 * sPx - q.fH * hS;
      const hPx = Math.min(120, SOVA_VYSKA_M[q.druh] * zakl * pr);
      if (hPx < 2.5) continue;
      const sp = hotovaSova(q.druh, tridaSovy(hPx), ton);
      const sc = hPx / (100 * sp.m);
      ctx.globalAlpha = 1;
      ctx.setTransform(hustota * sc, 0, 0, hustota * sc, hustota * x, hustota * y);
      ctx.drawImage(sp.snimky[q.fr], -sp.N / 2, -sp.N * 0.9);
      q.vidi = true; q.sx = x; q.sy = y - hPx * 0.5; q.hPx = hPx;
      q.nadM = (0.041 + 0.918 * q.fH) * 22.9 * q.k;
      kresleno++;
      if (leskA > 0 && q.fr <= 2) {                        // odlesk očí v noci
        ctx.setTransform(hustota, 0, 0, hustota, 0, 0);
        for (const [ex, ey, er] of sp.oci[q.fr]) {
          const gx = x + (ex - sp.N / 2) * sc, gy = y + (ey - sp.N * 0.9) * sc, rr = Math.max(1.2, er * sc * 1.9);
          const halo = ctx.createRadialGradient(gx, gy, 0, gx, gy, rr * 1.9);      // měkký svit kolem (347: menší, slabší)
          halo.addColorStop(0, 'rgba(255,190,110,0.4)'); halo.addColorStop(1, 'rgba(255,170,90,0)');
          ctx.globalAlpha = leskA * 0.35;
          ctx.fillStyle = halo;
          ctx.beginPath(); ctx.arc(gx, gy, rr * 1.9, 0, Math.PI * 2); ctx.fill();
          const gr = ctx.createRadialGradient(gx, gy, 0, gx, gy, rr);
          gr.addColorStop(0, '#ffe9c4'); gr.addColorStop(0.4, SOVY[q.druh].lesk); gr.addColorStop(1, 'rgba(255,170,90,0)');
          ctx.globalAlpha = leskA;
          ctx.fillStyle = gr;
          ctx.beginPath(); ctx.arc(gx, gy, rr, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }
    ctx.setTransform(hustota, 0, 0, hustota, 0, 0);
    return kresleno;
  }
  let sovNaPlatne = 0, dalsiSovaMs = Infinity;
  /// překreslení kvůli sovám jen v čase další změny (mrknutí, otočení hlavy)
  function planujSovy(t) {
    if (sovaCasovac || !sovNaPlatne || necinny() || !isFinite(dalsiSovaMs)) return;
    sovaCasovac = setTimeout(() => { sovaCasovac = 0; naplanuj(); }, Math.max(40, dalsiSovaMs - t));
  }
  function neco(st) {
    if (oblacky.length || krouzky.length || lety.length || kudrlinky.length) return true;
    if (necinny()) return false;
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
    const ton = tonNoci(t);
    dalsiSovaMs = krokSovy(t);
    kresliVodu(t, st);
    kresliKour(t, st);
    sovNaPlatne = kresliSedici(t, st, ton);
    kresliVitr(t);
    kresliPtaky(t, st, ton);
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
    if (neco(st)) naplanuj();
    else if (sovNaPlatne) planujSovy(t);                   // sovy: jen další změna, ne 24 Hz
    else vycisti(false);
  }
  function naRender() {
    if (!mapa || !platno || !pohybMapy() || !smi()) return;
    const t = performance.now();
    if (!neco(pocasi(t)) && !sedici.length) { vycisti(false); return; }
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
    obnovSedici(st);
    // svítání: viditelné sovy odlétají jedna po druhé (nemizí na místě)
    if (!sovySedi(st) && sedici.length && lety.length < MAX_LETU) {
      const q = sedici.find((x) => x.vidi && !x.pryc);
      const l = q ? novyLet(q.druh, q) : null;
      if (l) { q.pryc = true; sovyPryc.add(q.key); lety.push(l); naplanuj(); }
    }
    const vNoci = nocniSmi(st);
    if (!necinny() && lety.length < MAX_LETU && (t > dalsiLetMs || vynut().ptaciHned) && mapa.getZoom() >= PTACI_OD_Z
        && (vNoci || ptaciSmi(st))) {
      const druh = vynut().druh || vyberDruh(mapa.getZoom(), lety.map((l) => l.druh), vNoci);
      let l = null;
      if (druh && PTACI[druh]) {
        // engine 344: polovina sovích letů začne VZLETEM ze stromu, kde sova seděla
        if (PTACI[druh].sova && Math.random() < 0.5) {
          const vid = sedici.filter((q) => !q.pryc && q.vidi && q.druh === druh);
          if (vid.length) {
            const q = vid[Math.floor(Math.random() * vid.length)];
            l = novyLet(druh, q);
            if (l) { q.pryc = true; sovyPryc.add(q.key); }
          }
        }
        if (!l) l = novyLet(druh);
      }
      if (l) { lety.push(l); posledniDruh = druh; dalsiLetMs = t + (vNoci ? 30000 + Math.random() * 40000 : 20000 + Math.random() * 25000); }
      else dalsiLetMs = t + 10000;
      if (window.__animaceVynut) window.__animaceVynut.ptaciHned = false;
    }
    if (neco(st)) naplanuj();
    else if (sedici.length && !sovNaPlatne) naplanuj();   // sovy ještě nenakreslené
  }

  function pripoj(m) {
    if (mapa === m && platno && platno.isConnected) return;
    mapa = m;
    if (!zajistiPlatno()) return;
    if (!pripoj.hotovo) {
      pripoj.hotovo = true;
      mapa.on('move', aktivita);
      mapa.on('render', naRender);
      mapa.on('moveend', () => { obnovKotvy(false); try { obnovSedici(pocasi(performance.now())); } catch (e) { /* nic */ } });
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
                     sov: sedici.length, sovKresleno: sovNaPlatne, necinny: necinny(), ton: tonNoci(performance.now()),
                     uroven, cenaMs: +cenaEma.toFixed(2),
                     hustota, platno: platno ? platno.width + 'x' + platno.height : null }),
      // předskok 0–1 = kolik z cesty k cíli má let už za sebou (0,5 ≈ uprostřed obrazovky)
      hejnoTed: (predskok, druh) => {
        if (!mapa) return false;
        druh = druh || vyberDruh(mapa.getZoom(), [], nocniSmi(pocasi(performance.now()))) || 'vrana';
        const l = novyLet(druh);
        if (!l) return false;
        lety.length = 0;
        lety.push(l);
        l.s = (predskok || 0) * l.L;
        naplanuj();
        return druh + '×' + l.ptaci.length;
      },
      druhy: () => Object.keys(PTACI),
      sovy: () => sedici.map((q) => ({ druh: q.druh, vidi: q.vidi, lon: q.lon, lat: q.lat, x: Math.round(q.sx || 0), y: Math.round(q.sy || 0), px: +(q.hPx || 0).toFixed(1), fr: q.fr, pryc: !!q.pryc })),
      sovyZnovu: () => { sediciSig = ''; obnovSedici(pocasi(performance.now())); return sedici.length; },
      vzletSovy: () => {                                        // ladění: vzlet první viditelné sovy
        const q = sedici.find((x) => !x.pryc && x.vidi);
        if (!q) return false;
        const l = novyLet(q.druh, q);
        if (!l) return false;
        q.pryc = true; sovyPryc.add(q.key); lety.push(l); naplanuj();
        return q.druh;
      },
      kudrlinky: () => kudrlinky.map((k) => { const p = bod(k.lon, k.lat, k.h); return [Math.round(p.x), Math.round(p.y), +((performance.now() - k.t0) / k.zivot).toFixed(2)]; }),
      nahledDruhu: (klic, N) => upecDruh2(klic, N || 96, (N || 96) / 114, false).snimky.map((c) => c.toDataURL ? c.toDataURL() : null),
      velikost: () => lety.map((l) => { const kx = 111320 * Math.cos(l.y * Math.PI / 180); const v = vektoryLetu(l.x, l.y, l.alt, l.uhel, kx);
        return { druh: l.druh, rozM: l.c.rozM, px: +(Math.min(MAX_PX_PTAKA, l.c.rozM * v.lam)).toFixed(1), nad: Math.round(l.alt - l.teren), kamera: Math.round(vyskaKamery()) }; }),
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
