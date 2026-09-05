// ---------------------------------------------------------------------------
// ⭐ v1.607: TŘPYT (přání 4. 9. 2026: „sluneční i měsíční do modra odlesk
// na vodě, loužích, řekách, jezerech, nádržích a sněhu – levnější cestou,
// zkusíme, jak to bude vypadat").
//
// Bez shaderu a bez DOM značek (ty by s terénem promítaly přes readPixels):
// jiskřičky jsou SYMBOLOVÁ VRSTVA na GPU, rozmístěné náhodně po plochách
// vody z dlaždic ve výřezu (+ po polích a loukách, když leží sníh, + po
// polích do 3 h po dešti = louže). Blikání = ČTYŘI vrstvy nad jedním
// zdrojem, každá s KONSTANTNÍ `icon-opacity`, které se každých 420 ms
// protočí – konstantní paint vlastnost je jen uniform (žádná přestavba
// bufferů) a výchozí přechod 300 ms dělá měkké rozsvícení zdarma.
//
// Podmínky (Pocasi.stavSvetla, střed mapy):
//  • slunce > 3° nad obzorem, oblačnost < 0,75, neprší → teplé bílé,
//  • slunce < −3°, měsíc > 8°, osvit > 0,25, oblačnost < 0,5 → modravé,
//  • jinak nic. Jen od z12 (z dálky by to byl šum).
// Vzorkování po konci pohybu (odložené 350 ms) a každých 30 s; nejvýš
// ~80 jiskřiček. Test: `window.__vynutSvetlo = {slunceEl: 30, oblacnost: 0}`.
// ---------------------------------------------------------------------------
const Trpyt = (() => {
  // ⛔ 5. 9. 2026: VYPNUTO – čtyřcípé jiskřičky uživatel odmítl
  // („hvězdičky dej pryč, nevypadá to dobře“). Kód zůstává pro
  // případný jiný tvar odlesku (měkká záře bez cípů).
  const TRPYT_ZAPNUT = false;
  const ZDROJ = 'trpyt';
  const VRSTVY = ['trpyt-0', 'trpyt-1', 'trpyt-2', 'trpyt-3'];
  const OPACITY = [1, 0.45, 0.08, 0.45];
  let mapa = null;
  let pripojeno = false;
  let faze = 0;
  let tikac = null;
  let vzorkovac = null;
  let odklad = null;
  let rezim = 'nic';
  let seed = 7;

  function rnd() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }

  /// Jiskřička: měkká záře + čtyřcípá hvězdička (32 px, pixelRatio 2).
  function ikona(jmeno, jadro, zar) {
    if (mapa.hasImage(jmeno)) return;
    const S = 32;
    const c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 1, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(' + zar.join(',') + ',0.55)');
    g.addColorStop(0.5, 'rgba(' + zar.join(',') + ',0.12)');
    g.addColorStop(1, 'rgba(' + zar.join(',') + ',0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = 'rgba(' + jadro.join(',') + ',0.95)';
    for (const [w, h] of [[2.2, 22], [22, 2.2]]) {
      ctx.beginPath();
      ctx.ellipse(S / 2, S / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, 2.6, 0, Math.PI * 2);
    ctx.fill();
    mapa.addImage(jmeno, ctx.getImageData(0, 0, S, S), { pixelRatio: 2 });
  }

  function pripravIkony() {
    ikona('trpyt-slunce', [255, 252, 232], [255, 234, 160]);
    ikona('trpyt-mesic', [222, 234, 255], [150, 184, 240]);
  }

  function uvnitr(ring, x, y) {
    let in_ = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0]; const yi = ring[i][1];
      const xj = ring[j][0]; const yj = ring[j][1];
      if (((yi > y) !== (yj > y))
          && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) in_ = !in_;
    }
    return in_;
  }

  // ⚠️ ZMĚŘENO 4. 9.: `queryRenderedFeatures` stálo 8–32 ms na dotaz
  // (průnik každého prvku s výřezem) a po každém gestu udělalo pomalý
  // snímek. `querySourceFeatures` jen vysype prvky nahraných dlaždic
  // (bez průniku) a výřez si ohlídáme sami přes bbox.
  const VRSTVY_ZDROJE = {
    voda: { sourceLayer: 'water' },
    reky: { sourceLayer: 'waterway' },
    pole: { sourceLayer: 'landcover', filter: ['==', ['get', 'class'], 'farmland'] },
    louka: { sourceLayer: 'landcover',
             filter: ['in', ['get', 'class'], ['literal', ['grass', 'wetland']]] },
  };
  let vyrez = null;   // [z, j, v, s] aktuálního výřezu pro filtr bodů

  function prvkyZdroje(vrstvy) {
    const out = [];
    for (const v of vrstvy) {
      const d = VRSTVY_ZDROJE[v];
      if (!d) continue;
      try {
        const p = { sourceLayer: d.sourceLayer };
        if (d.filter) p.filter = d.filter;
        for (const f of mapa.querySourceFeatures('omt', p)) out.push(f);
      } catch (e) { /* zdroj ještě není */ }
    }
    return out;
  }

  function veVyrezu(x, y) {
    return !vyrez || (x >= vyrez[0] && x <= vyrez[2]
                      && y >= vyrez[1] && y <= vyrez[3]);
  }

  /// Náhodné body po plochách vrstev: `hustota` = m² na jiskřičku.
  function vzorkujPlochy(vrstvy, hustota, limit, out) {
    const feats = prvkyZdroje(vrstvy);
    for (const f of feats) {
      if (out.length >= limit) return;
      const g = f.geometry;
      if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates]
          : (g.type === 'MultiPolygon' ? g.coordinates : []);
      for (const poly of polys) {
        const ring = poly[0];
        if (!ring || ring.length < 4) continue;
        let x0 = 999, x1 = -999, y0 = 999, y1 = -999;
        for (const p of ring) {
          if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
          if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
        }
        // mimo výřez (dlaždice jsou i za okrajem) – přeskočit
        if (vyrez && (x1 < vyrez[0] || x0 > vyrez[2]
                      || y1 < vyrez[1] || y0 > vyrez[3])) continue;
        const cosL = Math.cos((y0 + y1) / 2 * Math.PI / 180);
        const plocha = (x1 - x0) * 111320 * cosL * (y1 - y0) * 110574 * 0.5;
        const n = Math.min(8, Math.round(plocha / hustota));
        if (n <= 0) continue;
        let dano = 0;
        for (let k = 0; k < n * 5 && dano < n && out.length < limit; k++) {
          const x = x0 + rnd() * (x1 - x0);
          const y = y0 + rnd() * (y1 - y0);
          if (veVyrezu(x, y) && uvnitr(ring, x, y)) {
            out.push([x, y]);
            dano++;
          }
        }
      }
    }
  }

  /// Body podél čar (řeky): každých ~`krokM` metrů jedna jiskřička,
  /// s náhodným posunem, ať to není korálkový náhrdelník.
  function vzorkujCary(vrstvy, krokM, limit, out) {
    const feats = prvkyZdroje(vrstvy);
    for (const f of feats) {
      if (out.length >= limit) return;
      const g = f.geometry;
      if (!g) continue;
      const cary = g.type === 'LineString' ? [g.coordinates]
          : (g.type === 'MultiLineString' ? g.coordinates : []);
      for (const cara of cary) {
        let zbyva = krokM * (0.3 + rnd() * 0.7);
        for (let i = 1; i < cara.length && out.length < limit; i++) {
          const a = cara[i - 1];
          const b = cara[i];
          const cosL = Math.cos(a[1] * Math.PI / 180);
          const dx = (b[0] - a[0]) * 111320 * cosL;
          const dy = (b[1] - a[1]) * 110574;
          const d = Math.hypot(dx, dy);
          let pos = 0;
          while (pos + zbyva <= d && out.length < limit) {
            pos += zbyva;
            const t = pos / d;
            const px = a[0] + (b[0] - a[0]) * t;
            const py = a[1] + (b[1] - a[1]) * t;
            if (veVyrezu(px, py)) out.push([px, py]);
            zbyva = krokM * (0.6 + rnd() * 0.8);
          }
          zbyva -= (d - pos);
          if (zbyva <= 0) zbyva = krokM * 0.5;
        }
      }
    }
  }

  function nastavData(body) {
    const src = mapa.getSource(ZDROJ);
    if (!src) return;
    src.setData({
      type: 'FeatureCollection',
      features: body.map((b, i) => ({
        type: 'Feature', properties: { i: i % 4 },
        geometry: { type: 'Point', coordinates: b },
      })),
    });
  }

  function tik() {
    // ⚠️ ZMĚŘENO 4. 9.: každá změna paint vlastnosti = přepočet stylu;
    // během gesta to přidávalo pomalé snímky. V pohybu se nebliká
    // (jiskřičky drží poslední stav), v klidu je to zadarmo.
    try { if (mapa.isMoving && mapa.isMoving()) return; } catch (e) { }
    faze = (faze + 1) % 4;
    for (let k = 0; k < 4; k++) {
      const v = VRSTVY[k];
      if (mapa.getLayer(v)) {
        mapa.setPaintProperty(v, 'icon-opacity', OPACITY[(k + faze) % 4]);
      }
    }
  }

  function spustTik() { if (!tikac) tikac = setInterval(tik, 700); }
  function zastavTik() { if (tikac) { clearInterval(tikac); tikac = null; } }

  let poslKlic = '';

  function vzorkuj(vynutit) {
    try {
      if (!mapa || !pripojeno || !mapa.getSource(ZDROJ)) return;
      if (!TRPYT_ZAPNUT) {
        if (rezim !== 'nic') { rezim = 'nic'; nastavData([]); zastavTik(); }
        return;
      }
      if (typeof Pocasi === 'undefined' || !Pocasi.stavSvetla) return;
      const st = Pocasi.stavSvetla();
      const z = mapa.getZoom();
      // výřez: jen když se posunul aspoň o třetinu nebo změnil zoom
      const b = mapa.getBounds();
      vyrez = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      const sirka = vyrez[2] - vyrez[0];
      const vyska = vyrez[3] - vyrez[1];
      const klic = [Math.round(vyrez[0] / (sirka / 3)),
                    Math.round(vyrez[1] / (vyska / 3)), Math.round(z * 2),
                    st.snih >= 1, !!st.mokro].join('|');
      if (!vynutit && klic === poslKlic && rezim !== 'nic') return;
      poslKlic = klic;
      let novy = 'nic';
      const prsi = st.druh === 'dest' || st.druh === 'bourka'
          || st.druh === 'snih' || st.druh === 'mlha';
      if (z >= 12 && !prsi) {
        if (st.slunceEl > 3 && st.oblacnost < 0.75) novy = 'slunce';
        else if (st.slunceEl < -3 && st.mesicEl > 8 && st.mesicOsvit > 0.25
                 && st.oblacnost < 0.5) novy = 'mesic';
      }
      if (novy === 'nic') {
        if (rezim !== 'nic') { rezim = 'nic'; nastavData([]); zastavTik(); }
        return;
      }
      if (novy !== rezim) {
        rezim = novy;
        for (const v of VRSTVY) {
          if (mapa.getLayer(v)) {
            mapa.setLayoutProperty(v, 'icon-image',
                rezim === 'mesic' ? 'trpyt-mesic' : 'trpyt-slunce');
          }
        }
      }
      const body = [];
      const hust = z >= 15 ? 12000 : (z >= 14 ? 30000 : 90000);
      vzorkujPlochy(['voda'], hust, 50, body);
      // řeky a potoky jsou čáry – jiskřička každých ~120 m (blíž hustěji)
      vzorkujCary(['reky'], z >= 15 ? 90 : 160, 70, body);
      if (rezim === 'slunce' && st.snih >= 1) {
        vzorkujPlochy(['pole', 'louka'], hust * 2.5, 80, body);
      } else if (rezim === 'slunce' && st.mokro) {
        vzorkujPlochy(['pole'], hust * 6, 65, body);
      }
      nastavData(body);
      if (body.length) spustTik(); else zastavTik();
      window.__trpyt = { rezim, bodu: body.length, z: +z.toFixed(1) };
    } catch (e) { console.warn('[trpyt]', e); }
  }

  function naKonecPohybu() {
    clearTimeout(odklad);
    odklad = setTimeout(() => vzorkuj(false), 350);
  }

  /// Zdroj + čtyři vrstvy (po každém načtení stylu znovu; idempotentní).
  function nasad() {
    if (!mapa) return;
    pripravIkony();
    if (!mapa.getSource(ZDROJ)) {
      mapa.addSource(ZDROJ, { type: 'geojson',
        data: { type: 'FeatureCollection', features: [] } });
    }
    VRSTVY.forEach((v, k) => {
      if (mapa.getLayer(v)) return;
      mapa.addLayer({
        id: v, type: 'symbol', source: ZDROJ,
        filter: ['==', ['get', 'i'], k],
        layout: {
          'icon-image': 'trpyt-slunce',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-pitch-alignment': 'viewport',
          'icon-size': ['interpolate', ['linear'], ['zoom'],
                        12, 0.45, 15, 0.8, 17, 1.15],
        },
        paint: { 'icon-opacity': OPACITY[k],
                 'icon-opacity-transition': { duration: 600, delay: 0 } },
      });
    });
    rezim = 'nic';
  }

  function pripoj(m) {
    mapa = m;
    nasad();
    if (!pripojeno) {
      pripojeno = true;
      mapa.on('moveend', naKonecPohybu);
      if (!vzorkovac) vzorkovac = setInterval(() => vzorkuj(true), 30000);
    }
    setTimeout(() => vzorkuj(true), 1500);
  }

  function zavri() {
    zastavTik();
    if (vzorkovac) { clearInterval(vzorkovac); vzorkovac = null; }
    if (mapa && pripojeno) {
      try { mapa.off('moveend', naKonecPohybu); } catch (e) { /* nic */ }
    }
    pripojeno = false;
    rezim = 'nic';
  }

  return { pripoj, zavri, nasad, vzorkuj: () => vzorkuj(true),
           _stav: () => ({ rezim, faze }) };
})();
