/* ⭐ KÁNĚ NAD KRAJINOU (5. 9. 2026; 3. kolo: „ať se podobají káňatům,
 * velikost podle zoomu jako ostatní obrázky, pomaleji, bez poskakování
 * nad kopci").
 *
 * JEDNO káně krouží vysoko nad mapou (herní styl, den, bez deště a sněhu,
 * zoom ≥ 12). Technika jako hmyz (dekorace.js): DOM prvek
 * v canvasContaineru, poloha přes `transform.locationToScreenPoint`
 * s NADMOŘSKOU VÝŠKOU. Výška letu = terén POD STŘEDEM KROUŽENÍ (ne pod
 * ptákem) + 120 m, doměřovaná zřídka a doháněná pomalu – pták tedy
 * nekopíruje každý kopec (to dělalo poskakování), plachtí v rovině.
 *
 * Velikost roste se zoomem stejnou křivkou jako stromy (dekorace.js:
 * exponential 1,8; 13,25 → 0,30 · 15,4 → 0,70 · 17,6 → 2,55), takže
 * působí jako součást krajiny. Pohyb po snímcích (rAF, dt).
 * Pod ptákem na zemi stín posunutý od slunce (`Pocasi.stavSvetla()`).
 */
const Ptaci = (() => {
  'use strict';
  let mapa = null;
  let ptaci = [];
  let bezi = false;
  let poslT = 0;
  const VYSKA_LETU = 120;          // m nad terénem
  const MAX_PTAKU = 1;
  const K = 0.42;                  // „k" druhu jako u stromů (základ 120 px)

  // ⭐ 5. 9. večer („mávání křídel je anatomicky špatně"): dřív se obě
  // křídla MAČKALA podél těla (scaleY), což žádný pták nedělá. Křídlo se
  // otáčí v RAMENI: při pohledu shora se rozpětí zkrátí (křídlo jde dolů
  // a k tělu → scaleX k rameni) a špička se při úderu dolů kývne dopředu,
  // při zdvihu mírně dozadu (rotate kolem ramene; levé +, pravé −,
  // protože y roste dolů). Každé křídlo je vlastní skupina s počátkem
  // v rameni; tělo, hlava a ocas se nehýbou. Káně mává 3–4 údery a plachtí.
  const CSS = '@keyframes kaneMachL{0%{transform:scaleX(1) rotate(0deg)}'
    + '30%{transform:scaleX(.6) rotate(7deg)}55%{transform:scaleX(1.03) rotate(-2deg)}'
    + '80%{transform:scaleX(.68) rotate(5deg)}100%{transform:scaleX(1) rotate(0deg)}}'
    + '@keyframes kaneMachR{0%{transform:scaleX(1) rotate(0deg)}'
    + '30%{transform:scaleX(.6) rotate(-7deg)}55%{transform:scaleX(1.03) rotate(2deg)}'
    + '80%{transform:scaleX(.68) rotate(-5deg)}100%{transform:scaleX(1) rotate(0deg)}}'
    + '.kane-kridlo-l,.kane-kridlo-r{transform-box:view-box}'
    + '.kane-kridlo-l{transform-origin:57px 24px}'
    + '.kane-kridlo-r{transform-origin:63px 24px}'
    // engine 310: mávnutí po krocích (5 snímků na mávnutí) – plynulé
    // keyframes držely při každém mávání 1,6 s kompozitor na 60 fps
    + '.kane-machani .kane-kridlo-l{animation:kaneMachL .4s steps(5, end) 4}'
    + '.kane-machani .kane-kridlo-r{animation:kaneMachR .4s steps(5, end) 4}'
    + '.kane{pointer-events:none;position:absolute;top:0;left:0;'
    + 'will-change:transform;}'
    + '.kane-stin{pointer-events:none;position:absolute;top:0;left:0;'
    + 'will-change:transform,opacity;}'
    // ⭐ engine 258: STÍN VE TVARU KÁNĚTE. Byla to elipsa s přechodem; teď je
    // to TÁŽ silueta jako pták, jen načerno (`brightness(0)`), rozmazaná
    // a zploštělá – a mává křídly zároveň s ním (třída `kane-machani`).
    + '.kane-stin svg{filter:brightness(0) blur(4px);opacity:.6;}';

  // Káně SHORA, letí nahoru (-y). Proporce káněte: rozpětí ≈ 2,4× délka,
  // široká zaoblená křídla s rovnější přední hranou a 5 roztaženými
  // „prsty", krátký široký vějíř ocasu, malá hlava. Tmavě hnědé shora,
  // na křídlech světlejší pásy per, na ocase světlé pruhy.
  const KANE_SVG = '<svg viewBox="0 0 120 56" width="120" height="56">'
    // levé křídlo (skupina s počátkem v rameni 57,24)
    + '<g class="kane-kridlo-l">'
    + '<path fill="#4a3826" d="M60 24 C50 17 36 14 22 15 C14 15.5 7 17.5 2 21 '
    + 'L1 24.5 L5 22.5 L4 26.5 L8.5 24 L8.5 28.5 L13 25.5 L14 30 L18 26.5 '
    + 'C24 29 33 31 42 32 C49 32.5 55 31 60 30 Z"/>'
    + '<path fill="#7d6547" opacity="0.5" d="M20 19 C33 18 46 22 60 27 L60 30 '
    + 'C46 25 33 21 20 19 Z"/>'
    + '<path fill="#2f241a" opacity="0.35" d="M6 22 C12 26 17 28 24 29 '
    + 'L22 25.5 C16 24 11 22.5 6 22 Z"/>'
    + '</g>'
    // pravé křídlo (počátek v rameni 63,24)
    + '<g class="kane-kridlo-r">'
    + '<path fill="#4a3826" d="M60 24 C70 17 84 14 98 15 C106 15.5 113 17.5 118 21 '
    + 'L119 24.5 L115 22.5 L116 26.5 L111.5 24 L111.5 28.5 L107 25.5 L106 30 L102 26.5 '
    + 'C96 29 87 31 78 32 C71 32.5 65 31 60 30 Z"/>'
    + '<path fill="#7d6547" opacity="0.5" d="M60 27 C74 22 87 18 100 19 '
    + 'C87 21 74 25 60 30 Z"/>'
    + '<path fill="#2f241a" opacity="0.35" d="M114 22 C108 26 103 28 96 29 '
    + 'L98 25.5 C104 24 109 22.5 114 22 Z"/>'
    + '</g>'
    // tělo
    + '<path fill="#3a2b1d" d="M56.5 20 C56.5 15.5 63.5 15.5 63.5 20 '
    + 'L64.5 34 C64.5 37 64 40 63 42 L57 42 C56 40 55.5 37 55.5 34 Z"/>'
    // hlava se zobákem
    + '<ellipse cx="60" cy="16.5" rx="3" ry="3.3" fill="#2a1f14"/>'
    + '<path fill="#d9c27a" d="M58.9 13.2 L60 11.6 L61.1 13.2 Z"/>'
    // ocas – krátký široký vějíř se světlými pruhy
    + '<path fill="#3a2b1d" d="M55 41 L65 41 L69 52 L60 49.5 L51 52 Z"/>'
    + '<path fill="#8a7454" opacity="0.5" d="M54 44.5 L66 44.5 L67 47 L53 47 Z"/>'
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
    // ⭐ engine 341 (výtka T: „když se posouvám, káně se trochu posouvá taky – nedrží
    // pozici“): vlastní rAF běžel PŘED vykreslením mapy, takže bral kameru o snímek
    // starší a při tahu pták klouzal. Při pohybu mapy se proto znovu umístí v události
    // `render` (hned po vykreslení snímku mapy, s aktuální kamerou, týž snímek).
    if (!pripoj.render) {
      pripoj.render = true;
      try {
        const cv = mapa.getCanvas();
        const dotyk = () => { posledniDotykMs = performance.now(); };
        cv.addEventListener('touchstart', dotyk, { passive: true });
        cv.addEventListener('touchmove', dotyk, { passive: true });
        cv.addEventListener('touchend', dotyk, { passive: true });
        cv.addEventListener('wheel', dotyk, { passive: true });
      } catch (e) { /* nic */ }
      // setrvačnost po švihu volá MapLibre jako easeTo(…, {originalEvent}) → i její `move`
      // nese originalEvent; programové pohyby kamery (sledování hráče, přelet) ne
      mapa.on('move', (e) => { if (e && e.originalEvent) posledniUzivPohybMs = performance.now(); });
      mapa.on('render', () => { try { if (bezi && ptaci.length && mapaSeHybe()) umisti(); } catch (e) { /* nic */ } });
    }
    if (window.KlidovyTakt) KlidovyTakt.pridej('ptaci', (t) => krokVKlidu(t), 1);
  }

  function svetlo() {
    try {
      if (typeof Pocasi !== 'undefined' && Pocasi.stavSvetla) {
        return Pocasi.stavSvetla();
      }
    } catch (e) { /* bez počasí */ }
    return null;
  }

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
    stin.innerHTML = KANE_SVG;
    mapa.getCanvasContainer().appendChild(stin);
    mapa.getCanvasContainer().appendChild(el);
    return {
      sx, sy,
      r: 120 + Math.random() * 100,            // poloměr v metrech
      uhel: Math.random() * Math.PI * 2,
      rychlost: (0.12 + Math.random() * 0.05) * (Math.random() < 0.5 ? 1 : -1), // rad/s
      drift: Math.random() * Math.PI * 2,
      x: sx, y: sy, teren: null, terenCil: null,
      dalsiMach: performance.now() + 4000 + Math.random() * 6000,
      dalsiMereni: 0,
      el, stin, op: 0,
    };
  }

  function odstran(p) {
    try { p.el.remove(); } catch (e) { }
    try { p.stin.remove(); } catch (e) { }
  }

  /// Měřítko jako stromy (dekorace.js): exponential 1,8 mezi stopy.
  function meritko() {
    const z = mapa.getZoom();
    // ⛔ 5. 9. večer: růst do z22 jako u stromů byl OMYL – káně na z19 mělo
    // rozpětí přes celou silnici (ověřeno snímkem). Pták není součást
    // krajiny na zemi, nad 17,6 drží velikost.
    const stopy = [[13.25, 0.30], [15.4, 0.70], [17.6, 2.55]];
    let v;
    if (z <= stopy[0][0]) v = stopy[0][1];
    else if (z >= stopy[stopy.length - 1][0]) v = stopy[stopy.length - 1][1];
    else {
      let i = 0;
      while (i < stopy.length - 2 && z >= stopy[i + 1][0]) i++;
      const [z0, v0] = stopy[i]; const [z1, v1] = stopy[i + 1];
      const t = (Math.pow(1.8, z - z0) - 1) / (Math.pow(1.8, z1 - z0) - 1);
      v = v0 + t * (v1 - v0);
    }
    return v * K;
  }

  // ⭐ engine 292 (audit klidu 11. 9. 2026): rAF jen když se mapa hýbe (prst
  // nebo animace kamery) – tam musí pták sedět na krajině každý snímek.
  // V klidu stačí krok 100 ms a přechod CSS (`transition`) mezi kroky:
  // mezisnímky dopočítá kompozitor bez hlavního vlákna. Káně dřív drželo
  // rAF 60×/s napořád (20 % hlavního vlákna rendereru v klidu, k tomu
  // dotaz na výšku terénu pro stín každý snímek) a s ním celý řetězec
  // WebView → Flutter v překreslování.
  const KLID_KROK_MS = 100;
  let vKlidu = false;
  let poslStred = null;            // engine 313: střed mapy v minulém kroku
  let posledniDotykMs = 0;         // engine 342: poslední dotyk prstu (setrvačnost ≠ sledování)
  let posledniUzivPohybMs = 0;     // engine 342: poslední `move` od uživatele (nese originalEvent)
  function prstNaMape_() {
    try {
      if (typeof prstNaMape === 'function') return prstNaMape();
      if (typeof prstuNaMape !== 'undefined') return !!prstuNaMape;
    } catch (e) { /* nic */ }
    return false;
  }
  function mapaSeHybe() {
    try {
      if (mapa.isMoving && mapa.isMoving()) return true;
      if (typeof prstuNaMape !== 'undefined' && prstuNaMape) return true;
    } catch (e) { /* nic */ }
    return false;
  }
  // engine 310: v klidu krok volá společný KlidovyTakt (10 Hz, jeden snímek
  // pro všechny animace); vlastní časovač se použije jen bez tikače (web bokem)
  let cekaNaTakt = false;
  function krokVKlidu(t) {
    if (!bezi || !cekaNaTakt) return;
    cekaNaTakt = false;
    snimek(t);
  }
  function snimek(t) {
    if (!bezi) return;
    vKlidu = !mapaSeHybe();
    if (vKlidu) {
      if (window.KlidovyTakt) cekaNaTakt = true;
      else setTimeout(() => snimek(performance.now()), KLID_KROK_MS);
    } else {
      requestAnimationFrame(snimek);
    }
    const dt = Math.min(0.12, Math.max(0.001, (t - poslT) / 1000));
    poslT = t;
    if (!mapa) return;
    const ok = smiLetat();
    if (ok && !ptaci.length) ptaci.push(novyPtak());
    if (!ptaci.length) return;
    const st = svetlo();
    const b = mapa.getBounds();
    const mLat = 1 / 110574;
    // ⭐ engine 313 („káňata někdy lítají pozpátku"): káně stálo ve světě, ale
    // při PROGRAMOVÉM pohybu kamery (sledování hráče v autě 15–25 m/s, dojezd,
    // přelet) se mapa pod ním sunula rychleji, než letí (14–37 m/s), a na
    // obrazovce couvalo proti svému nosu. Střed kroužení se proto posouvá
    // s kamerou; při tahu prstem zůstává ve světě (posun je záměr uživatele).
    let posunLng = 0, posunLat = 0;
    try {
      const c = mapa.getCenter();
      // ⭐ engine 342 (výtka T: „káně se posouvá ještě víc“): po švihu prstem běží
      // SETRVAČNOST bez prstu na mapě – střed kroužení jel s kamerou a pták se
      // posouval s mapou (s engine 341 umístěním v `render` ještě věrněji). S kamerou
      // se teď posouvá jen tehdy, když prst na mapě nebyl aspoň 1,5 s a poslední pohyb
      // kamery nebyl od uživatele (švih doznívá až ~1,9 s) – tj. jen sledování hráče a přelety.
      const ted = performance.now();
      if (poslStred && !prstNaMape_() && ted - posledniDotykMs > 1500 && ted - posledniUzivPohybMs > 250) {
        posunLng = c.lng - poslStred.lng;
        posunLat = c.lat - poslStred.lat;
        if (Math.abs(posunLng) > 0.02 || Math.abs(posunLat) > 0.02) { posunLng = 0; posunLat = 0; }
      }
      poslStred = { lng: c.lng, lat: c.lat };
    } catch (e) { posunLng = 0; posunLat = 0; }
    for (let i = ptaci.length - 1; i >= 0; i--) {
      const p = ptaci[i];
      if (posunLng || posunLat) { p.sx += posunLng; p.sy += posunLat; }
      const mLon = 1 / (111320 * Math.cos(p.sy * Math.PI / 180));
      const cil = ok ? 1 : 0;
      p.op += (cil - p.op) * Math.min(1, dt * 1.2);
      if (cil === 0 && p.op < 0.03) { odstran(p); ptaci.splice(i, 1); continue; }
      // termika: střed putuje ~0,5 m/s; mimo výřez → nový střed
      p.drift += (Math.random() - 0.5) * 0.6 * dt;
      p.sx += Math.cos(p.drift) * 0.5 * dt * mLon;
      p.sy += Math.sin(p.drift) * 0.5 * dt * mLat;
      // ⭐ 5. 9. noc („po přiblížení káně zmizí a posune se jinam"): mimo
      // výřez se pták nepřesazuje hned – při zoomu se výřez jen zúžil. Letí
      // dál; teprve když je mimo 6 s a mapa stojí, přesadí se (a plynule
      // se rozsvítí přes `op`).
      const mimo = p.sx < b.getWest() || p.sx > b.getEast()
          || p.sy < b.getSouth() || p.sy > b.getNorth();
      if (!mimo) p.mimoOd = 0;
      else if (!p.mimoOd) p.mimoOd = t;
      if (mimo && t - p.mimoOd > 6000 && !(mapa.isMoving && mapa.isMoving())) {
        p.mimoOd = 0;
        const c = mapa.getCenter();
        p.sx = c.lng + (Math.random() - 0.5) * (b.getEast() - b.getWest()) * 0.4;
        p.sy = c.lat + (Math.random() - 0.5) * (b.getNorth() - b.getSouth()) * 0.4;
        p.op = 0;
        p.terenCil = null;
      }
      p.uhel += p.rychlost * dt;
      p.x = p.sx + Math.cos(p.uhel) * p.r * mLon;
      p.y = p.sy + Math.sin(p.uhel) * p.r * 0.75 * mLat;
      const tx = -Math.sin(p.uhel) * Math.sign(p.rychlost);
      const ty = Math.cos(p.uhel) * 0.75 * Math.sign(p.rychlost);
      p.smer = Math.atan2(tx, ty);
      if (t > p.dalsiMach) {
        p.el.classList.add('kane-machani');
        p.stin.classList.add('kane-machani');
        p.dalsiMach = t + 9000 + Math.random() * 8000;
        setTimeout(() => { p.el.classList.remove('kane-machani');
                           p.stin.classList.remove('kane-machani'); }, 1750);
      }
      // výška: terén pod STŘEDEM kroužení, zřídka, dohánět pomalu
      if (t > p.dalsiMereni) {
        p.dalsiMereni = t + 1500;
        try {
          const v = mapa.queryTerrainElevation
              && mapa.queryTerrainElevation([p.sx, p.sy]);
          if (typeof v === 'number') {
            p.terenCil = v;
            if (p.teren === null) p.teren = v;
          }
        } catch (e) { }
      }
      if (p.teren !== null && p.terenCil !== null) {
        p.teren += (p.terenCil - p.teren) * Math.min(1, dt * 0.5);
      }
      p.st = st;
    }
    umisti();
  }

  function umisti() {
    if (!mapa || !ptaci.length) return;
    let tr;
    try { tr = mapa._camera.transform; } catch (e) { return; }
    const ter = mapa.terrain;
    const mer = meritko();
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
      // engine 233: směr letu je v mapě, prvek je na obrazovce → odečíst natočení mapy
      let otoc = (p.smer || 0) * 180 / Math.PI - (mapa.getBearing ? mapa.getBearing() : 0);
      // engine 292: úhel bez skoku přes 360° – CSS přechod by jinak otočil
      // ptáka dlouhou cestou
      if (typeof p.otocPred === 'number') otoc += 360 * Math.round((p.otocPred - otoc) / 360);
      p.otocPred = otoc;
      // engine 309: přechod po DVOU krocích, ne lineárně – lineární přechod
      // nechal kompozitor kreslit 6 snímků na každý krok (60 fps v klidu),
      // a každý snímek WebView znamená snímek i pro Flutter (viz pocasi.js)
      // engine 310: bez CSS přechodu – každý mezisnímek kompozitoru je snímek
      // i pro Flutter; krok 100 ms z jednoho tikače je ten „jediný" snímek
      const prechod = 'none';
      if (p.el.style.transition !== prechod) {
        p.el.style.transition = prechod;
        p.stin.style.transition = prechod;
      }
      p.el.style.opacity = (0.9 * p.op).toFixed(2);
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
        sila = (0.16 + Math.min(0.26, st.slunceEl / 140))
          * (1 - Math.min(1, (st.oblacnost || 0) * 0.8));
      }
      const mLat = 1 / 110574;
      const mLon = 1 / (111320 * Math.cos(p.y * Math.PI / 180));
      // terén PŘÍMO pod stínem (stín leží na zemi, i když pták letí rovně)
      let terenStin = teren;
      try {
        const v = mapa.queryTerrainElevation
            && mapa.queryTerrainElevation([p.x + sx * mLon, p.y + sy * mLat]);
        if (typeof v === 'number') terenStin = v;
      } catch (e) { }
      const lls = new maplibregl.LngLat(p.x + sx * mLon, p.y + sy * mLat);
      let bs;
      try {
        bs = ter
          ? tr.locationToScreenPoint(lls, { getElevationForLngLat: () => terenStin })
          : tr.locationToScreenPoint(lls);
      } catch (e) { continue; }
      p.stin.style.opacity = (sila * p.op).toFixed(2);
      p.stin.style.transform = 'translate(-50%, -50%) translate(' + bs.x.toFixed(1)
        + 'px, ' + bs.y.toFixed(1) + 'px) rotate(' + otoc.toFixed(1) + 'deg) scale('
        // engine 259: stín je MENŠÍ než pták (leží 120 m pod ním) a měkký
        + (mer * 0.55).toFixed(3) + ', ' + (mer * 0.40).toFixed(3) + ')';
    }
  }

  function odpoj() {
    for (const p of ptaci) odstran(p);
    ptaci = [];
    bezi = false;
  }

  return { pripoj, odpoj, _ladeni: { pocet: () => ptaci.length,
    mach: () => { for (const p of ptaci) p.dalsiMach = 0; } } };
})();
