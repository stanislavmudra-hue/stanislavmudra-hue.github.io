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

  // ⭐ 5. 9. večer: STÍNY DOMŮ (styles.js `stinyDomu`) – posun půdorysů od
  // světla. Délka = výška třídy / tan(výška světla), v px na z18 (0,19 m/px),
  // na z12 1/64; mezi tím základ 2 = drží se krajiny. Slabší při nízkém
  // slunci a pod mraky, v noci od měsíce, bez světla nic.
  function nastavStinyDomu(az, el, zdroj, st) {
    if (!mapa.getLayer('stin-domu-nizke-1')) return;
    const elR = Math.max(8, el) * Math.PI / 180;
    const smer = (az + 180) * Math.PI / 180;
    // celková tma u zdi (~0,30 za plného slunce); každá z N kopií dostane
    // takovou průhlednost, aby se u zdi složily právě na ni
    // 5. 9. noc („stíny domů už nejsou téměř vidět"): 0,30 → 0,50, mraky
    // ubírají jen 40 %
    // engine 211 („chtělo by to zvýraznit stíny"): slunce 0,50 → 0,65 (plné
    // od výšky 20°), měsíc 0,22 → 0,35, mraky ubírají 30 % (bylo 40)
    let celk = zdroj === 'slunce' ? 0.65 * Math.min(1, Math.max(0, el) / 20)
      : (zdroj === 'mesic' ? 0.35 * (st.mesicOsvit || 0.5) : 0);
    celk *= 1 - 0.3 * Math.min(1, st.oblacnost || 0);
    const T = (typeof STINY_DOMU_T !== 'undefined') ? STINY_DOMU_T : [1 / 3, 2 / 3, 1];
    const sila = celk > 0 ? 1 - Math.pow(1 - celk, 1 / T.length) : 0;
    for (const [trida, vyska] of [['nizke', 6], ['vysoke', 14]]) {
      const delka18 = vyska / Math.tan(elR) / 0.19;
      for (let i = 1; i <= T.length; i++) {
        const k = T[i - 1];
        const dx = Math.sin(smer) * delka18 * k;
        const dy = -Math.cos(smer) * delka18 * k;
        const id = 'stin-domu-' + trida + '-' + i;
        if (!mapa.getLayer(id)) continue;
        // ⛔ pole ve výrazu MUSÍ být `['literal', […]]` – holé [dx, dy] MapLibre
        // tiše odmítl (hodnota zůstala [0,0], stíny neviditelné; 5. 9. večer)
        mapa.setPaintProperty(id, 'fill-translate',
          ['interpolate', ['exponential', 2], ['zoom'],
           12, ['literal', [+(dx / 64).toFixed(2), +(dy / 64).toFixed(2)]],
           18, ['literal', [+dx.toFixed(1), +dy.toFixed(1)]]]);
        mapa.setPaintProperty(id, 'fill-opacity',
          ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15.2, +sila.toFixed(3)]);
      }
    }
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
      try { nastavStinyDomu(az, el, zdroj, st); }
      catch (e4) { console.warn('[svetlo] stíny domů', e4); }
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
