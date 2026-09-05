// ─────────────────────────────────────────────────────────────────────
// DOBYVATEL — vrstva vlajek a území (kostra MVP, v1.571)
//
// Zapíná/vypíná ho aplikace přes OkolnikMost.dobyvatel(zap). Kreslí:
//   • dob-uzemi/dob-hranice — Voroného oblasti vlajek: neutrální jen
//     tichá síť, držené území nese barvu týmu (vlastnost `t`),
//   • dob-vlajky — PRAPORKY: šedý = nikým nezabraná vlajka (přání
//     uživatele 25. 8.), jinak barva držícího týmu. Tým se promítá
//     přes setData s vlastností `t` — icon-image je layout vlastnost
//     a feature-state do ní nejde,
//   • dob-jmena — jména od z13,4 (⚠️ práh NEsmí být v pásmu pobytu
//     hráče ~z15–17, viz paměť o kolébání zoomu ±0,2).
// Klepnutí na vlajku hlásí do aplikace `onVlajka` {i, n, h}.
//
// Mlha se v Dobyvateli SCHOVÁVÁ (vrstvy `mlha*` na visibility none) —
// mlha je identita Objevitele, dobyvatel vidí celé bojiště.
//
// Data: assets/vlajky.json + assets/vlajky_oblasti.json (generuje
// tools/gen_vlajky.py — POŘADÍ VLAJEK JE SMLOUVA, feature id oblasti
// = index vlajky).
// ─────────────────────────────────────────────────────────────────────
window.Dobyvatel = (function () {
  'use strict';
  let mapa = null;
  let aktivni = false;
  let data = null;          // {body: FC, oblasti: FC, tymy: [...]}
  let nacitani = null;
  let mlhaSchovana = [];
  let drzitele = null;      // pole klíčů týmů ('' = neutrální)
  let boje = [];            // běžící boje ze snímku
  let bojeOd = 0;           // performance.now() příjmu snímku
  let bojeStariS = 0;       // stáří snímku při příjmu
  let bojeTikac = null;     // vteřinové překreslení časomíry
  let vlastniPole = [];     // vlastní místa soutěže (Etapa 4)
  let vlastniDosah = 150;   // poloměr kruhového území (m)
  // převod z webu (28. 8.): turistické trasy + informativní místa
  let trasyZap = false;     // přepínač z aplikace (Dobyvatel.trasy)
  let trasyFC = null;       // {r: FC, b: FC, g: FC, y: FC}
  let trasyNacita = false;
  let cykloZap = false;     // cyklotrasy (Dobyvatel.cyklo) — v1.595
  let cykloFC = null;       // {c: FC}
  let cykloNacita = false;
  const CYKLO_BARVA = '#8E44AD';   // fialová, ať se liší od pěších
  let infoFC = null;        // informativní místa (nedobývají se)
  let infoNacita = false;

  async function nacti() {
    if (data) return data;
    if (!nacitani) {
      nacitani = (async () => {
        const [vl, obl, tj] = await Promise.all([
          (await fetch('assets/vlajky.json')).json(),
          (await fetch('assets/vlajky_oblasti.json')).json(),
          (await fetch('assets/tymy.json')).json(),
        ]);
        const t0 = drzitele || [];
        const body = {
          type: 'FeatureCollection',
          features: vl.vlajky.map((v, i) => ({
            type: 'Feature', id: i,
            properties: { i: i, n: v.n, h: v.h, k: v.k,
                          t: t0[i] || '0' },
            geometry: { type: 'Point', coordinates: [v.lon, v.lat] },
          })),
        };
        spocitejPasmaDob(vl.vlajky, body.features);
        for (const f of obl.features) {
          f.properties.t = t0[f.id] || '0';
          f.properties.nad = '0';
        }
        data = { body: body, oblasti: obl, tymy: tj.tymy,
                 nStd: vl.vlajky.length,
                 // okres vlajky + [klíč, kraj] okresů — pro dobyté
                 // nadoblasti (vlastnost `nad`)
                 okresVlajky: vl.vlajky.map((v) => v.o),
                 okresy: vl.okresy };
        if (vlastniPole.length) zapracujVlastni();
        return data;
      })();
    }
    return nacitani;
  }

  // ── VLASTNÍ MÍSTA (Etapa 4): kruhová území kolem bodů, index
  // = nStd + pořadí (SMLOUVA s webem i rozhodčím) ────────────────
  function kruhVlastniho(lat, lon, r) {
    const dLat = r / 111320.0;
    const dLon = r / (111320.0 * Math.cos(lat * Math.PI / 180));
    const obvod = [];
    for (let i = 0; i <= 24; i++) {
      const a = i / 24 * 2 * Math.PI;
      obvod.push([lon + Math.cos(a) * dLon,
                  lat + Math.sin(a) * dLat]);
    }
    return { type: 'Polygon', coordinates: [obvod] };
  }

  function zapracujVlastni() {
    if (!data) return;
    const n = data.nStd;
    data.body.features.length = n;
    data.oblasti.features.length = n;
    const t0 = drzitele || [];
    vlastniPole.forEach((v, j) => {
      const idx = n + j;
      data.body.features.push({ type: 'Feature', id: idx,
        properties: { i: idx, n: v.n, h: v.h || 2, k: 'vlastni',
                      p: 4, t: t0[idx] || '0' },
        geometry: { type: 'Point',
                    coordinates: [v.lon, v.lat] } });
      data.oblasti.features.push({ type: 'Feature', id: idx,
        properties: { t: t0[idx] || '0', nad: '0' },
        geometry: kruhVlastniho(v.lat, v.lon, vlastniDosah) });
    });
    try {
      const b = mapa.getSource('dob-body');
      const o = mapa.getSource('dob-oblasti');
      if (b) b.setData(data.body);
      if (o) o.setData(data.oblasti);
    } catch (e) { /* vrstvy ještě nestojí */ }
  }

  /// Aplikace posílá vlastní místa soutěže (i prázdné pole při
  /// přepnutí na soutěž bez nich).
  function vlastni(pole, dosahM) {
    vlastniPole = Array.isArray(pole) ? pole : [];
    vlastniDosah = Number(dosahM) || 150;
    zapracujVlastni();
  }

  function barvaTymu() {
    const v = ['match', ['get', 't']];
    for (const t of data.tymy) { v.push(t.klic, t.barva); }
    v.push('#8a7a5c');            // neutrál (u výplně stejně skoro 0)
    return v;
  }

  function barvaNadoblasti() {
    const v = ['match', ['get', 'nad']];
    for (const t of data.tymy) { v.push(t.klic, t.barva); }
    v.push('#8a7a5c');
    return v;
  }

  // ── BUBLINKY JAKO NA WEBU (28. 8.): bílý kroužek s barevným
  // prstencem a emoji podle druhu; postupné odkrývání po druzích ──
  const BUBLINY = {
    castles: ['🏰', '#5D4037'], peaks: ['⛰️', '#4E6E58'],
    towers: ['🗼', '#455A64'], caves: ['🦇', '#4E342E'],
    waterfalls: ['💦', '#0277BD'], rocks: ['🪨', '#6D4C41'],
    viewpoints: ['🔭', '#00695C'], archaeology: ['🏺', '#8D6E63'],
    mines: ['⛏️', '#424242'], fortifications: ['🪖', '#4E342E'],
    memorial_trees: ['🌲', '#2E7D32'], jezera: ['🏞️', '#01579B'],
    prameny: ['💧', '#0288D1'], propasti: ['🕳️', '#37474F'],
    vlastni: ['🚩', '#C62828'],
  };

  function nakresliBublinu(emoji, barva) {
    const s = 256;
    const p = document.createElement('canvas');
    p.width = s;
    p.height = s;
    const ctx = p.getContext('2d');
    ctx.beginPath();
    ctx.arc(128, 128, 104, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 16;
    ctx.strokeStyle = barva;
    ctx.stroke();
    ctx.font = '128px "Noto Color Emoji", "Segoe UI Emoji", '
      + 'sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, 128, 140);
    return ctx.getImageData(0, 0, s, s);
  }

  // kreslené odznaky (assets/ikonky2) — emoji jen do jejich
  // příchodu / jako záloha; keš přežije přepnutí stylu
  const bublSoubor = {};

  function nahrajBubliny() {
    Object.keys(BUBLINY).forEach((k) => {
      const id = 'dobik-' + k;
      if (bublSoubor[k] && bublSoubor[k] !== true) {
        if (!mapa.hasImage(id)) {
          try {
            mapa.addImage(id, bublSoubor[k], { pixelRatio: 8 });
          } catch (e) { }
        }
        return;
      }
      if (!mapa.hasImage(id)) {
        mapa.addImage(id, nakresliBublinu(BUBLINY[k][0],
            BUBLINY[k][1]), { pixelRatio: 4 });
      }
      if (bublSoubor[k]) return;    // stahování už běží
      bublSoubor[k] = true;
      fetch('assets/ikonky2/' + k + '.webp')
        .then((r) => { if (!r.ok) throw 0; return r.blob(); })
        .then((bl) => createImageBitmap(bl))
        .then((im) => {
          bublSoubor[k] = im;
          try {
            if (mapa.hasImage(id)) mapa.removeImage(id);
            mapa.addImage(id, im, { pixelRatio: 8 });
          } catch (e) { }
        })
        .catch(() => { bublSoubor[k] = false; });
    });
  }

  /// Pásma odkrývání PO DRUZÍCH se stropem kvót (tatáž logika jako
  /// web — jinak by zdaleka byly „samé vrcholy").
  function spocitejPasmaDob(vl, feats) {
    const dle = {};
    vl.forEach((v, i) => { (dle[v.k] = dle[v.k] || []).push(i); });
    Object.keys(dle).forEach((k) => {
      const idx = dle[k];
      // SLAVNÁ místa (s ilustrací, pole `s`) přednostně (28. 8.)
      idx.sort((a, b) => (vl[b].s || 0) - (vl[a].s || 0)
        || (vl[b].h || 1) - (vl[a].h || 1)
        || (a * 2654435761 % 97) - (b * 2654435761 % 97) || a - b);
      const n = idx.length;
      const p4 = Math.min(Math.max(2, Math.round(n * 0.02)), 36);
      const p3 = p4 + Math.min(Math.max(6, Math.round(n * 0.08)), 150);
      const p2 = p3 + Math.round(n * 0.3);
      idx.forEach((fi, poradi) => {
        feats[fi].properties.p =
          poradi < p4 ? 4 : poradi < p3 ? 3 : poradi < p2 ? 2 : 1;
      });
    });
  }

  // ── TURISTICKÉ TRASY KČT (převod z webu 28. 8.): hlavní síť
  // (nwn/iwn) od z6,5, ostatní od z9,6; úseky za hranicí ČR
  // ztlumené (vlastnost v). Data assets/trasy.json — týž soubor
  // jako web (p = význam 0–3 | 4 mimo ČR). ─────────────────────
  const TRASY_BARVY = { r: '#c62f2f', b: '#1668b4',
                        g: '#2c8f43', y: '#c9a50e' };

  function nactiTrasy() {
    if (trasyNacita || trasyFC) { pridejTrasyVrstvy(); return; }
    trasyNacita = true;
    fetch('assets/trasy.json')
      .then((r) => r.json())
      .then((d) => {
        trasyNacita = false;
        trasyFC = {};
        Object.keys(TRASY_BARVY).forEach((k) => {
          const vlastnosti = d[k + 'p'] || [];
          trasyFC[k] = { type: 'FeatureCollection',
            features: (d[k] || []).map((u, idx) => {
              const body = [];
              for (let i = 0; i < u.length - 1; i += 2) {
                body.push([u[i + 1] / 1e5, u[i] / 1e5]);
              }
              const p = vlastnosti[idx] || 0;
              return { type: 'Feature',
                properties: { z: p & 3, v: (p & 4) ? 1 : 0 },
                geometry: { type: 'LineString', coordinates: body } };
            }) };
        });
        pridejTrasyVrstvy();
      })
      .catch(() => { trasyNacita = false; });
  }

  function trasyVrstvyIds() {
    const ven = [];
    Object.keys(TRASY_BARVY).forEach((k) => {
      ven.push('dob-trasa-' + k + '-hl', 'dob-trasa-' + k);
    });
    return ven;
  }

  function pridejTrasyVrstvy() {
    if (!mapa || !trasyFC || !aktivni) return;
    if (!mapa.getLayer('dob-jmena')) return;
    if (mapa.getSource('dob-trasa-r')) { prepniTrasyVrstvy(); return; }
    const vid = trasyZap ? 'visible' : 'none';
    Object.keys(TRASY_BARVY).forEach((k) => {
      mapa.addSource('dob-trasa-' + k,
          { type: 'geojson', data: trasyFC[k] });
      mapa.addLayer({ id: 'dob-trasa-' + k + '-hl', type: 'line',
        source: 'dob-trasa-' + k, minzoom: 6.5,
        filter: ['>=', ['get', 'z'], 2],
        layout: { visibility: vid, 'line-cap': 'round' },
        paint: { 'line-color': TRASY_BARVY[k],
          'line-width': ['interpolate', ['linear'], ['zoom'],
            6.5, 1.4, 10, 2.3, 13, 3, 16, 4],
          'line-opacity': ['case', ['==', ['get', 'v'], 1],
            0.25, 0.92] } }, 'dob-jmena');
      mapa.addLayer({ id: 'dob-trasa-' + k, type: 'line',
        source: 'dob-trasa-' + k, minzoom: 9.6,
        filter: ['<', ['get', 'z'], 2],
        layout: { visibility: vid, 'line-cap': 'round' },
        paint: { 'line-color': TRASY_BARVY[k],
          'line-width': ['interpolate', ['linear'], ['zoom'],
            9.6, 1, 13, 2.2, 16, 3.4],
          'line-opacity': ['case', ['==', ['get', 'v'], 1],
            0.22, 0.8] } }, 'dob-jmena');
    });
  }

  function prepniTrasyVrstvy() {
    if (!mapa) return;
    trasyVrstvyIds().forEach((id) => {
      try {
        mapa.setLayoutProperty(id, 'visibility',
            trasyZap ? 'visible' : 'none');
      } catch (e) { }
    });
  }

  /// Aplikace: zapnout/vypnout turistické trasy (jako na webu).
  function trasy(zap) {
    trasyZap = !!zap;
    if (trasyZap && !trasyFC) nactiTrasy();
    else prepniTrasyVrstvy();
  }

  // ───────── CYKLOTRASY (v1.595) — jedna barva, jinak jako pěší ─────
  function nactiCyklo() {
    if (cykloNacita || cykloFC) { pridejCykloVrstvy(); return; }
    cykloNacita = true;
    fetch('assets/cyklo.json')
      .then((r) => r.json())
      .then((d) => {
        cykloNacita = false;
        const vlastnosti = d.cp || [];
        cykloFC = { type: 'FeatureCollection',
          features: (d.c || []).map((u, idx) => {
            const body = [];
            for (let i = 0; i < u.length - 1; i += 2) {
              body.push([u[i + 1] / 1e5, u[i] / 1e5]);
            }
            const p = vlastnosti[idx] || 0;
            return { type: 'Feature',
              properties: { z: p & 3, v: (p & 4) ? 1 : 0 },
              geometry: { type: 'LineString', coordinates: body } };
          }) };
        pridejCykloVrstvy();
      })
      .catch(() => { cykloNacita = false; });
  }

  function cykloVrstvyIds() { return ['dob-cyklo-hl', 'dob-cyklo']; }

  function pridejCykloVrstvy() {
    if (!mapa || !cykloFC || !aktivni) return;
    if (!mapa.getLayer('dob-jmena')) return;
    if (mapa.getSource('dob-cyklo')) { prepniCykloVrstvy(); return; }
    const vid = cykloZap ? 'visible' : 'none';
    mapa.addSource('dob-cyklo', { type: 'geojson', data: cykloFC });
    // významné (mezinárodní/národní) už z dálky, přerušovaně ať se
    // liší od plných pěších tras
    mapa.addLayer({ id: 'dob-cyklo-hl', type: 'line',
      source: 'dob-cyklo', minzoom: 6.5,
      filter: ['>=', ['get', 'z'], 2],
      layout: { visibility: vid, 'line-cap': 'round' },
      paint: { 'line-color': CYKLO_BARVA,
        'line-width': ['interpolate', ['linear'], ['zoom'],
          6.5, 1.4, 10, 2.3, 13, 3, 16, 4],
        'line-dasharray': [2, 1.4],
        'line-opacity': ['case', ['==', ['get', 'v'], 1],
          0.25, 0.9] } }, 'dob-jmena');
    mapa.addLayer({ id: 'dob-cyklo', type: 'line',
      source: 'dob-cyklo', minzoom: 9.6,
      filter: ['<', ['get', 'z'], 2],
      layout: { visibility: vid, 'line-cap': 'round' },
      paint: { 'line-color': CYKLO_BARVA,
        'line-width': ['interpolate', ['linear'], ['zoom'],
          9.6, 1, 13, 2.2, 16, 3.4],
        'line-dasharray': [2, 1.4],
        'line-opacity': ['case', ['==', ['get', 'v'], 1],
          0.22, 0.8] } }, 'dob-jmena');
  }

  function prepniCykloVrstvy() {
    if (!mapa) return;
    cykloVrstvyIds().forEach((id) => {
      try {
        mapa.setLayoutProperty(id, 'visibility',
            cykloZap ? 'visible' : 'none');
      } catch (e) { }
    });
  }

  /// Aplikace: zapnout/vypnout cyklotrasy.
  function cyklo(zap) {
    // v1.601: cyklotrasy kreslí obecný modul v main.js (všechny režimy,
    // dlaždice ve Filtrech); tahle cesta zůstává jen kvůli starším
    // voláním a deleguje, ať se nekreslí dvakrát.
    if (window.OkolnikMost && OkolnikMost.cyklo) OkolnikMost.cyklo(zap);
  }

  // ── INFORMATIVNÍ MÍSTA (převod z webu): kandidáti, kteří se
  // nestali vlajkou — jen na koukání, přítomnost se počítá u
  // hlavního bodu oblasti. Načítá se ODLOŽENĚ (start!). ─────────
  function nactiInfo() {
    if (infoNacita || infoFC || !aktivni) return;
    infoNacita = true;
    fetch('assets/mista_info.json')
      .then((r) => r.json())
      .then((d) => {
        infoNacita = false;
        infoFC = { type: 'FeatureCollection',
          features: d.map((m) => ({ type: 'Feature',
            properties: { k: m[0], n: m[3], m: m[4] ? 1 : 0 },
            geometry: { type: 'Point',
              coordinates: [m[2] / 1e5, m[1] / 1e5] } })) };
        pridejInfoVrstvu();
      })
      .catch(() => { infoNacita = false; });
  }

  function pridejInfoVrstvu() {
    if (!mapa || !infoFC || !aktivni) return;
    if (mapa.getLayer('dob-info') || !mapa.getLayer('dob-jmena')) {
      return;
    }
    if (!mapa.getSource('dob-info')) {
      mapa.addSource('dob-info', { type: 'geojson', data: infoFC });
    }
    // pod jmény = ustoupí všemu důležitějšímu
    mapa.addLayer({ id: 'dob-info', type: 'symbol',
      source: 'dob-info', minzoom: 11.6,
      layout: {
        'icon-image': ['concat', 'dobik-', ['get', 'k']],
        // ⛔ zoom-interpolate musí být NA VRCHOLU výrazu
        'icon-size': ['interpolate', ['linear'], ['zoom'],
          11.6, ['case', ['==', ['get', 'm'], 1], 0.18, 0.28],
          14, ['case', ['==', ['get', 'm'], 1], 0.25, 0.38],
          17, ['case', ['==', ['get', 'm'], 1], 0.53, 0.8]],
        'icon-padding': 2,
      },
      paint: { 'icon-opacity': 0.55 } }, 'dob-jmena');
    mapa.on('click', 'dob-info', naKlikInfo);
  }

  function naKlikInfo(e) {
    try {
      const f = e.features && e.features[0];
      if (!f) return;
      // vlajka v dosahu má přednost (bublinky jsou nad informativními)
      const p = e.point;
      const vlajkyTu = mapa.queryRenderedFeatures(
          [[p.x - 14, p.y - 14], [p.x + 14, p.y + 14]],
          { layers: ['dob-ik4', 'dob-ik3', 'dob-ik2', 'dob-ik1',
                     'dob-ik-vse'].filter((id) => mapa.getLayer(id)) });
      if (vlajkyTu.length) return;
      klikPraveTed = true;
      if (typeof mostHlas === 'function') {
        mostHlas('onInfoMisto', { n: f.properties.n,
                                  k: f.properties.k });
      }
    } catch (err) { /* klik nesmí shodit mapu */ }
  }

  // praporky se do stylu nahrávají jednou; přepnutí stylu je odnese,
  // pridejVrstvy je proto vždy znovu ověří
  async function nahrajPraporky() {
    const klice = ['0'].concat(data.tymy.map((t) => t.klic));
    await Promise.all(klice.map(async (k) => {
      const id = 'praporek-' + k;
      if (mapa.hasImage && mapa.hasImage(id)) return;
      try {
        const odpoved = await fetch('assets/praporky/p_' + k + '.webp');
        const bitmapa = await createImageBitmap(await odpoved.blob());
        if (!mapa.hasImage(id)) {
          mapa.addImage(id, bitmapa, { pixelRatio: 2 });
        }
      } catch (e) { /* bez praporku zůstane vlajka neviditelná,
                       ale mapa nespadne */ }
    }));
  }

  async function pridejVrstvy() {
    if (!mapa || !data || mapa.getSource('dob-body')) return;
    nahrajBubliny();
    if (!aktivni || mapa.getSource('dob-body')) return;
    mapa.addSource('dob-body', { type: 'geojson', data: data.body });
    mapa.addSource('dob-oblasti',
        { type: 'geojson', data: data.oblasti });

    // území: neutrální jen tichá síť, držené v barvě týmu
    mapa.addLayer({ id: 'dob-uzemi', type: 'fill',
      source: 'dob-oblasti', minzoom: 8,
      paint: {
        'fill-color': barvaTymu(),
        'fill-opacity': ['case', ['==', ['get', 't'], '0'], 0.05, 0.24],
      } });
    // DOBYTÉ NADOBLASTI (>50 % bodů okresu/kraje): celý okres se
    // přelije barvou týmu — vidět i zdaleka, kde jednotlivá území
    // už nejsou (dob-uzemi má minzoom 8). `nad` plní stav().
    mapa.addLayer({ id: 'dob-nadoblasti', type: 'fill',
      source: 'dob-oblasti',
      paint: {
        'fill-color': barvaNadoblasti(),
        'fill-opacity': ['case',
          ['==', ['coalesce', ['get', 'nad'], '0'], '0'], 0, 0.20],
      } });
    // výrazněji — hranice se pletly s kresbou mapy (výtka 29. 8.)
    mapa.addLayer({ id: 'dob-hranice', type: 'line',
      source: 'dob-oblasti', minzoom: 9.5,
      paint: {
        'line-color': ['case', ['==', ['get', 't'], '0'],
                       '#6d6350', barvaTymu()],
        'line-opacity': ['case', ['==', ['get', 't'], '0'], 0.5, 0.9],
        'line-width': ['case', ['==', ['get', 't'], '0'], 1.0, 1.8],
      } });
    // zvýraznění KLIKNUTÉHO území (ať je poznat, co je nakliknuto)
    mapa.addLayer({ id: 'dob-zvyraz', type: 'line',
      source: 'dob-oblasti',
      filter: ['==', ['id'], -1],
      paint: { 'line-color': '#2f2a20', 'line-width': 3,
               'line-opacity': 0.95 } });
    // prstenec kolem hlavního bodu vybraného místa (převod z webu:
    // drobné/klínové buňky z dálky zaniknou, kroužek u vlajky ne)
    mapa.addLayer({ id: 'dob-zvyraz-bod', type: 'circle',
      source: 'dob-body',
      filter: ['==', ['id'], -1],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'],
          5, 11, 10, 16, 14, 24],
        'circle-color': '#C99B3F',
        'circle-opacity': 0.12,
        'circle-stroke-color': '#C99B3F',
        'circle-stroke-width': 3.5,
        'circle-stroke-opacity': 0.95,
      } });

    // jména POD bublinami (vrstva výš se rozmisťuje dřív — bubliny
    // mají přednost, jména si nepřekáží navzájem)
    mapa.addLayer({ id: 'dob-jmena', type: 'symbol',
      source: 'dob-body', minzoom: 8.6,
      layout: {
        'text-field': ['get', 'n'],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'],
          8.6, 10.5, 12, 12],
        'text-offset': ['interpolate', ['exponential', 1.5], ['zoom'],
          10, ['literal', [0, 0.9]], 13, ['literal', [0, 1.7]],
          17, ['literal', [0, 7.5]]],
        'text-anchor': 'top',
        'text-max-width': 9,
      },
      paint: { 'text-color': '#4a443a',
               'text-halo-color': '#f2efe6',
               'text-halo-width': 1.3 } });

    // ⭐ v1.599 (přání 2. 9. večer „raději ve tmě ozařuj vlajky"):
    // teplá záře pod vlajkami, ve dne neviditelná; sílu řídí krok
    // noci z main.js (aplikujNoc → Dobyvatel.noc). Nahrazuje můry,
    // netopýry i světla oken, které z bojiště zmizely.
    mapa.addLayer({ id: 'dob-zare', type: 'circle',
      source: 'dob-body', minzoom: 11,
      paint: {
        'circle-color': '#FFB347',
        'circle-blur': 0.9,
        'circle-opacity': 0,
        'circle-opacity-transition': { duration: 1200 },
        // poloměr musí PŘESAHOVAT bublinu vlajky (~48 dp při z13,8),
        // jinak záře zůstane schovaná pod ikonou (vyladěno naživo 2. 9.)
        'circle-radius': ['interpolate', ['exponential', 1.5], ['zoom'],
          11, 12, 13.8, 40, 17, 110],
      } });
    noc(typeof krokNoci !== 'undefined' ? krokNoci : 0);

    // BUBLINKY s odkrýváním jako web: pásma podle p, růst od z13,
    // od z13,8 úplné pokrytí bez kolizí
    [[4, 6], [3, 9.2], [2, 10.8], [1, 12]].forEach((pz) => {
      mapa.addLayer({ id: 'dob-ik' + pz[0], type: 'symbol',
        source: 'dob-body', minzoom: pz[1], maxzoom: 13.8,
        filter: ['==', ['get', 'p'], pz[0]],
        layout: {
          'icon-image': ['concat', 'dobik-', ['get', 'k']],
          'icon-size': ['interpolate', ['exponential', 1.5], ['zoom'],
            6, 0.5, 10, 0.66, 13, 0.85, 17, 2.9],
          'icon-padding': ['interpolate', ['linear'], ['zoom'],
            6, 26, 9, 14, 12, 4],
        } });
    });
    mapa.addLayer({ id: 'dob-ik-vse', type: 'symbol',
      source: 'dob-body', minzoom: 13.8,
      layout: {
        'icon-image': ['concat', 'dobik-', ['get', 'k']],
        'icon-size': ['interpolate', ['exponential', 1.5], ['zoom'],
          13.8, 0.9, 17, 2.9],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      } });

    // BOJE: pulzující kruh v barvě útočníka + odpočet nad vlajkou
    // (bojů jsou jednotky — vteřinový setData ani pulz nic nestojí)
    mapa.addSource('dob-boje', { type: 'geojson',
      data: { type: 'FeatureCollection', features: [] } });
    mapa.addLayer({ id: 'dob-boj-kruh', type: 'circle',
      source: 'dob-boje',
      paint: {
        'circle-color': ['get', 'c'],
        'circle-opacity': 0.22,
        'circle-radius': 15,
        'circle-stroke-color': ['get', 'c'],
        'circle-stroke-width': 2,
        'circle-stroke-opacity': 0.85,
      } });
    mapa.addLayer({ id: 'dob-boj-cas', type: 'symbol',
      source: 'dob-boje',
      layout: {
        'text-field': ['get', 'z'],
        'text-font': ['Noto Sans Bold'],
        'text-size': 14,
        'text-offset': [0, -2.6],
        'text-anchor': 'bottom',
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': ['get', 'c'],
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.6,
      } });

    ['dob-ik4', 'dob-ik3', 'dob-ik2', 'dob-ik1', 'dob-ik-vse']
      .forEach((id) => { mapa.on('click', id, naKlik); });
    mapa.on('click', 'dob-boj-kruh', naKlik);
    mapa.on('click', naKlikMimo);
    aplikujFiltr();
    // převod z webu: trasy (jsou-li zapnuté) + informativní místa
    // — po přepnutí stylu je pridejVrstvy postaví znovu
    if (trasyFC) pridejTrasyVrstvy();
    else if (trasyZap) nactiTrasy();
    if (cykloFC) pridejCykloVrstvy();
    else if (cykloZap) nactiCyklo();
    if (infoFC) pridejInfoVrstvu();
  }

  function barvaKlice(klic) {
    for (const t of (data && data.tymy) || []) {
      if (t.klic === klic) return t.barva;
    }
    return '#8f897c';
  }

  function mmss(s) {
    if (s < 0) return '…';
    const m = Math.floor(s / 60);
    const v = String(Math.floor(s % 60)).padStart(2, '0');
    return m + ':' + v;
  }

  /// Překreslí časomíry bojů (1×/s) + jemný pulz kruhu.
  function tikBoje() {
    if (!mapa || !data) return;
    const zdroj = mapa.getSource('dob-boje');
    if (!zdroj) return;
    const ubehloOdSnimku =
        bojeStariS + (performance.now() - bojeOd) / 1000;
    const prvky = [];
    for (const b of boje) {
      const f = data.body.features[b.vlajka];
      if (!f) continue;
      // PAT a vyprchávání se NEextrapolují — postup stojí/klesá,
      // pravdu má rozhodčí (výtka „dal jsem bránit a odpočet běžel")
      let text;
      if (b.stav === 'pat') {
        text = 'PAT';
      } else if (b.stav === 'vyprchava') {
        text = '⌛';
      } else if (b._lokalni) {
        text = '…';
      } else {
        text = mmss(Math.round((b.potrebaS || 600)
            - (b.prubehS || 0) - ubehloOdSnimku));
      }
      prvky.push({
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          c: barvaKlice(b.utocnik),
          z: text,
          i: f.properties.i,
          n: f.properties.n,
          h: f.properties.h,
        },
      });
    }
    zdroj.setData({ type: 'FeatureCollection', features: prvky });
    try {
      const puls = 15 + 4 * Math.sin(performance.now() / 450);
      mapa.setPaintProperty('dob-boj-kruh', 'circle-radius', puls);
    } catch (e) { /* vrstvu mohl odnést styl */ }
  }

  function rozjedBoje() {
    if (bojeTikac) { clearInterval(bojeTikac); bojeTikac = null; }
    if (!aktivni || !boje.length) { tikBoje(); return; }
    tikBoje();
    bojeTikac = setInterval(tikBoje, 1000);
  }

  let klikPraveTed = false;

  function zvyrazni(idx) {
    try {
      ['dob-zvyraz', 'dob-zvyraz-bod'].forEach((id) => {
        if (mapa.getLayer(id)) {
          mapa.setFilter(id, ['==', ['id'], idx]);
        }
      });
    } catch (err) { /* vrstvu mohl odnést styl */ }
  }

  function naKlik(e) {
    try {
      const f = e.features && e.features[0];
      if (!f) return;
      klikPraveTed = true;
      zvyrazni(Number(f.properties.i));
      if (typeof mostHlas === 'function') {
        mostHlas('onVlajka', { i: f.properties.i, n: f.properties.n,
                               h: f.properties.h });
      }
    } catch (err) { /* klik nesmí shodit mapu */ }
  }

  function naKlikMimo() {
    if (klikPraveTed) { klikPraveTed = false; return; }
    zvyrazni(-1);
  }

  // ── FILTR DRUHŮ (přání 29. 8.): aplikace pošle seznam druhů,
  // které se mají ukazovat; bublinky i jména ostatních zmizí ─────
  let filtrDruhu = null;   // pole klíčů, null = všechny

  function aplikujFiltr() {
    if (!mapa) return;
    const kindF = (filtrDruhu && filtrDruhu.length)
      ? ['in', ['get', 'k'], ['literal', filtrDruhu]]
      : null;
    try {
      [4, 3, 2, 1].forEach((p) => {
        const zaklad = [['==', ['get', 'p'], p]];
        mapa.setFilter('dob-ik' + p, kindF
          ? ['all'].concat(zaklad).concat([kindF])
          : ['all'].concat(zaklad));
      });
      mapa.setFilter('dob-ik-vse', kindF);
      mapa.setFilter('dob-jmena', kindF);
    } catch (e) { /* vrstvy ještě nestojí */ }
  }

  /// Aplikace: seznam druhů k zobrazení (prázdné/null = všechny).
  function filtr(seznam) {
    filtrDruhu = (Array.isArray(seznam) && seznam.length)
      ? seznam : null;
    aplikujFiltr();
  }

  // Kromě mlhy jde v Dobyvateli pryč VŠECHNO KRESLENÉ APPKOU, co má
  // web-mapa vlastní (výtka 29. 8. „dej mu jen ty své z webu"):
  // malované kresby (ink-ilustrace*), POI místa se shluky a jmény
  // (okolnik-mista*), záložky a záznamy s datem (okolnik-moje*)
  // a odznaky návštěv (okolnik-navsteva*). Vlajky, informativní
  // místa a odznaky si Dobyvatel kreslí sám; plán, navigace,
  // postavička a probíhající výprava zůstávají.
  const ciziVrstva = (id) =>
    id.startsWith('mlha') || id.startsWith('ink-ilustrace') ||
    id.startsWith('okolnik-mista') || id.startsWith('okolnik-moje') ||
    id.startsWith('okolnik-navsteva');

  function schovejMlhu(schovat) {
    try {
      const vrstvy = (mapa.getStyle().layers || []).map((v) => v.id);
      // obnova jde plošně (ne přes zapamatovaný seznam): ilustrace
      // se v aktivním Dobyvateli rodí rovnou skryté a seznam by je
      // minul; mimo Dobyvatele není důvod je skryté držet
      for (const id of vrstvy) {
        if (!ciziVrstva(id)) continue;
        const ted = mapa.getLayoutProperty(id, 'visibility');
        if (schovat && ted !== 'none') {
          mapa.setLayoutProperty(id, 'visibility', 'none');
        } else if (!schovat && ted === 'none') {
          mapa.setLayoutProperty(id, 'visibility', 'visible');
        }
      }
      mlhaSchovana = [];
    } catch (e) { /* mlha nemusí existovat (neherní styl) */ }
  }

  function odeber() {
    if (bojeTikac) { clearInterval(bojeTikac); bojeTikac = null; }
    try {
      for (const id of ['dob-ik4', 'dob-ik3', 'dob-ik2', 'dob-ik1',
                        'dob-ik-vse']) {
        mapa.off('click', id, naKlik);
      }
      mapa.off('click', 'dob-boj-kruh', naKlik);
      mapa.off('click', 'dob-info', naKlikInfo);
    } catch (e) { }
    try {
      for (const id of ['dob-boj-cas', 'dob-boj-kruh', 'dob-zare', 'dob-jmena',
                        'dob-ik4', 'dob-ik3', 'dob-ik2', 'dob-ik1',
                        'dob-ik-vse', 'dob-zvyraz', 'dob-zvyraz-bod',
                        'dob-info', 'dob-hranice',
                        'dob-nadoblasti', 'dob-uzemi']
            .concat(trasyVrstvyIds()).concat(cykloVrstvyIds())) {
        if (mapa.getLayer(id)) mapa.removeLayer(id);
      }
      for (const s of ['dob-boje', 'dob-body', 'dob-oblasti',
                       'dob-info', 'dob-trasa-r', 'dob-trasa-b',
                       'dob-trasa-g', 'dob-trasa-y', 'dob-cyklo']) {
        if (mapa.getSource(s)) mapa.removeSource(s);
      }
    } catch (e) { /* přepnutí stylu mohlo vrstvy odnést samo */ }
  }

  // mraky, déšť i mračnou mlhu kreslí modul Počasí na vlastní plátno —
  // v Dobyvateli jdou pryč celé (přání 26. 8.), ať je bojiště čisté
  function schovejPocasi(schovat) {
    try {
      if (window.Pocasi && Pocasi.nastavVidno) {
        Pocasi.nastavVidno(!schovat);
      }
      // nastavVidno jen zastaví tik — POSLEDNÍ NAKRESLENÝ SNÍMEK by na
      // plátně zůstal (a posun mapy kreslí dál); plátno se musí schovat
      const el = document.getElementById('pocasi-mraky');
      if (el) el.style.display = schovat ? 'none' : '';
    } catch (e) { /* styl bez počasí */ }
  }

  async function zapni(map) {
    mapa = map || mapa;
    aktivni = true;
    // PRVNÍ zapnutí parsuje 6,4 MB assetů na vlákně WebView — při
    // startu appky to brzdilo náběh mapy. Odklad vznikl, když se
    // zapni() volalo PŘED 'load'; dnes přichází až z onReady (po
    // load), takže stačí krátký ústupek prvnímu vykreslení
    // (změřeno 29. 8.: 1200 ms zdržovalo území o ~1 s zbytečně).
    if (!data) {
      await new Promise((res) => setTimeout(res, 300));
      if (!aktivni) return;
    }
    await nacti();
    if (!aktivni) return;      // mezitím vypnuto
    await pridejVrstvy();
    schovejMlhu(true);
    schovejPocasi(true);
    rozjedBoje();
    // informativní místa až po náběhu mapy (649 kB parse na vlákně)
    setTimeout(nactiInfo, 2500);
  }

  /// Okamžitá odezva po stisku Obsadit/při obraně: nakreslí boj
  /// lokálně („…"), než ho potvrdí snímek rozhodčího. Snímek pak
  /// lokální záznam přepíše (stav() bere kompletní seznam).
  function zahajeni(idx, tymKlic) {
    idx = Number(idx);
    for (const b of boje) {
      if (b.vlajka === idx) return;   // boj už běží
    }
    boje = boje.concat([{ vlajka: idx, utocnik: tymKlic,
                          prubehS: 0, potrebaS: 600,
                          stav: 'utok', _lokalni: true }]);
    rozjedBoje();
  }

  /// Snímek stavu ze serveru: pole klíčů týmů dle indexu vlajky
  /// ('' = neutrální). Promítá se setData — icon-image feature-state
  /// neumí.
  let minulySnimekPodpis = '';

  function stav(noviDrzitele, noveBoje, stariS, dobyto) {
    drzitele = noviDrzitele || null;
    boje = Array.isArray(noveBoje) ? noveBoje : [];
    bojeOd = performance.now();
    bojeStariS = Number(stariS) || 0;
    rozjedBoje();
    if (!data) return;
    // ⛔ PROBLIKÁVÁNÍ HRANIC (výtka 29. 8.): setData 17 688 polygonů
    // každé 2 minuty přestavuje dlaždice zdroje a hranice na okamžik
    // mizí. Když se držitelé ani nadoblasti NEZMĚNILY (běžný
    // případ), na zdroje se nesahá.
    const podpis = JSON.stringify([noviDrzitele || 0, dobyto || 0]);
    if (podpis === minulySnimekPodpis) return;
    minulySnimekPodpis = podpis;
    const t0 = drzitele || [];
    for (const f of data.body.features) {
      f.properties.t = t0[f.properties.i] || '0';
    }
    // dobyté nadoblasti: kraj má přednost před okresem (je větší)
    const dOkresy = (dobyto && dobyto.okresy) || {};
    const dKraje = (dobyto && dobyto.kraje) || {};
    for (const f of data.oblasti.features) {
      f.properties.t = t0[f.id] || '0';
      // dobyto je klíčované JMÉNEM okresu/kraje ('teplice',
      // 'ustecky') — index vlajky se překládá přes legendu okresů
      const o = data.okresy[data.okresVlajky[f.id]] || [];
      f.properties.nad = dKraje[o[1]] || dOkresy[o[0]] || '0';
    }
    try {
      const b = mapa.getSource('dob-body');
      const o = mapa.getSource('dob-oblasti');
      if (b) b.setData(data.body);
      if (o) o.setData(data.oblasti);
    } catch (e) { /* mimo režim není co překreslit */ }
  }

  function vypni() {
    aktivni = false;
    if (!mapa) return;
    odeber();
    schovejMlhu(false);
    schovejPocasi(false);
  }

  // přepnutí stylu vrstvy tiše odnese → po každém dostavění stylu se
  // v aktivním režimu přidají znovu (getSource brání smyčce)
  let hlidam = false;
  function hlidejStyl(map) {
    mapa = map;
    if (hlidam) return;
    hlidam = true;
    map.on('styledata', () => {
      if (!aktivni) return;
      if (data && !map.getSource('dob-body')) {
        try {
          pridejVrstvy();
          schovejMlhu(true);
          schovejPocasi(true);
        } catch (e) { }
      } else {
        // vrstvy appky (místa, návštěvy, záložky) přibývají KDYKOLI
        // později — každé addLayer vyvolá styledata, takže se tu
        // schovávají průběžně (setLayoutProperty na už skryté nesahá,
        // smyčka se tím zastaví sama)
        try { schovejMlhu(true); } catch (e) { }
      }
    });
  }

  /// Jeden popup (26. 8.): když v Dobyvateli leží pod klepnutím
  /// vlajka, ostatní vrstvy (kresby, POI, místa) detail NEotvírají —
  /// jinak se přes sebe otevřely dva popupy.
  function spolklKlik(e) {
    try {
      if (!aktivni || !mapa || !e || !e.point) return false;
      const vrstvy = ['dob-ik4', 'dob-ik3', 'dob-ik2', 'dob-ik1',
                      'dob-ik-vse'].filter((id) => mapa.getLayer(id));
      if (!vrstvy.length) return false;
      const p = e.point;
      return mapa.queryRenderedFeatures(
          [[p.x - 14, p.y - 14], [p.x + 14, p.y + 14]],
          { layers: vrstvy.concat(
              mapa.getLayer('dob-info') ? ['dob-info'] : []) })
        .length > 0;
    } catch (err) { return false; }
  }

  /// Síla záře vlajek podle kroku noci (0 den … 3 plná noc).
  function noc(krok) {
    try {
      if (!mapa || !mapa.getLayer('dob-zare')) return;
      const k = Math.max(0, Math.min(3, krok | 0));
      mapa.setPaintProperty('dob-zare', 'circle-opacity',
          [0, 0.28, 0.5, 0.7][k]);
    } catch (e) { /* styl se právě mění */ }
  }

  return { zapni, vypni, stav, zahajeni, hlidejStyl, spolklKlik,
           vlastni, filtr, trasy, cyklo, noc,
           jeAktivni: () => aktivni };
})();
