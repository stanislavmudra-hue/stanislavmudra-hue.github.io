// Okolník 3D — hlavní logika enginu: mapa, 3D terén, přepínání stylů,
// přelety, měření výšky. Vyžaduje styles.js + fog.js + maplibre-gl
// + maplibre-contour + pmtiles (vendor).
'use strict';

// ---------------------------------------------------------------------------
// ODCHYT TICHÝCH CHYB. `start()` je `async`, takže výjimka uvnitř skončí jako
// zamítnutý příslib a NIKDE se neohlásí — mapa prostě zůstane prázdná a
// v logu není nic (stálo to hodinu hledání 30. 7. 2026). V APK je konzole
// vidět přes `adb logcat -s flutter:I`.
// ---------------------------------------------------------------------------
window.addEventListener('error', (e) => {
  // ⭐ SE ZÁSOBNÍKEM (11. 8. 2026, hon na „already running"): bez něj
  // logcat říkal jen JMÉNO chyby a viník se hledal celý den naslepo.
  console.warn('[chyba]', e.message,
               (e.filename || '') + ':' + e.lineno + ':' + e.colno,
               (e.error && e.error.stack ? '\n' + e.error.stack : ''));
  hlidejOtravenouFrontu(e.message || '');
});

// ⭐⭐⭐ SAMOLÉČENÍ OTRÁVENÉ FRONTY SNÍMKŮ (11. 8. 2026).
//
// Když výjimka proletí obsluhou snímku MapLibre (`TaskQueue.run` nemá
// finally), zůstane fronta zamčená (`_currentlyRunning`) a KAŽDÝ další
// snímek hodí „Attempting to run(), but is already running". Mapa pak
// navěky `moving true`: dlaždice se nenačítají, gesta mrtvá, uživatel
// vidí šedou plochu. Stalo se to opakovaně (v1.354, 357, i v1.358 bez
// vlastního kamerového kódu) — spouštěč je vzácný souběh, ale důsledek
// fatální a trvalý.
//
// Léčba: při lavině těch chyb odemknout frontu a korektně zastavit
// mrtvou animaci PŘES VEŘEJNÉ `stop()` — ODLOŽENĚ (setTimeout 0),
// tedy MIMO jakoukoli právě běžící kaskádu událostí. Nejvýš 3 pokusy
// za minutu, ať se to nemůže zacyklit.
let lecbaCasy = [];
let lecbaNaplanovana = false;
function hlidejOtravenouFrontu(zprava) {
  if (!/already running|_onEaseFrame/.test(zprava)) return;
  if (lecbaNaplanovana) return;
  const ted = Date.now();
  lecbaCasy = lecbaCasy.filter((t) => ted - t < 60000);
  if (lecbaCasy.length >= 3) return;   // třikrát stačilo — ať je vidět pád
  lecbaCasy.push(ted);
  lecbaNaplanovana = true;
  setTimeout(() => {
    lecbaNaplanovana = false;
    try {
      if (!mapa) return;
      const fronta = mapa._renderTaskQueue;
      if (fronta && fronta._currentlyRunning) {
        fronta._currentlyRunning = false;
      }
      try { mapa.stop(); } catch (e) { /* mrtvá animace už neběží */ }
      mapa.triggerRepaint();
      console.log('[samoleceni] fronta snímků odemčena a animace zastavena');
    } catch (e) {
      console.warn('[samoleceni] nezdar:', e && e.message);
    }
  }, 0);
}
window.addEventListener('unhandledrejection', (e) => {
  const d = e.reason;
  console.warn('[chyba-promise]', (d && d.message) || d,
               (d && d.stack) || '');
});

// ---------------------------------------------------------------------------
// Volba zdrojů dlaždic — kaskáda spolehlivosti:
//   1. LOKÁLNÍ pipeline (desktop s běžícím serve.py) — nejrychlejší,
//   2. SERVERY po řadě: R2 (plná kvalita z6–14, přímé čtení s CORS)
//      → GitHub Releases (z6–13, jen v aplikaci přes proxy :8138 —
//        release assety nemají CORS),
//   3. DEMO — veřejné zdroje z KONFIG (AWS terén, OpenFreeMap).
// Vynucení přes URL: ?zdroj=lokal|server|demo. Strop kvality terénu:
// ?teren=13 (nebo automaticky dle paměti zařízení — šetří data).
// ---------------------------------------------------------------------------
const R2_ZAKLAD = 'https://pub-503fa062ecca4774b24370946e2b2a70.r2.dev/';
// Port GitHub proxy posílá obálka v ?ghport= (porty se hledají dynamicky,
// pevný 8138 se pral s aplikací Okolník běžící vedle)
const GH_PORT = new URLSearchParams(location.search).get('ghport') || '8138';
// ⭐⭐ R2 JDE V APPCE PŘES LOKÁLNÍ PROXY (8. 8. 2026). PMTiles čte archiv
// Range požadavky a přímo v `styles.js` je poznámka, že „na HTTP keš
// WebView se u Range požadavků spolehnout nedá" — takže se při KAŽDÉM
// spuštění appky stahovalo znovu ~5 MB (změřeno: 183 požadavků, poslední
// dorazil ve 21 s). Uživatel to popsal jako „stále musím pohnout mapou,
// jinak hrozně dlouho trvá načtení".
// Proxy v `mapa3d_view.dart` má od v1.302 keš NA DISKU, takže když přes ni
// R2 pustíme, druhé a další spuštění už nestahuje nic.
// ⚠️ Mimo appku (engine bokem) žádná proxy neběží → jede se napřímo.
const R2_PRES_PROXY = new URLSearchParams(location.search).get('app') === '1';
const r2 = (soubor) => 'pmtiles://' + (R2_PRES_PROXY
  ? `http://localhost:${GH_PORT}/r2/${soubor}`
  : R2_ZAKLAD + soubor);
const SERVERY = [
  { nazev: 'R2',
    teren: r2('teren_cr_z14.pmtiles'),
    vektor: r2('cesko_vektor.pmtiles'),
    terenMaxZoom: 14 },
  { nazev: 'GitHub',
    teren: `pmtiles://http://localhost:${GH_PORT}/gh/teren_cr.pmtiles`,
    vektor: `pmtiles://http://localhost:${GH_PORT}/gh/cesko_vektor.pmtiles`,
    terenMaxZoom: 13 },
];
const ATRIBUCE_DMR = 'Výškopis DMR 5G © ČÚZK';
const ATRIBUCE_OMT = '© OpenMapTiles © OpenStreetMap contributors';

async function zjistiVlastniZdroje() {
  if (typeof pmtiles !== 'undefined' && !maplibregl.getProtocol?.('pmtiles')) {
    try { maplibregl.addProtocol('pmtiles', new pmtiles.Protocol().tile); }
    catch (e) { /* už registrováno */ }
  }
  const rezim = new URLSearchParams(location.search).get('zdroj');
  if (rezim === 'demo') { console.log('[Okolník 3D] zdroje: DEMO (vynuceno)'); return; }

  // POZOR: lokální server v APK vrací 200 i pro neexistující cesty,
  // proto se kontroluje OBSAH (PNG magic / „PMTiles" hlavička), ne status.
  async function existujeDlazdice(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) return false;
      const b = new Uint8Array(await r.arrayBuffer());
      return b.length > 8 && b[0] === 0x89 && b[1] === 0x50;   // ‰P = PNG
    } catch (e) { return false; }
  }
  async function existujePmtiles(url) {
    try {
      const r = await fetch(url, { headers: { Range: 'bytes=0-6' } });
      if (!r.ok) return false;
      const b = new Uint8Array((await r.arrayBuffer()).slice(0, 7));
      return String.fromCharCode(...b) === 'PMTiles';
    } catch (e) { return false; }
  }

  // 1) lokální pipeline (jen pokud není vynucen server)
  if (rezim !== 'server') {
    if (await existujeDlazdice('../pipeline/data/teren/6/34/21.png')) {
      KONFIG.terenUrl = new URL('../pipeline/data/teren/', location.href).href
        + '{z}/{x}/{y}.png';
      // z14 (Sněžka) na disku? Pak plná kvalita.
      KONFIG.terenMaxZoom =
        (await existujeDlazdice('../pipeline/data/teren/14/8908/5504.png'))
          ? 14 : 13;
      KONFIG.terenAtribuce = ATRIBUCE_DMR;
      console.log(
        `[Okolník 3D] terén: LOKÁLNÍ dlaždice (DMR 5G, z≤${KONFIG.terenMaxZoom})`);
    }
    if (await existujePmtiles('../pipeline/data/cesko_vektor.pmtiles')) {
      KONFIG.vektorUrl = 'pmtiles://'
        + new URL('../pipeline/data/cesko_vektor.pmtiles', location.href).href;
      KONFIG.vektorAtribuce = ATRIBUCE_OMT;
      console.log('[Okolník 3D] vektor: LOKÁLNÍ PMTiles (Planetiler ČR)');
    }
    if (KONFIG.terenAtribuce && KONFIG.vektorAtribuce) return;
  }

  // 2) servery po řadě (R2 → GitHub) — ověří dostupnost, Range i CORS
  for (const s of SERVERY) {
    if (KONFIG.terenAtribuce && KONFIG.vektorAtribuce) break;
    if (!KONFIG.terenAtribuce
        && await existujePmtiles(s.teren.replace('pmtiles://', ''))) {
      KONFIG.terenUrl = s.teren;
      KONFIG.terenMaxZoom = s.terenMaxZoom;
      KONFIG.terenAtribuce = ATRIBUCE_DMR;
      console.log(`[Okolník 3D] terén: SERVER ${s.nazev} (DMR 5G, z≤${s.terenMaxZoom})`);
    }
    if (!KONFIG.vektorAtribuce
        && await existujePmtiles(s.vektor.replace('pmtiles://', ''))) {
      KONFIG.vektorUrl = s.vektor;
      KONFIG.vektorAtribuce = ATRIBUCE_OMT;
      console.log(`[Okolník 3D] vektor: SERVER ${s.nazev} (Planetiler ČR)`);
    }
  }
  if (!KONFIG.terenAtribuce || !KONFIG.vektorAtribuce) {
    console.log('[Okolník 3D] část zdrojů zůstává DEMO (servery nedostupné)');
  }
}

// Strop kvality terénu: ?teren=13 ručně, jinak slabší zařízení (<4 GB RAM)
// automaticky nečtou z14 — stejná data, jen se hlubší dlaždice nestahují.
function aplikujStropTerenu() {
  const param = parseInt(
    new URLSearchParams(location.search).get('teren'), 10);
  const pametGB = navigator.deviceMemory || 8;
  const strop = param || (pametGB < 4 ? 13 : 99);
  if (KONFIG.terenMaxZoom > strop) {
    KONFIG.terenMaxZoom = strop;
    console.log(`[Okolník 3D] strop kvality terénu: z≤${strop}`
      + (param ? ' (parametr)' : ` (paměť ${pametGB} GB)`));
  }
}

let mapa = null;
let STYLY = null;
let aktualniKod = 'zakladni';
let teren3d = true;
// ⭐ v1.382: RODIČOVSKÝ PŘEDVOJ (vlastní obdoba prefetchZoomDelta, který
// MapLibre — na rozdíl od Mapboxu — nemá v žádné verzi). Patch ve
// vendor/maplibre-gl-v6.mjs (_updateRetainedTiles): u čerstvě chybějící
// dlaždice se na spodku pásma (z−3) vyžádá a podrží hrubý rodič, takže
// posun do neznáma kreslí rozmazané → ostré místo šedé. Jen pro
// vector/raster zdroje a MIMO aktivní zoom (ochrana výkonu gesta).
// Tenhle příznak je vypínač patche — false = původní chování.
globalThis.__rodicPredvoj = true;

// ⭐⭐ NÁKLON SE NESMÍ POSLAT, DOKUD MÁ UŽIVATEL PRST NA MAPĚ (8. 8. 2026).
// `OkolnikMost.naklon()` končí `mapa.easeTo(…)`, a `easeTo` volá uvnitř
// `stop()` — tedy ZABIJE PRÁVĚ PROBÍHAJÍCÍ GESTO. Automatika náklonu ho
// přitom posílá v okamžiku, kdy přiblížení překročí práh 3D+ (z15,3), což
// je uprostřed uživatelova štípnutí. Kamera mu gesto sebere, překlopí se
// na 42° a s terénem se tím posune i to, co je vidět. Uživatel to popsal:
// *„přiblížil jsem se na nějakou velikost a najednou to samovolně skočilo
// cca 100 m od mé pozice na jiný zoom (76 %)."*
// Náklon se proto odloží a dožene se, až prst opustí displej A doběhne
// setrvačnost (`moveend`) — jinak by `easeTo` zabilo doběh švihu úplně
// stejně jako samotné gesto.
// ⚠️ Souvisí s poznámkou u `setPitch` (spojitý náklon je slepá ulička):
// gesto zabije KAŽDÁ změna kamery, `easeTo` i `jumpTo`/`setPitch`.
let prstuNaMape = 0;
let poslednDotykMs = 0;
let cekaNaklon = null;
let cekaNaklonHlidac = null;
let overNaklonCas = null;   // dotahovací pojistka letu náklonu (viz naklon)

/// Má uživatel PRÁVĚ TEĎ prst na mapě?
///
/// ⛔⛔ NEPTAT SE JEN POČÍTADLA (opraveno 8. 8. 2026 večer, druhé kolo).
/// `touchend` k plátnu NEMUSÍ DORAZIT — prst může skončit nad flutterovým
/// tlačítkem přes WebView nebo si gesto vezme platform view. Počítadlo pak
/// zůstane nenulové **navěky** a stane se tohle: příkaz z tlačítka se
/// odloží, chvíli si leží, a vystřelí až při nejbližším doteku mapy.
/// Uživatel to viděl jako *„po puštění displeje se obraz přiblížil na
/// 77 %"* — což je zoom 16,2, tedy hodnota tlačítka 3D+.
/// Proto se počítadlu věří jen 1,5 s od posledního dotyku. Samo se to
/// zhojí i bez jediné události, takže na to není potřeba `moveend`.
function prstNaMape() {
  return prstuNaMape > 0 && (performance.now() - poslednDotykMs) < 1500;
}

/// Dožene náklon odložený kvůli prstu na displeji.
/// ⚠️ Čeká i na doběh setrvačnosti (`isMoving`), ne jen na zvednutí prstu —
/// `easeTo` uprostřed švihu vypadá stejně jako skok uprostřed gesta.
function dokoncCekajiciNaklon() {
  if (!cekaNaklon || !mapa) return;
  // ⛔⛔ PŘI „JEŠTĚ NE" SE HLÍDAČ MUSÍ PŘEZBROJIT (11. 8. 2026 večer,
  // výtka „po rychlém přiblížení se hned nepřepne do 3D, je potřeba
  // ještě jeden odzoom"). Bývalo tu `return` s komentářem „dožene se na
  // moveend" — jenže ŽÁDNÝ moveend tuhle funkci nevolal. A protože
  // kompas mapou pohybuje skoro pořád (easeTo natočení každou ~1,2 s),
  // `isMoving()` bylo při hlídači skoro vždy true → odložený náklon se
  // TIŠE ZTRATIL. Stupeň v appce už říkal 3D+, pitch zůstal 30°, terén
  // nesměl (`smiTeren` chce ≥ 36°) — a spravilo to až DALŠÍ gesto,
  // protože jedině to vyrobí nové hlášení výřezu a dorovnání z Dartu.
  if (prstNaMape() || (mapa.isMoving && mapa.isMoving())) {
    clearTimeout(cekaNaklonHlidac);
    cekaNaklonHlidac = setTimeout(dokoncCekajiciNaklon, 400);
    return;
  }
  clearTimeout(cekaNaklonHlidac);
  cekaNaklonHlidac = null;
  const c = cekaNaklon;
  cekaNaklon = null;
  try { window.OkolnikMost.naklon(c.stupne, c.zoom); } catch (e) {
    console.warn('[naklon] odložený náklon selhal:', e);
  }
}

// ---------------------------------------------------------------------------
// Jen ČR: maska zahraničí (svět s dírou ve tvaru hranice) + zámek kamery.
// Herní styl masku nepotřebuje — cizinu kryje pergamen Kroniky.
// ---------------------------------------------------------------------------
const MASKA_BARVY = {
  zakladni: '#e9e5dc', letecka: '#101d16', turisticka: '#f2ecdc',
};
const CR_BOUNDS = [[11.9, 48.2], [19.1, 51.4]];   // malý přesah za hranice
let crObrys = null;

async function nactiHranici() {
  try {
    const data = await (await fetch('assets/cr_border.json')).json();
    crObrys = data.map(b => [b[1], b[0]]);   // [lat,lon] → [lng,lat]
    crObrys.push(crObrys[0]);
  } catch (e) {
    console.warn('[Okolník 3D] hranice ČR se nenačetla:', e);
  }
}

function pridejMaskuZahranici() {
  const barva = MASKA_BARVY[aktualniKod];
  if (!crObrys || !barva || mapa.getLayer('okolnik-zahranici')) return;
  if (!mapa.getSource('cr-maska')) {
    mapa.addSource('cr-maska', { type: 'geojson', data: {
      type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: [
        [[-30, 20], [45, 20], [45, 66], [-30, 66], [-30, 20]], crObrys] } } });
  }
  // ⛔ VLOŽIT POD SYMBOLY, NE NAKONEC (6. 8. 2026, hon na sekání).
  // Se zapnutým terénem se drapované vrstvy (background/fill/line/raster/
  // hillshade) kreslí do textury 1024² NA KAŽDOU terénní dlaždici. Vrstvy,
  // které se nedrapují (symboly, kolečka, budovy), ten blok ROZSEKNOU –
  // a maska vložená úplně nahoru tak vyrobila DRUHÝ „stack": další textura
  // 1024² na dlaždici a další kreslení terénu přes celou obrazovku.
  // Pod popisky patří i vizuálně (jméno města nemá maska přebít).
  const prvniSymbol = prvniSymbolovaVrstva();
  mapa.addLayer({ id: 'okolnik-zahranici', type: 'fill', source: 'cr-maska',
    paint: { 'fill-color': barva, 'fill-opacity': 1 } }, prvniSymbol);
}

async function start() {
  await Promise.all([zjistiVlastniZdroje(), nactiHranici()]);
  aplikujStropTerenu();

  // Vrstevnice: klientský výpočet z terénních dlaždic (maplibre-contour).
  // Strop z13 = čtvrtina požadavků na DEM, vizuálně beze změny (jemnost
  // vrstevnic řídí prahy, ne rozlišení zdroje).
  const demSource = new mlcontour.DemSource({
    url: KONFIG.terenUrl,
    encoding: 'terrarium',
    maxzoom: Math.min(KONFIG.terenMaxZoom, 13),
    worker: true,
    timeoutMs: 30000,   // serverové PMTiles přes proxy jsou línější
  });
  demSource.setupMaplibre(maplibregl);
  // ⭐ SDÍLENÁ KEŠ VÝŠKOPISU. Vrstevnice, stínování i 3D síť čtou tytéž
  // dlaždice; přes tenhle protokol projdou JEDNOU LRU keší místo tří
  // nezávislých stahování (podrobně u `zdrojTerenu` ve styles.js).
  // Tudy taky vede přednačítání – `predtahniTeren()` níž.
  try {
    KONFIG.terenSdilenaUrl = demSource.sharedDemProtocolUrl;
    KONFIG.terenSdilenyStrop = Math.min(KONFIG.terenMaxZoom, 13);
    window.__okolnikDem = demSource;   // pro přednačítání i ladění
  } catch (e) {
    console.warn('[teren] sdílená keš není k dispozici:', e);
  }

  const konturyUrl = demSource.contourProtocolUrl({
    multiplier: 1,
    // ⭐⭐ ŘIDŠÍ VRSTEVNICE = NEJVĚTŠÍ JEDNOTLIVÝ ZISK VÝKONU (6. 8. 2026).
    // Ablace vrstev herního stylu s terénem (z14, stejná trasa, nahřátá
    // keš) ukázala, že vrstevnice stojí VÍC než všechny ostatní vlastní
    // vrstvy dohromady:
    //   výchozí ................ 37 fps, 8,2 dlouhých snímků / 2 s
    //   BEZ VRSTEVNIC .......... 45 fps, 5,8   ← největší skok
    //   bez ilustrací .......... 42 fps, 6,0
    //   bez dekorací ........... 41 fps, 7,0
    //   bez mlhy / stínování ... 40 fps
    //   bez erbů ............... 38 fps
    //   bez všeho výše ......... 44 fps  (tedy ani ne tolik jako bez vrstevnic)
    // Není divu: vrstevnice se NEstahují, `maplibre-contour` je počítá
    // z výškových dlaždic přímo v telefonu, takže každý posun znamená
    // novou práci ve workeru A novou vektorovou dlaždici – a ta pak ještě
    // zahodí drapovací textury terénu.
    // ⛔ ZŘEDĚNÍ HUSTOTY NEPOMOHLO (změřeno: 37 → 35 fps, tedy v rozptylu),
    // protože cenu nedělá počet čar, ale samotné generování dlaždic.
    // Hustota je proto zpátky původní a řeší se to jinak – vrstevnice se
    // při zapnutém terénu VYPÍNAJÍ, viz `vrstevniceProTeren` níž.
    thresholds: {          // zoom: [vedlejší, hlavní] po metrech
      11: [200, 1000],
      12: [100, 500],
      13: [50, 250],
      14: [50, 250],
      15: [20, 100],
    },
    elevationKey: 'ele',
    levelKey: 'level',
    contourLayer: 'contours',
  });

  STYLY = vytvorStyly({ konturyUrl });

  // ⭐⭐⭐ START ROVNOU VE SPRÁVNÉM STYLU (12. 8. 2026, výtka „mapa se
  // načítá ~10 s"). Změřeno snímky studeného startu do hry: základní
  // styl stál už ve 3 s — jenže appka ho po náběhu přepnula na Kroniku,
  // `setStyle` zahodil všechny vrstvy a dalších ~7 s byl na obrazovce
  // prázdný pergamen (přeparsování dlaždic + pečení akvarelu + mlha).
  // Celý základní styl byla zbytečná oklika: appka ví, kam startuje,
  // a pošle to v `?styl=` — první postavený styl je rovnou ten pravý.
  // `aktualniKod` se musí nastavit PŘED konstrukcí mapy: čte ho
  // `aplikujDoplnky` v `load` (mlha!), maska hranic i konfigurace
  // terénu. Dartové `nastavStyl` po náběhu pak trefí guard
  // `kod === aktualniKod` v `prepniStyl` a nic se nepřepíná.
  {
    const chtenyStyl = new URLSearchParams(location.search).get('styl');
    if (chtenyStyl && STYLY[chtenyStyl]) aktualniKod = chtenyStyl;
    // ⭐ v1.394.1: držení terénu NAPEVNO už při startu — handler
    // style.load se registruje až po prvním načtení a boot mu utekl
    // (drzet zůstal false a automatika terén hned sundala)
    // ⭐⭐ v1.437: terén drží VŠECHNY styly („mapa má být vždy ve 3D,
    // nechci ŽÁDNÉ cuknutí") — setTerrain za běhu byl jediný zdroj
    // renormalizačních odskoků; výkonová pásma vznikla před
    // optimalizacemi v1.424+ (meze/BV/markery) a už neplatí
    drzetTeren = true;
  }

  // -------------------------------------------------------------------------
  // Mapa
  // -------------------------------------------------------------------------
  mapa = new maplibregl.Map({
    // ⭐ v1.421: větší keš dlaždic — „drhne především načítání“:
    // návraty při hraní (tam a zpět po vsi) už dlaždice neparsují
    // znovu; výchozí strop se počítá z viewportu a byl těsný.
    maxTileCacheSize: 320,
    container: 'mapa',
    style: STYLY[aktualniKod].podklad,
    center: [15.34, 49.82],   // střed ČR
    zoom: 6.6,
    pitch: 0,
    // ⛔⛔ `centerClampedToGround: false` TU BYLO A BYLO VRÁCENO
    // (11. 8. 2026 večer, po dni v provozu). Odskok při zapnutí terénu
    // sice zmenšilo (300 → ~90 m), ale ROZBILO SÉMANTIKU ZOOMU: zoom
    // přestal být vztažený k povrchu, gesto přiblížení se chovalo
    // zrychleně a obraz skákal „na 84 % zoomu" (výtka „přibližování
    // nějak zlobí, zoomuje hrozně moc rychle"). S vypnutým clampingem
    // navíc výšku středu bez animace nikdo nespravuje a každý easeTo
    // ji tiše přelaďoval — pocitově náhodné změny měřítka.
    // Odskok při zapnutí terénu zůstává NEVYŘEŠENÝ — tři architektury
    // opravy mapu zaklínily (podrobně u `nastavTeren`); další pokus
    // jedině v desktopovém demu s devtools.
    // 64°: nad ~65° se do záběru valí záplava dlaždic k horizontu a
    // snímky kolísají i na výkonném PC (změřeno 9. 8. na 4K plátně:
    // 70° = 62–78 fps se špičkami, 64° = stabilních 82–84 fps).
    // Návrh limitu přišel od uživatele („možná by pomohl limit
    // náklonu") a přesně sedí.
    // 6. 8. 2026 sníženo 64 → 52 (uživatel: „limit bych ještě snížil,
    // je to stále moc a pak už se to dost seká"). Nižší náklon = míň
    // dlaždic k obzoru i míň kolizí popisků nad terénem.
    maxPitch: 42,
    // Mobilní GPU nestíhá 3D terén na DPR 3 (Mali: 11–30 fps při gestu).
    // Strop 2 = 2,25× méně fill-rate, na 480dpi displeji nerozeznatelné.
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    // ⭐ LEVNÁ NASTAVENÍ PROTI SEKÁNÍ PŘI NÁKLONU (6. 8. 2026, doloženo
    // rešerší): kopie světa jsou pro ČR zbytečné, menší keš dlaždic drží
    // paměť WebView níž a `powerPreference` říká GPU, ať nešetří.
    renderWorldCopies: false,
    // ⭐ v1.386: snímky mapy pro sdílené karty (canvas.toDataURL).
    // Změřeno dřív A,B,A,B: bez měřitelné ceny (paměť
    // sarcher-preserve-drawing-buffer).
    // ⛔ v6: GL vlastnosti PATŘÍ do canvasContextAttributes — holé
    // `preserveDrawingBuffer` nahoře v6 tiše ignoruje (ověřeno: plátno
    // četlo černě, rozptyl 0). powerPreference nahoře v6 bere dál.
    canvasContextAttributes: { preserveDrawingBuffer: true },
    // 3 (výchozí MapLibre je 5): při 2 odtékaly PŘEDNAČTENÉ výškové
    // dlaždice dřív, než je terén stihl použít. Paměť hlídat na telefonu.
    maxTileCacheZoomLevels: 3,
    powerPreference: 'high-performance',
    hash: true,
    // ⭐⭐ NULA TU BYLA A STÁLA 19 FPS (přeměřeno 8. 8. 2026 večer).
    // `fadeDuration: 0` nutí MapLibre přepočítat rozmístění VŠECH symbolů
    // od nuly KAŽDÝ SNÍMEK (`_updatePlacement` dostane 0 →
    // `forceFullPlacement`, který navíc ruší i inkrementální rozpočet
    // 2 ms). Ráno jsem to změřil na z15,6, vyšlo 0,14–0,40 ms na snímek
    // a nechal jsem nulu. To byl SPRÁVNÝ ZÁVĚR ZA TEHDEJŠÍCH PODMÍNEK
    // a přestal platit, jakmile přibyly dekorace pod z14 — cena roste
    // s POČTEM SYMBOLŮ a těch je teď v obraze ~300 místo hrstky.
    // Přeměřeno na telefonu (z13,3, náklon, panování, A,B,B,A):
    //     fadeDuration 0 …… medián snímku 18,4 a 23,3 ms → 54 a 43 fps
    //     fadeDuration 300 … medián snímku 16,1 a 16,1 ms → 62 a 62 fps
    // 16,1 ms je přesně jeden snímek na 60 Hz, tedy strop displeje.
    // ⚠️ POUČENÍ: „změřeno = zanedbatelné" platí jen pro tu scénu, na
    // které se měřilo. Při každém zahuštění symbolů tohle přeměřit.
    fadeDuration: 300,  // symboly se rozmisťují inkrementálně (viz výš)
    attributionControl: { compact: true },
  });
  window.mapa = mapa;   // ladění
  zapniDynamickeRozliseni();
  // ⏱ RAZÍTKA STARTU (jen čísla, nic nekreslí) — bez nich se o pořadí
  // „styl → první snímek → mlha" jen hádá. Čte se přes CDP.
  window.__casy = window.__casy || {};
  window.__casy.mapa = Math.round(performance.now());
  mapa.once('style.load', () => {
    window.__casy.styl = Math.round(performance.now());
  });
  mapa.once('render', () => {
    window.__casy.prvniSnimek = Math.round(performance.now());
  });
  mapa.on('load', () => {
    if (!window.__casy.load) window.__casy.load = Math.round(performance.now());
  });
  mapa.setMaxBounds(CR_BOUNDS);   // kamera se drží u ČR

  // ⭐⭐⭐ POJISTKA OSIŘELÉHO SNÍMKU ANIMACE (11. 8. 2026 večer — jiskra
  // všech „šedých map" konečně chycená ZA RUKU, se zásobníkem):
  //
  //     Uncaught TypeError: this._onEaseFrame is not a function
  //         at Object._renderFrameCallback [as callback]
  //         at op.run  (TaskQueue.run — a fronta zůstane zamčená)
  //         at hp._render
  //
  // V bundlu 6.1.0 je `_renderFrameCallback` instanční arrow funkce
  // kamery a volá `this._onEaseFrame(...)` BEZ KONTROLY. Když `stop()`
  // ukončí animaci ve chvíli, kdy už její úkol leží v PRÁVĚ BĚŽÍCÍ
  // dávce fronty (run() si dávku zkopíroval, cancel na ni nedosáhne),
  // úkol se spustí osiřelý → TypeError UVNITŘ TaskQueue.run (nemá
  // finally) → `_currentlyRunning` zůstane true → každý další snímek
  // „Attempting to run(), but is already running" → mapa navěky šedá.
  // Potká se to jen se SKUTEČNÝMI gesty prstů + našimi věčnými easeTo
  // (kompas, přelet, náklon) — proto to adb testy nikdy nechytily.
  //
  // Obal na INSTANCI: osiřelý úkol se tiše přeskočí. Budoucí
  // sebe-plánování (`_requestRenderFrame(this._renderFrameCallback)`)
  // si už bere obalenou verzi. Druhou obrannou linií zůstává
  // `hlidejOtravenouFrontu` (odemkne frontu, kdyby proklouzlo něco
  // jiného). ⚠️ Interní API — po upgradu knihovny přeověřit.
  try {
    const kamera = mapa._camera;
    if (kamera && typeof kamera._renderFrameCallback === 'function') {
      const puvodniSnimek = kamera._renderFrameCallback;
      kamera._renderFrameCallback = () => {
        if (typeof kamera._onEaseFrame !== 'function') return;
        return puvodniSnimek();
      };
      console.log('[teren] pojistka osiřelého snímku nasazena');
    }
  } catch (e) { console.warn('[teren] pojistka snímku nešla nasadit:', e); }

  // ⭐⭐⭐ ŽÁDNÝ RAYCAST DO TERÉNU BĚHEM POHYBU (8. 8. 2026).
  //
  // Uživatel: *„dle mě se to seká prostě kvůli nějaké kravině."* Měl pravdu.
  // CPU profil při panování ve 3D+ ukázal 3,6 % v `readPixels`; zásobník
  // volání (scratchpad/kdovola2.mjs) vedl sem:
  //     readPixels ← pointCoordinate ← screenPointToMercatorCoordinate
  //                ← unproject ← new MapTouchEvent(…) ← touchstart/touchmove
  // MapLibre si při KAŽDÉ dotykové události dopředu spočítá `lngLats` všech
  // prstů přes `unproject`, a ten se zapnutým terénem střílí paprsek do GPU
  // a **synchronně čeká na `readPixels`**. Při tažení ty souřadnice nikdo
  // nečte — platí se za ně zbytečně.
  //
  // Změřeno A,B,B,A přímo na zařízení (pět posunů, z15,5, terén zapnutý):
  //     s raycastem … 49,5 a 49,9 fps · p99 83/67 ms · dlouhých snímků 36/68
  //                   readPixels 332× / 631 ms a 272× / 553 ms
  //     bez raycastu … 51,5 a 51,7 fps · p99 66,5 ms · dlouhých snímků 23/20
  //                   readPixels 60× / 135 ms a 90× / 159 ms
  // Tedy **čekání na GPU ze ~590 na ~150 ms a dlouhých snímků polovina.**
  //
  // ⚠️ PŘESNOST SE NEZTRÁCÍ TAM, KDE NA NÍ ZÁLEŽÍ: klik na místo i dlouhý
  // stisk se dějí na STOJÍCÍ mapě, a tam se pořád jede původní přesnou
  // cestou přes terén. Plochá projekce se použije jen po dobu `isMoving()`.
  (function bezRaycastuZaPohybu() {
    try {
      const t = mapa.painter && mapa.painter.transform;
      if (!t || typeof t.screenPointToLocation !== 'function') return;
      const puvodni = mapa.unproject.bind(mapa);
      mapa.unproject = function (bod) {
        if (mapa.isMoving && mapa.isMoving()) {
          try { return t.screenPointToLocation(maplibregl.Point.convert(bod)); }
          catch (e) { /* jiná verze knihovny → původní cesta */ }
        }
        return puvodni(bod);
      };
    } catch (e) {
      console.warn('[mapa] obejití raycastu se nepovedlo:', e);
    }
  })();

  // ⛔⛔ V REŽIMU APLIKACE ŽÁDNÉ OVLÁDACÍ PRVKY MAPLIBRE (7. 8. 2026, hon
  // na sekání). Appka je dosud jen SCHOVÁVALA přes CSS (`zapniAppRezim`),
  // jenže schované měřítko dál pracuje: `ScaleControl` si na KAŽDOU
  // událost `move` volá dvakrát `unproject`, a to se zapnutým terénem
  // znamená vykreslit terén do dvou pomocných framebufferů
  // (`maybeDrawDepth` + `maybeDrawCoords`) a synchronně přečíst pixel
  // z GPU (`gl.readPixels`) — čekání ~3,3 ms uprostřed snímku.
  // Změřeno na zařízení: 169 takových dotazů na tři posunutí prstem,
  // v profilu souvislého panování 31 % veškerého času (a dalších 14 %
  // příprava té textury). Prvek, který uživatel nikdy neuvidí.
  if (!APP_REZIM) {
    mapa.addControl(new maplibregl.NavigationControl({ visualizePitch: true }),
                    'top-right');
    mapa.addControl(new maplibregl.ScaleControl({ unit: 'metric' }),
                    'bottom-right');
  }

    // ⭐ v1.507: VZORY NA POŽÁDÁNÍ — konec „nejdřív světlá, pak herní".
  //
  // ZMĚŘENO: herní styl si žádá výplně `vzor-les/pole/louka/mesta/voda`
  // hned při prvním vykreslení (log: `Image "vzor-pole" could not be
  // loaded`), jenže ty se pekly až v `aplikujDoplnky`. Do té doby
  // MapLibre kreslil plochy PRÁZDNÉ, takže mapa naskočila světlá a
  // zezelenala teprve o vteřinu později. Uživatel to hlásil jako
  // „nejdřív se vykreslí světlá mapa a pak herní".
  //
  // `styleimagemissing` je přesně ten háček, na který MapLibre v té
  // hlášce odkazuje: obrázek se dodá v okamžiku, kdy si o něj styl
  // řekne — tedy PŘED vykreslením ploch.
  mapa.on('styleimagemissing', (e) => {
    try {
      if (!e || !e.id || e.id.indexOf('vzor-') !== 0) return;
      pridejAkvarelVzory();
    } catch (err) { /* bez vzorů se kreslí plochou barvou */ }
  });

mapa.on('error', (e) => {
    const zprava = (e && e.error && e.error.message) || e;
    // ⚠️ v1.397.1: chybějící DEM dlaždice NENÍ chyba — archiv kryje
    // jen ČR, okrajové dlaždice za hranicemi neexistují a výška je
    // prostě 0. Warn dělal šum v noční hlídce; stačí obranuřý log.
    if (typeof zprava === 'string' && zprava.includes('DEM tile')
        && zprava.includes('not found')) {
      console.log('[Okolník 3D] DEM mimo pokrytí (výška 0):', zprava);
      return;
    }
    console.warn('[Okolník 3D] chyba mapy:', zprava);
  });

  mapa.on('load', () => {
    // ⭐ MÉNĚ DLAŽDIC PŘI NÁKLONU (6. 8. 2026). Veřejné API MapLibre proti
    // přesně tomu, na co si uživatel stěžuje: při vysokém pitchi se do
    // záběru valí dlaždice až k obzoru. Výchozí (9, 3) je štědré; nižší
    // hodnoty = měkčí horizont, ale výrazně méně práce.
    // ⭐ 6. 8. 2026: třetí (nepovinný) parametr je `sourceId`. Bez něj se
    // nastavení propsalo do VŠECH zdrojů včetně vektorů. Výškopisu smí být
    // u obzoru hrubší (stejně ho zakrývá mlha a obloha) – tím se zkrátí
    // přechod do 3D+, protože ta práce prostě nevznikne.
    try {
      if (mapa.setSourceTileLodParams) {
        mapa.setSourceTileLodParams(5, 1.8);
        mapa.setSourceTileLodParams(3, 1.4, 'teren');
        mapa.setSourceTileLodParams(3, 1.4, 'stinovani');
      }
    } catch (e) { /* starší MapLibre tuhle metodu nemá */ }
    // ⛔⛔ IKONU ODZNAKU DO ATLASU JEŠTĚ PŘED VRSTVAMI. Obrázek přidaný
    // až potom se do UŽ ROZPARSOVANÝCH symbolů nepromítne — vrstva má
    // správný filtr, obrázek je v atlasu a `queryRenderedFeatures`
    // přesto vrací nulu (změřeno u kreseb Kroniky, `ilus-obrazky`).
    // U `okolnik-mista` se to dá zachránit přeparsováním, u ilustrací
    // ne: jejich data drží `ilustrace.js` a zvenčí se k nim nedostaneme.
    try { zajistiIkonu(IKONA_ODZNAKU); } catch (e) { /* nevadí */ }
    aplikujDoplnky();
    // 3D modely míst (splaty) — usazení hlídá idle přeměření výšky
    try { nasadModely3d(); nasadModely3dIdle(); } catch (e) { }
    try { nasadPlanTrasu(); } catch (e) { }
    try { nasadPlanStopu(); } catch (e) { }
      try { nasadCyklo(); } catch (e) { }   // v1.601 cyklotrasy
      // v1.607: nový styl smaže vrstvy třpytu, šrafy i světlo
      try { if (aktualniKod === 'herni') Trpyt.nasad(); } catch (e) { }
      try { nasadDomalovani(); } catch (e) { }
      try { Svetlo.pripoj(mapa); } catch (e) { }
    // ⭐ v1.521: odznaky návštěvy patří ke každému novému stylu
    try { nasadOdznakNavstevy(); } catch (e) { /* zkusí to časovač */ }
    nasadLovce();   // zapečený záznamník skoků (v1.392) — od 1. snímku
    nasadSipkuKUzivateli();   // šipka bez mostu, každý snímek (v1.417)
    nasadPametSnimku();   // BV/RI keš nepotřebuje terén — i pro neherní styly
    nasadSkrticPrijmu();  // příjem dlaždic ≤1/snímek (v1.422)
    // ⭐ v1.380: doplňky TRVALE na každý style.load. `once('style.load')`
    // z prepniStyl se při rychlém přepínání stylů navzájem sežraly (dvě
    // registrace vystřelí na prvním loadu, druhý styl zůstane bez
    // obsluhy) — a stylu pak CHYBĚLO stínování, terénní zdroje i značky
    // (výtka „stínování na mapě není, jak by mělo být"). aplikujDoplnky
    // je idempotentní (guardy !getSource/!getLayer), dvojí běh nevadí.
    mapa.on('style.load', () => {
      // v1.437: terén drží KAŽDÝ styl (konec odskoků z setTerrain)
      drzetTeren = true;
      aplikujDoplnky();
      try { nasadModely3d(); } catch (e) { }   // custom vrstvy styl maže
      try { nasadPlanTrasu(); } catch (e) { }
    try { nasadPlanStopu(); } catch (e) { }
      try { nasadCyklo(); } catch (e) { }   // v1.601 cyklotrasy
      // v1.607: nový styl smaže vrstvy třpytu, šrafy i světlo
      try { if (aktualniKod === 'herni') Trpyt.nasad(); } catch (e) { }
      try { nasadDomalovani(); } catch (e) { }
      try { Svetlo.pripoj(mapa); } catch (e) { }
      // v1.439: skrýt cizí POI dřív, než se poprvé vykreslí
      try { potlacDuplicity(); } catch (e) { /* doběhne z vykresliMista */ }
      // po usazení ještě překopnout terén (viz v1.378 idle-kick)
      mapa.once('idle', () => { try { nastavTeren(); } catch (e) {} });
      // ⭐ v1.393: terén zapnout HNED, jak je DEM zdroj k dispozici —
      // přepnutí projekce terénu posune obraz (~284 px, chyceno lovcem
      // při startu i po návratu z pozadí) a MUSÍ proběhnout POD TUŠÍ,
      // ne až po odkrytí mapy. Událost, žádný časovač.
      const zapniPodTusi = (e) => {
        try {
          if (!e || e.sourceId !== 'teren' || !e.isSourceLoaded) return;
          mapa.off('sourcedata', zapniPodTusi);
          if (!mapa.getTerrain()) nastavTeren();
        } catch (err) { /* zkusí to idle-kick */ }
      };
      mapa.on('sourcedata', zapniPodTusi);
      // hrubý předvoj vektoru — až tu bude styl se zdrojem `omt`
      // (pojistka uvnitř; start nikdy nezdrží — idle + zpoždění)
      setTimeout(predtahniVektor, 9000);
      // ⭐ v1.514: NOC HNED, NE ČASOVAČEM. `setTimeout` čeká na volné
      // hlavní vlákno, a to je při startu poslední, co je k mání —
      // změřeno, že se noční patro nanášelo až 6,4 s po dokreslení
      // mlhy a mapa do té doby svítila denními barvami. Přímé volání
      // proběhne ještě před prvním snímkem herního stylu.
      try { aplikujNoc(); } catch (e) { /* pojistka níž to dožene */ }
      // pojistka pro případ, že se v tu chvíli styl teprve skládal
      setTimeout(aplikujNoc, 400);
    });
    predtahniTeren();
    setTimeout(predtahniVektor, 9000);
    if (!APP_REZIM) {
      // Demo: rytířka u Rtyně, ať je figurka hned k vidění a jde ji
      // rozchodit z konzole (OkolnikMost.poloha s rychlostí)
      try {
        Postavicka.pripoj(mapa);
        Postavicka.nastav('assets/postavicka.webp',
            { sloupce: 8, faze: 4, obraceny: true });
        Postavicka.poloha(16.0725, 50.5050, 180, 0);
      } catch (e) { console.warn('[demo] postavicka', e); }
      // Demo erbů: tři obce výchozí odkryté krajiny (v aplikaci je posílá
      // Okolník přes OkolnikMost.erby; tady kopie erbů ze Sarcheru)
      try {
        Erby.nastav([
          { lng: 16.07196, lat: 50.50527,
            url: 'assets/erby/50509_16081.webp' },   // Rtyně v Podkrkonoší
          { lng: 15.91280, lat: 50.56105,
            url: 'assets/erby/50571_15931.webp' },   // Trutnov
          { lng: 16.10866, lat: 50.61869,
            url: 'assets/erby/50620_16103.webp' },   // Adršpach
        ]);
      } catch (e) { console.warn('[demo] erby', e); }
    }
    if (APP_REZIM) {
      // V aplikaci se nikam neletí – kameru řídí Okolník (skočí na polohu
      // uživatele). Uvítací přelet by mu ji hned přebil.
      mostHlas('onPripraveno', {});
      return;
    }
    // Uvítací nájezd na ČR s náklonem
    mapa.flyTo({ center: [15.34, 49.82], zoom: 7.05, pitch: 35, bearing: 0,
                 duration: 2800, essential: true });
  });

  mapa.on('click', zmerVysku);
  Navigace.init(mapa);

  // ---------------------------------------------------------------------
  // HLÁŠENÍ KAMERY DO APLIKACE (6. 8. 2026) — bez něj appka o výřezu
  // enginu nic neví, a tak jí ve 3D chyběla MODRÁ ŠIPKA k uživateli
  // (v 2D ji počítala z `_map.camera`). Projekci dělá engine, protože
  // jen on zná náklon i natočení; appka dostane hotové „vidíš se /
  // nevidíš, úhel na obrazovce, vzdálenost".
  // ---------------------------------------------------------------------
  // `zaBehu` = hlášení uprostřed pohybu: nese JEN lehká data pro modrou
  // šipku. ⚠️ VÝŘEZ SE ZA BĚHU NEPOSÍLÁ (6. 8. 2026, měření): appka na něj
  // reaguje výběrem turistických značek z 423 tisíc bodů a stavbou dlouhého
  // řetězce pro most – při panování to běželo 8× za vteřinu a mapa padala
  // na 17 fps (hůř než s terénem!). Výřez proto chodí až po zastavení.
  function hlasKameru(zaBehu) {
    if (!APP_REZIM || !mapa) return;
    try {
      const stred = mapa.getCenter();
      // ⭐ v1.388: PŘEVZETÍ VÝŠKY (skok elevation v jednom snímku) hne
      // středem i promítnutím značky uživatele, ačkoli OBRAZ stojí —
      // šipka pak „vyskočí na 180 m" a čísla poskočí (chyceno lovcem).
      // Po skoku výšky se hlášení na 1,5 s odmlčí; appka si nechá
      // poslední stav a další hlášení už popisuje usazenou skutečnost.
      const elTed = (mapa._camera && mapa._camera.transform
          && mapa._camera.transform.elevation) || 0;
      if (Math.abs(elTed - hlasMinulaEl) > 25) {
        hlasMlcDo = Date.now() + 1500;
      }
      hlasMinulaEl = elTed;
      if (Date.now() < hlasMlcDo) return;
      const b = zaBehu ? null : mapa.getBounds();
      const data = {
        lat: stred.lat, lon: stred.lng,
        zoom: mapa.getZoom(), bearing: mapa.getBearing(),
        pitch: mapa.getPitch(), vidim: true, uhel: 0, metry: 0,
      };
      if (b) {
        // výřez pro appku (turistické značky si vybírá podle něj stejně
        // jako 2D `TrailsData.inBounds`) – jen v klidu, viz komentář výš
        data.jih = b.getSouth();
        data.sever = b.getNorth();
        data.zapad = b.getWest();
        data.vychod = b.getEast();
      }
      const u = poslednPolohaUziv;
      if (u) {
        // ⛔⛔ v1.398: ŽÁDNÝ project()! S trvalým terénem promítá na
        // povrch kopců a pro body MIMO obrazovku (přesně tam šipka žije)
        // vrací nesmysly — uživatel 13. 8.: „šipka ukazovala úplně jiným
        // směrem, než byl hráč“. Úhel čistě zeměpisně: azimut
        // střed→uživatel minus natočení mapy = směr na obrazovce
        // (0 = vzhůru). Náklon okrajovou šipku nezajímá.
        const f1s = stred.lat * Math.PI / 180;
        const f2s = u.lat * Math.PI / 180;
        const dls = (u.lng - stred.lng) * Math.PI / 180;
        const azim = Math.atan2(Math.sin(dls) * Math.cos(f2s),
            Math.cos(f1s) * Math.sin(f2s)
            - Math.sin(f1s) * Math.cos(f2s) * Math.cos(dls)) * 180 / Math.PI;
        data.uhel = ((azim - mapa.getBearing()) % 360 + 360) % 360;
        // viditelnost přes hranice výřezu (bez GPU; u náklonu je obdélník
        // širší než obraz — šipka naskočí o chlup později, to nevadí)
        const hr = b || mapa.getBounds();
        data.vidim = !!(hr && hr.contains && hr.contains([u.lng, u.lat]));
        const R = 6371000;
        const f1 = stred.lat * Math.PI / 180;
        const f2 = u.lat * Math.PI / 180;
        const df = f2 - f1;
        const dl = (u.lng - stred.lng) * Math.PI / 180;
        const a = Math.sin(df / 2) ** 2
            + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
        data.metry = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
      }
      // ⭐ NEHLÁSIT, KDYŽ NENÍ CO KRESLIT (6. 8. 2026, změřeno). Tohle
      // hlášení slouží JEN modré šipce k uživateli po okraji obrazovky.
      // Když je uživatel na obrazovce vidět (`vidim`), appka žádnou šipku
      // nekreslí – volání přes most je tedy úplně zbytečné, a přitom
      // NENÍ zadarmo: každé znamená serializaci a skok přes platform
      // channel. Za běhu gesta se tak přeskočí drtivá většina hlášení
      // (mapa uživatele obvykle ukazuje).
      if (zaBehu && data.vidim && posledniVidim) return;
      posledniVidim = data.vidim;
      mostHlas('onKamera', data);
    } catch (e) { /* mapa se zrovna přestavuje */ }
  }
  let posledniVidim = false;
  let hlasMinulaEl = 0;
  let hlasMlcDo = 0;
  mapa.on('moveend', () => hlasKameru(false));
  mapa.on('zoomend', () => hlasKameru(false));
  // ⚠️ HLÁSIT I BĚHEM POHYBU („šipka nemění vzdálenost dynamicky").
  //
  // ⛔ 120 ms (8×/s) BYLO PŘÍLIŠ ČASTO. Komentář tu dřív tvrdil, že se to
  // „na výkon neprojeví, je to pár čísel" – ZMĚŘENO 6. 8. 2026 na zařízení
  // (stejná trasa, nahřátá keš, náklon 42° s terénem):
  //     s hlášením 8×/s ....... 33,6 fps, 7,8 dlouhých snímků / 2 s
  //     hlášení 2,5×/s ........ 42,9 fps, 6,2
  //     bez hlášení ........... 47,9 fps, 3,8
  // Není to tedy „pár čísel": každé volání je serializace + skok přes
  // platform channel do Dartu. Vypnutí OSTATNÍCH vrstev (stínování,
  // dekorace, ilustrace, mlha) přitom dohromady vyneslo jen ~7 fps –
  // tohle je největší jednotlivá položka.
  // 400 ms je pro plynulé číslo vzdálenosti pořád dost (šipka se navíc
  // hlásí okamžitě po `moveend`).
  let hlasMs = 0;
  mapa.on('move', () => {
    const t = Date.now();
    if (t - hlasMs < 400) return;
    hlasMs = t;
    hlasKameru(true);
  });
  // ⚠️ VÝŘEZ PO STARTU SE MUSÍ POSLAT VÍCKRÁT. Chodí jinak jen z `moveend`
  // — a po startu ŽÁDNÝ `moveend` nepřijde: počáteční kamera jde přes URL
  // hash, tedy bez pohybu. Zbýval jeden jediný výstřel po 1200 ms, a když
  // se trefil do chvíle, kdy se zrovna vyměňoval styl nebo dotékaly první
  // dlaždice, appka o výřezu nevěděla až do prvního doteku prstem. Přesně
  // stížnost uživatele: „mám pocit, že čeká, až pohnu obrazem, aby načetla
  // aktuální mapu pod uživatelem."
  for (const ms of [1200, 3000, 6000]) setTimeout(() => hlasKameru(false), ms);
  // …a hlavně si o něj umí appka říct sama, viz `OkolnikMost.hlasVyrez`.
  vynutHlaseniVyrezu = () => hlasKameru(false);

  // PODRŽENÍ PRSTU = návrh nového místa (6. 8. 2026, „podržení prstu nic
  // nedělá"). ⚠️ `contextmenu` NESTAČÍ – v Android WebView se nad plátnem
  // mapy nespustí (ověřeno na zařízení), takže se dlouhý dotyk hlídá sám:
  // 600 ms bez posunu přes 12 px. Dvouprstá gesta se ignorují.
  mapa.on('contextmenu', (e) => {          // desktop / pravé tlačítko
    if (!APP_REZIM || !e || !e.lngLat) return;
    mostHlas('onDlouhyStisk', { lat: e.lngLat.lat, lon: e.lngLat.lng });
  });
  (function dlouhyDotyk() {
    const platno = mapa.getCanvasContainer();
    let cas = null;
    let x0 = 0;
    let y0 = 0;
    const zrus = () => { clearTimeout(cas); cas = null; };
    platno.addEventListener('touchstart', (e) => {
      if (!APP_REZIM || e.touches.length !== 1) { zrus(); return; }
      const t = e.touches[0];
      x0 = t.clientX;
      y0 = t.clientY;
      zrus();
      cas = setTimeout(() => {
        cas = null;
        try {
          const r = platno.getBoundingClientRect();
          // přesně (s terénem) – během gesta je map.unproject rovinný
          const b = (window.unprojectPresne || mapa.unproject.bind(mapa))(
              [x0 - r.left, y0 - r.top]);
          mostHlas('onDlouhyStisk', { lat: b.lat, lon: b.lng });
        } catch (err) { /* mapa se zrovna přestavuje */ }
      }, 600);
    }, { passive: true });
    platno.addEventListener('touchmove', (e) => {
      if (!cas) return;
      const t = e.touches[0];
      if (!t) { zrus(); return; }
      if (Math.hypot(t.clientX - x0, t.clientY - y0) > 12) zrus();
    }, { passive: true });
    platno.addEventListener('touchend', zrus, { passive: true });
    platno.addEventListener('touchcancel', zrus, { passive: true });
  })();

  // ⭐ v1.605.2: PRSTY BEZ RAYCASTU (profil 4. 9. 2026). MapLibre při
  // KAŽDÉM touchstart/touchmove/touchend staví MapTouchEvent a v něm volá
  // map.unproject() pro každý prst (lngLat i lngLats = 2× na událost);
  // s terénem to znamená terrain.pointCoordinate → readPixels z GPU
  // (2 ms + zastavení fronty GPU) ~30× za jeden tah. Nikdo to při gestu
  // nepotřebuje přesně: během gesta se promítá rovinně (0,004 ms,
  // ověřeno ±4 m proti terénu). Přesnou polohu (dlouhý stisk, klik mimo
  // gesto) dává `unprojectPresne`.
  (function prstyBezRaycastu() {
    try {
      const presne = mapa.unproject.bind(mapa);
      window.unprojectPresne = presne;
      mapa.unproject = function (p) {
        if (prstuNaMape > 0 && mapa.terrain && mapa.painter
            && mapa.painter.transform) {
          try {
            return mapa.painter.transform.screenPointToLocation(
                maplibregl.Point.convert(p));
          } catch (e) { /* spadne na přesné */ }
        }
        return presne(p);
      };
    } catch (e) { console.warn('[výkon] prsty bez raycastu', e); }
  })();

  // Počítadlo prstů + dohnání odloženého náklonu (viz `cekaNaklon` nahoře).
  (function hlidacPrstu() {
    const platno = mapa.getCanvasContainer();
    const spocitej = (e) => {
      prstuNaMape = e.touches ? e.touches.length : 0;
      poslednDotykMs = performance.now();
      // ⭐ v1.509: uživatel si bere mapu do ruky → konec kotvy startu
      if (prstuNaMape) zrusKotvu('dotek');
    };
    platno.addEventListener('touchstart', spocitej, { passive: true });
    platno.addEventListener('touchmove', spocitej, { passive: true });
    for (const ev of ['touchend', 'touchcancel']) {
      platno.addEventListener(ev, (e) => {
        spocitej(e);
        if (!prstuNaMape) {
          dokoncCekajiciNaklon();
          spustCekajiciZapisy();   // prst pryč a mapa stojí → dopsat data
        }
      }, { passive: true });
    }
    // doběh setrvačnosti po švihu — odložený náklon smí až za ním
    mapa.on('moveend', dokoncCekajiciNaklon);
  })();

  // Přepínání terénu podle náklonu (viz nastavTeren): OBOJÍ jen v klidu
  // (pitchend) — přepnutí uprostřed gesta/animace probleskne všemi
  // popisky (MapLibre přepočítá rozmístění), proto nikdy mid-let.
  // ZAPNOUT až při náklonu ≥ PRAH_TEREN: dřívější „hned od 1°" znamenalo
  // DEM průchod (~30 ms/snímek bez ohledu na výkon) při KAŽDÉM náklonu
  // včetně středních 45° — „náklon stále generuje velké sekání" (8. 8.).
  // Střední náklon = perspektiva BEZ terénu (jako zásada naklon() v app
  // mostu); hory se zvednou po puštění gesta na plném náklonu.
  // ⛔⛔ TRY/CATCH JE TU POVINNÝ, NE KOSMETIKA. `Evented.fire` v MapLibre
  // volá posluchače v prostém cyklu bez ochrany a `Camera._afterEase`
  // střílí `…fire(pitchend), fire(moveend)` v jednom výrazu – výjimka
  // odsud tedy SPOLKNE `moveend` a appka do dalšího pohybu nedostane
  // výřez („mapa čeká, až s ní pohnu"). Dohledáno 7. 8. 2026 přímo
  // v `vendor/maplibre-gl-shared.mjs`.
  mapa.on('pitchend', () => {
    try {
      const p = mapa.getPitch();
      if (teren3d && p >= PRAH_TEREN && !mapa.getTerrain()) {
        // ⚠️ ZAPNOUT HNED, NEODKLÁDAT. Tohle je hlavní (a po startu jediná)
        // cesta, kterou se hory zvednou — ve v1.289 takhle prokazatelně
        // fungovala. Ve v1.290 jsem to poslal přes odloženou `naplanujTeren`
        // a spolu s podmínkou na načtené dlaždice terén přestal naskakovat.
        nastavTeren();
      } else if ((!teren3d || p < 1) && mapa.getTerrain()) {
        nastavTeren();          // sundání je levné a chceme ho hned
      }
    } catch (e) { console.warn('[teren] pitchend', e); }
  });

  // ⛔ ZKOUŠENO A ZAMÍTNUTO UŽIVATELEM (7. 8. 2026): „terén jen v klidu"
  // — na `movestart` sundat terén, po 400 ms klidu vrátit. ČÍSLA BYLA
  // DOBRÁ (z14,6: p90 150–238 → 23–33 ms; z12: 14–19 → 41–43 fps), ale
  // OKEM to bylo nepoužitelné: „moc to nefunguje (nejde se posouvat)
  // a vypadá to hrozně, jak to stále poskakuje, jen co se dotknu mapy."
  // Přepnutí terénu totiž srovnává střed kamery, což se pere s právě
  // probíhajícím gestem.
  //
  // ⭐⭐ CO JE MÍSTO TOHO (7. 8. 2026, druhý pokus – a ten sedí):
  // terén se sundává JEN PŘI ODDALOVÁNÍ, ne při každém doteku, a hlavně
  // BEZ SROVNÁVÁNÍ POHLEDU (viz `sundejTeren`), takže nic neposkakuje.
  // Panování se terénu nedotkne vůbec.
  //
  // PROČ PRÁVĚ ODDALOVÁNÍ. Uživatel: „při přiblížení je vše krásně
  // plynulé, pak začnu oddalovat a začne se to hrozně sekat." Změřeno
  // (scratchpad/ab-zoomout.mjs, gesto z15,5 → z10, A,B,B,A):
  //     s terénem …… 9,9 a 12,3 fps, medián snímku 56–66 ms, p90 183–216 ms
  //     bez terénu … 50,0 a 50,6 fps, medián 16,6 ms, p90 33 ms
  // Příčina není počet terénních dlaždic (drží se na 2–5 i při oddálení)
  // ani velikost drapovací textury (1024 vs 256 = 8,9 vs 9,5 fps, šum).
  // Je to DRAPOVACÍ KEŠ: při panování jde do textury 1,7–3,6 kresby vrstev
  // na snímek, protože se textury dlaždic recyklují — ale ZOOM mění celou
  // sadu dlaždic, takže keš netrefí a maluje se **45–59 kreseb na snímek**.
  // (Pozn.: tím padá i platnost staršího závěru „slučování vrstev nepomůže";
  // ten platí pro panování, pro zoom ne. Se sundaným terénem je ale celá
  // otázka bezpředmětná.)
  // ⚠️⚠️ OBĚMA SMĚRY, NEJEN PŘI ODDALOVÁNÍ (7. 8. 2026, druhá oprava).
  // První verze sundávala terén jen při oddalování — jenže drapovací keš
  // rozbíjí zoom STEJNĚ v obou směrech. Uživatel to popsal přesně:
  // „když se oddálím úplně daleko aby přešlo do 2D a znovu se přiblížím,
  // aby to přešlo do 3D, tak se všechno seká jako dřív."
  // Změřeno (scratchpad/cyklus2.mjs, štípání posílané přes CDP):
  //   panování ve 3D+ poprvé …… 51,8 fps, 2,7 kresby do textury na snímek
  //   panování po cyklu ……… 21,5 a 11,8 fps, 16,1 a 15,2 kresby
  // a přibližování s terénem mělo záškuby 316 a 333 ms.
  //
  // ⚠️ MĚŘÍ SE OD ZOOMU, PŘI KTERÉM TERÉN NASKOČIL, ne od začátku gesta.
  // Verze před tím si pamatovala zoom na `zoomstart` a zapomínala ho na
  // `zoomend` — jenže lidé oddalují OPAKOVANÝMI MALÝMI ŠTÍPNUTÍMI po
  // 0,2–0,3 zoomu, takže se práh 0,35 nikdy nepřekročil a terén jel celou
  // dobu (změřeno: 213 z 213 snímků). Referenční zoom drží přes gesta,
  // takže se malé kroky sečtou.
  // ⭐⭐ RUČNÍ POSUN MUSÍ VYPNOUT SLEDOVÁNÍ POLOHY (8. 8. 2026).
  // Uživatel: *„koukám někam a najednou pohled poskočí třeba o kilometr
  // jinam, je to náhodné."* Příčina: `_follow` se v appce vypíná jen při
  // gestu na 2D mapě (`onPositionChanged(hasGesture)`), jenže 3D vrstvu
  // kreslí engine — appka se o ručním posunu nedozvěděla, sledování
  // zůstalo zapnuté a **každé 4 s tě přeletělo zpátky na tvou pozici**
  // (home_screen.dart, `_follow && uleteno >= 12`).
  // ⚠️ `originalEvent` mají JEN uživatelská gesta; programové `easeTo`
  // a `flyTo` ho nemají, takže si vlastní přelety nevypneme samy.
  mapa.on('movestart', (e) => {
    try {
      if (e && e.originalEvent) mostHlas('onRucniPosun', {});
    } catch (err) { /* most ještě nestojí */ }
  });

  // ⭐⭐ TOHLE JE TA OPRAVA BLIKÁNÍ (8. 8. 2026, druhé kolo).
  // `naplanujTeren` schválně NEPŘENASTAVUJE běžící časovač (jinak ho
  // vyhladoví pohyby kamery od GPS, viz tam). Jenže tím časovač nasazený
  // po PRVNÍM štípnutí doběhl UPROSTŘED DRUHÉHO: hory se vrátily rovnou do
  // gesta a práh je hned zase sundal. Uživatel to viděl jako
  // *„pořád ten 3D+ efekt poskakuje"* — 8 bliknutí na čtyři štípnutí.
  // `zoomstart` je narozdíl od `moveend` DISKRÉTNÍ akce uživatele (a GPS
  // zoomem nehýbe), takže se čekající návrat smí bez obav zrušit. Hory se
  // pak vrátí JEDNOU, až se zoomem opravdu skončíš.
  mapa.on('zoomstart', () => {
    clearTimeout(vratTerenCas);
    vratTerenCas = null;
  });

  mapa.on('zoom', () => {
    // ⭐⭐ JEDNOU ZVEDNUTÉ KOPCE SE DRŽÍ AŽ K HRANICI PÁSMA (8. 8. 2026).
    // Zadání uživatele: *„ať načtené 3D+ během přibližování nebo oddalování
    // do své hraniční hodnoty nemizí. To dělá ty skoky také, že během
    // přesunu se přepíná mapa do 3D. Má držet případně načtené 3D+ a ne ho
    // hned pouštět."*
    //
    // ⛔ Předchozí pravidlo („sundej při změně zoomu o X") bylo ZDROJEM těch
    // skoků a stálo tři kola ladění: s X = 0,35 hory blikaly při každém
    // doťuknutí, s X = 1,5 zase prvních 1,5 stupně oddalování běželo
    // s terénem na ~16 fps. Žádná hodnota X nebyla dobrá, protože se ptala
    // na špatnou věc — nezajímá nás, O KOLIK se zoom změnil, ale jestli
    // uživatel VYJEL Z PÁSMA 3D+.
    //
    // Terén se proto sundá v jediném okamžiku: když zoom klesne pod
    // `prahZoomTerenu` (dolní hranice pásma 3D+, posílá ji appka). Zbytek
    // oddalování pak běží bez terénu, tedy plynule — to byl původní zisk
    // 16 → 45 fps a ten zůstává. Přibližování hory nikdy neshodí.
    if (drzetTeren) return;      // ruční volba uživatele – hory zůstávají
    if (!mapa.getTerrain || !mapa.getTerrain()) return;
    if (mapa.getZoom() >= prahZoomTerenu) return;
    // ⚠️ NULOVAT, NEJEN `clearTimeout`. `naplanujTeren` se podle téhle
    // proměnné rozhoduje, jestli už časovač běží – kdyby tu zůstalo staré
    // id, hory by se od té chvíle nezvedly nikdy.
    clearTimeout(vratTerenCas);
    vratTerenCas = null;
    sundejTeren();
  });

  // ⚠️ VRÁTIT TERÉN MUSÍ ENGINE SÁM. Automatika náklonu v appce posílá
  // `naklon()` jen když se ZMĚNÍ STUPEŇ (2D/3D/3D+); když uživatel jen
  // popojede zoomem uvnitř 3D+, nepřijde nic — a hory by se po prvním
  // oddálení už nikdy nezvedly.
  // Popisky se smějí vracet JEN NA STOJÍCÍ MAPĚ – viz `naplanujPopisky`.
  mapa.on('movestart', () => { clearTimeout(vratPopiskyCas); });

  mapa.on('moveend', () => {
    naplanujPopisky();
    naplanujTeren();
    prevezmiVyskuBezPohybu();
    dokoncCekajiciNaklon();   // odložený náklon — slib „na moveend" splněn
    spustCekajiciZapisy();    // odložené zápisy dat (viz zapisAzVKlidu)
  });

  /// Zvednout hory, ale až se mapa usadí. Jediná cesta k zapnutí terénu —
  /// `pitchend` i `moveend` jdou přes ni, ať se hory nikdy nezvednou
  /// uprostřed pohybu (tam stojí 10–16 fps proti 44–52).
  function naplanujTeren() {
    // ⛔⛔ NEPŘENASTAVOVAT UŽ BĚŽÍCÍ ČASOVAČ. Dřív tu bylo `clearTimeout`
    // na začátku — jenže tahle funkce visí na `moveend`, a appka hýbe
    // kamerou sama (sledování polohy z GPS). Když přišel pohyb častěji než
    // jednou za TEREN_ZPET_MS, časovač se pořád rušil a **terén se nikdy
    // nevrátil**: tlačítko hlásilo 3D+, ale hory nebyly.
    // Naměřeno v logcatu po startu, bez jediného doteku obrazovky:
    //   [fps] 62 | pitch 42 | teren on → 39 | pitch 42 | teren off → …
    // Ruší se jen tam, kde se terén záměrně sundává (obsluha `zoom`).
    if (vratTerenCas) return;
    if (!smiTeren()) return;
    vratTerenCas = setTimeout(() => {
      vratTerenCas = null;
      // ⚠️ `isMoving` je nutné: po přechodu do 2D letí kamera na 0° a bez
      // téhle podmínky by se terén cestou na okamžik zapnul a hned zhasl.
      if (!smiTeren() || mapa.isMoving()) return;
      // ⛔⛔ SEM NIKDY NEDÁVAT `areTilesLoaded()` ANI `isStyleLoaded()`.
      // Zkoušel jsem `areTilesLoaded()` ve v1.290, abych odložil hory za
      // úvodní načtení — a TERÉN PŘESTAL NASKAKOVAT ÚPLNĚ („3D nenabíhá").
      // Je to tatáž past, před kterou varuje poznámka v `nastavTeren`:
      // v Kronice se nepřetržitě dopočítávají vrstevnice a běží animace
      // mraků a mlhy, takže se mapa do „načteno" prakticky nedostane.
      // Podruhé už na to neskákat.
      clearTimeout(vratPopiskyCas);   // popisky zůstanou zjednodušené
      nastavTeren();
    }, TEREN_ZPET_MS);
  }

  // ⚠️ PRÁH ZOOMU JE TU NUTNÝ. Bez něj se terén vracel UPROSTŘED
  // oddalování: náklon zůstává 42° dokud appka nepošle nový stupeň, takže
  // v každé mezeře mezi kroky zoomu se hory zvedly a hned zase spadly.
  // Změřeno 7. 8. 2026: v průběhu jednoho oddálení z15,5 → z10 se terén
  // takhle vrátil na z13,27 a stálo to snímek dlouhý 499 ms.
  /// ⭐ v1.542: PLYNULÝ REŽIM — mapa naplocho.
  ///
  /// Zadání: přepínač pro chvíle, kdy chce člověk maximální plynulost.
  /// Změřeno máme, že **terén stojí zhruba trojnásobek výkonu** a pod
  /// z15 půlku snímku, takže tohle je ta nejlevnější páka, kterou
  /// máme — a nestojí ji cizí dlaždice ani druhý renderer.
  ///
  /// ⚠️ ZÁVORA JE TU, NE JEN V APPCE. Náklon a terén si v enginu
  /// zapíná pět různých cest (start, tlačítko, křivka pásem, držení
  /// v herním stylu, návrat po gestu). Kdyby se to řešilo jen tím, co
  /// appka pošle, stačilo by jedno opomenutí a hory by se vrátily.
  // ⚠️ OBĚ NA `window`. Závora se čte v `smiTeren()` (uvnitř jiné
  // funkce) a přepíná se z mostu `OkolnikMost` — to jsou DVA RŮZNÉ
  // ROZSAHY. `let` tu vydrželo přesně jeden test: most spadl na
  // `ReferenceError: plochaDrzela is not defined`, chyba se schovala
  // do `catch` a přepínač se tvářil, že funguje (tlačítko svítilo,
  // kopce stály dál).
  window.__plocha = false;

  function smiTeren() {
    if (window.__plocha) return false;   // plynulý režim: hory nikdy
    if (!teren3d) return false;
    if (mapa.getTerrain && mapa.getTerrain()) return false;
    if (mapa.getPitch() < PRAH_TEREN) return false;
    if (drzetTeren) return true;    // ruční volba přebíjí i práh zoomu
    return mapa.getZoom() >= prahZoomTerenu;
  }

  // Měřič plynulosti — každé 2 s zaloguje FPS a počet dlouhých snímků
  // (v APK čitelné přes adb logcat -s flutter:I)
  (function fpsMeric() {
    setTimeout(() => console.log('[platno] '
      + mapa.getCanvas().width + '×' + mapa.getCanvas().height
      + ' (DPR ' + window.devicePixelRatio + ')'), 3000);
    let snimky = 0, dlouhe = 0, minule = performance.now(), t0 = minule;
    function krok(t) {
      snimky++;
      if (t - minule > 50) dlouhe++;
      minule = t;
      if (t - t0 >= 2000) {
        console.log(`[fps] ${Math.round(snimky * 1000 / (t - t0))}`
          + ` | >50ms: ${dlouhe} | pitch ${Math.round(mapa.getPitch())}`
          + ` | teren ${mapa.getTerrain() ? 'on' : 'off'}`
          // ⚠️ `isEasing()` v MapLibre 6 UŽ NENÍ (Map tam Cameru
          // kompozituje místo dědění a tuhle metodu nepředává).
          // Volalo se rovnou v rAF smyčce, takže výjimka celý měřič
          // umlčela — v prohlížeči si toho nikdo nevšiml, chytil to
          // až běh v APK (10. 8.).
          + ` | moving ${mapa.isMoving()}`
          // natočení mapy + poslední přání kompasu z aplikace: bez toho
          // se „mapa se netočí / postava míří špatně" hádá naslepo
          + ` | bearing ${Math.round(mapa.getBearing())}`
          + ` chce ${smerPozadovany === null ? '-'
              : Math.round(smerPozadovany)}`
          + ` drag ${mapa.dragPan.isEnabled()}`
          + ` active ${mapa.dragPan.isActive()}`);
        snimky = 0; dlouhe = 0; t0 = t;
      }
      requestAnimationFrame(krok);
    }
    requestAnimationFrame(krok);
  })();

  // -------------------------------------------------------------------------
  // Ovládací prvky
  // -------------------------------------------------------------------------
  document.getElementById('styly').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) prepniStyl(b.dataset.styl);
  });

  document.getElementById('prelety').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) prelet(b.dataset.kam);
  });

  document.getElementById('teren-prepinac').addEventListener('click', (e) => {
    teren3d = !teren3d;
    e.currentTarget.classList.toggle('aktivni', teren3d);
    e.currentTarget.textContent = teren3d ? '3D zapnuto' : '3D vypnuto';
    // POZOR: podmínka bývala `=== 0` — při pitch např. 0,4° se nic
    // nestalo a „3D nešlo zapnout" (hlášeno v herním stylu).
    // Cíl 64° = maxPitch a zároveň ≥ PRAH_TEREN, ať se hory po doletu
    // opravdu zvednou (na 45° by zůstala jen perspektiva bez terénu).
    if (teren3d && mapa.getPitch() < 1) {
      mapa.easeTo({ pitch: 64, duration: 900, essential: true });
    }
    nastavTeren();
  });

  document.getElementById('mlha-demo').addEventListener('click', () => {
    Mlha.demoVyprava(mapa);
  });

  document.getElementById('mlha-reset').addEventListener('click', () => {
    Mlha.reset();
  });
}

// ---------------------------------------------------------------------------
// NÁVRH AKVARELU (6. 8., ?akvarel=1) — malované dlaždicové vzory lesů,
// polí a vody místo plochých barev. Pečou se deterministicky na canvasu
// (mulberry32), kraje dlaždice navazují (kresba přes torus ±256). Po
// schválení uživatelem se stanou výchozími; skutečné štětcové textury
// od výtvarníka pak stačí prohodit za tyhle pečené.
// ---------------------------------------------------------------------------
// SEZÓNA MALBY (stupeň 2): palety se řídí skutečným datem jako mraky
// počasím; na zkoušku jde vynutit ?sezona=jaro|leto|podzim|zima
function sezonaMalby() {
  const vynucena = new URLSearchParams(location.search).get('sezona');
  if (vynucena && ['jaro', 'leto', 'podzim', 'zima'].includes(vynucena)) {
    return vynucena;
  }
  // v1.606: SNÍH PODLE POČASÍ – leží-li sníh (Open-Meteo snow_depth,
  // ≥ 1 cm), jsou zimní sprity i v dubnu; kalendář je jen záloha
  if (!window.__vynutMesic && typeof Pocasi !== 'undefined'
      && Pocasi.snihCm && Pocasi.snihCm() >= 1) {
    return 'zima';
  }
  // test: window.__vynutMesic = 1..12 (týž přepínač jako roj)
  const mesic = window.__vynutMesic || (new Date().getMonth() + 1);
  if (mesic >= 3 && mesic <= 5) return 'jaro';
  if (mesic >= 6 && mesic <= 8) return 'leto';
  if (mesic >= 9 && mesic <= 11) return 'podzim';
  return 'zima';
}

const SEZONY = {
  jaro: {
    stin: ['#24483A', '#FFFDF0', '#2E7D5B'],
    lesZaklad: '#74B063',
    les: ['#5FA34F', '#8CC475', '#6CAB59', '#4F8F41'],
    korunaStin: 'rgba(36,66,30,0.6)', korunaSvit: 'rgba(184,224,156,0.6)',
    poleZaklad: '#DDDA9A',
    poleSvetla: 'rgba(244,240,190,0.8)', poleTmava: 'rgba(186,178,110,0.7)',
    loukaZaklad: '#C2E093', loukaSkvrny: ['#D2EBA4', '#AFD37E'],
    // jarní louky kvetou bíle a růžově (sady)
    kvitky: ['rgba(252,250,240,0.95)', 'rgba(242,196,208,0.9)'],
  },
  leto: {
    stin: ['#2A4A36', '#FFFBE6', '#3B8A5A'],
    lesZaklad: '#69A257',
    les: ['#4F8C3E', '#7FB868', '#5C9A4A', '#457F36'],
    korunaStin: 'rgba(30,58,24,0.6)', korunaSvit: 'rgba(158,205,128,0.55)',
    poleZaklad: '#E4DC96',
    poleSvetla: 'rgba(248,239,178,0.8)', poleTmava: 'rgba(190,176,102,0.7)',
    loukaZaklad: '#BCD989', loukaSkvrny: ['#CBE59A', '#A9CC74'],
    kvitky: ['rgba(250,246,228,0.9)', 'rgba(233,201,78,0.9)'],
  },
  podzim: {
    stin: ['#4A3A2A', '#FFF4DC', '#8C6A3A'],
    lesZaklad: '#8E8B43',
    les: ['#B8862F', '#C99A45', '#75873C', '#A3552F'],
    korunaStin: 'rgba(74,48,20,0.6)', korunaSvit: 'rgba(228,183,96,0.6)',
    poleZaklad: '#D9C98F',       // strniště po žních
    poleSvetla: 'rgba(238,224,168,0.8)', poleTmava: 'rgba(176,152,96,0.7)',
    loukaZaklad: '#B3C47C', loukaSkvrny: ['#C4D28C', '#9DAF66'],
    kvitky: ['rgba(246,240,220,0.85)', 'rgba(200,140,60,0.85)'],
  },
  // v1.606: HOLÁ ZIMA (bez sněhu) – prosinec až únor, když nesněží:
  // tmavé jehličnany, hnědošedá pole, vybledlé louky
  holo: {
    stin: ['#3C3F3C', '#F4F2EE', '#6F7A6F'],
    lesZaklad: '#6E7C62',
    les: ['#5D6E52', '#7C8A6C', '#66755A', '#4E5E45'],
    korunaStin: 'rgba(40,50,36,0.6)', korunaSvit: 'rgba(180,190,168,0.5)',
    poleZaklad: '#C9B99A',
    poleSvetla: 'rgba(224,214,190,0.8)', poleTmava: 'rgba(160,140,108,0.7)',
    loukaZaklad: '#B9B98C', loukaSkvrny: ['#C8C69A', '#A4A67A'],
    kvitky: ['rgba(240,236,224,0.6)', 'rgba(210,200,170,0.6)'],
  },
  snih: {
    // BÍLEJŠÍ (přání 6. 8. v noci): zasněžená krajina, jehličnany
    // prokvetlé sněhem, pole a louky pod peřinou (v1.606: paleta sněhu,
    // míchá se podle výšky sněhu z počasí, plná od 5 cm)
    stin: ['#5B6B86', '#FFFFFF', '#9FB0C8'],
    lesZaklad: '#7E937F',
    les: ['#6B826D', '#93A794', '#5C725E', '#A9B8AA'],
    korunaStin: 'rgba(52,66,54,0.55)', korunaSvit: 'rgba(244,248,244,0.75)',
    poleZaklad: '#F1EEE4',
    poleSvetla: 'rgba(255,255,252,0.9)', poleTmava: 'rgba(205,202,190,0.55)',
    loukaZaklad: '#E9EBDE', loukaSkvrny: ['#F4F5EC', '#D8DCCA'],
    kvitky: ['rgba(255,255,253,0.95)', 'rgba(228,233,226,0.9)'],
  },
};

/// ⭐⭐ VELIKOST AKVARELOVÝCH VZORŮ — NEJDRAŽŠÍ POLOŽKA ATLASU (9. 8. 2026).
/// Profil dvou stabilních stylů ukázal, že herní mapa tráví **13,7 % času
/// procesoru** ve funkci, která přednásobuje alfu pixel po pixelu před
/// každým nahráním textury do GPU (`_uploadRawData` v MapLibre). Za 2,6 s
/// posunu nahraje herní styl **6,49 M pixelů**, turistická 0,66 M — a
/// v atlasu (2,74 M px) zabíraly vzory 512×512 celých **48 %**.
/// ⚠️ Zmenšovat `icon-size` je k ničemu: atlas nese ZDROJOVÁ data, ne
/// vykreslenou velikost (ověřeno — 0,25× velikost stála stejně jako 1×).
/// Vzory jsou beztvaré rozpité lavice barvy, takže poloviční jemnost nemá
/// co prozradit — snímky 512 a 256 vedle sebe jsou nerozeznatelné.
///
/// ⭐ ZMĚŘENO NA TELEFONU (A,B,B,A, tatáž trasa, herní styl, náklon 42°):
///                     512×512            256×256
///   posun ……… 50 fps, p90 44,5 ms   **59 fps**, p90 39,0 ms
///   ZOOM ……… **27 fps**, p90 66,2   **50 fps**, p90 43,3
///   rotace …… 57 fps                 57 fps (nahrává se skoro nic)
///   nahraných pixelů při zoomu: 13,99 M → 4,45 M
/// Zisk přesně kopíruje objem nahraných pixelů. Zoom je nejcitlivější,
/// protože při něm přibývá nejvíc nových dlaždic — a každá si nahraje
/// vlastní atlas.
/// ⚠️ NÍŽ UŽ NECHODIT: 128 px nepřineslo nic (53 vs 53 fps při zoomu).
/// Pod 256 přestávají vzory být v atlasu tou velkou položkou a zbytek
/// (dekorace, ikony míst) se tím nezmenší.
let VZOR_PX = 256;

/// Přepnutí velikosti vzorů za běhu (pro měření přes CDP).
function nastavVelikostVzoru(px) {
  VZOR_PX = px;
  for (const jm of ['vzor-les', 'vzor-pole', 'vzor-louka',
                    'vzor-mesta', 'vzor-voda']) {
    try { if (mapa.hasImage(jm)) mapa.removeImage(jm); } catch (e) { /* nevadí */ }
  }
  pridejAkvarelVzory();
  return VZOR_PX;
}

// ⭐ v1.606: PLYNULÁ SEZÓNA (přání 4. 9. 2026: „přechody mezi obdobími,
// sníh podle počasí místo kalendáře, stínování k období"). Paleta se
// míchá mezi kotvami podle dne v roce – listopad hnědne postupně,
// březen zelená postupně – a při ležícím sněhu (Open-Meteo snow_depth,
// posílá appka s počasím) se míchá do bílé; plná bílá od 5 cm. Zima
// bez sněhu je „holá" (šedohnědá), ne bílá.
const SEZONA_KOTVY = [
  [15, 'holo'],     // 15. 1.
  [110, 'jaro'],    // 20. 4.
  [166, 'leto'],    // 15. 6.
  [237, 'leto'],    // 25. 8.
  [288, 'podzim'],  // 15. 10.
  [329, 'holo'],    // 25. 11.
  [380, 'holo'],    // 15. 1. dalšího roku (přetočení)
];

function mixBarva(a, b, t) {
  const roz = (c) => {
    c = String(c).trim();
    if (c[0] === '#') {
      const h = c.length === 4
          ? c.slice(1).split('').map((x) => x + x).join('') : c.slice(1, 7);
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16),
              parseInt(h.slice(4, 6), 16), 1, 'hex'];
    }
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1, 'rgba'];
  };
  const A = roz(a);
  const B = roz(b);
  if (!A || !B) return t < 0.5 ? a : b;
  const l = (i) => A[i] + (B[i] - A[i]) * t;
  if (A[4] === 'hex' && B[4] === 'hex') {
    const h = (v) => Math.round(Math.max(0, Math.min(255, v)))
        .toString(16).padStart(2, '0');
    return '#' + h(l(0)) + h(l(1)) + h(l(2));
  }
  return 'rgba(' + Math.round(l(0)) + ',' + Math.round(l(1)) + ','
      + Math.round(l(2)) + ',' + (Math.round(l(3) * 100) / 100) + ')';
}

function mixPaleta(A, B, t) {
  if (t <= 0) return A;
  if (t >= 1) return B;
  const out = {};
  for (const k of Object.keys(A)) {
    const va = A[k];
    const vb = B[k] !== undefined ? B[k] : va;
    out[k] = Array.isArray(va)
        ? va.map((x, i) => mixBarva(x, vb[i] !== undefined ? vb[i] : x, t))
        : mixBarva(va, vb, t);
  }
  return out;
}

function paletaSezony() {
  const vynucena = new URLSearchParams(location.search).get('sezona');
  if (vynucena) {
    const p = vynucena === 'zima' ? SEZONY.snih : SEZONY[vynucena];
    if (p) return p;
  }
  const dnes = window.__vynutMesic
      ? new Date(new Date().getFullYear(), window.__vynutMesic - 1, 15)
      : new Date();
  const zac = new Date(dnes.getFullYear(), 0, 1);
  let den = Math.floor((dnes - zac) / 86400000) + 1;
  if (den < SEZONA_KOTVY[0][0]) den += 365;
  let A = SEZONA_KOTVY[0];
  let B = SEZONA_KOTVY[SEZONA_KOTVY.length - 1];
  for (let i = 0; i < SEZONA_KOTVY.length - 1; i++) {
    if (den >= SEZONA_KOTVY[i][0] && den <= SEZONA_KOTVY[i + 1][0]) {
      A = SEZONA_KOTVY[i];
      B = SEZONA_KOTVY[i + 1];
      break;
    }
  }
  const t = (den - A[0]) / Math.max(1, B[0] - A[0]);
  let pal = mixPaleta(SEZONY[A[1]], SEZONY[B[1]], t);
  const cm = (typeof Pocasi !== 'undefined' && Pocasi.snihCm)
      ? Pocasi.snihCm() : 0;
  if (cm > 0) pal = mixPaleta(pal, SEZONY.snih, Math.min(1, cm / 5));
  return pal;
}

/// Stínování kopců podle sezóny (bod 4): jen dva paint parametry téže
/// vrstvy, žádná vrstva navíc.
function aplikujStinovaniSezony(pal) {
  try {
    // jen herní styl (`stinovani`); ostatní styly se sezónou nebarví
    // (rozhodnutí uživatele 4. 9.: „2. ne")
    if (!mapa || !mapa.getLayer('stinovani') || !pal.stin) return;
    mapa.setPaintProperty('stinovani', 'hillshade-shadow-color', pal.stin[0]);
    mapa.setPaintProperty('stinovani', 'hillshade-highlight-color',
                          pal.stin[1]);
    if (pal.stin[2]) {
      mapa.setPaintProperty('stinovani', 'hillshade-accent-color',
                            pal.stin[2]);
    }
  } catch (e) { /* jiný styl bez stínování */ }
}

/// Přepočet sezóny za běhu – volá se s každým počasím z appky (~30 min):
/// změnil-li se namíchaný odstín (nový den, napadl sníh), vzory se upečou
/// znovu (pět obrázků 256 px, jednou) a přebarví se stínování.
let paletaPodpis = '';
function aktualizujSezonu() {
  try {
    if (!mapa) return;
    const pal = paletaSezony();
    const podpis = JSON.stringify(pal);
    if (podpis === paletaPodpis) return;
    paletaPodpis = podpis;
    if (mapa.hasImage('vzor-les')) {
      // ⚠️ OVĚŘENO 4. 9.: odebrat + přidat obrázek se do hotových dlaždic
      // nepromítne (vzor si dlaždice drží z atlasu); `updateImage` +
      // znovunačtení dlaždic zdroje zabere hned (jednou, vzácně)
      pridejAkvarelVzory(true);
      try {
        const tm = mapa.style && mapa.style.tileManagers
            && mapa.style.tileManagers.omt;
        if (tm && typeof tm.reload === 'function') tm.reload();
      } catch (e2) { /* starší bundle */ }
    } else {
      pridejAkvarelVzory();
    }
    aplikujStinovaniSezony(pal);
    console.log('[sezona] paleta přepočtena (sníh '
        + ((typeof Pocasi !== 'undefined' && Pocasi.snihCm)
            ? Pocasi.snihCm() : 0) + ' cm)');
  } catch (e) { console.warn('[sezona]', e); }
}
window.aktualizujSezonu = aktualizujSezonu;

function pridejAkvarelVzory(vynutit) {
  if (!mapa || (!vynutit && mapa.hasImage('vzor-les'))) return;
  const SEZ = paletaSezony();
  paletaPodpis = JSON.stringify(SEZ);
  aplikujStinovaniSezony(SEZ);
  const rng = (seed) => () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  // Vzory nesou UZ JEN beztvare laviny barvy (mekke skvrny, tahy
  // stetce, vlnky) - DISKRETNI OBJEKTY (stromy, kytky, strechy) jsou
  // od 7. 8. skutecne body mapy v js/dekorace.js: dlazdicovy vzor se
  // s kazdym celym zoomem preskladava a objekty v nem "poskakovaly,
  // pribyvaly a zmensovaly se" (vytka uzivatele). Mekke skvrny zadne
  // rozpoznatelne tvary nemaji, takze jejich preskladani neni videt.
  const S = VZOR_PX;
  const vyrob = (jmeno, zaklad, kresliN) => {
    const p = document.createElement('canvas');
    p.width = S;
    p.height = S;
    const ctx = p.getContext('2d');
    ctx.fillStyle = zaklad;
    ctx.fillRect(0, 0, S, S);
    const torus = (kresli) => {
      for (const ox of [-S, 0, S]) {
        for (const oy of [-S, 0, S]) kresli(ox, oy);
      }
    };
    kresliN(ctx, torus);
    // ⚠️ `pixelRatio` musí jít s velikostí, jinak se změní i to, jak
    // hustě se vzor na mapě opakuje. 512@2 a 256@1 kreslí NA OBRAZOVCE
    // stejně velký vzor, jen s poloviční jemností.
    const data = ctx.getImageData(0, 0, S, S);
    if (mapa.hasImage(jmeno)) mapa.updateImage(jmeno, data);
    else mapa.addImage(jmeno, data, { pixelRatio: S / 256 });
  };

  // LES: jen mekke mechove skvrny (zadne koruny - stromy ma dekorace)
  vyrob('vzor-les', SEZ.lesZaklad, (ctx, torus) => {
    const r = rng(11);
    for (let i = 0; i < 70; i++) {
      const x = r() * S; const y = r() * S;
      const pr = 24 + r() * 56;
      const b = SEZ.les[Math.floor(r() * SEZ.les.length)];
      torus((ox, oy) => {
        const g = ctx.createRadialGradient(x + ox, y + oy, pr * 0.15,
                                           x + ox, y + oy, pr);
        g.addColorStop(0, b);
        g.addColorStop(1, b + '00');
        ctx.fillStyle = g;
        ctx.fillRect(x + ox - pr, y + oy - pr, pr * 2, pr * 2);
      });
    }
  });

  // POLE: dlouhe sikme tahy stetce ("tahy jsou ok")
  vyrob('vzor-pole', SEZ.poleZaklad, (ctx, torus) => {
    const r = rng(22);
    ctx.lineCap = 'round';
    for (let i = 0; i < 56; i++) {
      const x = r() * S; const y = r() * S;
      const d = 55 + r() * 100;
      const svetla = r() < 0.5;
      ctx.strokeStyle = svetla ? SEZ.poleSvetla : SEZ.poleTmava;
      ctx.lineWidth = 5 + r() * 7;
      torus((ox, oy) => {
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.lineTo(x + ox + d * 0.85, y + oy - d * 0.5);
        ctx.stroke();
      });
    }
  });

  // LOUKA: jen mekke tonove skvrny (kytky ma dekorace)
  vyrob('vzor-louka', SEZ.loukaZaklad, (ctx, torus) => {
    const r = rng(44);
    for (let i = 0; i < 30; i++) {
      const x = r() * S; const y = r() * S;
      const pr = 26 + r() * 52;
      const b = SEZ.loukaSkvrny[r() < 0.5 ? 0 : 1];
      torus((ox, oy) => {
        const g = ctx.createRadialGradient(x + ox, y + oy, pr * 0.2,
                                           x + ox, y + oy, pr);
        g.addColorStop(0, b);
        g.addColorStop(1, b + '00');
        ctx.fillStyle = g;
        ctx.fillRect(x + ox - pr, y + oy - pr, pr * 2, pr * 2);
      });
    }
  });

  // MESTA: tepla omitka s jemnym zihanim (strechy ma dekorace)
  vyrob('vzor-mesta', '#EBD4A9', (ctx, torus) => {
    const r = rng(55);
    for (let i = 0; i < 26; i++) {
      const x = r() * S; const y = r() * S;
      const pr = 30 + r() * 55;
      const b = r() < 0.5 ? '#E2C695' : '#F1DDB8';
      torus((ox, oy) => {
        const g = ctx.createRadialGradient(x + ox, y + oy, pr * 0.2,
                                           x + ox, y + oy, pr);
        g.addColorStop(0, b);
        g.addColorStop(1, b + '00');
        ctx.fillStyle = g;
        ctx.fillRect(x + ox - pr, y + oy - pr, pr * 2, pr * 2);
      });
    }
  });

  // VODA: tyrkys s dlouhymi vlnkami
  vyrob('vzor-voda', '#2FA7A0', (ctx, torus) => {
    const r = rng(33);
    for (let i = 0; i < 30; i++) {
      const y = r() * S; const x = r() * S;
      const d = 60 + r() * 95;
      ctx.strokeStyle = r() < 0.6
        ? 'rgba(118,214,205,0.7)' : 'rgba(14,110,104,0.55)';
      ctx.lineWidth = 2.6 + r() * 2.6;
      ctx.lineCap = 'round';
      torus((ox, oy) => {
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.quadraticCurveTo(x + ox + d / 2, y + oy - 6,
                             x + ox + d, y + oy);
        ctx.stroke();
      });
    }
  });
}

/// Základní (hotový styl Liberty) mluví anglicky a uprostřed mapy má
/// „Czechia" — po načtení stylu se popisky sídel přepnou na name:cs
/// (Prague → Praha) a nápisy zemí se schovají (přání 6. 8. v noci).
function pocestiZakladni() {
  if (aktualniKod !== 'zakladni' || !mapa) return;
  const styl = mapa.getStyle();
  if (!styl || !styl.layers) return;
  for (const v of styl.layers) {
    if (v.type !== 'symbol' || v['source-layer'] !== 'place') continue;
    if ((v.id + JSON.stringify(v.filter || '')).includes('country')) {
      try {
        mapa.setLayoutProperty(v.id, 'visibility', 'none');
      } catch (e) { /* vrstva mezitím zmizela */ }
      continue;
    }
    try {
      mapa.setLayoutProperty(v.id, 'text-field',
          ['coalesce', ['get', 'name:cs'], ['get', 'name']]);
    } catch (e) { /* vrstva mezitím zmizela */ }
  }
}

// Doplňky po načtení stylu: terén, obloha, případně stínování a mlha
function aplikujDoplnky() {
  // nový styl = nová šance i pro kresby, které minule nešly stáhnout
  // (server assetů se mohl teprve rozbíhat) – černá listina se čistí
  ikonySelhane.clear();
  // výměna stylu smaže vlastní zdroje – místa Okolníku založit znovu
  setTimeout(vykresliMista, 0);
  const cfg = STYLY[aktualniKod];

  // ⛔⛔ `nastavTeren()` SE MUSÍ DOSTAT NA ŘADU I KDYŽ SE TU NĚCO POKAZÍ
  // (6. 8. 2026). Tahle funkce je JEDINÁ cesta, kterou se po výměně stylu
  // vrací terén. Když z ní cokoli vyskočí výjimkou dřív (třeba
  // `mapa.getStyle().layers` u injektáže stínování, kde styl ještě nemusí
  // být), zůstane mapa s terénem, který ukazuje na ZAHOZENÝ styl – a
  // vykreslování je rozsypané NATRVALO, dokud uživatel appku nerestartuje.
  // Přesně to se stalo (mapa se sama nespravila ani po minutách).
  // Proto je zbytek v `try` a `nastavTeren()` ve `finally`.
  try {
  // Zdroje terénu (hotové styly z URL je nemají); zdrojTerenu() ve styles.js
  // umí šablonu i pmtiles://; stínování se stropem z13 (viz styles.js)
  // ⚠️ STEJNÝ STROP JAKO VE `styles.js` (oprava 6. 8. 2026). Tady se
  // zakládalo `zdrojTerenu()` bez argumentu = maxzoom 14 a PŘÍMÉ pmtiles,
  // kdežto vlastní styly dostávají `zdrojTerenu(13)` přes sdílenou keš.
  // Zdroj `teren` se tak při přepnutí stylu měnil pod rukama.
  if (!mapa.getSource('teren')) {
    mapa.addSource('teren', zdrojTerenu(13));
  }
  if (!mapa.getSource('stinovani')) {
    mapa.addSource('stinovani', zdrojTerenu(13));
  }

  // Injektovat jemné stínování do hotového stylu (Základní)
  if (cfg.injektovatStinovani && !mapa.getLayer('okolnik-stinovani')) {
    const styl = mapa.getStyle();
    const vrstvy = (styl && styl.layers) || [];
    const prvniCara = vrstvy.find(v => v.type === 'line' || v.type === 'symbol');
    mapa.addLayer({
      id: 'okolnik-stinovani', type: 'hillshade', source: 'stinovani',
      paint: { 'hillshade-exaggeration': 0.3,
               'hillshade-shadow-color': '#5a5040',
               'hillshade-highlight-color': '#ffffff' },
    }, prvniCara ? prvniCara.id : undefined);
  }

  // Obloha pro hotové styly (vlastní ji mají ve style.json)
  if (typeof cfg.podklad === 'string') {
    try { mapa.setSky(obloha()); } catch (e) { /* starší maplibre */ }
  }

  // ⚠️ LOD SE PŘI VÝMĚNĚ STYLU ZTRATÍ. `setSourceTileLodParams` zapisuje
  // nastavení do OBJEKTU ZDROJE, a `setStyle` zdroje vyrábí znovu – po
  // přepnutí stylu tedy platily zase výchozí (štědré) hodnoty a terén si
  // tahal víc dlaždic, než má. Patří sem, ne do `on('load')`.
  try {
    if (mapa.setSourceTileLodParams) {
      mapa.setSourceTileLodParams(5, 1.8);
      if (mapa.getSource('teren')) {
        mapa.setSourceTileLodParams(3, 1.4, 'teren');
      }
      if (mapa.getSource('stinovani')) {
        mapa.setSourceTileLodParams(3, 1.4, 'stinovani');
      }
    }
  } catch (e) { /* starší MapLibre tuhle metodu nemá */ }
  } catch (e) {
    console.warn('[most] aplikujDoplnky – doplňky stylu:', e);
  } finally {
    // ⛔ NIKDY NEPŘESKOČIT: bez tohohle zůstane terén viset nad zahozeným
    // stylem a mapa je rozsypaná natrvalo (viz komentář na začátku funkce).
    try { nastavTeren(); } catch (e) {
      console.warn('[most] aplikujDoplnky – nastavTeren:', e);
    }
  }

  // Mlha objevování a kreslené ilustrace míst jen v herním stylu
  if (cfg.mlha) {
    if (typeof AKVAREL !== 'undefined' && AKVAREL) {
      pridejAkvarelVzory();
      Dekorace.pripoj(mapa);  // stromy/kytky/střechy jako BODY mapy
    }
    Mlha.pripoj(mapa);
    Ilustrace.pripoj(mapa);
    Pocasi.pripoj(mapa);    // mraky dle skutečného počasí (v2.1)
    Erby.pripoj(mapa);      // erby dokončených obcí (v2.2)
    try { Trpyt.pripoj(mapa); } catch (e) { console.warn('[trpyt]', e); }
    // ⭐ 5. 9. 2026: káně kroužící nad krajinou (den, herní styl)
    try { Ptaci.pripoj(mapa); } catch (e) { console.warn('[ptaci]', e); }
    try { nasadDomalovani(); } catch (e) { console.warn('[domalovani]', e); }
  } else {
    Pocasi.zavri();
    try { Trpyt.zavri(); } catch (e) { /* nic */ }
  }
  // v1.607: skutečné světlo budov a stínování – ve všech stylech
  try { Svetlo.pripoj(mapa); } catch (e) { console.warn('[svetlo]', e); }
  pocestiZakladni();        // Czechia pryč, Prague → Praha
  // ⭐ JEDEN SEZNAM OBNOVITELŮ (6. 8. 2026). `setStyle` zahodí VŠECHNY
  // vlastní zdroje a vrstvy, takže je musí po výměně stylu někdo založit
  // znovu. Dřív se obnovovala jen místa a uložené výpravy — běžící výprava
  // (červená) a značky KČT po přepnutí do herního stylu MIZELY NADOBRO
  // (hlášeno „běžící výpravu stále nevidím"). Každá nová vrstva z mostu
  // patří SEM, jinak se na ni zase zapomene.
  for (const obnov of [vykresliMista, vykresliVypravy,
                       vykresliAktivniVypravu, vykresliZnacky,
                       pridejBudovy3d]) {
    setTimeout(obnov, 0);
  }
  pridejMaskuZahranici();   // cizinu kryje barva stylu (herní má pergamen)
  Navigace.obnovVrstvy();   // trasa přežívá přepnutí stylu
  document.body.classList.toggle('styl-herni', !!cfg.mlha);
  zavriAtribuci();          // nový styl ji vyrobí rozbalenou
}

// ---------------------------------------------------------------------------
// DRÁHY ULOŽENÝCH VÝPRAV (v2.1) — tušová linka v duchu Kroniky
// ---------------------------------------------------------------------------
let posledniVypravy = [];   // [[[lng,lat], …], …]

/// Poslední poloha uživatele z mostu ({lng, lat}) – pro hlášení kamery.
let poslednPolohaUziv = null;

/// Poslední turistické značky z aplikace ([{b, body:[[lng,lat]…]}]).
/// ⚠️ MUSÍ SE PAMATOVAT: `setStyle` zdroj zahodí a appka je posílá jen při
/// změně výřezu – po přepnutí stylu (kamera se nehne) by značky zmizely,
/// dokud uživatel nepohne mapou.
// ───── CYKLOTRASY (v1.601) – dlaždice ve Filtrech, VŠECHNY režimy ─────
// Do v1.595 je kreslil jen Dobyvatel (dobyvatel.js) a jen ve svém stylu.
// Přání 3. 9. 2026: „dej cyklotrasy do filtrů všech režimů" → obecný
// modul: data z přibaleného assets/cyklo.json (celá ČR, značené trasy
// OSM route=bicycle; z = význam 0–3, v = 1 pro ještě nevyznačené),
// vrstvy se nasazují do každého stylu a po každém style.load znovu
// (styl vlastní zdroje maže). Fialová přerušovaná, ať se liší od
// plných pěších značek KČT.
let cykloZap = false;
let cykloFC = null;
let cykloNacita = false;
const CYKLO_BARVA = '#8E44AD';

function nactiCyklo() {
  if (cykloNacita || cykloFC) { nasadCyklo(); return; }
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
      nasadCyklo();
    })
    .catch(() => { cykloNacita = false; });
}

/** Zdroj + vrstvy do aktuálního stylu (idempotentní) a viditelnost. */
function nasadCyklo() {
  if (!mapa || !cykloFC) return;
  try {
    if (!mapa.getSource('okolnik-cyklo')) {
      mapa.addSource('okolnik-cyklo', { type: 'geojson', data: cykloFC });
    }
    const pred = prvniSymbolovaVrstva();
    const vid = cykloZap ? 'visible' : 'none';
    if (!mapa.getLayer('okolnik-cyklo-hl')) {
      // významné (mezinárodní/národní) už z dálky
      mapa.addLayer({ id: 'okolnik-cyklo-hl', type: 'line',
        source: 'okolnik-cyklo', minzoom: 6.5,
        filter: ['>=', ['get', 'z'], 2],
        layout: { visibility: vid, 'line-cap': 'round' },
        paint: { 'line-color': CYKLO_BARVA,
          'line-width': ['interpolate', ['linear'], ['zoom'],
            6.5, 1.4, 10, 2.3, 13, 3, 16, 4],
          'line-dasharray': [2, 1.4],
          'line-opacity': ['case', ['==', ['get', 'v'], 1],
            0.25, 0.9] } }, pred);
    }
    if (!mapa.getLayer('okolnik-cyklo')) {
      mapa.addLayer({ id: 'okolnik-cyklo', type: 'line',
        source: 'okolnik-cyklo', minzoom: 9.6,
        filter: ['<', ['get', 'z'], 2],
        layout: { visibility: vid, 'line-cap': 'round' },
        paint: { 'line-color': CYKLO_BARVA,
          'line-width': ['interpolate', ['linear'], ['zoom'],
            9.6, 1, 13, 2.2, 16, 3.4],
          'line-dasharray': [2, 1.4],
          'line-opacity': ['case', ['==', ['get', 'v'], 1],
            0.22, 0.8] } }, pred);
    }
    for (const id of ['okolnik-cyklo-hl', 'okolnik-cyklo']) {
      mapa.setLayoutProperty(id, 'visibility', vid);
    }
  } catch (e) { /* styl se zrovna skládá – doběhne ze style.load */ }
}

/** Aplikace (OkolnikMost.cyklo): zapnout/vypnout cyklotrasy. */
function zapniCyklotrasy(zap) {
  cykloZap = !!zap;
  if (cykloZap && !cykloFC) nactiCyklo();
  else nasadCyklo();
}

let posledniZnacky = [];

function vykresliZnacky() {
  if (!mapa) return;
  if (!mapa.getStyle()) {
    clearTimeout(vykresliZnacky._t);
    vykresliZnacky._t = setTimeout(vykresliZnacky, 250);
    return;
  }
  try {
    // ⚡ podpisová brána: počet úseků + součet bodů (sada se mění jen
    // dávkou z appky po dotažení kraje)
    const podpis = posledniZnacky.length + '|'
        + posledniZnacky.reduce((s, u) => s + (u.body ? u.body.length : 0), 0);
    if (mapa.getSource('okolnik-znacky')
        && podpis === vykresliZnacky._podpis) return;
    vykresliZnacky._podpis = podpis;
    const gj = {
      type: 'FeatureCollection',
      features: posledniZnacky.map((u) => ({
        type: 'Feature',
        properties: { b: u.b },
        geometry: { type: 'LineString', coordinates: u.body },
      })),
    };
    const zdroj = mapa.getSource('okolnik-znacky');
    if (zdroj) { zdroj.setData(gj); return; }
    mapa.addSource('okolnik-znacky',
        { type: 'geojson', data: gj, maxzoom: 14 });
    // 6. 8. 2026: „značky trochu zvýrazni" – proti 2D (1,3–4,6 px)
    // o kus silnější; podklad drží 2D poměr (čára + 1,8 px).
    const sirka = ['interpolate', ['linear'], ['zoom'],
                   10, 1.8, 13, 3.2, 16, 5.6];
    mapa.addLayer({
      id: 'okolnik-znacky-podklad', type: 'line', source: 'okolnik-znacky',
      paint: { 'line-color': '#FFFFFF', 'line-opacity': 0.7,
               'line-width': ['interpolate', ['linear'], ['zoom'],
                              10, 3.6, 13, 5.0, 16, 7.4] },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    }, prvniSymbolovaVrstva());
    mapa.addLayer({
      id: 'okolnik-znacky-linka', type: 'line', source: 'okolnik-znacky',
      paint: {
        'line-width': sirka,
        'line-color': ['match', ['get', 'b'],
                       'r', '#D32F2F', 'b', '#1565C0',
                       'g', '#2E7D32', 'y', '#F9A825', '#D32F2F'],
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    }, prvniSymbolovaVrstva());
  } catch (e) {
    clearTimeout(vykresliZnacky._t);
    vykresliZnacky._t = setTimeout(vykresliZnacky, 400);
  }
}

/// 3D BUDOVY (6. 8. 2026, „ve 3D+ nevidím v neherním režimu budovy").
/// Ploché výplně budov měly styly odjakživa; tohle je vytáhne do výšky,
/// takže při náklonu vznikne skutečné město. V HERNÍM stylu se nekreslí –
/// Kronika má vlastní kreslený vzhled.
/// ⚠️ Jméno vektorového zdroje se liší (naše styly `omt`, hotový Liberty
/// `openmaptiles`), proto se hledá podle typu.
function pridejBudovy3d() {
  if (!mapa || !mapa.getStyle()) return;
  try {
    if (mapa.getLayer('okolnik-budovy-3d')) return;
    const cfg = STYLY[aktualniKod];
    if (cfg && cfg.mlha) return;          // herní styl si kreslí své
    const zdroje = mapa.getStyle().sources || {};
    let zdroj = null;
    for (const [jmeno, z] of Object.entries(zdroje)) {
      if (z.type === 'vector') { zdroj = jmeno; break; }
    }
    if (!zdroj) return;
    mapa.addLayer({
      id: 'okolnik-budovy-3d',
      type: 'fill-extrusion',
      source: zdroj,
      'source-layer': 'building',
      minzoom: 14.5,
      paint: {
        'fill-extrusion-color': '#D8CFC2',
        // OpenMapTiles nese `render_height`; kde chybí, odhad 8 m
        'fill-extrusion-height':
          ['coalesce', ['get', 'render_height'], ['get', 'height'], 8],
        'fill-extrusion-base':
          ['coalesce', ['get', 'render_min_height'], 0],
        // plynulý nástup, ať se domy „nevynoří" skokem
        'fill-extrusion-opacity': 0.85,
      },
    }, prvniSymbolovaVrstva());
    // v1.599 pojistka („Dobyvatel po načtení nevidí domy, až při
    // pohnutí"): až dojedou dlaždice nového stylu, vynutit snímek —
    // vrstva přidaná mezi načtením a klidem se jinak ukáže až s gestem
    mapa.once('idle', () => { try { mapa.triggerRepaint(); } catch (e) {} });
  } catch (e) { console.warn('[budovy] ', e); }
}

/// ⭐ ID PRVNÍ SYMBOLOVÉ VRSTVY. Čárové vrstvy vkládané NAD symboly rozbíjejí
/// souvislý blok „drapovaných" vrstev na víc kusů a s terénem pak MapLibre
/// dělá několik průchodů render-to-texture na KAŽDOU terénní dlaždici –
/// jeden z doložených důvodů sekání při náklonu. Proto všechny naše linky
/// vkládáme PŘED první symbol.
// ⭐ v1.607: DOMALOVÁNÍ (přání 4. 9.: „v místech naznačovat kopce, staré
// cesty, zvýraznit"): šrafy podél HLAVNÍCH vrstevnic od z14 – `line-pattern`
// se svislou čárkou opakovanou podél čáry = klasické šrafování reliéfu
// z ručních map; jedna line vrstva nad existujícím zdrojem vrstevnic.
// Staré cesty (path/track) už kreslí vrstva `cesty` sépiově čárkovaně.
// Záře pod malovanými místy je u vrstvy `okolnik-mista-ikona`.
function nasadDomalovani() {
  if (!mapa || aktualniKod !== 'herni') return;
  if (!mapa.hasImage('srafa')) {
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 8;
    const ctx = c.getContext('2d');
    ctx.strokeStyle = 'rgba(74,59,40,0.85)';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(2.5, 0.5);
    ctx.lineTo(2.5, 7.5);
    ctx.stroke();
    mapa.addImage('srafa', ctx.getImageData(0, 0, 16, 8), { pixelRatio: 2 });
  }
  if (!mapa.getLayer('ink-vrstevnice-srafy') && mapa.getSource('kontury')) {
    mapa.addLayer({
      id: 'ink-vrstevnice-srafy', type: 'line', source: 'kontury',
      'source-layer': 'contours', minzoom: 14,
      filter: ['==', ['get', 'level'], 1],
      paint: { 'line-pattern': 'srafa', 'line-width': 4,
               'line-opacity': ['interpolate', ['linear'], ['zoom'],
                 14, 0, 15.5, 0.45] },
    }, prvniSymbolovaVrstva());
  }
}

function prvniSymbolovaVrstva() {
  try {
    for (const v of mapa.getStyle().layers) {
      if (v.type === 'symbol') return v.id;
    }
  } catch (e) { /* styl se zrovna mění */ }
  return undefined;
}

// BĚŽÍCÍ VÝPRAVA (6. 8. 2026, „po spuštění výpravy se neukazuje běžící
// výprava na mapě"): kreslí se ČERVENĚ a navrchu, ať je na první pohled
// k rozeznání od uložených – stejné pravidlo jako na 2D mapě.
let aktivniVyprava = [];

function vykresliAktivniVypravu() {
  if (!mapa) return;
  // ⚠️ BĚHEM VÝMĚNY STYLU vrací getStyle() undefined – tichý return by
  // data ZAHODIL NADOBRO (přesně proto nebyla vidět běžící výprava).
  // Zkusit znovu za chvíli.
  if (!mapa.getStyle()) {
    clearTimeout(vykresliAktivniVypravu._t);
    vykresliAktivniVypravu._t = setTimeout(vykresliAktivniVypravu, 250);
    return;
  }
  try {
    // ⚡ podpisová brána: stopa jen PŘIRŮSTÁ — délka + poslední bod stačí
    const podpis = aktivniVyprava.length + '|'
        + (aktivniVyprava.length
            ? aktivniVyprava[aktivniVyprava.length - 1].join(',') : '');
    if (mapa.getSource('okolnik-vyprava-ted')
        && podpis === vykresliAktivniVypravu._podpis) return;
    vykresliAktivniVypravu._podpis = podpis;
    const gj = {
      type: 'FeatureCollection',
      features: aktivniVyprava.length < 2 ? [] : [{
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: aktivniVyprava },
      }],
    };
    const zdroj = mapa.getSource('okolnik-vyprava-ted');
    if (zdroj) { zdroj.setData(gj); return; }
    mapa.addSource('okolnik-vyprava-ted',
        { type: 'geojson', data: gj, maxzoom: 14 });
    mapa.addLayer({
      id: 'okolnik-vyprava-ted-podklad', type: 'line',
      source: 'okolnik-vyprava-ted',
      paint: { 'line-color': '#FFF3E0', 'line-width': 6.5,
               'line-opacity': 0.6 },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    }, prvniSymbolovaVrstva());
    mapa.addLayer({
      id: 'okolnik-vyprava-ted-linka', type: 'line',
      source: 'okolnik-vyprava-ted',
      paint: { 'line-color': '#C62828', 'line-width': 3.4,
               'line-opacity': 0.95 },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    }, prvniSymbolovaVrstva());
  } catch (e) {
    // výměna stylu zrovna běží – zkusit za chvíli znovu
    clearTimeout(vykresliAktivniVypravu._t);
    vykresliAktivniVypravu._t = setTimeout(vykresliAktivniVypravu, 400);
  }
}

let stopaDne = [];
/// ⭐ v1.450: TRASA VYBRANÉHO DNE. Neukazuje se sama od sebe — appka ji
/// pošle, teprve když si ji uživatel vyžádá z kalendáře v deníku
/// („nechci, aby trasa byla vidět hned, ale přes kalendář ano").
/// Prázdné pole ji smaže.
function vykresliStopuDne() {
  if (!mapa || !mapa.getStyle()) {
    clearTimeout(vykresliStopuDne._t);
    vykresliStopuDne._t = setTimeout(vykresliStopuDne, 250);
    return;
  }
  try {
    const gj = {
      type: 'FeatureCollection',
      features: stopaDne.length < 2 ? [] : [{
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: stopaDne },
      }],
    };
    const zdroj = mapa.getSource('okolnik-stopa-dne');
    if (zdroj) { zdroj.setData(gj); return; }
    mapa.addSource('okolnik-stopa-dne',
        { type: 'geojson', data: gj, maxzoom: 14 });
    mapa.addLayer({
      id: 'okolnik-stopa-dne-podklad', type: 'line',
      source: 'okolnik-stopa-dne',
      paint: { 'line-color': '#FFFFFF', 'line-width': 7,
               'line-opacity': 0.55 },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    }, prvniSymbolovaVrstva());
    mapa.addLayer({
      id: 'okolnik-stopa-dne-linka', type: 'line',
      source: 'okolnik-stopa-dne',
      paint: { 'line-color': '#3949AB', 'line-width': 3.6,
               'line-opacity': 0.95, 'line-dasharray': [2.2, 1.2] },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    }, prvniSymbolovaVrstva());
  } catch (e) {
    clearTimeout(vykresliStopuDne._t);
    vykresliStopuDne._t = setTimeout(vykresliStopuDne, 400);
  }
}

function vykresliVypravy() {
  // ⚠️ PRÁZDNÝ SEZNAM MUSÍ PROJÍT (6. 8. 2026): dřív se tu skončilo, takže
  // vypnutí filtru „Se záznamem" nechalo staré linky viset na mapě.
  if (!mapa) return;
  if (!mapa.getStyle()) {
    clearTimeout(vykresliVypravy._t);
    vykresliVypravy._t = setTimeout(vykresliVypravy, 250);
    return;
  }
  // ⚠️ NEČEKAT na isStyleLoaded(): pozastavený canvas zdroj mlhy ho
  // umí držet false donekonečna (zjištěno v demu – styl kreslil, ale
  // „loaded" nebyl). Přidání vrstev funguje po style.load.
  try {
    // ⚡ podpisová brána: počet tras + součet bodů (trasy se nemění,
    // jen přibývají/mizí celé)
    const podpis = posledniVypravy.length + '|'
        + posledniVypravy.reduce((s, t) => s + (t ? t.length : 0), 0);
    if (mapa.getSource('okolnik-vypravy')
        && podpis === vykresliVypravy._podpis) return;
    vykresliVypravy._podpis = podpis;
    const gj = {
      type: 'FeatureCollection',
      // trasa s jedním bodem je neplatné GeoJSON a MapLibre na to reaguje
      // TIŠE (celá vrstva zmizí) – proto se odfiltruje už tady
      features: posledniVypravy
        .filter((t) => t && t.length >= 2)
        .map((trasa) => ({
          type: 'Feature', properties: {},
          geometry: { type: 'LineString', coordinates: trasa },
        })),
    };
    const zdroj = mapa.getSource('okolnik-vypravy');
    if (zdroj) { zdroj.setData(gj); return; }
    mapa.addSource('okolnik-vypravy',
        { type: 'geojson', data: gj, maxzoom: 14 });
    // světlý podklad, ať je tuš čitelná na rytině i na barevné mapě
    mapa.addLayer({
      id: 'okolnik-vypravy-podklad', type: 'line', source: 'okolnik-vypravy',
      paint: { 'line-color': '#F4EBD3', 'line-width': 4.5,
               'line-opacity': 0.55 },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    }, prvniSymbolovaVrstva());
    mapa.addLayer({
      id: 'okolnik-vypravy-linka', type: 'line', source: 'okolnik-vypravy',
      paint: { 'line-color': '#6B4A2E', 'line-width': 2.2,
               'line-opacity': 0.9, 'line-dasharray': [2.2, 1.6] },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    }, prvniSymbolovaVrstva());
  } catch (e) {
    // výměna stylu zrovna běží – zkusit za chvíli znovu
    clearTimeout(vykresliVypravy._t);
    vykresliVypravy._t = setTimeout(vykresliVypravy, 400);
  }
}

// ⚠️ HILLSHADE SE PŘI 3D NESMÍ VYPÍNAT, i když to zní logicky:
// MapLibre terén sám vůbec NESVÍTÍ (ve specifikaci nejsou žádné
// vlastnosti osvětlení terénu), takže modelaci svahů dodává jedině
// hillshade — bez něj hory zplacatí do barevných ploch (10. 8.).
// Zkoušená úspora přes `hillshade-method: 'basic'` (v6) se navíc
// NEPOTVRDILA: první měření slibovalo +25 %, ale střídavá série
// 4× basic / 4× standard dala 38 vs 42 fps, tedy nic (rozptyl
// jednotlivých měření 33–51 fps je větší než hledaný rozdíl).
// Vizuálně jsou obě metody nerozlišitelné, takže kdyby se na
// slabším hardwaru přece jen projevila, stačí po style.load projít
// vrstvy typu 'hillshade' a zavolat na ně setPaintProperty
// ('hillshade-method', 'basic') v try/catch — v5 tu vlastnost nezná.

// Terén se zapíná JEN PŘI PLNÉM NÁKLONU kamery: kolmý i střední pohled
// (kde se nejvíc švihá) jede plnou rychlostí 2D — terénní průchod
// MapLibre stojí ~30 ms/snímek bez ohledu na rozlišení, zoom i výkon
// (změřeno na Dimensity 7300: 2D 60 fps, 3D při gestu 20–40; na PC
// „velké sekání" při 45°). Při plném náklonu, kde se mapa prohlíží
// pomalu, je 30 fps v pořádku. HYSTEREZE: jednou zvednuté hory drží,
// dokud se kamera nevrátí ke kolmici (<1°) — odebrání pod nakloněnou
// kamerou rozbíjí gesta (viz níž) a přepnutí probleskává popisky.
// 6. 8. 2026 sníženo 58 → 46: aplikace má nově stupně náklonu 0/30/52
// (uživatel: „těch 68° bych ještě snížil, je to stále moc a pak už se to
// dost seká"), takže při prahu 58 by se hory nezvedly UŽ NIKDY. Práh
// musí zůstat nad středním stupněm (30°), ať perspektiva bez terénu
// zůstane levná.
const PRAH_TEREN = 36;

// ⛔ ZRUŠENO (8. 8. 2026): pravidlo „sundej terén při změně zoomu o X“.
// Žádné X nebylo dobré — 0,35 dělalo blikání při dot’ukávání, 1,5 zase
// nechalo prvních 1,5 stupně oddálení běžet s terénem na ~16 fps.
// Ptá se to na špatnou věc: nejde o to, O KOLIK se zoom změnil, ale jestli
// uživatel VYJEL Z PÁSMA 3D+. Viz obsluha  výš./// Nechat hory puštěné bez ohledu na zoom (`OkolnikMost.drzTeren`).
/// ⛔ APPKA TO DNES NEPOUŽÍVÁ. Zkoušelo se to ve v1.288 („nech schválně
/// puštěný i terén pokud tak uživatel zvolí tlačítkem") a hned se ukázalo,
/// proč to nechceme: s terénem při zoumu 10–16 fps proti 44–52 bez něj,
/// takže se sekání vrátilo. Zůstává to tu jako jednořádkový vypínač,
/// kdyby někdo chtěl hory za každou cenu.
let drzetTeren = false;
/// Vynucené hlášení výřezu do appky (nastavuje se při stavbě mapy).
let vynutHlaseniVyrezu = null;
// Jak dlouho po odebrání terénu se čeká, než se vrátí plné popisky
// (a jak dlouho po zastavení se terén smí vrátit).
const POPISKY_ODLEZENI_MS = 1200;
// ⚠️ 1200, ne 600: při oddalování opakovanými štípnutími se mapa mezi nimi
// na chvíli zastaví, a s krátkou prodlevou se terén stihl vrátit a hned
// zase spadnout — každý návrat přitom zahodí celou drapovací keš
// (`releaseAllRTT`), tedy přesně ten stav 45–59 kreseb na snímek.
/// ⭐ 500 ms, ne 1200 (8. 8. 2026, třetí kolo). S 1200 se hory po ručním
/// přiblížení neobjevily prakticky nikdy: každé další štípnutí čekající
/// návrat zrušilo (`zoomstart`), takže se čekalo, až uživatel se zoomem
/// ÚPLNĚ skončí. Změřeno (scratchpad/preruseni.mjs, osm štípnutí nahoru
/// s pauzou 500 ms): náklon se překlopil na 42° už na z13,81, ale terén
/// nenaskočil ani jednou — až 1,2 s po posledním štípnutí.
/// Uživatel: *„když použiju tlačítko 3D+, tak k tomu dojde, ale pokud tam
/// dojedu manuálně, tak 3D+ nenaskakuje!"*
///
/// ⚠️ Je to vědomý obchod: kratší prodleva = hory chodí za prstem, ale
/// při rychlém doťukávání zoomu jednou probliknou. Delší prodleva =
/// neproblikne nic, ale hory se „nedostaví". Uživatel jednoznačně chce to
/// první — 3D+ má být vidět, když je přiblíženo.
/// ⭐ 250 ms (přání uživatele 8. 8.: „změnu načítej ještě dříve než 0,5 s,
/// třeba 0,25 s"). Krátká prodleva už nevadí, protože terén se od téhož
/// dne sundává JEN při vyjetí z pásma 3D+ (viz obsluha `zoom`) — dokud
/// jsi uvnitř pásma, není co vracet, takže se nemá co přepínat.
const TEREN_ZPET_MS = 250;
let vratPopiskyCas = null;
let vratTerenCas = null;
// Od kterého zoomu smí engine sám vrátit terén. Přepisuje appka přes
// `OkolnikMost.prahTerenu` hodnotou z `Mapa3dViewState.zoom3dPlus`, ať to
// není konstanta na dvou místech. Tohle je jen záloha pro engine bokem.
let prahZoomTerenu = 13.8;

// KOLIZE POPISKŮ NAD TERÉNEM ŽEROU HLAVNÍ VLÁKNO (změřeno 9. 8. na
// v6: 65° pan 54–62 fps s kolizemi vs. 122–140 fps bez nich — engine
// při náklonu přepočítává umístění symbolů proti výškám terénu).
// Při zvednutých horách proto: HUSTÝ BALAST (POI, názvy ulic, štíty,
// kóty vrstevnic…) schovat úplně a ŘÍDKÝM podstatným (sídla, vrcholy)
// vypnout kolize (allow-overlap + ignore-placement — pár prvků se
// smí výjimečně překrýt, výpočet zmizí). Návrat kolmice vše vrátí.
// Kaskáda kreseb, erby a dekorace už kolize nepoužívají (vlastní
// rozmisťování), těch se zásah nedotkne.
const BALAST_PRI_TERENU = /^(poi_|highway-|road_shield|road_one_way|airport$|waterway_.*label|water_name_|vrstevnice-koty)/;
let symbolyPuvod = null;   // id → {vis, tao, iao, tip, iip}; null = vráceno

function zjednodusSymbolyProTeren(zapnout) {
  if (!mapa.getStyle()) return;
  if (zapnout) {
    if (symbolyPuvod) return;                 // už zjednodušeno
    symbolyPuvod = new Map();
    for (const v of mapa.getStyle().layers) {
      // ⚠️ 6. 8. 2026: VYTAŽENÉ BUDOVY SE UŽ NESKRÝVAJÍ. Dřív se při
      // zapnutí terénu schovaly všechny `fill-extrusion` vrstvy – jenže
      // terén se zapíná právě na horním stupni náklonu, tedy přesně tam,
      // kde uživatel domy CHCE („ve 3D+ nevidím v neherním režimu
      // budovy"). MapLibre 6 je nad terénem umí položit správně.
      if (v.type === 'fill-extrusion') continue;
      if (v.type !== 'symbol') continue;
      const l = v.layout || {};
      symbolyPuvod.set(v.id, {
        vis: l.visibility || 'visible',
        tao: l['text-allow-overlap'] || false,
        iao: l['icon-allow-overlap'] || false,
        tip: l['text-ignore-placement'] || false,
        iip: l['icon-ignore-placement'] || false,
      });
      try {
        // ⭐⭐ BALAST SE SKRÝVÁ JEN V KRONICE (8. 8. 2026). Vzor zahrnuje
        // `poi_*`, štítky silnic a popisky vod — v herním stylu to nevadí,
        // protože místa dodává appka. V BĚŽNÝCH stylech (Základní, Letecká,
        // Turistická) tím ale ze 3D zmizel skoro všechen obsah a uživatel
        // to popsal jako *„ta mapa mi připadá nějaká taková prázdná"*.
        if (aktualniKod === 'herni' && BALAST_PRI_TERENU.test(v.id)) {
          mapa.setLayoutProperty(v.id, 'visibility', 'none');
        } else {
          mapa.setLayoutProperty(v.id, 'text-allow-overlap', true);
          mapa.setLayoutProperty(v.id, 'icon-allow-overlap', true);
          mapa.setLayoutProperty(v.id, 'text-ignore-placement', true);
          mapa.setLayoutProperty(v.id, 'icon-ignore-placement', true);
        }
      } catch (e) { /* vrstva mezitím zmizela */ }
    }
    return;
  }
  if (!symbolyPuvod) return;
  for (const [id, p] of symbolyPuvod) {
    if (!mapa.getLayer(id)) continue;         // styl se mezitím vyměnil
    try {
      mapa.setLayoutProperty(id, 'visibility', p.vis);
      if (p.tao === undefined) continue;      // fill-extrusion: jen vis
      mapa.setLayoutProperty(id, 'text-allow-overlap', p.tao);
      mapa.setLayoutProperty(id, 'icon-allow-overlap', p.iao);
      mapa.setLayoutProperty(id, 'text-ignore-placement', p.tip);
      mapa.setLayoutProperty(id, 'icon-ignore-placement', p.iip);
    } catch (e) { /* nevadí */ }
  }
  symbolyPuvod = null;
}

// PŘEDNAČTENÍ ŠPIČKY VÝŠKOVÉ PYRAMIDY (6. 8. 2026, „načítání 3D+ je dosti
// pomalé, nedalo by se přednačítat na pozadí?").
//
// Zjištění z knihovny: dokud neproběhne `setTerrain`, zdroj `teren` je
// ÚPLNĚ STUDENÝ – `TileManager.update` u nepoužívaného zdroje vrací prázdný
// seznam, takže se do té chvíle nestáhne ani jedna výšková dlaždice. Celá
// práce (síť → dekódování ve workeru → mesh → textury) tedy začne až po
// `pitchend`. MapLibre přitom ke každé cílové dlaždici sám přidává rodiče
// a předka na min(z, 5), takže stačí předtáhnout špičku pyramidy a terén
// má co ukázat OKAMŽITĚ; detail dotéká pod už zvednutou krajinou.
//
// Pro ČR je to na z5 JEDNA dlaždice, na z6 čtyři, na z7 dvanáct – dohromady
// ~17 dlaždic, jednotky set kB. Jde to jen přes sdílenou keš (viz výš);
// bez ní by se stažené bajty ke zdroji `teren` nedostaly.
const CR_ROZSAH = { zap: 12.09, vych: 18.86, jih: 48.55, sev: 51.06 };
let predtazeno = false;

function predtahniTeren() {
  if (predtazeno || !window.__okolnikDem) return;
  predtazeno = true;
  // na měřených datech se nepředtahuje (uživatel platí za každý bajt)
  try {
    if (navigator.connection && navigator.connection.saveData) return;
  } catch (e) { /* connection API není všude */ }
  const dlazdice = [];
  for (let z = 5; z <= 7; z++) {
    const n = Math.pow(2, z);
    const x0 = Math.floor((CR_ROZSAH.zap + 180) / 360 * n);
    const x1 = Math.floor((CR_ROZSAH.vych + 180) / 360 * n);
    const y = (lat) => {
      const r = lat * Math.PI / 180;
      return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r))
          / Math.PI) / 2 * n);
    };
    const y0 = y(CR_ROZSAH.sev);
    const y1 = y(CR_ROZSAH.jih);
    for (let x = x0; x <= x1; x++) {
      for (let yy = y0; yy <= y1; yy++) dlazdice.push([z, x, yy]);
    }
  }
  const odloz = window.requestIdleCallback
      || ((f) => setTimeout(f, 2000));
  odloz(() => {
    let hotovo = 0;
    for (const [z, x, yy] of dlazdice) {
      try {
        window.__okolnikDem.getDemTile(z, x, yy)
            .then(() => { hotovo++; })
            .catch(() => { /* dlaždice mimo archiv – nevadí */ });
      } catch (e) { /* starší build knihovny */ }
    }
    setTimeout(() => {
      console.log('[teren] přednačteno ' + hotovo + '/' + dlazdice.length
          + ' hrubých dlaždic');
    }, 8000);
  });
}

// ⭐ HRUBÝ PŘEDVOJ VEKTORU (v1.381, přání „ať se detaily dokreslují jako
// na jiných mapách"). MapLibre umí kreslit hrubého rodiče, než dorazí
// detail — ale jen když rodiče MÁ. Vektorová pyramida ČR z5–z8 (~70
// dlaždic, jednotky MB) se proto jednou zahřeje přes proxy; disková keš
// (gh-proxy od 8. 8.) ji pak drží napořád. Oddálení na přehled je hned
// ostré a cesta „oddálit → přesunout → přiblížit" kreslí hrubé → jemné
// místo šedé. Týž vzor jako `predtahniTeren` (ČR rozsah, saveData).
let predtazenVektor = false;

/// ⭐ v1.415: PŘEDEHŘÁTÍ OKOLÍ HRÁČE („uložit během načítání víc
/// věcí do keše“). Vektorové dlaždice z13–z16 a terén z11–z13
/// v okruhu ~1,6 km od hráče — přes gh-proxy jdou na DISK, příští
/// hraní v okolí už nejde na síť. Dávky po 4 + 150 ms; šetření dat
/// se ctí; jede jednou za relaci.
let predehratoOkoli = false;
function predtahniOkoli(lat, lng) {
  if (predehratoOkoli) return;
  predehratoOkoli = true;
  try {
    if (navigator.connection && navigator.connection.saveData) return;
    const ukoly = [];
    const pridej = (url, z, r) => {
      if (!url || !url.startsWith('pmtiles://')) return;
      const archiv = url.slice(10);
      const rad = Math.PI / 180;
      for (let zz = z[0]; zz <= z[1]; zz++) {
        const n = Math.pow(2, zz);
        const tx = Math.floor((lng + 180) / 360 * n);
        const ty = Math.floor((1 - Math.log(Math.tan(lat * rad)
            + 1 / Math.cos(lat * rad)) / Math.PI) / 2 * n);
        const metry = 40075016 * Math.cos(lat * rad) / n;
        const dosah = Math.max(1, Math.round(r / metry));
        for (let dx = -dosah; dx <= dosah; dx++) {
          for (let dy = -dosah; dy <= dosah; dy++) {
            ukoly.push([archiv, zz, tx + dx, ty + dy]);
          }
        }
      }
    };
    pridej(KONFIG.vektorUrl, [12, 16], 2400);
    pridej(KONFIG.terenUrl, [11, 13], 2400);
    if (!ukoly.length) return;
    const archivy = new Map();
    let i = 0;
    const krok = () => {
      const davka = ukoly.slice(i, i + 4);
      i += 4;
      for (const [archiv, z, x, y] of davka) {
        try {
          let a = archivy.get(archiv);
          if (!a) { a = new pmtiles.PMTiles(archiv); archivy.set(archiv, a); }
          a.getZxy(z, x, y).catch(() => {});
        } catch (e) { /* dlaždice mimo archiv — nevadí */ }
      }
      if (i < ukoly.length) setTimeout(krok, 150);
      else console.log('[předehřátí] okolí hráče:',
          ukoly.length, 'dlaždic požádáno');
    };
    setTimeout(krok, 500);
  } catch (e) { console.warn('[předehřátí]', e); }
}

function predtahniVektor() {
  if (predtazenVektor || !mapa) return;
  const zdroj = mapa.getSource('omt');
  const sablona = zdroj && zdroj.tiles && zdroj.tiles[0];
  if (!sablona) return;                                // Liberty aj. bez omt
  // ⚠️ vektor jede z PMTILES ARCHIVU (range požadavky) — obyčejný fetch
  // dlaždic neexistuje. Vlastní instance PMTiles nad týmž URL dělá TYTÉŽ
  // range dotazy jako MapLibre → zahřejou proxy i prohlížečovou keš.
  let archivUrl = null;
  if (/^pmtiles:\/\//.test(sablona)) {
    archivUrl = sablona.slice('pmtiles://'.length)
        .replace(/\/\{z\}\/\{x\}\/\{y\}.*$/, '');
  }
  const primaSablona = /^https?:/.test(sablona) ? sablona : null;
  if (!archivUrl && !primaSablona) return;
  if (archivUrl && typeof pmtiles === 'undefined') return;
  predtazenVektor = true;
  try {
    if (navigator.connection && navigator.connection.saveData) return;
  } catch (e) { /* connection API není všude */ }
  const dlazdice = [];
  for (let z = 5; z <= 8; z++) {
    const n = Math.pow(2, z);
    const x0 = Math.floor((CR_ROZSAH.zap + 180) / 360 * n);
    const x1 = Math.floor((CR_ROZSAH.vych + 180) / 360 * n);
    const y = (lat) => {
      const r = lat * Math.PI / 180;
      return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r))
          / Math.PI) / 2 * n);
    };
    const y0 = y(CR_ROZSAH.sev);
    const y1 = y(CR_ROZSAH.jih);
    for (let x = x0; x <= x1; x++) {
      for (let yy = y0; yy <= y1; yy++) dlazdice.push([z, x, yy]);
    }
  }
  const odloz = window.requestIdleCallback || ((f) => setTimeout(f, 2500));
  odloz(async () => {
    let hotovo = 0;
    const archiv = archivUrl ? new pmtiles.PMTiles(archivUrl) : null;
    const dotahni = ([z, x, yy]) => archiv
        ? archiv.getZxy(z, x, yy)
            .then((v) => { if (v && v.data) hotovo++; })
            .catch(() => { /* mimo archiv – nevadí */ })
        : fetch(primaSablona.replace('{z}', z).replace('{x}', x)
              .replace('{y}', yy))
            .then((o) => { if (o.ok) hotovo++; })
            .catch(() => { /* mimo archiv – nevadí */ });
    // po čtyřech a s oddechem — předvoj nikdy nesmí konkurovat startu
    for (let i = 0; i < dlazdice.length; i += 4) {
      await Promise.all(dlazdice.slice(i, i + 4).map(dotahni));
      await new Promise((r) => setTimeout(r, 120));
    }
    console.log('[predvoj] vektor ČR z5–8: ' + hotovo + '/'
        + dlazdice.length + ' dlaždic zahřáto');
  });
}

// PŘEDNAČTENÍ CÍLOVÉHO VÝŘEZU během 700 ms animace náklonu. Most o
// přechodu do 3D+ ví dřív než `pitchend`, kde teprve běží `nastavTeren` –
// tahle mezera se dá strávit sítí místo čekáním.
//
// ⚠️ Terén si bere dlaždice o JEDEN ZOOM HRUBŠÍ než stínování: přepíná
// zdroji `tileSize` na 512 (deltaZoom = 1). A okraje výškové sítě se
// dopočítávají ze sousedů (`backfillDEM`), takže se přidává jeden prstenec
// navíc – bez něj by na krajích zůstaly švy.
let vyrezMs = 0;

function predtahniVyrez() {
  const dem = window.__okolnikDem;
  if (!dem) return;
  const ted = Date.now();
  if (ted - vyrezMs < 3000) return;     // netahat na každé ťuknutí
  vyrezMs = ted;
  try {
    if (navigator.connection && navigator.connection.saveData) return;
  } catch (e) { /* connection API není všude */ }
  try {
    const strop = KONFIG.terenSdilenyStrop || 13;
    const z = Math.max(5, Math.min(strop, Math.floor(mapa.getZoom()) - 1));
    const b = mapa.getBounds();
    const n = Math.pow(2, z);
    const xy = (lng, lat) => {
      const r = lat * Math.PI / 180;
      return [
        Math.floor((lng + 180) / 360 * n),
        Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI)
            / 2 * n),
      ];
    };
    const [x0, y0] = xy(b.getWest(), b.getNorth());
    const [x1, y1] = xy(b.getEast(), b.getSouth());
    let kusu = 0;
    for (let x = x0 - 1; x <= x1 + 1 && kusu < 64; x++) {
      for (let y = y0 - 1; y <= y1 + 1 && kusu < 64; y++) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        kusu++;
        try {
          dem.getDemTile(z, x, y).catch(() => {});
        } catch (e) { /* starší build knihovny */ }
      }
    }
    console.log('[teren] výřez z' + z + ': předtaženo ' + kusu + ' dlaždic');
  } catch (e) {
    console.warn('[teren] předtažení výřezu:', e);
  }
}

// ⛔ VRSTEVNICE: ROZPORUPLNE MERENI, NEPOUZIVA SE (6. 8. 2026).
//
// Ablace vrstev hernniho stylu (z14, teren, jedna skupina skryta) rekla, ze
// vrstevnice stoji vic nez vsechny ostatni vlastni vrstvy dohromady:
//   vychozi 37 fps / 8,2 dlouhych snimku, BEZ VRSTEVNIC 45 / 5,8,
//   bez ilustraci 42, bez dekoraci 41, bez mlhy 40, bez erbu 38,
//   bez vseho ostatniho 44 (tedy min nez bez samotnych vrstevnic).
// JENZE poctive A/B po zahrati (tri zahrivaci prujezdy, stridave
// vypnuto/zapnuto, dvakrat) rteklo PRESNY OPAK:
//   vypnute 22 a 25 fps, zapnute 29 a 34 fps.
// Obe mereni jsou necim zkreslena (prvni poradim konfiguraci, druhe
// postupnym zahrivanim: 22, 29, 25, 34 roste bez ohledu na stav), takze
// se navzajem ruzi. Funkce proto ZUSTAVA, ale NEVOLA SE - nechci menit
// vzhled kvuli zisku, ktery se neda zopakovat.
//
// Az se to bude resit znovu: potreba mereni odolne vuci poradi (stridat
// B,A,B,A i A,B,A,B a prumerovat), protoze rozptyl na tomhle telefonu je
// vetsi nez hledany rozdil.
// ⭐⭐⭐ PAMĚŤ NA VÝŠKOVÉ MEZE DLAŽDIC (10. 8. 2026 — největší jednotlivý
// nález v honu na sekání „trvale zapnutého 3D").
//
// CO SE NAŠLO. Profil skutečného štípnutí (141 snímků, z13,5, náklon 42°)
// ukázal na prvním místě `Terrain.getMinMaxElevation`: **65 737 volání,
// 900–1188 ms**, tedy 6,4–9,5 ms NA KAŽDÝ SNÍMEK. To je zhruba třetina
// celého času gesta. Uvnitř toho sedí `getSourceTile` (70 tis. volání)
// a `findTileInCaches` (250–385 tis. volání).
//
// KDO TO VOLÁ (zásobník volání, vzorkovaný): `getTileBoundingVolume`
// ← `coveringTiles` ← `TileManager.update` ← `Style._updateSources`.
// Tedy: se zapnutým terénem si MapLibre pro KAŽDÝ ZDROJ STYLU a každou
// kandidátní dlaždici zjišťuje výškové meze — a styl má zdrojů ~19,
// všechny nad TOUŽ dlaždicovou mřížkou. Táž odpověď se tedy počítá
// devatenáctkrát za snímek. Bez terénu se to neděje vůbec (proto se
// „bez terénu" měřilo tak dobře).
//
// OPRAVA. Paměť na JEDEN SNÍMEK, klíč = `tileID.key`, mazaná na začátku
// každého `painter.render`. Uvnitř snímku se DEM dlaždice změnit nemůže
// (JS je jednovláknové a data dochodí mezi snímky), takže je to přesně
// tatáž odpověď — jen spočítaná jednou místo devatenáctkrát. Trefovost
// paměti vychází ~90 %.
//
// ZMĚŘENO (A,B,B,A, skutečná dvouprstá gesta, terén vynucený, z13,5):
//   | oddálení    | bez paměti **32,0** dlouhých snímků | s pamětí **17,5** |
//   |             | nejhorší snímek 125 ms              | 50 ms             |
//   | přiblížení  | 13,0                                 | 12,5 (v rozptylu) |
// Jednotlivé vzorky se nepřekrývají: bez paměti [33, 31], s pamětí [19, 16].
//
// ⚠️ Kopie výsledku je nutná — volající si objekt nesmí přepsat pod rukama.
// ⚠️ Prototyp jde získat jen z instance, proto se to nasazuje až po
//    prvním úspěšném `setTerrain`.
/// ⭐⭐⭐ PLYNULÉ PŘEBÍRÁNÍ VÝŠKY STŘEDU = KONEC ODSKOKU (11. 8. 2026,
/// SEDMÁ a konečně fungující architektura; prototypováno ŽIVĚ přes CDP
/// na zařízení, bez buildu — teprve po ověření zapsáno sem).
///
/// MECHANIKA ODSKOKU (doměřeno vzorkováním `transform.elevation` na
/// telefonu): výška středu se s výchozím clampingem lepí na terén
/// v render smyčce — jenže `elevationFreeze` zůstává po každém easeTo
/// TRVALE zapnutý a klapku otevře až SKUTEČNÉ gesto prstů (proto se
/// odskok nikdy nereprodukoval adb ťuky a uživateli skákal pořád).
/// Po gestu navíc přepočet často proběhne dřív, než dosednou jemnější
/// DEM dlaždice (výška spadne na 0), a v klidu se snímky nekreslí,
/// takže se výška neadoptuje — a SKOČÍ s prvními snímky PŘÍŠTÍHO
/// gesta. Odtud „odskakuje pořád, o ~90–300 m, hlavně po zoomu".
///
/// OPRAVA: obal `setElevation` na prototypu transformace (týž vzor
/// jako `nasadPametVysek` níž, roky ověřený). Velká změna výšky se
/// nepropustí naráz, ale po 12 % za snímek (~0,4 s klouzání);
/// `triggerRepaint` drží snímky v běhu, dokud výška nedokonverguje —
/// i na stojící mapě. ŽÁDNÉ události, žádné jumpTo/easeTo, žádný
/// zásah do kamery — jen tlumení hodnoty v setteru. Malé změny
/// (≤ 4 m, běžné interpolace animací) jdou beze změny.
///
/// ⚠️ Omezovat JEN se zapnutým terénem: `setTerrain(null)` nuluje
/// výšku jediným voláním a bez terénu už render smyčka setter nevolá —
/// škrcení by výšku nechalo viset v půlce (past z v1.355).
/// Ověřeno na zařízení: 0 → 278 m doklouzalo bez skoku, fling
/// 278 → 293 m plynule, žádné chyby, gesta netknutá.
/// ⭐⭐⭐ PŘEVZETÍ VÝŠKY BEZ POHYBU OBRAZU (11. 8. 2026 v noci — finální
/// tvar druhé půlky opravy; verze „jen odemknout" byla mezikrok
/// a uživatel ji právem reklamoval: klouzání kamery bylo VIDĚT, „stále
/// drcá").
///
/// MapLibre 6.1 nastaví `elevationFreeze = true` na začátku KAŽDÉ
/// animace s terénem a zpět ho vrací jen konec SKUTEČNÉHO gesta prstů.
/// Zamčená klapka → výška středu se rozejde s terénem o stovky metrů →
/// konec příštího gesta s tím rozchodem udělá divoký raycast (kamera
/// „poskočí", zoom uletěl 17 → 11,87 v jednom snímku — změřeno).
/// Ale ODEMČENÁ klapka má opačný problém: render smyčka lepí výšku
/// každý snímek a kamera se při dosedání DEM viditelně hýbe.
///
/// Řešení dělá obojí najednou: klapku držíme trvale ZAMČENOU (mezi
/// gesty se kamera sama nehne NIKDY) a výšku přebíráme v klidu na
/// `moveend` přepočtem `recalculateZoomAndCenter` — tím, kterým to
/// dělá nativní konec gesta. Ten DRŽÍ KAMERU NA MÍSTĚ (mění střed,
/// zoom i výšku najednou tak, aby se obraz nepohnul) a je čistě
/// pasivní: žádné události, žádný stop(), helper končí, když se výška
/// nezměnila. Časté volání (moveend chodí i po kompasových easeTo)
/// je tedy zadarmo a drží rozchod malý — přesně to brání i divokým
/// raycastům na koncích gest.
/// ⚠️ Volat JEN v klidu: během gesta pracuje kamera nad klonem
/// `_requestedCameraState` a přímý zápis by se ztratil. Klon maže
/// kamera vlastním posluchačem `moveend` registrovaným v konstruktoru,
/// tedy DŘÍV, než běží tenhle — pořadí sedí.
/// ⭐⭐⭐ JEN ODEMKNOUT KLAPKU — NIC VÍC (12. 8. 2026, PO REGRESI
/// „ZMIZELÁ MAPA"). Předchozí verze (glide + trvale zamčená klapka +
/// recalc + spolknutí velkého skoku) se sama se sebou prala:
/// klapka zůstala trvale ZAMČENÁ, `setElevation` ze `setTerrain` se
/// spolkl, výška středu uvázla na 0 se zapnutým terénem → kamera pod
/// povrchem → PRÁZDNÝ PERGAMEN. Změřeno CDP: `t1 e0` po 5 s v z17/p42.
///
/// Náprava = důvěřovat MapLibre. Klapka `elevationFreeze` se má po
/// KAŽDÉM dojetém pohybu vrátit do `false` — přesně to dělá nativní
/// konec gesta, jen se to u nás nedělo po `easeTo` (kompas, přelet).
/// Odemčená klapka nechá render smyčku výšku dorovnat sama, plynule
/// a SPRÁVNĚ (setTerrain i render nastaví plnou výšku, nic je nespolkne).
/// Holý zápis příznaku — žádné události, žádný recalc, žádný zásah do
/// kamery. Odskok při zapnutí terénu se tím vrací (nativní ~výška×tan),
/// ale MAPA ŽIJE; odskok patří do desktop dema (viz sarcher-naklon-krade-gesto).
/// ⭐⭐ v1.511: ČITELNÉ CESTY A BUDOVY V NOCI.
///
/// Výtka: *„noční mapa v herním režimu má málo výrazné cesty a silnice,
/// není moc poznat co je co"* + *„budovy by mohly být také výraznější"*.
///
/// PROČ to tak dopadlo (spočteno z barev, žádný odhad): `noc-prekryv`
/// je poslední DRAPOVANÁ vrstva, takže překrývá všechno pod sebou
/// včetně cest, silnic i budov. Při plné noci (krytí 0,78, barva
/// #081226) platí `výsledek = 0,22 × zdroj + 0,78 × tma`, čili se
/// všechno slehne do úzkého pásma kolem 50–70:
///
///   tráva #96BE78 (jas 172) → **54**
///   silnice #B49B72 (jas 155) → **50**   ← TMAVŠÍ NEŽ TRÁVA
///   budova #DCC9A5 (jas 202) → **60**
///
/// Silnice tedy v noci není „málo výrazná", ona je doslova tmavší než
/// louka kolem — proto se ztrácí úplně. ⚠️ Dekorace (stromy) přitom
/// zůstávají jasné, protože jsou to SYMBOLY nad překryvem; odtud dojem,
/// že v noci vidím jen stromy.
///
/// Řešení = v noci přebarvit samotné čáry a výplně směrem k měsíční
/// bílé. Bílá (255) dá po překryvu 72 proti trávě 54, tedy rozdíl +18
/// místo dnešních −4.
///
/// ⛔ CO NEJDE: přesunout cesty NAD překryv (`moveLayer`). Byly by
/// zároveň nad MLHOU, takže by prozrazovaly neobjevený svět — a navíc
/// vše vložené za první nedrapovanou vrstvu zakládá druhý RTT stack
/// (viz paměť „slučování vrstev je slepá ulička").
/// ⛔ A NEJDE ani zeslabit překryv — uživatel si tmu výslovně přál
/// (*„ve 22:00 může být větší tma"*).
///
/// Původní hodnoty se čtou ze stylu při prvním použití a při kroku 0 se
/// vrací zpátky, takže se nemůže stát, že noční barvy zůstanou přes den.
/// ⚠️ Přechody se explicitně vypínají — poučení ze zamrzlého
/// `fill-opacity-transition` (12. 8., čtyři buildy).
const NOCNI_KRESBA = [
  // [vrstva, vlastnost, hodnoty pro krok 0..3]  (krok 0 = den)
  ['cesty', 'line-color', ['#6B5636', '#8A7350', '#C2B091', '#E8DCC4']],
  // ⚠️ ŠÍŘKA MUSÍ ZŮSTAT VÝRAZEM. Do v1.537 tu byla čtyři čísla,
  // která v noci **přepsala zoomovou křivku ze stylu** na konstantu —
  // cesty se po setmění přestaly s přibližováním rozšiřovat.
  ['cesty', 'line-width', [
    ['interpolate', ['exponential', 1.4], ['zoom'], 12, 1.2, 17, 3.4],
    ['interpolate', ['exponential', 1.4], ['zoom'], 12, 1.3, 17, 3.6],
    ['interpolate', ['exponential', 1.4], ['zoom'], 12, 1.5, 17, 4.0],
    ['interpolate', ['exponential', 1.4], ['zoom'], 12, 1.7, 17, 4.4]]],
  ['silnice-servisni', 'line-color',
   ['#A98F63', '#C4AE87', '#DFD1B2', '#F3ECDA']],
  ['silnice-mistni', 'line-color',
   ['#8C6C39', '#B39C6A', '#D9CBA6', '#F2EAD6']],
  ['silnice-hlavni', 'line-color',
   ['#B0670F', '#CE8532', '#EBB768', '#FFDDA0']],
  ['silnice-hlavni', 'line-opacity', [0.85, 0.9, 0.95, 1]],
  ['budovy-vypln', 'fill-color',
   ['#DCC9A5', '#E6D6B9', '#F1E6D0', '#F9F3E6']],
  ['budovy-vypln', 'fill-opacity', [0.8, 0.84, 0.88, 0.92]],
  // obrys budov je nad mlhou; v noci musí nást dřív a být světlejší,
  // jinak se tmavá tuš v tmavé krajině ztratí (a při z14 je stejně
  // ještě skoro průhledná — náběh končí až na z15,2)
  ['ink-budovy', 'line-color', ['#5A4632', '#6B573F', '#96805F', '#C6B396']],
  ['ink-silnice', 'line-color', ['#6E5236', '#8A6B49', '#B79776', '#D8BE9C']],
  ['ink-silnice', 'line-opacity', [0.75, 0.8, 0.85, 0.92]],
  // ⚠️ KOLEJ SE V NOCI OBRACÍ. Ve dne je tmavá kolej se světlými
  // pražci; v noci je podklad tmavý, takže tmavá kolej zmizí — musí
  // zesvětlat, a pražce naopak ztmavnout, jinak splynou s kolejí.
  ['ink-zeleznice', 'line-color', ['#5A4632', '#7A6247', '#A89073', '#D2BE9E']],
  ['ink-zeleznice-prahy', 'line-color',
   ['#F4EBD8', '#EADFC8', '#8A7358', '#5E4C36']],
];

/// Původní (denní) hodnoty přečtené ze stylu — klíč "vrstva|vlastnost".
/// Maže se při výměně stylu spolu s `krokNoci`.
let puvodniKresba = null;

function nastavNocniKresbu(krok) {
  if (!mapa) return;
  if (!puvodniKresba) puvodniKresba = {};
  for (const [vrstva, vlastnost, hodnoty] of NOCNI_KRESBA) {
    if (!mapa.getLayer(vrstva)) continue;
    const klic = vrstva + '|' + vlastnost;
    try {
      if (!(klic in puvodniKresba)) {
        puvodniKresba[klic] = mapa.getPaintProperty(vrstva, vlastnost);
      }
      mapa.setPaintProperty(vrstva, vlastnost + '-transition', { duration: 0 });
      mapa.setPaintProperty(vrstva, vlastnost,
          krok <= 0 ? puvodniKresba[klic] : hodnoty[krok]);
    } catch (e) { /* styl se zrovna mění */ }
  }
}

/// ⭐ NOČNÍ REŽIM MAPY (v1.384, „ať je noční mapa opravdu jako v noci
/// a vesničky světélkují"). Krok 0–3 dává Pocasi.stavNoci() (čas +
/// počasí, odstupňovaně). Jen herní styl. Zásah POUZE při změně kroku:
/// ztmavovací překryv (fill s přechodem 1,5 s, drapuje se pod dekorace
/// a mlhu — popisky zůstávají čitelné) + viditelnost světel sídel
/// (`dekorace-svetla` z dekorace.js; ve dne visibility none = nulová
/// cena) + ztlumení dekorací v noci. ŽÁDNÁ kamera, jen paint/visibility.
/// Test: `window.__vynutKrokNoci = 0..3` (další tik do minuty, nebo
/// zavolat aplikujNoc() ručně).
let krokNoci = -1;

function aplikujNoc() {
  try {
    // v1.592: noc běží i v Dobyvateli (styl s příznakem `noc`) —
    // „přidej to i do Dobyvatele a uvidíme, kdyžtak dáme pryč"
    if (!mapa || !STYLY[aktualniKod]
        || !(STYLY[aktualniKod].mlha || STYLY[aktualniKod].noc)) return;
    if (typeof Pocasi === 'undefined' || !Pocasi.stavNoci) return;
    const krok = Pocasi.stavNoci();
    const svetla = mapa.getLayer('dekorace-svetla');
    const svChce = krok >= 2 ? 'visible' : 'none';
    const svMa = svetla
        ? (mapa.getLayoutProperty('dekorace-svetla', 'visibility')
           || 'visible')
        : svChce;
    if (krok === krokNoci && svMa === svChce) return;
    if (!mapa.getSource('noc-zdroj')) {
      // maxzoom 14: kruh 12 m = ~20 jednotek dlazdice z14 - presnost
      // staci a diry se nad z14 uz neprerezavaji (v1.401)
      mapa.addSource('noc-zdroj', { type: 'geojson', maxzoom: 14, data: {
        type: 'Feature', properties: {},
        geometry: { type: 'Polygon',
                    coordinates: [[[-30, 20], [40, 20], [40, 70],
                                   [-30, 70], [-30, 20]]] },
      } });
    }
    // „mapa klidně více tmavá" (12. 8.) — noc až 0,7
    // v1.396: plná noc tmavší (přání „ve 22:00 může být větší tma“)
    // ⭐ v1.424: díry/polostín/kaluže ODSTRANĚNY („vypadá to naprd“)
    // — tma je zase JEDNA vrstva, světla vesnic jen bodové záře oken
    const TMA = [0, 0.22, 0.45, 0.78];
    if (!mapa.getLayer('noc-prekryv')) {
      // kotva jako dekorace: první nedrapovaná vrstva → překryv je
      // poslední v drapovaném bloku (ztmaví svět, nerozřízne stack)
      const vrstvy = mapa.getStyle().layers;
      const drapuje = { background: 1, fill: 1, line: 1, raster: 1,
                        hillshade: 1, 'color-relief': 1 };
      let kotva = null;
      for (const v of vrstvy) { if (!drapuje[v.type]) { kotva = v; break; } }
      // ⛔⛔ PAST (změřeno 12. 8., ČTYŘI kola): `fill-opacity-transition`
      // na téhle vrstvě v tomhle buildu ZAMRZÁ — přechodovaná změna se
      // zasekne na startovní hodnotě (getPaintProperty hlásí cíl,
      // kreslí se stará), ať je přechod v definici, nebo doplněný
      // později. Odblokovávaly ji jen opakované ODLIŠNÉ zápisy.
      // PŘECHOD SE PROTO NEPOUŽÍVÁ VŮBEC — kroky jsou malé (0,2)
      // a mění se zřídka, skok okem prakticky nezachytitelný.
      mapa.addLayer({
        id: 'noc-prekryv', type: 'fill', source: 'noc-zdroj',
        paint: { 'fill-color': '#081226', 'fill-opacity': TMA[krok] },
      }, kotva ? kotva.id : undefined);
    } else {
      // ⛔ ZAMRZLÝ PŘECHOD (v1.592, tatáž past jako u mlhy 12. 8.):
      // po přesunu vrstvy moveLayerem se změna fill-opacity kreslila
      // STAROU hodnotou (property přitom hlásila cíl). Nulový přechod
      // + mezizápis odlišné hodnoty ji spolehlivě odblokují
      // (ověřeno na zařízení 1. 9.).
      mapa.setPaintProperty('noc-prekryv', 'fill-opacity-transition',
          { duration: 0 });
      mapa.setPaintProperty('noc-prekryv', 'fill-opacity',
          Math.min(1, TMA[krok] + 0.011));
      mapa.setPaintProperty('noc-prekryv', 'fill-opacity', TMA[krok]);
      // v1.599.1 (bezztrátová úspora): ve dne je tma průhledná, ale
      // celoplošná výplň se přesto kreslila — schovat ji úplně
      mapa.setLayoutProperty('noc-prekryv', 'visibility',
          krok === 0 ? 'none' : 'visible');
    }
    // ⭐ v1.592 POŘADÍ V DOBYVATELI: silnice a kóty jsou tam AŽ ZA
    // symboly, takže kotva „první nedrapovaná" nechá tmu pod nimi.
    // Tma patří nad celý podklad, ale POD území, plán a odznaky —
    // a světla oken s lucernou hráče nad tmu. moveLayer je levný
    // a idempotentní (jednou za minutu).
    if (STYLY[aktualniKod].noc && mapa.getLayer('dob-uzemi')) {
      try {
        mapa.moveLayer('noc-prekryv', 'dob-uzemi');
        if (mapa.getLayer('dekorace-svetla')) {
          mapa.moveLayer('dekorace-svetla', 'dob-uzemi');
        }
        if (mapa.getLayer('hrac-zare')) {
          mapa.moveLayer('hrac-zare', 'dob-uzemi');
        }
      } catch (ePresun) { /* vrstvy se zrovna přestavují */ }
    }
    if (svetla) {
      mapa.setLayoutProperty('dekorace-svetla', 'visibility', svChce);
    }
    // ⭐ v1.385: vlajky pro animátor mihotání (dekorace.js) + světlušky
    // jen za letních nocí (měsíce 6–8; test: window.__vynutLeto = true)
    window.__svetlaAktivni = krok >= 2;
    // ⭐ v1.422: denní hmyz létá za dne I ZA ŠERA (krok ≤ 1) — výtka
    // „teď je nevidím, asi už nelítají“ přišla za šera, kdy je automat
    // správně vypínal; až od soumraku je střídají světlušky.
    window.__hmyzDenniAktivni = krok <= 1;
    // test: window.__vynutMesic = 1..12 vynutí roční dobu roje
    const mesic = window.__vynutMesic || (new Date().getMonth() + 1);
    const leto = window.__vynutLeto === true || (mesic >= 6 && mesic <= 8);
    window.__svetluskyAktivni = krok >= 2 && leto;
    // ⭐ PODZIM (v1.592, „co lítá v září?"): po světluškách nastupují
    // MŮRY u rozsvícených oken a NETOPÝŘI (září–listopad, od šera);
    // ve dne BABÍ LÉTO (září–říjen) a PADAJÍCÍ LISTÍ (říjen–listopad)
    const podzim = mesic >= 9 && mesic <= 11;
    window.__muryAktivni = krok >= 2 && podzim;
    window.__babiLetoAktivni = krok <= 1 && (mesic === 9 || mesic === 10);
    window.__listiAktivni = krok <= 1 && (mesic === 10 || mesic === 11);
    // ⭐ ZIMA (v1.593): v prosinci–únoru včely spí a ve dne se snáší
    // ojedinělé vločky (nezávisle na počasí — sněžení má modul Počasí)
    window.__vlockyAktivni = krok <= 1
        && (mesic === 12 || mesic === 1 || mesic === 2);
    for (const vr of ['dekorace-svetlusky', 'dekorace-svetlusky-halo']) {
      if (mapa.getLayer(vr)) {
        mapa.setLayoutProperty(vr, 'visibility',
            window.__svetluskyAktivni ? 'visible' : 'none');
      }
    }
    // ⭐ v1.398: lucerna postavy — svítí už od šera (krok >= 1),
    // se tmou sílí; přes den zhasnutá (visibility = nulová cena)
    if (mapa.getLayer('hrac-zare')) {
      mapa.setLayoutProperty('hrac-zare', 'visibility',
          krok >= 1 ? 'visible' : 'none');
      if (krok >= 1) {
        mapa.setPaintProperty('hrac-zare', 'icon-opacity',
            [0, 0.5, 0.8, 1.0][krok]);
      }
    }
    // ⭐ v1.399: MLHA MUSÍ TAKY DO TMY („místy prosvítá světlá mapa
    // jako ve dne“) — pergamen neobjeveného světa je SVĚTLEJŠÍ než
    // objevená krajina a jednotný překryv na něj nestačí. Rytina se
    // tlumí přes raster-brightness-max, plochý pergamen barvou.
    // ⚠️ přechody explicitně vypnout — poučení ze zamrzlého
    // fill-opacity-transition (12. 8., čtyři buildy).
    const JAS_MLHY = [1, 0.82, 0.62, 0.45];
    const BARVA_PERGAMENU = ['#C8C6C3', '#A5A4A1', '#7D7C7A', '#5B5B5A'];
    if (mapa.getLayer('mlha-rytina')) {
      mapa.setPaintProperty('mlha-rytina',
          'raster-brightness-max-transition', { duration: 0 });
      mapa.setPaintProperty('mlha-rytina',
          'raster-brightness-max', JAS_MLHY[krok]);
    }
    if (mapa.getLayer('mlha-pergamen')) {
      mapa.setPaintProperty('mlha-pergamen',
          'fill-color-transition', { duration: 0 });
      mapa.setPaintProperty('mlha-pergamen',
          'fill-color', BARVA_PERGAMENU[krok]);
    }
    // ⭐ v1.424–425: POZADÍ STYLU do soumraku — při rychlém odzoomu
    // prosvítá tam, kam drape nedosáhl (záblesk #F1E4BE, jas 59→76).
    // ⚠️ POZOR NA DVOJÍ TMU (chyba v1.424 „tmavší části“): pozadí
    // prosvítá i MEZI polygony krajiny (holá zem, břehy, okraje polí)
    // a tam ho JEŠTĚ ztmavuje noc-prekryv — plná noční barva se
    // sčítala do téměř černé (#131C2D místo #3B4047). Kompromis:
    // jen jemný soumračný pergamen — mezery v krajině zůstanou
    // takřka původní (Δ≤16) a záblesk ztratí ~40 % kontrastu.
    if (mapa.getLayer('pozadi')) {
      mapa.setPaintProperty('pozadi',
          'background-color-transition', { duration: 0 });
      // v1.592: denní pozadí Dobyvatele je jeho vlastní (#f2efe6) —
      // herní pergamen by mu přes den žloutil podklad
      const denniPozadi = STYLY[aktualniKod].noc ? '#f2efe6'
                                                 : '#F1E4BE';
      mapa.setPaintProperty('pozadi', 'background-color',
          [denniPozadi, '#E2D5AF', '#C9BC98', '#A79E85'][krok]);
    }
    // ⭐ v1.425: dekorace v noci ztlumit („škoda že stromy nejsou
    // v noci tmavší, bijí do očí“) — násobek rampy rození, viz
    // __ztlumDekorace v dekorace.js
    if (window.__ztlumDekorace) {
      window.__ztlumDekorace([1, 0.92, 0.84, 0.72][krok]);
    }
    nastavNocniKresbu(krok);   // ⭐ v1.511: cesty a budovy čitelné i v noci
    prestavNocniDiry();
    // ⚠️ opacity stromů NEsahat — nese náběhovou rampu z `nastup()`
    // (setPaintProperty by ji přepsal konstantou a rozbil rození)
    // ⚠️ opacity světel NEsahat setPaintProperty — nese výraz
    // s feature-state pro mihotání
    krokNoci = krok;
    // v1.599: v Dobyvateli v noci září vlajky (místo světel a hmyzu)
    if (typeof Dobyvatel !== 'undefined' && Dobyvatel.noc) Dobyvatel.noc(krok);
    console.log('[noc] krok ' + krok);
  } catch (e) { console.warn('[noc]', e); }
}
setInterval(aplikujNoc, 60000);

// ⭐ v1.424: DÍRY V NOČNÍM PŘEKRYVU ODSTRANĚNY („osvětlení kolem
// hráče a světel domů dej pryč, vypadá to naprd“). Tma je zase celý
// polygon bez děr (data nastavená při založení zdroje se nemění);
// z celého systému zbývá jen bodová záře oken (dekorace-svetla)
// a decentní halo hráče (hrac-zare). Pahýly drží kontrakt pobídek
// z dekorací a obnovHracSvetlo — volající se nemusely přepisovat.
// Bonus: žádné setData na drapované vrstvě = méně přestaveb drape.
function prestavNocniDiry() { /* záměrně prázdné (v1.424) */ }
window.__nocniDiry = () => { /* záměrně prázdné (v1.424) */ };

// ⭐ v1.398: POSTAVA V NOCI OSVĚTLUJE OKOLÍ (přání 13. 8.). Malý
// vlastní zdroj s jedním bodem + pečená záře (sprite od dekorací,
// `svetlo-zare-0`), větší než světla chalup — lucerna poutníka.
// Viditelnost řídí aplikujNoc (krok >= 1), síla roste se tmou.
// setData na jednom bodu je zadarmo.
function obnovHracSvetlo(lng, lat) {
  try {
    if (!mapa || !mapa.getStyle || !mapa.getStyle()) return;
    const zdroj = mapa.getSource('hrac-svetlo');
    if (!zdroj) {
      if (!mapa.hasImage || !mapa.hasImage('svetlo-zare-0')) return;
      mapa.addSource('hrac-svetlo', { type: 'geojson', maxzoom: 10,
        data: { type: 'FeatureCollection', features: [] } });
      mapa.addLayer({
        id: 'hrac-zare', type: 'symbol', source: 'hrac-svetlo',
        minzoom: 11.5,
        layout: {
          'icon-image': 'svetlo-zare-0',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          visibility: 'none',
          // v1.424: z lucerny „osvětlující okolí“ (2,6/3,8) zpět na
          // DECENTNÍ halo — „hráče trochu zvýrazni, ať je vidět“
          'icon-size': ['interpolate', ['exponential', 1.6], ['zoom'],
                        12.6, 0.8, 15.4, 1.5, 17.6, 2.1],
        },
        paint: { 'icon-opacity': 0.9 },
      }, mapa.getLayer('dekorace-svetla') ? 'dekorace-svetla' : undefined);
      // ⚠️ v1.398.1: stav srovnat PŘÍMO — aplikujNoc má bránu „jen
      // při změně kroku“ a vrstva vzniklá PO jeho průchodu by zůstala
      // schovaná až do příští změny kroku (chyceno při ověřování).
      const k = (typeof krokNoci === 'number' && krokNoci >= 0) ? krokNoci : 0;
      mapa.setLayoutProperty('hrac-zare', 'visibility',
          k >= 1 ? 'visible' : 'none');
      if (k >= 1) {
        mapa.setPaintProperty('hrac-zare', 'icon-opacity',
            [0, 0.45, 0.7, 0.95][k]);
      }
    }
    const z2 = mapa.getSource('hrac-svetlo');
    if (z2) {
      z2.setData({ type: 'FeatureCollection', features: [{
        type: 'Feature', properties: {},
        geometry: { type: 'Point', coordinates: [lng, lat] } }] });
    }
    // díra lucerny putuje s hráčem (throttle uvnitř — pobídkou)
    if (window.__nocniDiry) window.__nocniDiry();
  } catch (e) { /* styl se zrovna mění — příští poloha */ }
}

/// ⭐ v1.392: ZAPEČENÝ LOVEC SKOKŮ. Injektovaný záznamník umíral s každým
/// restartem stránky — přesně tam, kde se skáče nejvíc (start, návrat
/// z pozadí). Teď běží vždy: prstenec kamery per frame + detekce skoku
/// V KLIDU (bez prstu, bez pohybu, >40 px promítnutého bodu za snímek)
/// + podpis volajícího u programových pohybů kamery. Čtení:
/// `window.__odskoky` (posledních 20), `window.__kamVolani`.
/// Cena: 1× project() za snímek (~0,1 ms) — měřeno neznatelné.
/// ⭐ v1.417: MODRÁ ŠIPKA K UŽIVATELI kreslená ENGINEM každý snímek.
/// Dřív šla přes most (hlasKameru → Dart) se škrcením, 1,5s tichy po
/// výškových krocích a zpožděním mostu — s trvalým terénem se ticha
/// při panování přes kopce řetězila („šipka zamrzá, ukazuje opačně“).
/// Teď: čistá geometrie na rAF přímo z kamery, žádný most, klep na
/// šipku přeletí na uživatele.
function nasadSipkuKUzivateli() {
  if (window.__sipkaEl || !document.body) return;
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:0;top:0;width:52px;'
    + 'z-index:30;display:none;text-align:center;'
    + 'will-change:transform;pointer-events:auto;cursor:pointer;';
  el.innerHTML = '<div class="sipkaOtoc" style="width:24px;height:24px;'
    + 'margin:0 auto;will-change:transform;">'
    + '<svg viewBox="0 0 24 24" width="24" height="24">'
    + '<path d="M12 2 L19 20 L12 15.5 L5 20 Z" fill="#2196F3" '
    + 'stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/>'
    + '</svg></div>'
    + '<div class="sipkaText" style="font:800 11px sans-serif;'
    + 'color:#1976D2;text-shadow:0 0 3px #fff,0 0 6px #fff;"></div>';
  document.body.appendChild(el);
  window.__sipkaEl = el;
  const otoc = el.querySelector('.sipkaOtoc');
  const text = el.querySelector('.sipkaText');
  el.addEventListener('click', () => {
    const u = poslednPolohaUziv;
    if (u && mapa) {
      try {
        mapa.flyTo({ center: [u.lng, u.lat], duration: 900,
                     essential: true });
      } catch (e) { /* nevadí */ }
    }
  });
  let minule = '';
  const tik = () => {
    try {
      const u = poslednPolohaUziv;
      let ukaz = false;
      if (mapa && u) {
        const b = mapa.getBounds();
        ukaz = !(b && b.contains && b.contains([u.lng, u.lat]));
      }
      if (!ukaz) {
        if (el.style.display !== 'none') el.style.display = 'none';
      } else {
        const c = mapa.getCenter();
        const f1 = c.lat * Math.PI / 180;
        const f2 = u.lat * Math.PI / 180;
        const dl = (u.lng - c.lng) * Math.PI / 180;
        const azim = Math.atan2(Math.sin(dl) * Math.cos(f2),
            Math.cos(f1) * Math.sin(f2)
            - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)) * 180 / Math.PI;
        const uhel = ((azim - mapa.getBearing()) % 360 + 360) % 360;
        const w = window.innerWidth;
        const h = window.innerHeight;
        const rad = (uhel - 90) * Math.PI / 180;
        const dx = Math.cos(rad);
        const dy = Math.sin(rad);
        const cx = w / 2;
        const cy = h / 2;
        // v1.604: při běžícím plánu je nahoře seznam zastávek – modrá
        // jde pod něj (stejná výška jako oranžová k zastávce)
        const horni = (typeof planCilBod !== 'undefined' && planCilBod)
            ? 185 : 92;
        let t = 1e9;
        if (dx > 0.0001) t = Math.min(t, (w - 78 - cx) / dx);
        if (dx < -0.0001) t = Math.min(t, (30 - cx) / dx);
        if (dy > 0.0001) t = Math.min(t, (h - 100 - cy) / dy);
        if (dy < -0.0001) t = Math.min(t, (horni - cy) / dy);
        const x = cx + dx * t;
        const y = cy + dy * t;
        const R = 6371000;
        const df = f2 - f1;
        const aa = Math.sin(df / 2) ** 2
            + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
        const m = 2 * R * Math.asin(Math.min(1, Math.sqrt(aa)));
        el.style.display = 'block';
        el.style.transform = 'translate(' + (x - 26).toFixed(1) + 'px,'
            + (y - 18).toFixed(1) + 'px)';
        otoc.style.transform = 'rotate(' + uhel.toFixed(1) + 'deg)';
        window.__sipkaXY = { x, y };   // v1.604: oranžová šipka uhýbá
        const pop = m >= 1000
            ? (m / 1000).toFixed(1).replace('.', ',') + ' km'
            : Math.round(m) + ' m';
        if (pop !== minule) { minule = pop; text.textContent = pop; }
      }
    } catch (e) { /* mapa v přestavbě */ }
    requestAnimationFrame(tik);
  };
  requestAnimationFrame(tik);
}

function nasadLovce() {
  if (!mapa || window.__lovec3) return;
  window.__lovec3 = true;
  window.__odskoky = [];
  window.__kamVolani = [];
  for (const m of ['jumpTo', 'easeTo', 'flyTo', 'panTo']) {
    const puv = mapa[m] && mapa[m].bind(mapa);
    if (!puv) continue;
    mapa[m] = function (a, b) {
      try {
        const cil = (a && a.center)
            ? (Array.isArray(a.center)
                ? a.center.map((x) => +(+x).toFixed(4)).join(',')
                : (+a.center.lng).toFixed(4) + ','
                  + (+a.center.lat).toFixed(4))
            : '';
        const stk = (new Error().stack || '').split('\n').slice(2, 5)
            .map((r) => r.trim().slice(-70)).join(' | ');
        window.__kamVolani.push(
            { t: Date.now(), m, cil, dur: a && a.duration, stk });
        if (window.__kamVolani.length > 40) window.__kamVolani.shift();
      } catch (e) { /* jen záznam */ }
      return puv(a, b);
    };
  }
  const prsten = [];
  let dumpDo = 0;
  let lovecTik = 0;
  const tik = () => {
    try {
      // ⚠️ v1.400: project() s trvalým terénem není zadarmo (raycast
      // výšky) a běžel 60×/s i při úplném klidu — pro detekci skoku
      // stačí vzorkovat každý 3. snímek (~20 Hz).
      if ((lovecTik = (lovecTik + 1) % 3) !== 0) {
        requestAnimationFrame(tik);
        return;
      }
      const t = performance.now();
      const c = mapa.getCenter();
      const z = mapa.getZoom();
      const posun = 0.003 * Math.pow(2, 15 - Math.min(z, 18));
      // ⭐ v1.429: PLOCHÁ projekce — mapa.project() s terénem tahá
      // getElevationForLngLat (výškové meze) 20×/s NAPOŘÁD; pro
      // detekci skoku stačí konzistentní číslo, výška je fuk
      const pr = mapa._camera.transform.locationToScreenPoint(
          new maplibregl.LngLat(c.lng, c.lat + posun));
      const klid = !mapa.isMoving()
          && (typeof prstuNaMape === 'undefined' || !prstuNaMape);
      const v = { t: t | 0, lng: +c.lng.toFixed(5), lat: +c.lat.toFixed(5),
        z: +z.toFixed(3), b: +mapa.getBearing().toFixed(1),
        p: +mapa.getPitch().toFixed(1),
        el: +((mapa._camera.transform.elevation) || 0).toFixed(1),
        klid: klid ? 1 : 0, px: +pr.x.toFixed(0), py: +pr.y.toFixed(0) };
      const m = prsten.length ? prsten[prsten.length - 1] : null;
      prsten.push(v);
      if (prsten.length > 60) prsten.shift();
      if (m && m.klid && v.klid && v.t - m.t < 400) {
        const dPx = Math.hypot(v.px - m.px, v.py - m.py);
        if (dPx > 40 && dumpDo < t) {
          dumpDo = t + 2500;
          window.__odskoky.push({
            kdy: new Date().toISOString().slice(11, 19),
            dPx: +dPx.toFixed(0),
            dM: +(Math.hypot((v.lng - m.lng) * 70000,
                             (v.lat - m.lat) * 111000)).toFixed(0),
            dB: +(v.b - m.b).toFixed(1), dP: +(v.p - m.p).toFixed(1),
            prsten: prsten.slice(-6),
            volani: window.__kamVolani.slice(-5),
          });
          if (window.__odskoky.length > 20) window.__odskoky.shift();
          console.warn('[lovec] SKOK dPx=' + dPx.toFixed(0));
        }
      }
    } catch (e) { /* mapa se přestavuje */ }
    requestAnimationFrame(tik);
  };
  requestAnimationFrame(tik);
}

/// ⭐ v1.389: PLYNULÉ PŘEVZETÍ VÝŠKY. Okamžitý přepočet (recalc) držel
/// obraz, ale skokem měnil ZOOM a STŘED → poskočila procenta, šipka
/// i velikosti symbolů („odskok čísel", chyceno lovcem 2×). Místo něj
/// NULOVÝ easeTo (600 ms): nativní stroj animace klouže elevation
/// s kompenzací každý snímek, zoom/střed čísla se NEMĚNÍ, svět se
/// jemně usadí jako při startu. Volá ho patch ve vendor bundlu
/// (sourcedata + render smyčka) přes `globalThis.__plynuleVysku`;
/// návrat true = převzato, jinak vendor spadne na surové doskočení.
/// Během klouzání je `elevationFreeze` nativně zamčené → vendor místa
/// se sama odmlčí. Vypínač: `delete globalThis.__plynuleVysku`.
/// ⚠️ setTimeout 0 jen VYSTUPUJE z render zásobníku (událost, ne
/// periodická korekce — sága zakazuje časovanou OPRAVU, ne odklad).
globalThis.__plynuleVysku = function () {
  try {
    if (!mapa || mapa.isMoving()) return false;
    if (typeof prstNaMape === 'function' && prstNaMape()) return false;
    if (document.visibilityState !== 'visible') return false;
    setTimeout(() => {
      try {
        if (mapa.isMoving()) return;
        mapa._camera.easeTo({
          center: mapa.getCenter(),
          duration: 600,
          essential: true,
          noMoveStart: true,
        });
      } catch (e) { /* příští příchod dat to dorovná */ }
    }, 0);
    return true;
  } catch (e) { return false; }
};

/// ⚡ ODKLAD ZÁPISŮ DAT NA KLID (12. 8. 2026, kampaň sekání). Se zapnutým
/// terénem KAŽDÝ setData do libovolného zdroje zahodí drapovací textury
/// (událost `data` → releaseRTT) a podklad se překresluje. Změřeno:
/// během jednoho štípnutí přišly zápisy dekorací (3×) i míst z appky
/// (2×) → bouře reloadTile. Zápis, který přijde během gesta/pohybu, se
/// tu odloží a spustí jednou po zklidnění; opakované volání s touž
/// klíčovou funkcí se slévá (běží jen poslední).
/// ⚠️ NENÍ to časovaná korekce kamery (sága odskoků) — jen odklad DAT.
const cekajiciZapisy = new Map();
function zapisAzVKlidu(klic, fn) {
  if (!mapa || (!mapa.isMoving() && !prstNaMape())) { fn(); return; }
  cekajiciZapisy.set(klic, fn);
}
function spustCekajiciZapisy() {
  if (!cekajiciZapisy.size) return;
  if (mapa.isMoving() || prstNaMape()) return;   // ještě klid není
  const davka = [...cekajiciZapisy.values()];
  cekajiciZapisy.clear();
  for (const fn of davka) { try { fn(); } catch (e) {} }
}

function prevezmiVyskuBezPohybu() {
  try {
    if (!mapa || !mapa._camera) return;
    if (mapa.isMoving()) return;   // uvnitř pohybu to řídí engine sám
    if (!mapa._camera.elevationFreeze) return;
    // ⛔ PO VÝMĚNĚ STYLU/TERÉNU (3 s) jen surové odemčení. Kompenzace
    // „drž obraz" kotví na to, co je právě na obrazovce — jenže po
    // surových teleportech výšky při výměně je to nesmysl a zoom pak
    // s každým přepnutím režimu putoval (změřeno 16→18→12). Surové
    // usazení je malý viditelný krok, ale NIKAM nedriftuje.
    if (Date.now() - (window.__zmenaTerenuMs || 0) < 3000) {
      mapa._camera.elevationFreeze = false;
      return;
    }
    // ⭐ 12. 8. 2026: NE holé shození vlajky. To nechalo render smyčku
    // převzít výšku terénu BEZ kompenzace → kamera teleportuje svisle
    // a obraz uskočí (změřeno: 210 m výšky = 170 px na obrazovce;
    // uživatel to hlásil jako „odskok 210 m a skok zoomu při posunu").
    // `_finalizeElevation` je nativní konec gesta: znovu ukotví střed
    // na bod pod křížkem a přepočte zoom, obraz stojí (změřeno 0,1 px).
    // Číslo zoomu se přitom SMÍ změnit — nad kopcem je to správně.
    if (mapa.getTerrain()
        && typeof mapa._camera._finalizeElevation === 'function') {
      mapa._camera._finalizeElevation();
    } else {
      mapa._camera.elevationFreeze = false;   // bez terénu stačí odemknout
    }
  } catch (e) {
    try { mapa._camera.elevationFreeze = false; } catch (e2) {}
  }
}

/// ⛔⛔⛔ GLIDE (obal `setElevation`) VYPNUT PO REGRESI ZMIZELÉ MAPY
/// (12. 8. 2026). Obal tlumil velké změny výšky na 12 %/snímek —
/// jenže `setTerrain` nastavuje výšku JEDINÝM velkým voláním, a když
/// to obal utlumil (a v poslední verzi rovnou spolkl), výška uvázla
/// na 0 se zapnutým terénem → kamera pod povrchem → PRÁZDNÝ PERGAMEN.
/// Přebírání výšky teď dělá nativní render smyčka MapLibre (odemčená
/// klapka, viz `prevezmiVyskuBezPohybu`) — správně a bez rizika.
/// ⚠️ Kdyby se sem někdo vracel kvůli odskoku: obal `setElevation`
/// je slepá ulička, protože pere se se `setTerrain`. Odskok patří do
/// desktop dema (breakpoint v render smyčce), ne do obalu setteru.
function nasadPlynulouVysku() { /* vypnuto — viz komentář výš */ }

// ⭐ v1.395: PAMĚŤ NA JEDEN SNÍMEK (rotace/posun na středním zoomu).
// Profil 12. 8.: getTileBoundingVolume + getRenderableIds žraly na gesto
// ~200 ms — TÝŽ výpočet se opakuje pro každý z 21 zdrojů a každou vrstvu.
// Změřeno živě přes CDP: BV keš 2,4 mil. zásahů / 45 tis. výpočtů za 30 s
// gest; rotace z14 66→9 dlouhých snímků, posun z13,5 43→8.
// ⛔⛔ getRenderableIds SMÍ číst z keše JEN UVNITŘ painter.render (jeden
// synchronní průchod = neměnná množina dlaždic). Rozmisťování symbolů
// běží MIMO něj a klíče z minulého snímku = „getBucket of undefined"
// 1097× za tři gesta (změřeno, verze bez brány `vKresleni`).
// BV keš smí přežívat celý snímek: hodnoty se mění jen příchodem DEM
// dlaždice a zpoždění o snímek je neškodné (stejná třída jako paměť
// výškových mezí v1.328).
// ⭐ v1.422: ŠKRTIČ PŘÍJMU DLAŽDIC („drhne především načítání“).
// Hotové vektorové dlaždice se dřív zapracovaly všechny naráz, jak
// přiletěly z workeru (upload bucketů + placement v jednom snímku =
// špička přesně při načítání). Teď se dokončení řadí do fronty
// a odbavuje SE JEDNO NA SNÍMEK. Chyby jdou hned (stav dlaždice
// se nesmí zaseknout). Platí pro vektorové zdroje (omt, kontury);
// geojson/DEM mají jiné třídy a nechávají se být.
let skrticNasazen = false;
function nasadSkrticPrijmu() {
  if (skrticNasazen) return;
  try {
    if (!mapa) return;
    const zdroj = mapa.getSource('omt');
    if (!zdroj || typeof zdroj.loadTile !== 'function') return;
    const P = Object.getPrototypeOf(zdroj);
    const puv = P.loadTile;
    const fronta = [];
    let bezi = false;
    const odbav = () => {
      const dalsi = fronta.shift();
      if (dalsi) { try { dalsi(); } catch (e) { /* dlaždice mezitím pryč */ } }
      if (fronta.length) requestAnimationFrame(odbav);
      else bezi = false;
    };
    P.loadTile = function (tile, cb) {
      const obal = function (err, data) {
        if (err) return cb(err, data);
        fronta.push(() => cb(err, data));
        if (!bezi) { bezi = true; requestAnimationFrame(odbav); }
      };
      return puv.call(this, tile, obal);
    };
    skrticNasazen = true;
    console.log('[výkon] škrtič příjmu dlaždic nasazen');
  } catch (e) { console.warn('[výkon] škrtič', e); }
}

let pametSnimkuNasazena = false;
function nasadPametSnimku() {
  if (pametSnimkuNasazena) return;
  try {
    if (!mapa || !mapa.painter || !mapa.painter.transform || !mapa.style) return;
    const tr = mapa.painter.transform;
    if (typeof tr.getCoveringTilesDetailsProvider !== 'function') return;
    const Prov = Object.getPrototypeOf(tr.getCoveringTilesDetailsProvider());
    const spravci = mapa.style.tileManagers || {};
    const jmena = Object.keys(spravci);
    if (!jmena.length) return;
    const Spravce = Object.getPrototypeOf(spravci[jmena[0]]);
    if (!Prov || typeof Prov.getTileBoundingVolume !== 'function') return;
    if (typeof Spravce.getRenderableIds !== 'function') return;
    const Kreslic = Object.getPrototypeOf(mapa.painter);
    if (typeof Kreslic.render !== 'function') return;

    const puvBV = Prov.getTileBoundingVolume;
    let kesBV = new Map();
    Prov.getTileBoundingVolume = function (d, w, el, o) {
      // v1.605.2: dřív se klíč skládal ze šesti řetězců při každém volání
      // (466×/snímek → 2,6 % hlavního vlákna v profilu 4. 9.); teď
      // dvouúrovňově: klíč dlaždice (má ho hotový) → číselný podklíč
      const k1 = d.key != null ? d.key : (d.z + '/' + d.x + '/' + d.y);
      const k2 = (w || 0) * 4194304 + ((el || 0) | 0) * 2
          + (o && o.terrain ? 1 : 0);
      let m = kesBV.get(k1);
      if (m === undefined) { m = new Map(); kesBV.set(k1, m); }
      let v = m.get(k2);
      if (v === undefined) { v = puvBV.call(this, d, w, el, o); m.set(k2, v); }
      return v;
    };
    // ⭐ v1.424: keš BV PŘEŽÍVÁ SNÍMKY. Odpověď závisí jen na dlaždici
    // a výškových mezích DEM (viz tělo v bundlu: getMinMaxElevation) —
    // mezi snímky se mění JEDINĚ příchodem DEM dlaždice. Dřív se keš
    // mazala každý render a při zoomu se meze počítaly pořád dokola
    // (466×/snímek, „výškové meze žerou třetinu gesta“). Invalidace:
    // každá dojetá dlaždice zdroje `teren` keš zahodí.
    mapa.on('sourcedata', (u) => {
      if (u && u.sourceId === 'teren' && u.tile) kesBV = new Map();
    });

    const puvRI = Spravce.getRenderableIds;
    let kesRI = new WeakMap();
    let vKresleni = false;
    Spravce.getRenderableIds = function (symboly) {
      if (!vKresleni) return puvRI.call(this, symboly);
      let m = kesRI.get(this);
      if (!m) { m = [null, null]; kesRI.set(this, m); }
      const i = symboly ? 1 : 0;
      if (m[i] === null) m[i] = puvRI.call(this, symboly);
      return m[i].slice();
    };

    const puvRender = Kreslic.render;
    Kreslic.render = function () {
      // kesBV se od v1.424 NEmaže per snímek (viz výš) — jen pojistka
      // proti neomezenému růstu při dlouhém courání po mapě
      if (kesBV.size > 6000) kesBV = new Map();
      kesRI = new WeakMap();
      vKresleni = true;
      try { return puvRender.apply(this, arguments); }
      finally { vKresleni = false; }
    };
    pametSnimkuNasazena = true;
    console.log('[výkon] paměť snímku nasazena (BV + pořadí dlaždic)');
  } catch (e) {
    console.warn('[výkon] paměť snímku nešla nasadit:', e);
  }
}

let pametVysekNasazena = false;
function nasadPametVysek() {
  if (pametVysekNasazena) return;
  try {
    if (!mapa || !mapa.terrain || !mapa.painter) return;
    const Teren = Object.getPrototypeOf(mapa.terrain);
    const Kreslic = Object.getPrototypeOf(mapa.painter);
    if (!Teren || typeof Teren.getMinMaxElevation !== 'function') return;
    if (!Kreslic || typeof Kreslic.render !== 'function') return;
    const puvodni = Teren.getMinMaxElevation;
    const kes = new Map();
    Teren.getMinMaxElevation = function (dlazdice) {
      const k = (dlazdice && dlazdice.key != null) ? dlazdice.key : String(dlazdice);
      let v = kes.get(k);
      if (v === undefined) { v = puvodni.call(this, dlazdice); kes.set(k, v); }
      return { minElevation: v.minElevation, maxElevation: v.maxElevation };
    };
    const puvodniRender = Kreslic.render;
    Kreslic.render = function () { kes.clear(); return puvodniRender.apply(this, arguments); };
    pametVysekNasazena = true;
    console.log('[teren] paměť výškových mezí nasazena');
  } catch (e) {
    console.warn('[teren] paměť výškových mezí nešla nasadit:', e);
  }
}

/// ⛔⛔ OPAKOVANÉ `jumpTo` V ČASOVAČI = ROZBITÁ MAPA (zkoušeno 10. 8. 2026,
/// OKAMžITĚ VRÁCENO). Nezkoušet znovu v téhle podobě.
///
/// Odskok obrazu při zapnutí terénu jsem chtěl srovnat hlídačem, který
/// po 150 ms kontroloval střed i zoom a případně volal `jumpTo`. Na
/// zařízení to mapu ZABILO:
///
///     Uncaught Error: Attempting to run(), but is already running.
///     [fps] 62 | pitch 34 | teren off | moving true | chce -
///
/// `jumpTo` uvnitř spouští animaci kamery; když přijde dřív, než doběhne
/// předchozí, MapLibre hodí výjimku a mapa zůstane trvale `moving` —
/// dlaždice nenaskakačí, terén se nezapne, engine nedostane azimut.
/// Uživatel koukal na žluté pozadi.
///
/// ⚠️ Záměr `korigujeSe` proti smyčce NEFUNGOVAL: `moveend` po `jumpTo`
/// přijde AŽ PO návratu z funkce, takže synchronní příznak je v tu chvíli
/// už zase `false`.
///
/// Diagnóza samotná PLATÍ (viz HANDOFF.md): korekce stříľí dřív, než
/// dorazí výškové dlaždice, a hlídá jen střed, ne zoom. Zoom už se
/// vrací níž. Spávné řešení musí počkat na UDÁLOST o načtení výškopisu
/// a korigovat JEDNOU, ne v časovači.

/// ⛔⛔⛔ OPRAVA ODSKOKU PŘI ZAPNUTÍ TERÉNU: TŘI ARCHITEKTURY, TŘI
/// ZAKLÍNĚNÍ MAPY — DÁL NEZKOUŠET NA TELEFONU (11. 8. 2026 večer).
///
///  1. hlídač jumpTo z časovače (v1.354) → kaskáda moveend, mapa mrtvá;
///  2. centerClampedToGround: false (v1.355–356) → odskok menší, ale
///     rozbitá sémantika zoomu („zoomuje hrozně rychle“, skoky na 84 %);
///  3. elevationFreeze + _finalizeElevation po dosednutí DEM (v1.357)
///     → při startu s obnovou do 3D se potkalo s animací kamery:
///     Uncaught TypeError: this._onEaseFrame is not a function
///     a hned po něm trvalé „Attempting to run(), but is already
///     running“ — otrávená fronta snímků, pitch zamrzl na 41,
///     šedá mapa jen s vrstevnicemi, žádná reakce na gesta.
///
/// Závěr: vnitřnosti kamery (elevationFreeze, _finalizeElevation)
/// NEJSOU bezpečné z vnějšku, dokud běží jakákoli animace — a při
/// startu/za provozu běží skoro pořád (obnova náklonu, přelet za
/// polohou, kompas). Další pokus SE MUSÍ ODLADIT V DESKTOPOVÉM DEMU
/// Okolnik3D s devtools (krokování, breakpoint v TaskQueue.run),
/// ne buildy na telefonu uživatele. Do té doby zůstává původní
/// chování: při zapnutí terénu obraz odskočí o ~výška×tan(náklon)
/// až dosedne DEM. Nepříjemné, ale mapa ŽIJE.

function nastavTeren() {
  // ⚠️ STYL SE MŮŽE PRÁVĚ VYMĚŇOVAT. `Map.setTerrain` začíná
  // `style._checkLoaded()` a hodí „Style is not done loading" – a protože
  // sem vede i obsluha `pitchend`, dala se ta výjimka trefit prstem.
  if (!mapa || !mapa.getStyle || !mapa.getStyle()) return;
  // ⛔⛔ NIKDY TU NEDÁVAT test isStyleLoaded() (zkušenost 6. 8. 2026):
  // v herním stylu se nepřetržitě dopočítávají vrstevnice, takže je skoro
  // pořád FALSE – a terén se pak NEZAPNE VŮBEC (měření hlásilo
  // "pitch 42 / bez terénu"). Výjimku ze setTerrain odchytneme níž.
  const cfg = STYLY[aktualniKod];
  const uzMa = !!(mapa.getTerrain && mapa.getTerrain());
  // ⭐ v1.394.1: držení přebíjí i náklon — bez toho stupeň 2D (pitch 0)
  // terén sundal a při návratu nahoru obraz uskočil (projekční skok).
  const chceTeren = drzetTeren
    ? true
    : (teren3d && mapa.getPitch() >= (uzMa ? 1 : PRAH_TEREN));
  if (chceTeren) {
    // ⚠️ ZAPNUTÍ TERÉNU CUKNE KAMEROU (6. 8. 2026, „při druhém stupni 3D
    // se kamera mnohdy posune – není to odtlačením vrcholem, prostě
    // cukne"). MapLibre po `setTerrain` přepočítá kameru na novou výšku
    // středu, takže se obraz posune o rozdíl nadmořské výšky. Střed si
    // proto zapamatujeme a hned vrátíme – uživatel zůstane tam, kde byl.
    // MĚŘENÍ (6. 8. 2026): ať je doložené, co z prodlevy padá na výškopis
    // a co na znovuzpracování vektorů kvůli popiskům. Čte se z logcatu
    // stejně jako `[fps]`.
    const t0 = performance.now();
    let demDlazdic = 0;
    let omtDlazdic = 0;
    const pocitadlo = (e) => {
      if (!e || !e.sourceId) return;
      // ⚠️ vektorový zdroj se jmenuje `omt` jen ve VLASTNÍCH stylech;
      // hotová „Základní" (Liberty) má `openmaptiles`. Dřív se tu hlídalo
      // jen `omt`, takže v Základní vycházelo „vektor 0" vždycky.
      if (e.sourceId === 'teren' || e.sourceId === 'stinovani') demDlazdic++;
      else omtDlazdic++;
    };
    mapa.on('dataloading', pocitadlo);
    // ⛔ ODREGISTROVAT I KDYŽ `idle` NEPŘIJDE (6. 8. 2026). V herním stylu
    // se mapa do klidu nedostane (běžící animace mlhy a mraků), takže
    // posluchač zůstával navěky – a s každým dalším zapnutím terénu
    // přibyl další. Pojistka po 12 s.
    const dost = setTimeout(() => {
      try { mapa.off('dataloading', pocitadlo); } catch (e) { /* nevadí */ }
    }, 12000);
    // ⛔⛔ `setTerrain` SE MUSÍ CHYTIT. Začíná `style._checkLoaded()` a hodí
    // „Style is not done loading" – a sem vede obsluha `pitchend`.
    // ⚠️ PROČ TO TAK BOLÍ (dohledáno 7. 8. 2026 v knihovně): `Evented.fire`
    // volá posluchače v prostém cyklu BEZ try/catch a `Camera._afterEase`
    // střílí `…fire(pitchend), fire(moveend)` V JEDNOM VÝRAZU. Výjimka
    // v obsluze `pitchend` tedy **spolkne `moveend`** – a s ním hlášení
    // výřezu do appky, dokreslení dekorací i ilustrací a oba časovače.
    // Nic to nespraví až do dalšího pohybu prstem. Přesně tvar stížnosti
    // uživatele: „když se mi načte přiblížená mapa, mám pocit, že čeká,
    // až pohnu obrazem, aby načetla aktuální mapu pod uživatelem."
    try {
      // ⚠️ v1.387: razítko okna TADY NEBÝT — běžné zapnutí terénu při
      // zoomu blokovalo kompenzaci a příchod DEM v klidu pak VIDITELNĚ
      // škubnul obrazem (změřeno lovcem: 445 px na z19,6). Okno kryje
      // jen výměny STYLU (prepniStyl), kde recalc dostával nesmysly.
      mapa.setTerrain({ source: 'teren', exaggeration: cfg.teren });
    } catch (e) {
      console.warn('[teren] setTerrain neprošel (styl se načítá):', e);
      clearTimeout(dost);
      try { mapa.off('dataloading', pocitadlo); } catch (e2) { /* nevadí */ }
      return;   // zkusí se znovu z `pitchend`/`moveend`
    }
    nasadPametVysek();
    nasadPametSnimku();
    nasadPlynulouVysku();
    // ⭐⭐ POLOVIČNÍ DRAPOVACÍ TEXTURA (6. 8. 2026, největší jednotlivý zisk
    // v honu na sekání). Se zapnutým terénem MapLibre kreslí VŠECHNY
    // drapované vrstvy (pozadí, plochy, čáry, rastr, stínování) do textury
    // `tileSize × qualityFactor` = 512 × 2 = **1024² NA KAŽDOU dlaždici
    // terénu**. A tu texturu zahodí při každé dodělané dlaždici jakéhokoli
    // zdroje – při oddalování, kdy jich dotéká spousta, se tedy překresluje
    // pořád dokola. Odtud „na kopcích se po posunu přepočítávají barvy".
    //
    // Změřeno na zařízení (stejná trasa, nahřátá keš, z14, náklon 42°):
    //   1024² … průměr 14,1 a 28,1 fps, NEJHORŠÍ SNÍMEK 1–2 fps
    //    512² … průměr 32,4 a 32,9 fps, nejhorší 13–15 fps
    //    256² … průměr 33,9 fps (dál už to nepřidá, jen měkčí obraz)
    // Rozdíl 512 vs 1024 je na snímku obrazovky sotva znát, zato mapa
    // přestala při gestu zamrzat. `qualityFactor` je v MapLibre napevno 2
    // a nejde zadat volbou, proto se přepisuje po `setTerrain`.
    // ⭐ 7. 8. 2026: ZPĚT NA 1024 (výtka „rozlišení mapy bych zase zvýšil,
    // rozdíl je vidět a nepůsobí to tak hezky malovaně").
    // Zákaz z v1.275 vznikl ve světě se TŘEMI drapovacími stacky, kde
    // 1024² znamenalo 18,9 M pixelů na snímek. Dnes je stack JEDEN, takže
    // 1024² je 6,3 M – třetina toho, na čem zákaz stál. A v1.276.1 navíc
    // doložilo, že dvanáctinásobné snížení drapování nepřineslo ANI JEDEN
    // fps, tedy fill-rate drapování prokazatelně není úzké hrdlo.
    // ZMĚŘENO ZNOVU (counterbalanced A,B,B,A, telefon, z15, náklon 42°):
    //   512²  … 47,0 a 47,9 fps, dlouhých snímků 24 a 19
    //   1024² … 48,1 a 47,5 fps, dlouhých snímků 19 a 19
    // Tedy ostrost zadarmo. Ústupová cesta, kdyby to na slabším telefonu
    // bolelo: 768, nebo 512 dokud `mapa.isMoving()` a 1024 na `moveend`.
    // ⚠️ `releaseAllRTT()` je NUTNÉ – dlaždice s platnou texturou si
    // jinak nechají tu starou velikost (renderLayer je přeskočí).
    // ⚠️ `qualityFactor` je tady MRTVÝ KÓD: čte se jen v konstruktoru
    // RenderToTexture, který proběhl už při `setTerrain` o řádek výš.
    try {
      if (mapa.painter && mapa.painter.renderToTexture) {
        mapa.painter.renderToTexture.rttSize = 1024;
      }
      if (mapa.terrain && mapa.terrain.tileManager
          && mapa.terrain.tileManager.releaseAllRTT) {
        mapa.terrain.tileManager.releaseAllRTT();
      }
    } catch (e) { /* jiná verze knihovny – necháme výchozí */ }
    const t1 = performance.now();
    zjednodusSymbolyProTeren(true);
    // převzít výšku hned při zapnutí (teplá keš DEM) — BEZ pohybu obrazu;
    // studená keš je no-op a dosednuvší dlaždice převezme příští moveend
    prevezmiVyskuBezPohybu();
    const t2 = performance.now();
    mapa.once('idle', () => {
      clearTimeout(dost);
      mapa.off('dataloading', pocitadlo);
      console.log('[teren] setTerrain ' + (t1 - t0).toFixed(0)
          + ' ms, popisky ' + (t2 - t1).toFixed(0)
          + ' ms, do klidu ' + (performance.now() - t0).toFixed(0)
          + ' ms, dlaždic DEM ' + demDlazdic + ' / vektor ' + omtDlazdic);
    });
    // ⛔⛔ ŽÁDNÉ `jumpTo` TADY (11. 8. 2026 večer). Bývala tu záložní
    // korekce středu z v1.351 — jenže `nastavTeren` běží z obsluhy
    // `pitchend`/`moveend`, tedy UVNITŘ kaskády konce animace, a jumpTo
    // odtud reentrantně vstupuje do právě končícího ease. Sedí to na
    // podpis zaklínění mapy (`_onEaseFrame is not a function` → trvale
    // otrávená fronta snímků): korekce vystřelí jen při TEPLÉ keši DEM
    // (výška skočí hned), proto čisté testy se studenou keší procházely
    // a sezení uživatele umírala. Hodnota korekce byla mizivá — odskok
    // stejně řeší až budoucí oprava v desktopovém demu.
    return;
  }
  if (!mapa.getTerrain || !mapa.getTerrain()) return;
  sundejTeren();
}

/// ⭐⭐ ODEBRÁNÍ TERÉNU BEZ SROVNÁVÁNÍ POHLEDU (7. 8. 2026).
///
/// Do dneška tu stálo: „TERÉN SE NESMÍ ODEBRAT, DOKUD JE KAMERA NAKLONĚNÁ –
/// MapLibre si v transformaci drží výškový model; když zmizí pod nakloněnou
/// kamerou, přestanou fungovat dotyková gesta." Proto se nejdřív jelo
/// `easeTo({pitch: 0})` a terén se odebral až v kolmici.
///
/// ⚠️ TO OMEZENÍ UŽ NEPLATÍ. Přeměřeno na MapLibre 6 přímo na telefonu
/// (scratchpad/test-odebrani.mjs) – týž tah prstem posune střed mapy:
///     nakloněno 42° + terén ……… 429 m
///     nakloněno 42°, terén pryč … 600 a 523 m   ← gesta fungují dál
///     kolmo bez terénu …………… 401 m
/// A právě to srovnávání pohledu byla ta věc, kterou uživatel zamítl
/// slovy „vypadá to hrozně, jak to poskakuje, jen co se dotknu mapy".
function sundejTeren() {
  // ⭐ Do logcatu, ať se dá bez CDP poznat, KDY a PROČ hory zmizely
  // („3D+ se nenačítá" = terén se sundal a nevrátil).
  console.log('[teren] sundáno na z' + mapa.getZoom().toFixed(2)
      + ', náklon ' + Math.round(mapa.getPitch()) + '°');
  // Odebrání mění výšku středu, takže by se obraz svisle posunul –
  // střed si zapamatujeme a vrátíme, stejně jako při zapínání.
  // v1.387: bez razítka — viz poznámka u zapnutí terénu
  mapa.setTerrain(null);
  // ⛔ Žádné jumpTo — stejné pravidlo jako v nastavTeren: tahle funkce
  // běží z kaskády pitchend/moveend a reentrantní vstup do kamery
  // odtud trhá frontu snímků. Výšku středu nuluje `setTerrain(null)`
  // sám (výchozí clamping).
  naplanujPopisky();
}

/// Vrácení plných popisků po odebrání terénu — ale AŽ NA STOJÍCÍ MAPĚ.
///
/// `zjednodusSymbolyProTeren` sahá na layout vlastnosti symbolových vrstev
/// a každá taková změna znamená v MapLibre `_updatedSources[…] = 'reload'`.
/// Změřeno 7. 8. 2026 (`scratchpad/cena-popisku.mjs`, 13 symbolových
/// vrstev, z9,6): **3 ms vlastních volání a jeden 66ms snímek** — tedy
/// mnohem míň, než tvrdila starší poznámka o „kompletním znovuzpracování".
/// I tak nemá co spadnout doprostřed gesta, proto `movestart` časovač ruší
/// a `moveend` ho nasazuje znovu. Když se terén mezitím vrátí, práce se
/// zahodí úplně.
function naplanujPopisky() {
  clearTimeout(vratPopiskyCas);
  if (!symbolyPuvod) return;                          // není co vracet
  if (mapa.getTerrain && mapa.getTerrain()) return;   // terén je zpátky
  vratPopiskyCas = setTimeout(() => {
    if (mapa.isMoving()) return;
    if (mapa.getTerrain && mapa.getTerrain()) return;
    try { zjednodusSymbolyProTeren(false); } catch (e) { /* nevadí */ }
  }, POPISKY_ODLEZENI_MS);
}


// ⭐ ČERNÉ PROBLIKNUTÍ PŘI VÝMĚNĚ STYLU (6. 8. 2026, „začne problikávat,
// a někdy nenačte vůbec nic"). `setStyle(…, {diff:false})` zahodí vrstvy
// OKAMŽITĚ, ale nový styl se načte až v PŘÍŠTÍM snímku – do té doby má
// plátno nula vrstev a maže se do PRŮHLEDNA (alfa 0, změřeno `readPixels`).
// WebView appky přitom běží s `transparentBackground: true`, takže tou
// dírou prosvítá tmavé pozadí Flutteru = „černá mapa". Podložíme proto
// stránku papírem v barvě nového stylu; mezera pak vypadá jako prázdný
// list, ne jako výpadek. (A když WebView zrovna negeneruje snímky – appka
// na pozadí, jiná obrazovka nahoře – mezera se protáhne, odtud „někdy
// nenačte vůbec nic".)
const POZADI_STYLU = {
  zakladni: '#EFEDE7', letecka: '#1C2418',
  turisticka: '#F1EFE7', herni: '#EFE3C8',
};

function podlozStyl(kod) {
  try {
    const barva = POZADI_STYLU[kod] || '#EFEDE7';
    document.documentElement.style.background = barva;
    document.body.style.background = barva;
    const el = document.getElementById('mapa');
    if (el) el.style.background = barva;
  } catch (e) { /* nevadí */ }
}

// ⭐ v1.599.3 DYNAMICKÉ ROZLIŠENÍ (rozhodnutí uživatele 2. 9. noc):
// během gesta se kreslí do plátna s poměrem 1,5 (540 px na 360dp
// displeji), po zastavení zpět na plný poměr 2. Změřeno na zařízení
// (herní styl, posun+zoom, z15, náklon, terén): 26,1 → 22,5 ms/snímek,
// snímků nad 33 ms 33 → 25 %, nejdelší snímek 153 → 85 ms; přepínání
// samo nic měřitelného nestojí (17 přepnutí v testu). V klidu je mapa
// ostrá jako dřív, po zvednutí prstu se za čtvrt vteřiny doostří.
// Poměr 1 už nic dalšího nepřidá (zbytek je CPU, ne vybarvování).
const DYN_ROZLISENI_NIZKE = 1.5;
const DYN_ROZLISENI_PRODLEVA_MS = 250;
let dynRozliseniT = null;

// ⛔⛔ VYPNUTO (v1.601.1, 3. 9. 2026 ráno, výtka „při posouvání mizí všechny
// obrázky a ukážou se po zastavení"). Změřeno snímky po 250 ms: se změnou
// poměru pixelů (interní i veřejnou cestou, s terénem i bez něj) zmizí
// od ~0,7 s tahu VŠECHNY symboly – kresby míst, shluky, dekorace i popisky
// z dlaždic – a vrátí se až po zastavení, kdy engine a appka pošlou data
// znovu (setData / nové dlaždice = nové buckety). Hmyz, jehož data se
// obnovují každý snímek, přežil. Symbolové buckety tedy nesou poměr
// pixelů z doby stavby – TO BYLA SLEPÁ STOPA. Skutečná příčina (nalezena
// 3. 9. 2026 večer na telefonu uživatele): `painter.terrainFacilitator`
// po změně plátna nepřekreslí hloubkovou/souřadnicovou texturu terénu,
// prázdná hloubka = „všechno za terénem" a shader symbolů je zahodí.
// Oprava v `nastavPomer` (příznaky depthDirty/coordsDirty).
// v1.601.7: ZAPNUTO NATRVALO (přání „dej to z nastavení pryč, ať je
// stále dynamické rozlišení"). `OkolnikMost.dynRozliseni(bool)` zůstává
// jen pro ladění přes CDP.
let dynRozliseniAktivni = true;
let dynRozliseniModul = null;   // {zapni(), vypni()} po registraci

function zapniDynamickeRozliseni() {
  if (!mapa || !mapa.getPixelRatio) return;
  const plne = mapa.getPixelRatio();
  // displej s nízkým DPR (tablet, emulátor) by se naopak ZVÝŠIL — nic
  if (plne <= DYN_ROZLISENI_NIZKE) return;
  // ⛔⛔ PAST 4 (v1.599.3, hlásil uživatel: „jedním prstem se mapa
  // nehne, jen zmizí obrázky, dvěma prsty jede"): veřejné
  // `mapa.setPixelRatio()` volá `resize()`, a ten mimo pohyb kamery volá
  // `stop()` → `_stopHandlers()` → RESET VŠECH OVLADAČŮ GEST. Při
  // touchstartu to zahodí rozjíždějící se tah jedním prstem (dva prsty
  // přežily, protože druhý dotyk už poměr neměnil). Navíc `resize()`
  // střílí umělé movestart/move/moveend. Proto se poměr nastavuje
  // interní cestou: přepsat `_overridePixelRatio` a přepočítat plátno
  // přes `_resizeInternal()` — bez stop(), bez událostí. Bez té interní
  // funkce (starší záložní bundle) se dynamické rozlišení NEZAPÍNÁ.
  // Ověřeno adb: střed mapy před/po tahu jedním prstem.
  if (typeof mapa._resizeInternal !== 'function') {
    console.log('[rozliseni] bundle bez _resizeInternal - dynamicke vypnuto');
    return;
  }
  const nastavPomer = (r) => {
    if (mapa.getPixelRatio() === r) return;
    try {
      mapa._overridePixelRatio = r;
      mapa._resizeInternal();
      // ⭐⭐ PŘÍČINA MIZENÍ SYMBOLŮ (nalezeno 3. 9. 2026 na realme RMX5070,
      // Adreno 810, kde stačilo ŤUKNOUT): po změně velikosti plátna se
      // hloubková a souřadnicová textura terénu založí znovu, ale
      // `painter.terrainFacilitator` si myslí, že jsou platné (kamera se
      // nehnula) a nepřekreslí je. Prázdná hloubka = 0 = „nejblíž", takže
      // test `depthOpacity` v shaderu symbolů schová ÚPLNĚ VŠECHNY symboly
      // (kresby, dekorace, popisky) až do dalšího pohybu kamery. Na
      // telefonu, kde se kamera pořád trochu hýbe (sledování hráče), to
      // nebylo vidět – proto se to nedařilo zopakovat. Řešení: říct
      // zprostředkovateli, že hloubka i souřadnice jsou k překreslení.
      const f = mapa.painter && mapa.painter.terrainFacilitator;
      if (f) { f.depthDirty = true; f.coordsDirty = true; }
      mapa.triggerRepaint();
    } catch (e) { /* nic - zůstane stávající poměr */ }
  };
  const plneRozliseni = () => nastavPomer(plne);
  // ⛔ PAST (ověřeno na ostrém buildu): engine sám hýbe kamerou
  // (sledování hráče, dojezdy, přelety), takže `isMoving()` bylo při
  // návratu často pravda a rozlišení zůstalo na 1,5 i v klidu. Proto
  // se snižuje JEN při gestu prstem (`originalEvent`) a vrací se
  // bez podmínky po prodlevě a navíc při `idle`.
  // ⛔ PAST 2 a 3 (ověřeno swipem přes adb): `idle` chodí i uprostřed
  // tahu a `moveend` posílají i programové pohyby enginu (sledování
  // hráče, dojezdy) během gesta — plné rozlišení se vracelo za čtvrt
  // vteřiny, i když prst dál táhl. Proto se řídí SKUTEČNÝMI DOTYKY na
  // plátně: první prst dolů → 1,5; poslední prst nahoru → po prodlevě
  // zpět; `idle` dorovná jen mimo dotyk.
  let prstyDole = 0;
  const dolu = () => {
    if (!dynRozliseniAktivni) return;
    clearTimeout(dynRozliseniT);
    dynRozliseniT = null;
    nastavPomer(DYN_ROZLISENI_NIZKE);
  };
  const nahoru = () => {
    if (!dynRozliseniAktivni) return;
    if (mapa.getPixelRatio() === plne) return;
    clearTimeout(dynRozliseniT);
    dynRozliseniT = setTimeout(() => {
      dynRozliseniT = null;
      plneRozliseni();
    }, DYN_ROZLISENI_PRODLEVA_MS);
  };
  const platno = mapa.getCanvasContainer();
  platno.addEventListener('touchstart', (e) => {
    prstyDole = e.touches ? e.touches.length : 1;
    dolu();
  }, { passive: true });
  const konecDotyku = (e) => {
    prstyDole = e.touches ? e.touches.length : 0;
    if (prstyDole === 0) nahoru();
  };
  platno.addEventListener('touchend', konecDotyku, { passive: true });
  platno.addEventListener('touchcancel', konecDotyku, { passive: true });
  mapa.on('idle', () => {
    if (!dynRozliseniAktivni) return;
    if (prstyDole === 0 && dynRozliseniT === null) plneRozliseni();
  });
  dynRozliseniModul = {
    zapni() { dynRozliseniAktivni = true; },
    vypni() {
      dynRozliseniAktivni = false;
      clearTimeout(dynRozliseniT);
      dynRozliseniT = null;
      plneRozliseni();
    },
  };
  console.log('[rozliseni] dynamicke pripraveno ' + DYN_ROZLISENI_NIZKE + ' / '
      + plne + ', aktivni=' + dynRozliseniAktivni);
}

function prepniStyl(kod) {
  if (kod === aktualniKod || !STYLY[kod]) return;
  // ⭐ v1.394 (OBRAT proti v1.379): v HERNÍM režimu se terén DRŽÍ
  // NAPOŘÁD — pásmové sundávání/vracení dělalo při každém návratu FLIP
  // sítě kopců (stovky až 1474 px, lovec 5×; „je to horší a horší").
  // Zapečený terén ve stylu + držení = kopce nikdy neodejdou a není
  // co flipovat. Tlačítko 2D je dál sundá (větev pitch<1). Výkonová
  // pásma vznikla PŘED optimalizacemi v1.328–386 — přeměřeno níže.
  drzetTeren = true;   // v1.437: všechny styly (viz boot výše)
  krokNoci = -1;   // nový styl = noční vrstvy zmizely, nanést znovu
  puvodniKresba = null;   // …a denní barvy cest se přečtou z nového stylu
  podlozStyl(kod);
  Mlha.zastav();
  Ilustrace.zavri();
  aktualniKod = kod;
  // uložené stavy symbolů patří starému stylu — nový je dostane čerstvé
  // (aplikujDoplnky přes nastavTeren zjednoduší znovu, je-li terén)
  symbolyPuvod = null;
  // ⛔⛔ TERÉN MUSÍ PRYČ JEŠTĚ PŘED VÝMĚNOU STYLU (6. 8. 2026, „když
  // přeskočím z herního režimu do neherního, vykreslení mapy je chybné,
  // problikává, někdy nenačte vůbec nic").
  //
  // Změřeno na zařízení přes CDP: po `setStyle` se zapnutým terénem má síť
  // terénu SPRÁVNÉ dlaždice (z14 nad Sezemicemi), `queryRenderedFeatures`
  // hlásí všech ~150 prvků ve všech vrstvách nového stylu a engine běží
  // 40–61 fps BEZ JEDINÉ CHYBY — ale to, co se drapuje na terén, je
  // rozsypané: nad obzorem prosvítá holé pozadí stylu, pod ním rozmazaná
  // plocha. Stav se sám NEOPRAVÍ: nepomůže `setTerrain(null)`+znovu,
  // `mapa.resize()`, další (už čisté) výměny stylu ani návrat oblohy či
  // výchozích LOD. Prevence je tedy jediná cesta — terén se odebere,
  // styl se vymění a terén se nasadí znovu, až nový styl doběhne.
  //
  // ⚠️ Odebrání terénu pod NAKLONĚNOU kamerou umí rozbít gesta (viz
  // `nastavTeren`), proto ho hned po `style.load` vracíme zpátky.
  const melTeren = !!(mapa.getTerrain && mapa.getTerrain());
  if (melTeren) {
    // ⛔ 12. 8.: POKUS „podržet výšku přes okno výměny" VRÁCEN — pral se
    // s kompenzovaným doskočením (finalize) a zoom se s každým přepnutím
    // vrstvil (16,4→18,65, bod uskočil 639 px). Dvojí surová výměna
    // výšky (dolů-nahoru) zůstává schovaná v přemalbě stylu; čistá
    // plynulá sekvence přepnutí je samostatný úkol (viz HANDOFF).
    window.__zmenaTerenuMs = Date.now();
    try { mapa.setTerrain(null); } catch (e) { /* nevadí */ }
  }
  // diff:false = čistá výměna stylu; kamera zůstává
  mapa.setStyle(STYLY[kod].podklad, { diff: false });
  // ⭐ v1.380: doplňky i idle-kick terénu obsluhuje TRVALÝ posluchač
  // `style.load` z initu — `once` odsud se při rychlém přepínání stylů
  // navzájem sežraly a styl zůstal bez stínování/terénu/značek.
  for (const el of document.querySelectorAll('#styly button')) {
    el.classList.toggle('aktivni', el.dataset.styl === kod);
  }
}

// ---------------------------------------------------------------------------
// Přelety na známá místa (souřadnice WGS84, ověřené)
// ---------------------------------------------------------------------------
// pitch ≤ 64 = maxPitch (vyšší hodnoty by MapLibre stejně ořízl)
const MISTA = {
  snezka: { center: [15.7396, 50.7300], zoom: 13.3, pitch: 64, bearing: 20 },
  rtyne:  { center: [16.0725, 50.5050], zoom: 13.2, pitch: 62, bearing: -25 },
  rip:    { center: [14.2893, 50.3866], zoom: 13.6, pitch: 64, bearing: -35 },
  lysa:   { center: [18.4473, 49.5461], zoom: 12.7, pitch: 64, bearing: -140 },
  praha:  { center: [14.4213, 50.0875], zoom: 12.2, pitch: 55, bearing: 0 },
  cesko:  { center: [15.34, 49.82], zoom: 7.05, pitch: 35, bearing: 0 },
};

function prelet(kam) {
  const m = MISTA[kam];
  if (!m) return;
  mapa.flyTo(Object.assign({ duration: 3800, essential: true }, m));
}

// ---------------------------------------------------------------------------
// Měření nadmořské výšky klepnutím
// ---------------------------------------------------------------------------
function zmerVysku(e) {
  if (APP_REZIM) return;            // v aplikaci klik patří Okolníku
  if (Navigace.aktivni()) return;   // klik právě vybírá start/cíl trasy
  // Klepnutí na kreslenou ilustraci otevírá kartu detailu — neměřit
  if (mapa.getLayer('ink-ilustrace')
      && mapa.queryRenderedFeatures(e.point,
                                    { layers: ['ink-ilustrace'] }).length) {
    return;
  }
  const info = document.getElementById('info');
  let text = `${e.lngLat.lat.toFixed(5)} N, ${e.lngLat.lng.toFixed(5)} E`;
  if (teren3d) {
    const v = mapa.queryTerrainElevation(e.lngLat);
    if (v !== null && v !== undefined && isFinite(v)) {
      // queryTerrainElevation vrací hodnotu včetně převýšení stylu
      const metry = v / (STYLY[aktualniKod].teren || 1);
      text = `⛰ ${Math.round(metry)} m n. m. · ` + text;
      console.log('[Okolník 3D] výška raw =', v, '→', Math.round(metry), 'm');
    }
  }
  info.textContent = text;
  info.style.display = 'block';
}

// ---------------------------------------------------------------------------
// MOST DO APLIKACE OKOLNÍK  (režim ?app=1)
// ---------------------------------------------------------------------------
// Engine vznikl proto, aby se do něj Okolník přestěhoval – ne aby stál
// vedle. Tohle je rozhraní, kterým appka engine řídí (Dart →
// `evaluateJavascript`) a kterým jí engine hlásí události zpět
// (`flutter_inappwebview.callHandler`).
//
// ⚠️ Volá se z Dartu, takže ŽÁDNÁ z těchhle funkcí nesmí házet výjimku –
// v Dartu by z toho byla jen tichá chyba v konzoli.
window.__okolnikApp = new URLSearchParams(location.search).get('app') === '1';
const APP_REZIM = new URLSearchParams(location.search).get('app') === '1';

function mostHlas(jmeno, data) {
  try {
    if (window.flutter_inappwebview) {
      window.flutter_inappwebview.callHandler(jmeno, data);
    }
  } catch (e) { /* mimo appku se prostě nic nestane */ }
}

// ⭐ v1.430: PLYNULÉ DOJÍŽDĚNÍ ZNAČKY POLOHY („postava/tečka se
// pohybuje trhaně“) — fixy chodí ~1×/2 s a značka mezi nimi
// teleportovala o metry. Interpolace 20 Hz / 900 ms easeOutQuad;
// velký skok (>45 m, auto/teleport) jde dál naraz.
let polohaVykres = null;
let polohaEase = null;
/// Odstup posledních dvou fixů (ms) — délka dojezdu se řídí jím.
let poslednFixMs = 0;
let mezeraFixu = 0;
let navratStreduHlidac = 0;
let navratStreduBezi = false;
let overNaklonMinule = null;
function vykresliPolohu(lng, lat, smer, rychlost) {
  // ⭐ v1.522: kotva startu drží kameru na KRESLENÉ poloze, ne na syrovém
  // fixu — jinak kamera skáče a figurka za ní dojíždí (viz `poloha`).
  kotviNaHrace(lng, lat);
  obnovSipkuCile();            // v1.602: oranžová šipka k zastávce plánu
  posliVyskuHrace(lng, lat);   // v1.602: převýšení k zastávce
  Postavicka.pripoj(mapa);
  if (Postavicka.poloha(lng, lat, smer, rychlost)) {
    // figurka převzala značku – tečka pryč, ať nejsou dvě
    if (window.__okolnikZnacka) {
      window.__okolnikZnacka.remove();
      window.__okolnikZnacka = null;
    }
    return;
  }
  if (!window.__okolnikZnacka) {
    const el = document.createElement('div');
    el.style.cssText = 'width:18px;height:18px;position:relative;'
      + 'pointer-events:none;';
    // ⭐ v1.430: KUŽEL POHLEDU („naznač u tečky směr pohledů“) —
    // trojúhelínek špičkou v tečce, otáčí ho kompas (azimut −
    // natočení mapy). Bez azimutu zůstává neviditelný.
    // v1.433: „větší a jemnější“ — místo tvrdého trojúhelíku
    // vějíř s přechodem (u tečky sytější, do dálky mizející)
    const kuzel = document.createElement('div');
    kuzel.style.cssText = 'position:absolute;left:50%;top:50%;'
      + 'width:34px;height:38px;margin:-38px 0 0 -17px;'
      + 'background:linear-gradient(to top,'
      + ' rgba(30,136,229,0.40), rgba(30,136,229,0.10) 65%,'
      + ' rgba(30,136,229,0) 100%);'
      + 'clip-path:polygon(50% 100%, 6% 0, 94% 0);'
      + '-webkit-clip-path:polygon(50% 100%, 6% 0, 94% 0);'
      + 'transform-origin:17px 38px;opacity:0;'
      + 'transition:transform 250ms linear, opacity 400ms;';
    el.appendChild(kuzel);
    const tecka = document.createElement('div');
    tecka.style.cssText = 'position:absolute;inset:0;border-radius:50%;'
      + 'background:#1E88E5;border:3px solid #fff;'
      + 'box-shadow:0 0 6px rgba(0,0,0,.45)';
    el.appendChild(tecka);
    window.__okolnikZnacka = new maplibregl.Marker({ element: el });
    window.__okolnikZnacka.__kuzel = kuzel;
    // v1.429: bez zákrytu za terénem — depthAtPoint čte 1×1 px
    // z GPU každý snímek pohybu; tečka smi zůstat vidět i za kopcem
    window.__okolnikZnacka._updateOpacity = function () {};
    window.__okolnikZnacka.setLngLat([lng, lat]).addTo(mapa);
    try { mapa.on('rotate', obnovKuzelZnacky); } catch (e) { /* nic */ }
    obnovKuzelZnacky();
  } else {
    window.__okolnikZnacka.setLngLat([lng, lat]);
  }
}
function obnovKuzelZnacky() {
  try {
    const mk = window.__okolnikZnacka;
    if (!mk || !mk.__kuzel) return;
    const az = window.__azimutZnacky;
    if (typeof az !== 'number' || !isFinite(az)) {
      mk.__kuzel.style.opacity = '0';
      return;
    }
    const uhel = az - (mapa ? mapa.getBearing() : 0);
    mk.__kuzel.style.opacity = '1';
    mk.__kuzel.style.transform = 'rotate(' + uhel.toFixed(1) + 'deg)';
  } catch (e) { /* mapa se zrovna mění */ }
}

// ⭐ v1.602: ORANŽOVÁ ŠIPKA K DALŠÍ ZASTÁVCE PLÁNU (přání 3. 9. večer:
// „jako je na uživatele modrá, tak tady bude oranžová ukazující do
// dalšího bodu od místa uživatele"). Vlastní DOM značka na KRESLENÉ
// poloze hráče (funguje u tečky i u postavičky), otáčí se azimutem
// hráč → zastávka minus natočení mapy; bez zákrytu za terénem (jako
// tečka). Cíl posílá appka v `planTrasa` (`dalsi`); vzdálenost,
// převýšení a čas ukazuje appka v řádku vedle mapy.
// ⚠️ Otáčí se VNITŘNÍ obal, ne kořen značky — na kořen sahá MapLibre
// (transform = umístění), rotace by značku odnesla z bodu.
let planCilBod = null;   // {lng, lat} další zastávky; null = bez šipky

function azimutNa(aLng, aLat, bLng, bLat) {
  const r = Math.PI / 180;
  const dL = (bLng - aLng) * r;
  const y = Math.sin(dL) * Math.cos(bLat * r);
  const x = Math.cos(aLat * r) * Math.sin(bLat * r)
      - Math.sin(aLat * r) * Math.cos(bLat * r) * Math.cos(dL);
  return (Math.atan2(y, x) / r + 360) % 360;
}

/// ⭐ v1.604: ORANŽOVÁ ŠIPKA K DALŠÍ ZASTÁVCE NA KRAJI MAPY (výtka 3. 9.
/// pozdě večer: „ukazuj pouze na kraji mapy s hodnotou vzdálenosti
/// a převýšení – jako modrou k uživateli"). Stejná geometrie jako
/// `nasadSipkuKUzivateli`: čistě z kamery na rAF, žádný most; ukáže se,
/// jen když zastávka není ve výřezu. Popisek posílá appka
/// (`planCilPopisek`: vzdálenost po cestě · převýšení); dokud nedorazí,
/// vzdušná vzdálenost od hráče. Klep přeletí na zastávku. Šipka u
/// postavičky z v1.602 je pryč (přání).
function obnovSipkuCile() { nasadSipkuKCili(); }

function nasadSipkuKCili() {
  if (window.__sipkaCilEl || !document.body) return;
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:0;top:0;width:64px;'
    + 'z-index:30;display:none;text-align:center;'
    + 'will-change:transform;pointer-events:auto;cursor:pointer;';
  el.innerHTML = '<div class="sipkaOtoc" style="width:24px;height:24px;'
    + 'margin:0 auto;will-change:transform;">'
    + '<svg viewBox="0 0 24 24" width="24" height="24">'
    + '<path d="M12 2 L19 20 L12 15.5 L5 20 Z" fill="#F29D38" '
    + 'stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/>'
    + '</svg></div>'
    + '<div class="sipkaText" style="font:800 11px sans-serif;'
    + 'color:#A85D12;text-shadow:0 0 3px #fff,0 0 6px #fff;'
    + 'white-space:nowrap;"></div>';
  document.body.appendChild(el);
  window.__sipkaCilEl = el;
  const otoc = el.querySelector('.sipkaOtoc');
  const text = el.querySelector('.sipkaText');
  el.addEventListener('click', () => {
    const c = planCilBod;
    if (c && mapa) {
      try {
        mapa.flyTo({ center: [c.lng, c.lat], duration: 900,
                     essential: true });
      } catch (e) { /* nevadí */ }
    }
  });
  let minule = '';
  let poslPopisekMs = 0;
  const tik = () => {
    try {
      const c = planCilBod;
      let ukaz = false;
      if (mapa && c) {
        const b = mapa.getBounds();
        ukaz = !(b && b.contains && b.contains([c.lng, c.lat]));
      }
      if (!ukaz) {
        if (el.style.display !== 'none') el.style.display = 'none';
        window.__sipkaXY = null;
      } else {
        const s = mapa.getCenter();
        const f1 = s.lat * Math.PI / 180;
        const f2 = c.lat * Math.PI / 180;
        const dl = (c.lng - s.lng) * Math.PI / 180;
        const azim = Math.atan2(Math.sin(dl) * Math.cos(f2),
            Math.cos(f1) * Math.sin(f2)
            - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)) * 180 / Math.PI;
        const uhel = ((azim - mapa.getBearing()) % 360 + 360) % 360;
        const w = window.innerWidth;
        const h = window.innerHeight;
        const rad = (uhel - 90) * Math.PI / 180;
        const dx = Math.cos(rad);
        const dy = Math.sin(rad);
        const cx = w / 2;
        const cy = h / 2;
        // nahoře až pod seznamem běžícího plánu (ověřeno: 130 px se
        // s ním i s modrou šipkou překrývalo); modré se uhýbá o 48 px
        let t = 1e9;
        if (dx > 0.0001) t = Math.min(t, (w - 84 - cx) / dx);
        if (dx < -0.0001) t = Math.min(t, (36 - cx) / dx);
        if (dy > 0.0001) t = Math.min(t, (h - 150 - cy) / dy);
        if (dy < -0.0001) t = Math.min(t, (185 - cy) / dy);
        let x = cx + dx * t;
        let y = cy + dy * t;
        // popisek je ~100 px široký, uhnout je třeba o víc než o šipku
        const mo = window.__sipkaXY;
        if (mo && Math.abs(mo.x - x) < 110 && Math.abs(mo.y - y) < 44) {
          if (Math.abs(dy) >= Math.abs(dx)) {
            // přednostně doleva (vpravo je sloupec tlačítek mapy)
            x = mo.x - 110 >= 56 ? mo.x - 110
                : Math.min(w - 118, mo.x + 110);
          } else {
            y += 56;
          }
        }
        el.style.display = 'block';
        el.style.transform = 'translate(' + (x - 32).toFixed(1) + 'px,'
            + (y - 18).toFixed(1) + 'px)';
        otoc.style.transform = 'rotate(' + uhel.toFixed(1) + 'deg)';
        // v1.605 (přání): vzdálenost a převýšení OD STŘEDU MAPY k zastávce
        // (jako modrá měří od středu k uživateli); převýšení = výška
        // zastávky − terén pod středem. Počítá se 4× za sekundu, ne
        // každý snímek (výkon).
        const ted = performance.now();
        if (ted - poslPopisekMs >= 250) {
          poslPopisekMs = ted;
          const df = f2 - f1;
          const aa = Math.sin(df / 2) ** 2
              + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
          const m = 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(aa)));
          let pop = m >= 1000
              ? (m / 1000).toFixed(1).replace('.', ',') + ' km'
              : Math.round(m) + ' m';
          if (planCilVyska !== null && teren3d) {
            try {
              const v = mapa.queryTerrainElevation([s.lng, s.lat]);
              if (typeof v === 'number' && isFinite(v) && Math.abs(v) > 0.5) {
                const st = STYLY[aktualniKod];
                const d = Math.round(planCilVyska - v / ((st && st.teren) || 1));
                pop += ' · ' + (Math.abs(d) < 5 ? '± 0 m'
                    : (d > 0 ? '↑ ' : '↓ ') + Math.abs(d) + ' m');
              }
            } catch (e) { /* bez terénu jen vzdálenost */ }
          }
          if (pop !== minule) { minule = pop; text.textContent = pop; }
        }
      }
    } catch (e) { /* mapa v přestavbě */ }
    requestAnimationFrame(tik);
  };
  requestAnimationFrame(tik);
}

// ⭐ v1.602: VÝŠKA TERÉNU POD HRÁČEM pro převýšení k zastávce plánu.
// GPS výška se nehodí (Android hlásí výšku nad elipsoidem, v Česku
// o ~45 m jinou než nadmořskou); výškopis enginu je týž zdroj jako
// výšky zastávek (DEM nad mořem). Hlásí se nejvýš 1× za 2 s; bez
// terénu (2D styl) mlčí a appka se zeptá Open-Meteo.
// ⛔ NULA NENÍ VÝŠKA (viz `pockejNaVysku`): dokud nedotečou dlaždice,
// `queryTerrainElevation` vrací 0 — to se neposílá.
function posliVyskuHrace(lng, lat) {
  try {
    if (!APP_REZIM || !mapa || !teren3d) return;
    const ted = performance.now();
    if (ted - (window.__vyskaHraceMs || 0) < 2000) return;
    window.__vyskaHraceMs = ted;
    const v = mapa.queryTerrainElevation([lng, lat]);
    if (typeof v !== 'number' || !isFinite(v) || Math.abs(v) < 0.5) return;
    const st = STYLY[aktualniKod];
    const metry = v / ((st && st.teren) || 1);
    mostHlas('onVyskaHrace', { m: metry });
  } catch (e) { /* bez terénu není co číst */ }
}

// ⭐⭐ v1.509: KOTVA STARTU — „postava zůstane uprostřed obrazovky".
//
// ZMĚŘENO (CDP, tři starty po sobě, telefon na stole): v 15. vteřině
// stála značka 78–94 CSS px nad středem plátna (až ~400 m), po pár
// minutách přesně ve středu. Kamera se totiž při startu nastaví na
// polohu, kterou appka zná HNED (uloženou nebo síťovou), kdežto pořádný
// GNSS fix dorazí o desítky vteřin později a je jinde. Značka se na něj
// přesune, kamera ne — a když nakonec vyrazí za ní, udělá to `letNa`
// přes `flyTo`, tedy švih s oddálením a přiblížením. Odtud obojí:
// „postava není ve středu obrazu" i „ošklivě to poskakuje".
//
// Kotva to obrátí: dokud běží, kamera se při každém fixu SKOKEM srovná
// na hráče. Postavička se na obrazovce nehne ani o pixel; posouvá se
// svět pod ní. Oprava chybného odhadu tak není „pohyb kamery", ale
// výměna okolí — a to oko bere docela jinak.
//
// ⚠️ KONEC KOTVY je stejně důležitý jako její začátek. Končí:
//   • při PRVNÍM DOTEKU mapy (uživatel si mapu bere do ruky),
//   • při přeletu jinam než na hráče (uživatel si vybral místo),
//   • nejpozději po 180 s.
//
// ⛔ ZKOUŠENO A ZAVRŽENO: „skonči, až se poloha usadí (dva fixy do
// 25 m)". Zní to rozumně, ale ZMĚŘENO to kotvu shodilo už ve 12.
// vteřině — dva síťové fixy jsou k sobě blízko, i když jsou obě o 400 m
// vedle. Pozdní GNSS fix pak značku odsunul o 71×125 px, tedy přesně
// ten stav, kvůli kterému kotva vznikla. Přesnost hlášená fixem to
// nezachrání: Wi-Fi fix v bytě běžně tvrdí 20 m a je o půl vsi vedle.
//
// Že kotva vydrží do doteku, NEVADÍ ani za chůze: sledování polohy je
// stejně zapnuté (`_follow` = true), takže kamera by šla za hráčem tak
// jako tak — kotva to jen dělá přesně a bez švihu. Krok mezi fixy je
// při chůzi 1–2 m, což je při zoomu mapy zlomek pixelu až pár pixelů.
let kotvaDo = 0;          // do kdy smí kotvit (performance.now()); 0 = neběží
let kotvaMinula = null;   // poslední zakotvená poloha — na měření usazení
window.__kotva = { skoku: 0, konec: '' };   // ladicí počítadlo (CDP)

function kotvaBezi() {
  return kotvaDo > 0 && performance.now() < kotvaDo;
}

function zrusKotvu(duvod) {
  if (!kotvaDo) return;
  kotvaDo = 0;
  window.__kotva.konec = duvod;
}

/// Srovná kameru na hráče, pokud kotva běží. Vrací true, když skočila.
function kotviNaHrace(lng, lat) {
  if (!kotvaBezi()) return false;
  // ⛔ PRST NA MAPĚ = KONEC KOTVY. `jumpTo` volá uvnitř `stop()`, takže
  // by uživateli sebral rozjeté gesto (past „náklon krade gesto").
  if (typeof prstuNaMape !== 'undefined' && prstuNaMape) {
    zrusKotvu('dotek');
    return false;
  }
  try {
    mapa.jumpTo({ center: [lng, lat] });
    window.__kotva.skoku++;
  } catch (e) { return false; }
  kotvaMinula = { lng, lat };
  return true;
}

// ── TRASA SPUŠTĚNÉHO PLÁNU (v1.584): vzdušné čáry mezi
// zastávkami + číslované body; data drží modul, vrstvy se po
// přepnutí stylu staví znovu (hooky u nasadModely3d) ──
let planTrasaBody = [];   // [[lng,lat],...] — čára (vzdušná, nebo po cestách)
let planZastavky = null;  // [[lng,lat],...] — kde kreslit číslované body
let planPlne = false;     // true = trasa po cestách (plná), jinak čárkovaná
// v1.605: popisky bodů [[číslo, text], …] (Start / Cíl, číslování od 1 –
// dřív se start počítal jako „1" a první zastávka měla „2") a výšky
// bodů (m n. m.) pro převýšení šipky
let planPopisky = null;
let planVysky = null;
let planCilVyska = null;  // výška další zastávky (m n. m.), null = neznámá

function nasadPlanTrasu() {
  try {
    if (!mapa || !planTrasaBody.length) return;
    if (mapa.getSource('plan-trasa')) {
      aktualizujPlanTrasu();
      return;
    }
    mapa.addSource('plan-trasa', { type: 'geojson', data:
      { type: 'Feature', geometry:
        { type: 'LineString', coordinates: planTrasaBody } } });
    mapa.addSource('plan-body', { type: 'geojson',
      data: planBodyFC() });
    mapa.addLayer({ id: 'plan-trasa', type: 'line',
      source: 'plan-trasa',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#E8701A',
               'line-width': planPlne ? 4 : 3.5,
               'line-opacity': 0.85,
               // v1.596: po cestách plná, vzdušná čárkovaná
               'line-dasharray': planPlne ? [1, 0] : [2, 1.6] } });
    mapa.addLayer({ id: 'plan-body-kruh', type: 'circle',
      source: 'plan-body',
      paint: { 'circle-radius': 11, 'circle-color': '#fffdf6',
               'circle-stroke-color': '#E8701A',
               'circle-stroke-width': 3 } });
    mapa.addLayer({ id: 'plan-body-cisla', type: 'symbol',
      source: 'plan-body',
      layout: { 'text-field': ['get', 'c'],
                'text-font': ['Noto Sans Bold'], 'text-size': 12,
                'text-allow-overlap': true },
      paint: { 'text-color': '#7a3c10' } });
    // v1.605: „Start" / „Cíl" pod bodem (přání: „u startu piš start,
    // na posledním místě cíl")
    mapa.addLayer({ id: 'plan-body-popis', type: 'symbol',
      source: 'plan-body',
      layout: { 'text-field': ['get', 't'],
                'text-font': ['Noto Sans Bold'], 'text-size': 11,
                'text-offset': [0, 1.5], 'text-anchor': 'top',
                'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': '#7a3c10', 'text-halo-color': '#fffdf6',
               'text-halo-width': 1.6 } });
  } catch (e) { console.warn('[plan] vrstvy:', e); }
}

function planBodyFC() {
  const body = planZastavky || planTrasaBody;
  return { type: 'FeatureCollection',
    features: body.map((b, i) => {
      const p = planPopisky && planPopisky[i];
      return { type: 'Feature',
        properties: { c: p ? String(p[0] || '') : String(i + 1),
                      t: p ? String(p[1] || '') : '' },
        geometry: { type: 'Point', coordinates: b } };
    }) };
}

function aktualizujPlanTrasu() {
  try {
    const t = mapa.getSource('plan-trasa');
    const b = mapa.getSource('plan-body');
    if (t) t.setData({ type: 'Feature', geometry:
      { type: 'LineString', coordinates: planTrasaBody } });
    if (b) b.setData(planBodyFC());
    if (mapa.getLayer('plan-trasa')) {
      mapa.setPaintProperty('plan-trasa', 'line-dasharray',
          planPlne ? [1, 0] : [2, 1.6]);
      mapa.setPaintProperty('plan-trasa', 'line-width',
          planPlne ? 4 : 3.5);
    }
  } catch (e) { }
}

function zrusPlanTrasu() {
  try {
    for (const id of ['plan-body-popis', 'plan-body-cisla',
                      'plan-body-kruh', 'plan-trasa']) {
      if (mapa.getLayer(id)) mapa.removeLayer(id);
    }
    for (const z of ['plan-trasa', 'plan-body']) {
      if (mapa.getSource(z)) mapa.removeSource(z);
    }
  } catch (e) { }
}

// ⭐ v1.595: SKUTEČNĚ UŠLÁ STOPA za běhu plánu (přání 1. 9.) —
// plná modrozelená čára pod čárkovanou vzdušnou trasou, ať je vidět,
// jak se reálná cesta liší od plánu.
let planStopaBody = [];   // [[lng,lat],...]

function nasadPlanStopu() {
  try {
    if (!mapa) return;
    if (mapa.getSource('plan-stopa')) {
      mapa.getSource('plan-stopa').setData({ type: 'Feature',
        geometry: { type: 'LineString',
          coordinates: planStopaBody.length > 1 ? planStopaBody : [] } });
      return;
    }
    if (planStopaBody.length < 2) return;
    mapa.addSource('plan-stopa', { type: 'geojson', data:
      { type: 'Feature', geometry:
        { type: 'LineString', coordinates: planStopaBody } } });
    // pod čárkovanou trasu plánu (ať vzdušná čára zůstane čitelná nad ní)
    const pred = mapa.getLayer('plan-trasa') ? 'plan-trasa' : undefined;
    mapa.addLayer({ id: 'plan-stopa-obrys', type: 'line',
      source: 'plan-stopa', layout: { 'line-cap': 'round',
        'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 6,
               'line-opacity': 0.7 } }, pred);
    mapa.addLayer({ id: 'plan-stopa', type: 'line',
      source: 'plan-stopa', layout: { 'line-cap': 'round',
        'line-join': 'round' },
      paint: { 'line-color': '#1E88A8', 'line-width': 3.5 } }, pred);
  } catch (e) { console.warn('[plan] stopa:', e); }
}

function zrusPlanStopu() {
  try {
    for (const id of ['plan-stopa', 'plan-stopa-obrys']) {
      if (mapa.getLayer(id)) mapa.removeLayer(id);
    }
    if (mapa.getSource('plan-stopa')) mapa.removeSource('plan-stopa');
  } catch (e) { }
}

window.OkolnikMost = {
  /// v1.601.2: dynamické rozlišení při gestu zapnout/vypnout za běhu
  /// (ladění; výchozí vypnuto kvůli mizení symbolů).
  dynRozliseni(zap) {
    try {
      if (!dynRozliseniModul) return false;
      if (zap) dynRozliseniModul.zapni(); else dynRozliseniModul.vypni();
      return dynRozliseniAktivni;
    } catch (e) { return false; }
  },
  /// v1.601: cyklotrasy (dlaždice ve Filtrech, všechny režimy).
  cyklo(zap) {
    try { zapniCyklotrasy(!!zap); } catch (e) { }
  },
  /// Trasa spuštěného plánu. Buď pole [[lng,lat],…] (vzdušná čára
  /// mezi zastávkami, čárkovaně), nebo objekt {body, zastavky, plne}
  /// (v1.596: čára po cestách plnou linkou + zastávky zvlášť).
  /// Prázdné pole = schovat.
  planTrasa(arg) {
    try {
      let pole = arg;
      planZastavky = null;
      planPlne = false;
      if (arg && !Array.isArray(arg) && typeof arg === 'object') {
        pole = arg.body || [];
        planZastavky = Array.isArray(arg.zastavky) && arg.zastavky.length
            ? arg.zastavky : null;
        planPlne = !!arg.plne;
      }
      // v1.602: index další zastávky → oranžová šipka na kraji mapy;
      // v1.605: popisky (Start/Cíl, čísla od 1) a výšky bodů
      planCilBod = null;
      planCilVyska = null;
      planPopisky = null;
      planVysky = null;
      if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
        if (Array.isArray(arg.popisky)) planPopisky = arg.popisky;
        if (Array.isArray(arg.vysky)) planVysky = arg.vysky;
        if (Number.isInteger(arg.dalsi)) {
          const zz = Array.isArray(arg.zastavky) && arg.zastavky.length
              ? arg.zastavky : pole;
          const c = zz && zz[arg.dalsi];
          if (c && c.length >= 2) planCilBod = { lng: c[0], lat: c[1] };
          const v = planVysky && planVysky[arg.dalsi];
          if (typeof v === 'number' && isFinite(v)) planCilVyska = v;
        }
      }
      obnovSipkuCile();
      planTrasaBody = Array.isArray(pole) ? pole : [];
      if (!planTrasaBody.length) zrusPlanTrasu();
      else nasadPlanTrasu();
    } catch (e) { }
  },
  /// v1.604: popisek oranžové šipky k zastávce na kraji mapy
  /// („555 m · ↑ 62 m") – vzdálenost po cestě a převýšení počítá appka.
  planCilPopisek(text) {
    try {
      window.__cilPopisek = (text == null) ? '' : String(text);
    } catch (e) { /* nic */ }
  },
  /// Skutečně ušlá stopa za běhu plánu (pole [[lng,lat],…]; prázdné
  /// = schovat). Plná čára pod čárkovanou vzdušnou trasou.
  planStopa(pole) {
    try {
      planStopaBody = Array.isArray(pole) ? pole : [];
      if (planStopaBody.length < 2) zrusPlanStopu();
      else nasadPlanStopu();
    } catch (e) { }
  },
  /// Režim Dobyvatel: vrstva vlajek + schování mlhy (js/dobyvatel.js).
  dobyvatel(zap) {
    try {
      if (!mapa || !window.Dobyvatel) return;
      if (zap) {
        Dobyvatel.hlidejStyl(mapa);
        Dobyvatel.zapni(mapa);
      } else {
        Dobyvatel.vypni();
      }
    } catch (e) { /* nesmí házet do Dartu */ }
  },
  /// Poloha uživatele: postavička (když je nastavený atlas), jinak modrá
  /// tečka. `smer` = azimut pohybu ve stupních, `rychlost` v m/s – obojí
  /// volitelné (figurka si je umí odhadnout z po sobě jdoucích poloh).
  poloha(lat, lng, presnost, smer, rychlost) {
    try {
      if (!mapa || !window.maplibregl) return;
      // drží se TADY (ne v Postavičce): ta si polohu pamatuje jen
      // s nastaveným atlasem, kdežto modrá šipka k uživateli ji
      // potřebuje i pro prostou tečku (cíl, ne mezikroky dojezdu)
      poslednPolohaUziv = { lng, lat };
      // odstup fixů — z něj se počítá délka dojezdu (viz níž)
      const tedFix = performance.now();
      mezeraFixu = poslednFixMs ? tedFix - poslednFixMs : 0;
      poslednFixMs = tedFix;
      // ⚠️ KOTVA SE PŘESUNULA DO `vykresliPolohu`. Když skákala sem, na
      // SYROVÝ fix, kamera uskočila naráz, kdežto figurka se teprve
      // rozjížděla dojezdem — svět tedy poskočil a postava se za ním
      // plazila. Teď kotva sleduje TU SAMOU polohu, která se kreslí.
      obnovHracSvetlo(lng, lat);
      predtahniOkoli(lat, lng);   // jednorázově předehřát okolí (v1.415)
      const start = polohaVykres;
      if (polohaEase) { clearInterval(polohaEase); polohaEase = null; }
      const dM = start ? Math.hypot((lat - start.lat) * 111320,
          (lng - start.lng) * 111320 * Math.cos(lat * Math.PI / 180)) : 1e9;
      // šum GPS na stole (<0,5 m) — NEPŘEKRESLOVAT VŮBEC (jitter
      // krmil dojezd a mapa se v klidu nikdy nezastavila)
      if (start && dM < 0.5) return;
      // první fix nebo teleport (auto) — bez dojezdu
      if (!start || dM > 45) {
        polohaVykres = { lng, lat };
        vykresliPolohu(lng, lat, smer, rychlost);
        return;
      }
      const c0 = { lng: start.lng, lat: start.lat };
      const t0 = performance.now();
      // ⭐⭐ v1.522: DOJEZD MUSÍ TRVAT TAK DLOUHO, JAK CHODÍ FIXY.
      //
      // Výtka: *„GPS posuv postavy na mapě je po skocích, není to
      // plynulé."* Dojezd měl NAPEVNO 900 ms, jenže fixy chodí po
      // ~2 s (a v klidu po 30 s). Figurka tedy 0,9 s klouzala,
      // 1,1 s STÁLA a pak se zase rozjela — přesně to „po skocích".
      //
      // Nově se doba dojezdu bere z odstupu posledních dvou fixů, takže
      // figurka dojede přesně ve chvíli, kdy přijde další poloha,
      // a jde plynule. ⚠️ Strop 3 s: při klidové kadenci 30 s by se
      // jinak plazila půl minuty a vypadalo by to jako zaseknutí.
      const trvani = Math.max(700, Math.min(3000, mezeraFixu || 900));
      polohaEase = setInterval(() => {
        try {
          const f = Math.min(1, (performance.now() - t0) / trvani);
          const g = 1 - (1 - f) * (1 - f);   // easeOutQuad
          polohaVykres = { lng: c0.lng + (lng - c0.lng) * g,
                           lat: c0.lat + (lat - c0.lat) * g };
          vykresliPolohu(polohaVykres.lng, polohaVykres.lat,
              smer, rychlost);
          if (f >= 1) { clearInterval(polohaEase); polohaEase = null; }
        } catch (e2) { clearInterval(polohaEase); polohaEase = null; }
      }, 100);
    } catch (e) { console.warn('[most] poloha', e); }
  },

  /// ⭐ v1.565: KROKOMĚR JAKO DRUHÝ SVĚDEK CHŮZE. Engine rozhoduje
  /// „jde / stojí" podle rychlosti z GNSS (0,9 m/s po 1,5 s); pomalá
  /// chůze v lese se pod práh vejde a postavička pak jen stojí.
  kroky(chodi) {
    try {
      Postavicka.kroky(!!chodi);
    } catch (e) { console.warn('[most] kroky', e); }
  },

  /// POSTAVIČKA (v2.1): atlas skinu z aplikace (stejné soubory jako 2D).
  /// `cfg` = {sloupce, faze, obraceny}; `url === null` vrátí modrou tečku.
  postavicka(url, cfg) {
    try {
      Postavicka.nastav(url, cfg || {});
      // ⛔⛔ v1.510: ZNAČKA SE MUSÍ PŘEKRESLIT HNED (výtka „po skoku
      // z herního do neherního a zase do herního se nenačetla
      // postavička").
      //
      // `Postavicka.nastav(null)` (přechod do neherního) volá `zrus()`,
      // který ZNAČKU SUNDÁ z mapy. Nakreslí ji zpátky až `vykresliPolohu`
      // — jenže tam vede cesta přes `poloha()`, a ta má hned na začátku
      // brzdu proti šumu GPS: *„stejná poloha do 0,5 m → nepřekreslovat
      // vůbec"*. Appka po přepnutí pošle TÉŽ poloze (uživatel se
      // nehnul), takže dM = 0 → return → značka se nenakreslí nikdy.
      // Objevila by se až po posunu o půl metru, což vsedě může trvat
      // libovolně dlouho. Týkalo se to i modré tečky v neherním režimu.
      //
      // ⚠️ `polohaVykres = null` musí zůstat: je to zároveň kotva
      // dojezdu, a po výměně značky se nesmí dojíždět z místa, kde
      // stála ta stará (skočilo by to).
      if (polohaEase) { clearInterval(polohaEase); polohaEase = null; }
      polohaVykres = null;
      const p = poslednPolohaUziv;
      if (p) {
        polohaVykres = { lng: p.lng, lat: p.lat };
        vykresliPolohu(p.lng, p.lat, undefined, undefined);
      }
    } catch (e) { console.warn('[most] postavicka', e); }
  },

  /// Odkrytí mlhy: kruh o poloměru r kilometrů. Po sobě jdoucí hlášení
  /// se spojují mezikruhy — při jízdě autem chodí GPS fixy dál od sebe,
  /// než je poloměr, a bez interpolace zůstávala šňůra oddělených
  /// koleček místo souvislého pruhu.
  objev(lat, lng, rKm) {
    try {
      const r = rKm || 0.25;
      const minule = window.__okolnikMinulyObjev;
      if (minule) {
        const dLat = (lat - minule.lat) * 110.574;
        const dLng = (lng - minule.lng)
          * 111.32 * Math.cos(lat * Math.PI / 180);
        const vzdal = Math.hypot(dLat, dLng);   // km
        // jen souvislý pohyb (max ~3 km mezi fixy — dálnice); teleport ne
        if (vzdal > r * 0.8 && vzdal < 3) {
          const kroku = Math.ceil(vzdal / (r * 0.8));
          for (let i = 1; i < kroku; i++) {
            Mlha.objev(minule.lng + (lng - minule.lng) * i / kroku,
                       minule.lat + (lat - minule.lat) * i / kroku, r);
          }
        }
      }
      window.__okolnikMinulyObjev = { lat, lng };
      Mlha.objev(lng, lat, r);
    } catch (e) { console.warn('[most] objev', e); }
  },

  /// Hromadné odkrytí (migrace mřížky mlhy z Okolníku) – bez animace,
  /// jinak by tisíc kruhů rozjelo tisíc animací.
  objevDavka(body) {
    try {
      for (const b of body || []) Mlha.objev(b[1], b[0], b[2] || 0.25);
    } catch (e) { console.warn('[most] objevDavka', e); }
  },

  /// DOKONČENÉ OBCE (v2.1): 2D vybarvuje dokončenou obec celou podle
  /// hranic – tady se vygumují jako polygonové díry v rytině, ať je
  /// mlha tvarově stejná. `pole` = [[kruh…]…], kruh = [[lat,lng]…]
  /// (pořadí jako u objevDavka; překlopí se tady).
  obce(pole) {
    try {
      const prevedene = (pole || []).map(
          (kruhy) => (kruhy || []).map(
              (kruh) => (kruh || []).map((b) => [b[1], b[0]])));
      console.log('[most] obce ←', prevedene.length);
      Mlha.objevObceDavka(prevedene);
    } catch (e) { console.warn('[most] obce', e); }
  },

  /// Právě dokončená obec – roste od středu (oslava jako ve 2D).
  dokoncenaObec(kruhy) {
    try {
      Mlha.dokoncenaObec(
          (kruhy || []).map((kruh) => (kruh || []).map((b) => [b[1], b[0]])));
    } catch (e) { console.warn('[most] dokoncenaObec', e); }
  },

  /// DRÁHY ULOŽENÝCH VÝPRAV (v2.1): pole tras, trasa = [[lat,lng], …].
  vypravy(pole) {
    try {
      posledniVypravy = (pole || []).map(
          (trasa) => (trasa || []).map((b) => [b[1], b[0]]));
      console.log('[most] vypravy ←', posledniVypravy.length);
      vykresliVypravy();
    } catch (e) { console.warn('[most] vypravy', e); }
  },

  /// POČASÍ Z APLIKACE (v2.9): `pole` = [{lat, lon, kod, oblacnost, den}].
  /// ⚠️ Engine si počasí NESTAHUJE SÁM – v APK `fetch` na Open-Meteo
  /// selhává („Failed to fetch"), zatímco Okolník ho v Dartu stahuje
  /// bez potíží. Bez tohohle volání nebyl na herní mapě ani jeden mrak.
  pocasi(pole) {
    try {
      Pocasi.nastavZvenku(pole || []);
    } catch (e) { console.warn('[most] pocasi', e); }
  },

  /// TURISTICKÉ ZNAČKY KČT (v2.8): appka posílá úseky ve VÝŘEZU (vybírá
  /// si je stejně jako 2D `TrailsData.inBounds`), engine je jen kreslí.
  /// `pole` = [{b: 'r'|'b'|'g'|'y', body: [[lat,lng], …]}, …].
  /// Barvy i světlý podklad pod čarou jsou převzaté z 2D vrstvy, ať
  /// značka vypadá v obou mapách stejně.
  znacky(pole) {
    try {
      posledniZnacky = (pole || []).map((u) => ({
        b: u.b || 'r',
        body: (u.body || []).map((p) => [p[1], p[0]]),
      })).filter((u) => u.body.length >= 2);
      vykresliZnacky();
    } catch (e) { console.warn('[most] znacky', e); }
  },

  /// TRASA VYBRANÉHO DNE (v1.450): appka pošle body z kalendáře,
  /// prázdné pole trasu smaže. Na mapě se sama neobjeví.
  stopaDne(trasa) {
    try {
      stopaDne = (trasa || []).map((b) => [b[1], b[0]]);
      vykresliStopuDne();
    } catch (e) { console.warn('[most] stopaDne', e); }
  },

  /// BĚŽÍCÍ VÝPRAVA (v2.7): jedna trasa `[[lat,lng], …]` kreslená
  /// červeně navrchu. Prázdné pole ji smaže (výprava skončila).
  aktivniVypravu(trasa) {
    try {
      aktivniVyprava = (trasa || []).map((b) => [b[1], b[0]]);
      // ⚡ za chůze s 3D mapou chodí bod à ~2 s a každý zápis shazoval
      // drapovací textury — kreslí se až v klidu (viz zapisAzVKlidu)
      zapisAzVKlidu('vyprava-ted', vykresliAktivniVypravu);
    } catch (e) { console.warn('[most] aktivniVypravu', e); }
  },

  /// ERBY DOKONČENÝCH OBCÍ (v2.2): `pole` = [{lat, lon, url}] — seznam
  /// se NAHRAZUJE (zdroj pravdy je aplikace, jako u obcí). `url` míří na
  /// asset server aplikace (`/assets/erby/<klíč>.webp`). Kreslí se jen
  /// v herním stylu; klik hlásí zpět `onErb` {lat, lon, url}.
  erby(pole) {
    try {
      const prevedene = (pole || [])
        .filter((e) => e && typeof e === 'object')
        .map((e) => ({ lng: +e.lon, lat: +e.lat, url: e.url }));
      console.log('[most] erby ←', prevedene.length);
      Erby.nastav(prevedene);
    } catch (e) { console.warn('[most] erby', e); }
  },

  /// NATOČENÍ MAPY PODLE KOMPASU (v1.227). Appka posílá azimut pohledu
  /// uživatele; mapa se otočí tak, aby „nahoru" byl směr chůze.
  ///
  /// ⚠️ Nikdy během vlastního pohybu kamery ani gesta – jinak by to
  /// uživateli rvalo mapu z ruky. Krátká animace, ať to neškube.
  /// [otacetMapu] false = azimut dostane JEN postavička, kamerou se
  /// nehýbe (6. 8. 2026: „rotaci podle pohledu defaultně vypni").
  smer(azimut, otacetMapu) {
    try {
      if (!mapa || typeof azimut !== 'number' || !isFinite(azimut)) return;
      // ⭐ v1.430: azimut živí i kužel pohledu u tečky (mimo hru)
      window.__azimutZnacky = azimut;
      obnovKuzelZnacky();
      if (otacetMapu === false) {
        Postavicka.kompas(azimut);
        smerPozadovany = null;   // ať se po zapnutí nedotáčí starý směr
        return;
      }
      // ⚠️ AZIMUT SE NIKDY NEZAHAZUJE (v1.247, výtka „směr natočení moc
      // nefunguje"). Dřív: appka posílá azimut jen při změně ≥6° a NAVÍC
      // nejdřív po 400 ms – jenže vlastní dotáčení trvá 450 ms, takže
      // další azimut skoro vždy dorazil BĚHEM animace a tady se zahodil.
      // Appka si ho ale odškrtla jako poslaný, znovu ho nepošle, a mapa
      // zůstala špatně natočená, dokud se člověk neotočil o dalších 6°.
      // Teď se poslední přání pamatuje a dotočí se po konci pohybu.
      smerPozadovany = azimut;
      smerCasMs = Date.now();
      Postavicka.kompas(azimut);   // postoj figurky při stání
      if (!smerHook) {
        smerHook = true;
        registrujPrsty();
        mapa.on('moveend', () => { smerBezi = false; aplikujSmer(); });
        // ruční otočení mapy (dva prsty) poznáme podle originalEvent –
        // programové easeTo/flyTo ho nemá
        mapa.on('rotatestart', (e) => {
          if (e && e.originalEvent) smerRucneMs = Date.now();
        });
      }
      aplikujSmer();
    } catch (e) { console.warn('[most] smer', e); }
  },

  /// Přepnutí stylu: zakladni / letecka / turisticka / herni
  /// ⚠️ KÓD HERNÍHO STYLU JE `herni`. „Kronika" je jméno grafického setu,
  /// ne klíč ve STYLY – a `prepniStyl()` neznámý kód TIŠE ZAHODÍ
  /// (`if (!STYLY[kod]) return;`), takže se chyba nikde neprojeví. Dřív
  /// tu stálo `kronika` a aplikace podle toho volala neexistující styl.
  nastavStyl(kod) {
    try {
      console.log('[most] nastavStyl ←', kod, '(nyní', aktualniKod + ')');
      prepniStyl(kod);
    } catch (e) { console.warn('[most] styl', e); }
  },

  /// Přelet kamery na místo.
  /// [plynule] = sledování za jízdy: lineární `easeTo` místo `flyTo`.
  ///
  /// ⛔ `flyTo` dělá i na sto metrech **oblouk s oddálením** — při
  /// sledování v autě to je to „poskakování", na které si tester
  /// stěžoval. `easeTo` s lineárním easingem jen posune střed.
  ///
  /// ⚠️ PŘESTO SE NEŘETĚZÍ NATVRDO. Appka si drží odstup 1,5 s a
  /// jede se 0,8 s, takže mezi přesuny zůstává ~0,7 s klidu. Je to
  /// záměr: na `mapa.isMoving()` visí návrat terénu i odložené zápisy
  /// dat — kdyby kamera jela nepřetržitě, už by se nikdy nespustily.
  letNa(lat, lng, zoom, plynule, vynutit) {
    try {
      // prst na mapě = žádné přelety (v1.250, „při zoomu 3D zamrzá":
      // sledování polohy létalo kamerou každý fix a rvalo gesta z ruky)
      registrujPrsty();
      // ⭐ 26. 8.: TLAČÍTKO „na mou polohu" posílá vynutit=true — klidová
      // brána 1,2 s po zvednutí prstu jinak žrala právě to klepnutí,
      // které po odsunutí mapy přijde („musím mačkat 2×; teď nefunguje").
      // Prst FYZICKY na mapě má přednost vždy.
      if (vynutit ? prstyDole > 0 : kameruNechatByt()) return;
      // ⭐ v1.509: pod kotvou startu se ZA HRÁČEM NELÉTÁ, skáče se.
      // `flyTo` dělá švih s oddálením a přiblížením — to je to
      // „ošklivé poskakování" hned po načtení. Cíl je přitom týž bod,
      // na kterém už kotva kameru drží, takže skok bývá prázdný.
      //
      // ⚠️ JEN PŘELETY NA HRÁČE. Sem chodí i „Ukázat na mapě" z deníku
      // nebo teleport ze seznamu — to je vědomá volba uživatele, ta
      // kotvu naopak ukončí (dívá se jinam, držet ho u sebe nemá smysl).
      if (kotvaBezi()) {
        const P = (typeof Postavicka !== 'undefined'
            && Postavicka.poslednPoloha()) || poslednPolohaUziv;
        const naHrace = P && Math.hypot((lat - P.lat) * 111320,
            (lng - P.lng) * 111320 * Math.cos(lat * Math.PI / 180)) < 30;
        if (naHrace) { kotviNaHrace(lng, lat); return; }
        zrusKotvu('jinam');
      }
      // ⚠️ `essential: true` je POVINNÉ. Bez něj MapLibre animaci přeskočí,
      // když má systém zapnuté omezení pohybu – a mapa se prostě nehne
      // (ověřeno na Realme: most volal letNa, kamera stála).
      // ⭐⭐ BEZ ZOOMU = ZOOM NECHAT (8. 8. 2026). Dřív tu bylo `zoom || 15`,
      // takže KAŽDÝ přelet na polohu srazil zoom na 15 — a při zapnutém
      // sledování polohy se to dělo každé 4 s. Uživatel: *„občas mapa
      // samovolně odskočí."* Navíc 15 leží POD pásmem 3D (15,3), takže tě
      // to zároveň vyhodilo z 3D. Přiblížení si volí uživatel; přelet má
      // jen posunout střed.
      const cil = { center: [lng, lat], duration: 900, essential: true };
      const z = Number(zoom);
      if (isFinite(z) && z > 0) cil.zoom = z;
      if (plynule && !cil.zoom) {
        mapa.easeTo({ center: [lng, lat], duration: 800,
          easing: (x) => x, essential: true, noMoveStart: true });
        return;
      }
      // ⭐ v1.415: MALÉ doladění (< 60 m, bez cílového zoomu) se PLÍŽÍ
      // — dlouhý lineární easeTo je pod prahem vnímání (subpixel na
      // snímek). Výtka: „po ~21 s se křížek přesune na uživatele“.
      // ⛔ v1.416: plížení JEN při startu (< 40 s od zrodu stránky).
      // Za chůze chodí fixy každých pár sekund a řetězené 2–5s easy
      // držely kameru trvale „v pohybu“ — kompas se za pohybu zdvořile
      // neotáčí, mapa se přestala točit s uživatelem a modrá šipka
      // (azimut − natočení) ukazovala pozdě až opačně.
      if (!cil.zoom && performance.now() < 40000) {
        const c0 = mapa.getCenter();
        const dM = Math.hypot((lat - c0.lat) * 111320,
            (lng - c0.lng) * 111320 * Math.cos(lat * Math.PI / 180));
        if (dM < 60) {
          if (dM < 1.5) return;   // šum — nehnout se vůbec
          mapa.easeTo({ center: [lng, lat],
            duration: Math.max(2200, dM * 90),
            easing: (x) => x, essential: true, noMoveStart: true });
          return;
        }
      }
      mapa.flyTo(cil);
    } catch (e) { console.warn('[most] letNa', e); }
  },

  /// Srovná mapu severem nahoru (po vypnutí natáčení podle pohledu).
  severNahoru() {
    try {
      smerPozadovany = null;
      if (mapa && Math.abs(mapa.getBearing()) > 0.5) {
        mapa.easeTo({ bearing: 0, duration: 400, essential: true });
      }
    } catch (e) { console.warn('[most] severNahoru', e); }
  },

  /// Náklon kamery (0 = shora). Terén se v enginu zapíná právě náklonem.
  ///
  /// ⚠️ TERÉN AŽ NA PLNÉM NÁKLONU (v1.250, „3D se seká stejně na starých
  /// i nových telefonech"): DEM stojí ~30 ms/snímek bez ohledu na výkon
  /// (vlastnost GL JS), takže výchozí pohled 45° běžel VŠUDE na ~30 fps.
  /// Střední náklon je teď perspektiva BEZ terénu (plynulá), hory se
  /// zvednou až na třetím stupni (70°). Pozn.: terén se nikdy neodebírá
  /// pod nakloněnou kamerou (rozbije gesta, viz nastavTeren) – při
  /// přechodu 70°→45° se proto nejdřív srovná pohled; 0/45→70 je čisté.
  /// Od kterého zoomu smí být terén. Posílá appka při startu hodnotou
  /// z `Mapa3dViewState.zoom3dPlus`; engine si podle ní sám vrací hory
  /// po oddalování, aniž by mu appka musela hlásit každý pohyb.
  prahTerenu(zoom) {
    const z = Number(zoom);
    if (isFinite(z) && z > 0) prahZoomTerenu = z;
  },

  /// ⭐ „Pošli mi výřez hned." Appka si o něj řekne po startu, protože
  /// počáteční kamera jde přes URL hash a žádný `moveend` tedy nepřijde.
  hlasVyrez() {
    try {
      if (vynutHlaseniVyrezu) vynutHlaseniVyrezu();
    } catch (e) { console.warn('[most] hlasVyrez', e); }
  },

  /// ⭐ RUČNÍ VOLBA: nechat hory puštěné bez ohledu na zoom.
  /// Posílá appka z `prepniNaklon`, když si uživatel tlačítkem sám zvolí
  /// stupeň 3D+ („nech schválně puštěný i terén pokud tak uživatel zvolí
  /// tlačítkem"). Automatika pak terén při zoomu nesundá.
  ///
  /// ⚠️ Musí přijít PŘED `naklon()`, protože ten už sahá na terén sám.
  /// ⭐ JE NA MAPU VŮBEC VIDĚT? (10. 8. 2026, šetření baterie.)
  /// Appka mapu překrývá vlastními obrazovkami (seznam, detail, deník…)
  /// a `document.hidden` to NEPOZNÁ — WebView je pořád „viditelný".
  /// Bez tohohle malovaly mraky (10 Hz přes celou obrazovku) i figurka
  /// (14 Hz) pod cizí obrazovkou dál: naměřeno 20–26 % jádra v klidu.
  /// ⛔ APPKA TO OD 10. 8. 2026 VEČER NEVOLÁ (viz `home_screen`): zhasnutí
  /// se dalo minout a zůstala nehybná postavička. Výchozí stav v obou
  /// modulech je „vidno", takže nezavolání nic nerozbije.
  vidno(ano) {
    try { Pocasi.nastavVidno(!!ano); } catch (e) { /* styl bez počasí */ }
    try { Postavicka.nastavVidno(!!ano); } catch (e) { /* bez atlasu */ }
  },

  /// ⭐ v1.409: jemné srovnání zoomu po studeném startu. Hash vezme
  /// 15,5, ale převzetí výšky terénu ČÍSLO posune (~+1) a ukazatel
  /// pak lže (80 % místo 72 %). Po usazení se číslo vrátí plynulým
  /// easeTo — jen když se uživatel nedotýká a nic neletí.
  srovnejZoomStartu(z) {
    try {
      if (!mapa || mapa.isMoving()) return;
      if (typeof prstuNaMape !== 'undefined' && prstuNaMape) return;
      if (Math.abs(mapa.getZoom() - z) < 0.2) return;
      // ⭐ v1.506: SKOKEM, NE PLYNULE. Dorovnání běží pod závojem zrodu,
      // takže plynulá animace nemá co zkrášlovat — jen protahuje dobu,
      // po kterou se kamera hýbe, a její konec pak vykoukne zpod závoje
      // jako „poskakování" (změřeno: skok o 40 px ~3,4 s po odhalení).
      // Surové `jumpTo` je navíc to, co se krátce po `setTerrain` má
      // dělat (viz zlaté pravidlo o kompenzacích).
      mapa.jumpTo({ zoom: z });
      // ještě jedna kontrola — kdyby DEM dojel později a číslo posunul
      // znovu. DŘÍV (700 ms), ať se stihne taky pod závojem.
      setTimeout(() => {
        try {
          if (!mapa.isMoving() && Math.abs(mapa.getZoom() - z) >= 0.2) {
            mapa.jumpTo({ zoom: z });
          }
        } catch (e) { /* nevadí */ }
      }, 700);
    } catch (e) { console.warn('[most] srovnejZoomStartu', e); }
  },

  /// ⭐ v1.509: ZAPNOUT KOTVU STARTU (volá appka, když je mapa hotová).
  ///
  /// Od téhle chvíle je kamera přilepená na hráče: každý přijatý fix ji
  /// SKOKEM srovná na jeho polohu, takže postavička zůstane přesně
  /// uprostřed a mění se jen svět pod ní. Podrobně viz `kotviNaHrace`.
  srovnejNaHrace(lat, lng) {
    try {
      if (!mapa) return;
      kotvaDo = performance.now() + 180000;   // tvrdý strop
      kotvaMinula = null;
      kotviNaHrace(lng, lat);
    } catch (e) { console.warn('[most] srovnejNaHrace', e); }
  },

  /// Zapne/vypne plynulý režim (mapa naplocho, bez terénu).
  ///
  /// ⚠️ Při zapnutí se terén odebírá HNED a kamera se srovná — obojí
  /// je vědomá volba uživatele, takže tady skok nevadí. Naopak by
  /// vadilo, kdyby se hory sundaly a kamera zůstala nakloněná: bez
  /// terénu vypadá nakloněný pohled placatě a lidé to hlásí jako chybu.
  /// [drzet] platí jen při VYPÍNÁNÍ: má se terén po návratu držet
  /// bez ohledu na náklon a zoom? (Ve hře ano — herní styl ho drží
  /// napořád, viz v1.394.1.)
  ///
  /// ⛔ ENGINE SI DRŽENÍ NEPAMATUJE SÁM. Napoprvé si ho schovával do
  /// `__plochaDrzela` — jenže když se appka nastartovala s 2D už
  /// zapnutým, hra držení nikdy nestihla nastavit a po vypnutí 2D se
  /// hory nevrátily. Výtka: *„vypnutím 2D se kopce nenačítají zpět
  /// hned, musel jsem zoomnout."* Jediný, kdo tuhle pravdu zná, je
  /// aplikace — tak ať ji pošle.
  /// Zavolá [hotovo], až se výška středu z výškopisu ustálí.
  ///
  /// ⭐ Proč to vůbec je: `queryTerrainElevation` vrací 0, dokud
  /// nedotečou dlaždice DEM, a pak hodnota vyskočí na reálnou. Kdo se
  /// v té chvíli nakloní, veze se na rostoucím čísle a obraz se plazí.
  ///
  /// ⚠️ STROP 20 POKUSŮ (~2,4 s) — změřeno, že výškopis dotéká
  /// do klidu ~2,3 s. Bez signálu nebo nad chybějící
  /// dlaždicí se výška neustálí nikdy — a nechat kvůli tomu uživatele
  /// natrvalo v placce by bylo horší než odskok.
  ///
  /// ⚠️ Časovač tu SMÍ být: nesahá na kameru, jen odloží zavolání
  /// `naklon()`. Zákaz z v1.354 se týká `jumpTo` z časovače, který
  /// reentrantně vstupuje do končící animace — to je něco jiného.
  pockejNaVysku(hotovo) {
    let pokusu = 0;
    let minula = null;
    const tik = () => {
      let v = null;
      try {
        const c = mapa.getCenter();
        v = mapa.queryTerrainElevation([c.lng, c.lat]);
      } catch (e) { /* ještě není co číst */ }
      // ⛔ NULA NENÍ VÝŠKA, JE TO „JEŠTĚ NEVÍM".
      // `queryTerrainElevation` vrací 0, dokud nedotečou dlaždice DEM —
      // a dvě nuly za sebou vypadají jako ustálená hodnota. Naměřeno:
      // „výška středu ustálena na 0 m po 120 ms" a kamera se naklonila
      // dřív, než výškopis dorazil — čekání tedy nedělalo nic.
      // V Česku leží nejnižší bod ve 115 m, takže nula je vždy „bez dat".
      const mam = (typeof v === 'number' && isFinite(v) && Math.abs(v) > 0.5);
      const stabilni = mam && minula !== null && Math.abs(v - minula) < 0.5;
      if (mam) minula = v;
      if (stabilni || ++pokusu >= 40) {
        console.log('[teren] výška středu ustálena na '
            + (minula === null ? '?' : minula.toFixed(0)) + ' m po '
            + (pokusu * 60) + ' ms');
        try { hotovo(); } catch (e) { console.warn('[teren] po výšce', e); }
        return;
      }
      setTimeout(tik, 60);
    };
    setTimeout(tik, 60);
  },

  /// [naklonPo] = na kolik stupňů se naklonit AŽ PO ustálení výšky.
  plocha(ano, drzet, naklonPo) {
    try {
      const zap = !!ano;
      if (window.__plocha === zap) return;
      window.__plocha = zap;
      // ⭐ Diagnostika k dotazu „proč se při přepnutí mění přiblížení":
      // MapLibre počítá zoom od POVRCHU, takže se s terénem mění vztah
      // mezi zoomem a měřítkem na obrazovce. Číslo se vypíše před a po,
      // ať se dá rozdíl doložit místo dohadování.
      const zoom0 = mapa.getZoom();
      setTimeout(() => {
        try {
          console.log('[teren] 2D ' + (zap ? 'zap' : 'vyp') + ': zoom '
              + zoom0.toFixed(3) + ' → ' + mapa.getZoom().toFixed(3)
              + ' (rozdíl ' + (mapa.getZoom() - zoom0).toFixed(3) + ')');
        } catch (e) { /* nevadí */ }
      }, 2500);
      if (zap) {
        // ⚠️ PAMATOVAT SI SKUTEČNOST, NE ZÁMĚR. Napoprvé se schovávalo
        // `drzetTeren` — jenže mimo hru se terén nedrží a přesto bývá
        // zapnutý: `nastavTeren` ho jednou nasadí nad prahem 36° a pak
        // ho nechá až do 1° (hystereze). Návrat z 2D pak spočítal
        // z pásma náklon 30°, což je pod prahem, a hory se nevrátily
        // (změřeno: `pitch 30 | teren off`).
        window.__plochaMelaTeren = !!(mapa.getTerrain && mapa.getTerrain());
        drzetTeren = false;
        teren3d = false;
        try { nastavTeren(); } catch (e) { /* pojistka níž */ }
        if (mapa.getPitch() > 0.5) {
          mapa.easeTo({ pitch: 0, duration: 500, essential: true });
        }
      } else {
        // ⚠️ NASADIT HNED, NE ČEKAT NA NÁKLON. `nastavTeren()` bere
        // `drzetTeren` jako přebíjející — terén se tedy vrátí i při
        // nulovém náklonu, ještě než doletí `easeTo` z appky.
        // Bez toho se čekalo na pásmo podle zoomu a v nižším pásmu
        // se hory nevrátily vůbec.
        // ⛔ DRŽENÍ MUSÍ PLATIT PO CELOU DOBU PŘECHODU, i mimo hru.
        //
        // `nastavTeren()` nasadí terén jen když ho buď někdo DRŽÍ, nebo
        // je náklon nad prahem — a my jsme schválně ještě naplocho.
        // Bez tohohle se mimo hru (kde se nedrží) terén nenasadil vůbec
        // a mapa zůstala placatá i po vypnutí 2D.
        //
        // Držení se pustí až po naklonění, kdy si terén udrží sám náklon
        // (nebo ho ve hře drží most dál).
        const cilovyNaklon = Number(naklonPo);
        const budeTeren = !!drzet
            || window.__plochaMelaTeren === true
            || (isFinite(cilovyNaklon) && cilovyNaklon >= PRAH_TEREN);
        window.__plochaMelaTeren = false;
        drzetTeren = budeTeren;
        teren3d = budeTeren;
        // ⚠️ NEJDŘÍV VÝŠKOPIS, POTOM TERÉN. Tohle je celý rozdíl mezi
        // směry: vypnutí má cíl známý (výška 0, `setTerrain(null)` ji
        // nastaví hned), zapnutí musí výšku středu TEPRVE ZJISTIT
        // z dlaždic — a než dotečou, obraz se plazí za rostoucí
        // hodnotou. Předtažení je totéž, co dělá tlačítko náklonu.
        // ⭐⭐ POŘADÍ JE CELÁ POINTA (návrh uživatele 22. 8.).
        //
        // Odskok je `výška středu × tangens náklonu`, takže **při
        // nulovém náklonu je nulový**. Terén se proto nasadí ještě
        // naplocho, počká se, až výškopis dodá skutečnou výšku středu,
        // a teprve pak se kamera nakloní — to už je obyčejná animace
        // nad hotovými daty, která nikam neskáče.
        //
        // ⛔ Dřív se náklon posílal z appky hned po zapnutí terénu, tedy
        // SOUČASNĚ s dotékáním dlaždic: tangens rostl, výška rostla
        // a obraz se vezl na obojím.
        // ⭐ v1.551: SROVNAT ZOOM ZPĚT.
        //
        // Změřeno na telefonu: vypnutí terénu zoom nemění (14,102 →
        // 14,102), ale zapnutí ho zvedne (14,102 → 14,302). Není to
        // chyba MapLibre — **zoom se počítá od POVRCHU**, a jakmile
        // povrch vystoupá na 272 m, je kamera o těch 272 m blíž zemi,
        // takže totéž místo v prostoru odpovídá vyššímu zoomu.
        // (Kontrola: log2(H/(H−272)) = 0,199 → H ≈ 2100 m, což na z14
        // sedí.)
        //
        // ⛔ Nesymetrie znamená DRIFT: každé zapnutí a vypnutí 2D by
        // mapu o dvě desetiny přiblížilo, po pěti cyklech o celý stupeň.
        // Proto se zoom zapamatuje TĚSNĚ PŘED nasazením terénu a vrátí
        // se v téže animaci, která doklápí náklon — žádné volání kamery
        // navíc.
        const zoomPredTerenem = mapa.getZoom();
        try { predtahniVyrez(); } catch (e) { /* nevadí */ }
        try { nastavTeren(); } catch (e) { /* appka pošle náklon */ }
        if (!budeTeren) {
          // ⚠️ Bez terénu není na co čekat — `queryTerrainElevation`
          // by 2,4 s vracela nic (v logu „ustálena na ? m") a náklon
          // by se o tu dobu zbytečně opozdil.
          if (isFinite(cilovyNaklon) && cilovyNaklon > 0) {
            mapa.easeTo({
              pitch: cilovyNaklon, duration: 700, essential: true });
          }
        } else if (isFinite(cilovyNaklon) && cilovyNaklon > 0) {
          this.pockejNaVysku(() => {
            if (window.__plocha) return;   // mezitím zase zapnuto
            // ⭐⭐ ZOOM SKOKEM, TEPRVE POTOM NÁKLON (výtka 23. 8.:
            // „z 2D do 3D to stále přiblíží a oddálí").
            //
            // Pořadí událostí je totiž tohle: terén se nasadí (zatím
            // beze změny), po chvíli dorazí výškopis, MapLibre přepočítá
            // zoom o +0,2 nahoru — a to je to PŘIBLÍŽENÍ. Cokoli, co ho
            // pak vrací **animací**, je vidět jako oddálení; a v animaci
            // náklonu to bylo vidět taky, protože zadaná hodnota se
            // dojíždí plynule z té vyskočené.
            //
            // Skok je proti tomu nejvýš jeden snímek — a s hlídkou po
            // 60 ms je celé okno se špatným zoomem pod desetinu sekundy.
            //
            // ⚠️ `jumpTo` je tu bezpečné: neběží žádná animace (náklon
            // se pouští až za ním) a nejsme uvnitř kaskády `pitchend`,
            // což je ten případ, který mapu v minulosti zaklínil.
            try {
              if (Math.abs(mapa.getZoom() - zoomPredTerenem) > 0.02) {
                mapa.jumpTo({ zoom: zoomPredTerenem });
              }
            } catch (e) { /* kosmetika */ }
            mapa.easeTo({ pitch: cilovyNaklon, duration: 700,
              essential: true });
            // ⛔ SROVNAT ZOOM AŽ NAKONEC, ne v téže animaci. Zkoušel
            // jsem to nejdřív společně — nefungovalo, protože v tu
            // chvíli je zoom ještě PŮVODNÍ; MapLibre ho přepočítá až
            // podle usazené výšky, tedy po doklopení náklonu. Změřeno
            // třemi cykly: 14,028 → 14,217 → 14,433 → 14,709.
            // ⛔ JEDNA OPRAVA NESTAČÍ. Výškopis se dopřesňuje ještě
            // sekundy po nasazení a zoom s ním leze dál nahoru —
            // změřeno: po jediné opravě sedělo první kolo, druhé už
            // startovalo o 0,47 výš. Srovnává se proto třikrát.
            // ⚠️ Prst na mapě opravu ruší: kdo si sám přiblížil, má
            // mít svůj zoom, ne náš.
            for (const kdy of [1100, 2600, 4600]) {
              setTimeout(() => {
                try {
                  if (window.__plocha) return;        // zase 2D
                  if (typeof prstNaMape === 'function' && prstNaMape()) {
                    return;
                  }
                  // pojistka na zbytkový posun; hlavní srovnání už
                  // proběhlo v animaci náklonu, tady jde jen o to, co
                  // dopřesnění výškopisu přidá dodatečně
                  if (Math.abs(mapa.getZoom() - zoomPredTerenem) < 0.05) {
                    return;
                  }
                  mapa.easeTo({ zoom: zoomPredTerenem, duration: 300,
                    essential: true, noMoveStart: true });
                } catch (e) { /* je to jen kosmetika */ }
              }, kdy);
            }
            // po doklonění držení pustit — mimo hru si terén od téhle
            // chvíle drží sám náklon a pásma ho zase sundají při
            // oddálení, přesně jako dřív
            if (!drzet) {
              setTimeout(() => {
                if (!window.__plocha) drzetTeren = false;
              }, 800);
            }
          });
        }
      }
    } catch (e) { console.warn('[most] plocha', e); }
  },

  drzTeren(ano) {
    try {
      // ⭐ v1.394.1: herní styl drží terén VŽDY — příkaz z appky ho smí
      // jen zapnout, nikdy vypnout (jinak by stupně náklonu v herním
      // režimu zase přepínaly projekci).
      drzetTeren = !!ano || !!(STYLY[aktualniKod] && STYLY[aktualniKod].mlha);
      // Když si uživatel hory vyžádal a zrovna nejsou (sundal je zoom),
      // vrátíme je hned – jinak by čekal na nejbližší `moveend`.
      if (drzetTeren && teren3d && mapa.getPitch() >= PRAH_TEREN
          && !(mapa.getTerrain && mapa.getTerrain())) {
        clearTimeout(vratPopiskyCas);
        nastavTeren();
      }
    } catch (e) { console.warn('[most] drzTeren', e); }
  },

  /// [zoom] je nepovinný: tlačítko v appce s náklonem zároveň přibližuje
  /// (2D mapa z výšky, 3D kopce a vesnice, 3D+ hráč ve 3D prostoru).
  /// Jede to JEDNÍM `easeTo`, ať se náklon a zoom neperou o kameru.
  /// Automatika náklonu zoom NEPOSÍLÁ – ta jen srovnává náklon s tím,
  /// kam se uživatel přiblížil sám.
  naklon(stupne, zoom) {
    // ⛔ PRST NA MAPĚ = NEHÝBAT KAMEROU (viz `prstuNaMape` u deklarace).
    // Uloží se poslední přání; dožene ho `dokoncCekajiciNaklon()`, až
    // uživatel pustí displej a doběhne setrvačnost.
    if (prstNaMape()) {
      cekaNaklon = { stupne: stupne, zoom: zoom };
      // ⚠️ HLÍDAČ JE POVINNÝ. Bez něj by odložený příkaz čekal na dotek
      // mapy — a když by mezitím uživatel jen tak seděl, vystřelil by mu
      // později „z ničeho nic". Odloha smí trvat jen o něco déle, než je
      // gesto samo (viz `prstNaMape`).
      clearTimeout(cekaNaklonHlidac);
      cekaNaklonHlidac = setTimeout(dokoncCekajiciNaklon, 1700);
      return;
    }
    // ⚠️ V plynulém režimu se každý požadavek na náklon srovná na nulu
    // (a `smiTeren` mezitím drží hory dole).
    if (window.__plocha) stupne = 0;
    try {
      // ⭐ v1.410: cíl ≈ současný náklon a žádný cílový zoom → není
      // co letet — fantomový easeTo při startu blokoval kompas
      // (naklonLetiDo) a dělal šum v pohybu kamery.
      if (!zoom && Math.abs(mapa.getPitch() - stupne) < 1) {
        teren3d = drzetTeren || stupne >= PRAH_TEREN;
        return;
      }
      const chtelTeren = teren3d && mapa.getTerrain && !!mapa.getTerrain();
      // ⚠️ JEDEN PRÁH PRO OBOJÍ. Bývalo tu natvrdo 60 podle starých
      // stupňů 0/45/70; po jejich změně na 0/30/52 (6. 8. 2026) by
      // nejvyšší stupeň terén UŽ NIKDY nezapnul – hory by se nezvedly
      // vůbec. Navázáno na `PRAH_TEREN`, ať se to znovu nerozejde.
      // ⭐ v1.394.1: v drženém stylu (herní) stupně terén NEVYPÍNAJÍ —
      // každé zapnutí/vypnutí posune projekci o stovky px (viz HANDOFF
      // v1.392: 284–1474 px i s nulovou výškou). Terén drží napořád.
      teren3d = drzetTeren || stupne >= PRAH_TEREN;
      // ⛔⛔ TADY BÝVALO ČEKÁNÍ NA `moveend` — A ROZBILO TLAČÍTKO (8. 8. 2026).
      // Když se šlo z plného náklonu dolů, volalo se `nastavTeren()` a cílový
      // náklon se odkládal na `mapa.once('moveend', …)`, protože terén se
      // tehdy odebíral až po srovnání pohledu (a to srovnání `moveend`
      // spolehlivě vyrobilo). Od v1.285 se terén odebírá BEZ hnutí kamerou,
      // takže `moveend` nemusí přijít VŮBEC — odložený příkaz pak čekal
      // a vykonal se až při PŘÍŠTÍM stisku, se starým cílem. Každý stupeň
      // byl o jeden stisk pozadu a uživateli to připadalo prohozené:
      //   „v nynější verzi přeskakuje 3D a 3D+, jako kdyby byly prohozeny."
      // Změřeno (scratchpad/tlacitko.mjs): 2D → kamera zůstala 42°,
      // 3D → skočila na 0°, 3D+ → 42°.
      // Terén se sundá a na cílový náklon se letí rovnou, bez čekání.
      if (chtelTeren && !teren3d) nastavTeren();
      // ⭐ POPISKY ZJEDNODUŠIT UŽ TEĎ, NE AŽ SE ZVEDNOU HORY (6. 8. 2026).
      // `zjednodusSymbolyProTeren` mění layout symbolových vrstev, a každá
      // taková změna znamená v MapLibre `_updatedSources[…] = 'reload'`,
      // tedy KOMPLETNÍ ZNOVUZPRACOVÁNÍ VŠECH VEKTOROVÝCH DLAŽDIC ve
      // workerech. Dokud se to dělo těsně po `setTerrain`, sečetlo se to
      // s náběhem výškopisu do jedné dlouhé prodlevy. Teď se ta práce
      // schová do 700 ms animace náklonu, kdy stejně nic nestojí.
      if (teren3d) {
        try { zjednodusSymbolyProTeren(true); } catch (e) { /* nevadí */ }
        predtahniVyrez();
      }
      const cil = { pitch: stupne, duration: 700, essential: true };
      const z = Number(zoom);
      if (isFinite(z) && z > 0) cil.zoom = z;
      // ⭐ v1.431: ZÁCHYT STŘEDU PŘED LETEM — surové převzetí výšky
      // po setTerrain umí střed odsunout o stovky metrů (změřeno:
      // naklon(60) na z15,5 = 213 m jižně + zoom +0,73; uživatel
      // „odkopl mě 227 m“). Bez cílového zoomu (= přepínač stupňů,
      // ne herní let) se střed po usazení vrátí zpátky.
      const stredPred = mapa.getCenter();
      // ⚠️ NÁKLON UŽ NA CÍLI = `easeTo` NEUDĚLÁ NIC, tedy ani `pitchend`,
      // na kterém visí `nastavTeren` – a terén se pak NEZAPNE VŮBEC.
      // Trefeno 7. 8. 2026 při měření (hlásilo „pitch 42 / bez terénu")
      // a od té doby je to reálná cesta: automatika náklonu může poslat
      // týž stupeň, když se terén mezitím sundal kvůli oddalování.
      // ⚠️ Musí sedět OBOJÍ – při stejném náklonu, ale jiném zoomu se
      // pořád má kam letět (tlačítko posílá i zoom).
      const sediNaklon = Math.abs(mapa.getPitch() - stupne) < 0.5;
      const sediZoom = cil.zoom === undefined
          || Math.abs(mapa.getZoom() - cil.zoom) < 0.05;
      if (sediNaklon && sediZoom) {
        nastavTeren();
        return;
      }
      // kompas po dobu letu mlčí (700 ms animace + rezerva) — jinak
      // jeho easeTo let zabije a pitch uvázne pod prahem terénu
      naklonLetiDo = Date.now() + 900;
      mapa.easeTo(cil);
      // ⭐ DOTAHOVACÍ POJISTKA (12. 8. 2026): když let přesto něco
      // přeruší (přelet za polohou, gesto), NIKDO ho dřív nedotáhl —
      // stupeň v appce už seděl, dorovnání přišlo až s dalším gestem.
      // Po 1,1 s se ověří, kam kamera doletěla; nedoletěla-li, příkaz
      // se znovu zařadí do fronty odloženého náklonu (ta si sama počká
      // na klid — žádný přímý zásah do kamery odsud).
      clearTimeout(overNaklonCas);
      overNaklonCas = setTimeout(() => {
        overNaklonCas = null;
        try {
          const ted = mapa.getPitch();
          if (Math.abs(ted - stupne) > 2) {
            // ⭐ v1.431.1: NEDOSAŽITELNÝ CÍL SE VZDÁVÁ — když se pitch
            // od minulého pokusu NEHNUL (sráží ho strop podle zoomu,
            // např. 52° → 42°), dotahovačka dřív vířila NAVĚKY každou
            // ~1,1 s (a rušila navazující pojistky)
            if (Math.abs(ted - (overNaklonMinule ?? -99)) < 0.5) {
              overNaklonMinule = null;
              return;
            }
            overNaklonMinule = ted;
            cekaNaklon = { stupne: stupne, zoom: zoom };
            dokoncCekajiciNaklon();
          } else {
            overNaklonMinule = null;
          }
        } catch (e) { /* mapa se zrovna přestavuje */ }
      }, 1100);
      // ⭐ v1.431.1: NÁVRAT KAMERY po přepnutí stupně. Změřeno na
      // zařízení: dolet náklonu (1,2 s) je ČISTÝ — skok přichází až
      // ve 2.–4. s s dojetím výškopisu (surové převzetí: střed
      // 213–284 m + MĚŘÍTKO reálně přiblíženo o ~16 %). Proto:
      // ① v 1,2 s SNÍMEK žádaného stavu (střed + šířka výřezu),
      // ② ve 4,2 s (po surovém okně) náprava: střed zpět a zoom
      // korigovaný o log2 poměru šířek (ciště naměřená korekce,
      // žádné odhady vnitřností). isMoving se NEtestuje — trvale
      // plápolá kompasovým dotáčením; ustupuje se jen prstům.
      if (cil.zoom === undefined && !navratStreduBezi) {
        // ⭐⭐ v1.436.1 („odskoky stále trvají, 80 % po odskoku“):
        // dvoufázová náprava (snímek 1,2 s → oprava 4,2 s) nechala
        // skok 3–4 s viditelný a zrušení dotykem ji vypínalo přesně
        // tam, kde skok vzniká (terén nabíhá po gestu a uživatel už
        // zase zoomuje). Teď: snímek žádaného stavu v 1,2 s po doletu
        // a HLÍDKA à 300 ms do 6,5 s — změřený protiskok přijde do
        // ~0,3 s od skoku. Dotek od snímku hlídku končí (kamera patří
        // uživateli); jumpTo, protože easeTo zabíjí kompas.
        navratStreduBezi = true;
        navratStreduHlidac = setTimeout(() => {
          try {
            const b0 = mapa.getBounds();
            const zadany = {
              lat: mapa.getCenter().lat,
              lng: mapa.getCenter().lng,
              sirka: (b0.getEast() - b0.getWest()),
              dotyk: poslednDotykMs,
            };
            const konecMs = performance.now() + 6500;
            const hlidka = setInterval(() => {
              try {
                if (performance.now() > konecMs
                    || poslednDotykMs > zadany.dotyk) {
                  clearInterval(hlidka);
                  navratStreduBezi = false;
                  return;
                }
                if (mapa.isMoving && mapa.isMoving()) return;
                const c = mapa.getCenter();
                const dM = Math.hypot((c.lat - zadany.lat) * 111320,
                    (c.lng - zadany.lng) * 111320
                    * Math.cos(c.lat * Math.PI / 180));
                const bb = mapa.getBounds();
                const pomer = (bb.getEast() - bb.getWest()) / zadany.sirka;
                if (dM > 400) {
                  clearInterval(hlidka);
                  navratStreduBezi = false;
                  return;
                }
                if (dM > 8 || Math.abs(Math.log2(pomer)) > 0.06) {
                  mapa.jumpTo({
                    center: [zadany.lng, zadany.lat],
                    zoom: mapa.getZoom() + Math.log2(pomer),
                  });
                  clearInterval(hlidka);
                  navratStreduBezi = false;
                }
              } catch (e) {
                clearInterval(hlidka);
                navratStreduBezi = false;
              }
            }, 300);
          } catch (e) { navratStreduBezi = false; }
        }, 1200);
      }
    } catch (e) { console.warn('[most] naklon', e); }
  },

  /// MÍSTA Z OKOLNÍKU (v1.221): appka posílá, co má právě ve filtrech,
  /// engine je kreslí jako body a klik hlásí zpátky.
  ///
  /// ⚠️ POI JSOU BEZ POPISKŮ. Každý styl má jinou sadu glyfů (OpenFreeMap,
  /// ortofoto ČÚZK…) a `text-font`, který ve stylu není, nechá MapLibre
  /// tiše spadnout celou vrstvu. Jméno místa ukazuje detail v appce.
  /// Výjimka: vlastní záložky (`okolnik-moje`) smějí mít krátký popisek
  /// `t` – datum záznamu – protože 'Noto Sans Bold' mají všechny styly.
  mista(pole) {
    try {
      console.log('[most] mista ←', (pole || []).length);
      posledniMista = pole || [];
      // ⚡ zápis až v klidu — appka posílá i během gesta (viz zapisAzVKlidu)
      zapisAzVKlidu('mista', vykresliMista);
    } catch (e) { console.warn('[most] mista', e); }
  },

  /// ⭐ v1.520: U KTERÉHO MÍSTA NABÍDNOUT POTVRZENÍ NÁVŠTĚVY.
  /// `null` odznak schová. Rozhoduje aplikace (zná svou sbírku
  /// i pravidla vzdálenosti), engine jen kreslí.
  nabidkaNavstevy(id) {
    try {
      idNabidkyNavstevy = (typeof id === 'string' && id) ? id : null;
      nasadOdznakNavstevy();
    } catch (e) { console.warn('[most] nabidkaNavstevy', e); }
  },

  /// NAVŠTÍVENÁ MALOVANÁ MÍSTA (v2.6): seznam slugů, které má kaskáda
  /// kreslit BAREVNĚ. Zbytek je černobíle (v odkryté mlze), nebo jen
  /// silueta s otazníkem (v neobjeveném území). Zdroj pravdy je
  /// aplikace (`Achievements` – deník nebo doložený pobyt), engine si
  /// návštěvy nikdy neodvozuje sám z mlhy.
  navstivenaMista(pole) {
    try {
      console.log('[most] navštívená ←', (pole || []).length);
      Ilustrace.navstivene(pole || []);
    } catch (e) { console.warn('[most] navstivenaMista', e); }
  },

  /// Je bod v odkryté ploše? (appka se ptá kvůli barvě značek)
  jeObjeveno(lat, lng) {
    try { return Mlha.jeObjeveno(lng, lat); } catch (e) { return false; }
  },
};

let posledniMista = [];

// ——— NATÁČENÍ PODLE KOMPASU (v1.247, zpřísněno v1.248) ———
// Poslední přání appky + příznak, že právě běží NAŠE dotáčecí animace
// (tu smíme přesměrovat novým azimutem; cizí pohyb – gesto, přelet –
// nikdy nepřerušujeme, jen si azimut necháme na `moveend`).
// ⚠️ v1.248 („mapa se různě protáčí"): STARÝ azimut se nesmí vracet –
// po každém gestu se mapa stáčela na poslední zapamatovaný směr, klidně
// minutu starý. Přání se proto aplikuje jen ČERSTVÉ (≤ 2,5 s) a po
// RUČNÍM otočení mapy prsty dostane uživatel 5 s klidu.
let smerPozadovany = null;
let smerCasMs = 0;
let smerRucneMs = 0;
let smerEaseMs = 0;
let smerBezi = false;
// ⭐ LET NÁKLONU MÁ PŘEDNOST PŘED KOMPASEM (12. 8. 2026 ráno, výtka
// „po prvním zoomu se mapa nepřepne do 3D, musím oddálit"). Kompasová
// otočka (`aplikujSmer` → easeTo, u telefonu v ruce klidně každých
// ~1,2 s) volá stop() a ZABÍJELA právě letící animaci náklonu — pitch
// uvázl třeba na 33° < PRAH_TEREN a terén nesměl. Dorovnání z appky
// přijde až s dalším hlášením výřezu = dalším gestem („musím oddálit").
// Po dobu letu náklonu (700 ms + rezerva) proto kompas mlčí.
let naklonLetiDo = 0;
let smerHook = false;

// ——— PRST NA MAPĚ (v1.250) ———
// Dokud se uživatel mapy dotýká (a chvilku po zvednutí), NIC nesmí hýbat
// kamerou – kompasové dotáčení ani přelet za polohou. Bez téhle stráže se
// gesta prala s běžícími animacemi a zoom/otáčení „zamrzaly": animace
// gesto přerušila a `moveend` hned spustil další.
let prstyDole = 0;
let prstyMs = 0;

function kameruNechatByt() {
  return prstyDole > 0 || Date.now() - prstyMs < 1200;
}

function registrujPrsty() {
  const el = mapa && mapa.getCanvas();
  if (!el || el.dataset.prsty) return;
  el.dataset.prsty = '1';
  el.addEventListener('pointerdown', () => { prstyDole++; }, true);
  const pust = () => {
    prstyDole = Math.max(0, prstyDole - 1);
    prstyMs = Date.now();
  };
  el.addEventListener('pointerup', pust, true);
  el.addEventListener('pointercancel', pust, true);
}

function aplikujSmer() {
  if (!mapa || smerPozadovany === null) return;
  if (kameruNechatByt()) return;               // prst na mapě → ticho
  if (Date.now() - smerCasMs > 2500) return;   // staré přání zahodit
  if (Date.now() - smerRucneMs < 5000) return; // uživatel si otočil sám
  // nejvýš jedno dotáčení za ~1,2 s – jinak se mapa nikdy nezastaví
  // a každé gesto se trefí do běžící animace
  if (Date.now() - smerEaseMs < 1200) return;
  // `isEasing()` existuje jen v MapLibre 5; v 6 ho Map nepředává
  // (kompozituje Cameru místo dědění). `isMoving()` má obojí pokryté,
  // volání navíc je jen pojistka pro záložní v5 (`?ml=5`).
  const jede = mapa.isMoving() || (mapa.isEasing && mapa.isEasing());
  // ⛔⛔⛔ `smerBezi` SE NESMÍ RUŠIT JEN NA `moveend` (10. 8. 2026,
  // „koukám dlouhou dobu na žluté pozadí a mapa se nenačítá").
  //
  // Příznak byl tenhle a sám se živil:
  //     Uncaught Error: Attempting to run(), but is already running.
  //     [fps] 61 | teren off | moving true | chce -
  //
  // Smyčka: `easeTo` běží → přijde další azimut → mapa se ještě hýbe,
  // ale `smerBezi` je true, takže podmínka níž NEPROPUSTÍ návrat →
  // zavolá se `easeTo` do běžící animace → VÝJIMKA → obsluha umře →
  // **`moveend` nevystřelí** → `smerBezi` zůstane true navěky.
  // Mapa pak visí v trvalém pohybu, dlaždice nenaskočí, terén se
  // nezapne a engine nedostane azimut.
  //
  // Táž past je popsaná u počítadla prstů: událost, na které visí
  // zhojení, nemusí přijít. Proto se příznaku VĚŘÍ JEN PO DOBU
  // DOBĚHU animace (350 ms + rezerva) a pak se zhojí sám, bez
  // jediné události.
  const bezi = smerBezi && Date.now() - smerEaseMs < 1000;
  if (jede && !bezi) return;
  // let náklonu má přednost — viz `naklonLetiDo` u deklarace
  if (Date.now() < naklonLetiDo) return;
  // ⭐ v1.410: PRVNÍ azimut po zrodu stránky se nastaví OKAMŽITĚ —
  // 350ms otočka byla při startu vidět jako „poskočení“. Mladá
  // mapa (do ~8 s) se ještě odhaluje, skok nikoho neruší.
  if (!aplikujSmer._prvniByl) {
    aplikujSmer._prvniByl = true;
    if (performance.now() < 25000) {
      try {
        mapa.setBearing(smerPozadovany);
      } catch (e) { /* nevadí, dorovná ease níž příště */ }
      return;
    }
  }
  const rozdil =
      Math.abs(((mapa.getBearing() - smerPozadovany + 540) % 360) - 180);
  if (rozdil < 8) return;          // klid pod 8° – kompas šumí
  smerBezi = true;
  smerEaseMs = Date.now();
  // ⚠️ A KDYBY PŘESTO PROŠLA VÝJIMKA, nesmí zabít obsluhu — jinak se
  // znovu ztratí `moveend` a jsme tam, kde jsme byli.
  try {
    mapa.easeTo({ bearing: smerPozadovany, duration: 350, essential: true });
  } catch (e) {
    smerBezi = false;
    console.warn('[smer] easeTo neprošel:', e && e.message);
  }
}

// ---------------------------------------------------------------------------
// MALOVANÉ IKONY MÍST (v1.225)
// ---------------------------------------------------------------------------
// Okolník posílá u každého místa `ik` = cestu ke SVÉ kresbě
// (`/assets/icons/<druh>.webp`). Dřív tu byly jen barevné kruhy a uživatel
// to právem hlásil: „autobusová zastávka nemá hezky malovaný obrázek, ale
// jen modrou tečku." Obrázky se nahrávají LÍNĚ — MapLibre si přes
// `styleimagemissing` řekne jen o ty, které opravdu kreslí; předem nahrát
// 250 kreseb by nafouklo atlas ikon o stovky MB.
// id -> Promise<boolean>: souběžná volání čekají na TENTÝŽ fetch a dozví
// se skutečný výsledek (dřív Set a druhé volání dostalo rovnou false –
// viz oprava „obrázky se ve 3D nezobrazují" níž)
const ikonyRozpracovane = new Map();
/// ⛔⛔ v1.515: NEÚSPĚCH NESMÍ BÝT DOŽIVOTNÍ (výtka „na jiném telefonu
/// nejsou obrázky některých míst vidět ani po úplném přiblížení").
///
/// Do teď stačilo, aby se kresba jednou nestáhla — třeba proto, že
/// lokální server ještě nestihl naběhnout nebo `createImageBitmap`
/// selhal pod tlakem paměti — a její id skončilo v množině navždy.
/// Na výkonnějším telefonu se to nestalo, na slabším ano, a rozdíl pak
/// vypadal jako „některá místa prostě nemají obrázek".
///
/// Nově se pamatuje POČET POKUSŮ A ČAS: po 20 s se ZKUSIT ZNOVU smí,
/// nejvýš třikrát. Trvale chybějící soubor tím nezahltí síť a přechodná
/// chyba se sama spraví.
const ikonySelhane = new Map();   // id → { pokusu, kdy }
const IKONA_POKUSU = 3;
const IKONA_PAUZA_MS = 20000;

/// Kresby, které se povedly až na druhý pokus. Symboly už jsou v tu
/// chvíli rozparsované BEZ nich, takže se zdroj musí přepsat znovu —
/// jinak zůstane místo prázdné, i když kresba v atlasu leží
/// (tatáž past je popsaná u `nactiIkonyZdroje`).
let ikonyDoparsovat = false;
let ikonyDoparsovatCas = 0;

function preparsujMistaPozdeji() {
  if (ikonyDoparsovat) return;
  ikonyDoparsovat = true;
  setTimeout(() => {
    ikonyDoparsovat = false;
    try {
      const zdroj = mapa && mapa.getSource('okolnik-mista');
      if (zdroj && poslednGjMist) {
        ikonyDoparsovatCas = performance.now();
        zdroj.setData(poslednGjMist);
        console.log('[ikony] přeparsováno (dodatečně dotažené obrázky)');
      }
    } catch (e) { /* styl se zrovna mění */ }
  }, 900);   // počkat, ať se sejde víc opozdilců najednou
}
let hookIkon = false;

// ⚠️ ČERNOBÍLÁ VARIANTA = id kresby + `#bw` (v1.226). Nenavštívená místa
// se kreslí odbarveně („objevené, ale nenavštívené ať jsou černobíle“),
// barvu dá až doložená návštěva. MapLibre umí přebarvit jen SDF ikony,
// takže se odbarvuje při načtení přes plátno a ukládá jako druhý obrázek.
// Stejná matice jako v aplikaci (nástěnka i mlha na mapě).
// ⚠️ Vrací ImageData, ne <canvas> – `map.addImage` bere obrázek, bitmapu
// nebo ImageData; plátno samotné by tiše neprošlo.
function odbarvi(bitmapa) {
  const p = document.createElement('canvas');
  p.width = bitmapa.width;
  p.height = bitmapa.height;
  const ctx = p.getContext('2d');
  ctx.filter = 'grayscale(1) brightness(0.92)';
  ctx.drawImage(bitmapa, 0, 0);
  return ctx.getImageData(0, 0, p.width, p.height);
}

/// ZNAČKY JAKO VE 2D (v1.242, přání „v neherním 3D ukazuj stejné ikony
/// jako 2D"): id `emoji|🛒|#2E7D32` = bílý kroužek s barevným prstencem
/// a emoji; `brand|K|#E10915|#FFFFFF` = plný kroužek s monogramem
/// řetězce. Kreslí se na canvasu (WebView umí barevná emoji), žádné
/// stahování. Vrací ImageData, ne canvas (stejná past jako `odbarvi`).
function nakresliZnacku(id) {
  const dily = id.split('|');
  // ⚠️ 9. 8. 2026 jsem tohle zkusil zmenšit na 150 px v domnění, že bubliny
  // tvoří většinu atlasu. NETVOŘÍ — 87 % atlasu jsou kresby míst (`ilus:`),
  // bubliny 1 %. Zmenšení ubralo 0,2 M px z 11,1 M a na výkonu se ztratilo
  // v šumu, tak je vráceno: neověřená změna vzhledu bez měřitelného zisku
  // za to nestojí.
  const s = 300;                      // pixelRatio 2 → 150 CSS px základ
  const p = document.createElement('canvas');
  p.width = s;
  p.height = s;
  const ctx = p.getContext('2d');
  const stred = s / 2;
  const r = s / 2 - 14;
  ctx.beginPath();
  ctx.arc(stred, stred, r, 0, Math.PI * 2);
  if (dily[0] === 'brand') {
    ctx.fillStyle = dily[2] || '#2E7D5B';
    ctx.fill();
    ctx.fillStyle = dily[3] || '#ffffff';
    const text = dily[1] || '?';
    // delší monogram (KFC, MOL) se zmenší, ať se do kroužku vejde
    const velikost = text.length <= 1 ? 170 : (text.length === 2 ? 130 : 100);
    ctx.font = '700 ' + velikost + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, stred, stred + 8);
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 18;
    ctx.strokeStyle = dily[2] || '#2E7D5B';
    ctx.stroke();
    ctx.font = '170px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(dily[1] || '?', stred, stred + 10);
  }
  return ctx.getImageData(0, 0, s, s);
}

/// Vrací true, když JE kresba v atlasu – ať už ji přidal kdokoli.
/// ⚠️ Dřív vracela true jen když ji „právě teď přidala já" a souběžné
/// volání (druhé vykresliMista, styleimagemissing) dostalo false;
/// nactiIkonyZdroje pak nepřeparsoval zdroj a symboly zůstaly bez
/// obrázků navždy (výtka „ve 3D se nezobrazují obrázky").
// ⭐ 5. 9. 2026: STÍNY OBRÁZKŮ MÍST podle světla (viz vrstva
// okolnik-mista-stin). Offset v pixelech obrázku (škáluje se s icon-size);
// typický obrázek místa má ~220 px na výšku, délka stínu 0,3 výšky ×
// cot(výšky světla), směr OD světla. Síla: slunce 0,32·f(el), měsíc
// 0,16·osvit, tma 0, pod mraky slabší.
let stinMistOffset = [0, 0];
let stinMistSila = 0;

/// Měkká elipsa „u paty" (kontaktní stín) – jeden obrázek pro všechny
/// kresby i obrázky míst, 240×80 px při pixelRatio 2. Vržený stín padá
/// v poledne ZA obrázek (schová se pod něj), tohle drží 3D dojem vždy.
function zajistiStinPatu() {
  try {
    if (!mapa || mapa.hasImage('stin-pata')) return;
    const c = document.createElement('canvas');
    c.width = 240; c.height = 80;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(120, 40, 4, 120, 40, 120);
    g.addColorStop(0, 'rgba(26,18,8,0.85)');
    g.addColorStop(0.55, 'rgba(26,18,8,0.35)');
    g.addColorStop(1, 'rgba(26,18,8,0)');
    ctx.save();
    ctx.scale(1, 80 / 240);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 240, 240);
    ctx.restore();
    mapa.addImage('stin-pata', ctx.getImageData(0, 0, 240, 80), { pixelRatio: 2 });
  } catch (e) { console.warn('[stin-pata]', e); }
}
window.zajistiStinPatu = zajistiStinPatu;

function nastavStinyMist(sv, st) {
  try {
    if (!sv || !mapa) return;
    zajistiStinPatu();
    let sila = 0;
    if (sv.zdroj === 'slunce') {
      sila = 0.42 * Math.max(0.45, Math.min(1, (sv.el || 0) / 25));
    } else if (sv.zdroj === 'mesic') {
      sila = 0.20 * Math.max(0.3, Math.min(1, (st && st.mesicOsvit) || 0.5));
    }
    if (st && typeof st.oblacnost === 'number') sila *= (1 - 0.6 * st.oblacnost);
    const elRad = Math.max(8, Math.min(80, sv.el || 45)) * Math.PI / 180;
    const delka = 66 * Math.max(0.25, Math.min(2.2, 1 / Math.tan(elRad)));
    const smer = ((sv.az || 0) + 180) * Math.PI / 180;
    stinMistOffset = [+(Math.sin(smer) * delka).toFixed(1),
                      +(-Math.cos(smer) * delka).toFixed(1)];
    stinMistSila = +sila.toFixed(3);
    if (mapa.getLayer('okolnik-mista-pata')) {
      mapa.setPaintProperty('okolnik-mista-pata', 'icon-opacity',
                            ['*', ['case', ['has', 'tl'], 0.38, 1],
                             +(0.30 + 0.5 * stinMistSila).toFixed(3)]);
    }
    if (mapa.getLayer('okolnik-mista-stin')) {
      mapa.setLayoutProperty('okolnik-mista-stin', 'icon-offset', stinMistOffset);
      // 0.38 = TLUM (lokální konstanta vrstvy ikon, sem nedosáhne)
      mapa.setPaintProperty('okolnik-mista-stin', 'icon-opacity',
                            ['*', ['case', ['has', 'tl'], 0.38, 1], stinMistSila]);
    }
  } catch (e) { console.warn('[stiny mist]', e); }
}
window.nastavStinyMist = nastavStinyMist;

function zajistiIkonu(id) {
  if (typeof id !== 'string') return Promise.resolve(false);
  // bubliny 2D značek se kreslí hned, bez fetch
  if (id.startsWith('emoji|') || id.startsWith('brand|')) {
    if (!mapa) return Promise.resolve(false);
    if (mapa.hasImage(id)) return Promise.resolve(true);
    try {
      // ⚡ v1.377: i bublina umí černobílou variantu `…#bw` — v herním
      // režimu ji dostávají neobjevená místa kategorií bez malované
      // kresby (dřív tečka). Šedivka přes malý canvas (300 px) je levná;
      // ctx.filter je zakázaný jen na VELKÉ plochy (viz mlha).
      const bw = id.endsWith('#bw');
      let data = nakresliZnacku(bw ? id.slice(0, -3) : id);
      if (bw) {
        const a = document.createElement('canvas');
        a.width = data.width; a.height = data.height;
        a.getContext('2d').putImageData(data, 0, 0);
        const b = document.createElement('canvas');
        b.width = data.width; b.height = data.height;
        const bc = b.getContext('2d');
        bc.filter = 'grayscale(1) brightness(0.92)';
        bc.drawImage(a, 0, 0);
        data = bc.getImageData(0, 0, b.width, b.height);
      }
      mapa.addImage(id, data, { pixelRatio: 2 });
      return Promise.resolve(true);
    } catch (e) {
      console.warn('[most] značka nejde nakreslit', id, e);
      return Promise.resolve(false);
    }
  }
  if (!id.startsWith('/assets/')) {
    return Promise.resolve(false);
  }
  if (!mapa) return Promise.resolve(false);
  if (mapa.hasImage(id)) return Promise.resolve(true);
  const selhalo = ikonySelhane.get(id);
  if (selhalo && (selhalo.pokusu >= IKONA_POKUSU
      || performance.now() - selhalo.kdy < IKONA_PAUZA_MS)) {
    return Promise.resolve(false);
  }
  const bezici = ikonyRozpracovane.get(id);
  if (bezici) return bezici; // souběžné volání čeká na tentýž fetch
  const prace = (async () => {
    try {
      // ⭐ 5. 9. 2026: '#stin' = stín obrázku (tmavá zploštělá silueta,
      // Ilustrace.stin), může být i za '#bw' ('…webp#bw#stin')
      const stin = id.endsWith('#stin');
      const zakladId = stin ? id.slice(0, -5) : id;
      const bw = zakladId.endsWith('#bw');
      const soubor = bw ? zakladId.slice(0, -3) : zakladId;
      const odpoved = await fetch(soubor);
      if (!odpoved.ok) throw new Error('HTTP ' + odpoved.status);
      let bitmapa = await createImageBitmap(await odpoved.blob());
      // ⚠️ POJISTKA VELIKOSTI (v1.246). `icon-size` NÁSOBÍ pixelovou
      // velikost zdroje, takže širší export (jednou dorazily kresby
      // 724 px vedle běžných 280 px) by se kreslil úměrně VĚTŠÍ a
      // nafoukl atlas. Cokoli nad 450 px se před vložením zmenší.
      if (bitmapa.width > 450) {
        const mensi = await createImageBitmap(bitmapa, {
          resizeWidth: 450,
          resizeHeight: Math.round(bitmapa.height * 450 / bitmapa.width),
          resizeQuality: 'high',
        });
        bitmapa.close();
        bitmapa = mensi;
      }
      // kresby jsou ~320–450 px; pixelRatio 2 → rozumný základ v CSS px
      if (!mapa.hasImage(id)) {
        const data = stin ? Ilustrace.stin(bitmapa)
          : (bw ? odbarvi(bitmapa) : bitmapa);
        mapa.addImage(id, data, { pixelRatio: 2 });
      }
      bitmapa.close();
      if (ikonySelhane.has(id)) {
        ikonySelhane.delete(id);
        preparsujMistaPozdeji();   // symboly vznikly bez ní, viz výš
      }
      return true;
    } catch (e) {
      const d = ikonySelhane.get(id) || { pokusu: 0, kdy: 0 };
      d.pokusu++;
      d.kdy = performance.now();
      ikonySelhane.set(id, d);
      // ⚠️ VYPSAT `name: message`, ne objekt. `console.warn(…, e)` s
      // DOMException dá do logu jen „[object DOMException]" a příčina
      // (dekódování? síť? velikost?) se ztratí — hodinu jsem podle toho
      // hledal naslepo.
      console.warn('[most] ikona nejde načíst (pokus ' + d.pokusu + ') '
          + id + ' — ' + ((e && (e.name + ': ' + e.message)) || e));
      if (d.pokusu >= IKONA_POKUSU) {
        nasadNahradniBublinu(id);
      } else {
        // ⛔ POKUS SI MUSÍME NAPLÁNOVAT SAMI. `styleimagemissing`
        // MapLibre pro totéž id znovu nevystřelí — chybějící obrázek si
        // pamatuje — takže „druhá šance po 20 s" by bez téhle řádky
        // nikdy nenastala a čekala by až na to, až appka pošle jiný
        // seznam míst.
        setTimeout(() => { zajistiIkonu(id); }, IKONA_PAUZA_MS + 500);
      }
      return false;
    } finally {
      ikonyRozpracovane.delete(id);
    }
  })();
  ikonyRozpracovane.set(id, prace);
  return prace;
}

/// ⛔⛔ v1.516: NÁHRADNÍ BUBLINA — MÍSTO NESMÍ ZMIZET.
///
/// Výtka: *„na druhém telefonu nevidím všechny obrázky, relativně
/// náhodně… v psaném seznamu ta místa jsou, po kliknutí najde pozici,
/// ale obrázek tam není."*
///
/// Proč to zmizí ÚPLNĚ: místo s vlastní kresbou nese vlastnost `ik`
/// a vrstvy jsou postavené proti sobě —
///   `okolnik-mista-kruh`  kreslí tečku, ale jen když `ik` NEMÁ,
///   `okolnik-mista-ikona` kreslí obrázek podle `ik`.
/// Když se tedy kresba nestáhne, tečka se nenakreslí (protože `ik` tam
/// je) a obrázek taky ne (protože v atlasu chybí) — a místo z mapy
/// vypadne, přestože v seznamu i v datech dál je. Přesně to hlášení.
///
/// Náhradní bublina zaručí, že tam vždycky něco zůstane: pod týmž id
/// se do atlasu vloží obecná značka, takže se místo kreslí dál — jen
/// bez své malované podoby.
function nasadNahradniBublinu(id) {
  try {
    if (!mapa || mapa.hasImage(id)) return;
    // stejná bublina jako u kategorií bez kresby (šedomodrá, špendlík)
    mapa.addImage(id, nakresliZnacku('emoji|📍|#5B6B75'), { pixelRatio: 2 });
    console.warn('[most] kresba se nedá načíst, kreslím náhradní'
                 + ' bublinu:', id);
    preparsujMistaPozdeji();
  } catch (e) { console.warn('[most] náhradní bublina selhala', id, e); }
}

/// Dotáhne kresby, na které odkazuje právě posílaná kolekce míst.
/// Po výměně stylu MapLibre atlas ikon zahodí, takže se volá znovu
/// (soubory jdou z HTTP keše, takže to nic nestojí).
///
/// ⚠️ NA ZÁVĚR SE ZDROJ PŘEPÍŠE ZNOVU. Obrázek přidaný `addImage` AŽ PO
/// rozparsování zdroje se do hotových symbolů sám nepromítne – značky
/// zůstanou neviditelné, i když je kresba v atlasu (ověřeno na zařízení:
/// „ikona + …#bw" v logu, ale na mapě nic). `setData` si vynutí nové
/// rozparsování, tentokrát už s kresbami po ruce.
/// ⛔⛔ v1.551: NEÚSPĚŠNÁ IKONA SE MUSÍ SAMA PŘIPOMENOUT.
///
/// Výtka: *„Vrch Kupa ukazuje název na stuze, ale obrázek jen velmi
/// občas."* Stuha je jiná vrstva s jiným (předem nahraným) obrázkem,
/// takže se kreslí vždycky — chybí jen kresba místa.
///
/// Díra byla v součinnosti dvou pojistek:
///   • `zajistiIkonu` po neúspěchu 20 s NIC nezkouší (aby se nezahltila
///     síť) a po třech pokusech to vzdá nadobro,
///   • aplikace posílá seznam míst **jen při jeho změně** (otisk podle
///     počtu a prvního id).
/// Když tedy kresba jednou selhala a člověk zůstal stát, seznam se
/// nezměnil, `nactiIkonyZdroje` se už nespustilo — a nebyl nikdo, kdo
/// by pokus zopakoval. Místo zůstalo bez obrázku, dokud se nešlo jinam.
///
/// Nově se po neúspěchu naplánuje opakování hned po skončení pauzy.
/// ⚠️ Jen dokud zbývají pokusy — jinak by se to připomínalo navěky.
let opakovaniIkon = null;

function naplanujOpakovaniIkon(ids) {
  if (opakovaniIkon) return;
  const zbyva = [...ids].some((id) => {
    const s = ikonySelhane.get(id);
    return !mapa.hasImage(id) && (!s || s.pokusu < IKONA_POKUSU);
  });
  if (!zbyva) return;
  opakovaniIkon = setTimeout(() => {
    opakovaniIkon = null;
    if (poslednGjMist) {
      console.log('[ikony] opakuji pokus o nedotažené kresby');
      nactiIkonyZdroje(poslednGjMist);
    }
  }, IKONA_PAUZA_MS + 1500);
}

async function nactiIkonyZdroje(gj, zdrojId) {
  const ids = new Set();
  for (const f of gj.features) {
    if (f.properties && f.properties.ik) ids.add(f.properties.ik);
  }
  if (!ids.size) return;
  const vysledky = await Promise.all([...ids].map((id) => zajistiIkonu(id)));
  if (vysledky.includes(false)) naplanujOpakovaniIkon(ids);
  // ⭐ Diagnostika k hlášení „stuha s kresbou se objevuje velmi náhodně".
  // Výpadek se nedaří vyvolat na povel, tak ať po sobě aspoň nechá stopu:
  // tohle vypíše, které kresby v atlasu chybí ve chvíli, kdy se do zdroje
  // zapisují místa — právě ta se pak nenakreslí.
  try {
    const chybi = [...ids].filter((id) => !mapa.hasImage(id));
    if (chybi.length) {
      console.warn('[ikony] v atlasu chybí ' + chybi.length + ' z '
          + ids.size + ': ' + chybi.slice(0, 4).join(', '));
    }
  } catch (e) { /* diagnostika nesmí nic shodit */ }
  if (zdrojId && zdrojId !== 'okolnik-mista') {
    const z2 = mapa && mapa.getSource(zdrojId);
    if (z2) z2.setData(gj);
    return;
  }
  // ⚠️ PŘEPARSOVAT VŽDY, ne jen „když jsem něco přidal já". Když kresby
  // dotáhl souběžný běh, tahle větev dřív zdroj nepřepsala a symboly
  // slepené bez obrázků (parse proběhl dřív než fetch) zůstaly prázdné
  // – na stylech se spritem (Základní/Liberty) je `styleimagemissing`
  // nezachrání, protože se pro ně vůbec nespouští.
  const zdroj = mapa && mapa.getSource('okolnik-mista');
  if (zdroj) zdroj.setData(gj);
}

/// ⚠️ KLIK NA MÍSTO SE SMÍ REGISTROVAT JEN JEDNOU (v1.226.2).
/// Vrstvy se po každé výměně stylu zakládají znovu, takže `mapa.on('click',
/// vrstva, …)` uvnitř `vykresliMista` přidával DALŠÍHO posluchače. Po
/// vstupu do hry (= jedna výměna stylu) hlásil most `onBod` dvakrát a
/// aplikace otevřela DVA pergamenové detaily přes sebe (výtka uživatele
/// „vyskočí ty pop up okna dvě"). Posluchač na ID vrstvy přežije i to,
/// když je vrstva mezitím zahozená a založená znovu.
let hookKlikuMist = false;

/// Od kterého zoomu nabídne klik na shluk SEZNAM členů místo přiblížení
/// a kolik jich pustíme do panelu aplikace. Shluky existují jen pod
/// `clusterMaxZoom` (13), takže vyšší práh by seznam nikdy nespustil;
/// strop 8 řádků se vejde do spodního panelu, který se neroluje.
const SHLUK_SEZNAM_ZOOM = 13;
const SHLUK_SEZNAM_MAX = 8;

function registrujKlikMista() {
  if (hookKlikuMist || !mapa) return;
  hookKlikuMist = true;
  for (const vrstva of ['okolnik-mista-kruh', 'okolnik-mista-ikona']) {
    mapa.on('click', vrstva, (e) => {
      const f = e.features && e.features[0];
      if (window.Dobyvatel && Dobyvatel.spolklKlik(e)) return;
      if (f) mostHlas('onBod', f.properties.id);
    });
  }
  // ⭐ KLIK NA SHLUK: zblízka SEZNAM ČLENŮ, z dálky přiblížit (7. 8. 2026).
  // ⚠️ 2D pravidlo „zoom >= 15 → seznam" sem NEJDE přenést doslova: 2D
  // shlukuje mřížkou v pixelech, takže shluk drží i při největším
  // přiblížení, kdežto MapLibre nad `clusterMaxZoom` (13) shluky vůbec
  // nedělá – expanzní zoom je proto vždycky vyšší než ten současný a na
  // seznam by nikdy nedošlo. Rozhoduje tedy pásmo, kde shluky ještě
  // existují, a počet členů (hromadu je rychlejší rozpadnout zoomem).
  mapa.on('click', 'okolnik-mista-shluk', (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    const zdroj = mapa.getSource('okolnik-mista');
    if (!zdroj) return;
    const cid = f.properties.cluster_id;
    const pocet = f.properties.point_count || 0;
    if (mapa.getZoom() >= SHLUK_SEZNAM_ZOOM && pocet <= SHLUK_SEZNAM_MAX
        && zdroj.getClusterLeaves) {
      zdroj.getClusterLeaves(cid, SHLUK_SEZNAM_MAX, 0).then((body) => {
        const ids = (body || [])
            .map((b) => (b && b.properties && b.properties.id) || '')
            .filter((s) => s);
        // kdyby se ids nepodařilo vytáhnout, ať klik aspoň přiblíží
        if (window.Dobyvatel && Dobyvatel.spolklKlik(e)) return;
        if (ids.length) mostHlas('onShluk', ids);
        else priblizShluk(zdroj, cid, f);
      }).catch(() => priblizShluk(zdroj, cid, f));
      return;
    }
    priblizShluk(zdroj, cid, f);
  });
}

/// Přiblížení na zoom, kde se shluk rozpadne (původní chování kliku).
function priblizShluk(zdroj, cid, f) {
  if (!mapa || !zdroj || !zdroj.getClusterExpansionZoom) return;
  zdroj.getClusterExpansionZoom(cid).then((z) => {
    mapa.easeTo({ center: f.geometry.coordinates, zoom: z,
                  duration: 500, essential: true });
  }).catch(() => {});
}

/// ⭐ v1.438 (A): KLIK NA POI PODKLADOVÉ MAPY. Dlaždice (OSM) kreslí
/// mnohem víc cílů, než má Okolník v databázi — ať jsou klikací.
/// Obecný posluchač běží VEDLE vrstvových: když v okolí doteku leží
/// klikací překryv Okolníku (symbol/kruh z okolnik-*/ilus-*), přednost
/// má on a tady se končí; čáry (trasy, značené cesty) klik neblokují.
/// Ve hře (styl s mlhou) se podklad NEproklikává — queryRenderedFeatures
/// vrací i prvky pod mlhou a klik by prozradil neobjevená místa.
let hookKlikuPoi = false;
function registrujKlikPoi() {
  if (hookKlikuPoi || !mapa) return;
  hookKlikuPoi = true;
  mapa.on('click', (e) => {
    if (!APP_REZIM) return;
    try {
      const stl = (typeof STYLY !== 'undefined'
          && typeof aktualniKod !== 'undefined') ? STYLY[aktualniKod] : null;
      if (stl && stl.mlha) return;
      const o = 10;
      const prvky = mapa.queryRenderedFeatures(
          [[e.point.x - o, e.point.y - o], [e.point.x + o, e.point.y + o]]);
      for (const f of prvky) {
        const typ = f.layer && f.layer.type;
        const zdroj = String(f.source || '');
        if (zdroj.indexOf('okolnik-') === 0 || zdroj.indexOf('ilus-') === 0) {
          if (typ === 'symbol' || typ === 'circle') return;
          continue;
        }
        const sl = f.sourceLayer || '';
        if (sl !== 'poi' && sl !== 'mountain_peak'
            && sl !== 'aerodrome_label') continue;
        if (typ !== 'symbol' && typ !== 'circle') continue;
        const pp = f.properties || {};
        const jmeno = String(pp['name:cs'] || pp.name
            || pp['name:latin'] || '').trim();
        // ⭐ v1.439: i BEZEJMENNÝ symbol reaguje („některé ikonky
        // nereagují“) — název doplní appka českým druhem
        if (!jmeno && !pp.class && !pp.subclass) continue;
        const g = (f.geometry && f.geometry.type === 'Point'
            && f.geometry.coordinates)
            ? f.geometry.coordinates : [e.lngLat.lng, e.lngLat.lat];
        // potlačené (zprůhledněné) ikony pod bublinou nesmí chytat
        // klik — vstupem je bublina Okolníku
        const mistaP = posledniMista || [];
        if (mistaP.some((mm) => Math.abs(mm.lat - g[1]) < 0.0003
            && Math.abs(mm.lng - g[0]) < 0.00045)) continue;
        if (window.Dobyvatel && Dobyvatel.spolklKlik(e)) return;
        mostHlas('onPoi', {
          n: jmeno, lat: g[1], lon: g[0], sl: sl,
          cls: String(pp.class || ''), sub: String(pp.subclass || ''),
          ele: (pp.ele === undefined || pp.ele === null)
              ? null : Number(pp.ele),
        });
        return;
      }
    } catch (err) { console.warn('[most] klikPoi', err); }
  });
}

/// ⭐ v1.438 (B): DVOJENÍ IKON — týž podnik jednou jako bublina
/// Okolníku a hned vedle podruhé jako ikona podkladu. Ikony podkladu
/// do ~30 m od poslaných míst se ZPRŮHLEDNÍ přes paint + ['within']
/// (filtr skládat NEJDE: legacy filtry se s výrazy míchat nesmějí;
/// průhlednost je na filtru nezávislá — ověřeno živě na Liberty).
/// Původní hodnota se při změně míst vrací; legacy „stops“ objekt
/// do výrazu vnořit nejde, taková vlastnost se přeskakuje.
const puvodniPrusvitnost = new Map();
function potlacDuplicity() {
  // ⚠ ŽÁDNÁ brána isStyleLoaded — v praxi není skoro nikdy true (táž
  // past jako u terénu) a potlačení se přes ni TIŠE nikdy nenasadilo;
  // chybějící vrstvy odchytá try/catch u každé vlastnosti zvlášť.
  if (!mapa || !mapa.getStyle) return;
  try {
    const R = 0.00028;   // ~31 m na severu Čech
    const kruhy = [];
    for (const m of (posledniMista || [])) {
      if (typeof m.lat !== 'number' || typeof m.lng !== 'number') continue;
      const rx = R / Math.max(0.2, Math.cos(m.lat * Math.PI / 180));
      kruhy.push([[[m.lng - rx, m.lat - R], [m.lng + rx, m.lat - R],
                   [m.lng + rx, m.lat + R], [m.lng - rx, m.lat + R],
                   [m.lng - rx, m.lat - R]]]);
    }
    const uvnitr = kruhy.length
        ? ['within', { type: 'MultiPolygon', coordinates: kruhy }] : null;
    for (const v of (mapa.getStyle().layers || [])) {
      if (v.type !== 'symbol' && v.type !== 'circle') continue;
      const sl = v['source-layer'];
      if (sl !== 'poi' && sl !== 'mountain_peak'
          && sl !== 'aerodrome_label') continue;
      // ⭐ v1.439: v Základní (Liberty) se cizí POI NEKRESLÍ VŮBEC —
      // „na místo značek Liberty dej naše ikonky s popup oknem“.
      // Skrytí LAYOUTEM je vyřadí i z queryRenderedFeatures (žádné
      // neviditelné kliky) a běží už ze style.load, DŘÍV než se
      // poprvé vykreslí — konec probliknutí modrého textu zastávek.
      if (typeof aktualniKod !== 'undefined' && aktualniKod === 'zakladni') {
        try {
          if (mapa.getLayoutProperty(v.id, 'visibility') !== 'none') {
            mapa.setLayoutProperty(v.id, 'visibility', 'none');
          }
        } catch (err) { /* vrstva bez layoutu */ }
        continue;
      }
      const vlastnosti = v.type === 'circle'
          ? ['circle-opacity', 'circle-stroke-opacity']
          : ['icon-opacity', 'text-opacity'];
      for (const pj of vlastnosti) {
        const klic = v.id + '|' + pj;
        try {
          const ted = mapa.getPaintProperty(v.id, pj);
          const nase = Array.isArray(ted) && ted[0] === 'case'
              && Array.isArray(ted[1]) && ted[1][0] === 'within';
          const orig = nase ? puvodniPrusvitnost.get(klic) : ted;
          if (!nase) {
            puvodniPrusvitnost.set(klic, orig === undefined ? null : orig);
          }
          if (!uvnitr) {
            if (nase) {
              mapa.setPaintProperty(v.id, pj,
                  orig == null ? undefined : orig);
            }
            continue;
          }
          if (orig && typeof orig === 'object' && !Array.isArray(orig)) {
            continue;
          }
          mapa.setPaintProperty(v.id, pj,
              ['case', uvnitr, 0, (orig == null ? 1 : orig)]);
        } catch (err) { /* nevhodný paint — vrstva zůstává beze změny */ }
      }
    }
  } catch (e) { console.warn('[most] potlacDuplicity', e); }
}

function registrujHookIkon() {
  if (hookIkon || !mapa) return;
  hookIkon = true;
  // záložní cesta (styly bez spritu ji používají)
  mapa.on('styleimagemissing', (e) => zajistiIkonu(e && e.id));
  // Nová místa po objevení posílá APLIKACE (zná svou mlhu) – engine si
  // je sám nedopočítává.
}

// ⚠️ MLHU FILTRUJE APLIKACE (v1.226), engine kreslí, co dostane. Okolník
// má zdroj pravdy o odkryté ploše (TrailStore: buňky štětce + dokončené
// obce); engine má jen kopii kruhů a oba se rozcházely.
function mistaViditelna() {
  return posledniMista;
}

/// ⭐⭐ v1.520: ODZNAK „POTVRDIT NÁVŠTĚVU" PŘÍMO U KRESBY.
///
/// Zadání: *„když je uživatel fyzicky dle GPS vedle místa, tak se mu
/// vedle obrázku ukáže potvrdit návštěvu; při kliknutí dojde
/// k potvrzení."*
///
/// ⛔ CO SE NESMÍ: přišpendlit Flutter tlačítko k místu na mapě. To by
/// znamenalo promítat souřadnice na obrazovku při každém snímku —
/// a `project()` se zapnutým terénem LŽE (promítá na kopce) a je 170×
/// pomalejší; DOM značky navíc platí `readPixels` za test zákrytu.
/// Odznak proto kreslí engine jako obyčejný SYMBOL mapy: nula práce
/// navíc na snímek, protože se o něj stará tentýž kolizní systém jako
/// o zbytek značek.
///
/// Aplikace pošle id místa (`OkolnikMost.nabidkaNavstevy`), vrstva má
/// filtr na to jediné id a klik hlásí zpátky `onPotvrdit`.
/// Ikona odznaku „potvrdit návštěvu". ⛔ MUSÍ TO BÝT EMOJI, ne
/// dingbat: `✔` (U+2714) se v canvasu WebView nevykreslí vůbec —
/// bublina vyjde prázdná (změřeno: 0 % tmavých pixelů uprostřed
/// proti 59 % u ✅).
const IKONA_ODZNAKU = 'emoji|✅|#2E7D5B';
let idNabidkyNavstevy = null;
/// Poslední GeoJSON míst — `zdroj._data` NENÍ použitelný: MapLibre v6
/// tam drží obal `{geojson: …}`, ne kolekci, takže `setData(zdroj._data)`
/// by zdroj rozbil. (Zjištěno při ladění odznaku návštěvy.)
let poslednGjMist = null;

function nasadOdznakNavstevy() {
  if (!mapa) return;
  // ⛔ PO VÝMĚNĚ STYLU JSOU VRSTVY PRYČ a `vykresliMista` se nemusí
  // vůbec spustit — má na začátku podpisovou bránu, a když se seznam
  // míst nezměnil, rovnou se vrátí. Odznak by pak v herním režimu
  // nikdy nevznikl (změřeno: zdroje existují, vrstvy odznaků ne).
  // Proto se sem chodí i z `aplikujDoplnky` a chybějící zdroj se
  // zkusí znovu.
  if (!mapa.getSource('okolnik-mista')
      || !mapa.getLayer('okolnik-mista-ikona')) {
    const n = (nasadOdznakNavstevy._pokusu || 0) + 1;
    nasadOdznakNavstevy._pokusu = n;
    if (n < 25) {
      clearTimeout(nasadOdznakNavstevy._t);
      nasadOdznakNavstevy._t = setTimeout(nasadOdznakNavstevy, 400);
    }
    return;
  }
  nasadOdznakNavstevy._pokusu = 0;
  if (!mapa.getLayer('okolnik-navsteva-odznak')) {
    mapa.addLayer({
      id: 'okolnik-navsteva-odznak',
      type: 'symbol',
      source: 'okolnik-mista',
      // filtr, který nikdy nic nepustí — dokud appka nepošle id
      filter: ['==', ['get', 'id'], '\u0000'],
      layout: {
        // bublinu s fajfkou nakreslí `nakresliZnacku` na požádání
        // (`styleimagemissing` → zajistiIkonu), žádný nový asset
        // ⛔ MUSÍ TO BÝT EMOJI, NE DINGBAT. Zkoušeno U+2714 (✔) —
        // bublina se nakreslila, ale PRÁZDNÁ: písmo WebView pro ten
        // znak nemá glyf a canvas vykreslil nic. Změřeno podílem
        // tmavých pixelů uprostřed bubliny: U+2714 = 0 %, U+2705 = 59 %.
        'icon-image': IKONA_ODZNAKU,
        'icon-size': 0.16,
        'icon-anchor': 'center',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {
        // ⚠️ POSUN V PIXELECH OBRAZOVKY (`icon-translate`), ne
        // `icon-offset`: ten se násobí `icon-size` a odznak by se
        // s přiblížením odplazil pryč od značky.
        'icon-translate': [20, -34],
        'icon-translate-anchor': 'viewport',
      },
    });
    mapa.on('click', 'okolnik-navsteva-odznak', (e) => {
      try {
        const f = e.features && e.features[0];
        const id = f && f.properties && f.properties.id;
        if (!id) return;
        if (e.originalEvent) e.originalEvent.stopPropagation();
        mostHlas('onPotvrdit', { id: String(id) });
      } catch (err) { console.warn('[most] odznak návštěvy', err); }
    });
  }
  mapa.setFilter('okolnik-navsteva-odznak',
      ['==', ['get', 'id'], idNabidkyNavstevy || '\u0000']);
  nasadOdznakIlustrace();
  // ⛔⛔ BEZ PŘEPARSOVÁNÍ SE ODZNAK NEUKÁŽE. Symboly dlaždice se
  // rozparsují jednou; obrázek přidaný `addImage` AŽ POTÉ se do nich
  // sám nepromítne — vrstva má správný filtr, obrázek je v atlasu
  // a přesto `queryRenderedFeatures` vrací NULU (změřeno). Tatáž past,
  // kvůli které `nactiIkonyZdroje` na závěr přepisuje zdroj.
  if (idNabidkyNavstevy) {
    try { zajistiIkonu(IKONA_ODZNAKU); } catch (e) { /* nevadi */ }
    preparsujMistaPozdeji();
  }
}

/// ⭐ v1.521: TÝŽ ODZNAK I U MALOVANÝCH MÍST.
///
/// Kresby Kroniky nejsou v `okolnik-mista`, ale ve vlastním zdroji
/// `ilus-obrazky` (vlastnost `s` = slug), takže potřebují vlastní
/// vrstvu. Id z aplikace má u nich tvar `illus:<slug>`.
///
/// ⚠️ Vrstva vzniká, až když zdroj existuje — `ilus-obrazky` je jen
/// v herním stylu (Kronika), jinde by `addLayer` spadl. A to je i
/// záměr: neherní mapa má zůstat odlehčená, na orientaci.
function nasadOdznakIlustrace() {
  if (!mapa || !mapa.getSource('ilus-obrazky')) return;
  const slug = (idNabidkyNavstevy || '').startsWith('illus:')
      ? idNabidkyNavstevy.slice(6)
      : null;
  if (!mapa.getLayer('ilus-navsteva-odznak')) {
    try { zajistiIkonu(IKONA_ODZNAKU); } catch (e) { /* nevadí */ }
    mapa.addLayer({
      id: 'ilus-navsteva-odznak',
      type: 'symbol',
      source: 'ilus-obrazky',
      filter: ['==', ['get', 's'], '\u0000'],
      layout: {
        'icon-image': IKONA_ODZNAKU,
        'icon-size': 0.18,
        'icon-anchor': 'center',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {
        // kresby jsou větší než bubliny POI, tak odznak dál od středu
        'icon-translate': [42, -46],
        'icon-translate-anchor': 'viewport',
      },
    });
    mapa.on('click', 'ilus-navsteva-odznak', (e) => {
      try {
        const f = e.features && e.features[0];
        const sl = f && f.properties && f.properties.s;
        if (!sl) return;
        if (e.originalEvent) e.originalEvent.stopPropagation();
        mostHlas('onPotvrdit', { id: 'illus:' + sl });
      } catch (err) { console.warn('[most] odznak kresby', err); }
    });
  }
  mapa.setFilter('ilus-navsteva-odznak',
      ['==', ['get', 's'], slug || '\u0000']);
}

function vykresliMista() {
  if (!mapa) return;
  // ⚠️ PO VÝMĚNĚ STYLU JEŠTĚ CHVÍLI `isStyleLoaded() === false`. Dřív se
  // tu prostě skončilo → místa Okolníku se po přepnutí stylu (např. do
  // herního) UŽ NIKDY nevykreslila, protože appka je posílá jen při
  // změně. Teď se to za chvíli zkusí znovu.
  if (!mapa.isStyleLoaded()) {
    clearTimeout(vykresliMista._t);
    vykresliMista._t = setTimeout(vykresliMista, 250);
    return;
  }
  const vsechna = mistaViditelna();
  // ⚡ PODPISOVÁ BRÁNA (12. 8. 2026, kampaň sekání): appka posílá seznam
  // míst při každém hlášení výřezu, i beze změny — a každý setData
  // přetiluje shlukovaný zdroj se stovkami míst (změřeno: 2× LD +
  // 8× reloadTile okolnik-mista za JEDNO štípnutí). Stejný vzor jako
  // v ilustrace.js: beze změny podpisu se nesahá na zdroj. Výměna stylu
  // zdroje smaže → getSource je null → projde se dál i se stejným podpisem.
  const podpisMist = vsechna.map((m) => m.id + '' + (m.ik || '')
      + '' + (m.b || '') + '' + (m.nav ? 1 : 0)
      + '' + (m.t || '')).join('');
  if (mapa.getSource('okolnik-mista') && mapa.getSource('okolnik-moje')
      && podpisMist === vykresliMista._podpis) return;
  vykresliMista._podpis = podpisMist;
  // ⭐ VLASTNÍ ZÁLOŽKY SE NESHLUKUJÍ (6. 8. 2026, výtka „vložil jsem zálohu,
  // procházka nemá svoji ikonu a nedá se otevřít"). Oblíbená, soukromá
  // místa a špendlíky výprav/zápisů šly do TÉHOŽ zdroje jako POI, takže je
  // pod zoomem 13 MapLibre slil do zeleného kolečka s číslem – a protože
  // vrstva ikon shluky odfiltruje, nebylo nač kliknout. Ve 2D jsou to
  // vlastní vrstvy MIMO shlukování; tady tedy taky.
  const MOJE = /^(fav|priv|trip|zapis):/;
  const viditelnaVse = vsechna.filter((m) => !MOJE.test(String(m.id)));
  const mojeMista = vsechna.filter((m) => MOJE.test(String(m.id)));
  // ⭐ v1.405 (bod B): POSTUPNÉ ROZENÍ. Nová POI (v téhle relaci
  // ještě neviděná) naskáčou po jednom à 180 ms — místo dávkového
  // „bum“ vlnka od nejdůležitějších (pořadí dává appka). Jedno až
  // dvě nová místa jdou rovnou (divadlo kvůli jednomu nemá smysl).
  // Známá id se NEzapomínají (návrat na místo rození neopakuje).
  const znama = vykresliMista._znama || (vykresliMista._znama = new Set());
  if (znama.size > 8000) znama.clear();
  const nova = viditelnaVse.filter((m) => !znama.has(String(m.id)));
  let viditelna = viditelnaVse;
  clearInterval(vykresliMista._rozeni);
  if (nova.length <= 2) {
    for (const m of nova) znama.add(String(m.id));
  } else {
    viditelna = viditelnaVse.filter((m) => znama.has(String(m.id)));
    vykresliMista._fronta = nova;
    vykresliMista._rozeni = setInterval(() => {
      const dalsi = (vykresliMista._fronta || []).shift();
      if (!dalsi) { clearInterval(vykresliMista._rozeni); return; }
      znama.add(String(dalsi.id));
      vykresliMista._podpis = null;   // vynutit průchod braným podpisem
      try { vykresliMista(); } catch (e) { /* příští tik */ }
    }, 180);
  }
  const naFeature = (m) => {
      const bublina = typeof m.ik === 'string'
          && (m.ik.startsWith('emoji|') || m.ik.startsWith('brand|'));
      // popisek pod značkou posílá aplikace (datum záznamu). Kreslí ho
      // jen nezhlukovaná vrstva `okolnik-moje-ikona`; u POI `t` nechodí.
      const stitek = (typeof m.t === 'string' && m.t) ? { t: m.t } : {};
      return {
        type: 'Feature',
        properties: m.ik
            ? { id: m.id, b: m.b || '#E07B39', ...stitek,
                // bublina 2D značky se kreslí menší než malovaná kresba
                // (výtka „značky po přiblížení zakrývají moc mapy")
                ...(bublina ? { b2d: 1 } : {}),
                // OBLÍBENÁ (v1.247): zlatá hvězda musí být k nalezení –
                // kreslí se větší než běžné bubliny (viz icon-size)
                ...(String(m.id).startsWith('fav:') ? { fv: 1 } : {}),
                // nenavštívené kreslíme odbarveně (viz odbarvi)
                ik: m.nav ? m.ik : m.ik + '#bw' }
            : { id: m.id, b: m.b || '#E07B39', ...stitek },
        geometry: { type: 'Point', coordinates: [m.lng, m.lat] },
      };
  };
  const gj = { type: 'FeatureCollection', features: viditelna.map(naFeature) };
  const gjMoje = {
    type: 'FeatureCollection', features: mojeMista.map(naFeature),
  };
  // ⚠️ KRESBY SI VYŽÁDÁME SAMI, NESPOLÉHAT NA `styleimagemissing`
  // (v1.226.1). Ve stylech se SPRITEM (Základní = OpenFreeMap Liberty)
  // se událost pro naše ikony vůbec nespustila – MapLibre jen napsal do
  // konzole „Image … could not be loaded" a značky zůstaly neviditelné.
  // Unikátních kreseb je pár desítek (druhy POI + kresby v dohledu),
  // takže je levné dotáhnout přesně ty, které jsou ve zdroji.
  poslednGjMist = gj;   // ⭐ v1.520: na přeparsování (viz níž)
  nactiIkonyZdroje(gj, 'okolnik-mista');
  nasadOdznakNavstevy();   // ⭐ v1.520: vrstva odznaku patří nad místa
  nactiIkonyZdroje(gjMoje, 'okolnik-moje');
  vykresliMojeMista(gjMoje);
  const zdroj = mapa.getSource('okolnik-mista');
  if (zdroj) { zdroj.setData(gj); potlacDuplicity(); return; }
  registrujHookIkon();
  // ⭐ SHLUKOVÁNÍ (6. 8. 2026, „při oddálení se ukazuje moc míst z velké
  // vzdálenosti – shlukovat jako ve 2D"). Dělá ho MapLibre nad zdrojem;
  // nad `clusterMaxZoom` se zase rozpadne na jednotlivé značky, takže
  // zblízka se nic nemění. Ušetří to i výkon: místo stovek symbolů
  // s vlastní ikonou se kreslí pár koleček s číslem.
  mapa.addSource('okolnik-mista', {
    // ⛔ maxzoom MUSÍ být NAD clusterMaxZoom (poučení v1.415): strop 14
    // z kampáně řezů zmrazil shluky — dlaždice z14 byla poslední
    // a blízká místa (týž dům) zůstala slitá „i po úplném
    // přiblížení“. Zdroj má po rozpočtu ≤24 prvků — přeřezávání
    // do z17 je zadarmo.
    type: 'geojson', data: gj, maxzoom: 17,
    // ⭐ v1.405 (bod C): shluky drží do z14 — jednotlivé obrázky
    // nevyskočí všechny už na z13; rozpad dobíhá do z16 (v1.415)
    cluster: true, clusterRadius: 48, clusterMaxZoom: 16,
  });
  // ⭐ v1.555: VYBLEDLÉ MÍSTO = KOMUNITA HLÁSÍ ZÁNIK.
  //
  // Appka o životnosti podniku mluví ve třech stavech: uživatelovo
  // „Stále aktivní" = plné barvy, hlášení komunity = tenhle útlum,
  // uživatelovo „Již neaktivní" = do enginu se to vůbec nepošle.
  //
  // ⚠️ Hodnota drží řeč, kterou 2D vykreslovač používal odjakživa
  // (`_markerFor`: 0,3 pro nahlášené, 0,6 pro záznam neupravený 5 let).
  // Trochu výš než 0,3, protože herní mapa je tmavá a kresba na ní mizí.
  const TLUM = 0.38;
  mapa.addLayer({
    id: 'okolnik-mista-shluk',
    type: 'circle',
    source: 'okolnik-mista',
    filter: ['has', 'point_count'],
    paint: {
      'circle-radius': ['step', ['get', 'point_count'], 15, 10, 19, 50, 24],
      'circle-color': '#2E7D5B',
      'circle-opacity': 0.92,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#F2E8CF',
    },
  });
  mapa.addLayer({
    id: 'okolnik-mista-shluk-pocet',
    type: 'symbol',
    source: 'okolnik-mista',
    filter: ['has', 'point_count'],
    layout: {
      'text-field': ['get', 'point_count_abbreviated'],
      // ⚠️ `text-font` MUSÍ být sada, kterou styl zná – jinak MapLibre
      // shodí celou vrstvu POTICHU (past popsaná v předávce enginu).
      'text-font': ['Noto Sans Bold'],
      'text-size': 13,
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#F2E8CF' },
  });
  // Kruh zůstává jen pro místa BEZ kresby (appka jich pár nemá)
  mapa.addLayer({
    id: 'okolnik-mista-kruh',
    type: 'circle',
    source: 'okolnik-mista',
    filter: ['all', ['!', ['has', 'ik']], ['!', ['has', 'point_count']]],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 9],
      'circle-color': ['get', 'b'],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
      'circle-opacity': ['case', ['has', 'tl'], TLUM, 1],
      'circle-stroke-opacity': ['case', ['has', 'tl'], TLUM, 1],
    },
  });
  // v1.607 DOMALOVÁNÍ: jemná světlá záře pod malovanými místy (jen
  // v herní mapě) – circle s rozostřením na rovině mapy, žádná data navíc
  if (aktualniKod === 'herni' && !mapa.getLayer('okolnik-mista-zar')) {
    mapa.addLayer({
      id: 'okolnik-mista-zar', type: 'circle', source: 'okolnik-mista',
      minzoom: 13,
      filter: ['all', ['has', 'ik'], ['!', ['has', 'point_count']],
               ['!', ['has', 'b2d']]],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'],
                          13, 14, 16, 42],
        'circle-color': '#FFF4D6',
        'circle-opacity': ['interpolate', ['linear'], ['zoom'],
                           13, 0, 14.5, 0.22],
        'circle-blur': 1,
        'circle-pitch-alignment': 'map',
      },
    });
  }
  // Malovaná ikona Okolníku; `icon-image` je rovnou cesta k souboru,
  // takže `styleimagemissing` ví, co má stáhnout (viz zajistiIkonu).
  // ⭐ 5. 9. 2026: STÍNY OBRÁZKŮ MÍST (přání „stíny za obrázky podle
  // svitu slunce a měsíce"). Tatáž featura, obrázek `ik + '#stin'`
  // (zajistiIkonu), kotva TOP = pata stínu u paty obrázku, leží na mapě
  // (pitch/rotation alignment map), posun a síla podle světla –
  // `nastavStinyMist` volá svetlo.js. Bubliny (b2d) stín nemají.
  // kontaktní stín u paty (vidět vždy, i když vržený stín padá za obrázek)
  zajistiStinPatu();
  mapa.addLayer({
    id: 'okolnik-mista-pata',
    type: 'symbol',
    source: 'okolnik-mista',
    filter: ['all', ['has', 'ik'], ['!', ['has', 'point_count']],
             ['!', ['has', 'b2d']]],
    layout: {
      'icon-image': 'stin-pata',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-anchor': 'center',
      'icon-pitch-alignment': 'map',
      'icon-rotation-alignment': 'map',
      'icon-size': ['interpolate', ['linear'], ['zoom'],
                    10, ['case', ['has', 'fv'], 0.24, 0.14],
                    13, ['case', ['has', 'fv'], 0.30, 0.24],
                    16, ['case', ['has', 'fv'], 0.30, 0.38],
                    18, ['case', ['has', 'fv'], 0.30, 0.5]],
    },
    paint: { 'icon-opacity': ['*', ['case', ['has', 'tl'], TLUM, 1], 0.32] },
  });
  mapa.addLayer({
    id: 'okolnik-mista-stin',
    type: 'symbol',
    source: 'okolnik-mista',
    filter: ['all', ['has', 'ik'], ['!', ['has', 'point_count']],
             ['!', ['has', 'b2d']]],
    layout: {
      'icon-image': ['concat', ['get', 'ik'], '#stin'],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-anchor': 'top',
      'icon-offset': stinMistOffset,
      'icon-pitch-alignment': 'map',
      'icon-rotation-alignment': 'map',
      'icon-size': ['interpolate', ['linear'], ['zoom'],
                    10, ['case', ['has', 'fv'], 0.24, 0.14],
                    13, ['case', ['has', 'fv'], 0.30, 0.24],
                    16, ['case', ['has', 'fv'], 0.30, 0.38],
                    18, ['case', ['has', 'fv'], 0.30, 0.5]],
    },
    paint: { 'icon-opacity': ['*', ['case', ['has', 'tl'], TLUM, 1],
                               stinMistSila] },
  });
  mapa.addLayer({
    id: 'okolnik-mista-ikona',
    type: 'symbol',
    source: 'okolnik-mista',
    filter: ['all', ['has', 'ik'], ['!', ['has', 'point_count']]],
    layout: {
      'icon-image': ['get', 'ik'],
      // ⚠️ BEZ POPISKŮ: `text-font`, který ve stylu chybí, shodí celou
      // vrstvu potichu (stejná past jako u kreseb Kroniky).
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-anchor': 'bottom',
      // Bubliny 2D značek (b2d) jsou menší a při přiblížení NEROSTOU
      // (výtka „po přiblížení klidně menší, ať nezakrývají mapu");
      // malované kresby si nechávají původní křivku.
      // ⚠️ v1.247: 0,18 (≈27 CSS px) bylo na telefonu prakticky
      // NEVIDITELNÉ (hlášeno „ve 3D nevidím oblíbená") → bubliny 0,24
      // a hvězda oblíbených (fv) ještě o kus větší, obě bez růstu.
      'icon-size': ['interpolate', ['linear'], ['zoom'],
                    10, ['case', ['has', 'fv'], 0.24,
                         ['has', 'b2d'], 0.14, 0.14],
                    13, ['case', ['has', 'fv'], 0.30,
                         ['has', 'b2d'], 0.22, 0.24],
                    16, ['case', ['has', 'fv'], 0.30,
                         ['has', 'b2d'], 0.24, 0.38],
                    18, ['case', ['has', 'fv'], 0.30,
                         ['has', 'b2d'], 0.24, 0.5]],
    },
    paint: { 'icon-opacity': ['case', ['has', 'tl'], TLUM, 1] },
  });
  // ⭐ STUHA SE JMÉNEM POD KRESBOU (9. 8. 2026, přání uživatele „u obrázků
  // v herním režimu přidej stužku s názvem místa").
  // ⚠️ JEN V KRONICE. Pergamenový podklad `ilus-stuha` registruje
  // `ilustrace.js`, a ten běží v herním stylu; jinde by MapLibre hlásil
  // chybějící obrázek a zůstal by holý text, který do střízlivé mapy
  // nepatří.
  // ⚠️ OD z13 (v1.428). Historie prahu: 15,2 (= Z_JEMNE, obava „les
  // textu") → 15,0 (v1.427, kolébání ČÍSLA zoomu terénem ±0,1–0,2
  // dělalo blikání na hraně; změřeno 15,1978 × práh 15,2) → 13,0
  // (v1.428, výtka „obrázky jsou dávno vidět, mají prostor, a stužka
  // stejně není"). „Les textu" už neplatí: hustotu míst pod z16
  // pohltí SHLUKY (stuha jen pro nesloučená místa) a zbytek ohlídá
  // kolizní systém z v1.405 (jména sídel mají přednost). Pod z13
  // nemá smysl — přehled patří kaskádě kreseb s vlastními stuhami.
  // ⚠️ `text-font` MUSÍ být sada, kterou styl zná; jinak MapLibre shodí
  // CELOU vrstvu POTICHU (past už popsaná u `okolnik-moje-ikona`).
  if (aktualniKod === 'herni' && !mapa.getLayer('okolnik-mista-stuha')) {
    try {
      mapa.addLayer({
        id: 'okolnik-mista-stuha',
        type: 'symbol',
        source: 'okolnik-mista',
        minzoom: 13.0,
        filter: ['all', ['has', 't'], ['has', 'ik'],
                 ['!', ['has', 'point_count']]],
        layout: {
          'icon-image': 'ilus-stuha',
          // ⚠️ `width`, NE `both` — stuha roste jen do šířky. Svislé
          // natahování rozmazalo její horní okraj (viz `addImage`
          // v ilustrace.js). Výška zůstává původní, takže se text NESMÍ
          // zalamovat — proto `text-max-width` níž tak velké.
          'icon-text-fit': 'width',
          'icon-text-fit-padding': [0, 4, 0, 4],
          // ⛔⛔ ŽÁDNÝ `icon-size`. `icon-text-fit` napasuje stuhu na text,
          // ale `icon-size` pak zmenší UŽ JEN STUHU — text se s ní
          // nezmenší a vyleze ven. Přesně tak jsem si to 9. 8. rozbil
          // (uživatel: „název přetéká přes stužku"). Velikost celku se
          // řídí VÝHRADNĚ `text-size` níž.
          // ⭐ v1.405 (bod A): stuha UŽ NENÍ nedotknutelná — účastní se
          // kolizí. Jména sídel (ink-*) se rozmisťují dřív (jsou výš
          // v pořadí stylu), takže stuha, která by je zakryla, se
          // s prolnutím schová — „nejdou vidět popisky“.
          'icon-allow-overlap': false,
          'icon-ignore-placement': false,
          'text-field': ['get', 't'],
          'text-font': ['Noto Sans Bold'],
          // ⭐ TOHLE je jediný knoflík na velikost stuhy (viz výš).
          // ⛔⛔ v1.428: ZOOMOVÝ VÝRAZ SEM NEDÁVAT — icon-text-fit
          // v kombinaci se zoom-interpolate text-size TIŠE přestane
          // kreslit CELOU vrstvu (vrstva žije, výraz uložen, symbolů
          // nula i tam, kde konstanta kreslila; ověřeno na zařízení).
          'text-size': 8.5,
          // ⚠️ ZÁMĚRNĚ VELKÉ = text se NIKDY nezalomí. Stuha má pevnou
          // výšku (roste jen do šířky), takže druhý řádek by z ní vylezl.
          // Dlouhý název tedy udělá delší stuhu, ne vyšší.
          'text-max-width': 40,
          // kresba kotví patou na bodě, stuha visí těsně pod ní
          'text-anchor': 'top',
          'text-offset': [0, 0.5],
          'text-allow-overlap': false,
          'text-ignore-placement': false,
        },
        // ⚠️ STUHA BLEDNE SPOLU S KRESBOU. Kdyby zůstala plná, vypadalo
        // by to jako chyba vykreslení, ne jako záměr.
        paint: {
          'text-color': '#3A2812',
          'text-opacity': ['case', ['has', 'tl'], TLUM, 1],
          'icon-opacity': ['case', ['has', 'tl'], TLUM, 1],
        },
      }, 'okolnik-mista-ikona');
    } catch (e) {
      console.warn('[most] stuha jmen míst:', e);
    }
  }
  // ⭐ JMÉNA MÍST MIMO HRU (v1.377, výtka „u obrázků nejsou žádné
  // popisky, uživatel musí stále otevírat obrázky"). Střízlivý text pod
  // značkou; žádná stuha — běžná mapa nemá hrát na pergamen. Les textu
  // hlídají KOLIZE (allow-overlap NEcháváme vypnuté: co se nevejde,
  // MapLibre schová) a práh z14.
  // ⚠️ `text-font` MUSÍ existovat ve stylu (jinak vrstva tiše umře) —
  // a `zakladni` je cizí Liberty s vlastními písmy. Font se proto bere
  // z první textové vrstvy AKTUÁLNÍHO stylu.
  if (aktualniKod !== 'herni' && !mapa.getLayer('okolnik-mista-jmeno')) {
    try {
      // první NEkurzívní písmo stylu (Liberty má jako první vodní
      // kurzívu — jména míst pak vypadala jako řeky); kurzíva jen záloha
      let font = null;
      let zaloha = null;
      for (const v of (mapa.getStyle().layers || [])) {
        const f = v.layout && v.layout['text-font'];
        if (f && f.length) {
          zaloha = zaloha || f;
          if (!/italic/i.test(f.join(' '))) { font = f; break; }
        }
      }
      font = font || zaloha;
      mapa.addLayer({
        id: 'okolnik-mista-jmeno',
        type: 'symbol',
        source: 'okolnik-mista',
        minzoom: 14,
        filter: ['all', ['has', 't'], ['!', ['has', 'point_count']]],
        layout: {
          'text-field': ['get', 't'],
          'text-font': font || ['Noto Sans Regular'],
          'text-size': 11,
          'text-anchor': 'top',
          'text-offset': [0, 0.4],
          'text-max-width': 9,
        },
        // tmavý inkoust s bílým halo čte se na turistické i na ortofotu
        // ⚠️ JMÉNO BLEDNE S KRESBOU. Plný popisek nad vybledlou značkou
        // vypadá jako chyba vykreslení, ne jako „tady už asi zavřeli".
        paint: { 'text-color': '#2B2A26', 'text-halo-color': '#ffffff',
                 'text-halo-width': 1.4,
                 'text-opacity': ['case', ['has', 'tl'], TLUM, 1] },
      });
    } catch (e) {
      console.warn('[most] jména míst mimo hru:', e);
    }
  }
  registrujKlikMista();
  registrujKlikPoi();
  potlacDuplicity();
  console.log('[most] místa Okolníku vykreslena:', viditelna.length,
              '| moje', mojeMista.length,
              '| s kresbou', viditelna.filter((m) => m.ik).length,
              '| navštívených', viditelna.filter((m) => m.nav).length);
}

/// VLASTNÍ ZÁLOŽKY UŽIVATELE (oblíbená ⭐, soukromá 📍, výpravy 🥾, zápisy 📖).
/// Vlastní zdroj BEZ shlukování – tyhle značky nesmí zmizet do bubliny ani
/// při oddálení, protože jsou to jediné body, které si uživatel sám založil
/// (a klik na ně otevírá detail výpravy či zápisu).
function vykresliMojeMista(gj) {
  if (!mapa) return;
  // ⚠️ STEJNÝ RETRY JAKO `vykresliMista` (7. 8. 2026). Bez něj se tu při
  // nenačteném stylu TIŠE SKONČILO – a v Kronice je `isStyleLoaded()`
  // skoro pořád `false` (viz poznámka u `nastavTeren`), takže se vlastní
  // záložky uživatele po přepnutí stylu neobjevily, dokud je appka
  // neposlala znovu. A ta je posílá až na `moveend`, tedy AŽ PO POHYBU.
  if (!mapa.isStyleLoaded()) {
    setTimeout(() => vykresliMojeMista(gj), 250);
    return;
  }
  const zdroj = mapa.getSource('okolnik-moje');
  if (zdroj) { zdroj.setData(gj); return; }
  mapa.addSource('okolnik-moje',
      { type: 'geojson', data: gj, maxzoom: 14 });
  mapa.addLayer({
    id: 'okolnik-moje-ikona',
    type: 'symbol',
    source: 'okolnik-moje',
    layout: {
      'icon-image': ['get', 'ik'],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-anchor': 'bottom',
      // stálá velikost: záložky mají být čitelné i z dálky
      'icon-size': ['interpolate', ['linear'], ['zoom'],
                    8, 0.22, 13, 0.28, 18, 0.30],
      // ⭐ DATUM POD ZNAČKOU ZÁZNAMU – 2D má pod botou/knihou bílý štítek
      // (`_StitekData`), 3D nemá zaostat. Text jde jen tam, kde aplikace
      // pošle `t` (výpravy a zápisy); u ⭐ a 📍 `t` nechodí.
      // ⚠️ `text-font` MUSÍ být sada, kterou styl zná, jinak MapLibre
      // shodí CELOU vrstvu POTICHU a zmizely by i ikony. 'Noto Sans Bold'
      // je ověřená na všech čtyřech stylech (počet ve shluku, kaskáda).
      'text-field': ['coalesce', ['get', 't'], ''],
      'text-font': ['Noto Sans Bold'],
      'text-size': 11,
      // ikona kotví patou na bodě, takže text kotvený shora sedí pod ní
      'text-anchor': 'top',
      'text-offset': [0, 0.35],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
      // kdyby se text nevešel, ikona zůstane (klik je důležitější)
      'text-optional': true,
    },
    paint: {
      // světlá obruba nahrazuje bílou pilulku ze 2D bez další textury
      'text-color': '#0D2B2E',
      'text-halo-color': '#FFFFFF',
      'text-halo-width': 1.6,
    },
  });
  // ⚠️ JEN JEDNOU. Vrstvy se po každé výměně stylu zakládají znovu; druhý
  // posluchač na témže id vrstvy by hlásil klik dvakrát a appka by otevřela
  // dva detaily přes sebe (past popsaná u `hookKlikuMist`).
  if (!vykresliMojeMista._hook) {
    vykresliMojeMista._hook = true;
    mapa.on('click', 'okolnik-moje-ikona', (e) => {
      const f = e.features && e.features[0];
      if (window.Dobyvatel && Dobyvatel.spolklKlik(e)) return;
      if (f) mostHlas('onBod', f.properties.id);
    });
  }
}

// (dočasná diagnostika značek z v1.247 odstraněna – příčina nalezena:
// oblíbená se neposílala a bubliny 0,18 byly příliš malé; viz icon-size)

// V režimu aplikace zmizí demo prvky – appka má vlastní ovládání a
// tlačítka se navíc překrývala (výtka „Herní se schovává za Sněžku").
// ⛔ ATRIBUCE SE NESKRÝVAJÍ, jsou povinné.
// ⚠️ VOLÁ SE OKAMŽITĚ při načtení skriptu, ne až v `map.load`. Do té doby
// stihla stará tlačítka probliknout (výtka „po spuštění 3D na chvilku
// vyskočí stará tlačítka").
function zapniAppRezim() {
  if (!APP_REZIM || document.getElementById('okolnik-app-css')) return;
  const css = document.createElement('style');
  css.id = 'okolnik-app-css';
  css.textContent = '#prelety,#mlha-ovladani,#mlha-demo,#mlha-reset,'
    + '#nav-prepinac,#nav-info,#nav-graf,#nav-profil-vyber,#nav-prolet,'
    // #ilus-filtr = chipy druhů kreseb (Vše/Hrady/Města…). V herním stylu
    // se ukazovaly uprostřed mapy i v appce, kde má Okolník vlastní filtry
    // — dvě různé sady filtrů přes sebe (výtka z 29. 7.).
    + '#nav-zrusit,#napoveda,#teren-prepinac,#styly,#znacka,#ilus-filtr,'
    + '.maplibregl-ctrl-top-right{display:none !important}'
    // měřítko („50 m") appka nikde jinde neukazuje – pryč
    + '.maplibregl-ctrl-scale{display:none !important}'
    // ⛔ ATRIBUCE ZŮSTÁVÁ. Nepředělávat jí vzhled – vlastní `font-size`
    // a `max-width` rozbily kompaktní režim MapLibre a z ⓘ se stal pruh
    // přes půl mapy (výtka „nápis dole zabírá velkou část mapy").
    // Necháváme MapLibre jeho ⓘ, které se rozbalí ťuknutím.
    // Atribuce sbalená do ⓘ (rozbalí se ťuknutím) – standardní a povolený
    // způsob. Bez tohohle zabírala dva řádky přes celou šířku mapy.
    + '.maplibregl-ctrl-attrib:not(.maplibregl-compact-show)'
    + ' .maplibregl-ctrl-attrib-inner{display:none !important}'
    + '.maplibregl-ctrl-attrib:not(.maplibregl-compact-show)'
    + '{background:transparent !important;box-shadow:none !important}'
    + '.maplibregl-ctrl-attrib-inner{font-size:10px !important}'
    // ⚠️ Atribuce se jen ZVEDNE nad tlačítko polohy Okolníku. Přesun
    // doleva (`left:0;right:auto`) ji z obrazu vyhodil úplně – a atribuce
    // zmizet NESMÍ, je povinná (© ČÚZK, © OpenStreetMap).
    + '.maplibregl-ctrl-bottom-right{bottom:64px !important}'
    + 'body{background:transparent}';
  document.head.appendChild(css);
  // ⚠️ MapLibre renderuje atribuci jako <details open> – sama se tedy
  // ukáže rozbalená přes dva řádky. Zavřeme ji; uživatel si ji kdykoli
  // rozbalí ťuknutím na ⓘ (a tím je licenci učiněno zadost).
  const zavri = () => {
    for (const d of document.querySelectorAll('.maplibregl-ctrl-attrib')) {
      d.removeAttribute('open');
      d.classList.remove('maplibregl-compact-show');
    }
  };
  setTimeout(zavri, 300);
  setTimeout(zavri, 1500);

  // ⚠️ SBALIT PO KAŽDÉ VÝMĚNĚ STYLU, NE JEN PŘI STARTU. MapLibre atribuci
  // po změně zdrojů vyrobí znovu jako `<details open>`, takže po vstupu do
  // hry přes mapu probleskl celý řádek s licencí (výtka „přeskakuje tam
  // text o zdroji"). Volá se z `aplikujDoplnky` — viz `zavriAtribuci`.
  // ⛔ SKRÝT SE NESMÍ, je povinná – jen se drží sbalená do ⓘ.
  //
  // ⛔ NIKDY NA TO NENASAZOVAT MutationObserver! Zavření `<details>` vyvolá
  // `toggle`, ovládání atribuce si stav vrátí = další mutace → nekonečná
  // smyčka, která UDUSÍ HLAVNÍ VLÁKNO: styl se pak nikdy nedonačte, most
  // sice volání přijme, ale `vykresliMista` čeká na `isStyleLoaded()` a
  // mapa zůstane němá (30. 7. 2026, stálo to hodinu).
  window.__okolnikZavriAtribuci = zavri;
}

/// Sbalí atribuci do ⓘ (bezpečné volat kdykoli).
function zavriAtribuci() {
  const f = window.__okolnikZavriAtribuci;
  if (!f) return;
  f();
  setTimeout(f, 400);   // MapLibre ji dorenderuje až po chvíli
}

zapniAppRezim();
start();
