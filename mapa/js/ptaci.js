/* ⭐ KÁNĚ NAD KRAJINOU (5. 9. 2026; výtka 2. kola: „příliš velká, moc se
 * káňatům nepodobají, je jich zbytečně moc a pohyb je trhaný").
 *
 * JEDNO káně krouží vysoko nad mapou (herní styl, den, bez deště a sněhu,
 * zoom ≥ 12). Technika jako hmyz (dekorace.js): DOM prvek v
 * canvasContaineru, poloha přes `transform.locationToScreenPoint`
 * s NADMOŘSKOU VÝŠKOU terén + ~120 m, takže v nakloněné 3D mapě pták
 * opravdu letí nad zemí. Pod ním na zemi leží STÍN posunutý od slunce
 * (`Pocasi.stavSvetla()`: azimut + výška).
 *
 * Pohyb: requestAnimationFrame s dt (plynule, ne 20 Hz tik), kroužení po
 * elipse s pomalu putujícím středem (termika), natočení po směru letu,
 * každých 8–15 s krátké zamávání (CSS), jinak plachtí. Výška terénu se
 * doměřuje občas a vyhlazuje, ať pták neskáče. Střed se přesune, když
 * odletí z výřezu. Levné: dva prvky, žádný dotaz do GPU.
 */
const Ptaci = (() => {
  'use strict';
  let mapa = null;
  let ptaci = [];
  let bezi = false;
  let poslT = 0;
  const VYSKA_LETU = 120;          // m nad terénem
  const MAX_PTAKU = 1;

  const CSS = '@keyframes kaneMach{0%{transform:scaleY(1)}30%{transform:'
    + 'scaleY(.55)}55%{transform:scaleY(1.05)}80%{transform:scaleY(.7)}100%{'
    + 'transform:scaleY(1)}}'
    + '.kane-kridla{transform-origin:50% 62%;transform-box:fill-box}'
    + '.kane-machani .kane-kridla{animation:kaneMach .38s ease-in-out 3}'
    + '.kane{pointer-events:none;position:absolute;top:0;left:0;'
    + 'will-change:transform;}'
    + '.kane-stin{pointer-events:none;position:absolute;top:0;left:0;'
    + 'will-change:transform,opacity;}';

  // Káně shora, letí NAHORU (-y): tělo s malou hlavou, dlouhá široká
  // křídla s pěti „prsty" a zaoblenou zadní hranou, krátký vějířovitý ocas.
  const KANE_SVG = '<svg viewBox="0 0 100 60" width="100" height="60">'
    + '<g class="kane-kridla" fill="#4a3a2a" opacity="0.9">'
    // levé křídlo
    + '<path d="M50 30 C42 24 30 20 16 22 C10 23 5 25 2 27 '
    + 'L4 24 L7 23 L5 20 L9 21 L8 18 L12 20 L12 17 L15 20 L16 17 L19 21 '
    + 'C28 22 40 28 50 38 Z"/>'
    // pravé křídlo
    + '<path d="M50 30 C58 24 70 20 84 22 C90 23 95 25 98 27 '
    + 'L96 24 L93 23 L95 20 L91 21 L92 18 L88 20 L88 17 L85 20 L84 17 L81 21 '
    + 'C72 22 60 28 50 38 Z"/>'
    // světlejší pruh na spodku křídel (káně mívá světlé pole)
    + '<path fill="#8a7460" opacity="0.55" d="M22 24 C32 24 42 29 50 36 '
    + 'C58 29 68 24 78 24 C68 27 58 31 50 39 C42 31 32 27 22 24 Z"/>'
    + '</g>'
    // tělo + hlava
    + '<path fill="#3a2c1e" d="M47 22 C47 17 53 17 53 22 L54 36 '
    + 'C54 40 55 44 58 48 L50 46 L42 48 C45 44 46 40 46 36 Z"/>'
    + '<ellipse cx="50" cy="20" rx="2.6" ry="3" fill="#2a1f14"/>'
    // ocas vějíř
    + '<path fill="#3a2c1e" opacity="0.9" d="M44 46 L56 46 L58 55 L50 52 '
    + 'L42 55 Z"/>'
    + '</svg>';

  function pripoj(m) {
    mapa = m;
    if (!document.getElementById('kane-css')) {
      const s = document.createElement('style');
      s.id = 'kane-css';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    if (!bezi) { bezi = true; poslT = performance.now(); requestAnimationFrame(snimek); }
  }

  function svetlo() {
    try {
      if (typeof Pocasi !== 'undefined' && Pocasi.stavSvetla) {
        return Pocasi.stavSvetla();
      }
    } catch (e) { /* bez počasí */ }
    return null;
  }

  /// Smí létat? Den, bez deště a sněhu, herní styl, přiblíženo aspoň na z12.
  function smiLetat() {
    if (!mapa || document.visibilityState !== 'visible') return false;
    if (mapa.getZoom() < 12) return false;
    if (typeof STYLY !== 'undefined' && typeof aktualniKod !== 'undefined'
        && STYLY && STYLY[aktualniKod] && !STYLY[aktualniKod].mlha) return false;
    const st = svetlo();
    if (!st) return true;
    if (typeof st.slunceEl === 'number' && st.slunceEl < 3) return false;
    if (st.druh && /dest|snih|bourka|mlha/i.test(String(st.druh))) return false;
    return true;
  }

  function novyPtak() {
    const c = mapa.getCenter();
    const b = mapa.getBounds();
    const sirka = b.getEast() - b.getWest();
    const vyska = b.getNorth() - b.getSouth();
    const sx = c.lng + (Math.random() - 0.5) * sirka * 0.5;
    const sy = c.lat + (Math.random() - 0.5) * vyska * 0.5;
    const el = document.createElement('div');
    el.className = 'kane';
    el.innerHTML = KANE_SVG;
    const stin = document.createElement('div');
    stin.className = 'kane-stin';
    stin.innerHTML = '<div style="width:60px;height:26px;border-radius:50%;'
      + 'background:radial-gradient(ellipse at center,rgba(20,16,10,.5) 0%,'
      + 'rgba(20,16,10,.22) 55%,rgba(20,16,10,0) 100%)"></div>';
    mapa.getCanvasContainer().appendChild(stin);
    mapa.getCanvasContainer().appendChild(el);
    return {
      sx, sy,
      r: 110 + Math.random() * 90,             // poloměr v metrech
      uhel: Math.random() * Math.PI * 2,
      rychlost: (0.22 + Math.random() * 0.1) * (Math.random() < 0.5 ? 1 : -1), // rad/s
      drift: Math.random() * Math.PI * 2,
      x: sx, y: sy, teren: null, terenCil: null,
      dalsiMach: performance.now() + 3000 + Math.random() * 6000,
      dalsiMereni: 0,
      el, stin, op: 0,
    };
  }

  function odstran(p) {
    try { p.el.remove(); } catch (e) { }
    try { p.stin.remove(); } catch (e) { }
  }

  /// Měřítko: z12 malý (0,28), z16 plný (0,6) – káně ve výšce je drobné.
  function velikost() {
    const z = Math.max(12, Math.min(16, mapa.getZoom()));
    return 0.28 + (z - 12) / 4 * 0.32;
  }

  function snimek(t) {
    if (!bezi) return;
    requestAnimationFrame(snimek);
    const dt = Math.min(0.1, Math.max(0.001, (t - poslT) / 1000));
    poslT = t;
    if (!mapa) return;
    const ok = smiLetat();
    const chci = ok ? MAX_PTAKU : 0;
    if (chci && !ptaci.length) ptaci.push(novyPtak());
    if (!ptaci.length) return;
    const st = svetlo();
    const b = mapa.getBounds();
    const mLat = 1 / 110574;
    for (let i = ptaci.length - 1; i >= 0; i--) {
      const p = ptaci[i];
      const mLon = 1 / (111320 * Math.cos(p.sy * Math.PI / 180));
      const cil = ok ? 1 : 0;
      p.op += (cil - p.op) * Math.min(1, dt * 1.5);
      if (cil === 0 && p.op < 0.03) { odstran(p); ptaci.splice(i, 1); continue; }
      // termika: střed putuje ~0,8 m/s; mimo výřez → nový střed
      p.drift += (Math.random() - 0.5) * 0.9 * dt;
      p.sx += Math.cos(p.drift) * 0.8 * dt * mLon;
      p.sy += Math.sin(p.drift) * 0.8 * dt * mLat;
      if (p.sx < b.getWest() || p.sx > b.getEast()
          || p.sy < b.getSouth() || p.sy > b.getNorth()) {
        const c = mapa.getCenter();
        p.sx = c.lng + (Math.random() - 0.5) * (b.getEast() - b.getWest()) * 0.4;
        p.sy = c.lat + (Math.random() - 0.5) * (b.getNorth() - b.getSouth()) * 0.4;
        p.op = 0;                                  // objeví se plynule
      }
      p.uhel += p.rychlost * dt;
      p.x = p.sx + Math.cos(p.uhel) * p.r * mLon;
      p.y = p.sy + Math.sin(p.uhel) * p.r * 0.75 * mLat;
      const tx = -Math.sin(p.uhel) * Math.sign(p.rychlost);
      const ty = Math.cos(p.uhel) * 0.75 * Math.sign(p.rychlost);
      p.smer = Math.atan2(tx, ty);                 // 0 = na sever
      if (t > p.dalsiMach) {
        p.el.classList.add('kane-machani');
        p.dalsiMach = t + 8000 + Math.random() * 7000;
        setTimeout(() => p.el.classList.remove('kane-machani'), 1200);
      }
      // výška terénu: doměřit občas, PLYNULE dohánět (žádné skoky)
      if (t > p.dalsiMereni) {
        p.dalsiMereni = t + 700;
        try {
          const v = mapa.queryTerrainElevation
              && mapa.queryTerrainElevation([p.x, p.y]);
          if (typeof v === 'number') {
            p.terenCil = v;
            if (p.teren === null) p.teren = v;
          }
        } catch (e) { }
      }
      if (p.teren !== null && p.terenCil !== null) {
        p.teren += (p.terenCil - p.teren) * Math.min(1, dt * 1.2);
      }
      p.st = st;
    }
    umisti();
  }

  /// Pták ve výšce terén+120 m, stín na zemi posunutý OD slunce (délka podle
  /// výšky slunce), slabší pod mraky a při nízkém slunci.
  function umisti() {
    if (!mapa || !ptaci.length) return;
    let tr;
    try { tr = mapa._camera.transform; } catch (e) { return; }
    const ter = mapa.terrain;
    const mer = velikost();
    for (const p of ptaci) {
      const teren = typeof p.teren === 'number' ? p.teren : 0;
      const ll = new maplibregl.LngLat(p.x, p.y);
      let bod;
      try {
        bod = ter
          ? tr.locationToScreenPoint(ll,
              { getElevationForLngLat: () => teren + VYSKA_LETU })
          : tr.locationToScreenPoint(ll);
      } catch (e) { continue; }
      const otoc = (p.smer || 0) * 180 / Math.PI;
      p.el.style.opacity = (0.88 * p.op).toFixed(2);
      p.el.style.transform = 'translate(-50%, -50%) translate(' + bod.x.toFixed(1)
        + 'px, ' + bod.y.toFixed(1) + 'px) rotate(' + otoc.toFixed(1) + 'deg) scale('
        + mer.toFixed(3) + ')';
      const st = p.st;
      let sx = 0, sy = 0, sila = 0.3;
      if (st && typeof st.slunceEl === 'number' && st.slunceEl > 0) {
        const el = Math.max(12, st.slunceEl) * Math.PI / 180;
        const delkaM = Math.min(160, VYSKA_LETU / Math.tan(el));
        const az = ((st.slunceAz || 0) + 180) * Math.PI / 180;
        sx = Math.sin(az) * delkaM;
        sy = Math.cos(az) * delkaM;
        sila = (0.14 + Math.min(0.24, st.slunceEl / 150))
          * (1 - Math.min(1, (st.oblacnost || 0) * 0.8));
      }
      const mLat = 1 / 110574;
      const mLon = 1 / (111320 * Math.cos(p.y * Math.PI / 180));
      const lls = new maplibregl.LngLat(p.x + sx * mLon, p.y + sy * mLat);
      let bs;
      try {
        bs = ter
          ? tr.locationToScreenPoint(lls, { getElevationForLngLat: () => teren })
          : tr.locationToScreenPoint(lls);
      } catch (e) { continue; }
      p.stin.style.opacity = (sila * p.op).toFixed(2);
      p.stin.style.transform = 'translate(-50%, -50%) translate(' + bs.x.toFixed(1)
        + 'px, ' + bs.y.toFixed(1) + 'px) rotate(' + otoc.toFixed(1) + 'deg) scale('
        + (mer * 0.9).toFixed(3) + ')';
    }
  }

  function odpoj() {
    for (const p of ptaci) odstran(p);
    ptaci = [];
    bezi = false;
  }

  return { pripoj, odpoj, _ladeni: { pocet: () => ptaci.length } };
})();
