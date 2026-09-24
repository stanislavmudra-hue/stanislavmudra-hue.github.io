// Okolník 3D — KAPKY NA DISPLEJI (engine 371, 24. 9. 2026).
//
// T 24. 9.: „…osvětlení blesky a podobně. Klidně i kapky na displej, které stékají.“ Když u středu mapy prší
// (herní styl, přiblíženo od z11,5, počasí na mapě zapnuté), na „sklo“ dopadají kapky: chvíli visí, pak některé
// stečou dolů a zmizí; po dešti doschnou.
// ⛔ engine 371c (měřeno na TT 24. 9.): kapky jako prvky DOM s backdrop-filter a CSS přechody stály v klidu +25 % CPU
// (přechody jedou 60×/s → celé okno appky 60 snímků/s, RenderThread 24 → 55 %). Proto tu je JEN MODEL (poloha,
// velikost, krytí) a kapky kreslí shader atmosféry v témže průchodu jako déšť (atmosfera.js, `uKapky`) – žádná
// vrstva ani snímek navíc. A/B `window.__kapkyVyp = true`.
'use strict';
const Kapky = (() => {
  const MAX = 7;
  let mapa = null, pripojeno = false, posluchace = false;
  let posledniInterakceMs = Date.now(), poslT = 0;
  const kapky = [];            // { x, y (CSS px, y dolů), r, t0, stekaOd, v, drah, faze: 'visi'|'steka'|'schne', konec }
  const out = new Float32Array(32);
  /// síla deště u středu 0–1 (0 = neprší nebo sněží)
  function dest() {
    try {
      const st = Pocasi.stavSvetla();
      const druh = String(st.druh || ''), mm = +st.srazky || 0;
      if (druh === 'snih' || (isFinite(st.teplota) && st.teplota < 0.8)) return 0;
      if (druh === 'dest' || druh === 'bourka' || mm > 0.1) {
        return Math.max(druh === 'bourka' ? 0.7 : (druh === 'dest' ? 0.35 : 0), Math.min(1, mm / 4));
      }
    } catch (e) { /* bez počasí */ }
    return 0;
  }
  function smi() {
    if (!pripojeno || !mapa || window.__kapkyVyp || document.hidden) return false;
    if (window.__nastaveniMapy && window.__nastaveniMapy.pocasi === false) return false;
    if (Date.now() - posledniInterakceMs > 5 * 60 * 1000) return false;   // 5 min nečinnosti: nic nového
    try { if (mapa.getZoom() < 11.5) return false; } catch (e) { return false; }
    return true;
  }
  function nova(t, sila) {
    const el = mapa.getContainer();
    const W = el.clientWidth, H = el.clientHeight;
    const r = 6 + Math.random() * 9 + sila * 3;
    kapky.push({ x: W * (0.05 + Math.random() * 0.9), y: H * (0.07 + Math.random() * 0.8), r, t0: t,
                 stekaOd: t + 1200 + Math.random() * 5000, v: 0, drah: 0, cil: 40 + r * (4 + Math.random() * 7),
                 faze: 'visi', konec: t + 9000 + Math.random() * 6000, a: 0 });
  }
  /// krok modelu v čase t (performance.now) – volá atmosféra před každým snímkem; true = něco se hýbe
  function krok(t) {
    const dt = poslT ? Math.min(0.2, Math.max(0, (t - poslT) / 1000)) : 0;
    poslT = t;
    const sila = smi() ? dest() : 0;
    if (sila > 0 && kapky.length < MAX && Math.random() < dt * (0.35 + 1.1 * sila)) nova(t, sila);
    let hybe = false;
    for (let i = kapky.length - 1; i >= 0; i--) {
      const k = kapky[i];
      if (k.faze === 'schne') {
        k.a = Math.max(0, k.a - dt / 0.45);
        if (k.a <= 0) { kapky.splice(i, 1); continue; }
        hybe = true;
        continue;
      }
      if (k.a < 1) { k.a = Math.min(1, (t - k.t0) / 350); hybe = true; }
      if (sila <= 0 && Math.random() < dt * 0.6) { k.faze = 'schne'; hybe = true; continue; }   // po dešti doschnou
      if (k.faze === 'visi' && t > k.stekaOd && Math.random() < dt * (0.8 + 0.05 * k.r)) k.faze = 'steka';
      if (k.faze === 'steka') {
        k.v = Math.min(160, k.v + dt * 90);                // rozjezd po skle
        const d = k.v * dt;
        k.y += d; k.drah += d;
        k.x += Math.sin(t / 420 + k.r) * 0.06 * d;         // mírné klikatění
        hybe = true;
        if (k.drah > k.cil) k.faze = 'schne';
      } else if (t > k.konec) k.faze = 'schne';
    }
    return hybe;
  }
  /// data pro shader: [x, y (px plátna, y nahoru), poloměr (px plátna), krytí] × n
  function data(meritko) {
    const H = mapa.getContainer().clientHeight;
    let n = 0;
    for (const k of kapky) {
      if (n >= 8) break;
      out[4 * n] = k.x * meritko; out[4 * n + 1] = (H - k.y) * meritko; out[4 * n + 2] = k.r * meritko; out[4 * n + 3] = k.a;
      n++;
    }
    return { n, px: out };
  }
  function pripoj(m) {
    mapa = m;
    pripojeno = true;
    if (!posluchace) {
      posluchace = true;
      window.addEventListener('touchstart', () => { posledniInterakceMs = Date.now(); }, { passive: true });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) posledniInterakceMs = Date.now(); });
      try { m.on('move', () => { posledniInterakceMs = Date.now(); }); } catch (e) { /* nic */ }
    }
  }
  function zavri() { pripojeno = false; kapky.length = 0; }
  return { pripoj, zavri, krok, data, pocet: () => kapky.length,
           stav: () => ({ pripojeno, kapek: kapky.length, dest: dest(), smi: smi() }) };
})();
window.Kapky = Kapky;
