// ⭐ engine 328 (18. 9. 2026): VÍTR – „větrné kudrlinky“ při silném větru.
//
// Přání T: „tam, kde fouká vítr (vysoká rychlost), ať prolétnou větrné
// kudrlinky“. Data o větru posílá appka s počasím (Open-Meteo `current`:
// wind_speed_10m, wind_direction_10m, wind_gusts_10m, km/h a ° ODKUD) –
// viz `Pocasi.vitr()`. Prahy jsou NÍZKO schválně: v nížinách ČR fouká
// ≥ 30 km/h jen pár hodin za rok (ERA5 2025: Pardubice 0 % hodin, nárazy
// ≥ 50 km/h 1,2 %), takže stupeň 1 = vítr ≥ 15 nebo nárazy ≥ 35 km/h,
// stupeň 2 = vítr ≥ 25 nebo nárazy ≥ 50 km/h.
//
// JAK (stejná pravidla jako roj v dekorace.js – žádný rAF v klidu):
//  • kudrlinky jsou holé divy se SVG spirálkou v kontejneru plátna,
//    pohyb v OBRAZOVKOVÝCH pixelech (jsou to poryvy vzduchu, ne věci ve
//    světě; při 10 m/s by posun ve světě dělal 2–13 px/s – stály by),
//  • letí V PORYVECH: stupeň 1 jednou za 14–24 s dvě kudrlinky, stupeň 2
//    jednou za 6–12 s čtyři; poryv trvá ~2,5–3 s a mezi poryvy se DOM
//    NEMĚNÍ (žádné snímky navíc v klidu),
//  • krok z KlidovyTakt každý tik (10 Hz) jen během poryvu; při pohybu
//    mapy a do 1,5 s po něm se poryvy nerodí (snímky vznikají tak jako tak,
//    ale kudrlinka by seděla na jiném místě krajiny),
//  • směr = kam vítr fouká, srovnaný o natočení mapy; v noci ztlumeno,
//  • jen v herním stylu (mlha) od z15, appka viditelná.
// Test bez vichřice: window.__vynutSvetlo = {vitr: 40, vitrSmer: 270, naraz: 60}
// (čte se přes Pocasi.stavSvetla, ne přímo z dat).
(function () {
  'use strict';
  const STUPEN1 = { vitr: 15, naraz: 35 };
  const STUPEN2 = { vitr: 25, naraz: 50 };
  const OD_Z = 15;
  let mapa = null;
  let kudrlinky = [];        // { el, x, y, vx, vy, zivot, t, maxOpac, meritko }
  let dalsiPoryvMs = 0;
  let poryvDoMs = 0;
  let bazenek = [];          // recyklované divy

  // spirálka větru: dvě zatočené čáry, bílá s tmavým stínem (čitelná na
  // světlé i tmavé krajině), průhledná – kreslí se scale/rotate podle směru
  // ⭐ engine 333 (výtka T 19. 9.: „ať se kudrlinka MALUJE, ne točí celá“):
  // cesty mají pathLength 100 a čárkování 100/100 → posun čárkování
  // (stroke-dashoffset) 100 → 0 = štětec tah postupně namaluje, 0 → −100 =
  // tah od začátku mizí (ocas dojede). Tmavá i bílá kopie téže křivky
  // dostávají týž posun (dvojice podle indexu i % 2).
  const CESTA = ' pathLength="100" stroke-dasharray="100 100" stroke-dashoffset="100"';
  const SVG = '<svg viewBox="0 0 48 20" width="48" height="20">'
    + '<g fill="none" stroke-linecap="round" stroke-width="2.6" stroke="rgba(30,40,40,0.28)">'
    + '<path' + CESTA + ' d="M2 12 C 14 12, 22 12, 30 8 C 36 5, 40 7, 38 11 C 36 14, 31 12, 33 9"/>'
    + '<path' + CESTA + ' d="M6 17 C 16 17, 24 17, 33 15 C 40 13, 43 15, 41 18"/>'
    + '</g>'
    + '<g fill="none" stroke-linecap="round" stroke-width="1.5" stroke="rgba(255,255,255,0.92)">'
    + '<path' + CESTA + ' d="M2 12 C 14 12, 22 12, 30 8 C 36 5, 40 7, 38 11 C 36 14, 31 12, 33 9"/>'
    + '<path' + CESTA + ' d="M6 17 C 16 17, 24 17, 33 15 C 40 13, 43 15, 41 18"/>'
    + '</g></svg>';

  /// Posun čárkování pro podíl života f (0–1): namalovat (do 38 %), chvíli
  /// držet (do 52 %), pak tah od začátku zmizí (do 100 %).
  function posunTahu(f) {
    if (f <= 0) return 100;
    if (f < 0.38) { const u = f / 0.38; return 100 * (1 - u) * (1 - u); }   // rychle, pak zvolna
    if (f < 0.52) return 0;
    if (f < 1) { const u = (f - 0.52) / 0.48; return -100 * u * u; }        // pomalu, pak rychle
    return -100;
  }

  function stupen() {
    try {
      if (typeof Pocasi === 'undefined' || !Pocasi.vitr) return 0;
      const v = Pocasi.vitr();
      if (!v) return 0;
      if (v.kmh >= STUPEN2.vitr || v.naraz >= STUPEN2.naraz) return 2;
      if (v.kmh >= STUPEN1.vitr || v.naraz >= STUPEN1.naraz) return 1;
      return 0;
    } catch (e) { return 0; }
  }

  function smiKreslit() {
    if (!mapa || document.visibilityState !== 'visible') return false;
    if (typeof aktualniKod === 'undefined' || typeof STYLY === 'undefined'
        || !STYLY[aktualniKod] || !STYLY[aktualniKod].mlha) return false;
    if (mapa.getZoom() < OD_Z) return false;
    return true;
  }

  /// směr letu na obrazovce (jednotkový vektor; y dolů) – kam vítr fouká,
  /// srovnaný o natočení mapy
  function smerNaObrazovce() {
    const v = Pocasi.vitr();
    const kam = ((((v.smerOdkud || 0) + 180) - (mapa.getBearing ? mapa.getBearing() : 0)) % 360 + 360) % 360;
    const a = kam * Math.PI / 180;
    return { x: Math.sin(a), y: -Math.cos(a), uhelDeg: kam };
  }

  function prvek() {
    let el = bazenek.pop();
    if (!el) {
      el = document.createElement('div');
      el.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;'
        + 'width:48px;height:20px;margin:-10px 0 0 -24px;will-change:transform,opacity;';
      el.innerHTML = SVG;
      el.__cesty = el.querySelectorAll('path');
    }
    // recyklace z bazénku: tah zase od nuly
    if (el.__cesty) for (const c of el.__cesty) c.setAttribute('stroke-dashoffset', '100');
    return el;
  }

  function zrodPoryv(st) {
    const pl = mapa.getCanvas();
    const W = pl.clientWidth, H = pl.clientHeight;
    if (!W || !H) return;
    const s = smerNaObrazovce();
    const kolmo = { x: -s.y, y: s.x };
    const pocet = st === 2 ? 4 : 2;
    const rychlost = (st === 2 ? 130 : 80) * (0.85 + Math.random() * 0.3);   // px/s
    const noc = typeof krokNoci === 'number' && krokNoci >= 2;
    const R = Math.hypot(W, H) / 2 + 40;
    for (let i = 0; i < pocet; i++) {
      // zrod na návětrném okraji: střed − směr·R + kolmý rozptyl
      const k = (Math.random() - 0.5) * Math.min(W, H) * 0.9;
      // engine 332/333: rodí se blíž (0,55–0,95 R proti větru), žije jen
      // 2,4–3,4 s – mezitím se namaluje, letí po větru a zase rozplyne
      const rr = R * (0.55 + Math.random() * 0.4);
      const x = W / 2 - s.x * rr + kolmo.x * k;
      const y = H / 2 - s.y * rr + kolmo.y * k;
      const el = prvek();
      const meritko = 0.8 + Math.random() * 0.5 + (st === 2 ? 0.2 : 0);
      el.style.opacity = '0';
      el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) '
        + 'rotate(' + (s.uhelDeg - 90).toFixed(0) + 'deg) scale(' + meritko.toFixed(2) + ')';
      mapa.getCanvasContainer().appendChild(el);
      kudrlinky.push({
        el, x, y, meritko,
        vx: s.x * rychlost, vy: s.y * rychlost,
        faze: Math.random() * Math.PI * 2,
        kolmo, uhel: s.uhelDeg - 90,
        zpozdeni: i * (0.25 + Math.random() * 0.35),   // s – ať neletí v řadě
        t: 0, maxOpac: (noc ? 0.4 : 0.85) * (0.8 + Math.random() * 0.2),
        zivot: 2.4 + Math.random() * 1.0,                // s – délka života
        W, H,
      });
    }
    poryvDoMs = performance.now() + 3600;
  }

  let posledniTikMs = 0;
  function tik(t) {
    try {
      if (!smiKreslit()) { uklid(); return; }
      const dt = posledniTikMs ? Math.min(0.25, (t - posledniTikMs) / 1000) : 0.1;
      posledniTikMs = t;
      const st = stupen();
      if (kudrlinky.length === 0) {
        if (!st) { dalsiPoryvMs = 0; return; }
        // mezi poryvy se nic nekreslí; první poryv brzy po zesílení větru
        if (!dalsiPoryvMs) dalsiPoryvMs = t + 1500 + Math.random() * 2000;
        if (t < dalsiPoryvMs) return;
        // ne během pohybu mapy ani hned po něm
        if ((mapa.isMoving && mapa.isMoving())
            || t - (window.__posledniPohybMs || 0) < 1500) return;
        zrodPoryv(st);
        const [a, b] = st === 2 ? [6000, 12000] : [14000, 24000];
        dalsiPoryvMs = t + a + Math.random() * (b - a);
        return;
      }
      // let: posun v px/s, jemné vlnění napříč, nástup/doznění krytí
      const zbyva = [];
      for (const k of kudrlinky) {
        k.t += dt;
        if (k.t < k.zpozdeni) { zbyva.push(k); continue; }
        const ziv = k.t - k.zpozdeni;
        k.x += k.vx * dt; k.y += k.vy * dt;
        const vln = Math.sin(ziv * 2.2 + k.faze) * 6;
        const px = k.x + k.kolmo.x * vln, py = k.y + k.kolmo.y * vln;
        const mimo = px < -60 || py < -60 || px > k.W + 60 || py > k.H + 60;
        if (!mimo) k.bylVidet = true;
        // engine 333: f = podíl života; tah se MALUJE (posun čárkování –
        // viz posunTahu), kudrlinka se neotáčí, jen letí po větru; krytí
        // naskočí za 0,4 s a úplně na konci dozní (mazání dělá čárkování)
        const f = Math.min(1, ziv / k.zivot);
        const nastup = Math.min(1, ziv / 0.4);
        const doz = f < 0.85 ? 1 : 1 - (f - 0.85) / 0.15;
        const opac = k.maxOpac * nastup * doz;
        // pryč po dožití (nebo po opuštění obrazovky)
        if ((mimo && k.bylVidet) || f >= 1) {
          k.el.remove(); k.el.style.opacity = '0';
          bazenek.push(k.el);
          continue;
        }
        const c = k.el.__cesty;
        if (c) {
          // druhý tah (spodní čára) o 0,15 s později – jako druhý šmrnc štětcem
          const f2 = Math.min(1, Math.max(0, (ziv - 0.15) / k.zivot));
          const p1 = posunTahu(f).toFixed(1), p2 = posunTahu(f2).toFixed(1);
          for (let i = 0; i < c.length; i++) c[i].setAttribute('stroke-dashoffset', i % 2 ? p2 : p1);
        }
        k.el.style.opacity = opac.toFixed(2);
        k.el.style.transform = 'translate(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px) '
          + 'rotate(' + k.uhel.toFixed(0) + 'deg) scale(' + k.meritko.toFixed(2) + ')';
        zbyva.push(k);
      }
      kudrlinky = zbyva;
    } catch (e) { /* styl v přestavbě – příští tik */ }
  }

  function uklid() {
    for (const k of kudrlinky) { try { k.el.remove(); } catch (e) { /* pryč */ } }
    kudrlinky = [];
    dalsiPoryvMs = 0;
  }

  let pripojeno = false;
  function pripoj(map) {
    mapa = map;
    if (pripojeno) return;
    pripojeno = true;
    if (window.KlidovyTakt) KlidovyTakt.pridej('vitr', tik, 1);
    else setInterval(() => tik(performance.now()), 100);
  }

  window.Vitr = { pripoj, stupen, uklid,
    // pro CDP diagnostiku
    stav: () => ({ stupen: stupen(), kudrlinek: kudrlinky.length, dalsiPoryvZaMs: Math.max(0, dalsiPoryvMs - performance.now()) | 0 }) };
})();
