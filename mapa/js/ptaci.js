/* ⭐ KÁNĚ NAD KRAJINOU (5. 9. 2026, přání: „udělej třeba i nějaké ptáky,
 * třeba kroužící káně, které občas zamává křídly").
 *
 * Jeden až dva ptáci krouží vysoko nad mapou (herní styl, den, bez deště
 * a sněhu, zoom ≥ 12). Technika jako hmyz (dekorace.js): DOM prvek
 * v canvasContaineru, poloha přes `transform.locationToScreenPoint`
 * s NADMOŘSKOU VÝŠKOU terén + ~120 m, takže v nakloněné 3D mapě pták
 * opravdu letí nad zemí. Pod ním na zemi leží STÍN posunutý od slunce
 * (`Pocasi.stavSvetla()`: azimut + výška) – první krok k „stínům pro 3D
 * pocit", které chce uživatel i u kreseb.
 *
 * Pohyb: kroužení po elipse s pomalu putujícím středem (termika),
 * natočení po směru letu, každých 7–14 s krátké zamávání (3 snímky
 * křídel v CSS), jinak plachtí. Střed se přesune, když odletí z výřezu.
 * Levné: dva prvky, tik 50 ms, žádný dotaz do GPU.
 */
const Ptaci = (() => {
  'use strict';
  let mapa = null;
  let tikac = null;
  let ptaci = [];
  const VYSKA_LETU = 120;          // m nad terénem
  const MAX_PTAKU = 2;

  const CSS = '@keyframes kaneMach{0%{transform:scaleX(1)}25%{transform:'
    + 'scaleX(.72) translateY(-1px)}50%{transform:scaleX(1.02)}75%{'
    + 'transform:scaleX(.8) translateY(1px)}100%{transform:scaleX(1)}}'
    + '.kane-kridla{transform-origin:50% 45%;transform-box:fill-box}'
    + '.kane-machani .kane-kridla{animation:kaneMach .32s ease-in-out 2}'
    + '.kane{pointer-events:none;position:absolute;top:0;left:0;'
    + 'will-change:transform;}'
    + '.kane-stin{pointer-events:none;position:absolute;top:0;left:0;'
    + 'will-change:transform,opacity;}';

  // Káně shora: široká křídla s „prsty", vějířovitý ocas, hlava vpřed.
  // Kreslí se směrem NAHORU (let = -y), natočení dělá transform.
  const KANE_SVG = '<svg viewBox="0 0 64 44" width="64" height="44">'
    + '<g class="kane-kridla" fill="#3a2e22" opacity="0.92">'
    + '<path d="M32 20 C24 12 12 10 2 14 L1 17 C6 16 9 17 10 19 '
    + 'L4 21 L11 22 L6 25 L13 24 L9 28 L15 26 C20 25 27 26 32 30 Z"/>'
    + '<path d="M32 20 C40 12 52 10 62 14 L63 17 C58 16 55 17 54 19 '
    + 'L60 21 L53 22 L58 25 L51 24 L55 28 L49 26 C44 25 37 26 32 30 Z"/>'
    + '</g>'
    + '<path fill="#2c2219" d="M29 14 C29 9 35 9 35 14 L36 30 '
    + 'C36 34 37 38 39 41 L32 39 L25 41 C27 38 28 34 28 30 Z"/>'
    + '<ellipse cx="32" cy="13" rx="3.2" ry="3.6" fill="#241b12"/>'
    + '</svg>';

  function pripoj(m) {
    mapa = m;
    if (!document.getElementById('kane-css')) {
      const s = document.createElement('style');
      s.id = 'kane-css';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    if (!tikac) tikac = setInterval(tik, 50);
    mapa.on('render', () => {
      if (mapa.isMoving && mapa.isMoving()) umisti();
    });
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
    // střed kroužení někde ve výřezu, ne u kraje
    const sx = c.lng + (Math.random() - 0.5) * sirka * 0.5;
    const sy = c.lat + (Math.random() - 0.5) * vyska * 0.5;
    const el = document.createElement('div');
    el.className = 'kane';
    el.innerHTML = KANE_SVG;
    const stin = document.createElement('div');
    stin.className = 'kane-stin';
    stin.innerHTML = '<div style="width:44px;height:22px;border-radius:50%;'
      + 'background:radial-gradient(ellipse at center,rgba(20,16,10,.55) 0%,'
      + 'rgba(20,16,10,.25) 55%,rgba(20,16,10,0) 100%)"></div>';
    mapa.getCanvasContainer().appendChild(stin);
    mapa.getCanvasContainer().appendChild(el);
    return {
      sx, sy,                                  // střed kroužení
      r: 90 + Math.random() * 70,              // poloměr v metrech
      uhel: Math.random() * Math.PI * 2,
      rychlost: (0.28 + Math.random() * 0.12) * (Math.random() < 0.5 ? 1 : -1),
      drift: Math.random() * Math.PI * 2,      // směr putování termiky
      x: sx, y: sy, vyska: 0,
      dalsiMach: performance.now() + 3000 + Math.random() * 6000,
      el, stin,
      op: 0,                                   // plynulé rození/mizení
    };
  }

  function odstran(p) {
    try { p.el.remove(); } catch (e) { }
    try { p.stin.remove(); } catch (e) { }
  }

  function velikost() {
    const z = Math.max(12, Math.min(16, mapa.getZoom()));
    return 0.45 + (z - 12) / 4 * 0.55;        // 0,45 → 1,0
  }

  function tik() {
    if (!mapa) return;
    const ok = smiLetat();
    const chci = ok ? (mapa.getZoom() >= 14 ? MAX_PTAKU : 1) : 0;
    while (ptaci.length < chci) ptaci.push(novyPtak());
    const ted = performance.now();
    const st = svetlo();
    const b = mapa.getBounds();
    const mLat = 1 / 110574;
    for (let i = ptaci.length - 1; i >= 0; i--) {
      const p = ptaci[i];
      const mLon = 1 / (111320 * Math.cos(p.sy * Math.PI / 180));
      // rození / mizení (přebytek nebo zákaz letu → zmizí a pryč)
      const cil = (ok && i < chci) ? 1 : 0;
      p.op += (cil - p.op) * 0.06;
      if (cil === 0 && p.op < 0.03) { odstran(p); ptaci.splice(i, 1); continue; }
      // termika: střed pomalu putuje, když odletí z výřezu, přeskočí
      p.drift += (Math.random() - 0.5) * 0.08;
      p.sx += Math.cos(p.drift) * 0.35 * mLon;
      p.sy += Math.sin(p.drift) * 0.35 * mLat;
      if (p.sx < b.getWest() || p.sx > b.getEast()
          || p.sy < b.getSouth() || p.sy > b.getNorth()) {
        const c = mapa.getCenter();
        p.sx = c.lng + (Math.random() - 0.5) * (b.getEast() - b.getWest()) * 0.4;
        p.sy = c.lat + (Math.random() - 0.5) * (b.getNorth() - b.getSouth()) * 0.4;
      }
      // kroužení
      p.uhel += p.rychlost * 0.05;
      p.x = p.sx + Math.cos(p.uhel) * p.r * mLon;
      p.y = p.sy + Math.sin(p.uhel) * p.r * 0.75 * mLat;
      // směr letu = tečna elipsy (+ znaménko otáčení)
      const tx = -Math.sin(p.uhel) * Math.sign(p.rychlost);
      const ty = Math.cos(p.uhel) * 0.75 * Math.sign(p.rychlost);
      p.smer = Math.atan2(tx, ty);             // 0 = na sever (obrazovka -y)
      // zamávání
      if (ted > p.dalsiMach) {
        p.el.classList.add('kane-machani');
        p.dalsiMach = ted + 7000 + Math.random() * 7000;
        setTimeout(() => p.el.classList.remove('kane-machani'), 700);
      }
      // výška terénu pod ptákem (levně, občas)
      if (!p.vyskaTik || ted - p.vyskaTik > 900) {
        p.vyskaTik = ted;
        try {
          const v = mapa.queryTerrainElevation
              && mapa.queryTerrainElevation([p.x, p.y]);
          if (typeof v === 'number') p.teren = v;
        } catch (e) { }
      }
      p.st = st;
    }
    umisti();
  }

  /// Poloha na obrazovce: pták ve výšce terén+120 m, stín na zemi
  /// posunutý OD slunce (délka podle výšky slunce), slabší při nízkém slunci.
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
      p.el.style.opacity = (0.9 * p.op).toFixed(2);
      p.el.style.transform = 'translate(-50%, -50%) translate(' + bod.x
        + 'px, ' + bod.y + 'px) rotate(' + otoc.toFixed(1) + 'deg) scale('
        + mer.toFixed(2) + ')';
      // stín: od slunce, délka = výška letu / tan(výška slunce)
      const st = p.st;
      let sx = 0, sy = 0, sila = 0.35;
      if (st && typeof st.slunceEl === 'number' && st.slunceEl > 0) {
        const el = Math.max(12, st.slunceEl) * Math.PI / 180;
        const delkaM = Math.min(160, VYSKA_LETU / Math.tan(el));
        const az = ((st.slunceAz || 0) + 180) * Math.PI / 180; // od slunce
        sx = Math.sin(az) * delkaM;
        sy = Math.cos(az) * delkaM;
        sila = 0.18 + Math.min(0.32, st.slunceEl / 120)
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
      p.stin.style.transform = 'translate(-50%, -50%) translate(' + bs.x
        + 'px, ' + bs.y + 'px) rotate(' + otoc.toFixed(1) + 'deg) scale('
        + (mer * 0.9).toFixed(2) + ')';
    }
  }

  function odpoj() {
    for (const p of ptaci) odstran(p);
    ptaci = [];
    if (tikac) { clearInterval(tikac); tikac = null; }
  }

  return { pripoj, odpoj, _ladeni: { pocet: () => ptaci.length } };
})();
