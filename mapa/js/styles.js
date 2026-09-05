// Okolník 3D — definice čtyř mapových stylů.
// Styly jsou standardní MapLibre style.json objekty (schéma OpenMapTiles),
// takže pojedou beze změny i na budoucím nativním rendereru.
'use strict';

// ---------------------------------------------------------------------------
// KONFIG — až budou hotové vlastní dlaždice z pipeline, stačí přepnout zde.
// ---------------------------------------------------------------------------
const KONFIG = {
  // Vektorové dlaždice (OpenMapTiles schéma). Demo: OpenFreeMap (bez klíčů).
  // Vlastní build: 'pmtiles://http://localhost:8137/pipeline/data/cesko_vektor.pmtiles'
  vektorUrl: 'https://tiles.openfreemap.org/planet',
  // Výškopis (terrarium PNG). Demo: AWS ~EU-DEM 25 m.
  // Vlastní DMR 5G (0,18 m): 'http://localhost:8137/pipeline/data/teren/{z}/{x}/{y}.png'
  terenUrl: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  // z14 stačí (checklist 9. 8.): z15 pro ČR reálný detail nepřidá,
  // jen čtyřnásobí počet dlaždic k dekódování při blízkém náklonu.
  // ⚠️ tileSize DEM zůstává 256 — AWS terrarium i DMR pipeline jsou
  // fyzicky 256px dlaždice; 512 by chtělo přegenerovat pyramidu.
  terenMaxZoom: 14,
  // Ortofoto ČÚZK — kachlovaná služba ve Web Mercatoru, LOD 6–20 (ověřeno).
  ortofotoUrl: 'https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer/tile/{z}/{y}/{x}',
  // ⭐ v1.432: písma popisků PŘIBALENÁ V APK (assets/engine3d/fonts,
  // řezy 0–1023 pro Regular/Bold/Italic, ~1,2 MB). Vzdálená adresa
  // (openfreemap) bez signálu NIKDY nedončetla styl → mapa „nabíhala
  // bez limitu“. Absolutně od umístění stránky — relativní glyphs
  // MapLibre bez style-URL neřeší spolehlivě.
  glyphs: location.origin + location.pathname.replace(/[^/]*$/, '')
      + 'fonts/{fontstack}/{range}.pbf',
};

// Paleta značky Okolník (lib/brand.dart v aplikaci)
const PALETA = {
  tmava:  '#0D2B2E',  // tmavá zeleň
  zelen:  '#2E7D5B',  // přírodní zeleň
  tyrkys: '#2FA7A0',
  oranz:  '#F29D38',
  pisek:  '#F2E8CF',
  seda:   '#E6E8EB',
};

// Jméno česky, když je v datech, jinak výchozí
const NAZEV = ['coalesce', ['get', 'name:cs'], ['get', 'name']];

const FONT = ['Noto Sans Regular'];
const FONT_B = ['Noto Sans Bold'];
const FONT_I = ['Noto Sans Italic'];

// Obloha (MapLibre v5 style.sky)
function obloha(horizont) {
  return {
    'sky-color': '#88bfe0',
    'horizon-color': horizont || '#eef4f8',
    'fog-color': '#f5f2ea',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.7,
    'fog-ground-blend': 0.6,
  };
}

// Zdroj terénu: šablona {z}/{x}/{y} NEBO PMTiles archiv (pmtiles://…).
// `stinovani` je zvlášť od `teren` (hillshade nesmí sdílet zdroj s terénem)
// a dostává strop z13 — na z14 hillshade zvýrazňuje kvantizaci terrarium
// (kroky 1/256 m) jako jemné šrafy; 3D síť jede dál z plného rozlišení.
//
// ⭐ SDÍLENÁ KEŠ VÝŠKOPISU (6. 8. 2026, „načítání 3D+ je dosti pomalé").
// Vrstevnice, stínování i 3D síť čtou TYTÉŽ dlaždice, ale každý si je
// dosud stahoval sám – jedna dlaždice tedy šla po drátě až třikrát.
// `maplibre-contour` na to má `sharedDemProtocolUrl`: požadavky projdou
// jeho LRU keší, takže druhý a třetí konzument dostane dlaždici z paměti.
// U PMTiles z R2/GitHubu je to jediná spolehlivá keš (na HTTP keš WebView
// se u Range požadavků spolehnout nedá) a zároveň to umožňuje PŘEDNAČTENÍ
// (viz `predtahniTeren` v main.js) – bez sdílené cesty by se předtažené
// bajty ke zdroji `teren` vůbec nedostaly.
function zdrojTerenu(stropZoom) {
  const strop = Math.min(KONFIG.terenMaxZoom, stropZoom || 99);
  const z = {
    type: 'raster-dem',
    encoding: 'terrarium',
    // ⛔ v1.397.1: BEZ minzoom si trvalý terén (drzetTeren) při plném
    // oddálení řekl o rodiče z0–z5, které archiv NEMÁ (teren_cr_z14
    // začíná na z6) — salva „Tile data not found“ během gesta
    // (hlídka 12. 8. večer, z6,5). Pod minzoom se dlaždice prostě
    // nevyžádají a výška je 0.
    minzoom: KONFIG.terenMinZoom || 6,
    maxzoom: strop,
    attribution: KONFIG.terenAtribuce || 'Terén: Mapzen/AWS Open Data',
  };
  // sdílená cesta umí jen tak hluboko, kam sahá DemSource (viz main.js)
  if (KONFIG.terenSdilenaUrl && strop <= (KONFIG.terenSdilenyStrop || 0)) {
    z.tiles = [KONFIG.terenSdilenaUrl];
    z.tileSize = 256;
    return z;
  }
  if (KONFIG.terenUrl.startsWith('pmtiles://')) {
    z.url = KONFIG.terenUrl;
  } else {
    z.tiles = [KONFIG.terenUrl];
    z.tileSize = 256;
  }
  return z;
}


function zdroje(ctx, extra) {
  const zaklad = {
    omt: { type: 'vector', url: KONFIG.vektorUrl,
           attribution: KONFIG.vektorAtribuce
             || '© OpenStreetMap, OpenMapTiles, OpenFreeMap' },
    // strop 13 i pro 3D síť: tím jde `teren` přes SDÍLENOU keš (viz výš).
    // Ztráta detailu reliéfu je při stropu náklonu 42° nepostřehnutelná,
    // zato dlaždice dorazí často už načtená kvůli vrstevnicím/stínování.
    teren: zdrojTerenu(13),
    stinovani: zdrojTerenu(13),
  };
  if (ctx && ctx.konturyUrl) {
    zaklad.kontury = { type: 'vector', tiles: [ctx.konturyUrl], maxzoom: 15 };
  }
  return Object.assign(zaklad, extra || {});
}

// Interpolace šířky čar podle zoomu (zkratka)
function sirka(z1, w1, z2, w2) {
  return ['interpolate', ['exponential', 1.4], ['zoom'], z1, w1, z2, w2];
}

// ---------------------------------------------------------------------------
// 2) LETECKÁ — ortofoto ČÚZK + orientační kresba
// ---------------------------------------------------------------------------
function stylLetecka(ctx) {
  return {
    version: 8,
    name: 'Okolník — Letecká',
    glyphs: KONFIG.glyphs,
    sky: obloha(),
    sources: zdroje(ctx, {
      ortofoto: {
        type: 'raster', tiles: [KONFIG.ortofotoUrl], tileSize: 256,
        minzoom: 6, maxzoom: 20, attribution: 'Ortofoto © ČÚZK',
      },
    }),
    layers: [
      { id: 'pozadi', type: 'background',
        paint: { 'background-color': '#16241d' } },
      { id: 'ortofoto', type: 'raster', source: 'ortofoto',
        paint: { 'raster-contrast': 0.04, 'raster-saturation': 0.06,
                 'raster-fade-duration': 150 } },
      { id: 'stinovani', type: 'hillshade', source: 'stinovani',
        maxzoom: 13,
        paint: { 'hillshade-exaggeration': 0.18,
                 'hillshade-shadow-color': '#0c1a14',
                 'hillshade-highlight-color': '#ffffff' } },
      { id: 'silnice', type: 'line', source: 'omt',
        'source-layer': 'transportation', minzoom: 9,
        filter: ['in', ['get', 'class'],
                 ['literal', ['motorway', 'trunk', 'primary', 'secondary']]],
        paint: { 'line-color': '#ffffff', 'line-opacity': 0.35,
                 'line-width': sirka(9, 0.6, 16, 3) } },
      { id: 'hranice-stat', type: 'line', source: 'omt',
        'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2],
                 ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': '#ffffff', 'line-opacity': 0.55,
                 'line-width': 1.2, 'line-dasharray': [3, 2] } },
      { id: 'voda-nazvy', type: 'symbol', source: 'omt',
        'source-layer': 'water_name', minzoom: 9,
        layout: { 'text-field': NAZEV, 'text-font': FONT_I,
                  'text-size': 12 },
        paint: { 'text-color': '#bfe3ef',
                 'text-halo-color': 'rgba(0,20,30,0.7)', 'text-halo-width': 1.2 } },
      { id: 'sidla', type: 'symbol', source: 'omt', 'source-layer': 'place',
        filter: ['in', ['get', 'class'],
                 ['literal', ['city', 'town', 'village']]],
        layout: {
          'text-field': NAZEV, 'text-font': FONT_B,
          'text-size': ['match', ['get', 'class'],
                        'city', 15, 'town', 13, 11],
        },
        paint: { 'text-color': '#ffffff',
                 'text-halo-color': 'rgba(0,0,0,0.75)', 'text-halo-width': 1.4 } },
    ],
  };
}

// ---------------------------------------------------------------------------
// 3) TURISTICKÁ — reliéf, vrstevnice, stezky, vrcholy
// ---------------------------------------------------------------------------
function stylTuristicka(ctx) {
  return {
    version: 8,
    name: 'Okolník — Turistická',
    glyphs: KONFIG.glyphs,
    sky: obloha(),
    sources: zdroje(ctx),
    layers: [
      { id: 'pozadi', type: 'background',
        paint: { 'background-color': '#f4efe3' } },
      { id: 'les', type: 'fill', source: 'omt', 'source-layer': 'landcover',
        filter: ['==', ['get', 'class'], 'wood'],
        paint: { 'fill-color': '#cadfb6', 'fill-opacity': 0.85 } },
      { id: 'louka', type: 'fill', source: 'omt', 'source-layer': 'landcover',
        filter: ['in', ['get', 'class'], ['literal', ['grass', 'wetland']]],
        paint: { 'fill-color': '#e0ecc8', 'fill-opacity': 0.7 } },
      { id: 'zastavba', type: 'fill', source: 'omt', 'source-layer': 'landuse',
        filter: ['in', ['get', 'class'],
                 ['literal', ['residential', 'suburb', 'neighbourhood']]],
        paint: { 'fill-color': '#e9dfd0', 'fill-opacity': 0.8 } },
      { id: 'park-np', type: 'fill', source: 'omt', 'source-layer': 'park',
        paint: { 'fill-color': '#9ccb86', 'fill-opacity': 0.15 } },
      { id: 'park-np-hranice', type: 'line', source: 'omt',
        'source-layer': 'park', minzoom: 8,
        paint: { 'line-color': '#4c9a2a', 'line-width': 1.6,
                 'line-dasharray': [4, 2], 'line-opacity': 0.7 } },
      { id: 'stinovani', type: 'hillshade', source: 'stinovani',
        paint: { 'hillshade-exaggeration': 0.45,
                 'hillshade-shadow-color': '#59503c',
                 'hillshade-highlight-color': '#fffdf5',
                 'hillshade-accent-color': '#8a7c5a' } },
      // Vrstevnice (klientský výpočet z terénu — maplibre-contour)
      { id: 'vrstevnice', type: 'line', source: 'kontury',
        'source-layer': 'contours', minzoom: 11,
        filter: ['!=', ['get', 'level'], 1],
        paint: { 'line-color': '#a58a58', 'line-opacity': 0.45,
                 'line-width': 0.7 } },
      { id: 'vrstevnice-hlavni', type: 'line', source: 'kontury',
        'source-layer': 'contours', minzoom: 11,
        filter: ['==', ['get', 'level'], 1],
        paint: { 'line-color': '#a58a58', 'line-opacity': 0.6,
                 'line-width': 1.2 } },
      { id: 'vrstevnice-koty', type: 'symbol', source: 'kontury',
        'source-layer': 'contours', minzoom: 13,
        filter: ['==', ['get', 'level'], 1],
        layout: { 'symbol-placement': 'line',
                  'text-field': ['concat', ['get', 'ele'], ' m'],
                  'text-font': FONT, 'text-size': 10 },
        paint: { 'text-color': '#8a7448', 'text-halo-color': '#f4efe3',
                 'text-halo-width': 1.2 } },
      // ⭐ v1.436 („ne všechny vrstevnice mají výšku“): zblízka
      // dostanou kótu i VEDLEJŠÍ vrstevnice (menším písmem);
      // z dálky by to byl šum, proto až od z15
      { id: 'vrstevnice-koty-vedlejsi', type: 'symbol', source: 'kontury',
        'source-layer': 'contours', minzoom: 15,
        filter: ['!=', ['get', 'level'], 1],
        layout: { 'symbol-placement': 'line',
                  'text-field': ['concat', ['get', 'ele'], ' m'],
                  'text-font': FONT, 'text-size': 8.5 },
        paint: { 'text-color': '#9a865c', 'text-halo-color': '#f4efe3',
                 'text-halo-width': 1.1 } },
      { id: 'voda', type: 'fill', source: 'omt', 'source-layer': 'water',
        paint: { 'fill-color': '#9fc7dd' } },
      { id: 'reky', type: 'line', source: 'omt', 'source-layer': 'waterway',
        paint: { 'line-color': '#7ab3d0',
                 // interpolace musí být vnější výraz (limit MapLibre)
                 'line-width': ['interpolate', ['exponential', 1.4], ['zoom'],
                   8, ['match', ['get', 'class'], 'river', 1, 0.4],
                   16, ['match', ['get', 'class'],
                        'river', 4, 'canal', 2.5, 1.6]] } },
      // Cesty a stezky — duše turistické mapy
      { id: 'stezky', type: 'line', source: 'omt',
        'source-layer': 'transportation', minzoom: 11,
        filter: ['==', ['get', 'class'], 'path'],
        paint: { 'line-color': '#c1402c', 'line-width': sirka(11, 0.9, 16, 2.2),
                 'line-dasharray': [3, 1.6] } },
      { id: 'polni-cesty', type: 'line', source: 'omt',
        'source-layer': 'transportation', minzoom: 11,
        filter: ['==', ['get', 'class'], 'track'],
        paint: { 'line-color': '#8a6b46', 'line-width': sirka(11, 0.8, 16, 2),
                 'line-dasharray': [5, 2, 1.5, 2] } },
      { id: 'silnice-mistni-obrys', type: 'line', source: 'omt',
        'source-layer': 'transportation', minzoom: 11,
        filter: ['in', ['get', 'class'],
                 ['literal', ['minor', 'service', 'tertiary']]],
        paint: { 'line-color': '#b3a68f', 'line-gap-width': sirka(11, 1, 16, 4),
                 'line-width': 0.8 } },
      { id: 'silnice-mistni', type: 'line', source: 'omt',
        'source-layer': 'transportation', minzoom: 11,
        filter: ['in', ['get', 'class'],
                 ['literal', ['minor', 'service', 'tertiary']]],
        paint: { 'line-color': '#ffffff', 'line-width': sirka(11, 1, 16, 4) } },
      { id: 'silnice-vedlejsi', type: 'line', source: 'omt',
        'source-layer': 'transportation', minzoom: 8,
        filter: ['==', ['get', 'class'], 'secondary'],
        paint: { 'line-color': '#f5d271', 'line-width': sirka(8, 1, 16, 5) } },
      { id: 'silnice-hlavni', type: 'line', source: 'omt',
        'source-layer': 'transportation', minzoom: 7,
        filter: ['in', ['get', 'class'],
                 ['literal', ['primary', 'trunk', 'motorway']]],
        paint: { 'line-color': '#f0a04b', 'line-width': sirka(7, 1.2, 16, 6) } },
      { id: 'zeleznice', type: 'line', source: 'omt',
        'source-layer': 'transportation', minzoom: 9,
        filter: ['==', ['get', 'class'], 'rail'],
        paint: { 'line-color': '#555049', 'line-width': 1.4,
                 'line-dasharray': [6, 3] } },
      { id: 'budovy', type: 'fill', source: 'omt', 'source-layer': 'building',
        minzoom: 14,
        paint: { 'fill-color': '#d6cbb8', 'fill-outline-color': '#b7a98e' } },
      { id: 'hranice-stat', type: 'line', source: 'omt',
        'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2],
                 ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': '#6b4f8f', 'line-width': 2,
                 'line-dasharray': [4, 2] } },
      { id: 'hranice-kraj', type: 'line', source: 'omt',
        'source-layer': 'boundary', minzoom: 7,
        filter: ['==', ['get', 'admin_level'], 4],
        paint: { 'line-color': '#8f7bab', 'line-width': 1,
                 'line-dasharray': [3, 3], 'line-opacity': 0.7 } },
      // Vrcholy se jménem a výškou
      { id: 'vrcholy', type: 'symbol', source: 'omt',
        'source-layer': 'mountain_peak', minzoom: 9,
        filter: ['any', ['<', ['zoom'], 11], ['>', ['coalesce', ['get', 'rank'], 9], 0]],
        layout: {
          'text-field': ['format',
            '▲ ', {},
            NAZEV, { 'text-font': ['literal', FONT_B] },
            '\n', {},
            ['concat', ['get', 'ele'], ' m'], { 'font-scale': 0.85 }],
          'text-font': FONT, 'text-size': 12, 'text-anchor': 'top',
          'text-offset': [0, 0.2],
        },
        paint: { 'text-color': '#5c452a', 'text-halo-color': '#f4efe3',
                 'text-halo-width': 1.4 } },
      // ⛔ v1.443: VRSTVA `cile` ZRUŠENA (červená kolečka z dlaždic pro
      // hrady/vyhlídky/chaty/přístřešky/zříceniny). Uživatel: „na mapě
      // jsou vidět červené puntíky a jsou to přístřešky". Všechny tyhle
      // třídy dnes pokrývají NAŠE kategorie s kresbami (castles,
      // viewpoints, accommodation/alpine_hut, shelters) — kolečko
      // z podkladu jen dublovalo naši bublinu. Stejné rozhodnutí jako
      // v1.439 u Základní: mapu nesou naše ikony, cizí značky pryč.
      { id: 'voda-nazvy', type: 'symbol', source: 'omt',
        'source-layer': 'water_name', minzoom: 10,
        layout: { 'text-field': NAZEV, 'text-font': FONT_I, 'text-size': 12 },
        paint: { 'text-color': '#3f7ea6', 'text-halo-color': '#f4efe3',
                 'text-halo-width': 1.2 } },
      // ⭐⭐ TÁŽ HIERARCHIE JAKO V KRONICE (10. 8. 2026).
      // ⚠️ NEHERNÍ STYL SE MUSÍ MĚNIT SPOLU S HERNÍM. Když jsem udělal
      // jen `ink-*` vrstvy, uživatel hlásil „popisky mi připadají jako
      // předtím" — koukal na tenhle styl, kde bylo TUČNÉ VŠECHNO
      // a navíc BEZ JAKÉHOKOLI OMEZENÍ ZOOMU, takže se psala každá
      // samota na všech úrovních.
      // Řez a barva nesou druh, `minzoom` (ne filtr se `['zoom']`) řídí
      // hustotu a reaguje okamžitě při oddálení.
      { id: 'mesta', type: 'symbol', source: 'omt', 'source-layer': 'place',
        filter: ['==', ['get', 'class'], 'city'],
        layout: { 'text-field': NAZEV, 'text-font': FONT_B, 'text-size': 16,
                  'text-transform': 'uppercase', 'text-letter-spacing': 0.08 },
        paint: { 'text-color': '#333029', 'text-halo-color': '#f4efe3',
                 'text-halo-width': 1.6 } },
      { id: 'mestyse', type: 'symbol', source: 'omt', 'source-layer': 'place',
        filter: ['==', ['get', 'class'], 'town'],
        // ⭐ 12. 8.: town TUČNĚ 14 — třída `city` je v ČR jen pár velkoměst,
        // takže v běžném výřezu byla město/vesnice k nerozeznání (13 vs 10,5
        // týmž řezem). Tučné patro dělá hierarchii viditelnou všude.
        layout: { 'text-field': NAZEV, 'text-font': FONT_B, 'text-size': 14 },
        paint: { 'text-color': '#333029', 'text-halo-color': '#f4efe3',
                 'text-halo-width': 1.6 } },
      { id: 'vesnice', type: 'symbol', source: 'omt', 'source-layer': 'place',
        minzoom: 10,
        filter: ['==', ['get', 'class'], 'village'],
        layout: { 'text-field': NAZEV, 'text-font': FONT, 'text-size': 10.5 },
        paint: { 'text-color': '#4A463C', 'text-halo-color': '#f4efe3',
                 'text-halo-width': 1.6 } },
      { id: 'obce', type: 'symbol', source: 'omt', 'source-layer': 'place',
        minzoom: 12,
        filter: ['==', ['get', 'class'], 'hamlet'],
        layout: { 'text-field': NAZEV, 'text-font': FONT, 'text-size': 9 },
        paint: { 'text-color': '#6B665A', 'text-halo-color': '#f4efe3',
                 'text-halo-width': 1.6 } },
    ],
  };
}

// ---------------------------------------------------------------------------
// 4) HERNÍ KRONIKA — dvě patra oddělená mlhou objevování (fog.js):
//   · BAREVNÉ PATRO (dole) — malovaná krajina v paletě Okolníku; v neobjeveném
//     území je zakryta pergamenovou rytinou, objevením se „vybarví".
//   · INKOUSTOVÉ PATRO (ink-*, nahoře) — obrysy budov, sídla, vrstevnice,
//     hranice, řeky a vrcholy kreslené tuší. Je vidět VŽDY: na pergamenu
//     tvoří černobílou kroniku, nad barvou působí jako ruční kresba.
//   Mlha (pergamenová rytina ČR s děrami) se vkládá před první vrstvu `ink-`.
// ---------------------------------------------------------------------------
const KRONIKA = {
  ink: '#4A3B28',        // tuš kresby (sladěno s kronika_meta.json)
  inkTmava: '#33291B',   // tuš popisků
  inkSvetla: '#6E5A3C',  // slabší tahy (kraje, vrstevnice)
  pergamen: '#E9DCBE',   // plochá barva papíru = fill-color mlhy
  halo: 'rgba(242,232,207,0.88)',  // svatozář textů — čitelné na obou patrech
};

// ⭐⭐⭐ TYPOGRAFICKÁ HIERARCHIE POPISKŮ (10. 8. 2026).
// Výtka: „je to nepřehledné, kopce, vesnice, města — všechno téměř
// stejné." A byla oprávněná: všechno se kreslilo TUČNĚ, jednou barvou,
// a lišilo se jen velikostí po dvou pixelech (17/14/12/10). Když je
// tučné všechno, nevyniká nic.
//
// Kartografická konvence (atlasy, Swisstopo, IGN, Ordnance Survey) staví
// hierarchii na VÍC ZNACÍCH NAJEDNOU, ne na velikosti:
//   1. řez podle DRUHU — sídla stojatě, přírodní jevy KURZÍVOU
//      (pozná se periferním viděním, funguje i na malém písmu),
//   2. barva podle kategorie — sídla tuš, terén sépie, voda modrozelená,
//   3. větší skoky velikostí (poměr ~1,35), méně stupňů,
//   4. tučné JEN pro nejvyšší stupeň, zbytek nese kontrast barvy.
const obceLayout = (font, velikost, verzalky) => ({
  'text-field': NAZEV, 'text-font': font, 'text-size': velikost,
  'text-anchor': 'top', 'text-offset': [0, 0.45],
  'text-transform': verzalky ? 'uppercase' : 'none',
  'text-letter-spacing': verzalky ? 0.08 : 0,
});
const obcePaint = (barva) => ({
  'text-color': barva, 'text-halo-color': KRONIKA.halo,
  'text-halo-width': 1.8,
});

// Sousední státy: za hranicí ČR leží v kronice jen plochý pergamen, takže
// bez nápisu není poznat, co tam vlastně je (2D protějšek je
// `_neighborArrows`). Nápis sedí ZA hranicí, ať se netiskne na kresbu
// pohraničí (přání z v1.127).
//
// ⚠️ SOUŘADNICE NEJSOU STEJNÉ JAKO VE 2D a být nemůžou: engine drží
// kameru u republiky (`mapa.setMaxBounds(CR_BOUNDS)` = [11,9 48,2] až
// [19,1 51,4]), takže co leží za tou zdí, se NIKDY nedostane na
// obrazovku. Body ze 2D (11,45 / 19,45) jsou obě za ní — ověřeno
// v prohlížeči, popisky se nevykreslily v žádném zoomu. Tyhle leží
// v pásu mezi hranicí ČR a zdí kamery.
//
// ⚠️ A KOTVÍ SE OD ZDI DOVNITŘ. Vystředěný nápis u zdi ukázal na telefonu
// jen „ĚCKO" – půlka slova zůstala za okrajem, což vypadá jako chyba.
// Odsazením bodu se to vyřešit NEDÁ: pás mezi hranicí a zdí je užší
// (0,2°) než šířka nápisu (~0,7° při plném oddálení). Kotva ano —
// 'left' = levý okraj textu na bodě, tedy text běží na východ, dovnitř.
const SOUSEDI = {
  type: 'FeatureCollection',
  features: [
    [12.00, 49.90, 'NĚMECKO', 'left'],
    [16.20, 51.20, 'POLSKO', 'top'],
    [15.30, 48.40, 'RAKOUSKO', 'bottom'],
    [19.00, 48.95, 'SLOVENSKO', 'right'],
  ].map(function (s) {
    return { type: 'Feature',
             properties: { jmeno: s[2], kotva: s[3] },
             geometry: { type: 'Point', coordinates: [s[0], s[1]] } };
  }),
};

// AKVAREL (6. 8.): lesy/pole/louky/voda jedou přes malované dlaždicové
// vzory (peče je pridejAkvarelVzory v main.js) místo plochých barev —
// objevený svět vypadá jako vybarvený štětcem. Uživatel směr SCHVÁLIL
// („rozhodně chci pokračovat v malovaném vzoru") → VÝCHOZÍ; porovnání
// s plochou verzí přes ?akvarel=0.
const AKVAREL = new URLSearchParams(location.search).get('akvarel') !== '0';

function stylHerni(ctx) {
  return {
    version: 8,
    name: 'Okolník — Herní kronika',
    glyphs: KONFIG.glyphs,
    // Hustší pergamenová atmosféra: dálky se rozpouštějí v barvě papíru,
    // což zakrývá LOD zlomy terénu u horizontu při velkém náklonu
    sky: {
      'sky-color': '#A9C6D6',
      'horizon-color': PALETA.pisek,
      'fog-color': '#EBDFC2',
      'sky-horizon-blend': 0.7,
      'horizon-fog-blend': 0.9,
      'fog-ground-blend': 0.42,
    },
    sources: zdroje(ctx, { sousedi: { type: 'geojson', data: SOUSEDI } }),
    layers: [
      // ===== BAREVNÉ PATRO (pod mlhou — odkrývá se objevováním) =====
      // 6. 8. „pohádkovější": teplejší papír, šťavnatější zeleně, zlatá
      // pole a výraznější akvarelový reliéf — objevený svět má vypadat
      // jako vybarvená ilustrace z dětského atlasu
      { id: 'pozadi', type: 'background',
        paint: { 'background-color': '#F1E4BE' } },
      { id: 'pole', type: 'fill', source: 'omt', 'source-layer': 'landcover',
        filter: ['==', ['get', 'class'], 'farmland'],
        paint: AKVAREL
          ? { 'fill-pattern': 'vzor-pole', 'fill-opacity': 0.6 }
          : { 'fill-color': '#E4DC96', 'fill-opacity': 0.55 } },
      // Vzory = jen BEZTVARÉ laviny barvy (žádné rozpoznatelné objekty
      // — jejich přeskládání mezi zoomy pak není vidět); stromy, kytky
      // a střechy kreslí jako skutečné BODY mapy js/dekorace.js
      { id: 'les', type: 'fill', source: 'omt', 'source-layer': 'landcover',
        filter: ['==', ['get', 'class'], 'wood'],
        paint: AKVAREL
          ? { 'fill-pattern': 'vzor-les', 'fill-opacity': 0.92 }
          : { 'fill-color': '#69A257', 'fill-opacity': 0.85 } },
      { id: 'louka', type: 'fill', source: 'omt', 'source-layer': 'landcover',
        filter: ['in', ['get', 'class'], ['literal', ['grass', 'wetland']]],
        paint: AKVAREL
          ? { 'fill-pattern': 'vzor-louka', 'fill-opacity': 0.65 }
          : { 'fill-color': '#BCD989', 'fill-opacity': 0.6 } },
      // ROZPITÉ OKRAJE LESŮ (stupeň 2): měkký tmavozelený nádech podél
      // hranic lesa — akvarel zapuštěný do mokrého papíru
      ...(AKVAREL ? [
        { id: 'les-okraj', type: 'line', source: 'omt',
          'source-layer': 'landcover',
          filter: ['==', ['get', 'class'], 'wood'],
          paint: { 'line-color': '#3E6B34', 'line-width': 7,
                   'line-blur': 6, 'line-opacity': 0.3 } },
      ] : []),
      // MĚSTA MALOVANĚ (stupeň 2): střechy jako cihlové tahy štětce
      { id: 'zastavba', type: 'fill', source: 'omt', 'source-layer': 'landuse',
        minzoom: 10,
        filter: ['==', ['get', 'class'], 'residential'],
        paint: AKVAREL
          ? { 'fill-pattern': 'vzor-mesta', 'fill-opacity': 0.75 }
          : { 'fill-color': '#E9C89C', 'fill-opacity': 0.6 } },
      // Akvarelový reliéf: teplé světlo, tmavě zelený stín (cíl = obrázek 3)
      //
      // ⭐ v1.529: VÍC PLASTIKY („našlo by do mapy herního stylu přidat
      // trochu více bump efektu“). Dvě změny, obě důležitější než
      // pouhé přitlačení čísla:
      //
      // ① `illumination-anchor: 'map'` — výchozí `viewport` značí, že
      //   světlo svítí pořád od horího okraje OBRAZOVKY. Při otočení
      //   mapy se tak stíny přelévají na druhou stranu kopce a mozek
      //   přestane vidět pevný tvar — vypadá to ploše. S kotvou
      //   v mapě svítí slunce pořád od severozápadu (335°, kartografická
      //   konvence) a kopce drží tvar i při otáčení kompasem.
      //
      // ② síla podle zoomu místo konstanty. Zdroj `stinovani` má strop
      //   z13, takže při velkém přiblížení se dlaždice přetahuje a
      //   kvantizace terraria (kroky 1/256 m) by se při vysoké síle
      //   ukázala jako šrafy. Proto nejvíc uprostřed (z11–14, kde se
      //   krajina čte jako reliéf) a mírněji na krajích.
      //
      // ⚠️ OTÁČENÍ MAPY JE V APPCE VYPNUTÉ (uživatel 21. 8.), takže
      // sama kotva světla nic viditelněho neudělá — zůstává jako
      // správnější výchozí stav pro chvíli, kdy se otáčení povolí.
      // Vidět je až ② síla a ③ druhá vrstva níž.
      { id: 'stinovani', type: 'hillshade', source: 'stinovani',
        paint: { 'hillshade-exaggeration':
                   ['interpolate', ['linear'], ['zoom'],
                    7, 0.85, 11, 1.0, 14, 1.0, 16, 0.9],
                 'hillshade-illumination-anchor': 'map',
                 'hillshade-illumination-direction': 335,
                 'hillshade-shadow-color': '#24483A',
                 'hillshade-highlight-color': '#FFFDF0',
                 'hillshade-accent-color': '#2E7D5B' } },
      // ③ DRUHÁ VRSTVA STEJNÉHO RELIÉFU Z PROTISMĚRU (v1.530).
      //
      // `hillshade-exaggeration` má strop 1,0 — víc plastiky už z jedné
      // vrstvy nedostanu. Druhý průchod se světlem z opačné strany
      // (155°) přidá stín na přivrácené svahy, které první vrstva
      // nechala plavé — kopec pak má světlou i tmavou tvář a čte se
      // jako těleso, ne jako skvrna. Kreslí se slabě (0,45) a jen
      // stínem, aby to nerozsvítilo akvarel.
      //
      // ⚠️ Zdroj je TÝŽ (`stinovani`), takže žádné nové dlaždice po
      // drátě ani do paměti — jen druhý průchod shaderu nad týmž DEM.
      // v1.599.1: protisvětlo jen do z14 — stojí ~2 ms/snímek (změřeno
      // 2. 9.) a při větším přiblížení už ho ulice a domy přebijí
      { id: 'stinovani-protisvetlo', type: 'hillshade',
        source: 'stinovani', maxzoom: 14,
        paint: { 'hillshade-exaggeration':
                   ['interpolate', ['linear'], ['zoom'],
                    7, 0.3, 11, 0.45, 14, 0.45, 16, 0.35],
                 'hillshade-illumination-anchor': 'map',
                 'hillshade-illumination-direction': 155,
                 'hillshade-shadow-color': '#3A5C46',
                 'hillshade-highlight-color': 'rgba(0,0,0,0)',
                 'hillshade-accent-color': 'rgba(0,0,0,0)' } },
      { id: 'voda', type: 'fill', source: 'omt', 'source-layer': 'water',
        paint: AKVAREL
          ? { 'fill-pattern': 'vzor-voda', 'fill-opacity': 0.92 }
          : { 'fill-color': PALETA.tyrkys, 'fill-opacity': 0.92 } },
      { id: 'reky', type: 'line', source: 'omt', 'source-layer': 'waterway',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': PALETA.tyrkys, 'line-blur': 0.4,
                 // interpolace musí být vnější výraz (limit MapLibre)
                 'line-width': ['interpolate', ['exponential', 1.4], ['zoom'],
                   7, ['match', ['get', 'class'], 'river', 1.4, 0.5],
                   16, ['match', ['get', 'class'], 'river', 5, 2.4]] } },
      // ⭐ v1.538: CESTY MUSÍ BÝT VIDĚT (výtka „v herním módu nejsou
      // moc vidět silnice a cesty“). Měly **pevnou šířku 1,1 px** —
      // při přiblížení tedy nerostly vůbec a tmavě zelená čárkovaná
      // čára se v akvarelové trávě ztratila. Teď roste se zoomem a má
      // hnědou barvu prašné cesty místo zelené.
      { id: 'cesty', type: 'line', source: 'omt',
        'source-layer': 'transportation', minzoom: 12,
        filter: ['in', ['get', 'class'], ['literal', ['path', 'track']]],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#6B5636', 'line-width': sirka(12, 1.4, 17, 4.0),
                 'line-opacity': 0.95,
                 'line-dasharray': [2.2, 1.6] } },
      // ⭐ v1.540: ÚČELOVÉ CESTY (`service`) — příjezdy k domům, cesty
      // po dvorech a parkovištích. Do teď v herní mapě CHYBĚLY ÚPLNĚ,
      // takže zástavba vypadala jako slepé bloky bez přístupu.
      // Až od z14,5: níž by z vesnice byla jen změť čárek.
      { id: 'silnice-servisni', type: 'line', source: 'omt',
        'source-layer': 'transportation', minzoom: 14.5,
        filter: ['==', ['get', 'class'], 'service'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#A98F63',
                 'line-width': sirka(14.5, 0.9, 17, 2.8) } },
      { id: 'silnice-mistni', type: 'line', source: 'omt',
        'source-layer': 'transportation', minzoom: 11,
        filter: ['in', ['get', 'class'],
                 ['literal', ['minor', 'tertiary', 'secondary']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#8C6C39',
                 'line-width': sirka(11, 1.3, 16, 5.4) } },
      { id: 'silnice-hlavni', type: 'line', source: 'omt',
        'source-layer': 'transportation', minzoom: 8,
        filter: ['in', ['get', 'class'],
                 ['literal', ['primary', 'trunk', 'motorway']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#B0670F', 'line-width': sirka(8, 1.6, 16, 6.4),
                 'line-opacity': 1 } },
      { id: 'budovy-vypln', type: 'fill', source: 'omt',
        'source-layer': 'building', minzoom: 14,
        paint: { 'fill-color': '#DCC9A5', 'fill-opacity': 0.8 } },

      // ===== INKOUSTOVÉ PATRO (nad mlhou — kronika viditelná vždy) =====
      // Vrstevnice: nad pergamenem dají neobjevenému terénu „mapovou" strukturu
      { id: 'ink-vrstevnice', type: 'line', source: 'kontury',
        'source-layer': 'contours', minzoom: 13,  // v1.420: 11,5→13 — vrstevnice stály ~10 dlouhých/gesto tam, kde nejsou vidět
        filter: ['!=', ['get', 'level'], 1],
        paint: { 'line-color': KRONIKA.inkSvetla,
                 // ⭐ DOMALOVÁVÁNÍ (7. 8. 2026): vrstevnice nastoupí až
                 // s přiblížením – z dálky by jen zašuměly podmalbu.
                 'line-opacity': ['interpolate', ['linear'], ['zoom'],
                   12.5, 0, 14.5, 0.3],
                 'line-width': 0.6 } },
      { id: 'ink-vrstevnice-hlavni', type: 'line', source: 'kontury',
        'source-layer': 'contours', minzoom: 13,  // v1.420: 11,5→13 — vrstevnice stály ~10 dlouhých/gesto tam, kde nejsou vidět
        filter: ['==', ['get', 'level'], 1],
        paint: { 'line-color': KRONIKA.inkSvetla,
                 // hlavní vrstevnice nastupují dřív než vedlejší
                 'line-opacity': ['interpolate', ['linear'], ['zoom'],
                   11.5, 0, 13.5, 0.45],
                 'line-width': 1.1 } },
      // ⭐ v1.436: kóty vrstevnic v KRONICE dřív nebyly VŮBEC
      // („ne všechny vrstevnice mají napsanou výšku“) — hlavní
      // od z14 sépiově, ať rytina zůstane čistá
      { id: 'ink-vrstevnice-koty', type: 'symbol', source: 'kontury',
        'source-layer': 'contours', minzoom: 14,
        filter: ['==', ['get', 'level'], 1],
        layout: { 'symbol-placement': 'line',
                  'text-field': ['concat', ['get', 'ele'], ' m'],
                  'text-font': FONT_I, 'text-size': 9.5 },
        paint: { 'text-color': KRONIKA.inkSvetla,
                 'text-halo-color': KRONIKA.pergamen || '#F1E4BE',
                 'text-halo-width': 1.1 } },
      // Vodstvo tuší: obrysy břehů + tenké linky řek
      { id: 'ink-voda-obrys', type: 'line', source: 'omt',
        'source-layer': 'water', minzoom: 8,
        paint: { 'line-color': KRONIKA.ink, 'line-opacity': 0.55,
                 'line-width': 0.9 } },
      { id: 'ink-reky', type: 'line', source: 'omt', 'source-layer': 'waterway',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#5A4632', 'line-opacity': 0.6,
                 'line-width': ['interpolate', ['exponential', 1.4], ['zoom'],
                   7, ['match', ['get', 'class'], 'river', 0.7, 0.3],
                   16, ['match', ['get', 'class'], 'river', 1.8, 1]] } },
      // Jen dálkové tahy — na kronice je síť cest záměrně řídká
      { id: 'ink-silnice', type: 'line', source: 'omt',
        'source-layer': 'transportation', minzoom: 8,
        filter: ['in', ['get', 'class'],
                 ['literal', ['motorway', 'trunk', 'primary']]],
        paint: { 'line-color': '#6E5236', 'line-opacity': 0.75,
                 'line-width': sirka(8, 0.9, 16, 2.4) } },
      // ⭐ v1.540: KOLEJE JAKO KOLEJE. Byla to jedna přerušovaná čárka
      // o šířce 1,1 px při krytí 0,6 — v kronikové kresbě k nerozeznání
      // od potoka. Teď je to plná tmavá kolej a NA NÍ SVĚTLÉ PRAŽCE:
      // dvojice vrstev, kterou oko přečte jako železnici okamžitě
      // (a je to tentýž recept, jaký používají běžné mapy).
      { id: 'ink-zeleznice', type: 'line', source: 'omt',
        'source-layer': 'transportation', minzoom: 9.5,
        filter: ['==', ['get', 'class'], 'rail'],
        paint: { 'line-color': KRONIKA.ink,
                 'line-width': sirka(10.5, 1.0, 17, 3.2),
                 'line-opacity': ['interpolate', ['linear'], ['zoom'],
                   10.5, 0, 12, 0.85] } },
      { id: 'ink-zeleznice-prahy', type: 'line', source: 'omt',
        'source-layer': 'transportation', minzoom: 11.5,
        filter: ['==', ['get', 'class'], 'rail'],
        paint: { 'line-color': '#F4EBD8',
                 'line-width': sirka(11.5, 0.6, 17, 1.9),
                 'line-dasharray': [1.5, 2.1],
                 'line-opacity': ['interpolate', ['linear'], ['zoom'],
                   11.5, 0, 12.5, 0.9] } },
      // Jednoduché obrysy budov perem (výplň čeká pod mlhou na objevení)
      { id: 'ink-budovy', type: 'line', source: 'omt',
        'source-layer': 'building', minzoom: 14,
        paint: { 'line-color': '#5A4632',
                 // obrysy budov se dokreslují posledními – nejjemnější
                 // pero kroniky
                 'line-opacity': ['interpolate', ['linear'], ['zoom'],
                   14, 0, 15.2, 0.75],
                 'line-width': 0.8 } },
      // Hranice ČR — kreslený dvojtah (měkký svit + čára tuší)
      { id: 'ink-hranice-svit', type: 'line', source: 'omt',
        'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2],
                 ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': '#8A6F4A', 'line-width': 6,
                 'line-blur': 5, 'line-opacity': 0.3 } },
      { id: 'ink-hranice-stat', type: 'line', source: 'omt',
        'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2],
                 ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': KRONIKA.inkTmava, 'line-width': 2.2,
                 'line-dasharray': [3, 1.6] } },
      { id: 'ink-hranice-kraj', type: 'line', source: 'omt',
        'source-layer': 'boundary', minzoom: 7,
        filter: ['==', ['get', 'admin_level'], 4],
        paint: { 'line-color': KRONIKA.inkSvetla, 'line-width': 0.9,
                 'line-dasharray': [3, 3], 'line-opacity': 0.55 } },
      // Vrcholy perem — na dálku jen významné (rank ≤ 2), od z12 všechny.
      // Zoom ve filtru se vyhodnocuje jen na CELÝCH úrovních → práh musí
      // být celé číslo (11.5 by se fakticky choval jako 12)
      // Vrcholy perem — na dálku jen významné (rank ≤ 2), od z12 VŠECHNY
      // i s výškou jako v neherním režimu (přání 6. 8.: méně významná
      // místa bez kresby ať mají po přiblížení aspoň značku kopce).
      // Vrcholy se jménem shodným s malovaným místem odfiltruje
      // Ilustrace.pripoj (jinak by byly dvakrát — kresba + ▲).
      { id: 'ink-vrcholy', type: 'symbol', source: 'omt',
        'source-layer': 'mountain_peak', minzoom: 9,
        filter: ['case', ['<', ['zoom'], 12],
                 ['<=', ['coalesce', ['get', 'rank'], 9], 2], true],
        layout: {
          'text-field': ['format',
            '▲\n', { 'text-font': ['literal', FONT_B], 'font-scale': 1.1 },
            NAZEV, { 'text-font': ['literal', FONT_I], 'font-scale': 0.9 },
            ['case', ['has', 'ele'],
             ['concat', '\n', ['get', 'ele'], ' m'], ''],
            { 'font-scale': 0.72 }],
          // kurzíva + sépie = „přírodní jev", odliší kopec od vsi
          'text-font': FONT_I, 'text-size': 13, 'text-anchor': 'center',
        },
        paint: { 'text-color': KRONIKA.inkSvetla, 'text-halo-color': KRONIKA.halo,
                 'text-halo-width': 1.6 } },
      // Herní cíle: mosazné špendlíky na kronice (hrady, vyhlídky)
      { id: 'ink-cile', type: 'circle', source: 'omt', 'source-layer': 'poi',
        minzoom: 10.5,
        filter: ['any', ['==', ['get', 'class'], 'castle'],
                 ['==', ['get', 'subclass'], 'viewpoint']],
        paint: { 'circle-color': PALETA.oranz, 'circle-radius': 4.5,
                 'circle-stroke-color': KRONIKA.inkTmava,
                 'circle-stroke-width': 1.4 } },
      { id: 'ink-cile-nazvy', type: 'symbol', source: 'omt',
        'source-layer': 'poi', minzoom: 11.5,
        filter: ['any', ['==', ['get', 'class'], 'castle'],
                 ['==', ['get', 'subclass'], 'viewpoint']],
        layout: { 'text-field': NAZEV, 'text-font': FONT_B, 'text-size': 11.5,
                  'text-anchor': 'top', 'text-offset': [0, 0.7] },
        paint: { 'text-color': '#7A4E1E', 'text-halo-color': KRONIKA.halo,
                 'text-halo-width': 1.5 } },
      { id: 'ink-voda-nazvy', type: 'symbol', source: 'omt',
        'source-layer': 'water_name', minzoom: 10,
        layout: { 'text-field': NAZEV, 'text-font': FONT_I, 'text-size': 12 },
        paint: { 'text-color': '#3D5148', 'text-halo-color': KRONIKA.halo,
                 'text-halo-width': 1.3 } },
      // Sídla: tečka perem + jméno kronikovým písmem
      { id: 'ink-obce-body', type: 'circle', source: 'omt',
        'source-layer': 'place', minzoom: 8, maxzoom: 14,
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village']]],
        paint: {
          'circle-color': KRONIKA.inkTmava,
          'circle-radius': ['match', ['get', 'class'],
                            'city', 5, 'town', 3.6, 2.4],
          'circle-stroke-color': '#FDF6E3', 'circle-stroke-width': 1.6 } },
      // ⭐⭐⭐ JMÉNA SÍDEL PO TŘÍDÁCH, KAŽDÁ VLASTNÍ VRSTVA S `minzoom`
      // (10. 8. 2026 — výtka „při oddalování zůstanou názvy vesniček
      // z předchozí úrovně a chvíli trvá, než zmizí; vytváří to chvilkové
      // přehlcení").
      //
      // PROČ SE TO DĚLO: prahy byly ve FILTRU (`['>=', ['zoom'], 10]`).
      // Jenže `['zoom']` ve filtru vyhodnocuje MapLibre podle **zoomu
      // dlaždice**, ne podle aktuálního zoomu mapy — a při oddalování se
      // ještě chvíli kreslí staré, jemnější dlaždice, které si to
      // rozhodnutí nesou s sebou. Jména proto zmizela až s příchodem
      // hrubších dlaždic, tedy o vteřinu či dvě později.
      //
      // `minzoom` VRSTVY se naproti tomu porovnává s aktuálním zoomem
      // mapy, takže reakce je okamžitá. Prahy zůstávají tytéž, co byly
      // (vesnice 10, samoty 12) — mění se jen to, KDY se uplatní.
      //
      // ⚠️ Pořadí vrstev = pořadí rozmisťování symbolů: první vyhrává
      // kolize. Města tedy musí být PRVNÍ, ať je nevytlačí vesnička.
      // ⚠️ Pořadí = pořadí rozmisťování: první vyhrává kolize, proto
      // města nahoře. `minzoom` (ne filtr se `['zoom']`) proto, aby při
      // oddálení jména mizela OKAMŽITĚ — viz poznámka o zoomu dlaždice.
      { id: 'ink-mesta', type: 'symbol', source: 'omt', 'source-layer': 'place',
        filter: ['==', ['get', 'class'], 'city'],
        layout: obceLayout(FONT_B, 17, true),
        paint: obcePaint(KRONIKA.inkTmava) },
      { id: 'ink-mestyse', type: 'symbol', source: 'omt', 'source-layer': 'place',
        filter: ['==', ['get', 'class'], 'town'],
        // ⭐ 12. 8.: tučně 14 — viz poznámka u `mestyse` v turistické
        layout: obceLayout(FONT_B, 14, false),
        paint: obcePaint(KRONIKA.inkTmava) },
      { id: 'ink-vesnice', type: 'symbol', source: 'omt', 'source-layer': 'place',
        minzoom: 10,
        filter: ['==', ['get', 'class'], 'village'],
        layout: obceLayout(FONT, 10.5, false),
        paint: obcePaint(KRONIKA.ink) },
      { id: 'ink-obce', type: 'symbol', source: 'omt', 'source-layer': 'place',
        minzoom: 12,
        filter: ['==', ['get', 'class'], 'hamlet'],
        layout: obceLayout(FONT, 9, false),
        paint: obcePaint(KRONIKA.inkSvetla) },
      // Popisky sousedních států při oddálení (2D protějšek: `_neighborArrows`).
      // ⚠️ MUSÍ ZŮSTAT ÚPLNĚ POSLEDNÍ: mlha se vkládá PŘED první vrstvu
      // `ink-` (fog.js → `kotva()`), takže všechno za ní se kreslí NAD
      // pergamenem. Posunutí výš by nápisy schovalo pod mlhu.
      // Barva je tuš, ne pískový odstín z 2D — na světlém pergamenu by
      // písek nebyl vidět. `text-font` je tatáž konstanta jako u obcí;
      // sadu, kterou styl nezná, MapLibre TIŠE zahodí i s celou vrstvou.
      { id: 'ink-sousedi', type: 'symbol', source: 'sousedi',
        minzoom: 5, maxzoom: 9.5,
        layout: {
          'text-field': ['get', 'jmeno'], 'text-font': FONT_B,
          'text-size': 13, 'text-letter-spacing': 0.18,
          // kotva od zdi kamery dovnitř (viz SOUSEDI)
          'text-anchor': ['coalesce', ['get', 'kotva'], 'center'],
          // jen orientace — nesmí vytlačit popisky uvnitř ČR ani zmizet
          'text-allow-overlap': true, 'text-ignore-placement': true,
        },
        paint: { 'text-color': KRONIKA.inkSvetla, 'text-opacity': 0.85,
                 'text-halo-color': KRONIKA.halo, 'text-halo-width': 1.6 } },
    ],
  };
}

// ---------------------------------------------------------------------------
// DOBYVATEL — čistý podklad JAKO WEBOVÁ MAPA (28. 8.): béžová +
// stínovaný terén; z vektoru jen voda, státní hranice a jména sídel.
// Území vlajek a bublinky kreslí js/dobyvatel.js nad tím.
// ---------------------------------------------------------------------------
function stylDobyvatel(ctx) {
  return {
    version: 8,
    name: 'Okolník — Dobyvatel',
    glyphs: KONFIG.glyphs,
    sky: obloha(),
    sources: zdroje(ctx),
    layers: [
      { id: 'pozadi', type: 'background',
        paint: { 'background-color': '#f2efe6' } },
      // ⚠️ BEZ maxzoom na vrstvě — s ním se stínování nad z13
      // vypnulo a „kresba mapy se ztratila" (výtka 28. 8.); zdroj
      // má strop 13 a overzoom kreslí dál
      { id: 'stinovani', type: 'hillshade', source: 'stinovani',
        // plastičtější (přání 28. 8.) — zblízka dál slábne kvůli
        // hranatým vadám DEM
        paint: { 'hillshade-exaggeration': ['interpolate',
                   ['linear'], ['zoom'], 10, 0.74, 12, 0.52, 14, 0.32],
                 'hillshade-shadow-color': '#6e6150',
                 // odlesk = barva papíru (bílá vysvěcovala vady DEM)
                 'hillshade-highlight-color': '#f5f1e4' } },
      // jemné zvýraznění vodstva (přání 28. 8.) — stejné jako web
      { id: 'voda', type: 'fill', source: 'omt',
        'source-layer': 'water',
        paint: { 'fill-color': '#b9d4e3', 'fill-opacity': 0.85 } },
      { id: 'voda-obrys', type: 'line', source: 'omt',
        'source-layer': 'water', minzoom: 9,
        paint: { 'line-color': '#8fb4c9', 'line-opacity': 0.5,
                 'line-width': 0.7 } },
      { id: 'reky', type: 'line', source: 'omt',
        'source-layer': 'waterway', minzoom: 9,
        paint: { 'line-color': '#8fb8cf', 'line-opacity': 0.9,
                 'line-width': sirka(9, 0.8, 16, 3.0) } },
      // ⭐ v1.592 NEVIDITELNÍ NOSIČI PLOCH: dekorace (světla vesnic
      // v noci, podzimní roj) si plochy čtou z VRSTEV STYLU
      // (definicePloch v dekorace.js) — bez les/louka/pole/zastavba
      // by v Dobyvateli nikdy nevznikly. Nulová opacita: vzhled
      // bojiště se nemění, jen dlaždice nesou potřebná data.
      { id: 'pole', type: 'fill', source: 'omt',
        'source-layer': 'landcover',
        filter: ['==', ['get', 'class'], 'farmland'],
        paint: { 'fill-color': '#000', 'fill-opacity': 0 } },
      { id: 'les', type: 'fill', source: 'omt',
        'source-layer': 'landcover',
        filter: ['==', ['get', 'class'], 'wood'],
        paint: { 'fill-color': '#000', 'fill-opacity': 0 } },
      { id: 'louka', type: 'fill', source: 'omt',
        'source-layer': 'landcover',
        filter: ['in', ['get', 'class'],
                 ['literal', ['grass', 'wetland']]],
        paint: { 'fill-color': '#000', 'fill-opacity': 0 } },
      { id: 'zastavba', type: 'fill', source: 'omt',
        'source-layer': 'landuse', minzoom: 10,
        filter: ['==', ['get', 'class'], 'residential'],
        paint: { 'fill-color': '#000', 'fill-opacity': 0 } },
      { id: 'vrstevnice', type: 'line', source: 'kontury',
        'source-layer': 'contours', minzoom: 12,
        filter: ['!=', ['get', 'level'], 1],
        paint: { 'line-color': '#9c8760', 'line-opacity': 0.42,
                 'line-width': 0.7 } },
      { id: 'vrstevnice-hlavni', type: 'line', source: 'kontury',
        'source-layer': 'contours', minzoom: 12,
        filter: ['==', ['get', 'level'], 1],
        paint: { 'line-color': '#9c8760', 'line-opacity': 0.6,
                 'line-width': 1.2 } },
      { id: 'vrstevnice-koty', type: 'symbol', source: 'kontury',
        'source-layer': 'contours', minzoom: 13,
        filter: ['==', ['get', 'level'], 1],
        // kóty výrazněji, čáry tlumeněji (přání 29. 8.)
        layout: { 'symbol-placement': 'line-center',
                  'text-max-angle': 80,
                  'text-field': ['concat', ['get', 'ele'], ' m'],
                  'text-font': FONT_B, 'text-size': 11.5 },
        paint: { 'text-color': '#7a6540',
                 'text-halo-color': '#f2efe6',
                 'text-halo-width': 1.5 } },
      { id: 'silnice', type: 'line', source: 'omt',
        'source-layer': 'transportation', minzoom: 9,
        filter: ['in', ['get', 'class'],
                 ['literal', ['motorway', 'trunk', 'primary',
                              'secondary', 'tertiary']]],
        paint: { 'line-color': '#cfc6b2', 'line-opacity': 0.9,
                 'line-width': sirka(9, 0.5, 16, 3) } },
      { id: 'ulice', type: 'line', source: 'omt',
        'source-layer': 'transportation', minzoom: 13,
        filter: ['in', ['get', 'class'],
                 ['literal', ['minor', 'service']]],
        paint: { 'line-color': '#d6cdb9', 'line-opacity': 0.8,
                 'line-width': sirka(13, 0.5, 16, 1.8) } },
      { id: 'cesty', type: 'line', source: 'omt',
        'source-layer': 'transportation', minzoom: 12,
        filter: ['in', ['get', 'class'],
                 ['literal', ['path', 'track']]],
        paint: { 'line-color': '#b9ae95', 'line-opacity': 0.8,
                 'line-width': sirka(12, 0.4, 16, 1.5),
                 'line-dasharray': [2, 1.6] } },
      { id: 'hranice-stat', type: 'line', source: 'omt',
        'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2],
                 ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': '#43413a', 'line-opacity': 0.8,
                 'line-width': 1.6 } },
      { id: 'sidla', type: 'symbol', source: 'omt',
        'source-layer': 'place', minzoom: 7,
        filter: ['in', ['get', 'class'],
                 ['literal', ['city', 'town', 'village']]],
        layout: {
          'text-field': NAZEV, 'text-font': FONT_B,
          'text-size': ['match', ['get', 'class'],
                        'city', 15.5, 'town', 13, 11.5],
          'text-padding': 6,
        },
        paint: { 'text-color': '#5d7285',
                 'text-halo-color': '#f2efe6',
                 'text-halo-width': 1.6 } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Registr stylů. „zakladni" je hotový styl Liberty (URL) — terén a stínování
// se do něj injektují za běhu v main.js.
// ---------------------------------------------------------------------------
function vytvorStyly(ctx) {
  return {
    zakladni: {
      nazev: 'Základní',
      podklad: 'https://tiles.openfreemap.org/styles/liberty',
      // ⭐ 12. 8.: převýšení neherních stylů zvednuto na přání („3D je
      // nad rovinou nenápadné") — herní 1,5 zůstává nejvýš
      teren: 1.4,
      injektovatStinovani: true,
    },
    letecka: { nazev: 'Letecká', podklad: stylLetecka(ctx), teren: 1.3 },
    // noc: true → noční ztmavení + světla vesnic i tady (v1.592;
    // mlha a počasí v Dobyvateli dál nejsou)
    dobyvatel: { nazev: 'Dobyvatel', noc: true,
                 podklad: stylDobyvatel(ctx),
                 teren: 1.4 },
    turisticka: { nazev: 'Turistická', podklad: stylTuristicka(ctx), teren: 1.4 },
    // ⭐ v1.393: terén ZAPEČENÝ do herního stylu — mapa se s ním rodí
    // (přepnutí projekce po startu posouvalo obraz o stovky px, chyceno
    // lovcem i po opravě časování; závod se stažením DEM nejde vyhrát).
    // Oddálení pod pásmo ho sundá `sundejTeren` jako dosud.
    herni: {
      nazev: 'Herní',
      podklad: (() => {
        const s = stylHerni(ctx);
        s.terrain = { source: 'teren', exaggeration: 1.5 };
        return s;
      })(),
      teren: 1.5,
      mlha: true,
    },
  };
}
