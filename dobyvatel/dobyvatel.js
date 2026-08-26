/* =====================================================================
   DOBYVATEL – mapa války (okolnik.cz/dobyvatel)

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
      'fill-color': barvaTymu(),
      // neutrální jemně podle hodnoty vlajky (jako náhledy z generátoru)
      'fill-opacity': ['case', ['==', ['get', 't'], '0'],
        ['match', ['get', 'h'], 4, 0.30, 3, 0.20, 2, 0.12, 0.07],
        0.62],
    },
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
}

function obarvi(drzitele) {
  for (var i = 0; i < oblasti.features.length; i++) {
    var f = oblasti.features[i];
    f.properties.t = (drzitele && drzitele[f.id]) || '0';
  }
  var zdroj = mapa.getSource('oblasti');
  if (zdroj) zdroj.setData(oblasti);
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
    fetch('data/tymy.json').then(function (r) { return r.json(); }),
    fetch('data/vlajky_oblasti.json').then(function (r) { return r.json(); }),
  ]).then(function (vysledky) {
    tymy = vysledky[0].tymy;
    oblasti = vysledky[1];
    for (var i = 0; i < oblasti.features.length; i++) {
      oblasti.features[i].properties.t = '0';
    }
    mapa = new maplibregl.Map({
      container: 'mapa',
      // prázdný styl — kreslíme jen vlastní území, žádné cizí dlaždice
      style: { version: 8, sources: {}, layers: [{
        id: 'pozadi', type: 'background',
        paint: { 'background-color': '#f2efe6' },
      }] },
      bounds: [[12.05, 48.5], [18.9, 51.1]],
      fitBoundsOptions: { padding: 12 },
      attributionControl: false,
      cooperativeGestures: true,
    });
    mapa.addControl(new maplibregl.NavigationControl({
      showCompass: false }), 'top-right');
    mapa.on('load', function () {
      pridejVrstvy();
      nactiSnimek().then(function (s) {
        var poradi = s.tymyPoradi || [];
        var drzitele = s.drzitele
          ? rozbalDrzitele(s.drzitele, poradi) : null;
        obarvi(drzitele);
        vypisSkore(s.skore || {});
        var kdy = s.ts ? new Date(s.ts) : null;
        el('stav').textContent = 'Stav bojiště k '
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
