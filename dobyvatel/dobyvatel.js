/* =====================================================================
   DOBYVATEL – mapa soutěže (okolnik.cz/dobyvatel)

   Kreslí Voroného území všech vlajek (data/vlajky_oblasti.json,
   generuje tools/gen_vlajky.py — POŘADÍ VLAJEK JE SMLOUVA, feature id
   = index vlajky) a barví je podle snímku stavu ze serveru. Snímek je
   JEDEN dokument (stav 19 000 vlajek = bajt na vlajku, base64) —
   stejné balení čte aplikace i rozhodčí (functions/baleni.py).

   Bez publikovaných pravidel v4 (veřejné čtení) vrátí snímek 403 —
   stránka pak ukáže mapu neutrálně a hlásí „soutěž se připravuje".
   ================================================================== */
'use strict';

var PROJEKT = 'sarcher-b32a1';
// týž webový klíč jako žebříček (omezený na okolnik.cz, jen Firestore
// + Identity Toolkit + Token Service)
var KLIC = 'AIzaSyB3sj8qS-Lh4lHow6AUrWH-JayEtJ70igQ';
var SOUTEZ = 'cesko-2026';
// AdSense: po schválení účtu sem přijde client id (ca-pub-…);
// prázdné = plochy se schovají. Premium hráči reklamy nevidí vůbec.
var ADSENSE_CLIENT = '';
var SNIMEK_URL = 'https://firestore.googleapis.com/v1/projects/'
  + PROJEKT + '/databases/(default)/documents/souteze/' + SOUTEZ
  + '/stav/snimek?key=' + KLIC;

function el(id) { return document.getElementById(id); }

/* Firestore JSON → obyčejná hodnota (jen typy, které snímek nosí). */
function cti(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) {
    var m = {};
    var f = v.mapValue.fields || {};
    for (var k in f) m[k] = cti(f[k]);
    return m;
  }
  if ('arrayValue' in v) {
    return (v.arrayValue.values || []).map(cti);
  }
  return null;
}

/* base64 držitelů → pole klíčů týmů ('' = neutrální). */
function rozbalDrzitele(b64, poradi) {
  var bin = atob(b64);
  var ven = new Array(bin.length);
  for (var i = 0; i < bin.length; i++) {
    var b = bin.charCodeAt(i);
    ven[i] = b === 0 ? '' : (poradi[b - 1] || '');
  }
  return ven;
}

var mapa = null;
var tymy = [];
var oblasti = null;
var kraje = null;
var vlajky = [];      // [{n, h, lat, lon}] dle indexu (jména oblastí)
var body = null;      // FeatureCollection bodů vlajek
var obrys = null;     // maska ztlumení okolí + čára hranice ČR
var IKONA_DRUHU = {castles:1,peaks:1,towers:1,caves:1,waterfalls:1,
  rocks:1,viewpoints:1,archaeology:1,mines:1,fortifications:1,
  memorial_trees:1,propasti:1,jezera:1,prameny:1};

function barvaTymu() {
  var v = ['match', ['get', 't']];
  for (var i = 0; i < tymy.length; i++) {
    v.push(tymy[i].klic, tymy[i].barva);
  }
  v.push('#c9c2b0');
  return v;
}

function nahrajIkony() {
  return Promise.all(Object.keys(IKONA_DRUHU).map(function (kat) {
    return fetch('data/ikonky/' + kat + '.webp?v=19')
      .then(function (r) { return r.blob(); })
      .then(function (b) { return createImageBitmap(b); })
      .then(function (bmp) {
        if (!mapa.hasImage('ik-' + kat)) {
          mapa.addImage('ik-' + kat, bmp, { pixelRatio: 1 });
        }
      }).catch(function () { /* bez ikonky zůstane tečka */ });
  }));
}

function pridejVrstvy() {
  // ztlumené okolí ČR + zřetelná hranice (přání 27. 8.)
  mapa.addSource('obrys', { type: 'geojson', data: obrys });
  mapa.addLayer({
    id: 'ztlumeni', type: 'fill', source: 'obrys',
    filter: ['==', '$type', 'Polygon'],
    paint: { 'fill-color': '#e9e4d6', 'fill-opacity': 0.82 },
  });
  mapa.addLayer({
    id: 'obrys-cr', type: 'line', source: 'obrys',
    filter: ['==', '$type', 'LineString'],
    paint: { 'line-color': '#43413a', 'line-width': 1.8,
             'line-opacity': 0.85 },
  });
  mapa.addSource('oblasti', { type: 'geojson', data: oblasti });
  mapa.addLayer({
    id: 'uzemi', type: 'fill', source: 'oblasti',
    paint: {
      'fill-antialias': false,
      'fill-color': barvaTymu(),
      // neutrální jemně podle hodnoty vlajky (jako náhledy z generátoru)
      'fill-opacity': ['case', ['==', ['get', 't'], '0'],
        ['match', ['get', 'h'], 4, 0.30, 3, 0.20, 2, 0.12, 0.07],
        0.62],
    },
  });
  mapa.addSource('kraje', { type: 'geojson', data: kraje });
  mapa.addLayer({
    id: 'kraje', type: 'line', source: 'kraje',
    paint: { 'line-color': '#5f574a', 'line-width': 1.5,
             'line-opacity': 0.7 },
  });
  mapa.addLayer({
    id: 'hranice', type: 'line', source: 'oblasti',
    paint: {
      'line-color': ['case', ['==', ['get', 't'], '0'],
        '#a89f8a', barvaTymu()],
      'line-opacity': ['case', ['==', ['get', 't'], '0'], 0.35, 0.9],
      'line-width': ['case', ['==', ['get', 't'], '0'], 0.4, 1.2],
    },
  });
  // body vlajek: tečka v barvě držitele (neutrální hnědošedá) — a od
  // přiblížení jméno vlajky = jméno oblasti
  mapa.addSource('body', { type: 'geojson', data: body });

  // malované značky podle druhu místa (hrad, vrchol, jeskyně…);
  // kolize je řídí samy — zblízka jich přibývá
  // postupné odkrývání jako na běžných mapách (přání 27. 8.):
  // zdaleka jen hrady (4 b.), přibližováním přibývají další druhy;
  // hustotu v pásmu řídí kolize symbolů
  [[4, 6], [3, 9.2], [2, 10.8], [1, 12]].forEach(function (p) {
    mapa.addLayer({
      id: 'vlajky-ik' + p[0], type: 'symbol', source: 'body',
      minzoom: p[1],
      filter: ['==', ['get', 'h'], p[0]],
      layout: {
        'icon-image': ['concat', 'ik-', ['get', 'k']],
        'icon-size': ['interpolate', ['linear'], ['zoom'],
          6, 0.48, 10, 0.7, 13, 0.92],
        // velký kolizní polštář zdaleka = řídká, klidná mapa
        'icon-padding': ['interpolate', ['linear'], ['zoom'],
          6, 26, 9, 14, 12, 4],
      },
      paint: { 'icon-opacity': 0.92 },
    });
  });
  mapa.addLayer({
    id: 'vlajky-jmena', type: 'symbol', source: 'body', minzoom: 10.2,
    layout: {
      'text-field': ['get', 'n'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'text-offset': [0, 0.9],
      'text-anchor': 'top',
      'text-max-width': 9,
    },
    paint: {
      'text-color': '#4a443a',
      'text-halo-color': '#f2efe6',
      'text-halo-width': 1.3,
    },
  });

  // klik kamkoli do území → bublina se jménem, hodnotou a držitelem
  mapa.on('click', 'uzemi', function (e) {
    var f = e.features && e.features[0];
    if (!f || f.id === undefined) return;
    var v = vlajky[f.id];
    if (!v) return;
    var drzitel = (f.properties && f.properties.t) || '0';
    var obal = document.createElement('div');
    var jm = document.createElement('strong');
    jm.textContent = v.n;
    obal.appendChild(jm);
    obal.appendChild(document.createElement('br'));
    obal.appendChild(document.createTextNode(
        v.h + ' b. · ' + (drzitel === '0'
            ? 'neutrální'
            : 'drží ' + jmenoTymu(drzitel) + ' kraj')));
    new maplibregl.Popup({ closeButton: false, maxWidth: '260px' })
      .setLngLat([v.lon, v.lat])
      .setDOMContent(obal)
      .addTo(mapa);
  });
  ['vlajky-ik4', 'vlajky-ik3', 'vlajky-ik2', 'vlajky-ik1']
    .forEach(function (id) {
      mapa.on('mouseenter', id, function () {
        mapa.getCanvas().style.cursor = 'pointer';
      });
      mapa.on('mouseleave', id, function () {
        mapa.getCanvas().style.cursor = '';
      });
    });
}

function obarvi(drzitele) {
  for (var i = 0; i < oblasti.features.length; i++) {
    var f = oblasti.features[i];
    f.properties.t = (drzitele && drzitele[f.id]) || '0';
  }
  for (var j = 0; j < body.features.length; j++) {
    body.features[j].properties.t = (drzitele && drzitele[j]) || '0';
  }
  var zdroj = mapa.getSource('oblasti');
  if (zdroj) zdroj.setData(oblasti);
  var zdrojB = mapa.getSource('body');
  if (zdrojB) zdrojB.setData(body);
}

function vypisSkore(skore) {
  var tab = el('skore');
  var radky = tymy.map(function (t) {
    return { t: t, body: (skore && skore[t.klic]) || 0 };
  }).sort(function (a, b) { return b.body - a.body; });
  // procenta = podíl na dobytí CELÉ republiky (součet hodnot všech
  // vlajek), přání 27. 8.
  var suma = 0;
  for (var v = 0; v < vlajky.length; v++) suma += vlajky[v].h || 0;
  for (var i = 0; i < radky.length; i++) {
    var r = document.createElement('tr');
    var jm = document.createElement('td');
    var z = document.createElement('img');
    z.className = 'znak';
    z.src = 'data/' + radky[i].t.znak;
    z.alt = '';
    var tecka = document.createElement('span');
    tecka.className = 'tecka';
    tecka.style.background = radky[i].t.barva;
    jm.appendChild(z);
    jm.appendChild(tecka);
    jm.appendChild(document.createTextNode(radky[i].t.kratky));
    var body = document.createElement('td');
    body.className = 'body';
    body.textContent = String(radky[i].body);
    var pct = document.createElement('td');
    pct.className = 'body';
    pct.textContent = suma > 0
      ? (100 * radky[i].body / suma).toFixed(2) + ' %'
      : '—';
    r.appendChild(jm);
    r.appendChild(body);
    r.appendChild(pct);
    tab.appendChild(r);
  }
}

function jmenoTymu(klic) {
  for (var i = 0; i < tymy.length; i++) {
    if (tymy[i].klic === klic) return tymy[i].kratky;
  }
  return klic;
}

function nazevKraje(klic) {
  for (var i = 0; i < tymy.length; i++) {
    if (tymy[i].klic === klic) return tymy[i].nazev;
  }
  return klic;
}

function vypisDobyto(dobyto) {
  var kraje2 = dobyto.kraje || {};
  var kusy = [];
  for (var k in kraje2) {
    kusy.push(nazevKraje(k) + ' drží ' + jmenoTymu(kraje2[k]));
  }
  el('dobyto').textContent = kusy.length
    ? 'Dobyté kraje: ' + kusy.join(' · ')
    : 'Žádný kraj zatím není dobytý celý.';
}

/* Přihlášení sdílené s Můj Okolník (localStorage okolnikUcet1). */
function nactiRelaci() {
  try {
    var s = localStorage.getItem('okolnikUcet1');
    return s ? JSON.parse(s) : null;
  } catch (e) { return null; }
}

function ctiDoc(url, token) {
  var hlavicky = token ? { Authorization: 'Bearer ' + token } : {};
  return fetch(url, { headers: hlavicky }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(function (doc) {
    var d = {};
    var f = doc.fields || {};
    for (var k in f) d[k] = cti(f[k]);
    return d;
  });
}

var ZAKLAD_DOK = 'https://firestore.googleapis.com/v1/projects/'
  + PROJEKT + '/databases/(default)/documents/';

function mojeSouteze() {
  var box = el('mojeObsah');
  var relace = nactiRelaci();
  if (!relace || !relace.uid) {
    box.textContent = '';
    var odkaz = document.createElement('a');
    odkaz.href = '/ucet/';
    odkaz.textContent = 'Přihlaste se na Můj Okolník';
    box.appendChild(odkaz);
    box.appendChild(document.createTextNode(
        ' — uvidíte tu svůj tým a soutěže, kterých se účastníte.'));
    return;
  }
  ctiDoc(ZAKLAD_DOK + 'clenstvi/' + relace.uid + '_' + SOUTEZ
      + '?key=' + KLIC, relace.idToken).then(function (c) {
    box.textContent = 'Česko 2026 — hraješ za tým '
      + jmenoTymu(c.tym) + '.';
  }).catch(function () {
    box.textContent = 'Zatím nejsi v žádné soutěži. Otevři v aplikaci '
      + 'režim Dobyvatel a tým dostaneš podle svého kraje.';
  });
}

function stavSouteze() {
  ctiDoc(ZAKLAD_DOK + 'souteze/' + SOUTEZ + '?key=' + KLIC)
    .then(function (d) {
      var st = el('stavSouteze');
      if (d.stav === 'bezi') {
        st.textContent = 'právě běží';
      } else {
        st.textContent = 'připravuje se';
        st.className = 'stitek sedy';
      }
    }).catch(function () {
      el('stavSouteze').textContent = 'připravuje se';
      el('stavSouteze').className = 'stitek sedy';
    });
}

/* Žebříček hráčů: zásluhy ze stav/hraci + přezdívky ze žebříčku. */
function zebricekHracu() {
  Promise.all([
    ctiDoc(ZAKLAD_DOK + 'souteze/' + SOUTEZ + '/stav/hraci?key=' + KLIC)
      .catch(function () { return null; }),
    fetch(ZAKLAD_DOK + 'zebricek?pageSize=300&key=' + KLIC)
      .then(function (r) { return r.json(); })
      .catch(function () { return {}; }),
  ]).then(function (v) {
    var hraci = v[0] && v[0].json ? JSON.parse(v[0].json) : {};
    var jmena = {};
    (v[1].documents || []).forEach(function (doc) {
      var f = doc.fields || {};
      var uid = f.hrac && f.hrac.stringValue;
      var jm = f.prezdivka && f.prezdivka.stringValue;
      if (uid && jm) jmena[uid] = jm;
    });
    var radky = Object.keys(hraci).map(function (uid) {
      return { uid: uid, z: hraci[uid].z || 0, b: hraci[uid].b || 0 };
    }).sort(function (a, b) { return b.b - a.b || b.z - a.z; })
      .slice(0, 20);
    var tab = el('hraci');
    if (!radky.length) {
      var r0 = document.createElement('tr');
      var t0 = document.createElement('td');
      t0.colSpan = 4;
      t0.textContent = 'Zatím nikdo nic nezabral — buď první.';
      r0.appendChild(t0);
      tab.appendChild(r0);
      return;
    }
    radky.forEach(function (h, i) {
      var r = document.createElement('tr');
      [String(i + 1) + '.',
       jmena[h.uid] || 'dobyvatel bez přezdívky',
       String(h.z), String(h.b)].forEach(function (text, j) {
        var td = document.createElement('td');
        td.textContent = text;
        if (j >= 2) td.className = 'body';
        r.appendChild(td);
      });
      tab.appendChild(r);
    });
  });
}

/* Reklamy: bez AdSense id nebo s Premium se plochy schovají. */
function reklamy() {
  var plochy = document.querySelectorAll('[data-reklama]');
  function schovej() {
    plochy.forEach(function (p) { p.remove(); });
  }
  if (!ADSENSE_CLIENT) { schovej(); return; }
  var relace = nactiRelaci();
  var rozhodni = Promise.resolve(false);
  if (relace && relace.uid && relace.idToken) {
    rozhodni = ctiDoc(ZAKLAD_DOK + 'hraci/' + relace.uid
        + '?key=' + KLIC, relace.idToken)
      .then(function (d) { return d.premium === true; })
      .catch(function () { return false; });
  }
  rozhodni.then(function (premium) {
    if (premium) { schovej(); return; }
    var sk = document.createElement('script');
    sk.async = true;
    sk.src = 'https://pagead2.googlesyndication.com/pagead/js/'
      + 'adsbygoogle.js?client=' + ADSENSE_CLIENT;
    sk.crossOrigin = 'anonymous';
    document.head.appendChild(sk);
    plochy.forEach(function (p) {
      p.textContent = '';
      var ins = document.createElement('ins');
      ins.className = 'adsbygoogle';
      ins.style.display = 'block';
      ins.setAttribute('data-ad-client', ADSENSE_CLIENT);
      ins.setAttribute('data-ad-format', 'auto');
      ins.setAttribute('data-full-width-responsive', 'true');
      p.appendChild(ins);
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    });
  });
}

var POPISKY_DRUHU = {
  castles: 'Hrad, zámek, tvrz', peaks: 'Vrchol',
  towers: 'Rozhledna, věž', caves: 'Jeskyně', waterfalls: 'Vodopád',
  rocks: 'Skála', viewpoints: 'Vyhlídka', archaeology: 'Hradiště',
  mines: 'Štola, důl', fortifications: 'Bunkr',
  memorial_trees: 'Památný strom', jezera: 'Jezero',
  prameny: 'Pramen řeky', propasti: 'Propast',
};

function pridejLegendu() {
  var obal = document.getElementById('mapa');
  var tl = document.createElement('button');
  tl.textContent = 'Legenda';
  tl.style.cssText = 'position:absolute;left:10px;top:10px;z-index:5;'
    + 'padding:5px 10px;border-radius:8px;border:1px solid #b9b2a0;'
    + 'background:#fffdf6;font:600 12.5px sans-serif;cursor:pointer;';
  var panel = document.createElement('div');
  panel.style.cssText = 'position:absolute;left:10px;top:44px;'
    + 'z-index:5;background:#fffdf6;border:1px solid #b9b2a0;'
    + 'border-radius:10px;padding:8px 12px;display:none;'
    + 'max-height:70%;overflow:auto;font:12.5px sans-serif;'
    + 'box-shadow:0 2px 8px rgba(0,0,0,.15);';
  for (var kat in POPISKY_DRUHU) {
    var radek = document.createElement('div');
    radek.style.cssText =
      'display:flex;align-items:center;gap:8px;margin:3px 0;';
    var im = document.createElement('img');
    im.src = 'data/ikonky/' + kat + '.webp?v=19';
    im.width = 18;
    im.height = 18;
    im.alt = '';
    radek.appendChild(im);
    radek.appendChild(
        document.createTextNode(POPISKY_DRUHU[kat]));
    panel.appendChild(radek);
  }
  var pozn = document.createElement('div');
  pozn.style.cssText = 'margin-top:6px;color:#6b6455;';
  pozn.textContent = 'Zdaleka jsou vidět jen hrady — přibližováním '
    + 'přibývají další druhy. Barva území = tým, který je drží.';
  panel.appendChild(pozn);
  var klic = 'dobyvatelLegenda';
  var schovana = false;
  try { schovana = localStorage.getItem(klic) === 'ne'; }
  catch (e) { }
  panel.style.display = schovana ? 'none' : 'block';
  tl.onclick = function () {
    var skryt = panel.style.display !== 'none';
    panel.style.display = skryt ? 'none' : 'block';
    try { localStorage.setItem(klic, skryt ? 'ne' : 'ano'); }
    catch (e) { }
  };
  obal.style.position = 'relative';
  obal.appendChild(tl);
  obal.appendChild(panel);
}

function nactiSnimek() {
  return fetch(SNIMEK_URL).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(function (doc) {
    var d = {};
    var f = doc.fields || {};
    for (var k in f) d[k] = cti(f[k]);
    return d;
  });
}

function start() {
  stavSouteze();
  mojeSouteze();
  zebricekHracu();
  reklamy();
  Promise.all([
    fetch('data/tymy.json?v=10').then(function (r) { return r.json(); }),
    fetch('data/vlajky_oblasti.json?v=10').then(function (r) { return r.json(); }),
    fetch('data/kraje.json?v=11').then(function (r) { return r.json(); }),
    fetch('data/vlajky.json').then(function (r) { return r.json(); }),
    fetch('data/obrys.json?v=14').then(function (r) { return r.json(); }),
  ]).then(function (vysledky) {
    obrys = vysledky[4];
    tymy = vysledky[0].tymy;
    oblasti = vysledky[1];
    kraje = vysledky[2];
    vlajky = vysledky[3].vlajky;
    body = {
      type: 'FeatureCollection',
      features: vlajky.map(function (v, i) {
        return { type: 'Feature', id: i,
          properties: { n: v.n, h: v.h, t: '0', k: v.k },
          geometry: { type: 'Point', coordinates: [v.lon, v.lat] } };
      }),
    };
    for (var i = 0; i < oblasti.features.length; i++) {
      oblasti.features[i].properties.t = '0';
    }
    mapa = new maplibregl.Map({
      container: 'mapa',
      // vlastní čistý podklad — území jsou hlavní obsah (Liberty
      // podklad je přebíjel, výtka 26. 8. večer)
      style: { version: 8,
        glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
        sources: {
          teren: {
            type: 'raster-dem',
            tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/'
              + 'terrarium/{z}/{x}/{y}.png'],
            encoding: 'terrarium',
            tileSize: 256,
            maxzoom: 14,
            attribution: 'Terén: Mapzen / AWS Open Data',
          },
        },
        layers: [{
          id: 'pozadi', type: 'background',
          paint: { 'background-color': '#f2efe6' },
        }, {
          id: 'stinovani', type: 'hillshade', source: 'teren',
          paint: {
            'hillshade-exaggeration': 0.42,
            'hillshade-shadow-color': '#8f8271',
            'hillshade-highlight-color': '#fffdf6',
          },
        }] },
      bounds: [[12.05, 48.5], [18.9, 51.1]],
      fitBoundsOptions: { padding: 12 },
      // jen ČR — mapa je jen pro republiku (přání 27. 8.)
      maxBounds: [[11.6, 48.2], [19.3, 51.4]],
      minZoom: 6,
    });
    mapa.addControl(new maplibregl.NavigationControl({
      showCompass: false }), 'top-right');
    mapa.addControl(new maplibregl.FullscreenControl(), 'top-right');
    // na PC bez GPS je poloha z Wi-Fi/IP (km vedle) → tlačítko jen
    // na dotykových zařízeních (přání 27. 8.)
    if (window.matchMedia
        && window.matchMedia('(pointer: coarse)').matches) {
      mapa.addControl(new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        showUserLocation: true,
      }), 'top-right');
    }
    pridejLegendu();
    mapa.on('load', function () {
      nahrajIkony().then(function () { pridejVrstvy(); });
      nactiSnimek().then(function (s) {
        var poradi = s.tymyPoradi || [];
        var drzitele = s.drzitele
          ? rozbalDrzitele(s.drzitele, poradi) : null;
        obarvi(drzitele);
        vypisSkore(s.skore || {});
        vypisDobyto(s.dobyto || {});
        var kdy = s.ts ? new Date(s.ts) : null;
        el('stav').textContent = 'Stav území k '
          + (kdy ? kdy.toLocaleString('cs-CZ') : 'poslednímu snímku')
          + ' · obsazovat lze v aplikaci Okolník (režim Dobyvatel).';
      }).catch(function () {
        vypisSkore({});
        el('stav').textContent = 'Soutěž se připravuje — mapa zatím '
          + 'ukazuje neutrální území. Obsazovat půjde v aplikaci '
          + 'Okolník (režim Dobyvatel).';
      });
    });
  }).catch(function (e) {
    el('stav').textContent = 'Mapu se nepodařilo načíst ('
      + e.message + ').';
  });
}

start();
