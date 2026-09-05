/* =====================================================================
   Stránky režimů (Cestovatel, Objevitel) – popis režimu, výřez žebříčku
   a po přihlášení vlastní čísla.

   Web na okolnik.cz je STATICKÝ (GitHub Pages), žádný backend. Všechno
   se čte přímo z Firestore přes REST, bez knihoven:

     • žebříček  – veřejná kolekce `zebricek` (jeden dokument na hráče
                   a měsíc; formát v /ZEBRICEK-POZNAMKY.md),
     • moje čísla – soukromý profil `hraci/{uid}` (čte jen vlastník,
                   formát v /UCET-POZNAMKY.md).

   Přihlášení je SDÍLENÉ s Můj Okolník: relace leží v localStorage pod
   klíčem `okolnikUcet1` (stejně ji čte i /dobyvatel/). Tlačítko Googlu
   je jen na /ucet/, tady se na něj odkazuje – jeden přihlašovací kód,
   jedno místo, kde se může něco pokazit.

   Který režim stránka ukazuje, říká `<body data-rezim="cestovatel">`.
   `?ukazka=1` vykreslí smyšlená data (náhled vzhledu bez účtu).
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------------
   Konfigurace
--------------------------------------------------------------------- */
var PROJEKT = 'sarcher-b32a1';
// ⚠️ JINÝ KLÍČ NEŽ V APLIKACI: omezený na okolnik.cz + Identity Toolkit,
// Firestore a Token Service. Data chrání Firestore Rules, ne klíč.
var KLIC = 'AIzaSyB3sj8qS-Lh4lHow6AUrWH-JayEtJ70igQ';
var ZAKLAD = 'https://firestore.googleapis.com/v1/projects/' + PROJEKT +
             '/databases/(default)/documents';
var TIMEOUT_MS = 12000;
var ULOZISTE = 'okolnikUcet1';
var TOP = 10;               // výřez žebříčku na stránce režimu
var STRANKA = 300;          // documents.list: maximum na stránku
var MAX_STRANEK = 8;        // pojistka proti nekonečnému stahování

var REZIM = (document.body && document.body.getAttribute('data-rezim'))
  || 'cestovatel';
var UKAZKA = /[?&]ukazka=1(&|$)/.test(location.search);

/* Co který režim ukazuje. `metriky` = kategorie žebříčku (pole
   dokumentu `zebricek`), `celkem`/`mesic` = dlaždice z profilu hráče
   (`hraci/{uid}.souhrn` a `.mesic`). Formát dlaždice: [popisek, pole,
   desetinná místa]. */
var REZIMY = {
  cestovatel: {
    nazev: 'Cestovatel',
    metriky: [
      { pole: 'km', nazev: 'Ušlé kilometry', jednotka: 'km', desetinna: 1 }
    ],
    celkem: [['Ušlé km', 'km', 1], ['Obce', 'obce', 0],
             ['Aktivní dny', 'dny', 0]],
    mesic: [['Ušlé km', 'km', 1], ['Nové obce', 'obce', 0],
            ['Aktivní dny', 'dny', 0], ['Kroky', 'kroky', 0]],
    kroky: true
  },
  objevitel: {
    nazev: 'Objevitel',
    metriky: [
      { pole: 'obce', nazev: 'Nové obce', jednotka: 'obcí', desetinna: 0 },
      { pole: 'vypravy', nazev: 'Fotovýpravy', jednotka: 'výprav', desetinna: 0 }
    ],
    celkem: [['Úroveň', 'uroven', 0], ['Doložené návštěvy', 'navstevy', 0],
             ['Fotovýpravy', 'vypravy', 0], ['Obce', 'obce', 0]],
    mesic: [['Navštívená místa', 'navstevy', 0], ['Fotovýpravy', 'vypravy', 0],
            ['Nové obce', 'obce', 0], ['Aktivní dny', 'dny', 0]],
    kroky: false
  }
};
var NASTAVENI = REZIMY[REZIM] || REZIMY.cestovatel;

var MESICE = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen',
              'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];

/* ---------------------------------------------------------------------
   Drobná pomocná kuchyň (stejná jako na /ucet/ a /zebricek/)
--------------------------------------------------------------------- */
function el(id) { return document.getElementById(id); }

function prvek(tag, trida, text) {
  var e = document.createElement(tag);
  if (trida) e.className = trida;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

function prazdny(e) { while (e.firstChild) e.removeChild(e.firstChild); }

/** Uživatelský text bez řídicích a obousměrných znaků, s ořezem délky. */
function ocisti(s, max) {
  if (typeof s !== 'string') return '';
  var v = s.replace(
    /[\x00-\x1F\x7F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g,
    '').trim();
  return v.length > (max || 60) ? v.slice(0, max || 60) + '…' : v;
}

function cislo(v, desetinna) {
  if (typeof v !== 'number' || !isFinite(v)) return '–';
  return v.toLocaleString('cs-CZ', {
    minimumFractionDigits: desetinna || 0,
    maximumFractionDigits: desetinna || 0
  });
}

function obdobiKlic(d) {
  var m = d.getMonth() + 1;
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : String(m));
}

function nazevObdobi(klic) {
  var c = /^(\d{4})-(\d{2})$/.exec(klic || '');
  if (!c) return klic || '';
  var m = parseInt(c[2], 10) - 1;
  return (MESICE[m] || klic) + ' ' + c[1];
}

/** fetch s časovým stropem – bez něj se stránka umí zaseknout napořád. */
function sit(url, volby) {
  volby = volby || {};
  var ovladac = ('AbortController' in window) ? new AbortController() : null;
  var casovac = setTimeout(function () { if (ovladac) ovladac.abort(); }, TIMEOUT_MS);
  if (ovladac) volby.signal = ovladac.signal;
  return fetch(url, volby).then(function (r) {
    clearTimeout(casovac);
    return r;
  }, function (e) {
    clearTimeout(casovac);
    throw e;
  });
}

/* Firestore REST → obyčejné hodnoty (integerValue chodí jako ŘETĚZEC). */
function zFirestore(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return !!v.booleanValue;
  if ('bytesValue' in v) return v.bytesValue;   // base64 (sync)
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('mapValue' in v) {
    var m = {}, pole = (v.mapValue && v.mapValue.fields) || {};
    for (var k in pole) if (Object.prototype.hasOwnProperty.call(pole, k)) {
      m[k] = zFirestore(pole[k]);
    }
    return m;
  }
  if ('arrayValue' in v) {
    return ((v.arrayValue && v.arrayValue.values) || []).map(zFirestore);
  }
  return null;
}

function dokumentNaObjekt(doc) {
  var o = {}, pole = (doc && doc.fields) || {};
  for (var k in pole) if (Object.prototype.hasOwnProperty.call(pole, k)) {
    o[k] = zFirestore(pole[k]);
  }
  return o;
}

/* ---------------------------------------------------------------------
   Relace (sdílená s Můj Okolník)
--------------------------------------------------------------------- */
var relace = null;   // {uid, idToken, refreshToken, vyprsi, jmeno, mail, foto}

function nactiRelaci() {
  try {
    var s = localStorage.getItem(ULOZISTE);
    if (!s) return null;
    var r = JSON.parse(s);
    return (r && r.refreshToken && r.uid) ? r : null;
  } catch (e) { return null; }
}

function ulozRelaci() {
  try {
    if (relace) localStorage.setItem(ULOZISTE, JSON.stringify(relace));
    else localStorage.removeItem(ULOZISTE);
  } catch (e) { /* privátní režim */ }
}

/** Platný idToken; hodinové tokeny se obnoví přes refreshToken. */
function token() {
  if (!relace) return Promise.reject(new Error('nepřihlášen'));
  if (relace.idToken && relace.vyprsi > Date.now() + 60000) {
    return Promise.resolve(relace.idToken);
  }
  return sit('https://securetoken.googleapis.com/v1/token?key=' + KLIC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=refresh_token&refresh_token=' +
          encodeURIComponent(relace.refreshToken)
  }).then(function (r) {
    if (!r.ok) throw new Error('obnova tokenu selhala');
    return r.json();
  }).then(function (d) {
    relace.idToken = d.id_token;
    relace.refreshToken = d.refresh_token || relace.refreshToken;
    relace.vyprsi = Date.now() + (Number(d.expires_in || 3600) * 1000);
    ulozRelaci();
    return relace.idToken;
  });
}

/** Soukromý dokument (s tokenem); `null` = neexistuje. */
function ctiSoukrome(cesta) {
  return token().then(function (t) {
    return sit(ZAKLAD + '/' + cesta, { headers: { Authorization: 'Bearer ' + t } });
  }).then(function (r) {
    if (r.status === 404) return null;
    if (r.status === 403) throw new Error('PERMISSION_DENIED');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json().then(dokumentNaObjekt);
  });
}

/* ---------------------------------------------------------------------
   Žebříček – jedno stažení kolekce, řazení v prohlížeči
   (proč ne runQuery: viz /zebricek/zebricek.js – chtělo by složené
   indexy; při dnešních počtech hráčů je výpis levnější a bez pastí).
--------------------------------------------------------------------- */
var POLE = ['hrac', 'prezdivka', 'obdobi', 'km', 'obce', 'vypravy', 'kraj'];
var kesZebricku = null;   // Promise se VŠEMI řádky (všechna období)

function naRadek(doc) {
  if (!doc || !doc.fields) return null;
  var d = dokumentNaObjekt(doc);
  var prezdivka = ocisti(typeof d.prezdivka === 'string' ? d.prezdivka : '', 20);
  if (!prezdivka) return null;
  function nezaporne(v) { return (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0; }
  return {
    uid: typeof d.hrac === 'string' ? d.hrac : '',
    prezdivka: prezdivka,
    obdobi: typeof d.obdobi === 'string' ? d.obdobi : '',
    kraj: ocisti(typeof d.kraj === 'string' ? d.kraj : '', 30),
    km: nezaporne(d.km),
    obce: Math.round(nezaporne(d.obce)),
    vypravy: Math.round(nezaporne(d.vypravy))
  };
}

function stahniZebricek() {
  var vse = [];
  var stranka = 0;
  function dalsi(pokracovani) {
    var u = new URL(ZAKLAD + '/zebricek');
    u.searchParams.set('key', KLIC);
    u.searchParams.set('pageSize', String(STRANKA));
    POLE.forEach(function (p) { u.searchParams.append('mask.fieldPaths', p); });
    if (pokracovani) u.searchParams.set('pageToken', pokracovani);
    return sit(u.toString(), { headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (j) {
        if (j && Array.isArray(j.documents)) {
          for (var i = 0; i < j.documents.length; i++) {
            var rad = naRadek(j.documents[i]);
            if (rad) vse.push(rad);
          }
        }
        stranka++;
        var t = (j && j.nextPageToken) ? j.nextPageToken : null;
        if (t && stranka < MAX_STRANEK) return dalsi(t);
        return vse;
      });
  }
  return dalsi(null);
}

function radkyZebricku(obdobi) {
  if (UKAZKA) return Promise.resolve(ukazkoveRadky(obdobi));
  if (!kesZebricku) {
    kesZebricku = stahniZebricek().catch(function (e) { kesZebricku = null; throw e; });
  }
  return kesZebricku.then(function (r) {
    return r.filter(function (x) { return x.obdobi === obdobi; });
  });
}

/** Seřazené řádky s pořadím (shodná hodnota = shodné pořadí). */
function seradit(radky, metrika) {
  var v = radky.filter(function (r) { return r[metrika] > 0; });
  v.sort(function (a, b) {
    if (b[metrika] !== a[metrika]) return b[metrika] - a[metrika];
    return a.prezdivka.localeCompare(b.prezdivka, 'cs');
  });
  var poradi = 0, predchozi = null;
  v.forEach(function (r, i) {
    if (predchozi === null || r[metrika] !== predchozi) { poradi = i + 1; predchozi = r[metrika]; }
    r.poradi = poradi;
  });
  return v;
}

function ukazkoveRadky(obdobi) {
  var vzor = [
    ['Poutník z Podhůří', 'Jihomoravský', 214.6, 31, 7],
    ['Bobr Bedřich', 'Vysočina', 188.2, 24, 11],
    ['Toulavá Tereza', 'Královéhradecký', 173.9, 24, 4],
    ['Hraničář', 'Liberecký', 121.4, 18, 9],
    ['Křemílek', 'Středočeský', 98.0, 12, 2],
    ['Rozárka', 'Zlínský', 61.5, 9, 6]
  ];
  return vzor.map(function (v, i) {
    return { uid: 'ukazka' + i, prezdivka: v[0], kraj: v[1], km: v[2],
             obce: v[3], vypravy: v[4], obdobi: obdobi };
  });
}

/* ---------------------------------------------------------------------
   Vykreslení: výřez žebříčku
--------------------------------------------------------------------- */
function stavovaKarta(nadpis, text, trida) {
  var s = prvek('div', 'stav' + (trida ? ' ' + trida : ''));
  if (nadpis) s.appendChild(prvek('h3', null, nadpis));
  if (text) s.appendChild(prvek('p', null, text));
  return s;
}

function nacitani(text) {
  var s = prvek('div', 'stav');
  var t = prvek('div', 'tocka');
  t.setAttribute('aria-hidden', 'true');
  s.appendChild(t);
  s.appendChild(prvek('p', null, text));
  return s;
}

function tabulka(radky, metrika, mujUid) {
  var obal = prvek('div', 'obal-tabulky');
  var tab = prvek('table');
  var hlava = prvek('thead');
  var hr = prvek('tr');
  [['poradi', '#'], ['jmeno', 'Přezdívka'], ['kraj', 'Kraj'],
   ['hodnota', metrika.jednotka]].forEach(function (par) {
    var th = prvek('th', par[0], par[1]);
    th.scope = 'col';
    hr.appendChild(th);
  });
  hlava.appendChild(hr);
  tab.appendChild(hlava);

  var telo = prvek('tbody');
  radky.slice(0, TOP).forEach(function (r) {
    var tr = prvek('tr');
    var tridy = [];
    if (r.poradi <= 3) tridy.push('stupne', 'm' + r.poradi);
    if (mujUid && r.uid === mujUid) tridy.push('ja');
    tr.className = tridy.join(' ');
    tr.appendChild(prvek('td', 'poradi', r.poradi + '.'));
    var jmeno = prvek('td', 'jmeno', r.prezdivka);
    if (r.kraj) jmeno.appendChild(prvek('span', 'kraj-mob', r.kraj));
    tr.appendChild(jmeno);
    tr.appendChild(prvek('td', 'kraj', r.kraj || '–'));
    tr.appendChild(prvek('td', 'hodnota', cislo(r[metrika.pole], metrika.desetinna)));
    telo.appendChild(tr);
  });
  tab.appendChild(telo);
  obal.appendChild(tab);
  return obal;
}

function vykresliZebricek() {
  var box = el('zebricek');
  if (!box) return;
  var obdobi = obdobiKlic(new Date());
  prazdny(box);
  box.appendChild(nacitani('Načítám žebříček…'));
  box.setAttribute('aria-busy', 'true');

  radkyZebricku(obdobi).then(function (radky) {
    prazdny(box);
    box.setAttribute('aria-busy', 'false');
    var mujUid = relace ? relace.uid : null;
    NASTAVENI.metriky.forEach(function (metrika) {
      var blok = prvek('div', 'blok-zebricku');
      var h = prvek('h3', null, metrika.nazev + ' – ' + nazevObdobi(obdobi));
      blok.appendChild(h);
      var serazene = seradit(radky, metrika.pole);
      if (!serazene.length) {
        blok.appendChild(stavovaKarta(null,
          'Tento měsíc se v této kategorii ještě nikdo neukázal. ' +
          'Můžete být první – v aplikaci Nastavení → Žebříček.'));
      } else {
        blok.appendChild(tabulka(serazene, metrika, mujUid));
        var ja = null;
        if (mujUid) {
          for (var i = 0; i < serazene.length; i++) {
            if (serazene[i].uid === mujUid) { ja = serazene[i]; break; }
          }
        }
        if (ja && ja.poradi > TOP) {
          blok.appendChild(prvek('p', 'poznamka',
            'Vy: ' + ja.poradi + '. místo z ' + serazene.length + ' (' +
            cislo(ja[metrika.pole], metrika.desetinna) + ' ' + metrika.jednotka + ').'));
        } else if (serazene.length > TOP) {
          blok.appendChild(prvek('p', 'poznamka',
            'Zobrazeno prvních ' + TOP + ' z ' + serazene.length + ' hráčů.'));
        }
      }
      var odkaz = prvek('p', 'odkaz-dal');
      var a = prvek('a', null, 'Celý žebříček – ' + metrika.nazev.toLowerCase());
      a.href = '/zebricek/?kategorie=' + metrika.pole + '&obdobi=tento';
      odkaz.appendChild(a);
      blok.appendChild(odkaz);
      box.appendChild(blok);
    });
  }).catch(function (e) {
    prazdny(box);
    box.setAttribute('aria-busy', 'false');
    var kod = (e && e.message) || '';
    box.appendChild(stavovaKarta('Žebříček se nepodařilo načíst',
      /abort/i.test(kod) || /Abort/.test(e && e.name)
        ? 'Server neodpověděl včas. Zkontrolujte připojení k internetu.'
        : 'Zkontrolujte připojení k internetu a zkuste stránku obnovit.',
      'chyba'));
  });
}

/* ---------------------------------------------------------------------
   Vykreslení: moje čísla
--------------------------------------------------------------------- */
function dlazdice(popis, zdroj) {
  var polozky = popis.map(function (d) {
    return [d[0], zdroj ? zdroj[d[1]] : undefined, d[2]];
  }).filter(function (d) { return typeof d[1] === 'number' && isFinite(d[1]); });
  if (!polozky.length) return null;
  var mrizka = prvek('div', 'cisla');
  polozky.forEach(function (d) {
    var k = prvek('div', 'cislo');
    k.appendChild(prvek('div', 'h', cislo(d[1], d[2])));
    k.appendChild(prvek('div', 'p', d[0]));
    mrizka.appendChild(k);
  });
  return mrizka;
}

function odkazNaUcet(text) {
  var p = prvek('p');
  var a = prvek('a', 'tlacitko', text);
  a.href = '/ucet/';
  p.appendChild(a);
  return p;
}

function vykresliMoje() {
  var box = el('moje');
  if (!box) return;
  prazdny(box);

  if (!relace) {
    var k = prvek('div', 'stav');
    k.appendChild(prvek('h3', null, 'Vaše čísla po přihlášení'));
    k.appendChild(prvek('p', null,
      'Přihlaste se stejným účtem jako v aplikaci a uvidíte tu své ' +
      'výsledky v režimu ' + NASTAVENI.nazev + '.'));
    k.appendChild(odkazNaUcet('Přihlásit se na Můj Okolník'));
    box.appendChild(k);
    return;
  }

  box.appendChild(nacitani('Načítám vaše výsledky…'));
  box.setAttribute('aria-busy', 'true');
  var obdobi = obdobiKlic(new Date());

  (UKAZKA
    ? Promise.resolve(ukazkovyHrac(obdobi))
    : ctiSoukrome('hraci/' + relace.uid)
  ).then(function (hrac) {
    prazdny(box);
    box.setAttribute('aria-busy', 'false');
    vypisMoje(hrac, obdobi);
  }).catch(function () {
    prazdny(box);
    box.setAttribute('aria-busy', 'false');
    box.appendChild(stavovaKarta('Výsledky se nepovedlo načíst',
      'Zkuste stránku za chvíli obnovit. Přihlášení jde obnovit na ' +
      'stránce Můj Okolník.', 'chyba'));
  });
}

function vypisMoje(hrac, obdobi) {
  var box = el('moje');
  var hlava = prvek('div', 'moje-hlava');
  hlava.appendChild(prvek('h3', null,
    (hrac && hrac.prezdivka) ? ocisti(hrac.prezdivka, 30)
      : (relace.jmeno || 'Přihlášený hráč')));
  var a = prvek('a', 'drobny-odkaz', 'Můj Okolník');
  a.href = '/ucet/';
  hlava.appendChild(a);
  box.appendChild(hlava);

  if (!hrac) {
    box.appendChild(stavovaKarta('Zatím tu nic není',
      'Přihlaste se v aplikaci stejným účtem (Více → Můj Okolník) ' +
      'a zapněte žebříček – čísla se odešlou při nejbližší příležitosti.'));
    return;
  }

  var celkem = dlazdice(NASTAVENI.celkem, hrac.souhrn);
  if (celkem) {
    box.appendChild(prvek('h4', null, 'Celkem'));
    box.appendChild(celkem);
  }

  var mesic = hrac.mesic || null;
  var mes = dlazdice(NASTAVENI.mesic, mesic);
  if (mes) {
    var kdy = (mesic && mesic.obdobi) ? mesic.obdobi : obdobi;
    box.appendChild(prvek('h4', null, 'Měsíc – ' + nazevObdobi(kdy)));
    box.appendChild(mes);
    if (NASTAVENI.kroky && typeof mesic.podlozeno === 'boolean'
        && typeof mesic.kroky === 'number' && mesic.kroky > 0) {
      // Informace, ne obvinění (telefon v batohu počet kroků srazí).
      box.appendChild(prvek('p', 'poznamka',
        mesic.podlozeno
          ? '✅ Kilometry jsou podložené nachozenými kroky.'
          : 'ℹ️ Kroků je na ten počet kilometrů méně, než odpovídá chůzi ' +
            '(třeba telefon v batohu, nebo jízda).'));
    }
  }

  if (!celkem && !mes) {
    box.appendChild(stavovaKarta('Zatím bez čísel',
      'Aplikace ještě neposlala žádné hodnoty. Zapněte v ní žebříček ' +
      '(Nastavení → Žebříček) a chvíli počkejte.'));
  }

  if (hrac.aktualizovano) {
    var d = new Date(hrac.aktualizovano);
    if (!isNaN(d)) {
      box.appendChild(prvek('p', 'podtitul',
        'Naposledy odesláno z aplikace: ' + d.toLocaleString('cs-CZ')));
    }
  }
}

function ukazkovyHrac(obdobi) {
  return {
    prezdivka: 'Toulavá Tereza',
    souhrn: { uroven: 23, km: 1287.4, obce: 212, navstevy: 341, vypravy: 19, dny: 96 },
    mesic: { obdobi: obdobi, km: 173.9, obce: 24, vypravy: 4, navstevy: 37,
             dny: 12, kroky: 231800, podlozeno: true },
    aktualizovano: new Date().toISOString()
  };
}

/* ---------------------------------------------------------------------
   Start
--------------------------------------------------------------------- */
/* ---------------------------------------------------------------------
   ⭐ Moje mapa (5. 9. 2026) – stav hry, který aplikace od v1.608 ukládá
   pod účet: hraci/{uid}/sync/stav (hlavička) + cast0…N (gzip JSON po
   částech). Kreslí odkryté buňky mlhy (kotouče ~230 m jako v aplikaci),
   trasy fotovýprav a zápisy deníku. MapLibre se načte až tady, ať
   stránky bez přihlášení zůstanou lehké. Buňky jsou v mřížce
   0,0018° (~200 × 130 m); polygony dokončených obcí web nemá, takže
   se kreslí jen projitá stopa.
--------------------------------------------------------------------- */
var BUNKA = 0.0018;                 // TrailStore.cell (stupně)
var KOTOUC_M = 160 * 1.45;          // uncoverMeters × haloFactor
var PLOCHA_BUNKY_KM2 = 0.026;       // ~200 × 130 m
var MAPLIBRE = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl';
var mapaMoje = null;

function nactiSkript(url) {
  return new Promise(function (ok, chyba) {
    var sc = document.createElement('script');
    sc.src = url;
    sc.onload = ok;
    sc.onerror = function () { chyba(new Error('Nepodařilo se načíst mapovou knihovnu.')); };
    document.head.appendChild(sc);
  });
}

function zajistiMaplibre() {
  if (window.maplibregl) return Promise.resolve();
  var l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = MAPLIBRE + '.css';
  document.head.appendChild(l);
  return nactiSkript(MAPLIBRE + '.js');
}

function zBase64(s) {
  var b = atob(s || ''), u = new Uint8Array(b.length);
  for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}

/* gzip → text (DecompressionStream: Chrome 80+, Safari 16.4+, Firefox 113+) */
function rozbal(bajty) {
  if (!('DecompressionStream' in window)) {
    return Promise.reject(new Error('Tenhle prohlížeč neumí rozbalit data, zkuste novější.'));
  }
  var ds = new DecompressionStream('gzip');
  var w = ds.writable.getWriter();
  w.write(bajty);
  w.close();
  return new Response(ds.readable).text();
}

function datumCz(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.getDate() + '. ' + (d.getMonth() + 1) + '. ' + d.getFullYear();
}

/** Stáhne a rozbalí stav hry; `null` = aplikace zatím nic neposlala. */
function stahniStav() {
  return ctiSoukrome('hraci/' + relace.uid + '/sync/stav').then(function (hl) {
    if (!hl) return null;
    var n = Number(hl.casti || 0), prace = [];
    for (var i = 0; i < n; i++) {
      prace.push(ctiSoukrome('hraci/' + relace.uid + '/sync/cast' + i));
    }
    return Promise.all(prace).then(function (casti) {
      var delka = 0;
      var kusy = casti.map(function (c) {
        var u = zBase64(c && c.data);
        delka += u.length;
        return u;
      });
      var vse = new Uint8Array(delka), p = 0;
      kusy.forEach(function (u) { vse.set(u, p); p += u.length; });
      return rozbal(vse).then(function (t) {
        var d = JSON.parse(t);
        d._hlavicka = hl;
        return d;
      });
    });
  });
}

function bunkyNaBody(cells) {
  var fc = { type: 'FeatureCollection', features: [] };
  (cells || []).forEach(function (k) {
    var p = String(k).split(':');
    var a = parseInt(p[0], 10), b = parseInt(p[1], 10);
    if (isNaN(a) || isNaN(b)) return;
    fc.features.push({ type: 'Feature', properties: {},
      geometry: { type: 'Point',
        coordinates: [(b + 0.5) * BUNKA, (a + 0.5) * BUNKA] } });
  });
  return fc;
}

function vypravyNaCary(trips) {
  var fc = { type: 'FeatureCollection', features: [] };
  (trips || []).forEach(function (t) {
    var body = (t.track || []).map(function (b) { return [b.lo, b.la]; })
      .filter(function (b) { return isFinite(b[0]) && isFinite(b[1]); });
    if (body.length < 2) return;
    fc.features.push({ type: 'Feature',
      properties: { n: t.name || 'Fotovýprava', d: datumCz(t.createdAt) },
      geometry: { type: 'LineString', coordinates: body } });
  });
  return fc;
}

function zapisyNaBody(diary) {
  var fc = { type: 'FeatureCollection', features: [] };
  (diary || []).forEach(function (v) {
    if (!isFinite(v.lat) || !isFinite(v.lon)) return;
    fc.features.push({ type: 'Feature',
      properties: { n: v.name || 'Zápis', d: datumCz(v.createdAt) },
      geometry: { type: 'Point', coordinates: [v.lon, v.lat] } });
  });
  return fc;
}

function rozsah(fcs) {
  var minX = 180, minY = 90, maxX = -180, maxY = -90, n = 0;
  function bod(c) {
    if (c[0] < minX) minX = c[0];
    if (c[0] > maxX) maxX = c[0];
    if (c[1] < minY) minY = c[1];
    if (c[1] > maxY) maxY = c[1];
    n++;
  }
  fcs.forEach(function (fc) {
    fc.features.forEach(function (f) {
      var g = f.geometry;
      if (g.type === 'Point') bod(g.coordinates);
      else g.coordinates.forEach(bod);
    });
  });
  return n ? [[minX, minY], [maxX, maxY]] : null;
}

function nakresliMapu(plátno, cells, trips, diary) {
  var kotouce = bunkyNaBody(cells);
  var cary = vypravyNaCary(trips);
  var zapisy = zapisyNaBody(diary);
  var hranice = rozsah([kotouce, cary, zapisy]);
  var lat0 = hranice ? (hranice[0][1] + hranice[1][1]) / 2 : 49.8;
  // poloměr kotouče v pixelech: metry / (m na px při daném zoomu)
  var mpp0 = 156543.03392 * Math.cos(lat0 * Math.PI / 180);
  function rPx(z) { return KOTOUC_M / (mpp0 / Math.pow(2, z)); }

  mapaMoje = new maplibregl.Map({
    container: plátno,
    style: 'https://tiles.openfreemap.org/styles/positron',
    center: [15.5, 49.8],
    zoom: 6.3,
    attributionControl: { compact: true },
  });
  mapaMoje.addControl(new maplibregl.NavigationControl({ showCompass: false }));
  mapaMoje.on('error', function (e) {
    console.warn('[mapa]', e && e.error ? e.error.message : e);
  });
  // ⚠️ 'style.load', ne 'load': 'load' čeká i na první dlaždice podkladu
  // a při pomalé síti by vrstvy hráče nepřišly dlouho (nebo vůbec)
  mapaMoje.on('style.load', function () {
    mapaMoje.addSource('kotouce', { type: 'geojson', data: kotouce });
    mapaMoje.addLayer({ id: 'kotouce', type: 'circle', source: 'kotouce',
      paint: {
        'circle-color': '#f29d38',
        'circle-opacity': 0.34,
        'circle-blur': 0.45,
        // ⚠️ ['zoom'] smí být jen v interpolate NA VRCHU výrazu (ne
        // uvnitř max) – zdaleka aspoň 1,4 px, od z10 skutečný poloměr
        'circle-radius': ['interpolate', ['exponential', 2], ['zoom'],
          5, 1.4, 9, 1.4, 10, Math.max(1.4, rPx(10)), 16, rPx(16)],
      } });
    mapaMoje.addSource('vypravy', { type: 'geojson', data: cary });
    mapaMoje.addLayer({ id: 'vypravy-hl', type: 'line', source: 'vypravy',
      paint: { 'line-color': '#ffffff', 'line-width': 4, 'line-opacity': 0.7 } });
    mapaMoje.addLayer({ id: 'vypravy', type: 'line', source: 'vypravy',
      paint: { 'line-color': '#2e7d5b', 'line-width': 2,
        'line-dasharray': [2, 1.6] } });
    mapaMoje.addSource('zapisy', { type: 'geojson', data: zapisy });
    mapaMoje.addLayer({ id: 'zapisy', type: 'circle', source: 'zapisy',
      paint: { 'circle-color': '#0d2b2e', 'circle-radius': 5,
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
    ['zapisy', 'vypravy'].forEach(function (vrstva) {
      mapaMoje.on('click', vrstva, function (e) {
        var f = e.features && e.features[0];
        if (!f) return;
        var kde = f.geometry.type === 'Point'
          ? f.geometry.coordinates.slice() : e.lngLat;
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(kde)
          .setText((f.properties.n || '') +
            (f.properties.d ? ' · ' + f.properties.d : ''))
          .addTo(mapaMoje);
      });
      mapaMoje.on('mouseenter', vrstva, function () {
        mapaMoje.getCanvas().style.cursor = 'pointer';
      });
      mapaMoje.on('mouseleave', vrstva, function () {
        mapaMoje.getCanvas().style.cursor = '';
      });
    });
    if (hranice) {
      mapaMoje.fitBounds(hranice, { padding: 36, maxZoom: 12, duration: 0 });
    }
  });
}

var HERNI_MAPA = '/mapa/?web=1&styl=herni';

function odkazTlacitko(text, href) {
  var a = prvek('a', 'tlacitko', text);
  a.href = href;
  return a;
}

function vykresliMapu() {
  var box = el('mapaMoje');
  if (!box) return;
  prazdny(box);
  if (!relace || UKAZKA) {
    var k = stavovaKarta('Vaše mapa po přihlášení',
      'Přihlaste se stejným účtem jako v aplikaci a uvidíte tu svou ' +
      'odkrytou mapu, fotovýpravy a zápisy. Aplikace je pod váš účet ' +
      'ukládá od verze 1.608 – jen pro vás, nikdy veřejně.', '');
    box.appendChild(k);
    return;
  }
  box.appendChild(nacitani('Načítám vaši mapu…'));
  box.setAttribute('aria-busy', 'true');
  stahniStav().then(function (d) {
    prazdny(box);
    box.setAttribute('aria-busy', 'false');
    if (!d) {
      box.appendChild(stavovaKarta('Zatím žádná mapa',
        'Aplikace pošle stav hry po přihlášení a po každé procházce ' +
        '(od verze 1.608). Ručně: Více → Můj Okolník → Synchronizovat ' +
        'teď.', ''));
      return;
    }
    var cells = d.trailCells || [], trips = d.trips || [],
      diary = d.diary || [];
    if (!cells.length && !trips.length && !diary.length) {
      box.appendChild(stavovaKarta('Mapa je zatím prázdná',
        'Vyrazte ven – odkrytá místa se tu objeví po další ' +
        'synchronizaci.', ''));
      return;
    }
    var kdy = d._hlavicka && d._hlavicka.aktualizovano
      ? ' · stav z ' + datumCz(d._hlavicka.aktualizovano) : '';
    box.appendChild(prvek('p', 'mapa-info',
      'Odkryto přibližně ' + cislo(cells.length * PLOCHA_BUNKY_KM2, 0) +
      ' km² · ' + trips.length + ' fotovýprav · ' + diary.length +
      ' zápisů' + kdy + '. Vidíte to jen vy.'));
    // ⭐ 5. 9.: tatáž herní mapa jako v aplikaci (engine na /mapa/)
    var lista = prvek('p', 'mapa-lista');
    lista.appendChild(odkazTlacitko('Otevřít herní mapu', HERNI_MAPA));
    box.appendChild(lista);
    var platno = prvek('div', 'mapa-moje');
    box.appendChild(platno);
    return zajistiMaplibre().then(function () {
      nakresliMapu(platno, cells, trips, diary);
    });
  }).catch(function (e) {
    prazdny(box);
    box.setAttribute('aria-busy', 'false');
    box.appendChild(stavovaKarta('Mapu se nepovedlo načíst',
      String((e && e.message) || e), 'chyba'));
  });
}

function start() {
  var pruh = el('ukazkaPruh');
  if (UKAZKA) {
    if (pruh) pruh.hidden = false;
    relace = { uid: 'ukazka2', jmeno: 'Ukázkový hráč' };
    vykresliMoje();
    vykresliMapu();
    vykresliZebricek();
    return;
  }
  relace = nactiRelaci();
  if (!relace) {
    vykresliMoje();
    vykresliMapu();
    vykresliZebricek();
    return;
  }
  // ověřit, že uložená relace ještě žije (odvolaný účet, změna hesla…)
  token().then(function () {
    vykresliMoje();
    vykresliMapu();
    vykresliZebricek();
  }).catch(function () {
    relace = null;
    ulozRelaci();
    vykresliMoje();
    vykresliMapu();
    vykresliZebricek();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
