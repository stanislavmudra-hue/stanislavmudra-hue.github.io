// ---------------------------------------------------------------------------
// ⭐ v1.607: SKUTEČNÉ SVĚTLO (přání 4. 9. 2026: „globální světlo dle
// reálného západu slunce – polohy osvětlení v daném místě: stíny, světla,
// tma"). Slunce a měsíc počítá Pocasi (NOAA + port SunCalc), tady se
// z nich dělá:
//  • světlo pro vytažené budovy (`fill-extrusion`): mapa.setLight s kotvou
//    `map` – azimut od severu, polární úhel 90 − výška; nízké slunce
//    teplé a slabší, v noci měsíc modravý, bez měsíce tlumené rozptýlené,
//  • směr stínování terénu herního stylu (`hillshade-illumination-direction`
//    vrstvy `stinovani`, protisvětlo naproti) podle slunce, v noci měsíce.
// ⚠️ Kartografická konvence svítí ze severozápadu (335°), protože jižní
// světlo umí u plochého stínování obrátit reliéf (kopce jako údolí).
// S 3D terénem se to projevuje málo – zkouší se; `window.__svetloPevne =
// true` vrátí 335° a `window.__vynutSvetlo = {...}` podstrčí stav (test).
// Obnova každých 5 minut a po každém načtení stylu; jen paint/light,
// za běhu nic nestojí.
// ---------------------------------------------------------------------------
const Svetlo = (() => {
  let mapa = null;
  let casovac = null;
  let posl = '';

  function hex(v) {
    return Math.round(Math.max(0, Math.min(255, v))).toString(16)
        .padStart(2, '0');
  }

  function mix(a, b, t) {
    const p = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16),
                      parseInt(c.slice(5, 7), 16)];
    const A = p(a);
    const B = p(b);
    return '#' + hex(A[0] + (B[0] - A[0]) * t) + hex(A[1] + (B[1] - A[1]) * t)
        + hex(A[2] + (B[2] - A[2]) * t);
  }

  function aktualizuj() {
    try {
      if (!mapa || !mapa.getStyle || typeof Pocasi === 'undefined'
          || !Pocasi.stavSvetla) return;
      const st = Pocasi.stavSvetla();
      let az;
      let el;
      let barva;
      let intenzita;
      let zdroj;
      if (st.slunceEl > -1) {
        // den: nízko nad obzorem oranžové a slabší, v poledne bílé
        az = st.slunceAz;
        el = Math.max(st.slunceEl, 3);
        const t = Math.max(0, Math.min(1, st.slunceEl / 30));
        barva = mix('#FFB878', '#FFF7E8', t);
        intenzita = 0.30 + 0.40 * t;
        zdroj = 'slunce';
      } else if (st.mesicEl > 3 && st.mesicOsvit > 0.15) {
        az = st.mesicAz;
        el = Math.max(st.mesicEl, 6);
        barva = '#A9BDE0';
        intenzita = 0.20 + 0.20 * st.mesicOsvit;
        zdroj = 'mesic';
      } else {
        az = 335;
        el = 45;
        barva = '#7F8AA3';
        intenzita = 0.18;
        zdroj = 'tma';
      }
      if (st.oblacnost > 0.7) intenzita *= 0.7;   // pod mraky měkčí světlo
      if (window.__svetloPevne) { az = 335; el = 45; }
      const klic = [zdroj, Math.round(az), Math.round(el), barva,
                    intenzita.toFixed(2)].join('|');
      if (klic === posl) return;
      posl = klic;
      mapa.setLight({
        anchor: 'map',
        position: [1.15, az, Math.min(88, 90 - el)],
        color: barva,
        intensity: intenzita,
      });
      // stínování herního stylu (ostatní styly zůstávají, jak jsou)
      if (mapa.getLayer('stinovani')) {
        mapa.setPaintProperty('stinovani', 'hillshade-illumination-direction',
                              Math.round(az) % 360);
      }
      if (mapa.getLayer('stinovani-protisvetlo')) {
        mapa.setPaintProperty('stinovani-protisvetlo',
                              'hillshade-illumination-direction',
                              Math.round(az + 180) % 360);
      }
      window.__svetlo = { zdroj, az: Math.round(az), el: Math.round(el),
                          barva, intenzita: +intenzita.toFixed(2) };
      // ⭐ 5. 9. 2026: stíny kreseb podle téhož světla (slunce / měsíc)
      try {
        if (typeof Ilustrace !== 'undefined' && Ilustrace.svetlo) {
          Ilustrace.svetlo(window.__svetlo, st);
        }
      } catch (e2) { /* kresby ještě nejsou */ }
      try {
        if (window.nastavStinyMist) window.nastavStinyMist(window.__svetlo, st);
      } catch (e3) { /* vrstva míst ještě není */ }
    } catch (e) { console.warn('[svetlo]', e); }
  }

  function pripoj(m) {
    mapa = m;
    posl = '';                       // nový styl = nastavit znovu
    aktualizuj();
    if (!casovac) casovac = setInterval(aktualizuj, 5 * 60 * 1000);
  }

  function zavri() {
    if (casovac) { clearInterval(casovac); casovac = null; }
    posl = '';
  }

  return { pripoj, zavri, aktualizuj };
})();
