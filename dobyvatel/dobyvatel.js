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

/* Záložky (jedna obrazovka bez rolování, přání 28. 8.). */
function prepniZalozku(z) {
  document.querySelectorAll('#zalozky > button').forEach(function (b) {
    b.classList.toggle('aktivni', b.getAttribute('data-z') === z);
  });
  var nav2 = document.getElementById('zalozky');
  if (nav2) nav2.classList.toggle('moje-otevrene', z === 'moje');
  document.querySelectorAll('.zalozka').forEach(function (s) {
    s.classList.toggle('aktivni', s.id === 'z-' + z);
  });
  if (z === 'mapa' && mapa) {
    setTimeout(function () { try { mapa.resize(); } catch (e) { } }, 60);
  }
}

function pripravZalozky() {
  document.querySelectorAll('#zalozky > button').forEach(function (b) {
    b.onclick = function () {
      prepniZalozku(b.getAttribute('data-z'));
    };
  });
  document.querySelectorAll('.pod-menu button')
    .forEach(function (b) {
      b.onclick = function () {
        prepniZalozku('moje');
        prepniPodzalozku(b.getAttribute('data-p'));
      };
    });
}

/* Po reloadu (akce správy) se vrátit tam, kde uživatel byl. */
function zapamatujNavrat() {
  try { sessionStorage.setItem('dobyvatelNavrat', 'moje'); }
  catch (e) { }
}

function prepniPodzalozku(p) {
  document.querySelectorAll('.pod-menu button')
    .forEach(function (b) {
      b.classList.toggle('aktivni', b.getAttribute('data-p') === p);
    });
  ['prehled', 'zalozit'].forEach(function (x) {
    var e2 = el('p-' + x);
    if (e2) e2.classList.toggle('aktivni', x === p);
  });
}

/* Plocha přesně do okna — ať se nikdy neroluje celá stránka. */
function napasujVysku() {
  var m = document.querySelector('main.plocha');
  if (!m) return;
  if (window.matchMedia('(max-width: 820px)').matches) {
    m.style.height = '';
    return;
  }
  var vrch = m.getBoundingClientRect().top + window.scrollY;
  m.style.height = Math.max(430, window.innerHeight - vrch - 8) + 'px';
}
window.addEventListener('resize', function () {
  napasujVysku();
  if (mapa) { try { mapa.resize(); } catch (e) { } }
});

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
  vlastni: ['🚩', '#C62828'],
};

function nakresliBublinu(emoji, barva) {
  // 256 px / pixelRatio 4 = základ 64 CSS px; při „růstu s mapou"
  // do z17 zůstane bublina ostrá
  var s = 256;
  var p = document.createElement('canvas');
  p.width = s;
  p.height = s;
  var ctx = p.getContext('2d');
  ctx.beginPath();
  ctx.arc(128, 128, 104, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 16;
  ctx.strokeStyle = barva;
  ctx.stroke();
  ctx.font = '128px "Segoe UI Emoji", "Noto Color Emoji", '
    + '"Apple Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, 128, 140);
  return ctx.getImageData(0, 0, s, s);
}

function nahrajIkony() {
  Object.keys(BUBLINA_DRUHU).forEach(function (kat) {
    if (!mapa.hasImage('ik-' + kat)) {
      var b = BUBLINA_DRUHU[kat];
      mapa.addImage('ik-' + kat, nakresliBublinu(b[0], b[1]),
          { pixelRatio: 4 });
    }
  });
  return Promise.resolve();
}

/* Pásma odkrývání PO DRUZÍCH: v každém druhu se vezme pár nejlepších
   do dálkového pásma (řazeno hodnotou, remíza deterministickým
   promícháním), takže zdaleka není vidět „skoro pořád hrady", ale
   výběr napříč druhy. */
function spocitejPasma(pole) {
  // kvóty se počítají JEN z hrajících míst (maska) — malá soutěž
  // musí mít své obrázky vidět už zdaleka (přání 27. 8.)
  var dleDruhu = {};
  vlajky.forEach(function (v, i) {
    if (v.k === 'vlastni') {
      body.features[i].properties.p = 4;   // vidět vždy a zdaleka
      return;
    }
    if (pole && !pole[i]) {
      body.features[i].properties.p = 1;
      return;
    }
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
  // KRAJE musí být jasně silnější než hranice buněk (v41 se mezi
  // nimi ztratily — výtka 29. 8.)
  mapa.addLayer({
    id: 'kraje', type: 'line', source: 'kraje',
    paint: { 'line-color': '#3d382e', 'line-width': 2.6,
             'line-opacity': 0.85 },
  });
  mapa.addLayer({
    id: 'hranice', type: 'line', source: 'oblasti',
    paint: {
      // vyladěno 29. 8.: viditelné, ale lehčí než kraje
      'line-color': ['case', ['==', ['get', 't'], '0'],
        '#6a6152', barvaTymu()],
      'line-opacity': ['case', ['==', ['get', 't'], '0'], 0.55, 0.95],
      'line-width': ['case', ['==', ['get', 't'], '0'], 0.9, 1.8],
    },
  });
  // zvýraznění kliknuté oblasti (přání 27. 8.) — filtr plní klik,
  // zhasíná zavření bubliny
  mapa.addLayer({ id: 'zvyraz-vypln', type: 'fill', source: 'oblasti',
    filter: ['==', ['id'], -1],
    paint: { 'fill-color': '#C99B3F', 'fill-opacity': 0.28 } });
  mapa.addLayer({ id: 'zvyraz-cara', type: 'line', source: 'oblasti',
    filter: ['==', ['id'], -1],
    paint: { 'line-color': '#2f2a20',
             'line-width': ['interpolate', ['linear'], ['zoom'],
               6, 2.2, 12, 3, 15, 3.6],
             'line-opacity': 0.95 } });

  // body vlajek: tečka v barvě držitele (neutrální hnědošedá) — a od
  // přiblížení jméno vlajky = jméno oblasti
  mapa.addSource('body', { type: 'geojson', data: body });
  // prstenec kolem hlavního bodu vybraného místa (přání 30. 8.:
  // „zvýrazňuj nakliknutou oblast i z dálky" — drobné a klínové
  // buňky z dálky zaniknou, kroužek u vlajky ne)
  mapa.addLayer({ id: 'zvyraz-bod', type: 'circle', source: 'body',
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

  // ⚠️ JMÉNA MUSÍ BÝT POD IKONAMI: vrstva výš se rozmisťuje
  // DŘÍV — když byla jména nahoře (v34–v39), zabrala místo a ikony
  // z mapy ZMIZELY (změřeno: z12,4 → 8 jmen, 0 ikon)
  mapa.addLayer({
    id: 'vlajky-jmena', type: 'symbol', source: 'body', minzoom: 10.2,
    layout: {
      'text-field': ['get', 'n'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'],
        10, 12.5, 13, 14.5, 17, 24],
      'text-offset': ['interpolate', ['exponential', 1.5], ['zoom'],
        10, ['literal', [0, 0.9]], 13, ['literal', [0, 1.7]],
        17, ['literal', [0, 7.5]]],
      'text-anchor': 'top',
      'text-max-width': 9,
    },
    paint: {
      'text-color': '#4a443a',
      'text-halo-color': '#f2efe6',
      'text-halo-width': 1.3,
    },
  });

  // malované značky z neherní mapy appky; postupné odkrývání řídí
  // pásmo p (kvóty v každém druhu — viz spocitejPasma) a hustotu
  // v pásmu kolizní polštář
  [[4, 6], [3, 9.2], [2, 10.8], [1, 12]].forEach(function (p) {
    mapa.addLayer({
      id: 'vlajky-ik' + p[0], type: 'symbol', source: 'body',
      minzoom: p[1],
      maxzoom: 13,
      filter: ['all', ['==', ['get', 'p'], p[0]],
        ['!=', ['coalesce', ['get', 'akt'], 1], 0]],
      layout: {
        'icon-image': ['concat', 'ik-', ['get', 'k']],
        // od z13 rostou SPOLEČNĚ S MAPOU (přání 28. 8.) —
        // exponenciála se blíží „přilepení" k zemi
        'icon-size': ['interpolate', ['exponential', 1.5], ['zoom'],
          6, 0.5, 10, 0.66, 13, 0.85, 17, 2.9],
        // velký kolizní polštář zdaleka = řídká, klidná mapa
        'icon-padding': ['interpolate', ['linear'], ['zoom'],
          6, 26, 9, 14, 12, 4],
      },
      paint: { 'icon-opacity': 1 },
    });
  });
  // od z13,8 má KAŽDÁ oblast svůj obrázek (přání 28. 8.: „ať má
  // každá oblast po přiblížení viditelný svůj obrázek") — kolize
  // se vypínají a kreslí se úplně všechny vlajky
  mapa.addLayer({
    id: 'vlajky-ik-vse', type: 'symbol', source: 'body',
    minzoom: 13,
    filter: ['!=', ['coalesce', ['get', 'akt'], 1], 0],
    layout: {
      'icon-image': ['concat', 'ik-', ['get', 'k']],
      'icon-size': ['interpolate', ['exponential', 1.5], ['zoom'],
        13, 0.85, 17, 2.9],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: { 'icon-opacity': 1 },
  });
  // ztlumení oblastí mimo výběr míst soutěže (maska)
  mapa.addLayer({
    id: 'mrtve', type: 'fill', source: 'oblasti',
    paint: {
      'fill-color': '#8d8778',
      'fill-opacity': ['case',
        ['==', ['coalesce', ['get', 'akt'], 1], 0], 0.35, 0],
    },
  });
  // VLASTNÍ MÍSTA v odděleném zdroji (kruh v barvě držitele +
  // čárkovaný lem) — malý kruh vmíchaný mezi 17 688 polygonů dělal
  // artefakty a splýval s buňkou pod sebou („dvě místa najednou")
  mapa.addSource('vlastni', { type: 'geojson', data: vlastniFC });
  mapa.addLayer({
    id: 'vlastni-uzemi', type: 'fill', source: 'vlastni',
    paint: {
      'fill-color': ['case', ['==', ['get', 't'], '0'],
        '#C62828', barvaTymu()],
      'fill-opacity': ['case', ['==', ['get', 't'], '0'], 0.14, 0.5],
    },
  });
  mapa.addLayer({
    id: 'vlastni-obrys', type: 'line', source: 'vlastni',
    paint: {
      'line-color': ['case', ['==', ['get', 't'], '0'],
        '#C62828', barvaTymu()],
      'line-width': 2.4,
      'line-dasharray': [2, 1.3],
    },
  });
  // ZÁCHYTNÉ BODY (přání 28. 8.): na ztlumené mapě zůstávají
  // nejvýznamnější místa jako bledé bublinky — jen orientace
  mapa.addLayer({
    id: 'orientacni', type: 'symbol', source: 'body', minzoom: 7,
    filter: ['all', ['==', ['get', 'p'], 4],
      ['==', ['coalesce', ['get', 'akt'], 1], 0]],
    layout: {
      'icon-image': ['concat', 'ik-', ['get', 'k']],
      'icon-size': ['interpolate', ['exponential', 1.5], ['zoom'],
        6, 0.36, 10, 0.5, 13, 0.62, 17, 2.0],
      'icon-padding': 22,
    },
    paint: { 'icon-opacity': 0.4 },
  });

  // karta informativního místa (bez dobývání)
  function ukazInfoMisto(f) {
    var p = f.properties || {};
    var box = el('mistoInfo');
    if (!box) {
      box = document.createElement('div');
      box.id = 'mistoInfo';
      box.className = 'legenda';
      box.style.cssText = 'position:absolute;left:10px;bottom:36px;'
        + 'z-index:6;max-width:250px;background:rgba(250,247,238,.96);'
        + 'border:1px solid #b9b2a0;border-left:4px solid #C99B3F;'
        + 'border-radius:10px;padding:8px 10px;'
        + 'box-shadow:0 3px 10px rgba(0,0,0,.18);';
      el('mapa').appendChild(box);
    }
    box.style.display = '';
    box.textContent = '';
    box.classList.remove('blik');
    void box.offsetWidth;
    box.classList.add('blik');
    var stitekV = document.createElement('div');
    stitekV.style.cssText = 'font-size:.72rem;font-weight:800;'
      + 'letter-spacing:.8px;color:#5f6f66;text-transform:uppercase;';
    stitekV.textContent = 'Informativní místo';
    box.appendChild(stitekV);
    var horni = document.createElement('div');
    horni.style.cssText = 'display:flex;align-items:baseline;gap:8px;';
    var jm = document.createElement('strong');
    jm.textContent = p.n || '';
    horni.appendChild(jm);
    var krizek = document.createElement('button');
    krizek.textContent = '×';
    krizek.style.cssText = 'margin-left:auto;padding:0 8px;';
    krizek.onclick = function () { box.style.display = 'none'; };
    horni.appendChild(krizek);
    box.appendChild(horni);
    var druh = document.createElement('div');
    druh.textContent = (POPISKY_DRUHU[p.k] || 'Místo')
      + ' · nedobývá se';
    box.appendChild(druh);
    var pozn = document.createElement('div');
    pozn.style.cssText = 'font-size:.82rem;color:#6a6152;';
    pozn.textContent = 'Přítomnost se počítá jen u hlavního '
      + 'bodu oblasti.';
    box.appendChild(pozn);
    pridejWiki(box, { n: p.n, lat: +p.lat, lon: +p.lon });
    ['zvyraz-vypln', 'zvyraz-cara', 'zvyraz-bod'].forEach(function (id) {
      try { mapa.setFilter(id, ['==', ['id'], -1]); } catch (er) { }
    });
  }
  ukazInfoMistoGl = ukazInfoMisto;

  // klik kamkoli do území → bublina se jménem, hodnotou a držitelem
  function naKlikOblasti(e) {
    var f = e.features && e.features[0];
    if (!f || f.id === undefined) return;
    if (rezimPridani) return;   // klik zpracuje obecný handler níž
    if (rezimVyberu) {
      if (f.id < nStd) prepniMisto(f.id);
      return;
    }
    // klik na OBRÁZEK má přednost před buňkou pod kurzorem (zdaleka
    // bublina často stojí nad jinou buňkou — výtka 29. 8.)
    try {
      var pb = e.point;
      var ik = mapa.queryRenderedFeatures(
        [[pb.x - 16, pb.y - 16], [pb.x + 16, pb.y + 16]],
        { layers: ['vlajky-ik4', 'vlajky-ik3', 'vlajky-ik2',
                   'vlajky-ik1', 'vlajky-ik-vse', 'orientacni',
                   'info-mista']
            .filter(function (id) { return mapa.getLayer(id); }) });
      // informativní místo vyhrává, jen když poblíž není vlajka
      // (kreslí se pode vším, takže vlajka je v poli první)
      if (ik.length && ik[0].layer
          && ik[0].layer.id === 'info-mista') {
        ukazInfoMisto(ik[0]);
        return;
      }
      if (ik.length && ik[0].id !== undefined) f = ik[0];
    } catch (eq) { }
    var v = vlajky[f.id];
    if (!v) return;
    ukazKartuMista(f.id, (f.properties && f.properties.t) || '0');
  }

  mapa.on('click', 'uzemi', naKlikOblasti);
  mapa.on('click', 'vlastni-uzemi', naKlikOblasti);
  aplikujFiltrDruhu();
  // zapamatované trasy z minula
  try {
    if (localStorage.getItem('dobyvatelTrasy') === 'ano'
        && !trasyStav.zapnuto) {
      trasyStav.zapnuto = true;
      obnovTlacitkoTras();
      nactiTrasy();
    }
  } catch (e) { }
  nactiMistaInfo();
  nactiModely3d();
  pripravHledani();
  // v editoru jmenovka i při najetí na BUŇKU (přání 28. 8.)
  mapa.on('mousemove', 'uzemi', function (e) {
    if (!rezimVyberu) return;
    var f = e.features && e.features[0];
    if (!f || f.id === undefined || f.id >= nStd) return;
    var v = vlajky[f.id];
    if (!v) return;
    mapa.getCanvas().style.cursor = 'pointer';
    jmenovka.setLngLat(e.lngLat).setText(v.n).addTo(mapa);
  });
  mapa.on('mouseleave', 'uzemi', function () {
    if (!rezimVyberu) return;
    mapa.getCanvas().style.cursor = '';
    jmenovka.remove();
  });
  // přidání vlastního místa: klik KAMKOLI (i doprostřed louky)
  mapa.on('click', function (e) {
    if (!rezimPridani || !pracovniVlastni) return;
    var jmeno = prompt('Název vlastního místa:');
    if (!jmeno || !jmeno.trim()) return;
    pracovniVlastni.push({
      n: jmeno.trim().slice(0, 40),
      lat: Math.round(e.lngLat.lat * 1e5) / 1e5,
      lon: Math.round(e.lngLat.lng * 1e5) / 1e5,
      h: 2,
    });
    rezimPridani = false;
    zapracujVlastni(pracovniVlastni);
    obnovSeznamVlastnich();
  });

  ['vlajky-ik4', 'vlajky-ik3', 'vlajky-ik2', 'vlajky-ik1',
   'vlajky-ik-vse', 'orientacni']
    .forEach(function (id) {
      mapa.on('mousemove', id, function (e) {
        mapa.getCanvas().style.cursor = 'pointer';
        var f = e.features && e.features[0];
        if (!f || !f.properties.n) return;
        jmenovka.setLngLat(f.geometry.coordinates)
          .setText(f.properties.n).addTo(mapa);
      });
      mapa.on('mouseleave', id, function () {
        mapa.getCanvas().style.cursor = '';
        jmenovka.remove();
      });
    });
}

// jmenovka místa po najetí (obrázky, orientační body, buňky
// v editoru) — jediná instance pro celou mapu
var jmenovka = null;
try {
  jmenovka = new maplibregl.Popup({ closeButton: false,
    closeOnClick: false, offset: 14 });
} catch (e) { /* maplibre se teprve načítá */ }

/* Ověřený úryvek z české Wikipedie: článek se přijme JEN když
   jeho souřadnice leží do 2,5 km od vlajky — jinak se raději
   neukáže nic (přání 29. 8.: „trocha historie? Ověřuj"). */
var wikiKes = {};
var wikiBeh = 0;



/* karta vlajky (v52 vytaženo z naKlikOblasti, ať ji otevře i hledání) */
var ukazInfoMistoGl = null;
var mistaInfoSeznam = null;

function ukazKartuMista(id, drzitel) {
  var v = vlajky[id];
  if (!v) return;
  var box = el('mistoInfo');
  if (!box) {
    box = document.createElement('div');
    box.id = 'mistoInfo';
    box.className = 'legenda';
    box.style.cssText = 'position:absolute;left:10px;bottom:36px;'
      + 'z-index:6;max-width:250px;background:rgba(250,247,238,.96);'
      + 'border:1px solid #b9b2a0;border-left:4px solid #C99B3F;'
      + 'border-radius:10px;padding:8px 10px;'
      + 'box-shadow:0 3px 10px rgba(0,0,0,.18);';
    el('mapa').appendChild(box);
  }
  box.style.display = '';
  box.textContent = '';
  box.classList.remove('blik');
  void box.offsetWidth;
  box.classList.add('blik');
  var stitekV = document.createElement('div');
  stitekV.style.cssText = 'font-size:.72rem;font-weight:800;'
    + 'letter-spacing:.8px;color:#8a5a20;text-transform:uppercase;';
  stitekV.textContent = 'Vybrané místo';
  box.appendChild(stitekV);
  if (window.matchMedia('(max-width: 820px)').matches) {
    try { box.scrollIntoView({ block: 'nearest' }); } catch (eS) { }
  }
  var horni = document.createElement('div');
  horni.style.cssText = 'display:flex;align-items:baseline;gap:8px;';
  var jm = document.createElement('strong');
  jm.textContent = v.n;
  horni.appendChild(jm);
  var krizek = document.createElement('button');
  krizek.textContent = '×';
  krizek.style.cssText = 'margin-left:auto;padding:0 8px;';
  krizek.onclick = function () {
    box.style.display = 'none';
    ['zvyraz-vypln', 'zvyraz-cara', 'zvyraz-bod'].forEach(function (idv) {
      try { mapa.setFilter(idv, ['==', ['id'], -1]); } catch (er) { }
    });
  };
  horni.appendChild(krizek);
  box.appendChild(horni);
  function radekI(text) {
    var p2 = document.createElement('div');
    p2.textContent = text;
    box.appendChild(p2);
  }
  radekI((POPISKY_DRUHU[v.k] || 'Místo') + ' · ' + v.h + ' b.');
  var ok = (v.o !== undefined) ? okresyLegenda[v.o] : null;
  if (ok) {
    var okNazev = ok[0] === 'praha'
      ? 'Praha'
      : 'okres ' + ok[0].charAt(0).toUpperCase() + ok[0].slice(1);
    radekI(okNazev.replace(/-/g, ' '));
  }
  radekI(drzitel === '0'
      ? 'Zatím neutrální — obsaď ji v aplikaci Okolník!'
      : 'Drží ' + jmenoTymu(drzitel) + '.');
  pridejWiki(box, v);
  ['zvyraz-vypln', 'zvyraz-cara', 'zvyraz-bod'].forEach(function (idv) {
    try { mapa.setFilter(idv, ['==', ['id'], id]); } catch (er) { }
  });
}

/* ── HLEDÁNÍ NAD MAPOU (v52) ── */
function bezHacku(t) {
  return t.toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

var hledaniIndex = null;

function pripravHledani() {
  var vstup = el('hledani');
  var vysledky = el('hledaniVysledky');
  if (!vstup || !vysledky) return;
  function schovej() { vysledky.style.display = 'none'; }
  function postavIndex() {
    if (hledaniIndex || !window.vlajky || !vlajky.length) return;
    hledaniIndex = [];
    vlajky.forEach(function (v, i) {
      hledaniIndex.push({ t: bezHacku(v.n), i: i, m: null });
    });
    (mistaInfoSeznam || []).forEach(function (m) {
      hledaniIndex.push({ t: bezHacku(m[3]), i: -1,
        m: { k: m[0], lat: m[1] / 1e5, lon: m[2] / 1e5, n: m[3] } });
    });
  }
  vstup.oninput = function () {
    postavIndex();
    var q = bezHacku(vstup.value.trim());
    if (q.length < 2 || !hledaniIndex) { schovej(); return; }
    var zacina = [];
    var obsahuje = [];
    for (var i = 0; i < hledaniIndex.length; i++) {
      var z = hledaniIndex[i];
      var kde = z.t.indexOf(q);
      if (kde === 0) zacina.push(z);
      else if (kde > 0) obsahuje.push(z);
      if (zacina.length >= 8) break;
    }
    var vyber = zacina.concat(obsahuje).slice(0, 8);
    vysledky.textContent = '';
    if (!vyber.length) { schovej(); return; }
    vyber.forEach(function (z) {
      var v = z.m || vlajky[z.i];
      var radek = document.createElement('div');
      radek.style.cssText = 'padding:6px 10px;cursor:pointer;'
        + 'display:flex;gap:8px;align-items:baseline;';
      radek.onmouseenter = function () {
        radek.style.background = '#efe9da';
      };
      radek.onmouseleave = function () { radek.style.background = ''; };
      var b = BUBLINA_DRUHU[v.k] || ['❓', '#777'];
      var em = document.createElement('span');
      em.textContent = b[0];
      radek.appendChild(em);
      var jm = document.createElement('span');
      jm.textContent = v.n;
      radek.appendChild(jm);
      if (z.i < 0) {
        var pozn = document.createElement('span');
        pozn.textContent = 'informativní';
        pozn.style.cssText = 'margin-left:auto;font-size:.75rem;'
          + 'color:#8a8264;';
        radek.appendChild(pozn);
      }
      radek.onclick = function () {
        vstup.value = '';
        schovej();
        if (mapaMrtva || !window.mapa) return;
        mapa.flyTo({ center: [v.lon, v.lat],
          zoom: Math.max(mapa.getZoom(), 13), speed: 1.7 });
        if (z.i >= 0) {
          ukazKartuMista(z.i,
            (posledniDrziteleArr && posledniDrziteleArr[z.i]) || '0');
        } else if (ukazInfoMistoGl) {
          ukazInfoMistoGl({ properties: v });
        }
      };
      vysledky.appendChild(radek);
    });
    vysledky.style.display = '';
  };
  vstup.onkeydown = function (e) {
    if (e.key === 'Escape') { vstup.value = ''; schovej(); }
    if (e.key === 'Enter') {
      var prvni = vysledky.firstChild;
      if (prvni && vysledky.style.display !== 'none') prvni.onclick();
    }
  };
  document.addEventListener('click', function (e) {
    if (!vysledky.contains(e.target) && e.target !== vstup) schovej();
  });
}

/* ── 3D MODELY NA MAPĚ (28. 8.) — splaty z ComfyUI převedené na
   mesh+texturu (tools/spz_do_enginu.py v repu appky). Mapa webu
   nemá 3D terén, model stojí na rovině (výška 0 + posunM). ── */
var modely3dKonf = null;
var modely3dBufery = {};
var modely3dGL = null;

function nactiModely3d() {
  fetch('data/modely/modely.json?v=54')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.umisteni || !d.umisteni.length || mapaMrtva) return;
      modely3dKonf = d;
      var jmena = {};
      d.umisteni.forEach(function (u) { jmena[u.model] = 1; });
      Object.keys(jmena).forEach(function (jm) {
        var m = d.modely[jm];
        if (!m) return;
        // otisk obsahu v URL — keš NEMŮŽE dát starý soubor
        // k novému popisu (přesně to se stalo 28. 8.)
        var otisk = '?v=' + (m.v || (m.vrcholu + 'x' + m.trojuhelniku));
        Promise.all([
          fetch('data/modely/' + m.bin + otisk)
            .then(function (r) { return r.arrayBuffer(); }),
          fetch('data/modely/' + m.textura + otisk)
            .then(function (r) { return r.blob(); })
            .then(function (b) { return createImageBitmap(b); }),
        ]).then(function (vys) {
          var nv = m.vrcholu;
          // ⛔ POJISTKA: rozjetá geometrie se radši nekreslí vůbec
          var cekano = nv * 20 + m.trojuhelniku * 12;
          if (vys[0].byteLength !== cekano) {
            console.warn('[modely3d]', jm, 'velikost nesedi',
              vys[0].byteLength, 'cekano', cekano, '- vynechan');
            return;
          }
          modely3dBufery[jm] = {
            pozice: new Float32Array(vys[0], 0, nv * 3),
            uv: new Float32Array(vys[0], nv * 12, nv * 2),
            indexy: new Uint32Array(vys[0], nv * 20),
            obrazek: vys[1],
          };
          try { mapa.triggerRepaint(); } catch (e) { }
        }).catch(function (e) {
          console.warn('[modely3d] model se nenačetl:', jm, e);
        });
      });
      try {
        if (!mapa.getLayer('modely3d')) {
          mapa.addLayer(vrstvaModelu3d(), 'vlajky-jmena');
        }
      } catch (e) { console.warn('[modely3d] vrstva:', e); }
    })
    .catch(function () { });
}

function vrstvaModelu3d() {
  var VS = 'attribute vec3 aPoz;attribute vec2 aUV;'
    + 'uniform mat4 uMatice;varying vec2 vUV;'
    + 'void main(){vUV=aUV;gl_Position=uMatice*vec4(aPoz,1.0);}';
  var FS = 'precision mediump float;varying vec2 vUV;'
    + 'uniform sampler2D uTex;'
    + 'void main(){gl_FragColor=vec4(texture2D(uTex,vUV).rgb,1.0);}';
  function program(gl) {
    function shader(typ, zdroj) {
      var sh = gl.createShader(typ);
      gl.shaderSource(sh, zdroj);
      gl.compileShader(sh);
      return sh;
    }
    var p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    return p;
  }
  function zdroje(gl) {
    if (modely3dGL && modely3dGL.gl === gl) return modely3dGL;
    var z = { gl: gl, prg: program(gl), modely: {} };
    z.aPoz = gl.getAttribLocation(z.prg, 'aPoz');
    z.aUV = gl.getAttribLocation(z.prg, 'aUV');
    z.uMatice = gl.getUniformLocation(z.prg, 'uMatice');
    z.uTex = gl.getUniformLocation(z.prg, 'uTex');
    modely3dGL = z;
    return z;
  }
  function modelGl(gl, jm) {
    var z = zdroje(gl);
    if (z.modely[jm]) return z.modely[jm];
    var b = modely3dBufery[jm];
    if (!b) return null;
    var vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER,
      b.pozice.byteLength + b.uv.byteLength, gl.STATIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.pozice);
    gl.bufferSubData(gl.ARRAY_BUFFER, b.pozice.byteLength, b.uv);
    var ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, b.indexy, gl.STATIC_DRAW);
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA,
      gl.UNSIGNED_BYTE, b.obrazek);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,
      gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,
      gl.CLAMP_TO_EDGE);
    z.modely[jm] = { vbo: vbo, ibo: ibo, tex: tex,
      n: b.indexy.length, uvPosun: b.pozice.byteLength };
    return z.modely[jm];
  }
  function krat(a, b) {
    var c = new Float32Array(16);
    for (var i = 0; i < 4; i++) {
      for (var j = 0; j < 4; j++) {
        c[j * 4 + i] = a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1]
          + a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
      }
    }
    return c;
  }
  function maticeUmisteni(u) {
    var kotva = maplibregl.MercatorCoordinate.fromLngLat(
      { lng: u.lon, lat: u.lat }, u.posunM || 0);
    var s = kotva.meterInMercatorCoordinateUnits()
      * (u.vyskaM || 30);
    var a = (u.otoceni || 0) * Math.PI / 180;
    var ca = Math.cos(a), sa = Math.sin(a);
    var m = new Float32Array(16);
    m[0] = s * ca; m[1] = -s * sa; m[2] = 0; m[3] = 0;
    m[4] = 0; m[5] = 0; m[6] = s; m[7] = 0;
    m[8] = s * sa; m[9] = s * ca; m[10] = 0; m[11] = 0;
    m[12] = kotva.x; m[13] = kotva.y; m[14] = kotva.z; m[15] = 1;
    return m;
  }
  return {
    id: 'modely3d', type: 'custom', renderingMode: '3d',
    onAdd: function () { modely3dGL = null; },
    render: function (gl, args) {
      if (!modely3dKonf) return;
      var matice = (args && args.defaultProjectionData)
        ? args.defaultProjectionData.mainMatrix : args;
      if (!matice || matice.length !== 16) return;
      if (mapa.getZoom() < 11) return;
      var meze = null;
      try { meze = mapa.getBounds(); } catch (e) { }
      var z = zdroje(gl);
      gl.useProgram(z.prg);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      for (var i = 0; i < modely3dKonf.umisteni.length; i++) {
        var u = modely3dKonf.umisteni[i];
        if (meze && !meze.contains([u.lon, u.lat])) continue;
        var mg = modelGl(gl, u.model);
        if (!mg) continue;
        gl.uniformMatrix4fv(z.uMatice, false,
          krat(matice, maticeUmisteni(u)));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, mg.tex);
        gl.uniform1i(z.uTex, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, mg.vbo);
        gl.enableVertexAttribArray(z.aPoz);
        gl.vertexAttribPointer(z.aPoz, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(z.aUV);
        gl.vertexAttribPointer(z.aUV, 2, gl.FLOAT, false, 0,
          mg.uvPosun);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mg.ibo);
        gl.drawElements(gl.TRIANGLES, mg.n, gl.UNSIGNED_INT, 0);
      }
    },
  };
}

/* ── TURISTICKÉ TRASY KČT (30. 8.) — líně načítaná vrstva ── */
var trasyStav = { nacteno: false, zapnuto: false, nacita: false };
var trasyVrstvy = [];
var tlacitkoTras = null;

function obnovTlacitkoTras() {
  if (!tlacitkoTras) return;
  tlacitkoTras.style.background = trasyStav.zapnuto
    ? '#efe9da' : '#fffdf6';
  tlacitkoTras.style.borderColor = trasyStav.zapnuto
    ? '#4e6e58' : '#b9b2a0';
}

function prepniTrasy() {
  if (mapaMrtva) return;
  trasyStav.zapnuto = !trasyStav.zapnuto;
  obnovTlacitkoTras();
  try {
    localStorage.setItem('dobyvatelTrasy',
        trasyStav.zapnuto ? 'ano' : 'ne');
  } catch (e) { }
  if (!trasyStav.nacteno) { nactiTrasy(); return; }
  trasyVrstvy.forEach(function (id) {
    try {
      mapa.setLayoutProperty(id, 'visibility',
          trasyStav.zapnuto ? 'visible' : 'none');
    } catch (e) { }
  });
}

function nactiTrasy() {
  if (trasyStav.nacita) return;
  trasyStav.nacita = true;
  if (tlacitkoTras) tlacitkoTras.textContent = 'Trasy…';
  fetch('data/trasy.json?v=49')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      trasyStav.nacteno = true;
      trasyStav.nacita = false;
      if (tlacitkoTras) tlacitkoTras.textContent = 'Trasy';
      var barvy = { r: '#c62f2f', b: '#1668b4',
                    g: '#2c8f43', y: '#c9a50e' };
      var viditelnost = trasyStav.zapnuto ? 'visible' : 'none';
      trasyVrstvy = [];
      Object.keys(barvy).forEach(function (k) {
        // vlastnosti úseku: z = význam sítě (0 lwn … 3 iwn),
        // v = 1 když je úsek ZA HRANICÍ ČR (přání 30. 8.: ztlumit)
        var vlastnosti = d[k + 'p'] || [];
        var fc = { type: 'FeatureCollection',
          features: (d[k] || []).map(function (u, idx) {
            var body2 = [];
            for (var i = 0; i < u.length - 1; i += 2) {
              body2.push([u[i + 1] / 1e5, u[i] / 1e5]);
            }
            var p = vlastnosti[idx] || 0;
            return { type: 'Feature',
              properties: { z: p & 3, v: (p & 4) ? 1 : 0 },
              geometry: { type: 'LineString', coordinates: body2 } };
          }) };
        mapa.addSource('trasa-' + k, { type: 'geojson', data: fc });
        // velké známé trasy (národní/mezinárodní síť) už z dálky…
        mapa.addLayer({ id: 'trasa-' + k + '-hl', type: 'line',
          source: 'trasa-' + k, minzoom: 6.5,
          filter: ['>=', ['get', 'z'], 2],
          layout: { visibility: viditelnost, 'line-cap': 'round' },
          paint: { 'line-color': barvy[k],
            'line-width': ['interpolate', ['linear'], ['zoom'],
              6.5, 1.4, 10, 2.3, 13, 3, 16, 4],
            'line-opacity': ['case', ['==', ['get', 'v'], 1],
              0.25, 0.92] } }, 'vlajky-jmena');
        // …ostatní se vykreslí až po přiblížení
        mapa.addLayer({ id: 'trasa-' + k, type: 'line',
          source: 'trasa-' + k, minzoom: 9.6,
          filter: ['<', ['get', 'z'], 2],
          layout: { visibility: viditelnost, 'line-cap': 'round' },
          paint: { 'line-color': barvy[k],
            'line-width': ['interpolate', ['linear'], ['zoom'],
              9.6, 1, 13, 2.2, 16, 3.4],
            'line-opacity': ['case', ['==', ['get', 'v'], 1],
              0.22, 0.8] } }, 'vlajky-jmena');
        trasyVrstvy.push('trasa-' + k + '-hl', 'trasa-' + k);
      });
    })
    .catch(function () {
      trasyStav.nacita = false;
      trasyStav.zapnuto = false;
      obnovTlacitkoTras();
      if (tlacitkoTras) tlacitkoTras.textContent = 'Trasy';
    });
}

/* ── INFORMATIVNÍ MÍSTA (přání 30. 8.) — kandidáti, kteří se
   nestali vlajkou (vyhlídky u silných míst, řopíky, hřebenové
   kóty…). Jen na koukání: přítomnost se počítá u hlavního bodu. ── */
function nactiMistaInfo() {
  fetch('data/mista_info.json?v=49')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      mistaInfoSeznam = d;
      var fc = { type: 'FeatureCollection',
        features: d.map(function (m) {
          return { type: 'Feature',
            properties: { k: m[0], n: m[3],
              lat: m[1] / 1e5, lon: m[2] / 1e5 },
            geometry: { type: 'Point',
              coordinates: [m[2] / 1e5, m[1] / 1e5] } };
        }) };
      mapa.addSource('mista-info', { type: 'geojson', data: fc });
      // pod jmény vlajek = ustoupí všemu, co je důležitější
      mapa.addLayer({ id: 'info-mista', type: 'symbol',
        source: 'mista-info', minzoom: 11.6,
        layout: {
          'icon-image': ['concat', 'ik-', ['get', 'k']],
          'icon-size': ['interpolate', ['linear'], ['zoom'],
            11.6, 0.26, 14, 0.34, 17, 0.6],
          'icon-padding': 2,
        },
        paint: { 'icon-opacity': 0.55 },
      }, 'vlajky-jmena');
      mapa.on('mousemove', 'info-mista', function (e) {
        mapa.getCanvas().style.cursor = 'pointer';
        var f = e.features && e.features[0];
        if (!f || !f.properties.n) return;
        jmenovka.setLngLat(f.geometry.coordinates)
          .setText(f.properties.n).addTo(mapa);
      });
      mapa.on('mouseleave', 'info-mista', function () {
        mapa.getCanvas().style.cursor = '';
        jmenovka.remove();
      });
    })
    .catch(function () { });
}

/* Zeměpisná vata pryč, historie dopředu (výtka 29. 8.: „že je to
   15 km od města moc zajímavé čtení není"). */
function zajimavyUryvek(extract) {
  var vety = extract.match(/[^.!?]+[.!?]+(\s|$)/g) || [extract];
  var vata = /(se nach[aá]z[ií]|le[žz][ií]c?[ií]?\s|km\s|kilometr|severn[ěe]|ji[žz]n[ěe]|v[yý]chodn[ěe]|z[aá]padn[ěe]|v okres[eu]|okres\s|kraj[ie]?\s|nadmo[řr]sk|katastr[aá]ln|sou[čc][aá]st[ií]?\s|eviduje se|po[čc]et obyvatel)/i;
  var zajimave = /(zalo[žz]|zm[ií]nk|stolet[ií]|kr[aá]l|c[ií]sa[řr]|postav|vystav[ěe]|p[řr]estav|vyho[řr]|zbo[řr]|zanik|pov[ěe]st|bitv|obl[eé]h|rod\s|p[aá]n[ůu]|got|renesan|barok|roku?\s\d|v roce)/i;
  var dobre = [];
  var ostatni = [];
  vety.forEach(function (veta) {
    var t = veta.trim();
    if (!t) return;
    if (zajimave.test(t)) dobre.push(t);
    else if (!vata.test(t)) ostatni.push(t);
  });
  var vybrane = dobre.concat(ostatni);
  if (!vybrane.length) vybrane = [vety[0].trim()];
  var u = '';
  for (var i = 0; i < vybrane.length && u.length < 240; i++) {
    u += (u ? ' ' : '') + vybrane[i];
  }
  if (u.length > 320) u = u.slice(0, 317) + '…';
  return u;
}

/* Kandidátní názvy článku: „zámek Molitorov" → i „Molitorov";
   „Vyhlídka · Kostelec…" → i část za tečkou. Každý kandidát se
   OVĚŘUJE souřadnicemi — špatný článek se nikdy neukáže. */
function kandidatiWiki(n) {
  var ven = [n];
  var bez = n.replace(/^(z[řr][ií]cenina\s+hradu|z[řr][ií]cenina|hrad|z[aá]me[čc]ek|z[aá]mek|tvrz|rozhledna|vodop[aá]d|jeskyn[ěe]|vyhl[ií]dka|propast)\s+/i, '');
  if (bez !== n && bez.length > 2) ven.push(bez);
  var casti = n.split('·');
  if (casti.length > 1) {
    var za = casti[1].trim();
    if (za.length > 2 && ven.indexOf(za) < 0) ven.push(za);
  }
  return ven.slice(0, 3);
}

function pridejWiki(box, v) {
  var muj = ++wikiBeh;
  var radek = document.createElement('div');
  radek.style.cssText = 'margin-top:6px;padding-top:6px;'
    + 'border-top:1px dashed #b9b2a0;';
  box.appendChild(radek);
  var klic = v.n + '|' + v.lat;
  function vykresli(z) {
    if (muj !== wikiBeh) return;
    if (!z) { radek.remove(); return; }
    radek.textContent = '';
    var text = document.createElement('span');
    text.textContent = z.uryvek + ' ';
    radek.appendChild(text);
    var a = document.createElement('a');
    a.href = z.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = (z.titul ? z.titul + ' — Wikipedie'
                             : 'Wikipedie') + ' →';
    radek.appendChild(a);
  }
  if (klic in wikiKes) { vykresli(wikiKes[klic]); return; }
  radek.textContent = 'Hledám popis…';
  var kandidati = kandidatiWiki(v.n);
  // poslední záchrana: NEJBLIŽŠÍ článek podle souřadnic (350 m) —
  // vzdálenost je ověření sama o sobě (přání 30. 8.: „dost obrázků
  // stále nemá žádnou informaci")
  function geoHledej() {
    fetch('https://cs.wikipedia.org/w/api.php?action=query'
        + '&list=geosearch&gscoord=' + v.lat + '%7C' + v.lon
        + '&gsradius=350&gslimit=5&format=json&origin=*')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var g = ((d.query || {}).geosearch || []);
        if (!g.length) {
          wikiKes[klic] = null;
          vykresli(null);
          return;
        }
        // vodní toky mají bod „někde na čáře" — blízkost klame,
        // přednost dostane skutečné místo (Černochov > Mšenský potok)
        var pevne = g.filter(function (x) {
          return !/potok|přítok|řeka/i.test(x.title);
        });
        var titul = (pevne.length ? pevne[0] : g[0]).title;
        return fetch(
            'https://cs.wikipedia.org/api/rest_v1/page/summary/'
            + encodeURIComponent(titul.replace(/ /g, '_')))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (s2) {
            if (s2 && s2.extract) {
              var z = { uryvek: zajimavyUryvek(s2.extract),
                titul: titul,
                url: (s2.content_urls && s2.content_urls.desktop
                      && s2.content_urls.desktop.page)
                  || ('https://cs.wikipedia.org/wiki/'
                      + encodeURIComponent(titul)) };
              wikiKes[klic] = z;
              vykresli(z);
            } else {
              wikiKes[klic] = null;
              vykresli(null);
            }
          });
      })
      .catch(function () { wikiKes[klic] = null; vykresli(null); });
  }
  function zkus(i) {
    if (i >= kandidati.length) {
      geoHledej();
      return;
    }
    fetch('https://cs.wikipedia.org/api/rest_v1/page/summary/'
        + encodeURIComponent(kandidati[i].replace(/ /g, '_')))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        // OVĚŘENÍ: článek musí být zeměpisně tam, kde vlajka
        if (d && d.extract && d.coordinates
            && Math.abs(d.coordinates.lat - v.lat) < 0.023
            && Math.abs(d.coordinates.lon - v.lon) < 0.035) {
          var z = { uryvek: zajimavyUryvek(d.extract),
                url: (d.content_urls && d.content_urls.desktop
                      && d.content_urls.desktop.page)
                  || ('https://cs.wikipedia.org/wiki/'
                      + encodeURIComponent(kandidati[i])) };
          wikiKes[klic] = z;
          vykresli(z);
        } else {
          zkus(i + 1);
        }
      })
      .catch(function () { zkus(i + 1); });
  }
  zkus(0);
}

/* ── VÝBĚR MÍST (maska soutěže) ── */
var nStd = 0;              // počet standardních vlajek (bez vlastních)
var okresyLegenda = [];    // [[okresKlic, krajKlic], …] dle indexu
var filtrDruhu = null;     // Set zapnutých druhů (null = všechny)

function aplikujFiltrDruhu() {
  if (!mapa) return;
  var vse = !filtrDruhu
    || filtrDruhu.size >= Object.keys(POPISKY_DRUHU).length;
  var kindF = vse ? null
    : ['in', ['get', 'k'], ['literal', Array.from(filtrDruhu)]];
  function slozeny(zaklad) {
    return kindF ? ['all'].concat(zaklad).concat([kindF])
                 : ['all'].concat(zaklad);
  }
  try {
    [4, 3, 2, 1].forEach(function (p) {
      mapa.setFilter('vlajky-ik' + p, slozeny(
        [['==', ['get', 'p'], p],
         ['!=', ['coalesce', ['get', 'akt'], 1], 0]]));
    });
    mapa.setFilter('vlajky-ik-vse', slozeny(
      [['!=', ['coalesce', ['get', 'akt'], 1], 0]]));
    mapa.setFilter('orientacni', slozeny(
      [['==', ['get', 'p'], 4],
       ['==', ['coalesce', ['get', 'akt'], 1], 0]]));
    mapa.setFilter('vlajky-jmena', kindF);
  } catch (e) { /* vrstvy ještě nestojí */ }
}
var vlastniFC = { type: 'FeatureCollection', features: [] };
var maskaAktivni = null;   // pole bool dle indexu vlajky (null = vše)
var rezimVyberu = false;   // správce právě kliká výběr na mapě
var vyberDruhu = null;     // {druh: bool} — kterých druhů se klik týká

function rozbalMasku(b64) {
  try {
    var bin = atob(b64);
    var ven = new Array(nStd);
    for (var i = 0; i < nStd; i++) {
      var bajt = bin.charCodeAt(i >> 3) || 0;
      ven[i] = !!(bajt & (1 << (i & 7)));
    }
    return ven;
  } catch (e) { return null; }
}

function zabalMasku(pole) {
  var bajty = new Uint8Array(Math.ceil(pole.length / 8));
  for (var i = 0; i < pole.length; i++) {
    if (pole[i]) bajty[i >> 3] |= (1 << (i & 7));
  }
  var bin = '';
  for (var j = 0; j < bajty.length; j++) {
    bin += String.fromCharCode(bajty[j]);
  }
  return btoa(bin);
}

/* Promítne masku (nebo rozpracovaný výběr) do vlastnosti `akt`. */
function aplikujMasku(pole) {
  if (!body || !oblasti) return;
  for (var i = 0; i < body.features.length; i++) {
    // vlastní místa (index za maskou) hrají vždy
    var a = (!pole || i >= pole.length || pole[i]) ? 1 : 0;
    body.features[i].properties.akt = a;
    oblasti.features[i].properties.akt = a;
  }
  spocitejPasma(pole);
  if (mapa) {
    var z1 = mapa.getSource('body');
    var z2 = mapa.getSource('oblasti');
    if (z1) z1.setData(body);
    if (z2) z2.setData(oblasti);
  }
  vypisSkoreZnovu();
}

/* Kruhové území vlastního místa (poloměr = dosah soutěže). */
function kruhPolygon(lat, lon, polomerM) {
  var dLat = polomerM / 111320.0;
  var dLon = polomerM / (111320.0 * Math.cos(lat * Math.PI / 180));
  var body2 = [];
  for (var i = 0; i <= 28; i++) {
    var a = i / 28 * 2 * Math.PI;
    body2.push([lon + Math.cos(a) * dLon, lat + Math.sin(a) * dLat]);
  }
  return { type: 'Polygon', coordinates: [body2] };
}

/* Vlastní místa soutěže → mapa (body 🚩 + kruhová území). Index
   vlastního místa = nStd + pořadí v poli (SMLOUVA s rozhodčím). */
function zapracujVlastni(pole) {
  if (!body || !oblasti || !nStd) return;
  vlajky.length = nStd;
  body.features.length = nStd;
  oblasti.features.length = nStd;   // kruhy už do oblastí NEpatří
  vlastniFC.features.length = 0;
  var dosah = ((soutezDoc && soutezDoc.pravidla) || {}).dosahM || 150;
  (pole || []).forEach(function (v, j) {
    var idx = nStd + j;
    vlajky.push({ n: v.n, h: v.h || 2, k: 'vlastni',
                  lat: v.lat, lon: v.lon });
    body.features.push({ type: 'Feature', id: idx,
      properties: { n: v.n, h: v.h || 2, t: '0', k: 'vlastni',
                    p: 4, akt: 1 },
      geometry: { type: 'Point', coordinates: [v.lon, v.lat] } });
    vlastniFC.features.push({ type: 'Feature', id: idx,
      properties: { t: '0' },
      geometry: kruhPolygon(v.lat, v.lon, dosah) });
  });
  if (mapa) {
    var zdrojV = mapa.getSource('vlastni');
    if (zdrojV) zdrojV.setData(vlastniFC);
  }
  // při editaci se promítá ROZPRACOVANÝ výběr (ostrá maska mazala
  // rozklikaná místa — výtka „naklikaná z mapy zmizela")
  aplikujMasku(rezimVyberu && maskaRozpracovana
      ? maskaRozpracovana : maskaAktivni);
}

function prepniMisto(idx) {
  if (!maskaRozpracovana) return;
  // klik funguje VŽDY (výtka „klikání moc nefunguje" — druhový
  // filtr tiše blokoval); zaškrtnutí druhů řídí jen hromadná tlačítka
  maskaRozpracovana[idx] = !maskaRozpracovana[idx];
  aplikujMasku(maskaRozpracovana);
  obnovPocetVyberu();
}

var maskaRozpracovana = null;
var panelVyberu = null;
var rezimPridani = false;      // další klik do mapy přidá vlastní místo
var pracovniVlastni = null;    // rozpracované pole vlastních míst

function obnovPocetVyberu() {
  var pocet = 0;
  for (var i = 0; i < maskaRozpracovana.length; i++) {
    if (maskaRozpracovana[i]) pocet++;
  }
  var b = document.getElementById('vyberUlozit');
  if (b) b.textContent = 'Uložit výběr (' + pocet + ' míst)';
  var info = document.getElementById('vyberInfo');
  if (info) {
    var dosah = vyberVolby
      ? 150
      : (((soutezDoc && soutezDoc.pravidla) || {}).dosahM || 150);
    info.textContent = 'Vybráno ' + pocet + ' z mapy · '
      + ((pracovniVlastni && pracovniVlastni.length) || 0)
      + ' vlastních · dosah ' + dosah + ' m';
  }
}

function obnovSeznamVlastnich() {
  var box = document.getElementById('seznamVlastnich');
  if (!box || !pracovniVlastni) return;
  box.textContent = '';
  if (!pracovniVlastni.length) return;
  var nadpis = document.createElement('p');
  nadpis.style.cssText = 'margin:4px 0 2px;font-weight:700;';
  nadpis.textContent = 'Vlastní místa (' + pracovniVlastni.length
    + '):';
  box.appendChild(nadpis);
  pracovniVlastni.forEach(function (v, j) {
    var r = document.createElement('div');
    r.style.cssText =
      'display:flex;align-items:center;gap:6px;margin:1px 0;';
    r.appendChild(document.createTextNode('🚩 ' + v.n));
    var mazatLze = soutezDoc && soutezDoc.stav === 'priprava';
    if (mazatLze) {
      var x = document.createElement('button');
      x.textContent = '×';
      x.onclick = function () {
        pracovniVlastni.splice(j, 1);
        zapracujVlastni(pracovniVlastni);
        obnovSeznamVlastnich();
      };
      r.appendChild(x);
    }
    box.appendChild(r);
  });
}

/* Editor výběru míst: panel nad mapou + klikání do území. */
var vyberVolby = null;   // konfigurace běžícího editoru

/* Editor míst. Bez voleb = SPRÁVA běžící soutěže (uloží rovnou do
   dokumentu). S volbami {maska, vlastni, dosah, poUlozeni} = výběr
   při ZAKLÁDÁNÍ (uloží se do formuláře, dokument vznikne až se
   soutěží). */
var titulekPredEditaci = null;

function zapniVyberMist(volby) {
  if (mapaMrtva) {
    alert('Bez mapy (WebGL) nejde místa vybírat — viz rada u mapy.');
    return;
  }
  vyberVolby = volby || null;
  prepniZalozku('mapa');
  rezimVyberu = true;
  // VLASTNÍ OBRAZOVKA ÚPRAV (výtka 29. 8.: „vypadá to, že jsem šel
  // na mapu") — menu se schová a nadpis řekne, co se děje
  document.body.classList.add('rezim-editace');
  var tit = el('titulek');
  if (tit) {
    titulekPredEditaci = tit.textContent;
    tit.textContent = '✏️ Úprava míst — '
      + (vyberVolby ? 'nová soutěž'
         : ((soutezDoc && soutezDoc.nazev) || SOUTEZ));
  }
  try {
    if (!mapa.getLayer('vyber-ram')) {
      // vybraná místa dostávají zelené orámování — ať je NA PRVNÍ
      // POHLED vidět, co je vybrané (výtka „složité")
      mapa.addLayer({ id: 'vyber-ram', type: 'line',
        source: 'oblasti',
        filter: ['==', ['coalesce', ['get', 'akt'], 1], 1],
        paint: { 'line-color': '#2E7D32', 'line-width': 2,
                 'line-opacity': 0.85 } });
    }
  } catch (e) { }
  // NOVÝ výběr začíná PRÁZDNÝ a klik místa PŘIDÁVÁ (výtka 27. 8.:
  // začínalo se vším a klik vypínal — uživatel si „vybraná" místa
  // omylem vyřadil); uložený výběr se načítá, jak je
  var vychoziMaska = vyberVolby ? vyberVolby.maska : maskaAktivni;
  maskaRozpracovana = vychoziMaska
    ? vychoziMaska.slice(0, nStd)
    : null;
  if (!maskaRozpracovana || maskaRozpracovana.length !== nStd) {
    maskaRozpracovana = [];
    for (var mi = 0; mi < nStd; mi++) {
      maskaRozpracovana.push(vychoziMaska
          ? !!vychoziMaska[mi] : false);
    }
  }
  vyberDruhu = {};
  Object.keys(POPISKY_DRUHU).forEach(function (k) {
    vyberDruhu[k] = true;
  });
  var obal = el('mapa');
  // JASNÝ PRUH přes mapu — ať je poznat, že se právě UPRAVUJE
  // (výtka 28. 8.: „tváří se to, že jsem šel na mapu")
  var prouzek = document.createElement('div');
  prouzek.id = 'editorProuzek';
  prouzek.style.cssText = 'position:absolute;left:50%;top:10px;'
    + 'transform:translateX(-50%);z-index:7;background:#C99B3F;'
    + 'color:#2b2416;font:700 13.5px sans-serif;padding:8px 16px;'
    + 'border-radius:10px;box-shadow:0 3px 10px rgba(0,0,0,.3);'
    + 'max-width:82%;text-align:center;';
  prouzek.textContent = '✏️ Upravuješ místa soutěže — klikej do '
    + 'mapy; ulož nebo zruš v panelu vpravo.';
  obal.appendChild(prouzek);
  panelVyberu = document.createElement('div');
  panelVyberu.style.cssText = 'position:absolute;right:10px;top:10px;'
    + 'z-index:6;background:rgba(255,253,246,.96);border:1px solid '
    + '#b9b2a0;border-radius:10px;padding:8px 10px;max-height:86%;'
    + 'overflow:auto;font:12px sans-serif;width:252px;';
  var nadpis = document.createElement('p');
  nadpis.style.cssText = 'margin:0 0 2px;font-weight:700;'
    + 'font-size:13px;';
  nadpis.textContent = 'Místa — klikej do mapy';
  panelVyberu.appendChild(nadpis);
  var info = document.createElement('p');
  info.id = 'vyberInfo';
  info.style.cssText = 'margin:0 0 6px;color:#6b6455;';
  panelVyberu.appendChild(info);
  var pozn = document.createElement('p');
  pozn.style.cssText = 'margin:0 0 6px;color:#6b6455;';
  pozn.textContent = 'Klik místo přidá, další klik vyřadí. Vybraná '
    + 'jsou zeleně orámovaná. Druhy níž platí pro hromadná tlačítka.';
  panelVyberu.appendChild(pozn);
  var mrizkaD = document.createElement('div');
  mrizkaD.style.cssText = 'display:grid;'
    + 'grid-template-columns:1fr 1fr;gap:0 6px;';
  Object.keys(POPISKY_DRUHU).forEach(function (k) {
    var radek = document.createElement('label');
    radek.style.cssText = 'display:flex;gap:4px;align-items:center;'
      + 'margin:1px 0;font-size:11.5px;';
    var ch = document.createElement('input');
    ch.type = 'checkbox';
    ch.checked = true;
    ch.onchange = function () { vyberDruhu[k] = ch.checked; };
    radek.appendChild(ch);
    radek.appendChild(
        document.createTextNode(POPISKY_DRUHU[k]));
    mrizkaD.appendChild(radek);
  });
  panelVyberu.appendChild(mrizkaD);
  function hromadne(zapnout) {
    for (var i = 0; i < vlajky.length; i++) {
      if (vyberDruhu[vlajky[i].k]) maskaRozpracovana[i] = zapnout;
    }
    aplikujMasku(maskaRozpracovana);
    obnovPocetVyberu();
  }
  var radekTl = document.createElement('p');
  radekTl.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;'
    + 'margin:8px 0 0;';
  [['Zapnout druhy', true], ['Vypnout druhy', false]]
    .forEach(function (par) {
      var t = document.createElement('button');
      t.textContent = par[0];
      t.onclick = function () { hromadne(par[1]); };
      radekTl.appendChild(t);
    });
  // vlastní místa (jen v přípravě — po startu je pořadí smlouva)
  pracovniVlastni = ((vyberVolby
      ? vyberVolby.vlastni
      : (soutezDoc && soutezDoc.vlastni)) || [])
    .map(function (v) { return { n: v.n, lat: v.lat, lon: v.lon,
                                 h: v.h || 2 }; });
  if (vyberVolby
      || (soutezDoc && soutezDoc.stav === 'priprava')) {
    var pridej = document.createElement('button');
    pridej.textContent = '+ Vlastní místo (pak klikni do mapy)';
    pridej.style.cssText = 'margin:6px 0;font-weight:700;';
    pridej.onclick = function () {
      rezimPridani = true;
      pridej.textContent = 'Klikni do mapy — kamkoli…';
      setTimeout(function () {
        pridej.textContent = '+ Vlastní místo (pak klikni do mapy)';
      }, 4000);
    };
    panelVyberu.appendChild(pridej);
  }
  var seznamVlastnich = document.createElement('div');
  seznamVlastnich.id = 'seznamVlastnich';
  panelVyberu.appendChild(seznamVlastnich);

  var obrat = document.createElement('button');
  obrat.textContent = 'Obrátit výběr';
  obrat.onclick = function () {
    for (var i = 0; i < maskaRozpracovana.length; i++) {
      maskaRozpracovana[i] = !maskaRozpracovana[i];
    }
    aplikujMasku(maskaRozpracovana);
    obnovPocetVyberu();
  };
  radekTl.appendChild(obrat);
  var uloz = document.createElement('button');
  uloz.id = 'vyberUlozit';
  uloz.style.fontWeight = '700';
  uloz.onclick = function () {
    var vsechna = maskaRozpracovana.every(function (x) { return x; });
    if (!maskaRozpracovana.some(function (x) { return x; })
        && !(pracovniVlastni && pracovniVlastni.length)) {
      alert('Vyber aspoň jedno místo — soutěž bez míst nejde hrát.');
      return;
    }
    if (vyberVolby) {
      // ZALOŽENÍ: výběr si převezme formulář, dokument vznikne až
      // se soutěží (návrat řeší vypniVyberMist)
      vyberVolby.poUlozeni(vsechna ? null : maskaRozpracovana,
          pracovniVlastni || []);
      vypniVyberMist(false);
      return;
    }
    uloz.disabled = true;
    zapisDoc('souteze/' + SOUTEZ, {
      maska: vsechna ? '' : zabalMasku(maskaRozpracovana),
      vlastni: pracovniVlastni || [],
    }).then(function () {
        maskaAktivni = vsechna ? null : maskaRozpracovana;
        soutezDoc.maska = vsechna ? '' : 'x';
        soutezDoc.vlastni = pracovniVlastni;
        vypniVyberMist(true);
      })
      .catch(function () { uloz.disabled = false; });
  };
  var zrus = document.createElement('button');
  zrus.textContent = 'Zrušit';
  zrus.onclick = function () { vypniVyberMist(false); };
  radekTl.appendChild(uloz);
  radekTl.appendChild(zrus);
  panelVyberu.appendChild(radekTl);
  obal.appendChild(panelVyberu);
  obnovPocetVyberu();
  obnovSeznamVlastnich();
  zapracujVlastni(pracovniVlastni);
  aplikujMasku(maskaRozpracovana);
}

function vypniVyberMist(ulozeno) {
  var zFormulare = !!vyberVolby;
  rezimVyberu = false;
  rezimPridani = false;
  vyberVolby = null;
  document.body.classList.remove('rezim-editace');
  var tit = el('titulek');
  if (tit && titulekPredEditaci !== null) {
    tit.textContent = titulekPredEditaci;
    titulekPredEditaci = null;
  }
  var prouzek = document.getElementById('editorProuzek');
  if (prouzek) prouzek.remove();
  if (panelVyberu) { panelVyberu.remove(); panelVyberu = null; }
  maskaRozpracovana = null;
  try {
    if (mapa.getLayer('vyber-ram')) mapa.removeLayer('vyber-ram');
  } catch (e) { }
  // zpět pohled uložené soutěže (zrušení zahodí i rozpracovaná
  // vlastní místa)
  zapracujVlastni((soutezDoc && soutezDoc.vlastni) || []);
  // návrat do Moje soutěže (přání: úpravy drž tam, ne v Mapě)
  prepniZalozku('moje');
  prepniPodzalozku(zFormulare ? 'zalozit' : 'prehled');
}

function obarvi(drzitele) {
  for (var i = 0; i < oblasti.features.length; i++) {
    var f = oblasti.features[i];
    f.properties.t = (drzitele && drzitele[f.id]) || '0';
  }
  for (var j = 0; j < body.features.length; j++) {
    body.features[j].properties.t = (drzitele && drzitele[j]) || '0';
  }
  for (var k2 = 0; k2 < vlastniFC.features.length; k2++) {
    var fv = vlastniFC.features[k2];
    fv.properties.t = (drzitele && drzitele[fv.id]) || '0';
  }
  if (!mapa) return;   // bez WebGL jen data (skóre, žebříčky)
  var zdroj = mapa.getSource('oblasti');
  if (zdroj) zdroj.setData(oblasti);
  var zdrojB = mapa.getSource('body');
  if (zdrojB) zdrojB.setData(body);
  var zdrojV = mapa.getSource('vlastni');
  if (zdrojV) zdrojV.setData(vlastniFC);
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
  for (var v = 0; v < vlajky.length; v++) {
    if (!maskaAktivni || v >= maskaAktivni.length
        || maskaAktivni[v]) {
      suma += vlajky[v].h || 0;
    }
  }
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
    (function (klic, b2, p2) {
      r.onmouseenter = function () { ukazTymTip(klic, b2, p2, r); };
      r.onmouseleave = schovejTymTip;
    })(radky[i].t.klic, radky[i].body, pct.textContent);
    tab.appendChild(r);
  }
}

/* Detail týmu po najetí na řádek skóre (přání 27. 8.). */
var posledniDrziteleArr = null;
var posledniDobyto = null;
var posledniClenove = null;
var tymTip = null;

function schovejTymTip() {
  if (tymTip) { tymTip.remove(); tymTip = null; }
}

function ukazTymTip(klic, body2, pct, radekEl) {
  schovejTymTip();
  tymTip = document.createElement('div');
  tymTip.style.cssText = 'position:fixed;z-index:40;'
    + 'background:#fffdf6;border:1px solid #b9b2a0;'
    + 'border-radius:10px;padding:8px 12px;font:12.5px sans-serif;'
    + 'box-shadow:0 3px 10px rgba(0,0,0,.2);pointer-events:none;'
    + 'max-width:250px;';
  function radek(text, tucne) {
    var p = document.createElement('div');
    if (tucne) p.style.fontWeight = '700';
    p.textContent = text;
    tymTip.appendChild(p);
  }
  radek(jmenoTymu(klic), true);
  radek('Členů: ' + ((posledniClenove
      && posledniClenove[klic]) != null
      ? posledniClenove[klic] : '–'));
  var vlajek = 0;
  if (posledniDrziteleArr) {
    for (var i = 0; i < posledniDrziteleArr.length; i++) {
      if (posledniDrziteleArr[i] === klic) vlajek++;
    }
  }
  radek('Drží vlajek: ' + vlajek);
  radek('Body: ' + body2 + (pct ? ' (' + pct + ')' : ''));
  var okresu = 0;
  var krajeT = [];
  if (posledniDobyto) {
    var ok = posledniDobyto.okresy || {};
    for (var o in ok) { if (ok[o] === klic) okresu++; }
    var kr = posledniDobyto.kraje || {};
    for (var k2 in kr) {
      if (kr[k2] === klic) krajeT.push(nazevKraje(k2));
    }
  }
  radek('Dobyté okresy: ' + okresu);
  if (krajeT.length) radek('Dobyté kraje: ' + krajeT.join(', '));
  document.body.appendChild(tymTip);
  var rect = radekEl.getBoundingClientRect();
  tymTip.style.left = (rect.left - 10) + 'px';
  tymTip.style.top = Math.max(8, rect.top - 6) + 'px';
  tymTip.style.transform = 'translateX(-100%)';
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

/* ── PŘEPÍNAČ SOUTĚŽE NA KARTĚ MAPA (přání 27. 8.) ──
   Uživatel musí IHNED vědět, na co se dívá, a rychle přepnout. */
var mojeVolby = null;      // {hraju: [...], spravuju: [...]}
var verejneCache = null;   // schválené veřejné soutěže

function naplnVolbuSouteze() {
  var box = el('soutezVolba');
  if (!box) return;
  box.textContent = '';
  var stitek = document.createElement('strong');
  stitek.textContent = 'Díváš se na soutěž:';
  box.appendChild(stitek);
  var sel = document.createElement('select');
  sel.style.cssText = 'padding:5px 8px;max-width:340px;';
  function pridat(sid, text) {
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === sid) return;
    }
    var o = document.createElement('option');
    o.value = sid;
    o.textContent = text;
    if (sid === SOUTEZ) o.selected = true;
    sel.appendChild(o);
  }
  pridat('cesko-2026', 'Česko 2026 — republikové kolo');
  if (mojeVolby) {
    mojeVolby.hraju.forEach(function (r) {
      pridat(r.sid, r.text);
    });
    mojeVolby.spravuju.forEach(function (r) {
      pridat(r.sid, r.text + ' — spravuji');
    });
  }
  (verejneCache || []).forEach(function (s2) {
    pridat(s2._id, (s2.nazev || s2._id) + ' — veřejná');
  });
  if (vlastniSoutez()) {
    pridat(SOUTEZ, (soutezDoc && soutezDoc.nazev) || SOUTEZ);
  }
  sel.onchange = function () {
    location.href = sel.value === 'cesko-2026'
      ? '/dobyvatel/'
      : '/dobyvatel/?s=' + sel.value;
  };
  box.appendChild(sel);
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
    // HRAJU × SPRAVUJI odděleně (smíchané to byl bordel — 27. 8.)
    var hraju = [];
    if (v[1]) {
      hraju.push({ sid: 'cesko-2026',
        text: 'Česko 2026 — tým ' + jmenoTymu(v[1].tym) });
    }
    v[2].filter(Boolean).forEach(function (p) {
      hraju.push({ sid: p.s._id,
        text: (p.s.nazev || p.s._id) + ' — tým '
          + ((p.s.tymyNazvy || {})[p.c.tym]
             || jmenoTymu(p.c.tym)) });
    });
    var spravuju = v[0].map(function (s2) {
      return { sid: s2._id, doc: s2,
        text: (s2.nazev || s2._id) + ' ('
          + (s2.stav === 'bezi' ? 'běží'
             : s2.stav === 'konec' ? 'skončila' : 'příprava')
          + ')' };
    });
    mojeVolby = { hraju: hraju, spravuju: spravuju };
    naplnVolbuSouteze();
    function sekce(nadpis, seznam, poznamka) {
      if (!seznam.length) return;
      var h = document.createElement('p');
      h.style.cssText = 'margin:8px 0 2px;font-weight:700;';
      h.textContent = nadpis;
      box.appendChild(h);
      seznam.forEach(function (r) {
        var p = document.createElement('p');
        p.style.margin = '3px 0 3px 12px';
        var a = document.createElement('a');
        a.href = '?s=' + r.sid;
        a.textContent = r.text;
        p.appendChild(a);
        if (poznamka) {
          p.appendChild(document.createTextNode(' · '));
          var a2 = document.createElement('a');
          a2.href = '?s=' + r.sid;
          a2.textContent = 'Správa';
          p.appendChild(a2);
        }
        box.appendChild(p);
      });
    }
    if (!hraju.length && !spravuju.length) {
      box.textContent = 'Zatím nejsi v žádné soutěži. Otevři '
        + 'v aplikaci režim Dobyvatel, nebo si soutěž založ '
        + 'v podzáložce Založení.';
      return;
    }
    sekce('Hraju', hraju, false);
    if (spravuju.length) {
      var hS = document.createElement('p');
      hS.style.cssText = 'margin:8px 0 2px;font-weight:700;';
      hS.textContent = 'Spravuji';
      box.appendChild(hS);
      spravuju.forEach(function (r) {
        var p = document.createElement('p');
        p.style.margin = '3px 0 3px 12px';
        var a = document.createElement('a');
        a.href = '?s=' + r.sid;
        a.textContent = r.text;
        p.appendChild(a);
        p.appendChild(document.createTextNode(' '));
        var tl = document.createElement('button');
        tl.textContent = 'Spravovat';
        var rozbal = document.createElement('div');
        rozbal.style.cssText = 'display:none;margin:6px 0 10px 12px;'
          + 'padding:10px 12px;border:1px solid var(--linka);'
          + 'border-radius:10px;background:#faf7ee;';
        tl.onclick = function () {
          var otevrit = rozbal.style.display === 'none';
          if (otevrit && !rozbal.hasChildNodes()) {
            renderSprava(r.sid, r.doc, rozbal);
          }
          rozbal.style.display = otevrit ? 'block' : 'none';
          tl.textContent = otevrit ? 'Skrýt správu' : 'Spravovat';
        };
        p.appendChild(tl);
        box.appendChild(p);
        box.appendChild(rozbal);
      });
    }
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
      // proti spamu: cizí soutěž se ve veřejném seznamu ukáže až po
      // schválení (pole schvaleno nastavuje správce Okolníku)
      return s2._id !== 'cesko-2026' && s2.stav !== 'konec'
        && s2.schvaleno === true;
    });
    verejneCache = ziva;
    naplnVolbuSouteze();
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
      }
      maskaAktivni = (vlastniSoutez() && d.maska)
        ? rozbalMasku(d.maska) : null;
      if (vlastniSoutez() && d.vlastni && d.vlastni.length) {
        zapracujVlastni(d.vlastni);
      } else if (maskaAktivni) {
        aplikujMasku(maskaAktivni);
      }
      naplnVolbuSouteze();
      var relaceA = nactiRelaci();
      if (relaceA && relaceA.mail === 'stanislavmudra@gmail.com'
          && vlastniSoutez() && d.verejna && d.schvaleno !== true) {
        var boxV = el('soutezVolba');
        if (boxV) {
          var schval = document.createElement('button');
          schval.textContent = 'Schválit zveřejnění (admin)';
          schval.onclick = function () {
            schval.disabled = true;
            zapisDoc('souteze/' + SOUTEZ, { schvaleno: true })
              .then(function () {
                schval.textContent = 'Schváleno ✓';
              })
              .catch(function () { schval.disabled = false; });
          };
          boxV.appendChild(schval);
        }
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
      box.textContent = 'V téhle soutěži hraješ za tým '
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

    // TÝMY: jeden řádek a plus (přání 28. 8.); barva se mění
    // klepnutím na tečku, název je prázdný s nápovědou
    var pozn = document.createElement('p');
    pozn.style.cssText = 'margin:6px 0 2px;font-weight:700;';
    pozn.textContent = 'Týmy (2–14):';
    f.appendChild(pozn);
    var tymBox = document.createElement('div');
    f.appendChild(tymBox);
    var radkyTymu = [];

    function volnaBarva(od) {
      for (var i = 0; i < tymy.length; i++) {
        var kand = tymy[(od + i) % tymy.length].klic;
        var obsazena = radkyTymu.some(function (r) {
          return r.klic === kand;
        });
        if (!obsazena) return kand;
      }
      return null;
    }

    function barvaKlic(klic) {
      for (var i = 0; i < tymy.length; i++) {
        if (tymy[i].klic === klic) return tymy[i].barva;
      }
      return '#888';
    }

    function pridejTymRadek() {
      if (radkyTymu.length >= 14) return;
      var klic = volnaBarva(radkyTymu.length);
      if (!klic) return;
      var r = document.createElement('div');
      r.style.cssText =
        'display:flex;align-items:center;gap:6px;margin:3px 0;';
      var zaznam = { klic: klic, nm: null, radek: r };
      var tecka = document.createElement('span');
      tecka.title = 'Klepnutím změníš barvu';
      function obarviTecku() {
        tecka.style.cssText = 'width:16px;height:16px;border-radius:'
          + '50%;flex:none;cursor:pointer;border:1px solid '
          + 'rgba(0,0,0,.3);background:' + barvaKlic(zaznam.klic)
          + ';';
      }
      obarviTecku();
      tecka.onclick = function () {
        var dalsi = volnaBarva(
            tymy.findIndex(function (t) {
              return t.klic === zaznam.klic;
            }) + 1);
        if (dalsi) { zaznam.klic = dalsi; obarviTecku(); }
      };
      var nm = document.createElement('input');
      nm.placeholder = 'Vyplň název týmu';
      nm.maxLength = 24;
      nm.style.cssText = 'flex:1;padding:3px 6px;';
      zaznam.nm = nm;
      var pryc = document.createElement('button');
      pryc.textContent = '×';
      pryc.title = 'Odebrat tým';
      pryc.onclick = function () {
        if (radkyTymu.length <= 1) return;
        radkyTymu.splice(radkyTymu.indexOf(zaznam), 1);
        r.remove();
      };
      r.appendChild(tecka);
      r.appendChild(nm);
      r.appendChild(pryc);
      tymBox.appendChild(r);
      radkyTymu.push(zaznam);
    }
    pridejTymRadek();
    var plus = document.createElement('button');
    plus.textContent = '+ Přidat tým';
    plus.onclick = function () { pridejTymRadek(); };
    f.appendChild(plus);

    // DALŠÍ NASTAVENÍ (rozbalovací)
    var dalsi = document.createElement('details');
    var shrn = document.createElement('summary');
    shrn.textContent = 'Další nastavení';
    shrn.style.cssText = 'cursor:pointer;font-weight:700;margin:8px 0 4px;';
    dalsi.appendChild(shrn);
    function cislo(popis, vychozi, min, max) {
      var radek = document.createElement('label');
      radek.style.cssText =
        'display:flex;align-items:center;gap:6px;margin:3px 0;';
      var vstup = document.createElement('input');
      vstup.type = 'number';
      vstup.value = vychozi;
      vstup.min = min;
      vstup.max = max;
      vstup.style.cssText = 'width:70px;padding:2px 6px;';
      radek.appendChild(vstup);
      radek.appendChild(document.createTextNode(' ' + popis));
      dalsi.appendChild(radek);
      return vstup;
    }
    var vObsazeni = cislo('minut na dobytí neutrální vlajky', 10, 1, 240);
    var vNeutral = cislo('minut navíc na sebrání držené vlajky', 10, 0, 240);
    var vDenne = cislo('nejvýš zabraných vlajek na hráče a den', 40, 1, 500);
    var vDosah = cislo('metrů dosah od vlajky', 150, 50, 2000);
    var vLhuta = cislo('dní lhůta pro změnu týmu', 30, 0, 365);
    function datum(popis) {
      // stačí DEN (výtka 27. 8.: datetime-local chtěl i čas a bez
      // něj hlásil nevyplněno) a pole je VIDĚT, ne ve skrytých
      var radek = document.createElement('label');
      radek.style.cssText =
        'display:flex;align-items:center;gap:6px;margin:4px 0;';
      var vstup = document.createElement('input');
      vstup.type = 'date';
      radek.appendChild(vstup);
      radek.appendChild(document.createTextNode(' ' + popis));
      f.appendChild(radek);
      return vstup;
    }
    var vZacatek = datum('začátek soutěže (povinné)');
    var vKonec = datum('konec soutěže (povinné)');
    var ffa = document.createElement('label');
    ffa.style.cssText = 'display:block;margin:4px 0;color:#6b6455;';
    var ffaCh = document.createElement('input');
    ffaCh.type = 'checkbox';
    ffaCh.disabled = true;
    ffa.appendChild(ffaCh);
    ffa.appendChild(document.createTextNode(
        ' všichni proti všem (připravujeme)'));
    dalsi.appendChild(ffa);
    f.appendChild(dalsi);

    // VÝBĚR MÍST JE SOUČÁST ZALOŽENÍ (výtka 28. 8.) — bez výběru
    // hraje celá republika
    var vybrano = { maska: null, vlastni: [] };
    var mista = document.createElement('button');
    mista.style.cssText = 'display:block;margin:8px 0;';
    function popisVyberu() {
      if (!vybrano.maska && !vybrano.vlastni.length) {
        return 'Vybrat místa na mapě (teď hraje celá republika)';
      }
      var n = 0;
      if (vybrano.maska) {
        for (var i = 0; i < vybrano.maska.length; i++) {
          if (vybrano.maska[i]) n++;
        }
      } else {
        n = nStd;
      }
      return 'Místa: ' + n + ' z mapy + '
        + vybrano.vlastni.length + ' vlastních — upravit';
    }
    mista.textContent = popisVyberu();
    mista.onclick = function () {
      zapniVyberMist({
        maska: vybrano.maska,
        vlastni: vybrano.vlastni,
        poUlozeni: function (maska2, vlastni2) {
          vybrano.maska = maska2;
          vybrano.vlastni = vlastni2;
          mista.textContent = popisVyberu();
        },
      });
    };
    f.appendChild(mista);

    var zaloz = document.createElement('button');
    zaloz.textContent = 'Založit';
    zaloz.style.marginTop = '8px';
    var zprava = document.createElement('p');
    f.appendChild(zaloz);
    f.appendChild(zprava);
    zaloz.onclick = function () {
      var vybrane = radkyTymu.filter(function (r) {
        return r.nm.value.trim().length > 0;
      });
      if (jmeno.value.trim().length < 3) {
        zprava.textContent = 'Zadejte název (aspoň 3 znaky).';
        return;
      }
      if (vybrane.length < 2) {
        zprava.textContent =
          'Přidej aspoň dva týmy a vyplň jim názvy.';
        return;
      }
      if (!vZacatek.value || !vKonec.value) {
        zprava.textContent = 'Vyplň začátek a konec soutěže.';
        return;
      }
      if (vKonec.value < vZacatek.value) {
        zprava.textContent =
          'Konec soutěže nesmí být před začátkem.';
        return;
      }
      zaloz.disabled = true;
      zprava.textContent = 'Zakládám…';
      var sid = slugSouteze(jmeno.value.trim());
      var nazvy = {};
      vybrane.forEach(function (r) {
        nazvy[r.klic] = r.nm.value.trim().slice(0, 24);
      });
      // ŘÁD PROTI SPAMU: každý účet nejvýš 5 soutěží — registr
      // zalozene/{uid} hlídají i serverová pravidla
      platnyToken().then(function (token) {
        return ctiDoc(ZAKLAD_DOK + 'zalozene/' + relace.uid
            + '?key=' + KLIC, token)
          .catch(function () { return { sids: [] }; });
      }).then(function (reg) {
        var sids = reg.sids || [];
        if (sids.length >= 5) {
          throw new Error('kvota');
        }
        return zapisDoc('zalozene/' + relace.uid,
            { sids: sids.concat([sid]) });
      }).then(function () {
        var prav = {
          obsazeniMin: parseInt(vObsazeni.value, 10) || 10,
          neutralizaceMin: parseInt(vNeutral.value, 10) || 0,
          zabraniDenne: parseInt(vDenne.value, 10) || 40,
          dosahM: parseInt(vDosah.value, 10) || 150,
          zmenaTymuDni: parseInt(vLhuta.value, 10) || 30,
          prahNadoblasti: 0.5,
        };
        prav.zacatek = vZacatek.value + 'T00:00:00Z';
        prav.konec = vKonec.value + 'T23:59:59Z';
        return zapisDoc('souteze/' + sid, {
          nazev: jmeno.value.trim(),
          stav: 'priprava',
          zakladatel: relace.uid,
          verejna: !!verCh.checked,
          pravidla: prav,
          tymyPoradi: vybrane.map(function (r) { return r.klic; }),
          tymyNazvy: nazvy,
          vytvoreno: new Date(),
        }, true);
      }).then(function () {
        // výběr míst z formuláře (create ho mít nesmí — hasOnly)
        if (vybrano.maska || vybrano.vlastni.length) {
          return zapisDoc('souteze/' + sid, {
            maska: vybrano.maska ? zabalMasku(vybrano.maska) : '',
            vlastni: vybrano.vlastni,
          });
        }
        return true;
      }).then(function () {
        location.href = '?s=' + sid;
      }).catch(function (e) {
        zaloz.disabled = false;
        // slot kvóty vrátit, když dokument soutěže neprošel
        platnyToken().then(function (token) {
          return ctiDoc(ZAKLAD_DOK + 'zalozene/' + relace.uid
              + '?key=' + KLIC, token);
        }).then(function (reg) {
          var sids = (reg.sids || []).filter(function (x) {
            return x !== sid;
          });
          return zapisDoc('zalozene/' + relace.uid, { sids: sids });
        }).catch(function () { });
        if (e && e.message === 'kvota') {
          zprava.textContent = 'Vedeš už 5 soutěží — nejdřív '
            + 'některou smaž (v její Správě).';
        } else if (e && /HTTP 40[13]/.test(e.message || '')) {
          zprava.textContent = 'Server založení zamítl — buď je '
            + 'potřeba se znovu přihlásit, nebo v databázi ještě '
            + 'neběží nová pravidla (v6).';
        } else {
          zprava.textContent = 'Založení se nepovedlo — zkuste '
            + 'jiný název, nebo to za chvíli zopakujte.';
        }
      });
    };
    box.appendChild(f);
  };
  box.appendChild(tl);
}

/* Po prokliku „Vybrat místa" ze správy (?editor=1) se editor na
   mapě té soutěže otevře sám. */
function vykresliSpravu() {
  if (!soutezDoc) return;
  var relace = nactiRelaci();
  if (!relace || relace.uid !== soutezDoc.zakladatel) return;
  if (new URLSearchParams(location.search).get('editor') === '1'
      && !rezimVyberu) {
    setTimeout(function () {
      if (!rezimVyberu) zapniVyberMist();
    }, (mapa && mapa.loaded && mapa.loaded()) ? 300 : 1400);
  }
}

/* ── SPRÁVA SOUTĚŽE — kreslí se PŘÍMO u soutěže v Přehledu (výtka
   28. 8.: „ani nevím, co spravuji") ── */
function renderSprava(sid, d, box) {
  var relace = nactiRelaci();
  var jsemSpravce = relace && relace.uid === d.zakladatel;
  if (!jsemSpravce) return;
  box.textContent = '';
  var jeVlastniS = sid !== 'cesko-2026';

  // stav soutěže
  var stavR = document.createElement('p');
  stavR.textContent = 'Stav: ' + (d.stav || '?') + ' ';
  if (d.stav !== 'bezi') {
    var spust = document.createElement('button');
    spust.textContent = 'Spustit soutěž';
    spust.onclick = function () {
      spust.disabled = true;
      zapisDoc('souteze/' + sid, { stav: 'bezi' })
        .then(function () { zapamatujNavrat(); location.reload(); })
        .catch(function () { spust.disabled = false; });
    };
    stavR.appendChild(spust);
  }
  if (d.stav === 'bezi') {
    var konec = document.createElement('button');
    konec.textContent = 'Ukončit soutěž';
    konec.onclick = function () {
      if (!confirm('Opravdu ukončit? Mapa zamrzne v posledním '
          + 'stavu.')) return;
      zapisDoc('souteze/' + sid, { stav: 'konec' })
        .then(function () { zapamatujNavrat(); location.reload(); });
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
  dny.value = ((d.pravidla || {}).zmenaTymuDni) || 30;
  dny.style.cssText = 'width:64px;margin:0 4px;';
  lhutaR.appendChild(dny);
  lhutaR.appendChild(document.createTextNode(' dní '));
  var ulozL = document.createElement('button');
  ulozL.textContent = 'Uložit';
  ulozL.onclick = function () {
    var prav = d.pravidla || {};
    prav.zmenaTymuDni = parseInt(dny.value, 10) || 30;
    ulozL.disabled = true;
    zapisDoc('souteze/' + sid, { pravidla: prav })
      .then(function () { ulozL.disabled = false; ulozL.textContent = 'Uloženo ✓'; })
      .catch(function () { ulozL.disabled = false; });
  };
  lhutaR.appendChild(ulozL);
  box.appendChild(lhutaR);

  // výběr míst na mapě (jen vlastní soutěže)
  if (jeVlastniS) {
    var mistaR = document.createElement('p');
    var mista = document.createElement('button');
    mista.textContent = (d.maska || (d.vlastni && d.vlastni.length))
      ? 'Upravit výběr míst na mapě'
      : 'Vybrat místa na mapě (teď hrají všechna)';
    mista.onclick = function () {
      if (sid === SOUTEZ) {
        zapniVyberMist();
        prepniZalozku('mapa');
      } else {
        location.href = '/dobyvatel/?s=' + sid + '&editor=1';
      }
    };
    mistaR.appendChild(mista);
    box.appendChild(mistaR);
  } else {
    var poznC = document.createElement('p');
    poznC.style.color = '#6b6455';
    poznC.textContent = 'Výběr míst na mapě patří k vlastním '
      + 'soutěžím — republikové kolo hraje o všechna místa.';
    box.appendChild(poznC);
  }
  if (jeVlastniS && d.stav === 'konec') {
    var uklid = document.createElement('p');
    uklid.style.color = '#8a5a20';
    var konecP = String((d.pravidla || {}).konec || '');
    var smazatOd = konecP
      ? new Date(new Date(konecP).getTime() + 180 * 86400000)
      : null;
    uklid.textContent = 'Neaktivní skončené soutěže se po půl roce '
      + 'mažou' + (smazatOd
          ? ' — tahle ' + smazatOd.toLocaleDateString('cs-CZ') + '.'
          : '.');
    box.appendChild(uklid);
  }

  // smazání (jen mimo běh) — uvolní slot v registru zalozene
  if (jeVlastniS && d.stav !== 'bezi') {
    var smazR = document.createElement('p');
    var smaz = document.createElement('button');
    smaz.textContent = 'Smazat soutěž';
    smaz.onclick = function () {
      if (!confirm('Opravdu smazat celou soutěž? Nejde to vrátit.')) {
        return;
      }
      smaz.disabled = true;
      platnyToken().then(function (token) {
        return fetch(ZAKLAD_DOK + 'souteze/' + sid + '?key='
            + KLIC, { method: 'DELETE',
              headers: { Authorization: 'Bearer ' + token } })
          .then(function () {
            return ctiDoc(ZAKLAD_DOK + 'zalozene/' + relace.uid
                + '?key=' + KLIC, token)
              .catch(function () { return null; });
          })
          .then(function (reg) {
            if (!reg) return null;
            return zapisDoc('zalozene/' + relace.uid, {
              sids: (reg.sids || []).filter(function (x) {
                return x !== sid;
              }),
            });
          });
      }).then(function () {
        zapamatujNavrat();
        location.href = '/dobyvatel/';
      }).catch(function () { smaz.disabled = false; });
    };
    smazR.appendChild(smaz);
    box.appendChild(smazR);
  }

  // členové: změna týmu + předání správy
  var klice = (d.tymyPoradi && d.tymyPoradi.length)
    ? d.tymyPoradi
    : tymy.map(function (t) { return t.klic; });
  platnyToken().then(function (token) {
    return Promise.all([
      dotaz('clenstvi', 'soutez', sid, token),
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
          soutez: sid,
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
          zapisDoc('souteze/' + sid, { zakladatel: uid })
            .then(function () {
              zapamatujNavrat();
              location.reload();
            });
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
      return { uid: uid, z: hraci[uid].z || 0, b: hraci[uid].b || 0,
               o: hraci[uid].o || 0, xp: hraci[uid].xp || 0 };
    }).sort(function (a, b) {
      return b.xp - a.xp || b.b - a.b || b.z - a.z;
    }).slice(0, 20);
    var tab = el('hraci');
    if (!radky.length) {
      var r0 = document.createElement('tr');
      var t0 = document.createElement('td');
      t0.colSpan = 5;
      t0.textContent = 'Zatím nikdo nic nezabral — buď první.';
      r0.appendChild(t0);
      tab.appendChild(r0);
      return;
    }
    radky.forEach(function (h, i) {
      var r = document.createElement('tr');
      [String(i + 1) + '.',
       jmena[h.uid] || 'dobyvatel bez přezdívky',
       String(h.z), String(h.o),
       String(h.xp)].forEach(function (text, j) {
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
  vlastni: 'Vlastní místo soutěže',
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
  filtrDruhu = new Set(Object.keys(POPISKY_DRUHU));
  Object.keys(POPISKY_DRUHU).forEach(function (kat) {
    var radek = document.createElement('label');
    radek.style.cssText = PRUH
      + 'display:flex;align-items:center;gap:8px;margin:3px 0;'
      + 'cursor:pointer;';
    // LEGENDA JE ZÁROVEŇ FILTR (přání 29. 8.): odškrtnutý druh
    // z mapy zmizí
    var ch = document.createElement('input');
    ch.type = 'checkbox';
    ch.checked = true;
    ch.onchange = function () {
      if (ch.checked) filtrDruhu.add(kat);
      else filtrDruhu.delete(kat);
      aplikujFiltrDruhu();
    };
    radek.appendChild(ch);
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
  });
  var pozn = document.createElement('div');
  pozn.style.cssText = PRUH + 'margin-top:6px;color:#6b6455;'
    + 'max-width:230px;';
  pozn.textContent = 'Zdaleka vidíš jen výběr nejvýznamnějších míst '
    + '— přibližováním přibývají další. Barva území = tým, který je '
    + 'drží.';
  panel.appendChild(pozn);
  // INTRO: legenda se ukáže ~2,5 s, sroluje se a tlačítko zadrnčí
  // — VŽDY (dřívější zapamatované „nechat otevřenou" ji drželo
  // napořád, výtka 29. 8. „po vteřině nemizí")
  panel.style.display = 'block';
  var kf = document.createElement('style');
  kf.textContent = '@keyframes legenda-drnc{0%,100%{transform:none}'
    + '25%{transform:translateX(-3px) rotate(-2deg)}'
    + '75%{transform:translateX(3px) rotate(2deg)}}';
  document.head.appendChild(kf);
  var introCasovac = setTimeout(function () {
    panel.style.display = 'none';
    tl.style.animation = 'legenda-drnc .45s ease 3';
  }, 2500);
  tl.onclick = function () {
    if (introCasovac) { clearTimeout(introCasovac); introCasovac = null; }
    tl.style.animation = '';
    panel.style.display =
      panel.style.display !== 'none' ? 'none' : 'block';
  };
  obal.style.position = 'relative';
  obal.appendChild(tl);
  // přepínač turistických tras vedle Legendy (přání 30. 8.)
  tlacitkoTras = document.createElement('button');
  tlacitkoTras.textContent = 'Trasy';
  tlacitkoTras.title = 'Turistické značky KČT';
  tlacitkoTras.style.cssText = 'position:absolute;left:88px;top:10px;'
    + 'z-index:5;padding:5px 10px;border-radius:8px;border:1px solid '
    + '#b9b2a0;background:#fffdf6;cursor:pointer;'
    + '-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);'
    + 'font:600 12.5px sans-serif;';
  tlacitkoTras.onclick = prepniTrasy;
  obal.appendChild(tlacitkoTras);
  var tl3d = document.createElement('button');
  tl3d.textContent = '3D';
  tl3d.title = 'Naklonit mapu';
  tl3d.style.cssText = 'position:absolute;left:150px;top:10px;'
    + 'z-index:5;padding:5px 10px;border-radius:8px;border:1px solid '
    + '#b9b2a0;background:#fffdf6;cursor:pointer;'
    + '-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);'
    + 'font:600 12.5px sans-serif;';
  tl3d.onclick = function () {
    if (mapaMrtva) return;
    var zapnout = mapa.getPitch() < 5;
    mapa.easeTo({ pitch: zapnout ? 57 : 0, duration: 700 });
    tl3d.style.background = zapnout ? '#efe9da' : '#fffdf6';
    tl3d.style.borderColor = zapnout ? '#4e6e58' : '#b9b2a0';
  };
  obal.appendChild(tl3d);
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
  pripravZalozky();
  napasujVysku();
  naplnVolbuSouteze();
  try {
    if (sessionStorage.getItem('dobyvatelNavrat') === 'moje') {
      sessionStorage.removeItem('dobyvatelNavrat');
      prepniZalozku('moje');
    }
  } catch (e) { }
  reklamy();
  vykresliZalozeni();
  verejneSouteze();
  Promise.all([
    fetch('data/tymy.json?v=10').then(function (r) { return r.json(); }),
    fetch('data/vlajky_oblasti.json?v=44').then(function (r) { return r.json(); }),
    fetch('data/kraje.json?v=44').then(function (r) { return r.json(); }),
    fetch('data/vlajky.json?v=52').then(function (r) { return r.json(); }),
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
    okresyLegenda = vysledky[3].okresy || [];
    nStd = vlajky.length;
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
    try {
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
          omt: {
            type: 'vector',
            url: 'https://tiles.openfreemap.org/planet',
            attribution: '© OpenStreetMap, OpenFreeMap',
          },
        },
        layers: [{
          id: 'pozadi', type: 'background',
          paint: { 'background-color': '#f2efe6' },
        }, {
          id: 'stinovani', type: 'hillshade', source: 'teren',
          paint: {
            // s přiblížením slábne: hranaté vady DEM (zuby u dálnic
            // a lomů) se zblízka kreslily jako „polygony" — kopce
            // zdaleka zůstávají
            'hillshade-exaggeration': ['interpolate', ['linear'],
              ['zoom'], 10, 0.62, 12, 0.4, 14, 0.22],
            'hillshade-shadow-color': '#7d705e',
            // odlesk = barva papíru: vady v DEM (mosty, zářezy) se
            // s bílou vysvěcovaly jako „díry v mapě" (u Poříčan)
            'hillshade-highlight-color': '#f5f1e4',
          },
        }, {
          id: 'voda', type: 'fill', source: 'omt',
          'source-layer': 'water',
          paint: { 'fill-color': '#cbdde6', 'fill-opacity': 0.75 },
        }, {
          id: 'reky', type: 'line', source: 'omt',
          'source-layer': 'waterway', minzoom: 9,
          paint: { 'line-color': '#b3cdd9', 'line-opacity': 0.85,
            'line-width': ['interpolate', ['exponential', 1.4],
              ['zoom'], 9, 0.6, 16, 2.4] },
        }, {
          id: 'silnice', type: 'line', source: 'omt',
          'source-layer': 'transportation', minzoom: 8,
          filter: ['in', ['get', 'class'],
            ['literal', ['motorway', 'trunk', 'primary',
                         'secondary', 'tertiary']]],
          paint: { 'line-color': '#cfc6b2', 'line-opacity': 0.9,
            'line-width': ['interpolate', ['exponential', 1.4],
              ['zoom'], 8, 0.5, 16, 3] },
        }, {
          id: 'mesta', type: 'symbol', source: 'omt',
          'source-layer': 'place', minzoom: 6.5,
          filter: ['in', ['get', 'class'],
            ['literal', ['city', 'town']]],
          layout: {
            'text-field': ['coalesce', ['get', 'name:cs'],
              ['get', 'name']],
            'text-font': ['Noto Sans Bold'],
            // větší a barevně odlišená od jmen míst (29. 8.)
            'text-size': ['match', ['get', 'class'],
              'city', 16.5, 13.5],
            'text-padding': 6,
          },
          paint: { 'text-color': '#5d7285',
            'text-halo-color': '#f2efe6', 'text-halo-width': 1.6 },
        }, {
          id: 'cesty', type: 'line', source: 'omt',
          'source-layer': 'transportation', minzoom: 12,
          filter: ['in', ['get', 'class'],
            ['literal', ['minor', 'service', 'path', 'track']]],
          paint: { 'line-color': '#bdb29a', 'line-opacity': 0.8,
            'line-width': ['interpolate', ['exponential', 1.4],
              ['zoom'], 12, 0.4, 16, 1.6],
            'line-dasharray': [2, 1.6] },
        }] },
      bounds: [[12.05, 48.5], [18.9, 51.1]],
      fitBoundsOptions: { padding: 12 },
      // jen ČR — mapa je jen pro republiku (přání 27. 8.)
      maxBounds: [[11.6, 48.2], [19.3, 51.4]],
      minZoom: 6,
      dragRotate: false,   // rotace na webu zrušena (přání 29. 8.)
      pitchWithRotate: false,
    });
    try {
      mapa.touchZoomRotate.disableRotation();
      if (mapa.keyboard && mapa.keyboard.disableRotation) {
        mapa.keyboard.disableRotation();
      }
    } catch (eR) { }
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
    });
    } catch (chybaMapy) {
      mapa = null;
      mapaSelhala(chybaMapy);
    }
    // snímek a skóre NEZÁVISLE na mapě — žebříčky, soutěže i správa
    // musí fungovat, i když WebGL nejede (hlášeno 28. 8.)
    nactiSnimek().then(function (s) {
      var poradi = s.tymyPoradi || [];
      var drzitele = s.drzitele
        ? rozbalDrzitele(s.drzitele, poradi) : null;
      posledniDrziteleArr = drzitele;
      posledniDobyto = s.dobyto || null;
      posledniClenove = s.clenove || null;
      obarvi(drzitele);
      vypisSkore(s.skore || {});
      vypisDobyto(s.dobyto || {});
      if (mapaMrtva) return;
      var kdy = s.ts ? new Date(s.ts) : null;
      el('stav').textContent = 'Stav území k '
        + (kdy ? kdy.toLocaleString('cs-CZ') : 'poslednímu snímku')
        + ' · obsazovat lze v aplikaci Okolník (režim Dobyvatel).';
    }).catch(function () {
      vypisSkore({});
      if (mapaMrtva) return;
      el('stav').textContent = 'Soutěž se připravuje — mapa zatím '
        + 'ukazuje neutrální území. Obsazovat půjde v aplikaci '
        + 'Okolník (režim Dobyvatel).';
    });
  }).catch(function (e) {
    mapaSelhala(e);
  });
}

var mapaMrtva = false;

function mapaSelhala(e) {
  mapaMrtva = true;
  var box = el('stav');
  box.textContent = '';
  var webgl = /webgl/i.test((e && e.message) || '');
  var text = document.createElement('span');
  text.textContent = webgl
    ? 'Prohlížeči se nepodařilo zapnout grafiku (WebGL), mapa se '
      + 'proto nenačte. Obvykle pomůže zapnout hardwarovou '
      + 'akceleraci v nastavení prohlížeče a restartovat ho, '
      + 'případně zkusit Chrome/Edge. Žebříčky, soutěže i správa '
      + 'fungují dál. '
    : 'Mapu se nepodařilo načíst. ';
  box.appendChild(text);
  var znovu = document.createElement('button');
  znovu.textContent = 'Zkusit znovu';
  znovu.onclick = function () { location.reload(); };
  box.appendChild(znovu);
}

start();
