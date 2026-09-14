/* =====================================================================
   Žebříček Okolníku – čte se přímo z Firebase Firestore přes REST API.

   Web na okolnik.cz je STATICKÝ (GitHub Pages), žádný backend tu není.
   Data proto tahá prohlížeč sám: veřejné čtení kolekce `zebricek`.
   Bez knihoven, bez CDN, jen fetch.

   Zápis dělá mobilní aplikace (jeden dokument na hráče a měsíc);
   formát dokumentu i potřebná Firestore pravidla jsou popsané
   v /ZEBRICEK-POZNAMKY.md v kořeni tohoto repozitáře.

   ⭐ 14. 9. 2026 – VÍC KATEGORIÍ A SOUTĚŽIVOST (zadání: „ať jsou
   žebříčky zábavné, vytvářejí soutěživost a hrdost na výsledek"):
   • sedm měsíčních kategorií (km, obce, doložené návštěvy, vrcholy,
     klenoty, kroky, XP) – každý hráč má šanci být nejlepší v NĚČEM, ne
     jen ten, kdo nejvíc chodí (fotovýpravy, dny venku a série dní
     vyřazeny 14. 9.: „otravná a nicneříkající soutěž");
   • měsíc = nový start (nováček soutěží s nováčkem), Síň slávy =
     celkové součty pro ty, kdo hrají dlouho;
   • „Moje pozice": vlastní řádek i mimo TOP, kolik chybí na příčku
     před tebou (blízký cíl motivuje víc než vzdálený vrchol), lepší než
     X % hráčů, tvůj nejlepší měsíc, loňské umístění;
   • filtr Můj kraj a Přátelé – nejsilnější motivace je porovnání
     s lidmi, které znám (vzor Strava);
   • koruny za 1. místa v minulém měsíci zůstávají celý měsíc vidět
     u jména (uznání, které nezmizí s novým měsícem).
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------------
   Přístup k Firestore
   ---------------------------------------------------------------------
   Web API Key je VEŘEJNÝ klientský identifikátor projektu – přesně
   tahle hodnota je i v APK (Sarcher/app/lib/vote_backend.dart).
   Data nechrání klíč, ale Firestore Rules: kolekce `zebricek` má
   veřejné čtení a přísně validovaný zápis. Klíč tedy smí být i tady.
--------------------------------------------------------------------- */
var PROJEKT = 'sarcher-b32a1';
// ⚠️ JINÝ KLÍČ NEŽ V APLIKACI. Tenhle je omezený na okolnik.cz
// (Websites restrikce) + jen tři API: Identity Toolkit, Firestore
// a Token Service. Klíč z APK sem NEPATŘÍ — appka volá Firestore
// holým REST, takže referrer neposílá a s omezením by přestala
// fungovat (proto má vlastní, neomezený).
var KLIC = 'AIzaSyB3sj8qS-Lh4lHow6AUrWH-JayEtJ70igQ';
var KOLEKCE = 'zebricek';
var ZAKLAD = 'https://firestore.googleapis.com/v1/projects/' + PROJEKT +
             '/databases/(default)/documents';
var ULOZISTE = 'okolnikUcet1';   // relace Můj Okolník (sdílená s /ucet/)

/* ---------------------------------------------------------------------
   PROČ PROSTÝ VÝPIS A ŘAZENÍ V JS, A NE runQuery
   ---------------------------------------------------------------------
   `runQuery` se `where obdobi == "2026-08"` a `orderBy km DESC` je
   rovnost na jednom poli + řazení podle JINÉHO pole. Na to Firestore
   vyžaduje SLOŽENÝ index; automatické jednopolové indexy nestačí.
   Prostý výpis kolekce (documents.list) žádný index nepotřebuje a při
   dnešních počtech hráčů je levný; jedním stažením se obslouží
   všechny kategorie, období, filtry i „Moje pozice" (kešuje se).
   AŽ jich bude moc (přes ~2 000 řádků), založit složené indexy
   (obdobi ASC + <kategorie> DESC) a přepnout POUZIT_RUNQUERY.
--------------------------------------------------------------------- */
var POUZIT_RUNQUERY = false;

var STRANKA = 300;      // maximum, které documents.list vrátí najednou
var MAX_STRANEK = 8;    // pojistka proti nekonečnému stahování
var LIMIT = 100;        // TOP 100 (+ vlastní řádek, když je dál)
var TIMEOUT_MS = 12000;

var POLE = ['prezdivka', 'obdobi', 'km', 'obce', 'vypravy', 'kraj', 'aktualizovano',
            'navstevy', 'vrcholy', 'malovana', 'dny', 'serie', 'kroky', 'podlozeno',
            'xp', 'uroven', 'celkem'];

/* Měsíční kategorie – pořadí = pořadí tlačítek. `pravidlo` je jedna
   věta „co se počítá" (hráč musí vědět, čím vyhraje). */
var KATEGORIE = {
  km:       { nazev: 'Kilometry',          ikona: '🥾', jednotka: 'km',      desetinna: 1, sklon: ['km', 'km', 'km'],
              pravidlo: 'Kilometry vlastní silou z GPS stopy (úseky pomalejší než 32 km/h).' },
  obce:     { nazev: 'Nové obce',          ikona: '🏘️', jednotka: 'obcí',    desetinna: 0, sklon: ['obec', 'obce', 'obcí'],
              pravidlo: 'Obce, do kterých hráč tenhle měsíc poprvé došel nebo dojel (do 160 m od jejich bodu).' },
  navstevy: { nazev: 'Doložené návštěvy',  ikona: '📍', jednotka: 'návštěv', desetinna: 0, sklon: ['návštěva', 'návštěvy', 'návštěv'],
              pravidlo: 'Návštěvy míst doložené polohou: pět minut u místa nebo „Jsem tady" přímo na místě.' },
  vrcholy:  { nazev: 'Vrcholy',            ikona: '⛰️', jednotka: 'vrcholů', desetinna: 0, sklon: ['vrchol', 'vrcholy', 'vrcholů'],
              pravidlo: 'Doložené vrcholy – potvrzení do 60 m od vrcholu.' },
  malovana: { nazev: 'Klenoty',            ikona: '💎', jednotka: 'klenotů', desetinna: 0, sklon: ['klenot', 'klenoty', 'klenotů'],
              pravidlo: 'Klenoty Česka = ručně malovaná významná místa; počítají se doložené návštěvou za měsíc.' },
  kroky:    { nazev: 'Kroky',              ikona: '👣', jednotka: 'kroků',   desetinna: 0, sklon: ['krok', 'kroky', 'kroků'],
              pravidlo: 'Kroky z krokoměru telefonu; počítají se jen hráči, u kterých kroky odpovídají kilometrům.' },
  xp:       { nazev: 'XP za měsíc',        ikona: '⭐', jednotka: 'XP',      desetinna: 0, sklon: ['XP', 'XP', 'XP'],
              pravidlo: 'Body za úspěchy odemčené tenhle měsíc – odměna za pestrost, ne jen za kilometry.' }
};

/* Síň slávy – celkové součty z posledního hlášení hráče. */
var SIN = {
  uroven:   { nazev: 'Úroveň',             ikona: '🏅', jednotka: 'úroveň',  desetinna: 0, sklon: ['úroveň', 'úrovně', 'úrovní'],
              pravidlo: 'Úroveň hráče z XP za všechny úspěchy.' },
  km:       { nazev: 'Kilometry celkem',   ikona: '🥾', jednotka: 'km',      desetinna: 0, sklon: ['km', 'km', 'km'],
              pravidlo: 'Všechny kilometry vlastní silou za celou dobu.' },
  obce:     { nazev: 'Obce celkem',        ikona: '🏘️', jednotka: 'obcí',    desetinna: 0, sklon: ['obec', 'obce', 'obcí'],
              pravidlo: 'Objevené obce ze 6 258 obcí Česka.' },
  navstevy: { nazev: 'Doložené návštěvy',  ikona: '📍', jednotka: 'návštěv', desetinna: 0, sklon: ['návštěva', 'návštěvy', 'návštěv'],
              pravidlo: 'Všechna místa doložená polohou.' },
  malovana: { nazev: 'Klenoty',            ikona: '💎', jednotka: 'klenotů', desetinna: 0, sklon: ['klenot', 'klenoty', 'klenotů'],
              pravidlo: 'Navštívené klenoty Česka – ručně malovaná významná místa (z 393).' },
  vrcholy:  { nazev: 'Vrcholy',            ikona: '⛰️', jednotka: 'vrcholů', desetinna: 0, sklon: ['vrchol', 'vrcholy', 'vrcholů'],
              pravidlo: 'Doložené vrcholy za celou dobu.' },
  xp:       { nazev: 'XP celkem',          ikona: '⭐', jednotka: 'XP',      desetinna: 0, sklon: ['XP', 'XP', 'XP'],
              pravidlo: 'Součet bodů za všechny odemčené úspěchy.' },
  uspechy:  { nazev: 'Úspěchy',            ikona: '🏆', jednotka: 'úspěchů', desetinna: 0, sklon: ['úspěch', 'úspěchy', 'úspěchů'],
              pravidlo: 'Počet odemčených úspěchů.' }
};

var MESICE = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen',
              'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
// 6. pád („v lednu…") – čeština, ne řetězení nominativů
var MESICE_KDE = ['lednu', 'únoru', 'březnu', 'dubnu', 'květnu', 'červnu',
                  'červenci', 'srpnu', 'září', 'říjnu', 'listopadu', 'prosinci'];

/* ── období ─────────────────────────────────────────────────────── */

function klicObdobi(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function nazevObdobi(klic) {
  var c = /^(\d{4})-(\d{2})$/.exec(klic);
  if (!c) return klic;
  var m = parseInt(c[2], 10) - 1;
  return (MESICE[m] || klic) + ' ' + c[1];
}

/** Totéž v 6. pádu, pro větu „V srpnu 2026 se ještě nikdo nepřihlásil". */
function nazevObdobiKde(klic) {
  var c = /^(\d{4})-(\d{2})$/.exec(klic);
  if (!c) return klic;
  var m = parseInt(c[2], 10) - 1;
  return (MESICE_KDE[m] || klic) + ' ' + c[1];
}

var ted = new Date();
var OBDOBI = {
  tento: klicObdobi(ted),
  minuly: klicObdobi(new Date(ted.getFullYear(), ted.getMonth() - 1, 1)),
  sin: 'sin'
};

/** Kolik dní zbývá do konce měsíce (včetně dneška). */
function dniDoKonceMesice() {
  var posledni = new Date(ted.getFullYear(), ted.getMonth() + 1, 0).getDate();
  return posledni - ted.getDate() + 1;
}

/* ── stav stránky ───────────────────────────────────────────────── */

var stav = { metrika: 'km', obdobi: 'tento', kdo: 'vsichni', kraj: '' };
var kes = {};          // klíč → Promise s řádky (jedno stažení pro všechno)
var behZmena = 0;      // pořadové číslo požadavku, ať starší odpověď nepřepíše novější
var UKAZKA = /[?&]ukazka=1(&|$)/.test(location.search);

var elVysledek = document.getElementById('vysledek');
var elMoje = document.getElementById('mojePozice');

/* ── relace Můj Okolník (jen čtení; přihlášení dělá /ucet/) ─────── */

var relace = null;
function nactiRelaci() {
  try {
    var s = localStorage.getItem(ULOZISTE);
    if (!s) return null;
    var r = JSON.parse(s);
    return (r && r.refreshToken && r.uid) ? r : null;
  } catch (e) { return null; }
}

/** Platný idToken (obnova přes refresh token, jako v /ucet/ucet.js). */
function token() {
  if (!relace) return Promise.reject(new Error('nepřihlášen'));
  if (relace.idToken && relace.vyprsi > Date.now() + 60000) {
    return Promise.resolve(relace.idToken);
  }
  return fetch('https://securetoken.googleapis.com/v1/token?key=' + KLIC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(relace.refreshToken)
  }).then(function (r) {
    if (!r.ok) throw new Error('obnova tokenu selhala');
    return r.json();
  }).then(function (d) {
    relace.idToken = d.id_token;
    relace.refreshToken = d.refresh_token || relace.refreshToken;
    relace.vyprsi = Date.now() + (Number(d.expires_in || 3600) * 1000);
    try { localStorage.setItem(ULOZISTE, JSON.stringify(relace)); } catch (e) { /* nevadí */ }
    return relace.idToken;
  });
}

/* ── pomocné čtení hodnot z Firestore REST ──────────────────────── */

/** Firestore vrací typované hodnoty; integerValue navíc jako ŘETĚZEC. */
function cislo(pole) {
  if (!pole || typeof pole !== 'object') return 0;
  var s = null;
  if (pole.doubleValue !== undefined) s = pole.doubleValue;
  else if (pole.integerValue !== undefined) s = pole.integerValue;
  else if (pole.stringValue !== undefined) s = String(pole.stringValue).replace(',', '.');
  else return 0;
  var n = Number(s);                    // "NaN"/"Infinity" ošetří Number.isFinite
  return Number.isFinite(n) ? n : 0;
}

function pravda(pole) {
  return !!(pole && pole.booleanValue === true);
}

/** Text od uživatele: ořez délky + pryč s řídicími a obousměrnými znaky. */
function text(pole, max) {
  if (!pole || typeof pole.stringValue !== 'string') return '';
  var s = pole.stringValue;
  var strop = max || 40;
  var ven = '';
  for (var i = 0; i < s.length && ven.length < strop; i++) {
    var k = s.charCodeAt(i);
    // řídicí znaky a obousměrné přepínače by rozhodily tabulku
    if (k < 32 || k === 127) continue;
    if (k >= 0x200b && k <= 0x200f) continue;
    if (k >= 0x202a && k <= 0x202e) continue;
    if (k >= 0x2066 && k <= 0x2069) continue;
    ven += s.charAt(i);
  }
  return ven.trim();
}

/** Dokument z REST API → řádek žebříčku (nebo null, když nedává smysl). */
function naRadek(doc) {
  if (!doc || !doc.fields) return null;
  var f = doc.fields;
  var prezdivka = text(f.prezdivka, 20);
  if (!prezdivka) return null;                        // bez jména se nezobrazuje
  // id dokumentu = "<uid>_<obdobi>" → uid pro „Moje pozice" a přátele
  var id = String(doc.name || '').split('/').pop() || '';
  var uid = id.indexOf('_') > 0 ? id.substring(0, id.lastIndexOf('_')) : '';
  var c = (f.celkem && f.celkem.mapValue && f.celkem.mapValue.fields) || {};
  return {
    uid: uid,
    prezdivka: prezdivka,
    obdobi: text(f.obdobi, 7),
    kraj: text(f.kraj, 30),
    km: Math.max(0, cislo(f.km)),
    obce: Math.max(0, Math.round(cislo(f.obce))),
    vypravy: Math.max(0, Math.round(cislo(f.vypravy))),
    navstevy: Math.max(0, Math.round(cislo(f.navstevy))),
    vrcholy: Math.max(0, Math.round(cislo(f.vrcholy))),
    malovana: Math.max(0, Math.round(cislo(f.malovana))),
    dny: Math.max(0, Math.round(cislo(f.dny))),
    serie: Math.max(0, Math.round(cislo(f.serie))),
    // kroky jen podložené kilometry – jinak by vyhrál, kdo nosí telefon v kapse autem
    kroky: pravda(f.podlozeno) ? Math.max(0, Math.round(cislo(f.kroky))) : 0,
    xp: Math.max(0, Math.round(cislo(f.xp))),
    uroven: Math.max(0, Math.round(cislo(f.uroven))),
    aktualizovano: (f.aktualizovano && f.aktualizovano.timestampValue) || '',
    celkem: {
      uroven: Math.max(0, Math.round(cislo(c.uroven))),
      km: Math.max(0, cislo(c.km)),
      obce: Math.max(0, Math.round(cislo(c.obce))),
      navstevy: Math.max(0, Math.round(cislo(c.navstevy))),
      malovana: Math.max(0, Math.round(cislo(c.malovana))),
      vrcholy: Math.max(0, Math.round(cislo(c.vrcholy))),
      xp: Math.max(0, Math.round(cislo(c.xp))),
      uspechy: Math.max(0, Math.round(cislo(c.uspechy)))
    }
  };
}

function chybaZOdpovedi(r) {
  return r.json().catch(function () { return null; }).then(function (j) {
    var kod = (j && j.error && j.error.status) ? j.error.status : ('HTTP_' + r.status);
    var e = new Error(kod);
    e.kod = kod;
    e.stav = r.status;
    return e;
  });
}

function sTimeoutem(url, telo, hlavicky) {
  var ac = ('AbortController' in window) ? new AbortController() : null;
  var casovac = setTimeout(function () { if (ac) ac.abort(); }, TIMEOUT_MS);
  var nastaveni = { headers: { 'Accept': 'application/json' } };
  if (hlavicky) Object.keys(hlavicky).forEach(function (k) { nastaveni.headers[k] = hlavicky[k]; });
  if (ac) nastaveni.signal = ac.signal;
  if (telo) {
    nastaveni.method = 'POST';
    nastaveni.headers['Content-Type'] = 'application/json';
    nastaveni.body = JSON.stringify(telo);
  }
  return fetch(url, nastaveni).then(function (r) {
    clearTimeout(casovac);
    if (!r.ok) return chybaZOdpovedi(r).then(function (e) { throw e; });
    return r.json();
  }, function (e) {
    clearTimeout(casovac);
    var ch = new Error(e && e.name === 'AbortError' ? 'TIMEOUT' : 'SIT');
    ch.kod = ch.message;
    throw ch;
  });
}

/* ── A) prostý výpis kolekce (výchozí, bez indexů) ──────────────── */

function nactiVypisem() {
  var vse = [];
  var stranka = 0;

  function dalsi(token) {
    var u = new URL(ZAKLAD + '/' + KOLEKCE);
    u.searchParams.set('key', KLIC);
    u.searchParams.set('pageSize', String(STRANKA));
    POLE.forEach(function (p) { u.searchParams.append('mask.fieldPaths', p); });
    if (token) u.searchParams.set('pageToken', token);

    return sTimeoutem(u.toString()).then(function (j) {
      // Prázdná / dosud neexistující kolekce vrací 200 a {} – bez `documents`.
      if (j && Array.isArray(j.documents)) {
        for (var i = 0; i < j.documents.length; i++) {
          var r = naRadek(j.documents[i]);
          if (r) vse.push(r);
        }
      }
      stranka++;
      var dalsiToken = (j && j.nextPageToken) ? j.nextPageToken : null;
      if (dalsiToken && stranka < MAX_STRANEK) return dalsi(dalsiToken);
      if (dalsiToken) {
        console.warn('[žebříček] Kolekce přerostla ' + (STRANKA * MAX_STRANEK) +
          ' řádků – je čas založit složené indexy a zapnout POUZIT_RUNQUERY.');
      }
      return vse;
    });
  }

  return dalsi(null);
}

/* ── B) serverový dotaz (až budou složené indexy) ───────────────── */

function nactiDotazem(obdobi, metrika) {
  var telo = {
    structuredQuery: {
      from: [{ collectionId: KOLEKCE }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'obdobi' },
          op: 'EQUAL',
          value: { stringValue: obdobi }
        }
      },
      orderBy: [{ field: { fieldPath: metrika }, direction: 'DESCENDING' }],
      limit: LIMIT
    }
  };
  return sTimeoutem(ZAKLAD + ':runQuery?key=' + encodeURIComponent(KLIC), telo)
    .then(function (odpoved) {
      var ven = [];
      if (!Array.isArray(odpoved)) return ven;
      // První prvek bývá jen {readTime:…} bez dokumentu – přeskočí se.
      for (var i = 0; i < odpoved.length; i++) {
        var r = naRadek(odpoved[i] && odpoved[i].document);
        if (r) ven.push(r);
      }
      return ven;
    });
}

/** Všechny řádky (všechna období) – jedno stažení, kešované. */
function vsechnyRadky() {
  if (UKAZKA) return Promise.resolve(ukazkovaData());
  if (!kes.vse) {
    kes.vse = nactiVypisem().catch(function (e) { delete kes.vse; throw e; });
  }
  return kes.vse;
}

/* ── přátelé (jen přihlášený; potvrzená přátelství) ─────────────── */

function nactiPratele() {
  if (!relace) return Promise.resolve(null);
  if (kes.pratele) return kes.pratele;
  function dotaz(pole, t) {
    var telo = {
      structuredQuery: {
        from: [{ collectionId: 'pratelstvi' }],
        where: { compositeFilter: { op: 'AND', filters: [
          { fieldFilter: { field: { fieldPath: pole }, op: 'EQUAL', value: { stringValue: relace.uid } } },
          { fieldFilter: { field: { fieldPath: 'stav' }, op: 'EQUAL', value: { stringValue: 'prijato' } } }
        ] } },
        limit: 200
      }
    };
    return sTimeoutem(ZAKLAD + ':runQuery', telo, { Authorization: 'Bearer ' + t });
  }
  kes.pratele = token().then(function (t) {
    return Promise.all([dotaz('a', t), dotaz('b', t)]);
  }).then(function (odp) {
    var uids = {};
    odp.forEach(function (seznam) {
      (Array.isArray(seznam) ? seznam : []).forEach(function (z) {
        var f = z && z.document && z.document.fields;
        if (!f) return;
        var a = text(f.a, 64), b = text(f.b, 64);
        if (a && a !== relace.uid) uids[a] = true;
        if (b && b !== relace.uid) uids[b] = true;
      });
    });
    return uids;
  }).catch(function () { delete kes.pratele; return {}; });
  return kes.pratele;
}

/* ── výběr, řazení, pořadí ──────────────────────────────────────── */

function hodnota(r, metrika, sin) {
  return sin ? (r.celkem[metrika] || 0) : (r[metrika] || 0);
}

/** Síň slávy: z každého hráče jen NEJNOVĚJŠÍ řádek (má aktuální součty). */
function posledniZaHrace(radky) {
  var podle = {};
  radky.forEach(function (r) {
    var k = r.uid || r.prezdivka;
    if (!podle[k] || r.obdobi > podle[k].obdobi) podle[k] = r;
  });
  return Object.keys(podle).map(function (k) { return podle[k]; });
}

/**
 * Tentýž hráč pod víc účty (14. 9. 2026: „proč tam jsem 3×?" – dva staré
 * uid z doby před přihlašováním účtem posílaly totéž jméno a čísla).
 * Z řádků se stejnou přezdívkou (bez ohledu na velikost písmen) zůstane
 * jen ten NEJČERSTVĚJI aktualizovaný – opuštěné účty se už neaktualizují.
 * ⚠️ Dva různí lidé se stejnou přezdívkou se tím slijí – ať si zvolí
 * jinou; duplicita jednoho hráče je častější a horší.
 */
function bezDuplicit(radky) {
  var podle = {};
  radky.forEach(function (r) {
    var k = r.prezdivka.trim().toLowerCase();
    var z = podle[k];
    if (!z || r.aktualizovano > z.aktualizovano) podle[k] = r;
  });
  return Object.keys(podle).map(function (k) { return podle[k]; });
}

/**
 * Seřadí a očísluje VŠECHNY řádky vybraného období/metriky (bez ořezu),
 * aby šla spočítat i pozice hráče, který v TOP není. Ořez dělá až výpis.
 */
function seradVse(radky, obdobi, metrika) {
  var sin = obdobi === 'sin';
  var vybrane = sin
    ? posledniZaHrace(radky)
    : radky.filter(function (r) { return r.obdobi === obdobi; });
  vybrane = bezDuplicit(vybrane);
  vybrane = vybrane.filter(function (r) { return hodnota(r, metrika, sin) > 0; });
  vybrane.sort(function (a, b) {
    var ha = hodnota(a, metrika, sin), hb = hodnota(b, metrika, sin);
    if (hb !== ha) return hb - ha;
    return a.prezdivka.localeCompare(b.prezdivka, 'cs');
  });
  // Shodná hodnota = shodné pořadí (1, 2, 2, 4 …).
  var poradi = 0, predchozi = null;
  vybrane.forEach(function (r, i) {
    var h = hodnota(r, metrika, sin);
    if (predchozi === null || h !== predchozi) { poradi = i + 1; predchozi = h; }
    r.poradi = poradi;
    r.hodnota = h;
  });
  return vybrane;
}

/** Filtr „Kdo": všichni / můj kraj / přátelé. */
function uplatniKdo(serazene, pratele) {
  if (stav.kdo === 'kraj' && stav.kraj) {
    return serazene.filter(function (r) { return r.kraj === stav.kraj; });
  }
  if (stav.kdo === 'pratele' && pratele) {
    return serazene.filter(function (r) {
      return pratele[r.uid] || (relace && r.uid === relace.uid);
    });
  }
  return serazene;
}

/** Po filtru se pořadí přečísluje (v kraji jsi třeba 3., ne 47.). */
function precisluj(radky) {
  var poradi = 0, predchozi = null;
  radky.forEach(function (r, i) {
    if (predchozi === null || r.hodnota !== predchozi) { poradi = i + 1; predchozi = r.hodnota; }
    r.poradi = poradi;
  });
  return radky;
}

/* ── koruny za minulý měsíc ─────────────────────────────────────── */

/** uid → [názvy kategorií], kde byl hráč v minulém měsíci první. */
function koruny(radky) {
  var ven = {};
  Object.keys(KATEGORIE).forEach(function (m) {
    var s = seradVse(radky, OBDOBI.minuly, m);
    s.forEach(function (r) {
      if (r.poradi !== 1) return;
      if (!ven[r.uid]) ven[r.uid] = [];
      ven[r.uid].push(KATEGORIE[m].nazev.toLowerCase());
    });
  });
  return ven;
}

/* ── vykreslení ─────────────────────────────────────────────────── */

function prazdny(el) { while (el.firstChild) el.removeChild(el.firstChild); }

function td(trida, obsah) {
  var b = document.createElement('td');
  if (trida) b.className = trida;
  if (obsah !== undefined && obsah !== null) b.textContent = obsah;
  return b;
}

var formaty = {};
function formatuj(hodnota, desetinna) {
  if (!formaty[desetinna]) {
    try {
      formaty[desetinna] = new Intl.NumberFormat('cs-CZ', {
        minimumFractionDigits: desetinna, maximumFractionDigits: desetinna
      });
    } catch (e) {
      formaty[desetinna] = { format: function (n) { return n.toFixed(desetinna); } };
    }
  }
  return formaty[desetinna].format(hodnota);
}

function hraciSlovo(n) {
  return n + (n === 1 ? ' hráč' : (n < 5 ? ' hráči' : ' hráčů'));
}

/** 2. pád po „z": „z 1 hráče", „z 3 hráčů". */
function hraciZ(n) {
  return n + (n === 1 ? ' hráče' : ' hráčů');
}

/** „2 vrcholy", „5 vrcholů", „1,5 km" – jednotka ve správném pádu. */
function sJednotkou(n, kat) {
  var t = formatuj(n, kat.desetinna);
  var s = kat.sklon || [kat.jednotka, kat.jednotka, kat.jednotka];
  var cele = Math.abs(n - Math.round(n)) < 1e-9 ? Math.round(n) : -1;
  var slovo = cele === 1 ? s[0] : (cele >= 2 && cele <= 4 ? s[1] : s[2]);
  return t + ' ' + slovo;
}

function ukazStav(trida, nadpis, texty, tlacitko) {
  prazdny(elVysledek);
  var box = document.createElement('div');
  box.className = 'stav' + (trida ? ' ' + trida : '');
  if (trida === 'nacita') {
    var t = document.createElement('div');
    t.className = 'tocka';
    t.setAttribute('aria-hidden', 'true');
    box.appendChild(t);
  }
  if (nadpis) {
    var h = document.createElement('h2');
    h.textContent = nadpis;
    box.appendChild(h);
  }
  (texty || []).forEach(function (radek) {
    var p = document.createElement('p');
    p.textContent = radek;
    box.appendChild(p);
  });
  if (tlacitko) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = tlacitko;
    b.addEventListener('click', function () {
      kes = {};
      nacti();
    });
    box.appendChild(b);
  }
  elVysledek.appendChild(box);
}

function kategorieDef() {
  return stav.obdobi === 'sin' ? SIN[stav.metrika] : KATEGORIE[stav.metrika];
}

function stupenVitezu(r, kat, korunky) {
  var d = document.createElement('div');
  var tridy = ['stupen', 'm' + r.poradi];
  if (relace && r.uid === relace.uid) tridy.push('ja');
  d.className = tridy.join(' ');
  var med = document.createElement('span');
  med.className = 'medaile';
  med.textContent = ['', '🥇', '🥈', '🥉'][r.poradi] || '';
  d.appendChild(med);
  var jm = document.createElement('span');
  jm.className = 'jm';
  jm.textContent = r.prezdivka;
  if (korunky && korunky[r.uid] && korunky[r.uid].length) {
    var kor = document.createElement('span');
    kor.className = 'koruna';
    kor.textContent = '👑';
    kor.title = '1. místo v ' + nazevObdobiKde(OBDOBI.minuly) + ': ' + korunky[r.uid].join(', ');
    jm.appendChild(kor);
  }
  d.appendChild(jm);
  var hod = document.createElement('span');
  hod.className = 'hod';
  hod.textContent = sJednotkou(r.hodnota, kat);
  d.appendChild(hod);
  var kr = document.createElement('span');
  kr.className = 'kr';
  kr.textContent = (r.kraj || '') + (r.uroven > 0 ? (r.kraj ? ' · ' : '') + 'úr. ' + r.uroven : '');
  d.appendChild(kr);
  return d;
}

function ukazTabulku(radky, celkemHracu, korunky) {
  var kat = kategorieDef();
  var sin = stav.obdobi === 'sin';
  var obdobi = OBDOBI[stav.obdobi];
  prazdny(elVysledek);

  // hlavička: disciplína · období · počet hráčů · odpočet
  var hl = document.createElement('div');
  hl.className = 'zeb-hlava';
  var h2 = document.createElement('h2');
  h2.textContent = kat.ikona + ' ' + kat.nazev;
  hl.appendChild(h2);
  var meta = document.createElement('span');
  meta.className = 'meta';
  var kdeText = stav.kdo === 'kraj' && stav.kraj ? ' · ' + stav.kraj
              : (stav.kdo === 'pratele' ? ' · mezi přáteli' : '');
  meta.textContent = (sin ? 'síň slávy' : nazevObdobi(obdobi)) + kdeText + ' · ' + hraciSlovo(celkemHracu);
  hl.appendChild(meta);
  if (stav.obdobi === 'tento') {
    var zb = dniDoKonceMesice();
    var od = document.createElement('span');
    od.className = 'odpocet';
    od.textContent = 'do konce měsíce ' + zb + (zb === 1 ? ' den' : (zb < 5 ? ' dny' : ' dní'));
    hl.appendChild(od);
  }
  elVysledek.appendChild(hl);

  // stupně vítězů: první tři (2. – 1. – 3.), zbytek do tabulky
  var top = radky.filter(function (r) { return r.poradi <= 3; }).slice(0, 3);
  var zbytek = radky.filter(function (r) { return r.poradi > 3; });
  if (top.length) {
    var st = document.createElement('div');
    st.className = 'stupne-v';
    var poradiKaret = top.length === 3 ? [1, 0, 2] : top.map(function (_, i) { return i; });
    poradiKaret.forEach(function (i) { st.appendChild(stupenVitezu(top[i], kat, korunky)); });
    elVysledek.appendChild(st);
  }

  if (zbytek.length) {
    var obal = document.createElement('div');
    obal.className = 'obal-tabulky';
    var tab = document.createElement('table');
    var hlava = document.createElement('thead');
    var hr = document.createElement('tr');
    [['poradi', '#'], ['jmeno', 'Přezdívka'], ['kraj', 'Kraj'], ['hodnota', kat.jednotka]]
      .forEach(function (par) {
        var th = document.createElement('th');
        th.className = par[0];
        th.scope = 'col';
        th.textContent = par[1];
        hr.appendChild(th);
      });
    hlava.appendChild(hr);
    tab.appendChild(hlava);

    var telo = document.createElement('tbody');
    var predchoziPoradi = 3;
    zbytek.forEach(function (r) {
      // vlastní řádek za TOP: vizuální mezera „…"
      if (r.poradi > predchoziPoradi + 1) {
        var trM = document.createElement('tr');
        trM.className = 'mezera';
        var tdM = td('', '…');
        tdM.colSpan = 4;
        trM.appendChild(tdM);
        telo.appendChild(trM);
      }
      predchoziPoradi = r.poradi;

      var tr = document.createElement('tr');
      if (relace && r.uid === relace.uid) tr.className = 'ja';
      tr.appendChild(td('poradi', r.poradi + '.'));

      var jmeno = td('jmeno', r.prezdivka);
      if (r.uroven > 0) {
        var ur = document.createElement('span');
        ur.className = 'uroven';
        ur.textContent = 'úr. ' + r.uroven;
        ur.title = 'Úroveň hráče';
        jmeno.appendChild(ur);
      }
      if (korunky && korunky[r.uid] && korunky[r.uid].length) {
        var kor = document.createElement('span');
        kor.className = 'koruna';
        kor.textContent = '👑';
        kor.title = '1. místo v ' + nazevObdobiKde(OBDOBI.minuly) + ': ' + korunky[r.uid].join(', ');
        kor.setAttribute('aria-label', kor.title);
        jmeno.appendChild(kor);
      }
      if (relace && r.uid === relace.uid) {
        var ja = document.createElement('span');
        ja.className = 'ja-stitek';
        ja.textContent = 'to jsi ty';
        jmeno.appendChild(ja);
      }
      if (r.kraj) {                       // na mobilu se sloupec Kraj skrývá
        var pod = document.createElement('span');
        pod.className = 'kraj-mob';
        pod.textContent = r.kraj;
        jmeno.appendChild(pod);
      }
      tr.appendChild(jmeno);
      tr.appendChild(td('kraj', r.kraj || '–'));
      tr.appendChild(td('hodnota', formatuj(r.hodnota, kat.desetinna)));
      telo.appendChild(tr);
    });
    tab.appendChild(telo);
    obal.appendChild(tab);
    elVysledek.appendChild(obal);
  }

}

/* ── „Moje pozice" (přihlášený hráč) ─────────────────────────────── */

function ukazMojiPozici(serazene, vse) {
  if (!elMoje) return;
  prazdny(elMoje);
  elMoje.hidden = true;
  if (!relace) return;
  var kat = kategorieDef();
  var muj = null;
  for (var i = 0; i < serazene.length; i++) {
    if (serazene[i].uid === relace.uid) { muj = serazene[i]; break; }
  }
  var box = document.createElement('div');
  box.className = 'moje';
  var h = document.createElement('h2');
  var p = document.createElement('p');
  if (!muj) {
    h.textContent = 'Moje pozice';
    var mamRadek = vse.some(function (r) { return r.uid === relace.uid; });
    p.textContent = mamRadek
      ? 'V téhle disciplíně zatím nemáš nic.'
      : 'Ještě nesoutěžíš. V aplikaci zapni „Více → Můj Okolník → Soutěžit v žebříčku" ' +
        'a při dalším odeslání se tu objevíš.';
    box.appendChild(h);
    box.appendChild(p);
    elMoje.appendChild(box);
    elMoje.hidden = false;
    return;
  }
  var n = serazene.length;
  var lepsiNez = n > 1 ? Math.round((n - muj.poradi) / (n - 1) * 100) : 100;
  h.textContent = 'Jsi ' + muj.poradi + '. z ' + hraciZ(n) + ' · ' + sJednotkou(muj.hodnota, kat);
  box.appendChild(h);

  var radky = [];
  if (muj.poradi > 1) {
    // nejbližší soupeř před tebou – blízký cíl táhne
    var pred = null;
    for (var j = 0; j < serazene.length; j++) {
      if (serazene[j].poradi < muj.poradi) pred = serazene[j];
    }
    if (pred) {
      var chybi = pred.hodnota - muj.hodnota;
      radky.push('Na ' + pred.poradi + '. místo (' + pred.prezdivka + ') chybí ' +
        sJednotkou(Math.max(chybi, kat.desetinna ? 0.1 : 1), kat) + '.');
    }
    if (n > 2) radky.push('Lepší než ' + lepsiNez + ' % hráčů v téhle kategorii.');
  } else {
    var druhy = null;
    for (var k = 0; k < serazene.length; k++) {
      if (serazene[k].poradi > 1) { druhy = serazene[k]; break; }
    }
    radky.push(druhy
      ? 'Vedeš – ' + druhy.prezdivka + ' za tebou zaostává o ' +
        sJednotkou(muj.hodnota - druhy.hodnota, kat) + '.'
      : 'Vedeš a zatím nemáš soupeře.');
  }
  if (stav.obdobi !== 'sin') {
    // osobní rekord z vlastních měsíců (hrdost, i když letos nevyhráváš)
    var nej = null;
    vse.forEach(function (r) {
      if (r.uid !== relace.uid) return;
      var hod = r[stav.metrika] || 0;
      if (!nej || hod > nej.hod) nej = { hod: hod, obdobi: r.obdobi };
    });
    if (nej && nej.hod > 0 && nej.obdobi !== OBDOBI[stav.obdobi]) {
      radky.push('Tvůj nejlepší měsíc: ' + sJednotkou(nej.hod, kat) +
        ' (' + nazevObdobi(nej.obdobi) + ').');
    } else if (nej && nej.obdobi === OBDOBI[stav.obdobi] && stav.obdobi === 'tento') {
      radky.push('Tenhle měsíc je tvůj nejlepší v téhle kategorii – jen tak dál!');
    }
    if (stav.obdobi === 'tento') {
      var minule = seradVse(vse, OBDOBI.minuly, stav.metrika);
      for (var m = 0; m < minule.length; m++) {
        if (minule[m].uid === relace.uid) {
          radky.push('Minulý měsíc: ' + minule[m].poradi + '. místo z ' + hraciZ(minule.length) + '.');
          break;
        }
      }
    }
  }
  radky.forEach(function (t) {
    var q = document.createElement('p');
    q.textContent = t;
    box.appendChild(q);
  });
  elMoje.appendChild(box);
  elMoje.hidden = false;
}

/* ── kraje do výběru ────────────────────────────────────────────── */

function naplnKraje(vse) {
  var sel = document.getElementById('vyberKraje');
  if (!sel) return;
  var kraje = {};
  vse.forEach(function (r) { if (r.kraj) kraje[r.kraj] = true; });
  var seznam = Object.keys(kraje).sort(function (a, b) { return a.localeCompare(b, 'cs'); });
  var puvodni = sel.value;
  prazdny(sel);
  var o0 = document.createElement('option');
  o0.value = '';
  o0.textContent = 'Vyber kraj…';
  sel.appendChild(o0);
  seznam.forEach(function (k) {
    var o = document.createElement('option');
    o.value = k;
    o.textContent = k;
    sel.appendChild(o);
  });
  // předvolit kraj přihlášeného hráče
  if (!stav.kraj && relace) {
    vse.forEach(function (r) { if (r.uid === relace.uid && r.kraj) stav.kraj = r.kraj; });
  }
  sel.value = stav.kraj || puvodni || '';
  if (sel.value !== stav.kraj) stav.kraj = sel.value;
}

function ukazChybu(e) {
  var kod = (e && e.kod) || 'CHYBA';
  if (kod === 'PERMISSION_DENIED') {
    // Typicky: pravidla pro kolekci `zebricek` ještě nejsou nasazená.
    ukazStav('', 'Žebříček se teprve spouští', [
      'Soutěž zatím není otevřená. Zkuste to prosím za pár dní – ' +
      'nebo si zatím v aplikaci zapněte účast, ať vám nic neuteče.'
    ]);
    return;
  }
  if (kod === 'FAILED_PRECONDITION') {
    ukazStav('chyba', 'Žebříček se nepovedlo seřadit', [
      'Databáze hlásí, že chybí index. Napište nám prosím na ' +
      'stamu.apps@gmail.com, ať to opravíme.'
    ], 'Zkusit znovu');
    return;
  }
  ukazStav('chyba', 'Žebříček se nepodařilo načíst', [
    kod === 'TIMEOUT'
      ? 'Server neodpověděl včas. Zkontrolujte připojení k internetu.'
      : 'Zkontrolujte připojení k internetu a zkuste to prosím znovu.',
    'Technický kód: ' + kod
  ], 'Zkusit znovu');
}

/* ── načtení + přepínače ────────────────────────────────────────── */

function nacti() {
  var muj = ++behZmena;
  var obdobi = OBDOBI[stav.obdobi];
  var metrika = stav.metrika;

  elVysledek.setAttribute('aria-busy', 'true');
  ukazStav('nacita', null, ['Načítám žebříček…']);

  var prace = vsechnyRadky().then(function (vse) {
    var pr = stav.kdo === 'pratele' ? nactiPratele() : Promise.resolve(null);
    return pr.then(function (pratele) { return { vse: vse, pratele: pratele }; });
  });

  prace.then(function (d) {
    if (muj !== behZmena) return;                 // mezitím se přepnulo jinam
    elVysledek.setAttribute('aria-busy', 'false');
    naplnKraje(d.vse);
    var serazene = precisluj(uplatniKdo(seradVse(d.vse, obdobi, metrika), d.pratele));
    var korunky = koruny(d.vse);
    ukazMojiPozici(serazene, d.vse);
    if (!serazene.length) {
      var proc;
      if (stav.kdo === 'pratele') {
        proc = relace
          ? 'Nikdo z tvých přátel v téhle kategorii zatím nic nemá – pošli jim svůj kód přítele v aplikaci.'
          : 'Přátele uvidíš po přihlášení na Můj Okolník.';
      } else if (stav.kdo === 'kraj' && !stav.kraj) {
        proc = 'Vyber kraj v nabídce výš.';
      } else if (stav.obdobi === 'sin') {
        proc = 'Síň slávy se plní z hlášení aplikace od verze 1.613.92 – zatím tu nikdo není.';
      } else {
        proc = stav.obdobi === 'tento'
          ? 'V ' + nazevObdobiKde(obdobi) + ' tu v téhle kategorii ještě nikdo nic nemá. ' +
            'Můžeš být první – v aplikaci Více → Můj Okolník → Soutěžit v žebříčku.'
          : 'Za ' + nazevObdobi(obdobi) + ' tu v téhle kategorii žádné výsledky nejsou.';
      }
      ukazStav('', 'Zatím prázdno', [proc]);
      return;
    }
    // TOP N + vlastní řádek, když je až za ním
    var vypis = serazene.slice(0, LIMIT);
    if (relace) {
      var jaVTop = vypis.some(function (r) { return r.uid === relace.uid; });
      if (!jaVTop) {
        serazene.forEach(function (r) { if (r.uid === relace.uid) vypis.push(r); });
      }
    }
    ukazTabulku(vypis, serazene.length, korunky);
  }).catch(function (e) {
    if (muj !== behZmena) return;
    elVysledek.setAttribute('aria-busy', 'false');
    ukazChybu(e);
  });
}

/** Tlačítka kategorií podle období (měsíc × síň slávy). */
function vykresliKategorie() {
  var obal = document.getElementById('prepinacKategorie');
  if (!obal) return;
  var def = stav.obdobi === 'sin' ? SIN : KATEGORIE;
  if (!def[stav.metrika]) stav.metrika = Object.keys(def)[0];
  prazdny(obal);
  Object.keys(def).forEach(function (k) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('data-metrika', k);
    b.setAttribute('aria-pressed', k === stav.metrika ? 'true' : 'false');
    b.title = def[k].pravidlo;   // pravidlo jen po najetí, ne v textu (14. 9.)
    var ik = document.createElement('span');
    ik.className = 'ik';
    ik.setAttribute('aria-hidden', 'true');
    ik.textContent = def[k].ikona;
    b.appendChild(ik);
    b.appendChild(document.createTextNode(def[k].nazev));
    obal.appendChild(b);
  });
}

function zapniPrepinac(id, atribut, klic) {
  var obal = document.getElementById(id);
  if (!obal) return;
  obal.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('button[data-' + atribut + ']') : null;
    if (!b || !obal.contains(b)) return;
    var hodnota = b.getAttribute('data-' + atribut);
    if (stav[klic] === hodnota) return;
    stav[klic] = hodnota;
    Array.prototype.forEach.call(obal.querySelectorAll('button'), function (jiny) {
      jiny.setAttribute('aria-pressed', jiny === b ? 'true' : 'false');
    });
    if (klic === 'obdobi') vykresliKategorie();
    var sel = document.getElementById('vyberKraje');
    if (sel) sel.hidden = stav.kdo !== 'kraj';
    ulozDoAdresy();
    nacti();
  });
}

function ulozDoAdresy() {
  if (!window.history || !history.replaceState) return;
  var q = '?kategorie=' + stav.metrika + '&obdobi=' + stav.obdobi +
    (stav.kdo !== 'vsichni' ? '&kdo=' + stav.kdo : '') +
    (stav.kdo === 'kraj' && stav.kraj ? '&kraj=' + encodeURIComponent(stav.kraj) : '') +
    (UKAZKA ? '&ukazka=1' : '');
  history.replaceState(null, '', location.pathname + q);
}

function zAdresy() {
  var p;
  try { p = new URLSearchParams(location.search); } catch (e) { return; }
  var o = p.get('obdobi');
  if (o === 'tento' || o === 'minuly' || o === 'sin') stav.obdobi = o;
  var k = p.get('kategorie');
  var def = stav.obdobi === 'sin' ? SIN : KATEGORIE;
  if (k && def[k]) stav.metrika = k;
  var kdo = p.get('kdo');
  if (kdo === 'kraj' || kdo === 'pratele') stav.kdo = kdo;
  var kraj = p.get('kraj');
  if (kraj) stav.kraj = kraj.substring(0, 30);
  [['prepinacObdobi', 'obdobi', stav.obdobi], ['prepinacKdo', 'kdo', stav.kdo]]
    .forEach(function (t) {
      var obal = document.getElementById(t[0]);
      if (!obal) return;
      Array.prototype.forEach.call(obal.querySelectorAll('button'), function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-' + t[1]) === t[2] ? 'true' : 'false');
      });
    });
}

/* ── ukázková data (?ukazka=1) – jen pro náhled vzhledu ─────────── */

function ukazkovaData() {
  var vzor = [
    ['Poutník z Podhůří', 'Jihomoravský', 214.6, 31, 7, 12, 3, 4, 19, 9, 61000, 480, 21],
    ['Bobr Bedřich', 'Vysočina', 188.2, 24, 11, 8, 5, 2, 22, 12, 88000, 620, 17],
    ['Toulavá Tereza', 'Královéhradecký', 173.9, 24, 4, 15, 1, 6, 14, 5, 40000, 310, 25],
    ['Hraničář', 'Liberecký', 121.4, 18, 9, 6, 7, 1, 11, 4, 30000, 250, 14],
    ['Křemílek', 'Středočeský', 98.0, 12, 2, 3, 0, 2, 9, 3, 21000, 90, 8],
    ['Rozárka', 'Zlínský', 61.5, 9, 6, 4, 2, 3, 7, 7, 15000, 140, 11]
  ];
  var ven = [];
  ['tento', 'minuly'].forEach(function (o, oi) {
    vzor.forEach(function (v, i) {
      var f = oi ? 0.8 : 1;
      ven.push({
        uid: 'ukazka' + i, prezdivka: v[0], kraj: v[1], obdobi: OBDOBI[o],
        km: Math.round(v[2] * f * 10) / 10, obce: Math.round(v[3] * f), vypravy: Math.round(v[4] * f),
        navstevy: Math.round(v[5] * f), vrcholy: v[6], malovana: v[7], dny: v[8], serie: v[9],
        kroky: Math.round(v[10] * f), xp: v[11], uroven: v[12],
        celkem: { uroven: v[12], km: v[2] * 9, obce: v[3] * 11, navstevy: v[5] * 8,
                  malovana: v[7] * 6, vrcholy: v[6] * 5, xp: v[11] * 7, uspechy: 20 + i * 7 }
      });
    });
  });
  return ven;
}

/* ── start ──────────────────────────────────────────────────────── */

function start() {
  if (UKAZKA) {
    var pruh = document.getElementById('ukazkaPruh');
    if (pruh) pruh.hidden = false;
  }
  relace = nactiRelaci();
  zAdresy();
  vykresliKategorie();
  zapniPrepinac('prepinacKategorie', 'metrika', 'metrika');
  zapniPrepinac('prepinacObdobi', 'obdobi', 'obdobi');
  zapniPrepinac('prepinacKdo', 'kdo', 'kdo');
  var sel = document.getElementById('vyberKraje');
  if (sel) {
    sel.hidden = stav.kdo !== 'kraj';
    sel.addEventListener('change', function () {
      stav.kraj = sel.value;
      ulozDoAdresy();
      nacti();
    });
  }
  var bp = document.querySelector('#prepinacKdo button[data-kdo="pratele"]');
  if (bp && !relace) bp.title = 'Přátele uvidíš po přihlášení na Můj Okolník';
  nacti();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
