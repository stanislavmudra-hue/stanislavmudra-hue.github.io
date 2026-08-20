/* =====================================================================
   Žebříček Okolníku – čte se přímo z Firebase Firestore přes REST API.

   Web na okolnik.cz je STATICKÝ (GitHub Pages), žádný backend tu není.
   Data proto tahá prohlížeč sám: veřejné čtení kolekce `zebricek`.
   Bez knihoven, bez CDN, jen fetch.

   Zápis dělá mobilní aplikace (jeden dokument na hráče a měsíc);
   formát dokumentu i potřebná Firestore pravidla jsou popsané
   v /ZEBRICEK-POZNAMKY.md v kořeni tohoto repozitáře.
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

/* ---------------------------------------------------------------------
   PROČ PROSTÝ VÝPIS A ŘAZENÍ V JS, A NE runQuery
   ---------------------------------------------------------------------
   `runQuery` se `where obdobi == "2026-08"` a `orderBy km DESC` je
   rovnost na jednom poli + řazení podle JINÉHO pole. Na to Firestore
   vyžaduje SLOŽENÝ index; automatické jednopolové indexy nestačí.
   Dokud index neexistuje, dotaz spadne na FAILED_PRECONDITION – tedy
   přesně ten scénář „nasadil jsem web a nic se nenačítá".

   Prostý výpis kolekce (documents.list) žádný index nepotřebuje,
   funguje od první minuty a při dnešních počtech hráčů je levný:
   posílá se jen 7 polí (mask.fieldPaths) a stránkuje se po 300.
   Období i pořadí se dopočítá v prohlížeči; navíc se tím jedním
   stažením obslouží všechny tři kategorie (kešuje se podle období).

   AŽ jich bude moc (řekněme přes ~2 000 řádků v kolekci), stačí:
     1) ve Firebase konzoli založit tři složené indexy
        (obdobi ASC + km DESC), (obdobi ASC + obce DESC),
        (obdobi ASC + vypravy DESC),
     2) přepnout POUZIT_RUNQUERY na true.
   Kód pro obě cesty je níž, chování stránky je identické.
--------------------------------------------------------------------- */
var POUZIT_RUNQUERY = false;

var STRANKA = 300;      // maximum, které documents.list vrátí najednou
var MAX_STRANEK = 8;    // pojistka proti nekonečnému stahování
var LIMIT = 50;         // TOP 50
var TIMEOUT_MS = 12000;

var POLE = ['prezdivka', 'obdobi', 'km', 'obce', 'vypravy', 'kraj', 'aktualizovano'];

var KATEGORIE = {
  km:      { nazev: 'Ušlé kilometry', jednotka: 'km',      desetinna: 1 },
  obce:    { nazev: 'Nové obce',      jednotka: 'obcí',    desetinna: 0 },
  vypravy: { nazev: 'Fotovýpravy',    jednotka: 'výprav',  desetinna: 0 }
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
  minuly: klicObdobi(new Date(ted.getFullYear(), ted.getMonth() - 1, 1))
};

/* ── stav stránky ───────────────────────────────────────────────── */

var stav = { metrika: 'km', obdobi: 'tento' };
var kes = {};          // klíč období (nebo "období|metrika") → Promise s řádky
var behZmena = 0;      // pořadové číslo požadavku, ať starší odpověď nepřepíše novější
var UKAZKA = /[?&]ukazka=1(&|$)/.test(location.search);

var elVysledek = document.getElementById('vysledek');

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
  return {
    prezdivka: prezdivka,
    obdobi: text(f.obdobi, 7),
    kraj: text(f.kraj, 30),
    km: Math.max(0, cislo(f.km)),
    obce: Math.max(0, Math.round(cislo(f.obce))),
    vypravy: Math.max(0, Math.round(cislo(f.vypravy)))
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

function sTimeoutem(url, telo) {
  var ac = ('AbortController' in window) ? new AbortController() : null;
  var casovac = setTimeout(function () { if (ac) ac.abort(); }, TIMEOUT_MS);
  var nastaveni = { headers: { 'Accept': 'application/json' } };
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

/* ── výběr, řazení, pořadí ──────────────────────────────────────── */

function seradAOrez(radky, obdobi, metrika, uzFiltrovano) {
  var vybrane = uzFiltrovano
    ? radky.slice()
    : radky.filter(function (r) { return r.obdobi === obdobi; });

  vybrane = vybrane.filter(function (r) { return r[metrika] > 0; });
  vybrane.sort(function (a, b) {
    if (b[metrika] !== a[metrika]) return b[metrika] - a[metrika];
    return a.prezdivka.localeCompare(b.prezdivka, 'cs');
  });
  vybrane = vybrane.slice(0, LIMIT);

  // Shodná hodnota = shodné pořadí (1, 2, 2, 4 …).
  var poradi = 0, predchozi = null;
  vybrane.forEach(function (r, i) {
    if (predchozi === null || r[metrika] !== predchozi) { poradi = i + 1; predchozi = r[metrika]; }
    r.poradi = poradi;
  });
  return vybrane;
}

function ziskejRadky(obdobi, metrika) {
  if (UKAZKA) return Promise.resolve(seradAOrez(ukazkovaData(obdobi), obdobi, metrika));

  if (POUZIT_RUNQUERY) {
    var k = obdobi + '|' + metrika;
    if (!kes[k]) {
      kes[k] = nactiDotazem(obdobi, metrika).catch(function (e) { delete kes[k]; throw e; });
    }
    return kes[k].then(function (r) { return seradAOrez(r, obdobi, metrika, true); });
  }

  if (!kes[obdobi]) {
    // Jedno stažení obslouží všechny tři kategorie téhož měsíce.
    kes[obdobi] = nactiVypisem().catch(function (e) { delete kes[obdobi]; throw e; });
  }
  return kes[obdobi].then(function (r) { return seradAOrez(r, obdobi, metrika); });
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

function ukazTabulku(radky, obdobi, metrika) {
  var kat = KATEGORIE[metrika];
  prazdny(elVysledek);

  var obal = document.createElement('div');
  obal.className = 'obal-tabulky';
  var tab = document.createElement('table');

  var popis = document.createElement('caption');
  popis.textContent = kat.nazev + ' – ' + nazevObdobi(obdobi) +
    ' · ' + radky.length + (radky.length === 1 ? ' hráč' :
      (radky.length < 5 ? ' hráči' : ' hráčů'));
  tab.appendChild(popis);

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
  radky.forEach(function (r) {
    var tr = document.createElement('tr');
    if (r.poradi <= 3) tr.className = 'stupne m' + r.poradi;

    tr.appendChild(td('poradi', r.poradi + '.'));

    var jmeno = td('jmeno', r.prezdivka);
    if (r.kraj) {                       // na mobilu se sloupec Kraj skrývá
      var pod = document.createElement('span');
      pod.className = 'kraj-mob';
      pod.textContent = r.kraj;
      jmeno.appendChild(pod);
    }
    tr.appendChild(jmeno);

    tr.appendChild(td('kraj', r.kraj || '–'));
    tr.appendChild(td('hodnota', formatuj(r[metrika], kat.desetinna)));
    telo.appendChild(tr);
  });
  tab.appendChild(telo);
  obal.appendChild(tab);
  elVysledek.appendChild(obal);
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

  ziskejRadky(obdobi, metrika).then(function (radky) {
    if (muj !== behZmena) return;                 // mezitím se přepnulo jinam
    elVysledek.setAttribute('aria-busy', 'false');
    if (!radky.length) {
      ukazStav('', 'Zatím nikdo nesoutěží', [
        stav.obdobi === 'tento'
          ? 'V ' + nazevObdobiKde(obdobi) + ' se do žebříčku ještě nikdo nepřihlásil. ' +
            'Můžete být první – v aplikaci Nastavení → Žebříček.'
          : 'Za ' + nazevObdobi(obdobi) + ' tu žádné výsledky nejsou.'
      ]);
      return;
    }
    ukazTabulku(radky, obdobi, metrika);
  }).catch(function (e) {
    if (muj !== behZmena) return;
    elVysledek.setAttribute('aria-busy', 'false');
    ukazChybu(e);
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
    ulozDoAdresy();
    nacti();
  });
}

function ulozDoAdresy() {
  if (!window.history || !history.replaceState) return;
  var q = '?kategorie=' + stav.metrika + '&obdobi=' + stav.obdobi + (UKAZKA ? '&ukazka=1' : '');
  history.replaceState(null, '', location.pathname + q);
}

function zAdresy() {
  var p;
  try { p = new URLSearchParams(location.search); } catch (e) { return; }
  var k = p.get('kategorie');
  if (k && KATEGORIE[k]) stav.metrika = k;
  var o = p.get('obdobi');
  if (o === 'tento' || o === 'minuly') stav.obdobi = o;
  [['prepinacKategorie', 'metrika', stav.metrika], ['prepinacObdobi', 'obdobi', stav.obdobi]]
    .forEach(function (t) {
      var obal = document.getElementById(t[0]);
      if (!obal) return;
      Array.prototype.forEach.call(obal.querySelectorAll('button'), function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-' + t[1]) === t[2] ? 'true' : 'false');
      });
    });
}

/* ── ukázková data (?ukazka=1) – jen pro náhled vzhledu ─────────── */

function ukazkovaData(obdobi) {
  var vzor = [
    ['Poutník z Podhůří', 'Jihomoravský', 214.6, 31, 7],
    ['Bobr Bedřich', 'Vysočina', 188.2, 24, 11],
    ['Toulavá Tereza', 'Královéhradecký', 173.9, 24, 4],
    ['Hraničář', 'Liberecký', 121.4, 18, 9],
    ['Křemílek', 'Středočeský', 98.0, 12, 2],
    ['Rozárka', 'Zlínský', 61.5, 9, 6]
  ];
  return vzor.map(function (v) {
    return { prezdivka: v[0], kraj: v[1], km: v[2], obce: v[3], vypravy: v[4], obdobi: obdobi };
  });
}

/* ── start ──────────────────────────────────────────────────────── */

function start() {
  if (UKAZKA) {
    var pruh = document.getElementById('ukazkaPruh');
    if (pruh) pruh.hidden = false;
  }
  zAdresy();
  zapniPrepinac('prepinacKategorie', 'metrika', 'metrika');
  zapniPrepinac('prepinacObdobi', 'obdobi', 'obdobi');
  nacti();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
