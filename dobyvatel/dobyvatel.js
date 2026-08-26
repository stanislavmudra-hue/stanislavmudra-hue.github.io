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
// ?s=<id> přepne celou stránku (mapu, skóre, hráče) na jinou
// soutěž; bez parametru republikové kolo
var SOUTEZ = (function () {
  var s = new URLSearchParams(location.search).get('s') || '';
  return /^[a-z0-9][a-z0-9-]{2,39}$/.test(s) ? s : 'cesko-2026';
})();
var soutezDoc = null;   // dokument soutěže (názvy týmů, zakladatel…)
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

// Bublinky druhů PŘESNĚ jako na neherní mapě v aplikaci (Cestovatel):
// bílý kroužek s barevným prstencem a emoji; emoji a barvy převzaté
// z categories.dart. Kreslí se na canvasu — žádné stahování.
var BUBLINA_DRUHU = {
  castles: ['🏰', '#5D4037'], peaks: ['⛰️', '#4E6E58'],
  towers: ['🗼', '#455A64'], caves: ['🦇', '#4E342E'],
  waterfalls: ['💦', '#0277BD'], rocks: ['🪨', '#6D4C41'],
  viewpoints: ['🔭', '#00695C'], archaeology: ['🏺', '#8D6E63'],
  mines: ['⛏️', '#424242'], fortifications: ['🪖', '#4E342E'],
  memorial_trees: ['🌲', '#2E7D32'], jezera: ['🏞️', '#01579B'],
  prameny: ['💧', '#0288D1'], propasti: ['🕳️', '#37474F'],
};

function nakresliBublinu(emoji, barva) {
  var s = 128;
  var p = document.createElement('canvas');
  p.width = s;
  p.height = s;
  var ctx = p.getContext('2d');
  ctx.beginPath();
  ctx.arc(64, 64, 52, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = barva;
  ctx.stroke();
  ctx.font = '64px "Segoe UI Emoji", "Noto Color Emoji", '
    + '"Apple Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, 64, 70);
  return ctx.getImageData(0, 0, s, s);
}

function nahrajIkony() {
  Object.keys(BUBLINA_DRUHU).forEach(function (kat) {
    if (!mapa.hasImage('ik-' + kat)) {
      var b = BUBLINA_DRUHU[kat];
      mapa.addImage('ik-' + kat, nakresliBublinu(b[0], b[1]),
          { pixelRatio: 2 });
    }
  });
  return Promise.resolve();
}

/* Pásma odkrývání PO DRUZÍCH: v každém druhu se vezme pár nejlepších
   do dálkového pásma (řazeno hodnotou, remíza deterministickým
   promícháním), takže zdaleka není vidět „skoro pořád hrady", ale
   výběr napříč druhy. */
function spocitejPasma() {
  var dleDruhu = {};
  vlajky.forEach(function (v, i) {
    (dleDruhu[v.k] = dleDruhu[v.k] || []).push(i);
  });
  Object.keys(dleDruhu).forEach(function (k) {
    var idx = dleDruhu[k];
    idx.sort(function (a, b) {
      var r = (vlajky[b].h || 1) - (vlajky[a].h || 1);
      if (r) return r;
      return (a * 2654435761 % 97) - (b * 2654435761 % 97) || a - b;
    });
    var n = idx.length;
    // strop kvót: bez něj by obří druhy (vrcholy) zase přebily mapu
    var p4 = Math.min(Math.max(2, Math.round(n * 0.02)), 36);
    var p3 = p4 + Math.min(Math.max(6, Math.round(n * 0.08)), 150);
    var p2 = p3 + Math.round(n * 0.3);
    idx.forEach(function (fi, poradi) {
      body.features[fi].properties.p =
        poradi < p4 ? 4 : poradi < p3 ? 3 : poradi < p2 ? 2 : 1;
    });
  });
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
  // POD stínování terénu (beforeId je 2. argument addLayer!) —
  // jinak výplně území kopce zakryjí a „terén není vidět" (výtka
  // 27. 8.); ztlumení okolí zůstává NAD stínováním, ať za hranicemi
  // kopce nesvítí
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
  }, 'stinovani');
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

  // malované značky z neherní mapy appky; postupné odkrývání řídí
  // pásmo p (kvóty v každém druhu — viz spocitejPasma) a hustotu
  // v pásmu kolizní polštář
  [[4, 6], [3, 9.2], [2, 10.8], [1, 12]].forEach(function (p) {
    mapa.addLayer({
      id: 'vlajky-ik' + p[0], type: 'symbol', source: 'body',
      minzoom: p[1],
      filter: ['==', ['get', 'p'], p[0]],
      layout: {
        'icon-image': ['concat', 'ik-', ['get', 'k']],
        'icon-size': ['interpolate', ['linear'], ['zoom'],
          6, 0.4, 10, 0.52, 13, 0.66],
        // velký kolizní polštář zdaleka = řídká, klidná mapa
        'icon-padding': ['interpolate', ['linear'], ['zoom'],
          6, 26, 9, 14, 12, 4],
      },
      paint: { 'icon-opacity': 1 },
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
  while (tab.rows.length > 1) tab.deleteRow(1);
  // vlastní soutěž hraje jen vybrané týmy (tymyPoradi)
  var sada = tymy;
  if (soutezDoc && soutezDoc.tymyPoradi
      && soutezDoc.tymyPoradi.length) {
    sada = tymy.filter(function (t) {
      return soutezDoc.tymyPoradi.indexOf(t.klic) >= 0;
    });
  }
  var radky = sada.map(function (t) {
    return { t: t, body: (skore && skore[t.klic]) || 0 };
  }).sort(function (a, b) { return b.body - a.body; });
  // procenta = podíl na dobytí CELÉ republiky (součet hodnot všech
  // vlajek), přání 27. 8.
  var suma = 0;
  for (var v = 0; v < vlajky.length; v++) suma += vlajky[v].h || 0;
  for (var i = 0; i < radky.length; i++) {
    var r = document.createElement('tr');
    var jm = document.createElement('td');
    if (!vlastniSoutez()) {
      var z = document.createElement('img');
      z.className = 'znak';
      z.src = 'data/' + radky[i].t.znak;
      z.alt = '';
      jm.appendChild(z);
    }
    var tecka = document.createElement('span');
    tecka.className = 'tecka';
    tecka.style.background = radky[i].t.barva;
    jm.appendChild(tecka);
    jm.appendChild(document.createTextNode(
        jmenoTymu(radky[i].t.klic)));
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
  if (soutezDoc && soutezDoc.tymyNazvy && soutezDoc.tymyNazvy[klic]) {
    return soutezDoc.tymyNazvy[klic];
  }
  for (var i = 0; i < tymy.length; i++) {
    if (tymy[i].klic === klic) return tymy[i].kratky;
  }
  return klic;
}

function vlastniSoutez() {
  return SOUTEZ !== 'cesko-2026';
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

/* Obyčejná hodnota → Firestore JSON (zrcadlo cti()). */
function ven(v) {
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return (v % 1 === 0) ? { integerValue: String(v) }
                         : { doubleValue: v };
  }
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(ven) } };
  }
  if (v && typeof v === 'object') {
    var f = {};
    for (var k in v) f[k] = ven(v[k]);
    return { mapValue: { fields: f } };
  }
  return { stringValue: String(v) };
}

/* Platný idToken jako na /ucet/: hodinové tokeny se před zápisem
   obnoví přes refreshToken a uloží zpět. */
function platnyToken() {
  var r = nactiRelaci();
  if (!r) return Promise.reject(new Error('bez přihlášení'));
  if (r.idToken && r.vyprsi > Date.now() + 60000) {
    return Promise.resolve(r.idToken);
  }
  return fetch('https://securetoken.googleapis.com/v1/token?key='
      + KLIC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=refresh_token&refresh_token='
      + encodeURIComponent(r.refreshToken),
  }).then(function (o) { return o.json(); }).then(function (d) {
    if (!d.id_token) throw new Error('obnova tokenu selhala');
    r.idToken = d.id_token;
    r.refreshToken = d.refresh_token || r.refreshToken;
    r.vyprsi = Date.now() + (parseInt(d.expires_in, 10) || 3600) * 1000;
    try { localStorage.setItem('okolnikUcet1', JSON.stringify(r)); }
    catch (e) { }
    return r.idToken;
  });
}

/* PATCH dokumentu s updateMask (bez masky by PŘEPSAL celý dokument).
   `jenNovy` = precondition exists=false (založení). */
function zapisDoc(cesta, data, jenNovy) {
  return platnyToken().then(function (token) {
    var url = ZAKLAD_DOK + cesta + '?key=' + KLIC;
    for (var k in data) url += '&updateMask.fieldPaths=' + k;
    if (jenNovy) url += '&currentDocument.exists=false';
    var f = {};
    for (var k2 in data) f[k2] = ven(data[k2]);
    return fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json',
                 Authorization: 'Bearer ' + token },
      body: JSON.stringify({ fields: f }),
    });
  }).then(function (o) {
    if (!o.ok) throw new Error('HTTP ' + o.status);
    return true;
  });
}

/* runQuery: kolekce WHERE pole == hodnota (rovnost stačí všude tady). */
function dotaz(kolekce, pole, hodnota, token) {
  var telo = { structuredQuery: {
    from: [{ collectionId: kolekce }],
    where: { fieldFilter: { field: { fieldPath: pole }, op: 'EQUAL',
      value: { stringValue: hodnota } } },
    limit: 200,
  } };
  if (typeof hodnota === 'boolean') {
    telo.structuredQuery.where.fieldFilter.value =
      { booleanValue: hodnota };
  }
  var hlavicky = { 'Content-Type': 'application/json' };
  if (token) hlavicky.Authorization = 'Bearer ' + token;
  return fetch(ZAKLAD_DOK.slice(0, -1) + ':runQuery?key=' + KLIC, {
    method: 'POST', headers: hlavicky, body: JSON.stringify(telo),
  }).then(function (o) { return o.json(); }).then(function (vysl) {
    var ven2 = [];
    (vysl || []).forEach(function (radek) {
      if (!radek.document) return;
      var d = {};
      var f = radek.document.fields || {};
      for (var k in f) d[k] = cti(f[k]);
      d._id = radek.document.name.split('/').pop();
      ven2.push(d);
    });
    return ven2;
  });
}

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
  platnyToken().then(function (token) {
    return Promise.all([
      // založené mnou
      dotaz('souteze', 'zakladatel', relace.uid, token),
      // členství v republikovém kole
      ctiDoc(ZAKLAD_DOK + 'clenstvi/' + relace.uid + '_cesko-2026'
        + '?key=' + KLIC, token).catch(function () { return null; }),
      // členství ve veřejných soutěžích (po jedné — je jich málo)
      dotaz('souteze', 'verejna', true).then(function (vs) {
        return Promise.all(vs.filter(function (s2) {
          return s2._id !== 'cesko-2026';
        }).map(function (s2) {
          return ctiDoc(ZAKLAD_DOK + 'clenstvi/' + relace.uid + '_'
              + s2._id + '?key=' + KLIC, token)
            .then(function (c) { return { s: s2, c: c }; })
            .catch(function () { return null; });
        }));
      }),
    ]);
  }).then(function (v) {
    box.textContent = '';
    var radky = [];
    if (v[1]) {
      radky.push(['cesko-2026', 'Česko 2026 — hraješ za tým '
        + jmenoTymu(v[1].tym) + '.']);
    }
    v[2].filter(Boolean).forEach(function (p) {
      radky.push([p.s._id, (p.s.nazev || p.s._id) + ' — tým '
        + ((p.s.tymyNazvy || {})[p.c.tym] || jmenoTymu(p.c.tym))
        + '.']);
    });
    v[0].forEach(function (s2) {
      radky.push([s2._id, (s2.nazev || s2._id) + ' — jsi správce ('
        + (s2.stav === 'bezi' ? 'běží' : s2.stav) + ').']);
    });
    if (!radky.length) {
      box.textContent = 'Zatím nejsi v žádné soutěži. Otevři '
        + 'v aplikaci režim Dobyvatel, nebo si soutěž založ vedle.';
      return;
    }
    radky.forEach(function (r) {
      var p = document.createElement('p');
      p.style.margin = '4px 0';
      var a = document.createElement('a');
      a.href = '?s=' + r[0];
      a.textContent = r[1];
      p.appendChild(a);
      box.appendChild(p);
    });
  }).catch(function () {
    box.textContent = 'Soutěže se nepodařilo načíst — zkuste to '
      + 'za chvíli.';
  });
}

/* Seznam veřejných dobývání (odkazy na mapy soutěží). */
function verejneSouteze() {
  var box = el('verejneBox');
  if (!box) return;
  dotaz('souteze', 'verejna', true).then(function (vs) {
    var ziva = vs.filter(function (s2) {
      return s2._id !== 'cesko-2026' && s2.stav !== 'konec';
    });
    if (!ziva.length) return;
    var nadpis = document.createElement('p');
    nadpis.style.cssText = 'margin:10px 0 2px;font-weight:700;';
    nadpis.textContent = 'Veřejná dobývání:';
    box.appendChild(nadpis);
    ziva.forEach(function (s2) {
      var p = document.createElement('p');
      p.style.margin = '3px 0';
      var a = document.createElement('a');
      a.href = '?s=' + s2._id;
      a.textContent = (s2.nazev || s2._id)
        + (s2.stav === 'bezi' ? ' (běží)' : ' (příprava)');
      p.appendChild(a);
      box.appendChild(p);
    });
  }).catch(function () { });
}

function stavSouteze() {
  ctiDoc(ZAKLAD_DOK + 'souteze/' + SOUTEZ + '?key=' + KLIC)
    .then(function (d) {
      soutezDoc = d;
      var st = el('stavSouteze');
      if (d.stav === 'bezi') {
        st.textContent = 'právě běží';
      } else if (d.stav === 'konec') {
        st.textContent = 'skončila';
        st.className = 'stitek sedy';
      } else {
        st.textContent = 'připravuje se';
        st.className = 'stitek sedy';
      }
      if (vlastniSoutez()) {
        document.title = (d.nazev || SOUTEZ) + ' – Dobyvatel';
        var h1 = document.querySelector('main h1');
        if (h1) h1.textContent = 'Dobyvatel — ' + (d.nazev || SOUTEZ);
        el('soutezNazev').textContent = d.nazev || SOUTEZ;
        var pocet = (d.tymyPoradi || []).length;
        el('soutezPopis').textContent = 'Vlastní dobývání o stejných '
          + '18 946 vlajek — hraje ' + pocet + ' týmů. Tým jde změnit '
          + 'po ' + (((d.pravidla || {}).zmenaTymuDni) || 30)
          + ' dnech, dřív jen rozhodnutím správce.';
        var vb = el('verejneBox');
        if (vb) vb.style.display = 'none';
      }
      vykresliSpravu();
      vykresliPridani();
      vypisSkoreZnovu();
    }).catch(function () {
      el('stavSouteze').textContent = vlastniSoutez()
        ? 'soutěž nenalezena' : 'připravuje se';
      el('stavSouteze').className = 'stitek sedy';
    });
}

/* Skóre se poprvé kreslí ze snímku; po načtení dokumentu soutěže se
   překreslí s vlastními názvy a podmnožinou týmů. */
var posledniSkore = null;
function vypisSkoreZnovu() {
  if (posledniSkore && tymy.length) vypisSkore(posledniSkore);
}

/* „Přidat se" — jen u vlastních soutěží (v republikovém kole dává
   tým aplikace podle kraje v profilu). */
function vykresliPridani() {
  var box = el('pridaniBox');
  if (!box || !vlastniSoutez() || !soutezDoc) return;
  var relace = nactiRelaci();
  box.textContent = '';
  if (!relace || !relace.uid) {
    var a = document.createElement('a');
    a.href = '/ucet/';
    a.textContent = 'Přihlaste se';
    box.appendChild(a);
    box.appendChild(document.createTextNode(
        ' a můžete se přidat k některému týmu.'));
    return;
  }
  platnyToken().then(function (token) {
    return ctiDoc(ZAKLAD_DOK + 'clenstvi/' + relace.uid + '_'
        + SOUTEZ + '?key=' + KLIC, token);
  })
    .then(function (c) {
      box.textContent = 'Hraješ za tým '
        + jmenoTymu(c.tym) + '.';
    })
    .catch(function () {
      var vyber = document.createElement('select');
      (soutezDoc.tymyPoradi || []).forEach(function (klic) {
        var o = document.createElement('option');
        o.value = klic;
        o.textContent = jmenoTymu(klic);
        vyber.appendChild(o);
      });
      var tl = document.createElement('button');
      tl.textContent = 'Přidat se';
      tl.style.marginLeft = '8px';
      tl.onclick = function () {
        tl.disabled = true;
        zapisDoc('clenstvi/' + relace.uid + '_' + SOUTEZ, {
          soutez: SOUTEZ,
          tym: vyber.value,
          od: new Date(),
          tymZmena: new Date(),
        }).then(function () {
          box.textContent = 'Hraješ za tým ' + jmenoTymu(vyber.value)
            + '. Vyraž do terénu s aplikací Okolník!';
        }).catch(function () {
          tl.disabled = false;
          alert('Přidání se nepovedlo — zkuste to znovu.');
        });
      };
      box.appendChild(document.createTextNode('Tvůj tým: '));
      box.appendChild(vyber);
      box.appendChild(tl);
    });
}

/* ── ZAKLÁDÁNÍ SOUTĚŽE (Etapa 3) ── */
function slugSouteze(nazev) {
  var s = nazev.toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 30);
  return (s || 'soutez') + '-'
    + Math.random().toString(36).slice(2, 6);
}

function vykresliZalozeni() {
  var box = el('zalozeniBox');
  if (!box) return;
  var relace = nactiRelaci();
  box.textContent = '';
  if (!relace || !relace.uid) {
    var a = document.createElement('a');
    a.href = '/ucet/';
    a.textContent = 'Přihlaste se na Můj Okolník';
    box.appendChild(a);
    box.appendChild(document.createTextNode(
        ' a soutěž založíte na tři kliknutí.'));
    return;
  }
  var tl = document.createElement('button');
  tl.textContent = 'Založit soutěž';
  tl.onclick = function () {
    tl.style.display = 'none';
    var f = document.createElement('div');
    var jmeno = document.createElement('input');
    jmeno.placeholder = 'Název soutěže (např. Rodinné dobývání)';
    jmeno.maxLength = 60;
    jmeno.style.cssText = 'width:100%;margin:6px 0;padding:6px;';
    f.appendChild(jmeno);
    var ver = document.createElement('label');
    ver.style.cssText = 'display:block;margin:4px 0;';
    var verCh = document.createElement('input');
    verCh.type = 'checkbox';
    ver.appendChild(verCh);
    ver.appendChild(document.createTextNode(
        ' veřejná (uvidí ji a přidá se každý; jinak jen s odkazem)'));
    f.appendChild(ver);
    var pozn = document.createElement('p');
    pozn.style.cssText = 'margin:6px 0 2px;font-weight:700;';
    pozn.textContent = 'Týmy (vyber 2–14, názvy si přepiš):';
    f.appendChild(pozn);
    var radkyTymu = [];
    tymy.forEach(function (t) {
      var r = document.createElement('div');
      r.style.cssText =
        'display:flex;align-items:center;gap:6px;margin:2px 0;';
      var ch = document.createElement('input');
      ch.type = 'checkbox';
      var tecka = document.createElement('span');
      tecka.style.cssText = 'width:12px;height:12px;border-radius:'
        + '50%;flex:none;background:' + t.barva + ';';
      var nm = document.createElement('input');
      nm.value = t.kratky;
      nm.maxLength = 24;
      nm.style.cssText = 'flex:1;padding:3px 6px;';
      r.appendChild(ch);
      r.appendChild(tecka);
      r.appendChild(nm);
      f.appendChild(r);
      radkyTymu.push({ klic: t.klic, ch: ch, nm: nm });
    });
    var zaloz = document.createElement('button');
    zaloz.textContent = 'Založit';
    zaloz.style.marginTop = '8px';
    var zprava = document.createElement('p');
    f.appendChild(zaloz);
    f.appendChild(zprava);
    zaloz.onclick = function () {
      var vybrane = radkyTymu.filter(function (r) {
        return r.ch.checked;
      });
      if (jmeno.value.trim().length < 3) {
        zprava.textContent = 'Zadejte název (aspoň 3 znaky).';
        return;
      }
      if (vybrane.length < 2 || vybrane.length > 14) {
        zprava.textContent = 'Vyberte 2 až 14 týmů.';
        return;
      }
      zaloz.disabled = true;
      zprava.textContent = 'Zakládám…';
      var sid = slugSouteze(jmeno.value.trim());
      var nazvy = {};
      vybrane.forEach(function (r) {
        nazvy[r.klic] = r.nm.value.trim().slice(0, 24)
          || jmenoTymu(r.klic);
      });
      zapisDoc('souteze/' + sid, {
        nazev: jmeno.value.trim(),
        stav: 'priprava',
        zakladatel: relace.uid,
        verejna: !!verCh.checked,
        pravidla: { dosahM: 150, zabraniDenne: 40,
                    zmenaTymuDni: 30, prahNadoblasti: 0.5 },
        tymyPoradi: vybrane.map(function (r) { return r.klic; }),
        tymyNazvy: nazvy,
        vytvoreno: new Date(),
      }, true).then(function () {
        location.href = '?s=' + sid;
      }).catch(function () {
        zaloz.disabled = false;
        zprava.textContent = 'Založení se nepovedlo — zkuste jiný '
          + 'název, nebo se přihlaste znovu.';
      });
    };
    box.appendChild(f);
  };
  box.appendChild(tl);
}

/* ── PANEL SPRÁVCE (zakladatele) ── */
function vykresliSpravu() {
  var karta = el('sprava');
  var box = el('spravaObsah');
  if (!karta || !box || !soutezDoc) return;
  var relace = nactiRelaci();
  if (!relace || relace.uid !== soutezDoc.zakladatel) return;
  karta.style.display = '';
  box.textContent = '';

  // stav soutěže
  var stavR = document.createElement('p');
  stavR.textContent = 'Stav: ' + (soutezDoc.stav || '?') + ' ';
  if (soutezDoc.stav !== 'bezi') {
    var spust = document.createElement('button');
    spust.textContent = 'Spustit soutěž';
    spust.onclick = function () {
      spust.disabled = true;
      zapisDoc('souteze/' + SOUTEZ, { stav: 'bezi' })
        .then(function () { location.reload(); })
        .catch(function () { spust.disabled = false; });
    };
    stavR.appendChild(spust);
  }
  if (soutezDoc.stav === 'bezi') {
    var konec = document.createElement('button');
    konec.textContent = 'Ukončit soutěž';
    konec.onclick = function () {
      if (!confirm('Opravdu ukončit? Mapa zamrzne v posledním '
          + 'stavu.')) return;
      zapisDoc('souteze/' + SOUTEZ, { stav: 'konec' })
        .then(function () { location.reload(); });
    };
    stavR.appendChild(konec);
  }
  box.appendChild(stavR);

  // lhůta změny týmu
  var lhutaR = document.createElement('p');
  lhutaR.appendChild(document.createTextNode(
      'Hráč smí změnit tým jednou za '));
  var dny = document.createElement('input');
  dny.type = 'number';
  dny.min = 0;
  dny.max = 365;
  dny.value = ((soutezDoc.pravidla || {}).zmenaTymuDni) || 30;
  dny.style.cssText = 'width:64px;margin:0 4px;';
  lhutaR.appendChild(dny);
  lhutaR.appendChild(document.createTextNode(' dní '));
  var ulozL = document.createElement('button');
  ulozL.textContent = 'Uložit';
  ulozL.onclick = function () {
    var prav = soutezDoc.pravidla || {};
    prav.zmenaTymuDni = parseInt(dny.value, 10) || 30;
    ulozL.disabled = true;
    zapisDoc('souteze/' + SOUTEZ, { pravidla: prav })
      .then(function () { ulozL.disabled = false; ulozL.textContent = 'Uloženo ✓'; })
      .catch(function () { ulozL.disabled = false; });
  };
  lhutaR.appendChild(ulozL);
  box.appendChild(lhutaR);

  // členové: změna týmu + předání správy
  var klice = (soutezDoc.tymyPoradi && soutezDoc.tymyPoradi.length)
    ? soutezDoc.tymyPoradi
    : tymy.map(function (t) { return t.klic; });
  platnyToken().then(function (token) {
    return Promise.all([
      dotaz('clenstvi', 'soutez', SOUTEZ, token),
      fetch(ZAKLAD_DOK + 'zebricek?pageSize=300&key=' + KLIC)
        .then(function (r) { return r.json(); })
        .catch(function () { return {}; }),
    ]);
  }).then(function (v) {
    var jmena = {};
    (v[1].documents || []).forEach(function (doc) {
      var f = doc.fields || {};
      var uid = f.hrac && f.hrac.stringValue;
      var jm2 = f.prezdivka && f.prezdivka.stringValue;
      if (uid && jm2) jmena[uid] = jm2;
    });
    var nadpis = document.createElement('p');
    nadpis.style.fontWeight = '700';
    nadpis.textContent = 'Členové (' + v[0].length + '):';
    box.appendChild(nadpis);
    if (!v[0].length) {
      var pr = document.createElement('p');
      pr.textContent = 'Zatím nikdo — pošlete odkaz na tuhle '
        + 'stránku.';
      box.appendChild(pr);
    }
    v[0].forEach(function (c) {
      var uid = c._id.split('_')[0];
      var r = document.createElement('p');
      r.style.cssText =
        'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
      r.appendChild(document.createTextNode(
          (jmena[uid] || ('hráč ' + uid.slice(0, 6) + '…')) + ' — '));
      var vyber = document.createElement('select');
      klice.forEach(function (klic) {
        var o = document.createElement('option');
        o.value = klic;
        o.textContent = jmenoTymu(klic);
        if (klic === c.tym) o.selected = true;
        vyber.appendChild(o);
      });
      r.appendChild(vyber);
      var uloz = document.createElement('button');
      uloz.textContent = 'Změnit tým';
      uloz.onclick = function () {
        uloz.disabled = true;
        zapisDoc('clenstvi/' + c._id, {
          soutez: SOUTEZ,
          tym: vyber.value,
          od: new Date(),
          tymZmena: new Date(),
        }).then(function () {
          uloz.textContent = 'Změněno ✓';
        }).catch(function () { uloz.disabled = false; });
      };
      r.appendChild(uloz);
      if (uid !== relace.uid) {
        var predej = document.createElement('button');
        predej.textContent = 'Předat správu';
        predej.onclick = function () {
          if (!confirm('Předat správu soutěže hráči '
              + (jmena[uid] || uid.slice(0, 8)) + '? Tobě zůstane '
              + 'jen role hráče.')) return;
          zapisDoc('souteze/' + SOUTEZ, { zakladatel: uid })
            .then(function () { location.reload(); });
        };
        r.appendChild(predej);
      }
      box.appendChild(r);
    });
  }).catch(function () { });
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
    + 'background:rgba(255,253,246,.72);cursor:pointer;'
    + '-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);'
    + 'font:600 12.5px sans-serif;';
  // bez podbarvení panelu — každý řádek nese jen malinko
  // rozostřený pruh (přání 27. 8.)
  var PRUH = 'background:rgba(247,244,236,.45);'
    + '-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);'
    + 'border-radius:8px;padding:2px 9px;';
  var panel = document.createElement('div');
  panel.style.cssText = 'position:absolute;left:10px;top:44px;'
    + 'z-index:5;display:none;max-height:70%;overflow:auto;'
    + 'font:12.5px sans-serif;';
  for (var kat in POPISKY_DRUHU) {
    var radek = document.createElement('div');
    radek.style.cssText = PRUH
      + 'display:flex;align-items:center;gap:8px;margin:3px 0;';
    var b = BUBLINA_DRUHU[kat] || ['❓', '#777'];
    var im = document.createElement('span');
    im.style.cssText = 'display:inline-flex;align-items:center;'
      + 'justify-content:center;width:22px;height:22px;'
      + 'border-radius:50%;background:#fff;border:2.5px solid '
      + b[1] + ';font-size:12.5px;flex:none;';
    im.textContent = b[0];
    radek.appendChild(im);
    radek.appendChild(
        document.createTextNode(POPISKY_DRUHU[kat]));
    panel.appendChild(radek);
  }
  var pozn = document.createElement('div');
  pozn.style.cssText = PRUH + 'margin-top:6px;color:#6b6455;'
    + 'max-width:230px;';
  pozn.textContent = 'Zdaleka vidíš jen výběr nejvýznamnějších míst '
    + '— přibližováním přibývají další. Barva území = tým, který je '
    + 'drží.';
  panel.appendChild(pozn);
  var klic = 'dobyvatelLegenda';
  var volba = null;
  try { volba = localStorage.getItem(klic); } catch (e) { }
  // INTRO (přání 27. 8.): legenda se ukáže ~2,5 s, sroluje se a
  // tlačítko zadrnčí — uživatel si všimne, kde ji najde. Kdo si ji
  // sám otevřel (volba 'ano'), tomu zůstává otevřená bez cirkusu.
  panel.style.display = 'block';
  var kf = document.createElement('style');
  kf.textContent = '@keyframes legenda-drnc{0%,100%{transform:none}'
    + '25%{transform:translateX(-3px) rotate(-2deg)}'
    + '75%{transform:translateX(3px) rotate(2deg)}}';
  document.head.appendChild(kf);
  var introCasovac = null;
  if (volba !== 'ano') {
    introCasovac = setTimeout(function () {
      panel.style.display = 'none';
      tl.style.animation = 'legenda-drnc .45s ease 3';
    }, 2500);
  }
  tl.onclick = function () {
    if (introCasovac) { clearTimeout(introCasovac); introCasovac = null; }
    tl.style.animation = '';
    var skryt = panel.style.display !== 'none';
    panel.style.display = skryt ? 'none' : 'block';
    try { localStorage.setItem(klic, skryt ? 'ne' : 'ano'); }
    catch (e) { }
  };
  obal.style.position = 'relative';
  obal.appendChild(tl);
  obal.appendChild(panel);
}

var _puvodniVypisSkore = vypisSkore;
vypisSkore = function (skore) {
  posledniSkore = skore;
  _puvodniVypisSkore(skore);
};

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
  reklamy();
  vykresliZalozeni();
  verejneSouteze();
  Promise.all([
    fetch('data/tymy.json?v=10').then(function (r) { return r.json(); }),
    fetch('data/vlajky_oblasti.json?v=10').then(function (r) { return r.json(); }),
    fetch('data/kraje.json?v=11').then(function (r) { return r.json(); }),
    fetch('data/vlajky.json').then(function (r) { return r.json(); }),
    fetch('data/obrys.json?v=14').then(function (r) { return r.json(); }),
  ]).then(function (vysledky) {
    obrys = vysledky[4];
    tymy = vysledky[0].tymy;
    // až po načtení týmů — jména týmů v textech by jinak byla klíče
    stavSouteze();
    mojeSouteze();
    zebricekHracu();
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
    spocitejPasma();
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
            'hillshade-exaggeration': 0.62,
            'hillshade-shadow-color': '#7d705e',
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
