// Okolník 3D — navigace s převýšením (prototyp).
//
// Trasu počítá BRouter (lokální server, spouští pipeline/nav_server.ps1;
// později veřejný server vedle dlaždic). Výškový profil se NEBERE
// z BRouteru (SRTM ~30 m), ale z našeho terénu DMR 5G — vzorkování
// dlaždic podél trasy, bilineární interpolace, součty s hysterezí.
//
// Ovládání: tlačítko „Navigace" → 1. klik = start, 2. klik = cíl.
// Vrstvy se po přepnutí stylu obnoví přes Navigace.obnovVrstvy().
'use strict';

const Navigace = (() => {
  const BROUTER = 'http://localhost:17777/brouter';
  const PROFILY = { pesky: 'hiking-mountain', kolo: 'trekking' };
  const KROK_M = 100;          // vzorkování profilu po metrech
  const HYSTEREZE_M = 2;       // filtr šumu při součtu stoupání

  let mapa = null;
  let rezim = false;           // zapnutý výběr bodů
  let body = [];               // [[lng,lat], [lng,lat]]
  let trasa = null;            // GeoJSON LineString
  let profil = null;           // {vzdal[], vyska[], stoupani, klesani, delkaKm}
  let profilCtrl = null;       // AbortController běžícího výpočtu
  let dostupny = null;         // BRouter server nalezen?

  // ---------------------------------------------------------------------- UI
  function el(id) { return document.getElementById(id); }

  async function init(m) {
    mapa = m;
    try {
      const r = await fetch(BROUTER.replace('/brouter', '/robots.txt'),
                            { signal: AbortSignal.timeout(1500) });
      dostupny = true;   // server odpovídá (čímkoli)
    } catch (e) { dostupny = false; }
    if (el('nav-prepinac')) {
      el('nav-prepinac').addEventListener('click', prepni);
      el('nav-zrusit').addEventListener('click', zrus);
      el('nav-prolet').addEventListener('click', prolet);
    }
    mapa.on('click', klik);
  }

  function aktivni() { return rezim; }

  function prepni() {
    if (!dostupny) {
      alert('Navigační server neběží.\nSpusť: powershell -File '
        + 'pipeline\\nav_server.ps1 (viz pipeline/README.md)');
      return;
    }
    rezim = !rezim;
    if (rezim) { body = []; nastavData('nav-body', prazdno()); }
    el('nav-prepinac').classList.toggle('aktivni', rezim);
    el('nav-prepinac').textContent =
      rezim ? (body.length === 0 ? 'Klepni na START' : 'Klepni na CÍL')
            : '🧭 Navigace';
  }

  function klik(e) {
    if (!rezim) return;
    body.push([e.lngLat.lng, e.lngLat.lat]);
    kresliBody();
    if (body.length === 1) {
      el('nav-prepinac').textContent = 'Klepni na CÍL';
    } else if (body.length >= 2) {
      rezim = false;
      el('nav-prepinac').classList.remove('aktivni');
      el('nav-prepinac').textContent = '🧭 Navigace';
      najdiTrasu();
    }
  }

  // ------------------------------------------------------------------ vrstvy
  function prazdno() {
    return { type: 'FeatureCollection', features: [] };
  }

  function nastavData(id, data) {
    const z = mapa.getSource(id);
    if (z) z.setData(data);
  }

  function obnovVrstvy() {
    if (!mapa || mapa.getSource('nav-trasa')) { prekresli(); return; }
    mapa.addSource('nav-trasa',
        { type: 'geojson', data: prazdno(), maxzoom: 14 });
    mapa.addSource('nav-body',
        { type: 'geojson', data: prazdno(), maxzoom: 14 });
    // ⛔ ČÁRY TRASY PATŘÍ DO DRAPOVANÉHO BLOKU (7. 8. 2026). Přidané
    // nakonec seděly NAD symboly, a tím založily další „stack" – další
    // texturu na každou terénní dlaždici a snímek. Vkládají se proto
    // před první nedrapovanou vrstvu. Kolečka bodů (circle) můžou
    // zůstat nahoře, ta stack nezaloží (už jsou nad ním).
    const drapuje = { background: 1, fill: 1, line: 1, raster: 1,
                      hillshade: 1, 'color-relief': 1 };
    let predSymboly;
    try {
      for (const v of mapa.getStyle().layers) {
        if (!drapuje[v.type]) { predSymboly = v.id; break; }
      }
    } catch (e) { /* styl se zrovna mění */ }
    mapa.addLayer({ id: 'nav-trasa-obrys', type: 'line', source: 'nav-trasa',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9 } },
      predSymboly);
    mapa.addLayer({ id: 'nav-trasa-cara', type: 'line', source: 'nav-trasa',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#F29D38', 'line-width': 4 } }, predSymboly);
    mapa.addLayer({ id: 'nav-body-kruhy', type: 'circle', source: 'nav-body',
      paint: { 'circle-radius': 7, 'circle-color': ['match', ['get', 'typ'],
                 'start', '#2E7D5B', '#C1402C'],
               'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
    prekresli();
  }

  function kresliBody() {
    nastavData('nav-body', { type: 'FeatureCollection',
      features: body.map((b, i) => ({ type: 'Feature',
        properties: { typ: i === 0 ? 'start' : 'cil' },
        geometry: { type: 'Point', coordinates: b } })) });
  }

  function prekresli() {
    if (trasa) nastavData('nav-trasa', trasa);
    kresliBody();
  }

  // ------------------------------------------------------------------- trasa
  async function najdiTrasu() {
    const profilJmeno = el('nav-profil-vyber')
      ? PROFILY[el('nav-profil-vyber').value] || 'trekking' : 'trekking';
    const lonlats = body.map(b => b.join(',')).join('|');
    const url = `${BROUTER}?lonlats=${lonlats}&profile=${profilJmeno}`
      + '&alternativeidx=0&format=geojson';
    el('nav-info').textContent = 'Hledám trasu…';
    el('nav-info').style.display = 'block';
    try {
      const odp = await fetch(url);
      if (!odp.ok) throw new Error(await odp.text());
      const geo = await odp.json();
      trasa = geo;
      nastavData('nav-trasa', trasa);
      const vlastnosti = geo.features && geo.features[0]
        && geo.features[0].properties || {};
      const delkaKm = (parseFloat(vlastnosti['track-length']) || 0) / 1000;
      el('nav-info').textContent =
        `Trasa ${delkaKm.toFixed(1)} km — počítám převýšení…`;
      el('nav-prolet').style.display = 'inline-block';
      el('nav-zrusit').style.display = 'inline-block';
      await spocitejProfil(delkaKm);
    } catch (e) {
      el('nav-info').textContent = 'Trasa se nenašla: '
        + String(e.message || e).slice(0, 120);
      trasa = null;
    }
  }

  function zrus() {
    body = []; trasa = null; profil = null; rezim = false;
    if (profilCtrl) profilCtrl.abort();
    nastavData('nav-trasa', prazdno());
    nastavData('nav-body', prazdno());
    el('nav-info').style.display = 'none';
    el('nav-prolet').style.display = 'none';
    el('nav-zrusit').style.display = 'none';
    el('nav-graf').style.display = 'none';
    el('nav-prepinac').classList.remove('aktivni');
    el('nav-prepinac').textContent = '🧭 Navigace';
  }

  // -------------------------------------------- výškový profil z DMR dlaždic
  const Z_PROFIL = 13;
  const dlazdiceCache = new Map();   // "x/y" → Float64Array | Promise

  function mercXY(lng, lat) {
    const n = 2 ** Z_PROFIL;
    const x = (lng + 180) / 360 * n;
    const y = (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n;
    return [x, y];
  }

  async function nactiDlazdici(tx, ty) {
    const klic = `${tx}/${ty}`;
    if (dlazdiceCache.has(klic)) return dlazdiceCache.get(klic);
    const slib = (async () => {
      let bajty;
      if (KONFIG.terenUrl.startsWith('pmtiles://')) {
        const p = new pmtiles.PMTiles(KONFIG.terenUrl.slice(10));
        const t = await p.getZxy(Z_PROFIL, tx, ty);
        if (!t) return null;
        bajty = new Blob([t.data], { type: 'image/png' });
      } else {
        const url = KONFIG.terenUrl.replace('{z}', Z_PROFIL)
          .replace('{x}', tx).replace('{y}', ty);
        const r = await fetch(url);
        if (!r.ok) return null;
        bajty = await r.blob();
      }
      const bmp = await createImageBitmap(bajty);
      const c = new OffscreenCanvas(256, 256);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, 256, 256).data;
      const vysky = new Float64Array(256 * 256);
      for (let i = 0; i < vysky.length; i++) {
        vysky[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
      }
      return vysky;
    })();
    dlazdiceCache.set(klic, slib);
    return slib;
  }

  async function vyska(lng, lat) {
    const [x, y] = mercXY(lng, lat);
    const tx = Math.floor(x), ty = Math.floor(y);
    const data = await nactiDlazdici(tx, ty);
    if (!data) return null;
    // bilineární interpolace uvnitř dlaždice (na hraně stačí ořez)
    const px = Math.min(254.999, Math.max(0, (x - tx) * 256));
    const py = Math.min(254.999, Math.max(0, (y - ty) * 256));
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const fx = px - x0, fy = py - y0;
    const v = (xx, yy) => data[yy * 256 + xx];
    return v(x0, y0) * (1 - fx) * (1 - fy) + v(x0 + 1, y0) * fx * (1 - fy)
      + v(x0, y0 + 1) * (1 - fx) * fy + v(x0 + 1, y0 + 1) * fx * fy;
  }

  function metryNaStupne(lat) {
    return { dLat: 1 / 110574, dLng: 1 / (111320 * Math.cos(lat * Math.PI / 180)) };
  }

  async function spocitejProfil(delkaKm) {
    if (profilCtrl) profilCtrl.abort();
    profilCtrl = new AbortController();
    const signal = profilCtrl.signal;
    const cara = trasa.features[0].geometry.coordinates;   // [lng,lat,(ele)]
    // převzorkování po KROK_M metrech
    const vzorky = [];
    let zbytek = 0, celkem = 0;
    for (let i = 1; i < cara.length; i++) {
      const [ax, ay] = cara[i - 1], [bx, by] = cara[i];
      const { dLat, dLng } = metryNaStupne((ay + by) / 2);
      const dx = (bx - ax) / dLng, dy = (by - ay) / dLat;
      const d = Math.hypot(dx, dy);
      let s = zbytek;
      while (s < d) {
        vzorky.push([ax + (bx - ax) * (s / d), ay + (by - ay) * (s / d),
                     celkem + s]);
        s += KROK_M;
      }
      zbytek = s - d;
      celkem += d;
    }
    const posledni = cara[cara.length - 1];
    vzorky.push([posledni[0], posledni[1], celkem]);

    const vysky = [];
    for (const [lng, lat] of vzorky) {
      if (signal.aborted) return;
      vysky.push(await vyska(lng, lat));
    }
    let stoupani = 0, klesani = 0, kotva = vysky[0];
    for (let i = 1; i < vysky.length; i++) {
      if (vysky[i] === null || kotva === null) { kotva = vysky[i]; continue; }
      const roz = vysky[i] - kotva;
      if (roz > HYSTEREZE_M) { stoupani += roz; kotva = vysky[i]; }
      else if (roz < -HYSTEREZE_M) { klesani -= roz; kotva = vysky[i]; }
    }
    profil = { vzdal: vzorky.map(v => v[2]), vyska: vysky,
               stoupani, klesani, delkaKm: celkem / 1000 };
    el('nav-info').textContent =
      `${profil.delkaKm.toFixed(1)} km · ↑ ${Math.round(stoupani)} m `
      + `· ↓ ${Math.round(klesani)} m (výšky: DMR 5G)`;
    kresliGraf();
  }

  function kresliGraf() {
    const c = el('nav-graf');
    if (!c || !profil) return;
    c.style.display = 'block';
    const sirka = c.width = c.clientWidth * devicePixelRatio;
    const vyskaC = c.height = c.clientHeight * devicePixelRatio;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, sirka, vyskaC);
    const platne = profil.vyska.filter(v => v !== null);
    if (!platne.length) return;
    const min = Math.min(...platne), max = Math.max(...platne);
    const rozsah = Math.max(50, max - min);
    const X = i => profil.vzdal[i] / profil.vzdal[profil.vzdal.length - 1]
      * (sirka - 8) + 4;
    const Y = v => vyskaC - 6 - (v - min) / rozsah * (vyskaC - 26);
    ctx.beginPath();
    ctx.moveTo(X(0), vyskaC);
    profil.vyska.forEach((v, i) => { if (v !== null) ctx.lineTo(X(i), Y(v)); });
    ctx.lineTo(X(profil.vyska.length - 1), vyskaC);
    ctx.closePath();
    ctx.fillStyle = 'rgba(46,125,91,0.35)';
    ctx.fill();
    ctx.beginPath();
    profil.vyska.forEach((v, i) => {
      if (v === null) return;
      if (i === 0) ctx.moveTo(X(i), Y(v)); else ctx.lineTo(X(i), Y(v));
    });
    ctx.strokeStyle = '#2E7D5B';
    ctx.lineWidth = 2 * devicePixelRatio;
    ctx.stroke();
    ctx.fillStyle = '#0D2B2E';
    ctx.font = `${11 * devicePixelRatio}px sans-serif`;
    ctx.fillText(`${Math.round(max)} m`, 6, 12 * devicePixelRatio);
    ctx.fillText(`${Math.round(min)} m`, 6, vyskaC - 8);
  }

  // ------------------------------------------------------------------ prolet
  function azimut(a, b) {
    const fi1 = a[1] * Math.PI / 180, fi2 = b[1] * Math.PI / 180;
    const dl = (b[0] - a[0]) * Math.PI / 180;
    const y = Math.sin(dl) * Math.cos(fi2);
    const x = Math.cos(fi1) * Math.sin(fi2)
      - Math.sin(fi1) * Math.cos(fi2) * Math.cos(dl);
    return Math.atan2(y, x) * 180 / Math.PI;
  }

  function prolet() {
    if (!trasa) return;
    const cara = trasa.features[0].geometry.coordinates;
    const kroky = Math.min(14, Math.max(4, Math.floor(cara.length / 40)));
    const body2 = [];
    for (let i = 0; i < kroky; i++) {
      body2.push(cara[Math.floor(i / (kroky - 1) * (cara.length - 1))]);
    }
    let i = 0;
    function dalsi() {
      if (i >= body2.length) return;
      const bod = body2[i];
      const dalsiBod = body2[Math.min(i + 1, body2.length - 1)];
      mapa.easeTo({ center: [bod[0], bod[1]], zoom: 13.6, pitch: 68,
                    bearing: azimut(bod, dalsiBod), duration: 2400,
                    easing: t => t });
      i++;
      if (i < body2.length) setTimeout(dalsi, 2300);
    }
    mapa.flyTo({ center: [body2[0][0], body2[0][1]], zoom: 13.2, pitch: 60,
                 duration: 1800, essential: true });
    setTimeout(dalsi, 1900);
  }

  return { init, obnovVrstvy, aktivni, zrus };
})();
