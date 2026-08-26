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

function barvaTymu() {
  var v = ['match', ['get', 't']];
  for (var i = 0; i < tymy.length; i++) {
    v.push(tymy[i].klic, tymy[i].barva);
  }
  v.push('#c9c2b0');
  return v;
}

function pridejVrstvy() {
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
  mapa.addLayer({
    id: 'vlajky-body', type: 'circle', source: 'body',
    paint: {
      'circle-color': ['case', ['==', ['get', 't'], '0'],
        '#7d7668', barvaTymu()],
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        7, 1.6, 10, 3, 13, 5],
      'circle-stroke-color': '#f7f4ec',
      'circle-stroke-width': 1,
      'circle-opacity': 0.9,
    },
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
  mapa.on('mouseenter', 'vlajky-body', function () {
    mapa.getCanvas().style.cursor = 'pointer';
  });
  mapa.on('mouseleave', 'vlajky-body', function () {
    mapa.getCanvas().style.cursor = '';
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
    r.appendChild(jm);
    r.appendChild(body);
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
  Promise.all([
    fetch('data/tymy.json?v=10').then(function (r) { return r.json(); }),
    fetch('data/vlajky_oblasti.json?v=10').then(function (r) { return r.json(); }),
    fetch('data/kraje.json?v=9').then(function (r) { return r.json(); }),
    fetch('data/vlajky.json').then(function (r) { return r.json(); }),
  ]).then(function (vysledky) {
    tymy = vysledky[0].tymy;
    oblasti = vysledky[1];
    kraje = vysledky[2];
    vlajky = vysledky[3].vlajky;
    body = {
      type: 'FeatureCollection',
      features: vlajky.map(function (v, i) {
        return { type: 'Feature', id: i,
          properties: { n: v.n, h: v.h, t: '0' },
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
    });
    mapa.addControl(new maplibregl.NavigationControl({
      showCompass: false }), 'top-right');
    mapa.addControl(new maplibregl.FullscreenControl(), 'top-right');
    mapa.addControl(new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      showUserLocation: true,
    }), 'top-right');
    mapa.on('load', function () {
      pridejVrstvy();
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
