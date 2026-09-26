/* Okolník – HRA NA MÍRU: založení, správa a výsledky AKCÍ na webu (26. 9. 2026).
   Návrh: Sarcher/NAVRH-HRA-NA-MIRU.md (kap. 2, 3, 5, 7). Data ve Firestore, pravidla v20:
     akce/{kod}                   nastavení akce (kód = ID dokumentu, 8 znaků bez zaměnitelných)
     akce/{kod}/ucastnici/{uid}   přezdívka, tým, role, stav (ceka|ok|zamitnut), sdiliPolohu – zapisuje aplikace
     akce/{kod}/poloha/{uid}      poslední poloha účastníka (aplikace)
     akce/{kod}/stopy/{uid}_{n}   kousky trasy – zakódovaná lomená čára (aplikace)
     akce/{kod}/body/{bid}        kontrolní body (organizátor)
   KDO CO VIDÍ, určuje jen nastavení akce, se kterým každý účastník souhlasí (textSouhlasu) –
   organizátor NEVIDÍ automaticky všechno (polohu jen u 'organizator', 'vsichni' a 'tym' s polohaOrg,
   a jen do konce akce + 10 min; trasy jen když stopy != 'ne'). Jinak by dotaz pravidla odmítla (403).
   Pohledy (jedna stránka, podle adresy):
     /akce/                  nepřihlášený: co to je + přihlášení; přihlášený: Moje akce
     /akce/?novy=1           průvodce založením (Premium)
     /akce/?k=KOD            organizátor: správa se živou mapou; ostatní: pozvánka
     /akce/?k=KOD&upravit=1  úprava nastavení (týž průvodce)
     /akce/?k=KOD&vysledky=1 výsledky: trasy, km, CSV
     /akce/?k=KOD&nahled=1   pozvánka očima účastníka (i pro organizátora)
     …&ukazka=1              smyšlená data v paměti, na Firestore se vůbec nesahá (test bez účtu)
   Přihlášení sdílí s Můj Okolník (localStorage okolnikUcet1), jako firmy.js. */
(function () {
  'use strict';

  /* ================================================================ konstanty */
  var PROJEKT = 'sarcher-b32a1';
  var KLIC = 'AIzaSyB3sj8qS-Lh4lHow6AUrWH-JayEtJ70igQ';   // webový klíč (omezený na okolnik.cz), jako firmy.js
  var ZAKLAD = 'https://firestore.googleapis.com/v1/projects/' + PROJEKT + '/databases/(default)/documents/';
  var JMENO = 'projects/' + PROJEKT + '/databases/(default)/documents/';
  var ODKAZ_AKCE = 'https://okolnik.cz/akce/?k=';
  var PLAY = 'https://play.google.com/store/apps/details?id=cz.okolnik.app';
  var ML_JS = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js';    // stejná verze jako /dobyvatel
  var ML_CSS = 'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css';
  var STYL_MAPY = 'https://tiles.openfreemap.org/styles/liberty';          // atribuce (OpenFreeMap, OSM) nese styl
  var ABECEDA = 'abcdefghjkmnpqrstuvwxyz23456789';                       // bez i, l, o, 0, 1 – pravidla [a-hj-np-z2-9]{8}
  var SOUHLAS_VERZE = 2;                                                 // verze textu souhlasu (textSouhlasu)
  var DEN = 86400000, MAX_DNU = 14, MAX_UCASTNIKU = 15, MAX_TYMU = 8, MAX_BODU = 50;
  var STARA_POLOHA = 5 * 60000;                                          // starší poloha = vybledlá tečka
  var OBNOVA = 15000, OBNOVA_TRAS = 60000;
  var UCHOVANI = [0, 1, 7, 30, 90];
  var UKAZKA = /[?&]ukazka=1(&|$)/.test(location.search);
  var NBSP = '\u00a0';

  var STAVY = { priprava: 'Připravuje se', bezi: 'Běží', konec: 'Skončila' };
  var REZIMY = { vyprava: 'Jen výprava', body: 'Kontrolní body', vlajky: 'Dobývání vlajek' };
  var POLOHA = { nikdo: 'Nikdo, ani organizátor', organizator: 'Jen organizátor', tym: 'Spoluhráči v týmu', vsichni: 'Všichni vidí všechny' };
  var STOPY = { ne: 'Vypnuto', organizator: 'Vidí organizátor', vysledky: 'Všichni po skončení', zive: 'Všichni živě' };
  var VYBER = { hraci: 'Vyberou si hráči', organizator: 'Rozdělí organizátor', nahodne: 'Náhodně' };
  var STAV_UC = { ceka: 'čeká', ok: 'schválen', zamitnut: 'zamítnut' };
  var BARVY_TYMU = [
    { b: '#E53935', n: 'červená', t: 'Červení' }, { b: '#1E88E5', n: 'modrá', t: 'Modří' },
    { b: '#43A047', n: 'zelená', t: 'Zelení' }, { b: '#FB8C00', n: 'oranžová', t: 'Oranžoví' },
    { b: '#8E24AA', n: 'fialová', t: 'Fialoví' }, { b: '#00ACC1', n: 'tyrkysová', t: 'Tyrkysoví' },
    { b: '#F9A825', n: 'žlutá', t: 'Žlutí' }, { b: '#6D4C41', n: 'hnědá', t: 'Hnědí' },
  ];
  var BARVY_UCASTNIKU = ['#E53935', '#1E88E5', '#43A047', '#FB8C00', '#8E24AA', '#00ACC1', '#F9A825', '#6D4C41',
    '#D81B60', '#3949AB', '#7CB342', '#546E7A', '#FF7043', '#26A69A', '#AB47BC'];
  var BARVA_AKCENT = '#D9583B', BARVA_BEZ_TYMU = '#78909C';
  var SABLONY = [
    { id: 'spolecna', ikona: '🥾', nazev: 'Společná výprava',
      popis: 'Výlet s přáteli nebo rodinou. Všichni se vidí na mapě, sdílení je dobrovolné a trasy jsou vidět hned.',
      nastav: { rezim: 'vyprava', poloha: 'vsichni', polohaOrg: true, polohaPovinna: false, schvalovani: false, stopy: 'zive', tymy: 0, uchovatDni: 30 } },
    { id: 'skola', ikona: '🎒', nazev: 'Bezpečná výprava – škola',
      popis: 'Polohu i trasy vidí jen organizátor, sdílí se při úkolech a na trase a účast schvalujete. Data se smažou den po akci.',
      nastav: { rezim: 'vyprava', poloha: 'organizator', polohaOrg: true, polohaPovinna: true, schvalovani: true, stopy: 'organizator', tymy: 0, uchovatDni: 1 } },
    { id: 'tymova', ikona: '🚩', nazev: 'Týmová výprava',
      popis: 'Dva týmy (i víc). Polohu týmu vidí spoluhráči a organizátor, trasy všech se ukážou po skončení.',
      nastav: { rezim: 'vyprava', poloha: 'tym', polohaOrg: true, polohaPovinna: true, schvalovani: false, stopy: 'vysledky', tymy: 2, tymyVyber: 'hraci', uchovatDni: 30 } },
    { id: 'body', ikona: '📍', nazev: 'Kontrolní body',
      popis: 'Body na mapě, které účastníci obejdou. Každý sám za sebe, polohu vidí jen organizátor.',
      nastav: { rezim: 'body', poloha: 'organizator', polohaOrg: true, polohaPovinna: true, schvalovani: false, stopy: 'vysledky', tymy: 0, uchovatDni: 30 } },
  ];

  /* ================================================================ stav stránky */
  var relace = null, api = null, DEMO = null;
  var pohled = 0, uklidy = [];
  var hlaska = null, hlaskaPohledu = null;   // krátká zpráva pro příští pohled („Akce je smazaná.“)
  var Z = null;                              // živá správa akce
  var P = null;                              // průvodce (založení / úprava)
  var posunCasu = 0, casZnam = false;        // hodiny serveru − hodiny prohlížeče (z readTime dotazů)

  /* ================================================================ drobnosti */
  var el = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function sklon(n, jeden, dva, pet) { n = Math.abs(n); return n === 1 ? jeden : (n >= 2 && n <= 4 ? dva : pet); }
  function jeCislo(x) { return typeof x === 'number' && isFinite(x); }
  function platneDatum(d) { return d instanceof Date && !isNaN(+d); }
  function najdi(pole, fn) { for (var i = 0; i < pole.length; i++) if (fn(pole[i])) return pole[i]; return null; }
  function pockej(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
  function kopie(o) {
    if (o instanceof Date) return new Date(+o);
    if (Array.isArray(o)) return o.map(kopie);
    if (o && typeof o === 'object') { var r = {}; for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = kopie(o[k]); return r; }
    return o;
  }
  function zkrat(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function barvaOk(b) { return typeof b === 'string' && /^#[0-9a-fA-F]{6}$/.test(b) ? b : BARVA_BEZ_TYMU; }
  function chyba(text, kod, stav) { var e = new Error(text); e.kod = kod; e.stav = stav; return e; }
  function chybaText(e) {
    if (!e) return 'Neznámá chyba.';
    if (e.kod === 'prihlaseni') return 'Přihlášení vypršelo. Přihlaste se prosím znovu na stránce Můj Okolník.';
    if (e.kod === 401 || e.kod === 403) return 'Server požadavek odmítl (chybí oprávnění). Zkuste se znovu přihlásit na stránce Můj Okolník.';
    if (e.kod === 404) return 'Požadovaná data už neexistují.';
    if (e.kod === 'cas' || e.name === 'AbortError') return 'Server neodpověděl včas. Zkuste to prosím znovu.';
    if (typeof e.kod === 'number') return 'Chyba serveru (HTTP ' + e.kod + '). Zkuste to prosím později.';
    if (e instanceof TypeError) return 'Nepodařilo se spojit se serverem. Zkontrolujte připojení k internetu.';
    return e.message || String(e);
  }

  /* ---------------------------------------------------------------- čas */
  function zaznamenejCas(iso) { var t = Date.parse(iso); if (!isNaN(t)) { posunCasu = t - Date.now(); casZnam = true; } }
  function ted() { return Date.now() + posunCasu; }
  function fmtDen(d) {
    var s = d.getDate() + '.' + NBSP + (d.getMonth() + 1) + '.';
    return d.getFullYear() !== new Date(ted()).getFullYear() ? s + NBSP + d.getFullYear() : s;
  }
  function fmtHod(d) { return d.getHours() + ':' + pad(d.getMinutes()); }
  function fmtCas(d) { return platneDatum(d) ? fmtDen(d) + NBSP + fmtHod(d) : '–'; }
  function stejnyDen(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function fmtRozsah(od, dO) {
    if (!platneDatum(od) || !platneDatum(dO)) return '–';
    return stejnyDen(od, dO) ? fmtCas(od) + '–' + fmtHod(dO) : fmtCas(od) + ' – ' + fmtCas(dO);
  }
  function fmtCsvCas(d) { return platneDatum(d) ? d.getDate() + '. ' + (d.getMonth() + 1) + '. ' + d.getFullYear() + ' ' + fmtHod(d) : ''; }
  function trvani(ms) {
    var min = Math.max(0, Math.round(ms / 60000));
    if (min < 1) return 'méně než minuta';
    var d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60, casti = [];
    if (d) casti.push(d + NBSP + sklon(d, 'den', 'dny', 'dní'));
    if (h) casti.push(h + NBSP + 'h');
    if (m && !d) casti.push(m + NBSP + 'min');
    return casti.join(' ');
  }
  function predChvili(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 45) return 'před chvílí';
    var m = Math.round(s / 60);
    if (m < 60) return 'před ' + m + NBSP + 'min';
    var h = Math.floor(m / 60);
    if (h < 24) return 'před ' + h + NBSP + 'h' + (m % 60 ? ' ' + (m % 60) + NBSP + 'min' : '');
    var d = Math.floor(h / 24);
    return 'před ' + d + NBSP + (d === 1 ? 'dnem' : 'dny');
  }
  function mistniCas(d) {
    return platneDatum(d) ? d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) : '';
  }
  function casZVstupu(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || '');
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
    return isNaN(+d) ? null : d;
  }
  function isoZ(d) { return new Date(+d).toISOString().replace(/\.\d{3}Z$/, 'Z'); }   // 'YYYY-MM-DDTHH:MM:SSZ'

  /* ---------------------------------------------------------------- vzdálenosti, čísla */
  function km(m) { return (Math.round((m || 0) / 100) / 10).toFixed(1).replace('.', ',') + NBSP + 'km'; }
  function metry(m) { return m >= 1000 ? (Math.round(m / 100) / 10).toFixed(1).replace('.', ',') + NBSP + 'km' : Math.round(m) + NBSP + 'm'; }
  function vzdalenost(lat1, lon1, lat2, lon2) {
    var r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function delkaCary(sour) {   // [[lon, lat], …]
    var d = 0;
    for (var i = 1; i < sour.length; i++) d += vzdalenost(sour[i - 1][1], sour[i - 1][0], sour[i][1], sour[i][0]);
    return d;
  }
  function kruh(lat, lon, r) {
    var body = [], kLat = 111320, kLon = 111320 * Math.cos(lat * Math.PI / 180);
    for (var i = 0; i <= 72; i++) { var a = i / 72 * 2 * Math.PI; body.push([lon + r * Math.sin(a) / kLon, lat + r * Math.cos(a) / kLat]); }
    return body;
  }
  function zaokr(x) { return Math.round(x * 1e6) / 1e6; }

  /* ---------------------------------------------------------------- lomená čára (Google encoded polyline, přesnost 5) */
  /* → [[lon, lat], …] (pořadí GeoJSON). Poškozený řetězec vrátí jen body, které šly přečíst. */
  function dekodujPolyline(s) {
    var out = [], i = 0, lat = 0, lon = 0, n = (s || '').length;
    while (i < n) {
      var v = [0, 0];
      for (var j = 0; j < 2; j++) {
        var b, posun = 0, vysl = 0;
        do {
          if (i >= n) return out;
          b = s.charCodeAt(i++) - 63;
          vysl |= (b & 0x1f) << posun;
          posun += 5;
        } while (b >= 0x20 && posun < 35);
        v[j] = (vysl & 1) ? ~(vysl >> 1) : (vysl >> 1);
      }
      lat += v[0]; lon += v[1];
      out.push([lon / 1e5, lat / 1e5]);
    }
    return out;
  }
  function zakodujPolyline(body) {   // [[lat, lon], …] – jen pro ukázková data
    var out = '', pLat = 0, pLon = 0;
    function cislo(v) {
      v = v < 0 ? ~(v << 1) : (v << 1);
      var s = '';
      while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
      return s + String.fromCharCode(v + 63);
    }
    body.forEach(function (b) {
      var la = Math.round(b[0] * 1e5), lo = Math.round(b[1] * 1e5);
      out += cislo(la - pLat) + cislo(lo - pLon); pLat = la; pLon = lo;
    });
    return out;
  }

  /* ---------------------------------------------------------------- kód akce */
  function novyKod() {
    var kod = '', b = new Uint8Array(16);
    while (kod.length < 8) {
      crypto.getRandomValues(b);
      for (var i = 0; i < b.length && kod.length < 8; i++) if (b[i] < 248) kod += ABECEDA.charAt(b[i] % 31);   // 248 = 8 × 31, bez zkreslení
    }
    return kod;
  }
  function normKod(s) { return String(s || '').toLowerCase().replace(/[\s\-_.]/g, ''); }
  function kodVypadaPlatne(k) { return /^[a-z0-9]{4,40}$/.test(k); }

  /* ================================================================ TEXT SOUHLASU
     ⚠️ Stejné věty a stejnou logiku má aplikace (karta souhlasu při připojení) – měnit obojí najednou.
     Krátce a jen informativně, bez výhrůžek; čas akce věty neobsahují (je v záhlaví karty).
     Výchozí hodnoty jako pravidla: polohaOrg a polohaPovinna bez hodnoty = true, schvalovani = false.
     akce: { poloha, polohaOrg, polohaPovinna, schvalovani, stopy, uchovatDni } */
  function textSouhlasu(akce) {
    var vety = [];
    var poloha = ['organizator', 'tym', 'vsichni'].indexOf(akce.poloha) >= 0 ? akce.poloha : 'nikdo';
    var stopy = ['organizator', 'vysledky', 'zive'].indexOf(akce.stopy) >= 0 ? akce.stopy : 'ne';
    if (akce.schvalovani === true) vety.push('Účast schvaluje organizátor.');
    if (poloha === 'organizator') vety.push('Polohu vidí jen organizátor.');
    else if (poloha === 'tym') vety.push(akce.polohaOrg !== false ? 'Polohu vidí váš tým a organizátor.' : 'Polohu vidí jen váš tým.');
    else if (poloha === 'vsichni') vety.push('Polohu vidí všichni účastníci i organizátor.');
    else vety.push('Polohu nevidí nikdo, ani organizátor.');
    if (stopy === 'organizator') vety.push('Trasu vidí organizátor.');
    else if (stopy === 'vysledky') vety.push('Trasu uvidí všichni po skončení akce.');
    else if (stopy === 'zive') vety.push('Trasu vidí všichni už během akce.');
    else vety.push('Trasa zůstane jen ve vašem telefonu.');
    if (poloha !== 'nikdo' || stopy !== 'ne') {   // jeden vypínač účastníka platí pro polohu i trasu
      vety.push(akce.polohaPovinna !== false
        ? 'Sdílení stačí zapnout při plnění úkolů a na trase – je to doklad, kde a kdy jste byli.'
        : 'Sdílení je dobrovolné, můžete ho kdykoli vypnout.');
      vety.push('Sdílení skončí samo po skončení akce nebo po odstoupení z akce.');
      var dni = Math.max(0, Math.round(Number(akce.uchovatDni == null ? 30 : akce.uchovatDni) || 0));
      vety.push(dni === 0 ? 'Poloha a trasa se smažou hned po akci.'
        : 'Poloha a trasa se smažou ' + dni + ' ' + sklon(dni, 'den', 'dny', 'dní') + ' po akci.');
    }
    return vety.join(' ');
  }
  /* náhled karty souhlasu jako v aplikaci: čas akce v záhlaví, pod ním věty */
  function nahledSouhlasu(a, bezCasu) {
    return (bezCasu ? '' : '<p class="souhlas-cas">' + esc(fmtRozsah(a.od, a.do)) + '</p>') + '<p>' + esc(textSouhlasu(a)) + '</p>';
  }

  /* ================================================================ stav akce a oprávnění */
  function stavAkce(a) {
    var t = ted();
    if (a.stav === 'konec' || (platneDatum(a.do) && t >= +a.do)) return 'konec';
    if (a.stav === 'bezi' || (platneDatum(a.od) && t >= +a.od)) return 'bezi';
    return 'priprava';
  }
  function stitekStavu(st) { return '<span class="stitek-stav ' + st + '">' + STAVY[st] + '</span>'; }
  function jsemOrg(a) { return !!(relace && a && (a.vlastnik === relace.uid || (a.spoluorg || []).indexOf(relace.uid) >= 0)); }
  /* Pravidla v20: organizátor vidí polohu jen u 'organizator', 'vsichni' a 'tym' s polohaOrg,
     a jen do konce akce + 10 min (tady s minutou rezervy). */
  function orgVidiPolohu(a) { return a.poloha === 'organizator' || a.poloha === 'vsichni' || (a.poloha === 'tym' && a.polohaOrg !== false); }
  function orgCtePolohu(a) { return orgVidiPolohu(a) && platneDatum(a.do) && ted() < +a.do + 9 * 60000; }
  /* Pravidla v21: PO ZALOŽENÍ JDE SDÍLENÍ JEN ZÚŽIT (účastníci souhlasili s původním nastavením,
     širší sdílení = nová akce). Poloha: žádný z příznaků org / tym / vsichni nesmí přibýt;
     trasy jen k nižší úrovni; uchování jen kratší. Čas: před startem volně, po startu je začátek
     pevný a konec jde jen posunout dřív. */
  var PORADI_STOP = { ne: 0, organizator: 1, vysledky: 2, zive: 3 };
  var JEN_ZUZIT = 'Po založení jde sdílení jen zúžit – účastníci souhlasili s původním nastavením. Pro širší sdílení založte novou akci.';
  var JEN_ZKRATIT = 'Běžící akci jde jen zkrátit.';
  function vlajkyPolohy(poloha, polohaOrg) {
    return { org: poloha === 'organizator' || poloha === 'vsichni' || (poloha === 'tym' && polohaOrg !== false),
      tym: poloha === 'tym' || poloha === 'vsichni', vsichni: poloha === 'vsichni' };
  }
  function polohaRozsiruje(puv, poloha, polohaOrg) {   // puv = původní akce
    var s = vlajkyPolohy(puv.poloha, puv.polohaOrg), n = vlajkyPolohy(poloha, polohaOrg);
    return (!s.org && n.org) || (!s.tym && n.tym) || (!s.vsichni && n.vsichni);
  }
  function stopyRozsiruji(puv, stopy) { return (PORADI_STOP[stopy] || 0) > (PORADI_STOP[puv.stopy] || 0); }
  function akceZacala(a) { return platneDatum(a.od) && ted() >= +a.od; }
  function stavUc(u) { return STAV_UC[u.stav] ? u.stav : 'ok'; }
  function aktivniUcastnici(uc) { return uc.filter(function (u) { return stavUc(u) !== 'zamitnut'; }); }
  function tymPodleKlice(a, k) { return k ? najdi(a.tymy, function (t) { return t.k === k; }) : null; }
  /* kdy účastníci sdílejí – jeden vypínač pokrývá polohu i trasu (jako textSouhlasu) */
  function popisPovinnosti(a) {
    if (a.poloha === 'nikdo' && a.stopy === 'ne') return '';
    return a.polohaPovinna !== false ? 'sdílení při úkolech a na trase (doklad)' : 'sdílení dobrovolné';
  }
  function popisPolohy(a) {
    var s = POLOHA[a.poloha] || a.poloha;
    if (a.poloha === 'tym') s += a.polohaOrg !== false ? ' a organizátor' : ' (organizátor ne)';
    if (a.poloha !== 'nikdo') s += ' · ' + popisPovinnosti(a);
    return s;
  }
  function popisTras(a) {   // u akce jen s trasou patří povinnost sem
    return (STOPY[a.stopy] || a.stopy) + (a.poloha === 'nikdo' && a.stopy !== 'ne' ? ' · ' + popisPovinnosti(a) : '');
  }
  function tymyHtml(a) {
    if (!a.tymy.length) return 'Každý sám za sebe';
    return a.tymy.map(function (t) { return '<span class="vzorek" style="background:' + barvaOk(t.b) + '"></span>' + esc(t.n); }).join(', ');
  }
  function mapyCz(b) { return 'https://mapy.cz/zakladni?source=coor&id=' + b.lon + '%2C' + b.lat + '&x=' + b.lon + '&y=' + b.lat + '&z=17'; }

  /* ================================================================ Firestore: hodnoty a dokumenty */
  function S(v) { return { stringValue: String(v) }; }
  function I(v) { return { integerValue: String(Math.round(Number(v))) }; }
  function D(v) { return { doubleValue: Number(v) }; }
  function B(v) { return { booleanValue: !!v }; }
  function T(v) { return { timestampValue: isoZ(v) }; }
  function M(f) { return { mapValue: { fields: f || {} } }; }
  function A(v) { return { arrayValue: { values: v || [] } }; }
  var NUL = { nullValue: null };

  function cti(v) {
    if (!v || typeof v !== 'object') return null;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return parseInt(v.integerValue, 10);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('booleanValue' in v) return v.booleanValue;
    if ('timestampValue' in v) return new Date(v.timestampValue);
    if ('nullValue' in v) return null;
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(cti);
    if ('mapValue' in v) { var m = {}, f = v.mapValue.fields || {}; for (var k in f) m[k] = cti(f[k]); return m; }
    if ('geoPointValue' in v) return { lat: v.geoPointValue.latitude, lon: v.geoPointValue.longitude };
    if ('referenceValue' in v) return v.referenceValue;
    return null;
  }
  function dokument(doc) {
    var d = { _id: String(doc.name || '').split('/').pop(), _cesta: doc.name || '' }, f = doc.fields || {};
    for (var k in f) d[k] = cti(f[k]);
    return d;
  }
  function text(v, max) { return typeof v === 'string' ? v.slice(0, max || 2000) : ''; }
  function naAkci(d) {
    var tymy = Array.isArray(d.tymy) ? d.tymy.filter(function (t) { return t && typeof t.k === 'string' && t.k; })
      .map(function (t) { return { k: t.k, n: text(t.n, 24) || t.k, b: barvaOk(t.b) }; }) : [];
    var pole = d.pole && jeCislo(d.pole.lat) && jeCislo(d.pole.lon)
      ? { typ: 'kruh', lat: d.pole.lat, lon: d.pole.lon, r: Math.max(10, Math.round(jeCislo(d.pole.r) ? d.pole.r : 500)) } : null;
    var sraz = d.sraz && jeCislo(d.sraz.lat) && jeCislo(d.sraz.lon) ? { n: text(d.sraz.n, 60), lat: d.sraz.lat, lon: d.sraz.lon } : null;
    return {
      _id: d._id, nazev: text(d.nazev, 60) || 'Akce', popis: text(d.popis, 1000), vlastnik: text(d.vlastnik, 128),
      stav: text(d.stav, 20) || 'priprava', od: platneDatum(d.od) ? d.od : null, do: platneDatum(d.do) ? d.do : null,
      rezim: text(d.rezim, 20) || 'vyprava', poloha: text(d.poloha, 20) || 'nikdo',
      polohaOrg: d.polohaOrg !== false, polohaPovinna: d.polohaPovinna !== false, schvalovani: d.schvalovani === true,
      stopy: text(d.stopy, 20) || 'ne', tymy: tymy, tymyVyber: text(d.tymyVyber, 20) || 'hraci', pole: pole, sraz: sraz,
      max: Math.round(jeCislo(d.max) ? d.max : MAX_UCASTNIKU), uchovatDni: Math.round(jeCislo(d.uchovatDni) ? d.uchovatDni : 30),
      verejna: d.verejna === true, vytvoreno: platneDatum(d.vytvoreno) ? d.vytvoreno : null,
      souhlasVerze: Math.round(jeCislo(d.souhlasVerze) ? d.souhlasVerze : 1),
      vzhled: d.vzhled && typeof d.vzhled === 'object' ? d.vzhled : {}, spoluorg: Array.isArray(d.spoluorg) ? d.spoluorg : [],
    };
  }
  /* Akce → pole Firestore s PŘESNÝMI typy (pravidla chtějí int / timestamp / bool). */
  function akceNaPole(a) {
    var f = {
      nazev: S(a.nazev), vlastnik: S(a.vlastnik), stav: S(a.stav), od: T(a.od), do: T(a.do), rezim: S(a.rezim),
      poloha: S(a.poloha), polohaOrg: B(a.polohaOrg !== false), polohaPovinna: B(a.polohaPovinna !== false),
      schvalovani: B(a.schvalovani === true), stopy: S(a.stopy),
      tymy: A((a.tymy || []).map(function (t) { return M({ k: S(t.k), n: S(t.n), b: S(t.b) }); })),
      tymyVyber: S(a.tymyVyber),
      pole: a.pole ? M({ typ: S('kruh'), lat: D(a.pole.lat), lon: D(a.pole.lon), r: I(a.pole.r) }) : NUL,
      sraz: a.sraz ? M({ n: S(a.sraz.n), lat: D(a.sraz.lat), lon: D(a.sraz.lon) }) : NUL,
      max: I(a.max), uchovatDni: I(a.uchovatDni), verejna: B(false), souhlasVerze: I(a.souhlasVerze || SOUHLAS_VERZE),
      pravidla: M({}), vzhled: M(a.vzhled && a.vzhled.uvitani ? { uvitani: S(a.vzhled.uvitani) } : {}),
    };
    if (platneDatum(a.vytvoreno)) f.vytvoreno = T(a.vytvoreno);
    if (a.popis) f.popis = S(a.popis);
    return f;
  }
  function bodNaPole(b, i) {
    var f = { n: S(b.n), lat: D(b.lat), lon: D(b.lon), poradi: I(i + 1) };
    if (jeCislo(b.h)) f.h = I(b.h);
    if (jeCislo(b.r)) f.r = I(b.r);
    return f;
  }
  function rovno(pole, hodnota) { return { fieldFilter: { field: { fieldPath: pole }, op: 'EQUAL', value: { stringValue: hodnota } } }; }
  function seradBody(b) { return b.slice().sort(function (x, y) { return (x.poradi || 999) - (y.poradi || 999) || String(x._id).localeCompare(String(y._id)); }); }
  function podleId(seznam) { var m = {}; (seznam || []).forEach(function (d) { m[d._id] = d; }); return m; }

  /* ================================================================ síť: přihlášení a Firestore REST */
  function nactiRelaci() {
    try {
      var s = localStorage.getItem('okolnikUcet1'), r = s ? JSON.parse(s) : null;
      return r && r.uid && r.refreshToken ? r : null;
    } catch (e) { return null; }
  }
  function sit(url, volby, ms) {
    if (UKAZKA) return Promise.reject(chyba('V ukázce se nic neposílá na server.', 'ukazka'));   // pojistka
    volby = volby || {};
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    if (ctrl) volby.signal = ctrl.signal;
    var casovac = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms || 20000);
    return fetch(url, volby).then(function (o) { clearTimeout(casovac); return o; }, function (e) {
      clearTimeout(casovac);
      if (e && e.name === 'AbortError') throw chyba('Server neodpověděl včas.', 'cas');
      throw e;
    });
  }
  function chybaOdpovedi(o) {
    return o.text().catch(function () { return ''; }).then(function (t) {
      var stav = '', zprava = '';
      try { var j = JSON.parse(t); j = Array.isArray(j) ? j[0] : j; stav = (j && j.error && j.error.status) || ''; zprava = (j && j.error && j.error.message) || ''; } catch (e) { /* nic */ }
      throw chyba('HTTP ' + o.status + (zprava ? ': ' + zprava : ''), o.status, stav);
    });
  }
  function platnyToken() {
    var r = nactiRelaci();
    if (!r) return Promise.reject(chyba('Nejste přihlášeni.', 'prihlaseni'));
    if (r.idToken && r.vyprsi > Date.now() + 60000) return Promise.resolve(r.idToken);
    return sit('https://securetoken.googleapis.com/v1/token?key=' + KLIC, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(r.refreshToken),
    }).then(function (o) {
      return o.json().catch(function () { return {}; }).then(function (d) {
        if (!o.ok || !d.id_token) throw chyba('Obnova přihlášení selhala.', 'prihlaseni');
        r.idToken = d.id_token; r.refreshToken = d.refresh_token || r.refreshToken;
        r.vyprsi = Date.now() + (parseInt(d.expires_in, 10) || 3600) * 1000;
        try { localStorage.setItem('okolnikUcet1', JSON.stringify(r)); } catch (e) { /* nic */ }
        return r.idToken;
      });
    });
  }
  function hlavicky(token, json) { var h = {}; if (token) h.Authorization = 'Bearer ' + token; if (json) h['Content-Type'] = 'application/json'; return h; }
  function fsGet(cesta, token) {
    return sit(ZAKLAD + cesta + '?key=' + KLIC, { headers: hlavicky(token) }).then(function (o) {
      if (o.status === 404) return null;
      if (!o.ok) return chybaOdpovedi(o);
      return o.json().then(dokument);
    });
  }
  function fsQuery(rodic, dotaz, token) {
    var url = (rodic ? ZAKLAD + rodic : ZAKLAD.slice(0, -1)) + ':runQuery?key=' + KLIC;
    return sit(url, { method: 'POST', headers: hlavicky(token, true), body: JSON.stringify({ structuredQuery: dotaz }) }, 30000).then(function (o) {
      if (!o.ok) return chybaOdpovedi(o);
      return o.json();
    }).then(function (v) {
      var out = [], cas = false;
      (Array.isArray(v) ? v : []).forEach(function (r) {
        if (!cas && r.readTime) { zaznamenejCas(r.readTime); cas = true; }
        if (r.document) out.push(dokument(r.document));
      });
      return out;
    });
  }
  function fsPocet(rodic, kolekce, token) {
    var telo = { structuredAggregationQuery: { structuredQuery: { from: [{ collectionId: kolekce }] }, aggregations: [{ alias: 'n', count: {} }] } };
    return sit(ZAKLAD + rodic + ':runAggregationQuery?key=' + KLIC, { method: 'POST', headers: hlavicky(token, true), body: JSON.stringify(telo) }).then(function (o) {
      if (!o.ok) return chybaOdpovedi(o);
      return o.json();
    }).then(function (v) {
      var r = Array.isArray(v) ? v[0] : v, n = r && r.result && r.result.aggregateFields && r.result.aggregateFields.n;
      return n ? parseInt(n.integerValue, 10) : null;
    });
  }
  /* PATCH: volby.maska = updateMask (bez masky se zapíše celý dokument), novy = jen když ještě neexistuje */
  function fsPatch(cesta, pole, volby) {
    volby = volby || {};
    return platnyToken().then(function (token) {
      var q = ['key=' + KLIC];
      (volby.maska || []).forEach(function (k) { q.push('updateMask.fieldPaths=' + encodeURIComponent(k)); });
      if (volby.novy) q.push('currentDocument.exists=false');
      if (volby.existuje) q.push('currentDocument.exists=true');
      return sit(ZAKLAD + cesta + '?' + q.join('&'), { method: 'PATCH', headers: hlavicky(token, true), body: JSON.stringify({ fields: pole }) });
    }).then(function (o) { if (!o.ok) return chybaOdpovedi(o); return true; });
  }
  function fsDelete(cesta) {
    return platnyToken().then(function (token) {
      var url = (cesta.indexOf('projects/') === 0 ? 'https://firestore.googleapis.com/v1/' + cesta : ZAKLAD + cesta) + '?key=' + KLIC;
      return sit(url, { method: 'DELETE', headers: hlavicky(token) });
    }).then(function (o) { if (!o.ok && o.status !== 404) return chybaOdpovedi(o); return true; });
  }
  /* celá podkolekce akce po stránkách (řazení podle __name__ nepotřebuje složený index) */
  function podkolekce(aid, kolekce, filtr) {
    return platnyToken().then(function (token) {
      var vse = [], stran = 0;
      function strana(posledni) {
        var q = { from: [{ collectionId: kolekce }], orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit: 300 };
        if (filtr) q.where = filtr;
        if (posledni) q.startAt = { values: [{ referenceValue: posledni }], before: false };
        return fsQuery('akce/' + encodeURIComponent(aid), q, token).then(function (d) {
          vse = vse.concat(d);
          if (d.length === 300 && ++stran < 30) return strana(d[d.length - 1]._cesta);
          return vse;
        });
      }
      return strana(null);
    });
  }

  var apiSit = {
    hrac: function () { return platnyToken().then(function (t) { return fsGet('hraci/' + encodeURIComponent(relace.uid), t); }); },
    akce: function (aid) {
      var tk = relace ? platnyToken().catch(function () { return null; }) : Promise.resolve(null);   // akci přečte i nepřihlášený
      return tk.then(function (t) { return fsGet('akce/' + encodeURIComponent(aid), t); }).then(function (d) { return d ? naAkci(d) : null; });
    },
    mojeAkce: function () {
      return platnyToken().then(function (t) {
        return fsQuery('', { from: [{ collectionId: 'akce' }], where: rovno('vlastnik', relace.uid), limit: 200 }, t);   // bez filtru vlastnik pravidla dotaz odmítnou
      }).then(function (d) { return d.map(naAkci); });
    },
    pocet: function (aid, kolekce) { return platnyToken().then(function (t) { return fsPocet('akce/' + encodeURIComponent(aid), kolekce, t); }); },
    pod: function (aid, kolekce, filtr) { return podkolekce(aid, kolekce, filtr); },
    zaloz: function (aid, pole) { return fsPatch('akce/' + aid, pole, { novy: true }); },
    uprav: function (aid, pole, maska) { return fsPatch('akce/' + encodeURIComponent(aid), pole, { maska: maska, existuje: true }); },
    zapisBod: function (aid, bid, pole) { return fsPatch('akce/' + encodeURIComponent(aid) + '/body/' + encodeURIComponent(bid), pole, {}); },
    upravUcastnika: function (aid, uid, data) {
      var pole = {}; Object.keys(data).forEach(function (k) { pole[k] = S(data[k]); });
      return fsPatch('akce/' + encodeURIComponent(aid) + '/ucastnici/' + encodeURIComponent(uid), pole, { maska: Object.keys(data), existuje: true });
    },
    smaz: function (cesta) { return fsDelete(cesta); },
    synchronizujCas: function () {
      return platnyToken().then(function (t) { return fsQuery('', { from: [{ collectionId: 'akce' }], where: rovno('vlastnik', relace.uid), limit: 1 }, t); })
        .catch(function () { /* nevadí – použijí se hodiny prohlížeče */ });
    },
  };

  /* ================================================================ UKÁZKA (?ukazka=1) – data v paměti, žádná síť */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  /* procházka pro ukázku: začne ve `start` a nikdy neopustí obdélník `oblast` {s, j, z, v}
     (sever/jih = zeměpisná šířka, západ/východ = délka) – oblast je vybraná tak, aby byla na souši */
  function demoCesta(seed, kroku, start, oblast) {
    var rnd = mulberry32(seed), lat = start.lat, lon = start.lon, smer = rnd() * 2 * Math.PI, out = [];
    var kLat = 111320, kLon = 111320 * Math.cos(start.lat * Math.PI / 180);
    var sLat = (oblast.s + oblast.j) / 2, sLon = (oblast.z + oblast.v) / 2;
    var venku = function (la, lo) { return la > oblast.s || la < oblast.j || lo > oblast.v || lo < oblast.z; };
    var keStredu = function () { return Math.atan2((sLon - lon) * kLon, (sLat - lat) * kLat); };   // 0 = sever, po směru hodin
    for (var i = 0; i < kroku; i++) {
      out.push([zaokr(lat), zaokr(lon)]);
      var uKraje = Math.min(oblast.s - lat, lat - oblast.j) * kLat < 120 || Math.min(oblast.v - lon, lon - oblast.z) * kLon < 120;
      if (uKraje) { var k = keStredu(); smer += Math.atan2(Math.sin(k - smer), Math.cos(k - smer)) * 0.45; }   // měkce zpátky
      smer += (rnd() - 0.5) * 0.7;
      var krok = 20 + rnd() * 10;
      var nLat = lat + krok * Math.cos(smer) / kLat, nLon = lon + krok * Math.sin(smer) / kLon;
      if (venku(nLat, nLon)) {   // odraz od okraje, v rohu rovnou ke středu
        if (nLat > oblast.s || nLat < oblast.j) smer = Math.PI - smer;
        if (nLon > oblast.v || nLon < oblast.z) smer = -smer;
        nLat = lat + krok * Math.cos(smer) / kLat; nLon = lon + krok * Math.sin(smer) / kLon;
        if (venku(nLat, nLon)) { smer = keStredu(); nLat = lat + krok * Math.cos(smer) / kLat; nLon = lon + krok * Math.sin(smer) / kLon; }
      }
      lat = nLat; lon = nLon;
    }
    return out;
  }
  function demoInit() {
    // ⚠️ Ukázka je veřejná → jen známá veřejná místa v Praze (Stromovka, Letná), nikdy ne skutečné bydliště.
    var t = Date.now(), uid = 'ukazka-organizator';
    var stromovka = { lat: 50.1055, lon: 14.4225 }, planetarium = { lat: 50.1040, lon: 14.4287 }, letna = { lat: 50.0955, lon: 14.4190 };
    // Stromovka, Výstaviště a okolní ulice – jižně od železnice a Vltavy (celé na souši)
    var oblastProchazek = { s: 50.1075, j: 50.1012, z: 14.4085, v: 14.4375 };
    var zitra = new Date(t + DEN); zitra.setHours(10, 0, 0, 0);
    var a1 = {
      nazev: 'Podzimní výprava oddílu', popis: 'Společná výprava Stromovkou a Trojou. Vezměte si pití, svačinu a pláštěnku.',
      vlastnik: uid, stav: 'bezi', od: new Date(t - 65 * 60000), do: new Date(t + 115 * 60000), rezim: 'vyprava',
      poloha: 'tym', polohaOrg: true, polohaPovinna: true, schvalovani: true, stopy: 'zive',
      tymy: [{ k: 'a', n: 'Červení', b: '#E53935' }, { k: 'b', n: 'Modří', b: '#1E88E5' }], tymyVyber: 'hraci',
      pole: { typ: 'kruh', lat: stromovka.lat, lon: stromovka.lon, r: 1500 }, sraz: { n: 'U Planetária', lat: planetarium.lat, lon: planetarium.lon },
      max: 15, uchovatDni: 30, vytvoreno: new Date(t - 2 * DEN), souhlasVerze: SOUHLAS_VERZE,
      vzhled: { uvitani: 'Vítejte! Sraz je u Planetária. Držte se svého týmu a u úkolů zapněte sdílení.' },
    };
    var a2 = {
      nazev: 'Narozeninová hra – kontrolní body', popis: 'Obejděte všechny body co nejrychleji. Na každém čeká malá odměna.',
      vlastnik: uid, stav: 'priprava', od: zitra, do: new Date(+zitra + 3 * 3600000), rezim: 'body',
      poloha: 'organizator', polohaOrg: true, polohaPovinna: true, schvalovani: false, stopy: 'vysledky', tymy: [], tymyVyber: 'hraci',
      pole: { typ: 'kruh', lat: letna.lat, lon: letna.lon, r: 800 }, sraz: { n: 'Hřiště na Letné', lat: letna.lat, lon: letna.lon },
      max: 12, uchovatDni: 7, vytvoreno: new Date(t - 3 * 3600000), souhlasVerze: SOUHLAS_VERZE, vzhled: {},
    };
    DEMO = { relace: { uid: uid, mail: 'organizator@example.cz', jmeno: 'Ukázkový organizátor' }, hrac: { premium: true }, akce: {}, pod: {}, cesty: {} };
    DEMO.akce.demo1234 = { name: JMENO + 'akce/demo1234', fields: akceNaPole(a1) };
    DEMO.akce.demo5678 = { name: JMENO + 'akce/demo5678', fields: akceNaPole(a2) };
    var lidi = [   // stop = před kolika minutami přestal posílat polohu
      { uid: 'u-jana', prezdivka: 'Jana', tym: 'a', role: 'kapitan', stav: 'ok', sdili: true, seed: 11, stop: 0, presnost: 6 },
      { uid: 'u-petr', prezdivka: 'Petr', tym: 'a', role: 'hrac', stav: 'ok', sdili: true, seed: 23, stop: 0, presnost: 12 },
      { uid: 'u-ema', prezdivka: 'Ema', tym: 'a', role: 'hrac', stav: 'ok', sdili: true, seed: 37, stop: 3, presnost: 18 },
      { uid: 'u-vojta', prezdivka: 'Vojta', tym: 'b', role: 'kapitan', stav: 'ok', sdili: true, seed: 41, stop: 8, presnost: 9 },
      { uid: 'u-klara', prezdivka: 'Klára', tym: 'b', role: 'hrac', stav: 'ok', sdili: false, seed: 53, stop: 0, presnost: 25 },
      { uid: 'u-tomas', prezdivka: 'Tomáš', tym: 'b', role: 'hrac', stav: 'ceka', sdili: true, seed: 61, stop: 0, presnost: 10 },
      { uid: 'u-lucie', prezdivka: 'Lucie', tym: '', role: 'hrac', stav: 'ceka', sdili: true, seed: 71, stop: 0, presnost: 10 },
    ];
    var t0 = t - 62 * 60000;
    DEMO.cesty.demo1234 = { t0: t0, krok: 22500, nacteno: t, lidi: {} };
    DEMO.pod.demo1234 = { ucastnici: [], body: [] };
    lidi.forEach(function (l, i) {
      var pripojen = new Date(t0 - (14 - i * 2) * 60000);
      DEMO.pod.demo1234.ucastnici.push({ _id: l.uid, _cesta: JMENO + 'akce/demo1234/ucastnici/' + l.uid, prezdivka: l.prezdivka, tym: l.tym,
        role: l.role, stav: l.stav, sdiliPolohu: l.sdili, souhlas: pripojen, souhlasVerze: SOUHLAS_VERZE, pripojen: pripojen });
      DEMO.cesty.demo1234.lidi[l.uid] = { body: demoCesta(l.seed, 520, planetarium, oblastProchazek), stop: l.stop * 60000, presnost: l.presnost };
    });
    var b2 = [['Metronom', 50.0947, 14.4151], ['Hanavský pavilon', 50.0935, 14.4128], ['Letenský zámeček', 50.0960, 14.4219], ['Letenská vyhlídka', 50.0942, 14.4175]];
    DEMO.pod.demo5678 = { ucastnici: [], body: b2.map(function (b, i) {
      return { _id: 'b' + (i + 1), _cesta: JMENO + 'akce/demo5678/body/b' + (i + 1), n: b[0], lat: b[1], lon: b[2], h: 1, r: 30, poradi: i + 1 };
    }) };
  }
  function demoAkce(aid) { return DEMO.akce[aid] ? naAkci(dokument(DEMO.akce[aid])) : null; }
  /* poloha a stopy ukázkové akce se počítají z času – na živé mapě se účastníci opravdu hýbou */
  function demoZive(aid, kolekce) {
    var c = DEMO.cesty[aid], a = demoAkce(aid);
    if (!c || !a) return [];
    var konec = Math.min(Date.now(), +a.do), out = [];
    DEMO.pod[aid].ucastnici.forEach(function (u) {
      var cl = c.lidi[u._id];
      // pravidla v21: polohu I trasu zapíše jen schválený účastník se zapnutým vypínačem sdiliPolohu
      // (zápis stopy s vypnutým vypínačem server odmítne) – ukázka ho tedy vůbec nevytvoří
      if (!cl || stavUc(u) !== 'ok' || u.sdiliPolohu !== true) return;
      var tKonec = cl.stop ? Math.min(konec, c.nacteno - cl.stop) : konec;
      var idx = Math.max(0, Math.min(cl.body.length - 1, Math.floor((tKonec - c.t0) / c.krok)));
      if (kolekce === 'poloha') {
        var b = cl.body[idx];
        out.push({ _id: u._id, _cesta: JMENO + 'akce/' + aid + '/poloha/' + u._id, lat: b[0], lon: b[1], presnost: cl.presnost,
          kdy: new Date(c.t0 + idx * c.krok), tym: u.tym });
        return;
      }
      for (var n = 0; n * 40 < idx; n++) {
        var z = n * 40, k = Math.min(z + 40, idx), usek = cl.body.slice(z, k + 1);
        if (usek.length < 2) continue;
        var delka = 0;
        for (var i = 1; i < usek.length; i++) delka += vzdalenost(usek[i - 1][0], usek[i - 1][1], usek[i][0], usek[i][1]);
        out.push({ _id: u._id + '_' + n, _cesta: JMENO + 'akce/' + aid + '/stopy/' + u._id + '_' + n, u: u._id, n: n, body: zakodujPolyline(usek),
          od: new Date(c.t0 + z * c.krok), do: new Date(c.t0 + k * c.krok), delka: Math.round(delka), tym: u.tym });
      }
    });
    return out;
  }
  function demoPod(aid, kolekce, filtr) {
    var p = DEMO.pod[aid], a = demoAkce(aid), vysl;
    if (!p || !a) return [];
    // stejná omezení jako pravidla v20 – ukázka tak odhalí dotaz, který by server odmítl
    if (kolekce === 'poloha' && (!orgVidiPolohu(a) || Date.now() > +a.do + 10 * 60000)) throw chyba('HTTP 403 (pravidla: poloha)', 403);
    if (kolekce === 'stopy' && a.stopy === 'ne') throw chyba('HTTP 403 (pravidla: stopy)', 403);
    if (kolekce === 'ucastnici' || kolekce === 'body') vysl = kopie(p[kolekce] || []);
    else if (kolekce === 'poloha' || kolekce === 'stopy') vysl = (p['_' + kolekce] || []).concat(demoZive(aid, kolekce));
    else vysl = [];
    if (filtr && filtr.fieldFilter) {
      var pole = filtr.fieldFilter.field.fieldPath, h = filtr.fieldFilter.value.stringValue;
      vysl = vysl.filter(function (d) { return d[pole] === h; });
    }
    return vysl;
  }
  var KLICE_AKCE = ['nazev', 'popis', 'vlastnik', 'stav', 'od', 'do', 'rezim', 'poloha', 'polohaOrg', 'polohaPovinna', 'schvalovani',
    'stopy', 'tymy', 'tymyVyber', 'pole', 'sraz', 'max', 'uchovatDni', 'verejna', 'vytvoreno', 'souhlasVerze', 'pravidla', 'vzhled'];
  /* kopie podmínek pravidel v20 (nastaveniAkceOk + create/update) nad typovanými poli */
  function demoPravidla(f, stare, aid) {
    var ch = [];
    var s = function (k) { return f[k] && typeof f[k].stringValue === 'string' ? f[k].stringValue : null; };
    var c = function (k) { return f[k] && f[k].timestampValue ? Date.parse(f[k].timestampValue) : NaN; };
    var i = function (k) { return f[k] && f[k].integerValue !== undefined ? Number(f[k].integerValue) : NaN; };
    var b = function (k) { return !(k in f) || (f[k] && typeof f[k].booleanValue === 'boolean'); };
    Object.keys(f).forEach(function (k) { if (KLICE_AKCE.indexOf(k) < 0 && !(stare && k === 'spoluorg')) ch.push('pole ' + k); });
    var n = s('nazev'); if (n === null || n.length < 3 || n.length > 60) ch.push('nazev');
    if ('popis' in f && (s('popis') === null || s('popis').length > 1000)) ch.push('popis');
    var od = c('od'), dO = c('do'); if (isNaN(od) || isNaN(dO) || !(dO > od) || dO - od > MAX_DNU * DEN) ch.push('od/do');
    if (['vyprava', 'body', 'vlajky'].indexOf(s('rezim')) < 0) ch.push('rezim');
    if (['nikdo', 'organizator', 'tym', 'vsichni'].indexOf(s('poloha')) < 0) ch.push('poloha');
    ['polohaOrg', 'polohaPovinna', 'schvalovani'].forEach(function (k) { if (!b(k)) ch.push(k); });
    if (['ne', 'organizator', 'vysledky', 'zive'].indexOf(s('stopy')) < 0) ch.push('stopy');
    if (!f.tymy || !f.tymy.arrayValue || (f.tymy.arrayValue.values || []).length > 20) ch.push('tymy');
    if (['hraci', 'organizator', 'nahodne'].indexOf(s('tymyVyber')) < 0) ch.push('tymyVyber');
    var max = i('max'); if (!(max >= 2 && max <= MAX_UCASTNIKU)) ch.push('max');
    var u = i('uchovatDni'); if (!(u >= 0 && u <= 90)) ch.push('uchovatDni');
    if (!f.verejna || f.verejna.booleanValue !== false) ch.push('verejna');
    if (isNaN(i('souhlasVerze'))) ch.push('souhlasVerze');
    if (!stare) {
      if (!/^[a-hj-np-z2-9]{8}$/.test(aid)) ch.push('kód');
      if (s('vlastnik') !== DEMO.relace.uid) ch.push('vlastnik');
      if (s('stav') !== 'priprava') ch.push('stav');
      var v = c('vytvoreno'); if (isNaN(v) || Math.abs(v - Date.now()) > 5 * 60000) ch.push('vytvoreno');
      if (!DEMO.hrac.premium) ch.push('premium');
    } else {
      if (JSON.stringify(f.vlastnik) !== JSON.stringify(stare.vlastnik)) ch.push('vlastnik');
      if (JSON.stringify(f.vytvoreno) !== JSON.stringify(stare.vytvoreno)) ch.push('vytvoreno');
      if (['priprava', 'bezi', 'konec'].indexOf(s('stav')) < 0) ch.push('stav');
    }
    return ch;
  }
  /* kopie pravidel v21 pro update: sdílení jen zúžit, po startu čas jen zkrátit */
  function demoZuzeni(stare, nove) {
    var ch = [], a = naAkci(dokument({ name: 'x/y', fields: stare })), b = naAkci(dokument({ name: 'x/y', fields: nove }));
    if (polohaRozsiruje(a, b.poloha, b.polohaOrg)) ch.push('poloha jen zúžit');
    if (stopyRozsiruji(a, b.stopy)) ch.push('stopy jen zúžit');
    if (b.uchovatDni > a.uchovatDni) ch.push('uchovatDni jen zkrátit');
    if (Date.now() >= +a.od) {   // po startu (podle uloženého začátku)
      if (+b.od !== +a.od) ch.push('začátek po startu pevný');
      if (+b.do > +a.do) ch.push('konec po startu jen dřív');
    }
    return ch;
  }
  function demoOdmitni(ch) { console.warn('[ukázka] pravidla by zápis odmítla:', ch); return chyba('HTTP 403 (pravidla: ' + ch.join(', ') + ')', 403); }
  /* updateMask jako Firestore: pole v masce a v datech se zapíšou, v masce bez dat se smažou */
  function demoMaska(fields, pole, maska) {
    Object.keys(pole).forEach(function (k) {
      if (!maska.some(function (m) { return m === k || m.indexOf(k + '.') === 0; })) throw chyba('HTTP 400 (pole ' + k + ' chybí v masce)', 400);
    });
    maska.forEach(function (cesta) {
      var casti = cesta.split('.');
      if (casti.length === 1) { if (cesta in pole) fields[cesta] = kopie(pole[cesta]); else delete fields[cesta]; return; }
      var a = casti[0], b = casti[1];
      if (!fields[a] || !fields[a].mapValue) fields[a] = M({});
      fields[a].mapValue.fields = fields[a].mapValue.fields || {};
      var zdroj = (pole[a] && pole[a].mapValue && pole[a].mapValue.fields) || {};
      if (b in zdroj) fields[a].mapValue.fields[b] = kopie(zdroj[b]); else delete fields[a].mapValue.fields[b];
    });
  }
  function demoCesta2(cesta) {   // 'projects/…/documents/akce/x/poloha/u' nebo 'akce/x/poloha/u' → ['akce','x','poloha','u']
    return String(cesta).replace(/^projects\/[^/]+\/databases\/[^/]+\/documents\//, '').split('/');
  }
  var apiUkazka = {
    hrac: function () { return pockej(150).then(function () { return kopie(DEMO.hrac); }); },
    akce: function (aid) { return pockej(150).then(function () { return demoAkce(aid); }); },
    mojeAkce: function () {
      return pockej(220).then(function () {
        return Object.keys(DEMO.akce).map(demoAkce).filter(function (a) { return a.vlastnik === relace.uid; });
      });
    },
    pocet: function (aid, kolekce) { return pockej(120).then(function () { return ((DEMO.pod[aid] || {})[kolekce] || []).length; }); },
    pod: function (aid, kolekce, filtr) { return pockej(180).then(function () { return demoPod(aid, kolekce, filtr); }); },
    zaloz: function (aid, pole) {
      return pockej(350).then(function () {
        if (DEMO.akce[aid]) throw chyba('HTTP 409', 409, 'ALREADY_EXISTS');
        var ch = demoPravidla(pole, null, aid);
        if (ch.length) throw demoOdmitni(ch);
        DEMO.akce[aid] = { name: JMENO + 'akce/' + aid, fields: kopie(pole) };
        DEMO.pod[aid] = { ucastnici: [], body: [] };
      });
    },
    uprav: function (aid, pole, maska) {
      return pockej(250).then(function () {
        var d = DEMO.akce[aid];
        if (!d) throw chyba('HTTP 404', 404);
        var nove = kopie(d.fields);
        demoMaska(nove, pole, maska);
        var ch = demoPravidla(nove, d.fields, aid).concat(demoZuzeni(d.fields, nove));
        if (ch.length) throw demoOdmitni(ch);
        d.fields = nove;
      });
    },
    zapisBod: function (aid, bid, pole) {
      return pockej(120).then(function () {
        var p = DEMO.pod[aid]; if (!p) throw chyba('HTTP 403', 403);
        if (!pole.n || typeof pole.n.stringValue !== 'string' || pole.n.stringValue.length > 60 || !pole.lat || !pole.lon) throw demoOdmitni(['bod']);
        var doc = dokument({ name: JMENO + 'akce/' + aid + '/body/' + bid, fields: kopie(pole) });
        p.body = p.body.filter(function (x) { return x._id !== bid; }).concat([doc]);
      });
    },
    upravUcastnika: function (aid, uid, data) {
      return pockej(200).then(function () {
        var p = DEMO.pod[aid], u = p && najdi(p.ucastnici, function (x) { return x._id === uid; });
        if (!u) throw chyba('HTTP 404', 404);
        Object.keys(data).forEach(function (k) {
          if (['tym', 'role', 'stav'].indexOf(k) < 0) throw demoOdmitni(['ucastnik.' + k]);
          if (k === 'stav' && ['ceka', 'ok', 'zamitnut'].indexOf(data[k]) < 0) throw demoOdmitni(['stav']);
          if (k === 'tym' && String(data[k]).length > 24) throw demoOdmitni(['tym']);
        });
        Object.keys(data).forEach(function (k) { u[k] = data[k]; });
      });
    },
    smaz: function (cesta) {
      return pockej(60).then(function () {
        var c = demoCesta2(cesta);
        if (c[0] !== 'akce' || !c[1]) throw chyba('HTTP 403', 403);
        var aid = c[1];
        if (c.length === 2) {
          var a = demoAkce(aid);
          if (a && ['priprava', 'konec'].indexOf(a.stav) < 0) throw demoOdmitni(['smazání jen ve stavu priprava/konec']);
          delete DEMO.akce[aid]; delete DEMO.pod[aid]; delete DEMO.cesty[aid];
          return;
        }
        var p = DEMO.pod[aid]; if (!p) return;
        if (c[2] === 'ucastnici' || c[2] === 'body') p[c[2]] = p[c[2]].filter(function (x) { return x._id !== c[3]; });
      });
    },
    synchronizujCas: function () { return Promise.resolve(); },
  };

  /* ================================================================ mapa (MapLibre z CDN, načtená až když je potřeba) */
  var mlSlib = null;
  function nactiMapLibre() {
    if (window.maplibregl) return Promise.resolve(window.maplibregl);
    if (mlSlib) return mlSlib;
    mlSlib = new Promise(function (ok, ko) {
      if (!document.querySelector('link[data-maplibre]')) {
        var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = ML_CSS; l.setAttribute('data-maplibre', '1');
        document.head.appendChild(l);
      }
      var s = document.createElement('script'); s.src = ML_JS; s.async = true;
      var cas = setTimeout(function () { ko(chyba('Knihovna mapy se nenačetla včas.', 'mapa')); }, 25000);
      s.onload = function () { clearTimeout(cas); if (window.maplibregl) ok(window.maplibregl); else ko(chyba('Knihovna mapy se nenačetla.', 'mapa')); };
      s.onerror = function () { clearTimeout(cas); ko(chyba('Knihovnu mapy se nepodařilo stáhnout.', 'mapa')); };
      document.head.appendChild(s);
    });
    mlSlib.catch(function () { mlSlib = null; });   // příště to zkusí znovu
    return mlSlib;
  }
  function mapaHtml(id, trida, poznamka) {
    return '<div class="mapa-obal"><div id="' + id + '" class="mapa-box ' + (trida || '') + '"></div>'
      + (poznamka ? '<div class="mapa-poznamka" id="' + id + 'Pozn"></div>' : '')
      + '<div class="mapa-nacitani"><div class="tocka"></div>Načítám mapu…</div></div>';
  }
  function chybaMapy(kontejner, e) {
    var n = kontejner && kontejner.parentNode && kontejner.parentNode.querySelector('.mapa-nacitani');
    if (n) { n.classList.add('chyba-mapy'); n.textContent = 'Mapu se nepodařilo načíst. ' + chybaText(e); }
  }
  function vytvorMapu(kontejner, volby) {
    volby = volby || {};
    return nactiMapLibre().then(function (ml) {
      return new Promise(function (ok, ko) {
        var mapa;
        try {
          mapa = new ml.Map({
            container: kontejner, style: STYL_MAPY, center: volby.stred || [15.45, 49.8], zoom: volby.zoom != null ? volby.zoom : 6.2,
            attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false,
            locale: { 'NavigationControl.ZoomIn': 'Přiblížit', 'NavigationControl.ZoomOut': 'Oddálit',
              'GeolocateControl.FindMyLocation': 'Najít moji polohu', 'GeolocateControl.LocationNotAvailable': 'Poloha není k dispozici',
              'AttributionControl.ToggleAttribution': 'Zdroje mapy' },
          });
        } catch (e) { ko(chyba('Mapu se nepodařilo spustit – prohlížeč možná nepodporuje WebGL.', 'mapa')); return; }
        if (mapa.touchZoomRotate) mapa.touchZoomRotate.disableRotation();
        mapa.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
        if (volby.hledatPolohu && ml.GeolocateControl) {
          mapa.addControl(new ml.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), 'top-right');
        }
        var hotovo = false, styl = false;
        var nacitani = function () { return kontejner.parentNode && kontejner.parentNode.querySelector('.mapa-nacitani'); };
        // Po 25 s jen zpráva místo točení – mapu NERUŠIT: ve skrytém panelu prohlížeč brzdí snímky
        // a mapa se dočte, až se na stránku vrátíte (načtení pak zprávu samo odstraní).
        var cas = setTimeout(function () {
          var n = nacitani();
          if (hotovo || !n) return;
          n.classList.add('chyba-mapy');
          n.textContent = 'Mapa se načítá déle než obvykle. Zkontrolujte připojení k internetu, případně stránku načtěte znovu.';
        }, 25000);
        priUklidu(function () { if (!hotovo) { hotovo = true; clearTimeout(cas); try { mapa.remove(); } catch (e) { /* nic */ } } });   // odchod ze stránky před načtením
        mapa.once('styledata', function () { styl = true; });
        mapa.on('error', function () {   // chyba ještě před stylem = styl nejde stáhnout (chyby dlaždic až po něm)
          if (hotovo || styl) return;
          hotovo = true; clearTimeout(cas);
          try { mapa.remove(); } catch (e) { /* nic */ }
          ko(chyba('Podkladovou mapu se nepodařilo stáhnout.', 'mapa'));
        });
        mapa.on('load', function () {
          if (hotovo) return; hotovo = true; clearTimeout(cas);
          var n = kontejner.parentNode && kontejner.parentNode.querySelector('.mapa-nacitani');
          if (n) n.remove();
          pripravVrstvy(mapa);
          ok(obalMapy(mapa, ml));
        });
      });
    });
  }
  function pripravVrstvy(mapa) {
    var prazdne = { type: 'FeatureCollection', features: [] };
    mapa.addSource('akce-pole', { type: 'geojson', data: prazdne });
    mapa.addSource('akce-stopy', { type: 'geojson', data: prazdne });
    mapa.addLayer({ id: 'akce-pole-plocha', type: 'fill', source: 'akce-pole', paint: { 'fill-color': '#2E7D5B', 'fill-opacity': 0.07 } });
    mapa.addLayer({ id: 'akce-pole-obrys', type: 'line', source: 'akce-pole',
      paint: { 'line-color': '#2E7D5B', 'line-width': 2.5, 'line-dasharray': [2, 1.5], 'line-opacity': 0.9 } });
    mapa.addLayer({ id: 'akce-stopy-podklad', type: 'line', source: 'akce-stopy', layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 6.5, 'line-opacity': 0.75 } });
    mapa.addLayer({ id: 'akce-stopy-cara', type: 'line', source: 'akce-stopy', layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'barva'], 'line-width': 3.5, 'line-opacity': 0.92 } });
  }
  function obalMapy(mapa, ml) {
    var znacky = {};
    return {
      mapa: mapa,
      pole: function (p) {
        var s = mapa.getSource('akce-pole');
        if (s) s.setData({ type: 'FeatureCollection', features: p ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [kruh(p.lat, p.lon, p.r)] } }] : [] });
      },
      stopy: function (f) { var s = mapa.getSource('akce-stopy'); if (s) s.setData({ type: 'FeatureCollection', features: f || [] }); },
      /* značky podle klíče: stejná „verze“ = jen posun, jiná = nový prvek */
      znacky: function (seznam) {
        var nove = {};
        seznam.forEach(function (z) {
          var m = znacky[z.klic];
          if (m && m._verze !== z.verze) { m.remove(); m = null; }
          if (!m) {
            var prvek = z.prvek();
            if (z.vrch) prvek.style.zIndex = '3';
            if (z.tah) prvek.classList.add('zn-tah');
            m = new ml.Marker({ element: prvek, anchor: z.kotva || 'center', offset: z.posun || [0, 0], draggable: !!z.tah })
              .setLngLat([z.lon, z.lat]).addTo(mapa);
            m._verze = z.verze;
            if (z.tah) m.on('dragend', function () { if (m._tah) m._tah(m.getLngLat()); });
          } else m.setLngLat([z.lon, z.lat]);
          m._tah = z.tah || null;
          if (z.titulek != null) m.getElement().title = z.titulek;
          nove[z.klic] = m;
        });
        Object.keys(znacky).forEach(function (k) { if (!nove[k]) znacky[k].remove(); });
        znacky = nove;
      },
      prizpusob: function (body) {
        var b = null;
        (body || []).forEach(function (p) {
          if (!p || !jeCislo(p[0]) || !jeCislo(p[1]) || Math.abs(p[1]) > 90 || Math.abs(p[0]) > 180) return;
          if (!b) b = [p[0], p[1], p[0], p[1]];
          else { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); }
        });
        var k = mapa.getContainer();
        if (!b || !k.clientWidth || !k.clientHeight) return false;
        var okraj = Math.max(10, Math.min(60, Math.floor(Math.min(k.clientWidth, k.clientHeight) / 5)));
        if (b[2] - b[0] < 1e-4 && b[3] - b[1] < 1e-4) mapa.jumpTo({ center: [b[0], b[1]], zoom: 15 });
        else mapa.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: okraj, maxZoom: 16, duration: 0 });
        return true;
      },
      zrus: function () { try { mapa.remove(); } catch (e) { /* nic */ } },
    };
  }
  function jeKlikNaZnacku(e) {
    var t = e && e.originalEvent && e.originalEvent.target;
    return !!(t && t.closest && t.closest('.maplibregl-marker'));
  }
  function prvekHrace(jmeno, barva, stara) {
    var d = document.createElement('div');
    d.className = 'zn-hrac' + (stara ? ' stara' : '');
    d.style.background = barva;
    var j = document.createElement('span'); j.className = 'jm'; j.textContent = jmeno; d.appendChild(j);
    return d;
  }
  function prvekSrazu(nazev) { var d = document.createElement('div'); d.className = 'zn-sraz'; d.textContent = '📍 ' + (nazev || 'Sraz'); return d; }
  function prvekBodu(cislo, nazev) {
    var d = document.createElement('div'); d.className = 'zn-bod'; d.textContent = String(cislo);
    var j = document.createElement('span'); j.className = 'jm'; j.textContent = nazev || ''; d.appendChild(j);
    return d;
  }
  function prvekStredu() { var d = document.createElement('div'); d.className = 'zn-stred'; return d; }
  function znackaSrazu(sraz, tah) {
    return { klic: 'sraz', lat: sraz.lat, lon: sraz.lon, verze: 'sraz|' + sraz.n, kotva: 'bottom', posun: [0, -6],
      prvek: function () { return prvekSrazu(sraz.n); }, titulek: 'Sraz: ' + (sraz.n || ''), tah: tah };
  }
  function znackaBodu(b, i, klic, tah) {
    var cislo = i + 1;
    return { klic: klic || 'bod:' + (b._id || i), lat: b.lat, lon: b.lon, verze: 'bod|' + cislo + '|' + b.n,
      prvek: function () { return prvekBodu(cislo, b.n); }, titulek: cislo + '. ' + (b.n || '') + (jeCislo(b.h) ? ' · ' + b.h + ' ' + sklon(b.h, 'bod', 'body', 'bodů') : ''), tah: tah };
  }
  var mezipametStop = {};
  function sourStopy(s) {
    var k = s._id + ':' + (s.body || '').length;
    if (!mezipametStop[k]) mezipametStop[k] = dekodujPolyline(s.body || '').filter(function (p) { return Math.abs(p[1]) <= 90 && Math.abs(p[0]) <= 180; });
    return mezipametStop[k];
  }
  function prvkyStop(stopy, barvaPro) {
    var out = [];
    (stopy || []).forEach(function (s) {
      var sour = sourStopy(s);
      if (sour.length < 2) return;
      out.push({ type: 'Feature', properties: { barva: barvaPro(s) }, geometry: { type: 'LineString', coordinates: sour } });
    });
    return out;
  }
  function bodyProPrizpusobeni(a, body, polohy, stopy) {
    var out = [];
    if (a.sraz) out.push([a.sraz.lon, a.sraz.lat]);
    if (a.pole) kruh(a.pole.lat, a.pole.lon, a.pole.r).forEach(function (p, i) { if (i % 18 === 0) out.push(p); });
    (body || []).forEach(function (b) { out.push([b.lon, b.lat]); });
    (polohy || []).forEach(function (p) { out.push([p.lon, p.lat]); });
    (stopy || []).forEach(function (s) { sourStopy(s).forEach(function (p, i) { if (i % 5 === 0) out.push(p); }); });
    return out;
  }

  /* ================================================================ společné kusy stránky */
  function horni() {
    var h = '';
    if (UKAZKA) h += '<div class="ukazka-pruh">UKÁZKA – smyšlená data, nic se neukládá na server.</div>';
    if (hlaskaPohledu) h += '<p class="hlaska' + (hlaskaPohledu.chyba ? ' spatna' : '') + '" role="status">' + esc(hlaskaPohledu.text) + '</p>';
    return h;
  }
  function sirka(siroka) { el('obsah').classList.toggle('siroky', !!siroka); }
  function nacitani(textik) { el('obsah').innerHTML = horni() + '<div class="stav"><div class="tocka"></div>' + esc(textik || 'Načítám…') + '</div>'; }
  function zpravaEl(id, textik, typ) {
    var z = el(id); if (!z) return;
    z.textContent = textik || '';
    z.className = 'zprava' + (typ === 'chyba' ? ' je-chyba' : typ === 'ok' ? ' je-ok' : '');
  }
  function chybaNacteni(textik, znovu) {
    el('obsah').innerHTML = horni() + '<div class="stav"><h2>Něco se nepovedlo</h2><p>' + esc(textik) + '</p>'
      + '<p class="radek-flex" style="justify-content:center"><button type="button" class="tlacitko male" id="znovu">Zkusit znovu</button>'
      + '<a class="tlacitko male obrys" data-jdi href="' + esc(odkaz({})) + '">Moje akce</a></p></div>';
    el('znovu').onclick = znovu;
  }
  function vyzvaPrihlaseni(textik) {
    el('obsah').innerHTML = horni() + '<div class="stav"><h2>Přihlaste se</h2><p>' + esc(textik) + '</p>'
      + '<p><a class="tlacitko" href="/ucet/">Přihlásit se</a></p></div>';
  }
  function nenalezeno(kod) {
    document.title = 'Akce nenalezena – Okolník';
    sirka(false);
    el('obsah').innerHTML = horni() + '<div class="stav"><h2>Akce s tímto kódem neexistuje</h2><p>Kód <strong>' + esc(kod || '–')
      + '</strong> jsme nenašli. Zkontrolujte ho prosím – má 8 znaků (malá písmena a číslice). Akci mohl organizátor také smazat.</p></div>'
      + formularKodu('Zkusit jiný kód');
    napojFormularKodu();
  }
  function formularKodu(nadpis) {
    return '<form class="kod-form" id="kodForm" novalidate><label class="popisek" for="kodVstup">' + esc(nadpis || 'Máte kód akce?') + '</label>'
      + '<div class="kod-form-radek"><input class="vstup" id="kodVstup" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="24" placeholder="např. k7m2x9qa">'
      + '<button class="tlacitko male zelene" type="submit">Otevřít</button></div><p class="chyba" id="kodChyba" role="alert"></p></form>';
  }
  function napojFormularKodu() {
    var f = el('kodForm'); if (!f) return;
    f.onsubmit = function (e) {
      e.preventDefault();
      var k = normKod(el('kodVstup').value);
      if (!k) { el('kodChyba').textContent = 'Zadejte kód akce.'; return; }
      if (!kodVypadaPlatne(k)) { el('kodChyba').textContent = 'Kód má 8 znaků – malá písmena a číslice.'; return; }
      jdi(odkaz({ k: k }));
    };
  }
  function kopiruj(textik, tlacitko) {
    var puvodni = tlacitko.getAttribute('data-text') || tlacitko.textContent;
    tlacitko.setAttribute('data-text', puvodni);
    function hotovo() { tlacitko.textContent = 'Zkopírováno ✓'; setTimeout(function () { tlacitko.textContent = puvodni; }, 2000); }
    function zaloha() {
      var t = document.createElement('textarea'); t.value = textik; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* nic */ }
      t.remove();
      if (ok) hotovo(); else tlacitko.textContent = 'Zkopírujte odkaz ručně';
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(textik).then(hotovo, zaloha); else zaloha();
  }
  function napojKopirovani(koren, a) {
    var url = ODKAZ_AKCE + a._id;
    koren.querySelectorAll('[data-kopirovat]').forEach(function (b) { b.onclick = function () { kopiruj(url, b); }; });
    koren.querySelectorAll('[data-sdilet]').forEach(function (b) {
      if (!navigator.share) return;
      b.hidden = false;
      b.onclick = function () {
        navigator.share({ title: a.nazev, text: 'Připojte se k akci „' + a.nazev + '“ v aplikaci Okolník – kód ' + a._id + '.', url: url }).catch(function () { /* zrušeno */ });
      };
    });
  }
  /* vlastní potvrzovací okno (window.confirm nejde stylovat a v náhledech blokuje) */
  function potvrd(o) {
    return new Promise(function (ok) {
      var predtim = document.activeElement;
      var zaves = document.createElement('div');
      zaves.className = 'dialog-zaves';
      zaves.innerHTML = '<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlgNadpis"><h2 id="dlgNadpis"></h2><p class="dlg-text"></p>'
        + '<div class="dialog-tlacitka"><button type="button" class="tlacitko male obrys" data-ne>Zrušit</button>'
        + '<button type="button" class="tlacitko male ' + (o.nebezpecne ? 'nebezpeci-plne' : 'zelene') + '" data-ano></button></div></div>';
      zaves.querySelector('h2').textContent = o.nadpis;
      zaves.querySelector('.dlg-text').textContent = o.text;
      zaves.querySelector('[data-ano]').textContent = o.ano || 'Potvrdit';
      function konec(v) {
        document.removeEventListener('keydown', klavesa, true);
        zaves.remove();
        if (predtim && predtim.focus && document.contains(predtim)) predtim.focus();
        ok(v);
      }
      function klavesa(e) { if (e.key === 'Escape') { e.stopPropagation(); konec(false); } }
      zaves.addEventListener('click', function (e) { if (e.target === zaves) konec(false); });
      zaves.querySelector('[data-ne]').onclick = function () { konec(false); };
      zaves.querySelector('[data-ano]').onclick = function () { konec(true); };
      document.addEventListener('keydown', klavesa, true);
      document.body.appendChild(zaves);
      zaves.querySelector('[data-ne]').focus();
    });
  }
  function stahni(nazev, obsah, typ) {
    var url = URL.createObjectURL(new Blob([obsah], { type: typ }));
    var a = document.createElement('a'); a.href = url; a.download = nazev; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }
  function poSkupinach(seznam, n, fn) {   // fn nad seznamem, nejvýš n najednou; chyby až na konec
    var i = 0, chyby = [];
    function dalsi() {
      if (i >= seznam.length) return Promise.resolve();
      var x = seznam[i++];
      return Promise.resolve().then(function () { return fn(x); }).catch(function (e) { chyby.push(e); }).then(dalsi);
    }
    var vlakna = [];
    for (var k = 0; k < Math.min(n, seznam.length); k++) vlakna.push(dalsi());
    return Promise.all(vlakna).then(function () { if (chyby.length) throw chyby[0]; });
  }

  /* ================================================================ směrování (jedna stránka) */
  function odkaz(p) {
    var q = [];
    if (p.k) q.push('k=' + encodeURIComponent(p.k));
    if (p.novy) q.push('novy=1');
    if (p.upravit) q.push('upravit=1');
    if (p.vysledky) q.push('vysledky=1');
    if (p.nahled) q.push('nahled=1');
    if (p.zalozeno) q.push('zalozeno=1');
    if (UKAZKA) q.push('ukazka=1');
    return '/akce/' + (q.length ? '?' + q.join('&') : '');
  }
  function jdi(url, nahradit) {
    try { history[nahradit ? 'replaceState' : 'pushState'](null, '', url); } catch (e) { location.href = url; return; }
    vykresli();
  }
  function priUklidu(fn) { uklidy.push(fn); }
  function uklid() {
    pohled++;
    uklidy.splice(0).forEach(function (f) { try { f(); } catch (e) { /* nic */ } });
    document.body.classList.remove('velka');
    document.querySelectorAll('.dialog-zaves').forEach(function (d) { d.remove(); });
    if (P && P.mapa) P.mapa.zrus();
    P = null; Z = null;
  }
  function vykresli() {
    uklid();
    hlaskaPohledu = hlaska; hlaska = null;
    window.scrollTo(0, 0);
    var p = new URLSearchParams(location.search);
    if (p.has('k')) {
      var k = normKod(p.get('k'));
      if (!kodVypadaPlatne(k)) { nenalezeno(k); return; }
      if (p.get('upravit') === '1') { pruvodce(k); return; }
      detail(k, { vysledky: p.get('vysledky') === '1', nahled: p.get('nahled') === '1', zalozeno: p.get('zalozeno') === '1' });
      return;
    }
    if (p.get('novy') === '1') { pruvodce(null); return; }
    domov();
  }

  /* ================================================================ DOMŮ: co to je / Moje akce */
  function seradAkce(seznam) {
    var poradi = { bezi: 0, priprava: 1, konec: 2 };
    return seznam.sort(function (a, b) {
      var sa = stavAkce(a), sb = stavAkce(b);
      if (sa !== sb) return poradi[sa] - poradi[sb];
      return sa === 'konec' ? (+b.do || 0) - (+a.do || 0) : (+a.od || 0) - (+b.od || 0);
    });
  }
  function polozkaAkce(a) {
    var st = stavAkce(a);
    return '<li><a class="akce-polozka" data-jdi href="' + esc(odkaz({ k: a._id })) + '">'
      + '<span class="ap-hlava"><strong>' + esc(a.nazev) + '</strong>' + stitekStavu(st) + '</span>'
      + '<span class="ap-info">' + esc(fmtRozsah(a.od, a.do)) + ' · ' + esc(REZIMY[a.rezim] || a.rezim)
      + '<span data-pocet="' + esc(a._id) + '"></span></span></a></li>';
  }
  function premiumHtml() {
    return '<div class="karta premium-box"><h3>Okolník Premium</h3>'
      + '<p>Zakládání akcí je součást Okolník Premium (akce až pro 15 lidí). Premium si pořídíte v aplikaci.</p>'
      + '<p class="drobne">V aplikaci otevřete Více → Okolník Premium. Web si předplatného všimne po dalším spuštění aplikace. Své dřívější akce tu můžete dál spravovat.</p></div>';
  }
  function domov() {
    var id = pohled;
    sirka(false);
    document.title = 'Hra na míru – Okolník';
    var uvod = '<span class="nadtitul">Skupinové akce v terénu</span><h1>Hra na míru</h1>';
    if (!relace) {
      el('obsah').innerHTML = horni() + uvod
        + '<p class="podtitul">Výprava nebo hra pro partu, firmu, školu či oslavu – s aplikací Okolník.</p>'
        + '<p>Naplánujte společnou výpravu nebo hru v terénu pro firmu, školu, oddíl i oslavu. Sami určíte, kdo koho uvidí na mapě '
        + 'a jestli se budou zaznamenávat trasy. Účastníci se připojí kódem v aplikaci Okolník, vy sledujete živou mapu '
        + 'a po skončení dostanete výsledky s mapou tras.</p>'
        + '<ul class="stitky akce-stitky"><li>Kdo koho vidí na mapě</li><li>Záznam tras</li><li>Týmy i jednotlivci</li><li>Kontrolní body</li><li>Výsledky a CSV</li></ul>'
        + '<p><a class="tlacitko" href="/ucet/">Přihlásit se</a></p>'
        + '<p class="drobne">Zakládání akcí je součást Okolník Premium (akce až pro 15 lidí). Po přihlášení na stránce Můj Okolník se sem vraťte.</p>'
        + formularKodu();
      napojFormularKodu();
      return;
    }
    el('obsah').innerHTML = horni() + uvod
      + '<p class="podtitul">Založte výpravu nebo hru, pošlete účastníkům kód a sledujte akci na živé mapě.</p>'
      + '<div id="zalozitBox" class="zalozit-box"><p class="drobne">Ověřuji předplatné…</p></div>'
      + '<h2>Moje akce</h2><div id="mojeAkce"><div class="stav"><div class="tocka"></div>Načítám vaše akce…</div></div>'
      + formularKodu('Máte kód cizí akce?');
    napojFormularKodu();
    api.hrac().then(function (h) { return !!(h && h.premium === true); }, function (e) { return { chyba: e }; }).then(function (p) {
      if (id !== pohled) return;
      var tl = '<a class="tlacitko" data-jdi href="' + esc(odkaz({ novy: true })) + '">+ Založit akci</a>';
      if (p === true) el('zalozitBox').innerHTML = tl;
      else if (p && p.chyba && p.chyba.kod === 'prihlaseni') {   // uložená relace už neplatí
        el('zalozitBox').innerHTML = '<div class="karta"><h3>Přihlášení vypršelo</h3><p>Přihlaste se prosím znovu stejným účtem jako v aplikaci – uvidíte své akce a budete moci zakládat nové.</p>'
          + '<p style="margin-top:10px"><a class="tlacitko male" href="/ucet/">Přihlásit se znovu</a></p></div>';
      }
      else if (p && p.chyba) el('zalozitBox').innerHTML = tl + '<p class="drobne">Předplatné se nepodařilo ověřit (' + esc(chybaText(p.chyba)) + '). Založení ověří server.</p>';
      else el('zalozitBox').innerHTML = premiumHtml();
    });
    nactiMojeAkce(id);
  }
  function nactiMojeAkce(id) {
    var box = el('mojeAkce');
    api.mojeAkce().then(function (seznam) {
      if (id !== pohled) return;
      if (!seznam.length) { box.innerHTML = '<p class="drobne">Zatím nemáte žádnou akci.</p>'; return; }
      seradAkce(seznam);
      box.innerHTML = '<ul class="seznam-akci">' + seznam.map(polozkaAkce).join('') + '</ul>';
      seznam.slice(0, 20).forEach(function (a) {
        api.pocet(a._id, 'ucastnici').then(function (n) {
          if (id !== pohled || n == null) return;
          box.querySelectorAll('[data-pocet]').forEach(function (s) {
            if (s.getAttribute('data-pocet') === a._id) s.textContent = ' · ' + n + ' ' + sklon(n, 'účastník', 'účastníci', 'účastníků');
          });
        }).catch(function () { /* počet je jen doplněk */ });
      });
    }).catch(function (e) {
      if (id !== pohled) return;
      if (e && e.kod === 'prihlaseni') { box.innerHTML = '<p class="drobne">Po přihlášení tu uvidíte své akce.</p>'; return; }
      box.innerHTML = '<p class="chyba">Akce se nepodařilo načíst: ' + esc(chybaText(e)) + '</p>'
        + '<p><button type="button" class="tlacitko male obrys" id="mojeZnovu">Zkusit znovu</button></p>';
      el('mojeZnovu').onclick = function () { box.innerHTML = '<div class="stav"><div class="tocka"></div>Načítám vaše akce…</div>'; nactiMojeAkce(id); };
    });
  }

  /* ================================================================ AKCE PODLE KÓDU: správa / pozvánka / výsledky */
  function detail(kod, o) {
    var id = pohled;
    sirka(false);
    nacitani('Načítám akci…');
    api.akce(kod).then(function (a) {
      if (id !== pohled) return;
      if (!a) { nenalezeno(kod); return; }
      document.title = a.nazev + ' – Hra na míru – Okolník';
      var org = jsemOrg(a);
      if (org && !o.nahled) { if (o.vysledky) vysledky(a); else sprava(a, o.zalozeno); return; }
      pozvanka(a, o.vysledky && !org);
    }).catch(function (e) {
      if (id !== pohled) return;
      chybaNacteni('Akci se nepodařilo načíst. ' + chybaText(e), function () { detail(kod, o); });
    });
  }

  /* ---------------------------------------------------------------- pozvánka (účastník, nepřihlášený, náhled) */
  function pozvanka(a, vysledkyOdmitnuty) {
    var id = pohled, st = stavAkce(a), org = jsemOrg(a);
    sirka(false);
    var h = horni();
    if (org) h += '<p class="nahled-pruh">Takhle akci vidí účastníci a lidé s odkazem. <a data-jdi href="' + esc(odkaz({ k: a._id })) + '">Zpět do správy akce</a></p>';
    if (vysledkyOdmitnuty) h += '<p class="hlaska">Výsledky akce zatím vidí jen organizátor.</p>';
    h += '<span class="nadtitul">Pozvánka na akci</span><h1>' + esc(a.nazev) + '</h1>'
      + '<p class="podtitul">' + esc(fmtRozsah(a.od, a.do)) + ' ' + stitekStavu(st) + '</p>';
    if (a.vzhled && a.vzhled.uvitani) h += '<div class="uvitani">' + esc(a.vzhled.uvitani) + '</div>';
    if (a.popis) h += '<p class="popis-akce">' + esc(a.popis) + '</p>';
    h += '<dl class="souhrn"><dt>Režim</dt><dd>' + esc(REZIMY[a.rezim] || a.rezim) + '</dd>'
      + '<dt>Týmy</dt><dd>' + tymyHtml(a) + '</dd>'
      + (a.sraz ? '<dt>Sraz</dt><dd>' + esc(a.sraz.n || 'Sraz') + ' · <a href="' + esc(mapyCz(a.sraz)) + '" target="_blank" rel="noopener">ukázat na Mapy.cz</a></dd>' : '')
      + '<dt>Účastníci</dt><dd>nejvýš ' + a.max + (a.schvalovani ? ' · účast schvaluje organizátor' : '') + '</dd></dl>';
    h += '<h2>Co se bude sdílet</h2><div class="souhlas-nahled">' + nahledSouhlasu(a, true) + '</div>'
      + '<p class="drobne">Tento text potvrdíte v aplikaci před připojením.</p>';
    if (st === 'konec') h += '<div class="stav"><h2>Akce skončila</h2><p>Připojit se už nejde.</p></div>';
    else {
      h += '<div class="karta pripojeni"><h2>Připojte se v aplikaci Okolník</h2>'
        + '<p>V aplikaci otevřete <strong>Více → Akce (hra na míru)</strong> a zadejte kód:</p><div class="kod-velky">' + esc(a._id) + '</div>'
        + '<p>Máte-li aplikaci v telefonu, stačí klepnout na odkaz, který vám organizátor poslal.</p>'
        + '<p><a class="tlacitko zelene" href="' + PLAY + '">Okolník na Google Play</a></p></div>';
    }
    if (a.sraz || a.pole) h += '<h2>Místo</h2>' + mapaHtml('pozvankaMapa', 'mala');
    el('obsah').innerHTML = h;
    if (!a.sraz && !a.pole) return;
    var kont = el('pozvankaMapa');
    vytvorMapu(kont, {}).then(function (m) {
      if (id !== pohled) { m.zrus(); return; }
      priUklidu(function () { m.zrus(); });
      m.pole(a.pole);
      m.znacky(a.sraz ? [znackaSrazu(a.sraz)] : []);
      m.prizpusob(bodyProPrizpusobeni(a));
    }).catch(function (e) { if (id === pohled) chybaMapy(kont, e); });
  }

  /* ---------------------------------------------------------------- správa (organizátor) */
  function hotovoHtml(a) {
    var url = ODKAZ_AKCE + a._id;
    return '<div class="karta hotovo-karta"><h2>✓ Akce je založená</h2><p>Kód akce:</p><div class="kod-velky">' + esc(a._id) + '</div>'
      + '<p class="odkaz-akce"><a href="' + esc(url) + '">' + esc(url) + '</a></p>'
      + '<p class="radek-flex"><button type="button" class="tlacitko" data-kopirovat>Kopírovat odkaz</button>'
      + '<button type="button" class="tlacitko obrys" data-sdilet hidden>Sdílet</button></p>'
      + '<p class="drobne">Účastníci si v aplikaci Okolník otevřou Více → Akce (hra na míru) a zadají kód, nebo klepnou na odkaz.</p></div>';
  }
  function kodKartaHtml(a) {
    var url = ODKAZ_AKCE + a._id;
    return '<div class="karta kod-karta"><div class="kod-radek"><span class="drobne">Kód akce</span><span class="kod-maly">' + esc(a._id) + '</span>'
      + '<input class="odkaz-pole" readonly value="' + esc(url) + '" aria-label="Odkaz na akci">'
      + '<button type="button" class="tlacitko male" data-kopirovat>Kopírovat odkaz</button>'
      + '<button type="button" class="tlacitko male obrys" data-sdilet hidden>Sdílet</button></div>'
      + '<p class="drobne">Účastníci si v aplikaci Okolník otevřou Více → Akce (hra na míru) a zadají kód, nebo klepnou na odkaz.</p></div>';
  }
  function sprava(a, zalozeno) {
    var id = pohled;
    sirka(true);
    Z = { akce: a, ucastnici: [], poloha: [], stopy: [], body: [], mapa: null, posledni: 0, posledniTrasy: 0, chyba: null,
      bezi: false, znovu: false, podpisHlavy: '', podpisTabulky: '', prizpusobeno: false, nacteno: false, barvyUc: {} };
    var h = horni();
    if (zalozeno) h += hotovoHtml(a);
    h += '<div class="jen-normalne"><span class="nadtitul">Správa akce</span><div id="spravaHlava"></div>'
      + (zalozeno ? '' : kodKartaHtml(a))
      + '<div class="ovladani" id="spravaOvladani"></div><p class="zprava" id="spravaZprava" role="status"></p></div>'
      + '<section class="ziva-plocha" aria-label="Živá mapa akce">'
      + '<div class="velka-hlava"><div class="vh-nazev"><strong id="vhNazev"></strong><span id="vhOdpocet"></span></div>'
      + '<div class="vh-kod">Kód <strong>' + esc(a._id) + '</strong> · okolnik.cz/akce</div>'
      + '<span class="drobne" id="vhAktualizace"></span>'
      + '<button type="button" class="tlacitko male obrys" id="vhZavrit">Zavřít velkou obrazovku</button></div>'
      + '<h2 class="jen-normalne">Živá mapa</h2>'
      + mapaHtml('zivaMapa', 'ziva', true)
      + '<div class="ziva-seznam" id="zivySeznam"></div>'
      + '<div class="mapa-pod jen-normalne"><span id="aktualizovano" class="drobne">Načítám data…</span>'
      + '<span><button type="button" class="odkaz-tl" id="obnovit">Obnovit</button><button type="button" class="odkaz-tl" id="zobrazitVse">Zobrazit vše</button></span>'
      + '<span id="legenda" class="legenda"></span></div></section>'
      + '<section class="jen-normalne sekce-ucastnici"><h2 id="ucastniciNadpis">Účastníci</h2><div id="ucastniciBox"><div class="stav"><div class="tocka"></div>Načítám účastníky…</div></div>'
      + '<div id="rozdelitBox"></div></section>';
    el('obsah').innerHTML = h;
    napojKopirovani(el('obsah'), a);
    el('obnovit').onclick = function () { obnov(true); };
    el('zobrazitVse').onclick = function () { if (Z && Z.mapa) Z.mapa.prizpusob(vsechnyBody()); };
    el('vhZavrit').onclick = function () { velkaObrazovka(false); };
    vykresliHlavickuSpravy();
    api.pod(a._id, 'body').then(function (b) { if (id !== pohled || !Z) return; Z.body = seradBody(b); vykresliZivouMapu(); }).catch(function () { /* body jsou doplněk */ });
    var kont = el('zivaMapa');
    vytvorMapu(kont, {}).then(function (m) {
      if (id !== pohled || !Z) { m.zrus(); return; }
      Z.mapa = m;
      priUklidu(function () { m.zrus(); });
      vykresliZivouMapu();
      if (Z.nacteno && !Z.prizpusobeno) Z.prizpusobeno = m.prizpusob(vsechnyBody());
    }).catch(function (e) { if (id === pohled) chybaMapy(kont, e); });
    obnov(true);
    var interval = setInterval(tik, 1000);
    var priViditelnosti = function () { if (document.visibilityState === 'visible' && Z && !Z.bezi && Date.now() - Z.posledni >= OBNOVA) obnov(false); };
    var klavesy = function (e) { if (e.key === 'Escape' && document.body.classList.contains('velka') && !document.querySelector('.dialog-zaves')) velkaObrazovka(false); };
    document.addEventListener('visibilitychange', priViditelnosti);
    document.addEventListener('keydown', klavesy);
    priUklidu(function () { clearInterval(interval); document.removeEventListener('visibilitychange', priViditelnosti); document.removeEventListener('keydown', klavesy); });
  }
  function obnov(vse) {
    if (!Z) return;
    if (Z.bezi) { if (vse) Z.znovu = true; return; }
    var id = pohled, a = Z.akce;
    Z.bezi = true;
    var trasy = a.stopy !== 'ne' && (vse || Date.now() - Z.posledniTrasy >= OBNOVA_TRAS);
    Promise.all([
      api.akce(a._id),
      api.pod(a._id, 'ucastnici'),
      orgCtePolohu(a) ? api.pod(a._id, 'poloha') : Promise.resolve([]),   // jinak by dotaz pravidla odmítla
      trasy ? api.pod(a._id, 'stopy') : Promise.resolve(null),
    ]).then(function (v) {
      if (id !== pohled || !Z) return;
      if (!v[0]) { hlaska = { text: 'Akce „' + a.nazev + '“ už neexistuje.', chyba: true }; jdi(odkaz({}), true); return; }
      Z.akce = v[0]; Z.ucastnici = v[1]; Z.poloha = orgCtePolohu(v[0]) ? v[2] : [];
      if (v[0].stopy === 'ne') Z.stopy = [];
      else if (v[3]) { Z.stopy = v[3]; Z.posledniTrasy = Date.now(); }
      Z.chyba = null; Z.nacteno = true;
      vykresliSpravuData(false);
    }).catch(function (e) {
      if (id !== pohled || !Z) return;
      Z.chyba = chybaText(e);
      if (!Z.nacteno) el('ucastniciBox').innerHTML = '<p class="chyba">Účastníky se nepodařilo načíst: ' + esc(Z.chyba) + '</p>';
    }).then(function () {
      if (id !== pohled || !Z) return;
      Z.bezi = false; Z.posledni = Date.now();
      if (Z.znovu) { Z.znovu = false; obnov(true); }
      tik();
    });
  }
  function tik() {
    if (!Z) return;
    var t;
    if (!Z.posledni) t = 'Načítám data…';
    else {
      var s = Math.round((Date.now() - Z.posledni) / 1000);
      t = (Z.chyba ? 'Obnova selhala (' + Z.chyba + ') Zkusím to znovu. ' : '')
        + 'Aktualizováno ' + (s < 60 ? 'před ' + s + NBSP + 's' : predChvili(s * 1000))
        + (document.visibilityState === 'visible' ? '' : ' · obnova čeká, až se na stránku vrátíte');
    }
    if (el('aktualizovano')) el('aktualizovano').textContent = t;
    if (el('vhAktualizace')) el('vhAktualizace').textContent = t;
    if (el('vhOdpocet')) el('vhOdpocet').textContent = odpocet(Z.akce);
    obnovCasy();
    if (document.visibilityState === 'visible' && !Z.bezi && Z.posledni && Date.now() - Z.posledni >= OBNOVA) obnov(false);
  }
  function odpocet(a) {
    var st = stavAkce(a), t = ted();
    if (st === 'priprava') return 'Začíná za ' + trvani(a.od - t);
    if (st === 'bezi') return 'Do konce zbývá ' + trvani(a.do - t);
    return 'Akce skončila';
  }
  function obnovCasy() {
    var t = ted();
    document.querySelectorAll('[data-kdy]').forEach(function (x) {
      var kdy = +x.getAttribute('data-kdy'), txt = predChvili(t - kdy) + (x.getAttribute('data-pres') || '');
      if (x.textContent !== txt) x.textContent = txt;
      x.classList.toggle('zastarale', t - kdy > STARA_POLOHA);
    });
  }
  function zpravaSpravy(textik, jeChyba) { zpravaEl('spravaZprava', textik, jeChyba ? 'chyba' : 'ok'); }
  function smazaniText(a) {
    if (a.poloha === 'nikdo' && a.stopy === 'ne') return '';
    if (a.uchovatDni === 0) return ' Poloha a trasy se ze serveru smažou hned po skončení.';
    var den = fmtDen(new Date(+a.do + a.uchovatDni * DEN));
    return ' Poloha a trasy se ze serveru smažou ' + den + (/\.$/.test(den) ? '' : '.');   // „26. 10.“ už tečku má
  }
  function vykresliHlavickuSpravy() {
    var a = Z.akce, st = stavAkce(a);
    var podpis = [a.nazev, +a.od, +a.do, st, a.rezim, a.stav].join('|');
    if (podpis === Z.podpisHlavy) return;
    Z.podpisHlavy = podpis;
    document.title = a.nazev + ' – správa akce – Okolník';
    el('vhNazev').textContent = a.nazev;
    var pozn = st === 'priprava' ? 'Akce začne sama ' + fmtCas(a.od) + '. Účastníci se mohou připojit už teď.'
      : st === 'bezi' ? 'Akce běží, skončí ' + fmtCas(a.do) + '.'
        : 'Akce skončila ' + fmtCas(a.do) + '.' + smazaniText(a);
    el('spravaHlava').innerHTML = '<h1>' + esc(a.nazev) + '</h1><p class="podtitul">' + esc(fmtRozsah(a.od, a.do)) + ' · '
      + esc(REZIMY[a.rezim] || a.rezim) + ' ' + stitekStavu(st) + '</p><p class="drobne">' + esc(pozn) + '</p>';
    var b = [];
    if (st === 'priprava') b.push('<button type="button" class="tlacitko zelene" id="btnSpustit">Spustit teď</button>');
    if (st === 'bezi') b.push('<button type="button" class="tlacitko" id="btnUkoncit">Ukončit akci</button>');
    b.push('<button type="button" class="tlacitko obrys" id="btnVelka">Velká obrazovka</button>');
    b.push('<a class="tlacitko obrys" data-jdi href="' + esc(odkaz({ k: a._id, vysledky: true })) + '">' + (st === 'konec' ? 'Výsledky' : 'Průběžné výsledky') + '</a>');
    b.push('<a class="tlacitko obrys" data-jdi href="' + esc(odkaz({ k: a._id, upravit: true })) + '">Upravit nastavení</a>');
    b.push('<a class="tlacitko obrys" data-jdi href="' + esc(odkaz({ k: a._id, nahled: true })) + '">Pozvánka (náhled)</a>');
    if (st !== 'bezi') b.push('<button type="button" class="tlacitko nebezpeci" id="btnSmazat">Smazat akci</button>');
    el('spravaOvladani').innerHTML = b.join('');
    if (el('btnSpustit')) el('btnSpustit').onclick = spustitTed;
    if (el('btnUkoncit')) el('btnUkoncit').onclick = ukoncit;
    if (el('btnSmazat')) el('btnSmazat').onclick = smazatAkci;
    el('btnVelka').onclick = function () { velkaObrazovka(true); };
  }
  function vykresliSpravuData(vynutit) {
    if (!Z) return;
    vykresliHlavickuSpravy();
    vykresliUcastniky(vynutit);
    vykresliZivySeznam();
    vykresliZivouMapu();
    vykresliLegendu();
    if (Z.mapa && Z.nacteno && !Z.prizpusobeno) Z.prizpusobeno = Z.mapa.prizpusob(vsechnyBody());
  }
  function spustitTed() {
    var a = Z.akce, t = new Date(ted()), zmeny = { stav: S('bezi') }, maska = ['stav'], od = a.od, posunOd = +a.od > +t, novyDo = null;
    if (posunOd) { od = t; zmeny.od = T(t); maska.push('od'); }
    if (+a.do - +od > MAX_DNU * DEN) { novyDo = new Date(+od + MAX_DNU * DEN); zmeny.do = T(novyDo); maska.push('do'); }
    potvrd({ nadpis: 'Spustit akci teď?', ano: 'Spustit',
      text: 'Akce začne hned' + (posunOd ? ' a začátek se posune na teď (' + fmtCas(t) + ')' : '') + '. Účastníci pak mohou v aplikaci sdílet podle nastavení akce.'
        + (novyDo ? ' Konec se posune na ' + fmtCas(novyDo) + ', protože akce může trvat nejvýš 14 dní.' : '') }).then(function (ano) {
      if (!ano || !Z) return;
      zpravaSpravy('Spouštím akci…');
      api.uprav(a._id, zmeny, maska).then(function () {
        if (!Z) return;
        Z.akce.stav = 'bezi'; if (posunOd) Z.akce.od = t; if (novyDo) Z.akce.do = novyDo;
        zpravaSpravy('Akce běží.');
        vykresliSpravuData(true); obnov(true);
      }).catch(function (e) { zpravaSpravy('Akci se nepodařilo spustit: ' + chybaText(e), true); });
    });
  }
  function ukoncit() {
    var a = Z.akce;
    potvrd({ nadpis: 'Ukončit akci?', ano: 'Ukončit akci', nebezpecne: true,
      text: 'Akce „' + a.nazev + '“ skončí hned teď. Sdílení polohy se zastaví a nikdo další se už nepřipojí. Výsledky zůstanou k dispozici.' }).then(function (ano) {
      if (!ano || !Z) return;
      // v21: po startu je začátek pevný → posouvá se jen konec (dřív); do > od drží zaokrouhlení
      // nahoru na celé sekundy (časy se ukládají po sekundách)
      var t = new Date(Math.ceil(Math.max(ted(), +a.od + 1000) / 1000) * 1000);
      if (platneDatum(a.do) && +t > +a.do) t = new Date(+a.do);   // konec nikdy později než dosud
      var zmeny = { stav: S('konec'), do: T(t) }, maska = ['stav', 'do'];
      zpravaSpravy('Ukončuji akci…');
      api.uprav(a._id, zmeny, maska).then(function () {
        if (!Z) return;
        Z.akce.stav = 'konec'; Z.akce.do = t;
        zpravaSpravy('Akce skončila. Výsledky najdete pod tlačítkem Výsledky.');
        vykresliSpravuData(true); obnov(true);
      }).catch(function (e) { zpravaSpravy('Akci se nepodařilo ukončit: ' + chybaText(e), true); });
    });
  }
  function smazatAkci() {
    var a = Z.akce;
    potvrd({ nadpis: 'Smazat akci?', ano: 'Smazat akci', nebezpecne: true,
      text: 'Akce „' + a.nazev + '“ se smaže i s účastníky, polohami, trasami a kontrolními body. Tohle nejde vrátit.' }).then(function (ano) {
      if (!ano || !Z) return;
      var id = pohled;
      zpravaSpravy('Mažu akci…');
      document.querySelectorAll('#spravaOvladani button, #spravaOvladani a').forEach(function (x) { x.setAttribute('aria-disabled', 'true'); x.style.pointerEvents = 'none'; });
      smazAkciUplne(Z.akce).then(function () {
        hlaska = { text: 'Akce „' + a.nazev + '“ je smazaná.' };
        jdi(odkaz({}), true);
      }).catch(function (e) {
        if (id !== pohled) return;
        zpravaSpravy('Smazání se nepovedlo: ' + chybaText(e), true);
        document.querySelectorAll('#spravaOvladani button, #spravaOvladani a').forEach(function (x) { x.removeAttribute('aria-disabled'); x.style.pointerEvents = ''; });
      });
    });
  }
  /* Pravidla: akci smí smazat jen ve stavu priprava/konec; podkolekce se mažou dřív (pak by je nešlo
     vypsat). Polohy se nevypisují (organizátor je smí číst jen za určitých podmínek) – mažou se podle
     uid účastníků; trasy jde vypsat jen při stopy != 'ne'. Časová osa a souhrn (udalosti, stav) zapisuje
     a uklízí server. */
  function smazAkciUplne(a) {
    var aid = a._id;
    var krok1 = a.stav === 'bezi' ? api.uprav(aid, { stav: S('konec') }, ['stav']) : Promise.resolve();
    return krok1.then(function () {
      return Promise.all([api.pod(aid, 'ucastnici'), api.pod(aid, 'body'), a.stopy !== 'ne' ? api.pod(aid, 'stopy') : Promise.resolve([])]);
    }).then(function (v) {
      var cesty = [];
      v[0].forEach(function (u) { cesty.push('akce/' + aid + '/poloha/' + u._id); });
      v[2].forEach(function (d) { cesty.push(d._cesta); });
      v[0].forEach(function (d) { cesty.push(d._cesta); });
      v[1].forEach(function (d) { cesty.push(d._cesta); });
      return poSkupinach(cesty, 6, function (c) { return api.smaz(c); });
    }).then(function () { return api.smaz('akce/' + aid); });
  }
  function velkaObrazovka(zapnout) {
    document.body.classList.toggle('velka', zapnout);
    if (zapnout) window.scrollTo(0, 0);
    vykresliZivySeznam(); tik();
    setTimeout(function () {
      if (!Z || !Z.mapa) return;
      Z.mapa.mapa.resize();
      Z.mapa.prizpusob(vsechnyBody());
    }, 80);
    if (!zapnout && el('btnVelka')) el('btnVelka').focus();
  }
  function serazeniUcastnici(uc, a) {
    var poradi = {}; a.tymy.forEach(function (t, i) { poradi[t.k] = i; });
    var vaha = { ceka: 0, ok: 1, zamitnut: 2 };
    return uc.slice().sort(function (x, y) {
      var sx = vaha[stavUc(x)], sy = vaha[stavUc(y)];
      if (sx !== sy) return sx - sy;
      var tx = poradi[x.tym] != null ? poradi[x.tym] : 99, ty = poradi[y.tym] != null ? poradi[y.tym] : 99;
      return tx - ty || String(x.prezdivka || '').localeCompare(String(y.prezdivka || ''), 'cs');
    });
  }
  function najdiUcastnika(uid) { return Z ? najdi(Z.ucastnici, function (u) { return u._id === uid; }) : null; }
  function barvaUcastnika(u) {
    var a = Z.akce;
    if (a.tymy.length) { var t = tymPodleKlice(a, u.tym); return t ? t.b : BARVA_BEZ_TYMU; }
    return BARVA_AKCENT;
  }
  function barvaTrasy(uid) {   // týmy: barva týmu; jednotlivci: každý svou barvou
    var a = Z.akce;
    if (a.tymy.length) { var u = najdiUcastnika(uid), t = u && tymPodleKlice(a, u.tym); return t ? t.b : BARVA_BEZ_TYMU; }
    if (!Z.barvyUc[uid]) Z.barvyUc[uid] = BARVY_UCASTNIKU[Object.keys(Z.barvyUc).length % BARVY_UCASTNIKU.length];
    return Z.barvyUc[uid];
  }
  function delkyPodleUid(stopy) {
    var m = {};
    (stopy || []).forEach(function (s) { var d = jeCislo(s.delka) && s.delka > 0 ? s.delka : delkaCary(sourStopy(s)); m[s.u] = (m[s.u] || 0) + d; });
    return m;
  }
  function vyberTymu(u, a) {
    var h = '<select data-tym="' + esc(u._id) + '" aria-label="Tým účastníka ' + esc(u.prezdivka) + '">'
      + '<option value=""' + (tymPodleKlice(a, u.tym) ? '' : ' selected') + '>— bez týmu —</option>';
    a.tymy.forEach(function (t) { h += '<option value="' + esc(t.k) + '"' + (t.k === u.tym ? ' selected' : '') + '>' + esc(t.n) + '</option>'; });
    return h + '</select>';
  }
  function vykresliUcastniky(vynutit) {
    var box = el('ucastniciBox'); if (!box || !Z) return;
    var a = Z.akce, uc = serazeniUcastnici(Z.ucastnici, a), polohy = podleId(Z.poloha), delky = delkyPodleUid(Z.stopy);
    var sTymy = a.tymy.length > 0, ctePolohu = orgCtePolohu(a), sTrasou = a.stopy !== 'ne';
    // v21: vypínač účastníka (sdiliPolohu) platí pro polohu I trasu – sloupec podle toho, co akce sdílí
    var sPolohou = a.poloha !== 'nikdo' || sTrasou;
    var coSdili = a.poloha !== 'nikdo' && sTrasou ? 'polohu a trasu' : a.poloha !== 'nikdo' ? 'polohu' : 'trasu';
    var cekaji = uc.filter(function (u) { return stavUc(u) === 'ceka'; }).length;
    el('ucastniciNadpis').textContent = 'Účastníci (' + aktivniUcastnici(uc).length + ' z ' + a.max + ')';
    var podpis = JSON.stringify([a.tymy, a.poloha, a.polohaPovinna, a.stopy, ctePolohu, uc.map(function (u) {
      var p = polohy[u._id];
      return [u._id, u.prezdivka, u.tym, u.role, u.stav, u.sdiliPolohu, p ? +p.kdy : 0, p ? p.presnost : 0, Math.round(delky[u._id] || 0)];
    })]);
    if (!vynutit && podpis === Z.podpisTabulky) return;
    var fokus = document.activeElement;
    if (!vynutit && fokus && box.contains(fokus) && fokus.tagName === 'SELECT') return;   // nepřekreslovat pod rukama
    Z.podpisTabulky = podpis;
    if (!uc.length) { box.innerHTML = '<p class="drobne">Zatím se nikdo nepřipojil. Pošlete účastníkům kód nebo odkaz.</p>'; vykresliRozdeleni(uc); return; }
    var h = '';
    if (cekaji) {
      h += '<p class="upozorneni">Na schválení ' + (cekaji === 1 ? 'čeká 1 účastník' : cekaji <= 4 ? 'čekají ' + cekaji + ' účastníci' : 'čeká ' + cekaji + ' účastníků')
        + (cekaji === 1 ? '. Schvalte ho, nebo ho zamítněte.</p>' : '. Schvalte je, nebo je zamítněte.</p>');
    }
    h += '<div class="tabulka-obal"><table class="tabulka"><thead><tr><th>Přezdívka</th><th>Stav</th>' + (sTymy ? '<th>Tým</th>' : '')
      + (sPolohou ? '<th>Sdílí ' + coSdili + '</th>' : '') + (ctePolohu ? '<th>Poslední poloha</th>' : '') + (sTrasou ? '<th class="cislo">Trasa</th>' : '')
      + '<th>Připojen</th><th><span class="sr">Akce</span></th></tr></thead><tbody>';
    uc.forEach(function (u) {
      var st = stavUc(u), p = polohy[u._id];
      var nesdili = sPolohou && a.polohaPovinna && u.sdiliPolohu === false && st !== 'zamitnut';
      h += '<tr class="' + (nesdili ? 'nesdili' : '') + (st === 'zamitnut' ? ' zamitnuty' : '') + '">'
        + '<td class="jmeno"><span class="tecka" style="background:' + barvaUcastnika(u) + '"></span>' + esc(u.prezdivka || 'Účastník')
        + (u.role === 'kapitan' ? '<span class="mini-stitek">kapitán</span>' : '') + '</td>'
        + '<td><span class="stav-uc ' + st + '">' + STAV_UC[st] + '</span></td>';
      if (sTymy) h += '<td>' + vyberTymu(u, a) + '</td>';
      if (sPolohou) {
        // zvýrazněný řádek nese jen krátké „Nesdílí“ – žádná pravidla ani výhrůžky (rozhoduje organizátor)
        h += '<td>' + (nesdili ? '<span class="ne">Nesdílí</span>'
          : u.sdiliPolohu === true ? '<span class="ano">ano</span>' : u.sdiliPolohu === false ? '<span class="ne">ne</span>' : '<span class="drobne">–</span>') + '</td>';
      }
      if (ctePolohu) {
        h += '<td>' + (p && platneDatum(p.kdy) ? '<span data-kdy="' + (+p.kdy) + '" data-pres="' + (jeCislo(p.presnost) ? ' · ±' + Math.round(p.presnost) + NBSP + 'm' : '') + '"></span>'
          : '<span class="drobne">zatím žádná</span>') + '</td>';
      }
      if (sTrasou) h += '<td class="cislo">' + (delky[u._id] ? '<span class="cara" style="background:' + barvaTrasy(u._id) + '"></span>' + km(delky[u._id]) : '–') + '</td>';
      h += '<td>' + esc(fmtCas(u.pripojen)) + '</td><td><span class="akce-uc">'
        + (st !== 'ok' ? '<button type="button" class="tlacitko mini zelene" data-schvalit="' + esc(u._id) + '">Schválit</button>' : '')
        + (st !== 'zamitnut' ? '<button type="button" class="tlacitko mini nebezpeci" data-zamitnout="' + esc(u._id) + '">Zamítnout</button>' : '')
        + '<button type="button" class="tlacitko mini obrys" data-odebrat="' + esc(u._id) + '">Odebrat</button></span></td></tr>';
    });
    box.innerHTML = h + '</tbody></table></div>';
    obnovCasy();
    box.querySelectorAll('select[data-tym]').forEach(function (sel) { sel.onchange = function () { zmenTym(sel); }; });
    box.querySelectorAll('[data-schvalit]').forEach(function (b) { b.onclick = function () { zmenStav(b.getAttribute('data-schvalit'), 'ok'); }; });
    box.querySelectorAll('[data-zamitnout]').forEach(function (b) { b.onclick = function () { zmenStav(b.getAttribute('data-zamitnout'), 'zamitnut'); }; });
    box.querySelectorAll('[data-odebrat]').forEach(function (b) { b.onclick = function () { odebratUcastnika(b.getAttribute('data-odebrat')); }; });
    vykresliRozdeleni(uc);
  }
  function zmenTym(sel) {
    var uid = sel.getAttribute('data-tym'), u = najdiUcastnika(uid);
    if (!u) return;
    var pred = u.tym, novy = sel.value;
    sel.disabled = true;
    api.upravUcastnika(Z.akce._id, uid, { tym: novy }).then(function () {
      if (!Z) return;
      u.tym = novy;
      var t = tymPodleKlice(Z.akce, novy);
      zpravaSpravy('„' + u.prezdivka + '“ je ' + (t ? 'v týmu ' + t.n : 'bez týmu') + '.');
      vykresliSpravuData(true);
    }).catch(function (e) {
      sel.value = pred || '';
      zpravaSpravy('Tým se nepodařilo změnit: ' + chybaText(e), true);
    }).then(function () { sel.disabled = false; });
  }
  function zmenStav(uid, stav) {
    var u = najdiUcastnika(uid);
    if (!u) return;
    var pred = u.stav;
    u.stav = stav; vykresliSpravuData(true);   // hned, ať organizátor vidí odezvu
    api.upravUcastnika(Z.akce._id, uid, { stav: stav }).then(function () {
      zpravaSpravy((stav === 'ok' ? 'Schváleno: „' : 'Zamítnuto: „') + u.prezdivka + '“.');
    }).catch(function (e) {
      u.stav = pred;
      if (Z) vykresliSpravuData(true);
      zpravaSpravy('Stav se nepodařilo změnit: ' + chybaText(e), true);
    });
  }
  function odebratUcastnika(uid) {
    var u = najdiUcastnika(uid);
    if (!u) return;
    var a = Z.akce;
    potvrd({ nadpis: 'Odebrat účastníka?', ano: 'Odebrat', nebezpecne: true,
      text: '„' + u.prezdivka + '“ zmizí z akce i z mapy a smaže se jeho poloha a trasy z této akce. Dokud akce neskončí, může se připojit znovu – '
        + 'když nechcete, aby se vrátil, použijte raději Zamítnout.' }).then(function (ano) {
      if (!ano || !Z) return;
      zpravaSpravy('Odebírám…');
      api.smaz('akce/' + a._id + '/ucastnici/' + uid).then(function () {
        return Promise.all([
          api.smaz('akce/' + a._id + '/poloha/' + uid),
          a.stopy !== 'ne' ? api.pod(a._id, 'stopy', rovno('u', uid)).then(function (s) { return poSkupinach(s.map(function (x) { return x._cesta; }), 5, api.smaz); }) : null,
        ]);
      }).then(function () {
        if (!Z) return;
        Z.ucastnici = Z.ucastnici.filter(function (x) { return x._id !== uid; });
        Z.poloha = Z.poloha.filter(function (x) { return x._id !== uid; });
        Z.stopy = Z.stopy.filter(function (x) { return x.u !== uid; });
        zpravaSpravy('„' + u.prezdivka + '“ je odebraný z akce.');
        vykresliSpravuData(true); obnov(true);
      }).catch(function (e) { zpravaSpravy('Odebrání se nepovedlo celé: ' + chybaText(e), true); obnov(true); });
    });
  }
  function vykresliRozdeleni(uc) {
    var box = el('rozdelitBox'); if (!box) return;
    var a = Z.akce;
    if (!a.tymy.length) { box.innerHTML = ''; return; }
    var bez = aktivniUcastnici(uc).filter(function (u) { return !tymPodleKlice(a, u.tym); });
    var h = a.tymyVyber === 'organizator' ? '<p class="drobne">Hráči se připojují bez týmu – rozdělte je výběrem v tabulce, nebo náhodně.</p>' : '';
    if (bez.length) h += '<p><button type="button" class="tlacitko male obrys" id="rozdelit">Rozdělit náhodně do týmů (' + bez.length + ' bez týmu)</button></p>';
    box.innerHTML = h;
    if (el('rozdelit')) el('rozdelit').onclick = rozdelitNahodne;
  }
  function rozdelitNahodne() {
    var a = Z.akce, pocty = {};
    a.tymy.forEach(function (t) { pocty[t.k] = 0; });
    var aktivni = aktivniUcastnici(Z.ucastnici);
    aktivni.forEach(function (u) { if (pocty[u.tym] != null) pocty[u.tym]++; });
    var bez = aktivni.filter(function (u) { return pocty[u.tym] == null; });
    for (var i = bez.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), x = bez[i]; bez[i] = bez[j]; bez[j] = x; }
    var zmeny = bez.map(function (u) {
      var min = Math.min.apply(null, a.tymy.map(function (t) { return pocty[t.k]; }));
      var kandidati = a.tymy.filter(function (t) { return pocty[t.k] === min; });
      var t = kandidati[Math.floor(Math.random() * kandidati.length)];
      pocty[t.k]++;
      return { u: u, tym: t.k };
    });
    if (!zmeny.length) return;
    potvrd({ nadpis: 'Rozdělit do týmů?', ano: 'Rozdělit',
      text: 'Účastníkům bez týmu (' + zmeny.length + ') se náhodně přidělí tým tak, aby byly týmy co nejvyrovnanější.' }).then(function (ano) {
      if (!ano || !Z) return;
      zpravaSpravy('Rozděluji…');
      poSkupinach(zmeny, 4, function (z) { return api.upravUcastnika(a._id, z.u._id, { tym: z.tym }).then(function () { z.u.tym = z.tym; }); }).then(function () {
        zpravaSpravy('Hotovo – účastníci jsou rozdělení do týmů.');
      }).catch(function (e) { zpravaSpravy('Rozdělení se nepovedlo celé: ' + chybaText(e), true); })
        .then(function () { if (Z) { vykresliSpravuData(true); obnov(true); } });
    });
  }
  function vykresliZivySeznam() {
    var box = el('zivySeznam'); if (!box || !Z) return;
    var a = Z.akce, uc = serazeniUcastnici(Z.ucastnici, a), ok = uc.filter(function (u) { return stavUc(u) === 'ok'; });
    var polohy = podleId(Z.poloha), ctePolohu = orgCtePolohu(a);
    var skupiny = a.tymy.length ? a.tymy.map(function (t) { return { t: t, lidi: ok.filter(function (u) { return u.tym === t.k; }) }; }) : [{ t: null, lidi: ok }];
    if (a.tymy.length) {
      var bez = ok.filter(function (u) { return !tymPodleKlice(a, u.tym); });
      if (bez.length) skupiny.push({ t: { n: 'Bez týmu', b: BARVA_BEZ_TYMU }, lidi: bez });
    }
    var h = '<h2>Účastníci</h2>';
    if (!ok.length) h += '<p class="drobne">Zatím tu nikdo není.</p>';
    else skupiny.forEach(function (s) {
      if (s.t) h += '<h3><span class="vzorek" style="background:' + barvaOk(s.t.b) + '"></span>' + esc(s.t.n) + NBSP + '<span class="drobne">(' + s.lidi.length + ')</span></h3>';
      h += '<ul>' + s.lidi.map(function (u) {
        var p = polohy[u._id];
        return '<li><span class="tecka" style="background:' + barvaUcastnika(u) + '"></span><span class="jm">' + esc(u.prezdivka) + '</span>'
          + (ctePolohu ? (p && platneDatum(p.kdy) ? '<span class="kdy" data-kdy="' + (+p.kdy) + '"></span>' : '<span class="kdy">bez polohy</span>') : '') + '</li>';
      }).join('') + '</ul>';
    });
    var cekaji = uc.length - ok.length - uc.filter(function (u) { return stavUc(u) === 'zamitnut'; }).length;
    if (cekaji) h += '<p class="drobne">Na schválení čeká: ' + cekaji + '</p>';
    box.innerHTML = h;
    obnovCasy();
  }
  function vsechnyBody() {
    if (!Z) return [];
    var ok = podleId(Z.ucastnici.filter(function (u) { return stavUc(u) === 'ok'; }));
    return bodyProPrizpusobeni(Z.akce, Z.body, Z.poloha.filter(function (p) { return ok[p._id]; }),
      Z.akce.stopy === 'ne' ? [] : Z.stopy.filter(function (s) { return ok[s.u]; }));
  }
  function vykresliZivouMapu() {
    if (!Z) return;
    var a = Z.akce, t = ted();
    var pozn = el('zivaMapaPozn');
    if (pozn) {
      pozn.textContent = !orgVidiPolohu(a) ? 'Podle pravidel akce polohu účastníků nevidíte.'
        : !orgCtePolohu(a) ? 'Akce skončila – poloha účastníků už není vidět.' : '';
    }
    if (!Z.mapa) return;
    var m = Z.mapa, uc = podleId(Z.ucastnici), z = [];
    m.pole(a.pole);
    if (a.sraz) z.push(znackaSrazu(a.sraz));
    if (a.rezim === 'body' || Z.body.length) Z.body.forEach(function (b, i) { z.push(znackaBodu(b, i)); });
    Z.poloha.forEach(function (p) {
      var u = uc[p._id];
      if (!u || stavUc(u) !== 'ok' || !jeCislo(p.lat) || !jeCislo(p.lon)) return;   // zamítnutí a čekající na mapu nepatří
      var stara = !platneDatum(p.kdy) || t - p.kdy > STARA_POLOHA, barva = barvaUcastnika(u);
      z.push({ klic: 'h:' + p._id, lat: p.lat, lon: p.lon, verze: [barva, u.prezdivka, stara].join('|'), vrch: true,
        prvek: function () { return prvekHrace(u.prezdivka, barva, stara); },
        titulek: u.prezdivka + (platneDatum(p.kdy) ? ' · ' + predChvili(t - p.kdy) : '') + (jeCislo(p.presnost) ? ' · ±' + Math.round(p.presnost) + ' m' : '') });
    });
    m.znacky(z);
    m.stopy(a.stopy === 'ne' ? [] : prvkyStop(Z.stopy.filter(function (s) { var u = uc[s.u]; return u && stavUc(u) === 'ok'; }), function (s) { return barvaTrasy(s.u); }));
  }
  function vykresliLegendu() {
    var box = el('legenda'); if (!box || !Z) return;
    var a = Z.akce, casti = [];
    a.tymy.forEach(function (t) { casti.push('<span><span class="tecka" style="background:' + barvaOk(t.b) + '"></span>' + esc(t.n) + '</span>'); });
    if (orgCtePolohu(a)) casti.push('<span>vybledlá tečka = poloha starší než 5 min</span>');
    if (a.stopy !== 'ne') casti.push('<span>čáry = trasy</span>');
    if (a.pole) casti.push('<span>čárkovaně = hrací pole</span>');
    box.innerHTML = casti.join('');
  }

  /* ---------------------------------------------------------------- výsledky (organizátor) */
  function spocitejVysledky(a, uc, stopy) {
    var mapa = {};
    uc.forEach(function (u) { mapa[u._id] = { uid: u._id, prezdivka: u.prezdivka || 'Účastník', tym: u.tym || '', stav: stavUc(u), delka: 0, od: null, do: null, kusy: 0 }; });
    stopy.forEach(function (s) {
      var uid = s.u || String(s._id).replace(/_\d+$/, '');
      var r = mapa[uid] || (mapa[uid] = { uid: uid, prezdivka: 'Odebraný účastník (' + uid.slice(0, 4) + ')', tym: s.tym || '', stav: 'odebrany', delka: 0, od: null, do: null, kusy: 0 });
      r.delka += jeCislo(s.delka) && s.delka > 0 ? s.delka : delkaCary(sourStopy(s));
      r.kusy++;
      if (platneDatum(s.od) && (!r.od || s.od < r.od)) r.od = s.od;
      if (platneDatum(s.do) && (!r.do || s.do > r.do)) r.do = s.do;
    });
    var radky = Object.keys(mapa).map(function (k) { return mapa[k]; });
    radky.slice().sort(function (x, y) { return x.prezdivka.localeCompare(y.prezdivka, 'cs'); })
      .forEach(function (r, i) { r.barva = BARVY_UCASTNIKU[i % BARVY_UCASTNIKU.length]; });   // barvy stabilně podle abecedy
    radky.forEach(function (r) {
      var t = tymPodleKlice(a, r.tym);
      r.tymNazev = t ? t.n : (a.tymy.length ? 'bez týmu' : '');
      r.barvaTymu = t ? t.b : BARVA_BEZ_TYMU;
    });
    return radky.sort(function (x, y) { return y.delka - x.delka || x.prezdivka.localeCompare(y.prezdivka, 'cs'); });
  }
  function csvVysledku(a, radky) {
    function bunka(v) {
      v = String(v == null ? '' : v);
      if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;   // tabulkový procesor by to bral jako vzorec
      return /[;"\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }
    var r = [['Účastník', 'Tým', 'km', 'Začátek trasy', 'Konec trasy', 'Kousků trasy']];
    radky.forEach(function (x) {
      r.push([x.prezdivka + (x.stav === 'zamitnut' ? ' (zamítnut)' : ''), x.tymNazev, (x.delka / 1000).toFixed(2).replace('.', ','), fmtCsvCas(x.od), fmtCsvCas(x.do), x.kusy]);
    });
    return '\ufeff' + r.map(function (radek) { return radek.map(bunka).join(';'); }).join('\r\n') + '\r\n';
  }
  function vysledky(a) {
    var id = pohled, st = stavAkce(a);
    sirka(true);
    document.title = 'Výsledky – ' + a.nazev + ' – Okolník';
    var h = horni() + '<p class="zpet"><a data-jdi href="' + esc(odkaz({ k: a._id })) + '">← Zpět na správu akce</a></p>'
      + '<span class="nadtitul">Výsledky akce</span><h1>' + esc(a.nazev) + '</h1>'
      + '<p class="podtitul">' + esc(fmtRozsah(a.od, a.do)) + ' ' + stitekStavu(st) + '</p>';
    if (st !== 'konec') h += '<p class="hlaska">Akce ještě neskončila – výsledky jsou průběžné.</p>';
    if (a.stopy === 'ne') h += '<p class="drobne">Záznam tras byl u této akce vypnutý, proto tu nejsou žádné trasy ani kilometry.</p>';
    h += '<div id="vysledkyObsah"><div class="stav"><div class="tocka"></div>Načítám trasy…</div></div>';
    el('obsah').innerHTML = h;
    Promise.all([
      api.pod(a._id, 'ucastnici'),
      a.stopy !== 'ne' ? api.pod(a._id, 'stopy') : Promise.resolve([]),
      api.pod(a._id, 'body').catch(function () { return []; }),
    ]).then(function (v) {
      if (id !== pohled) return;
      vykresliVysledky(a, v[0], v[1], seradBody(v[2]));
    }).catch(function (e) {
      if (id !== pohled) return;
      el('vysledkyObsah').innerHTML = '<p class="chyba">Výsledky se nepodařilo načíst: ' + esc(chybaText(e)) + '</p>'
        + '<p><button type="button" class="tlacitko male obrys" id="vysledkyZnovu">Zkusit znovu</button></p>';
      el('vysledkyZnovu').onclick = function () { vysledky(a); };
    });
  }
  function vykresliVysledky(a, uc, stopy, body) {
    var id = pohled, radky = spocitejVysledky(a, uc, stopy), sTymy = a.tymy.length > 0;
    var celkem = radky.reduce(function (s, r) { return s + r.delka; }, 0), sTrasou = radky.filter(function (r) { return r.kusy > 0; });
    var h = '';
    if (a.stopy !== 'ne') {
      h += mapaHtml('mapaVysledku', '') + (sTymy ? '<label class="zaskrtavatko"><input type="checkbox" id="barvyTymu"><span>Obarvit trasy podle týmů</span></label>' : '');
    }
    h += '<h2>Trasy účastníků</h2>';
    if (!radky.length) h += '<p class="drobne">Zatím tu nejsou žádní účastníci ani trasy.</p>';
    else {
      h += '<div class="souhrn-cisla"><span>Celkem <strong>' + km(celkem) + '</strong></span><span>' + sTrasou.length + ' ' + sklon(sTrasou.length, 'účastník', 'účastníci', 'účastníků') + ' s trasou</span>'
        + (sTrasou.length ? '<span>Nejdelší trasa: <strong>' + esc(sTrasou[0].prezdivka) + '</strong> (' + km(sTrasou[0].delka) + ')</span>' : '') + '</div>';
      if (sTymy) {
        h += '<div class="souhrn-cisla">' + a.tymy.map(function (t) {
          var s = radky.filter(function (r) { return r.tym === t.k; }).reduce(function (x, r) { return x + r.delka; }, 0);
          return '<span><span class="vzorek" style="background:' + barvaOk(t.b) + '"></span>' + esc(t.n) + ': <strong>' + km(s) + '</strong></span>';
        }).join('') + '</div>';
      }
      h += '<div class="tabulka-obal"><table class="tabulka"><thead><tr><th>#</th><th>Účastník</th>' + (sTymy ? '<th>Tým</th>' : '')
        + '<th class="cislo">Vzdálenost</th><th>Začátek trasy</th><th>Konec trasy</th><th class="cislo">Kousků</th></tr></thead><tbody>';
      radky.forEach(function (r, i) {
        h += '<tr><td>' + (i + 1) + '.</td><td class="jmeno"><span class="cara" data-uid="' + esc(r.uid) + '" style="background:' + r.barva + '"></span>' + esc(r.prezdivka)
          + (r.stav === 'zamitnut' ? ' <span class="stav-uc zamitnut">zamítnut</span>' : r.stav === 'ceka' ? ' <span class="stav-uc ceka">čeká</span>' : '') + '</td>'
          + (sTymy ? '<td>' + esc(r.tymNazev) + '</td>' : '') + '<td class="cislo"><strong>' + km(r.delka) + '</strong></td>'
          + '<td>' + esc(r.od ? fmtCas(r.od) : '–') + '</td><td>' + esc(r.do ? fmtCas(r.do) : '–') + '</td><td class="cislo">' + r.kusy + '</td></tr>';
      });
      h += '</tbody><tfoot><tr><td></td><td><strong>Celkem</strong></td>' + (sTymy ? '<td></td>' : '') + '<td class="cislo"><strong>' + km(celkem) + '</strong></td><td colspan="3"></td></tr></tfoot></table></div>'
        + '<p><button type="button" class="tlacitko zelene" id="stahnoutCsv">Stáhnout CSV</button></p>';
    }
    if (a.poloha !== 'nikdo' || a.stopy !== 'ne') {
      h += '<p class="drobne">' + (a.uchovatDni === 0 ? 'Poloha a trasy se ze serveru smažou hned po skončení akce.'
        : 'Poloha a trasy se ze serveru smažou ' + fmtDen(new Date(+a.do + a.uchovatDni * DEN)) + ' (' + a.uchovatDni + ' ' + sklon(a.uchovatDni, 'den', 'dny', 'dní') + ' po akci).')
        + ' Výsledky si do té doby stáhněte jako CSV.</p>';
    }
    el('vysledkyObsah').innerHTML = h;
    if (el('stahnoutCsv')) el('stahnoutCsv').onclick = function () { stahni('akce-' + a._id + '-vysledky.csv', csvVysledku(a, radky), 'text/csv;charset=utf-8'); };
    if (a.stopy === 'ne') return;
    var kont = el('mapaVysledku');
    vytvorMapu(kont, {}).then(function (m) {
      if (id !== pohled) { m.zrus(); return; }
      priUklidu(function () { m.zrus(); });
      var podle = {};
      function kresli() {
        var tymove = !!(el('barvyTymu') && el('barvyTymu').checked);
        radky.forEach(function (r) { podle[r.uid] = tymove ? r.barvaTymu : r.barva; });
        m.stopy(prvkyStop(stopy, function (s) { return podle[s.u] || BARVA_BEZ_TYMU; }));
        document.querySelectorAll('#vysledkyObsah .cara[data-uid]').forEach(function (c) { c.style.background = podle[c.getAttribute('data-uid')] || BARVA_BEZ_TYMU; });
      }
      kresli();
      if (el('barvyTymu')) el('barvyTymu').onchange = kresli;
      m.pole(a.pole);
      var z = [];
      if (a.sraz) z.push(znackaSrazu(a.sraz));
      body.forEach(function (b, i) { z.push(znackaBodu(b, i)); });
      m.znacky(z);
      m.prizpusob(bodyProPrizpusobeni(a, body, [], stopy));
    }).catch(function (e) { if (id === pohled) chybaMapy(kont, e); });
  }

  /* ================================================================ PRŮVODCE: založení a úprava akce */
  var KROKY = [
    { nazev: 'Šablona', nazevUprava: 'Režim', vykresli: krokSablona },
    { nazev: 'Název', vykresli: krokNazev, over: overNazev },
    { nazev: 'Kdy', vykresli: krokKdy, over: overKdy },
    { nazev: 'Kde', vykresli: krokKde, over: overKde },
    { nazev: 'Týmy', vykresli: krokTymy, over: overTymy },
    { nazev: 'Poloha a trasy', vykresli: krokPoloha, over: overPoloha },
    { nazev: 'Účastníci', vykresli: krokUcastnici, over: overUcastnici },
    { nazev: 'Souhrn', vykresli: krokSouhrn },
  ];
  function novyTym(tymy) {
    var klic = najdi('abcdefghijklmnopqrstuvwxyz'.split(''), function (c) { return !tymy.some(function (t) { return t.k === c; }); }) || ('t' + (tymy.length + 1));
    var barva = najdi(BARVY_TYMU, function (b) { return !tymy.some(function (t) { return t.b.toLowerCase() === b.b.toLowerCase(); }); }) || BARVY_TYMU[tymy.length % BARVY_TYMU.length];
    var jmeno = tymy.some(function (t) { return t.n === barva.t; }) ? 'Tým ' + (tymy.length + 1) : barva.t;
    return { k: klic, n: jmeno, b: barva.b };
  }
  function pouzijSablonu(N, s) {
    var x = s.nastav;
    N.sablona = s.id; N.rezim = x.rezim; N.poloha = x.poloha; N.polohaOrg = x.polohaOrg; N.polohaPovinna = x.polohaPovinna;
    N.schvalovani = x.schvalovani; N.stopy = x.stopy; N.uchovatDni = x.uchovatDni;
    if (!x.tymy) N.tymy = [];
    else while (N.tymy.length < x.tymy) N.tymy.push(novyTym(N.tymy));
    N.tymyVyber = x.tymyVyber || 'hraci';
  }
  function novyNavrh() {
    var od = new Date(ted()); od.setDate(od.getDate() + 1); od.setHours(9, 0, 0, 0);
    var N = { sablona: null, nazev: '', popis: '', uvitani: '', od: od, do: new Date(+od + 3 * 3600000), rezim: 'vyprava',
      poloha: 'vsichni', polohaOrg: true, polohaPovinna: true, schvalovani: false, stopy: 'zive', tymy: [], tymyVyber: 'hraci',
      sraz: null, pole: null, body: [], max: MAX_UCASTNIKU, uchovatDni: 30 };
    pouzijSablonu(N, SABLONY[0]);
    return N;
  }
  var dalsiIdBodu = 1;
  function zAkce(a, body) {
    return { sablona: null, nazev: a.nazev, popis: a.popis || '', uvitani: (a.vzhled && typeof a.vzhled.uvitani === 'string' ? a.vzhled.uvitani : ''),
      od: a.od ? new Date(+a.od) : null, do: a.do ? new Date(+a.do) : null, rezim: a.rezim, poloha: a.poloha, polohaOrg: a.polohaOrg,
      polohaPovinna: a.polohaPovinna, schvalovani: a.schvalovani, stopy: a.stopy, tymy: a.tymy.map(function (t) { return { k: t.k, n: t.n, b: t.b }; }),
      tymyVyber: a.tymyVyber, sraz: a.sraz ? { n: a.sraz.n || 'Sraz', lat: a.sraz.lat, lon: a.sraz.lon } : null,
      pole: a.pole ? { typ: 'kruh', lat: a.pole.lat, lon: a.pole.lon, r: a.pole.r } : null,
      body: body.map(function (b) { return { _uid: dalsiIdBodu++, bid: b._id, n: b.n || '', lat: b.lat, lon: b.lon, h: jeCislo(b.h) ? b.h : null, r: jeCislo(b.r) ? b.r : null }; }),
      max: a.max, uchovatDni: a.uchovatDni };
  }
  function navrhNaAkci(N, uid) {
    return {
      nazev: N.nazev.trim(), popis: N.popis.trim(), vlastnik: uid, stav: 'priprava', od: N.od, do: N.do, rezim: N.rezim,
      poloha: N.poloha, polohaOrg: N.polohaOrg !== false, polohaPovinna: N.polohaPovinna !== false, schvalovani: N.schvalovani === true,
      stopy: N.stopy, tymy: N.tymy.map(function (t) { return { k: t.k, n: t.n.trim(), b: t.b }; }), tymyVyber: N.tymy.length ? N.tymyVyber : 'hraci',
      pole: N.pole ? { typ: 'kruh', lat: N.pole.lat, lon: N.pole.lon, r: Math.round(N.pole.r) } : null,
      sraz: N.sraz ? { n: N.sraz.n.trim() || 'Sraz', lat: N.sraz.lat, lon: N.sraz.lon } : null,
      max: N.max, uchovatDni: N.uchovatDni, verejna: false, vytvoreno: null, souhlasVerze: SOUHLAS_VERZE, vzhled: { uvitani: N.uvitani.trim() },
    };
  }
  function pruvodce(kod) {
    var id = pohled;
    sirka(false);
    document.title = (kod ? 'Úprava akce' : 'Nová akce') + ' – Hra na míru – Okolník';
    if (!relace) { vyzvaPrihlaseni(kod ? 'Nastavení akce může měnit jen přihlášený organizátor.' : 'Pro založení akce se prosím přihlaste stejným účtem jako v aplikaci.'); return; }
    nacitani(kod ? 'Načítám akci…' : 'Ověřuji předplatné…');
    if (kod) {
      Promise.all([api.akce(kod), api.pod(kod, 'body').catch(function () { return []; }), api.pod(kod, 'ucastnici').catch(function () { return []; })]).then(function (v) {
        if (id !== pohled) return;
        if (!v[0]) { nenalezeno(kod); return; }
        if (!jsemOrg(v[0])) {
          el('obsah').innerHTML = horni() + '<div class="stav"><h2>Tuhle akci nespravujete</h2><p>Nastavení akce může měnit jen organizátor.</p>'
            + '<p><a class="tlacitko male" data-jdi href="' + esc(odkaz({ k: kod })) + '">Zobrazit pozvánku</a></p></div>';
          return;
        }
        P = { uprava: true, aid: kod, puvodni: { akce: v[0], body: seradBody(v[1]) }, ucastnici: v[2], N: zAkce(v[0], seradBody(v[1])), krok: 0, mapa: null };
        vykresliPruvodce();
      }).catch(function (e) {
        if (id !== pohled) return;
        chybaNacteni('Akci se nepodařilo načíst. ' + chybaText(e), function () { pruvodce(kod); });
      });
      return;
    }
    api.hrac().then(function (h) { return !!(h && h.premium === true); }, function (e) { return e && e.kod === 'prihlaseni' ? 'prihlaseni' : null; }).then(function (premium) {
      if (id !== pohled) return;
      if (premium === 'prihlaseni') { vyzvaPrihlaseni('Přihlášení vypršelo. Přihlaste se prosím znovu stejným účtem jako v aplikaci.'); return; }
      if (premium === false) {
        el('obsah').innerHTML = horni() + '<span class="nadtitul">Nová akce</span><h1>Založit akci</h1>' + premiumHtml()
          + '<p><a class="tlacitko obrys" data-jdi href="' + esc(odkaz({})) + '">Zpět na moje akce</a></p>';
        return;
      }
      P = { uprava: false, N: novyNavrh(), krok: 0, mapa: null, premiumNeovereno: premium === null };
      vykresliPruvodce();
    });
  }
  function vykresliPruvodce() {
    if (P.mapa) { P.mapa.zrus(); P.mapa = null; }
    var k = KROKY[P.krok], posledni = P.krok === KROKY.length - 1;
    var nazevKroku = function (x) { return P.uprava && x.nazevUprava ? x.nazevUprava : x.nazev; };
    var h = horni() + '<span class="nadtitul">' + (P.uprava ? 'Úprava akce' : 'Nová akce') + '</span>'
      + '<h1>' + (P.uprava ? esc(P.puvodni.akce.nazev) : 'Založit akci') + '</h1>'
      + '<ol class="kroky" aria-label="Kroky průvodce">' + KROKY.map(function (x, i) {
        return '<li class="' + (i < P.krok ? 'hotovo' : i === P.krok ? 'aktivni' : '') + '"'
          + (i < P.krok ? ' data-krok="' + i + '" role="button" tabindex="0"' : '') + (i === P.krok ? ' aria-current="step"' : '') + '>'
          + (i + 1) + '. ' + nazevKroku(x) + '</li>';
      }).join('') + '</ol>'
      + '<p class="krok-mobil">Krok ' + (P.krok + 1) + ' z ' + KROKY.length + ' · ' + nazevKroku(k) + '</p>'
      + '<section id="krokTelo" class="krok-telo" tabindex="-1"></section>'
      + '<p class="chyba" id="krokChyba" role="alert"></p>'
      + '<div class="krok-tlacitka">'
      + (P.krok > 0 ? '<button type="button" class="tlacitko obrys" id="krokZpet">← Zpět</button>'
        : '<a class="tlacitko obrys" data-jdi href="' + esc(odkaz(P.uprava ? { k: P.aid } : {})) + '">Zrušit</a>')
      + '<button type="button" class="tlacitko' + (posledni ? ' zelene' : '') + '" id="krokDal">'
      + (posledni ? (P.uprava ? 'Uložit změny' : 'Založit akci') : 'Pokračovat →') + '</button></div>'
      + '<p class="zprava" id="odeslatZprava" role="status"></p>';
    el('obsah').innerHTML = h;
    k.vykresli(el('krokTelo'));
    oznacVolby(el('krokTelo'));
    el('obsah').querySelectorAll('.kroky [data-krok]').forEach(function (li) {
      var jdiZpet = function () { jdiNaKrok(parseInt(li.getAttribute('data-krok'), 10)); };
      li.onclick = jdiZpet;
      li.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jdiZpet(); } };
    });
    if (el('krokZpet')) el('krokZpet').onclick = function () { jdiNaKrok(P.krok - 1); };
    el('krokDal').onclick = function () { if (posledni) odeslatPruvodce(); else dalsiKrok(); };
  }
  function jdiNaKrok(i) {
    if (i < 0 || i >= KROKY.length) return;
    P.krok = i;
    vykresliPruvodce();
    var t = el('krokTelo'); if (t) t.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  function dalsiKrok() {
    var k = KROKY[P.krok], ch = k.over ? k.over() : {};
    if (ukazChyby(ch)) return;
    jdiNaKrok(P.krok + 1);
  }
  /* chyby u polí: data-chyba="klic" = text pod polem, data-pole="klic" = orámované pole */
  function ukazChyby(ch) {
    var t = el('krokTelo'), klice = Object.keys(ch || {});
    t.querySelectorAll('[data-chyba]').forEach(function (p) { p.textContent = ''; });
    t.querySelectorAll('.spatne').forEach(function (x) { x.classList.remove('spatne'); x.removeAttribute('aria-invalid'); });
    el('krokChyba').textContent = '';
    if (!klice.length) return false;
    var prvni = null, volne = [];
    klice.forEach(function (k) {
      var p = t.querySelector('[data-chyba="' + k + '"]');
      if (ch[k]) { if (p) p.textContent = ch[k]; else volne.push(ch[k]); }
      var vstup = t.querySelector('[data-pole="' + k + '"]');
      if (vstup) { vstup.classList.add('spatne'); vstup.setAttribute('aria-invalid', 'true'); if (!prvni) prvni = vstup; }
    });
    el('krokChyba').textContent = volne.length ? volne.join(' ') : 'Opravte prosím označené údaje.';
    if (prvni) prvni.focus();
    return true;
  }
  function radio(jmeno, hodnota, nadpis, popis, vybrano, zakazano) {
    return '<label class="volba-radek' + (vybrano ? ' vybrana' : '') + (zakazano ? ' zakazana' : '') + '">'
      + '<input type="radio" name="' + jmeno + '" value="' + esc(hodnota) + '"' + (vybrano ? ' checked' : '') + (zakazano ? ' disabled' : '') + '>'
      + '<span><strong>' + nadpis + '</strong>' + (popis ? '<span class="popis">' + popis + '</span>' : '') + '</span></label>';
  }
  function oznacVolby(koren) {
    if (!koren) return;
    koren.querySelectorAll('.volba-radek').forEach(function (l) { var i = l.querySelector('input'); l.classList.toggle('vybrana', !!(i && i.checked)); });
  }
  function naRadio(koren, jmeno, fn) {
    koren.querySelectorAll('input[name="' + jmeno + '"]').forEach(function (r) {
      r.addEventListener('change', function () { if (r.checked) { fn(r.value); oznacVolby(el('krokTelo')); } });
    });
  }

  /* ---------------------------------------------------------------- 1. šablona a režim */
  function krokSablona(t) {
    var N = P.N, h = '';
    if (!P.uprava) {
      h += '<h2>Šablona</h2><p class="drobne">Šablona jen předvyplní nastavení. Všechno můžete v dalších krocích změnit.</p><div class="sablony">';
      SABLONY.forEach(function (s) {
        h += '<button type="button" class="sablona" data-sablona="' + s.id + '" aria-pressed="' + (N.sablona === s.id) + '">'
          + '<span class="ik" aria-hidden="true">' + s.ikona + '</span><strong>' + s.nazev + '</strong><span class="p">' + s.popis + '</span></button>';
      });
      h += '</div>';
    }
    h += '<h2>Herní režim</h2><div class="volby">'
      + radio('rezim', 'vyprava', 'Jen výprava', 'Společná výprava bez soutěže a bez bodování.', N.rezim === 'vyprava')
      + radio('rezim', 'body', 'Kontrolní body (bodování připravujeme)', 'Body na mapě, které účastníci obejdou. Přidáte je v kroku Kde.', N.rezim === 'body')
      + radio('rezim', 'vlajky', 'Dobývání vlajek (připravujeme)', 'Týmy obsazují vlajky jako v Dobyvateli.', N.rezim === 'vlajky', true)
      + '</div>';
    t.innerHTML = h;
    t.querySelectorAll('[data-sablona]').forEach(function (b) {
      b.onclick = function () {
        var sid = b.getAttribute('data-sablona');
        pouzijSablonu(N, najdi(SABLONY, function (s) { return s.id === sid; }));
        krokSablona(t); oznacVolby(t);
        var nove = t.querySelector('[data-sablona="' + sid + '"]'); if (nove) nove.focus();
      };
    });
    naRadio(t, 'rezim', function (v) { N.rezim = v; });
  }

  /* ---------------------------------------------------------------- 2. název */
  function krokNazev(t) {
    var N = P.N;
    t.innerHTML = '<h2>Název a uvítání</h2>'
      + '<label class="popisek" for="fNazev">Název akce</label>'
      + '<input class="vstup" id="fNazev" data-pole="nazev" maxlength="60" autocomplete="off" placeholder="Např. Podzimní výprava na Sněžku" value="' + esc(N.nazev) + '">'
      + '<p class="chyba" data-chyba="nazev"></p>'
      + '<label class="popisek" for="fPopis">Popis <span class="drobne">(nepovinný)</span></label>'
      + '<textarea id="fPopis" data-pole="popis" maxlength="1000" rows="4" placeholder="Co vás čeká, co si vzít s sebou…">' + esc(N.popis) + '</textarea>'
      + '<p class="chyba" data-chyba="popis"></p>'
      + '<label class="popisek" for="fUvitani">Uvítání <span class="drobne">(nepovinné – účastníci ho uvidí po připojení)</span></label>'
      + '<textarea id="fUvitani" data-pole="uvitani" maxlength="300" rows="2" placeholder="Vítejte! Sraz je u hlavního vchodu do parku.">' + esc(N.uvitani) + '</textarea>'
      + '<p class="chyba" data-chyba="uvitani"></p>';
    el('fNazev').oninput = function () { N.nazev = this.value; };
    el('fPopis').oninput = function () { N.popis = this.value; };
    el('fUvitani').oninput = function () { N.uvitani = this.value; };
  }
  function overNazev() {
    var N = P.N, ch = {}, n = N.nazev.trim();
    if (n.length < 3 || n.length > 60) ch.nazev = 'Název musí mít 3 až 60 znaků.';
    if (N.popis.trim().length > 1000) ch.popis = 'Popis může mít nejvýš 1000 znaků.';
    if (N.uvitani.trim().length > 300) ch.uvitani = 'Uvítání může mít nejvýš 300 znaků.';
    return ch;
  }

  /* ---------------------------------------------------------------- 3. kdy */
  function krokKdy(t) {
    var N = P.N, o = P.uprava ? P.puvodni.akce : null;
    // v21: po startu je začátek pevný a konec jde jen dřív; skončenou akci už neměnit vůbec
    var zacala = !!(o && akceZacala(o)), skoncila = !!(o && stavAkce(o) === 'konec');
    var konecMax = zacala && platneDatum(o.do) ? o.do : null;
    var tlDelka = function (x) {
      var cil = platneDatum(N.od) ? +N.od + x[0] * 3600000 : 0;
      var nejde = skoncila || (konecMax && (cil > +konecMax || cil <= ted()));
      return '<button type="button" data-hodin="' + x[0] + '"' + (nejde ? ' disabled' : '') + '>' + x[1] + '</button>';
    };
    t.innerHTML = '<h2>Kdy</h2><div class="dva-sloupce">'
      + '<div><label class="popisek" for="fOd">Začátek</label><input class="vstup" type="datetime-local" id="fOd" data-pole="od" value="' + mistniCas(N.od) + '"' + (zacala ? ' disabled' : '') + '><p class="chyba" data-chyba="od"></p></div>'
      + '<div><label class="popisek" for="fDo">Konec</label><input class="vstup" type="datetime-local" id="fDo" data-pole="do" value="' + mistniCas(N.do) + '"'
      + (konecMax ? ' max="' + mistniCas(konecMax) + '"' : '') + (skoncila ? ' disabled' : '') + '><p class="chyba" data-chyba="do"></p></div>'
      + '</div>'
      + (skoncila ? '<p class="jen-zuzit">Akce už skončila, její čas už nejde změnit.</p>' : zacala ? '<p class="jen-zuzit">' + JEN_ZKRATIT + '</p>' : '')
      + '<div class="rychle"><span class="drobne">Délka:</span>'
      + [[1, '1 h'], [2, '2 h'], [3, '3 h'], [6, '6 h'], [24, '1 den']].map(tlDelka).join('')
      + '<button type="button" id="zacitHned"' + (zacala ? ' disabled' : '') + '>Začít hned</button></div>'
      + '<p class="drobne" id="kdyDelka" aria-live="polite"></p>'
      + '<p class="drobne">Časy jsou v místním čase. Akce začne sama v nastavený čas (dřív ji můžete spustit ve správě akce) a skončí v čase konce. Může trvat nejvýš 14 dní.</p>';
    var fOd = el('fOd'), fDo = el('fDo');
    function delka() { el('kdyDelka').textContent = platneDatum(N.od) && platneDatum(N.do) && N.do > N.od ? 'Akce potrvá ' + trvani(N.do - N.od) + '.' : ''; }
    fOd.onchange = function () {
      var nove = casZVstupu(fOd.value);
      if (nove && platneDatum(N.od) && platneDatum(N.do) && N.do > N.od) { N.do = new Date(+nove + (N.do - N.od)); fDo.value = mistniCas(N.do); }   // délka zůstane
      N.od = nove; delka();
    };
    fDo.onchange = function () { N.do = casZVstupu(fDo.value); delka(); };
    t.querySelectorAll('[data-hodin]').forEach(function (b) {
      b.onclick = function () {
        prectiKdy();
        if (!platneDatum(N.od)) { ukazChyby({ od: 'Nejdřív vyplňte začátek.' }); return; }
        N.do = new Date(+N.od + parseInt(b.getAttribute('data-hodin'), 10) * 3600000); fDo.value = mistniCas(N.do); delka();
      };
    });
    el('zacitHned').onclick = function () {
      var t0 = new Date(ted()); t0.setSeconds(0, 0);
      var trv = platneDatum(N.od) && platneDatum(N.do) && N.do > N.od ? N.do - N.od : 3 * 3600000;
      N.od = t0; N.do = new Date(+t0 + trv); fOd.value = mistniCas(N.od); fDo.value = mistniCas(N.do); delka();
    };
    delka();
  }
  function prectiKdy() {   // pole mohla změnit hodnotu bez události change (psaní a hned klik)
    var N = P.N, fOd = el('fOd'), fDo = el('fDo');
    if (fOd && fOd.value !== mistniCas(N.od)) N.od = casZVstupu(fOd.value);
    if (fDo && fDo.value !== mistniCas(N.do)) N.do = casZVstupu(fDo.value);
  }
  function overKdy() {
    var N = P.N, ch = {};
    prectiKdy();
    if (!platneDatum(N.od)) ch.od = 'Vyplňte začátek akce.';
    if (!platneDatum(N.do)) ch.do = 'Vyplňte konec akce.';
    if (!ch.od && !ch.do) {
      if (+N.do <= +N.od) ch.do = 'Konec musí být až po začátku.';
      else if (N.do - N.od > MAX_DNU * DEN) ch.do = 'Akce může trvat nejvýš 14 dní.';
      else if (+N.do <= ted() && (!P.uprava || +N.do !== +P.puvodni.akce.do)) ch.do = 'Konec akce už uplynul. Nastavte pozdější čas.';
    }
    if (P.uprava && !ch.od && !ch.do && akceZacala(P.puvodni.akce)) {   // v21 (i když akce začala až během úprav)
      var o = P.puvodni.akce;
      if (+N.od !== +o.od) ch.od = JEN_ZKRATIT + ' Začátek už nejde změnit.';
      else if (+N.do > +o.do) ch.do = JEN_ZKRATIT + ' Konec může být nejpozději ' + fmtCas(o.do) + '.';
    }
    return ch;
  }

  /* ---------------------------------------------------------------- 4. kde (mapa: sraz, hrací pole, kontrolní body) */
  function krokKde(t) {
    var N = P.N, sBody = N.rezim === 'body';
    if (!P.nastroj || (P.nastroj === 'bod' && !sBody)) P.nastroj = 'sraz';
    var nastroj = function (id, textik) { return '<button type="button" class="nastroj" data-nastroj="' + id + '" aria-pressed="' + (P.nastroj === id) + '">' + textik + '</button>'; };
    t.innerHTML = '<h2>Kde <span class="drobne">(nepovinné)</span></h2>'
      + '<p class="drobne">Vyberte, co chcete umístit, a klepněte do mapy. Značky jde přetáhnout.</p>'
      + '<div class="nastroje" role="group" aria-label="Co umístit klepnutím do mapy">'
      + nastroj('sraz', '📍 Sraz') + nastroj('pole', '⭕ Hrací pole') + (sBody ? nastroj('bod', '🏁 Kontrolní bod') : '') + '</div>'
      + mapaHtml('kdeMapa', '') + '<p class="drobne" id="kdeNapoveda" aria-live="polite"></p>'
      + '<div class="kde-sekce"><h3>Sraz</h3><div id="srazBox"></div><p class="chyba" data-chyba="sraz"></p></div>'
      + '<div class="kde-sekce"><h3>Hrací pole</h3><div id="poleBox"></div></div>'
      + (sBody ? '<div class="kde-sekce"><h3>Kontrolní body</h3><div id="bodyBox"></div><p class="chyba" data-chyba="body"></p></div>' : '');
    t.querySelectorAll('[data-nastroj]').forEach(function (b) {
      b.onclick = function () {
        P.nastroj = b.getAttribute('data-nastroj');
        t.querySelectorAll('[data-nastroj]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        napovedaKde();
      };
    });
    napovedaKde();
    vykresliKdePanely();
    var kont = el('kdeMapa'), maNeco = N.sraz || N.pole || N.body.length;
    vytvorMapu(kont, { stred: UKAZKA ? [14.4225, 50.1055] : undefined, zoom: UKAZKA ? 13 : undefined, hledatPolohu: true }).then(function (m) {   // ukázka: Stromovka
      if (!P || el('kdeMapa') !== kont) { m.zrus(); return; }   // mezitím jiný krok
      P.mapa = m;
      m.mapa.on('click', function (e) { if (!jeKlikNaZnacku(e)) klikKde(e.lngLat); });
      m.mapa.getCanvas().style.cursor = 'crosshair';
      vykresliKdeMapu();
      if (maNeco) m.prizpusob(bodyProPrizpusobeni(navrhNaAkci(N, ''), N.rezim === 'body' ? N.body : []));
    }).catch(function (e) {
      if (!P || el('kdeMapa') !== kont) return;
      chybaMapy(kont, e);
      var n = kont.parentNode.querySelector('.mapa-nacitani');
      if (n) n.textContent += ' Sraz, pole a body můžete doplnit později v úpravách akce.';
    });
  }
  function napovedaKde() {
    var n = el('kdeNapoveda'); if (!n) return;
    n.textContent = P.nastroj === 'sraz' ? 'Klepnutím do mapy umístíte sraz.' : P.nastroj === 'pole' ? 'Klepnutím do mapy určíte střed hracího pole (kruhu).'
      : 'Každé klepnutí do mapy přidá kontrolní bod.';
  }
  function klikKde(ll) {
    var N = P.N, lat = zaokr(ll.lat), lon = zaokr(ll.lng);
    if (P.nastroj === 'sraz') N.sraz = { n: (N.sraz && N.sraz.n) || 'Sraz', lat: lat, lon: lon };
    else if (P.nastroj === 'pole') N.pole = { typ: 'kruh', lat: lat, lon: lon, r: (N.pole && N.pole.r) || 1000 };
    else if (P.nastroj === 'bod') {
      if (N.body.length >= MAX_BODU) { el('kdeNapoveda').textContent = 'Kontrolních bodů může být nejvýš ' + MAX_BODU + '.'; return; }
      N.body.push({ _uid: dalsiIdBodu++, bid: null, n: 'Bod ' + (N.body.length + 1), lat: lat, lon: lon, h: 1, r: 30 });
    }
    vykresliKdePanely(); vykresliKdeMapu();
  }
  function vykresliKdeMapu() {
    var m = P && P.mapa; if (!m) return;
    var N = P.N, z = [];
    m.pole(N.pole);
    if (N.sraz) z.push(znackaSrazu(N.sraz, function (ll) { N.sraz.lat = zaokr(ll.lat); N.sraz.lon = zaokr(ll.lng); vykresliKdePanely(); }));
    if (N.pole) {
      z.push({ klic: 'stred', lat: N.pole.lat, lon: N.pole.lon, verze: 'stred', prvek: prvekStredu, titulek: 'Střed hracího pole – přetáhněte',
        tah: function (ll) { N.pole.lat = zaokr(ll.lat); N.pole.lon = zaokr(ll.lng); m.pole(N.pole); vykresliKdePanely(); } });
    }
    if (N.rezim === 'body') {
      N.body.forEach(function (b, i) {
        z.push(znackaBodu(b, i, 'bod:' + b._uid, function (ll) { b.lat = zaokr(ll.lat); b.lon = zaokr(ll.lng); }));
      });
    }
    m.znacky(z);
  }
  function vykresliKdePanely() {
    var N = P.N;
    var s = el('srazBox');
    if (s) {
      s.innerHTML = N.sraz
        ? '<div class="radek-flex"><label class="sr" for="fSraz">Název srazu</label><input class="vstup" id="fSraz" data-pole="sraz" maxlength="60" value="' + esc(N.sraz.n) + '" style="max-width:320px">'
          + '<span class="souradnice">' + N.sraz.lat.toFixed(5) + ', ' + N.sraz.lon.toFixed(5) + '</span>'
          + '<button type="button" class="odkaz-tl" id="srazPryc">Odebrat sraz</button></div>'
        : '<p class="drobne">Zatím není. Vyberte „Sraz“ a klepněte do mapy.</p>';
      if (el('fSraz')) el('fSraz').oninput = function () { N.sraz.n = this.value; vykresliKdeMapu(); };
      if (el('srazPryc')) el('srazPryc').onclick = function () { N.sraz = null; vykresliKdePanely(); vykresliKdeMapu(); };
    }
    var p = el('poleBox');
    if (p) {
      p.innerHTML = N.pole
        ? '<div class="radek-flex"><label for="fPoleR">Poloměr</label><input type="range" id="fPoleR" min="100" max="5000" step="50" value="' + Math.round(N.pole.r) + '" style="flex:1;min-width:160px;max-width:360px">'
          + '<output id="fPoleRText" for="fPoleR"><strong>' + metry(N.pole.r) + '</strong></output>'
          + '<button type="button" class="odkaz-tl" id="polePryc">Odebrat hrací pole</button></div>'
        : '<p class="drobne">Zatím není. Vyberte „Hrací pole“ a klepněte na jeho střed.</p>';
      if (el('fPoleR')) el('fPoleR').oninput = function () {
        N.pole.r = parseInt(this.value, 10);
        el('fPoleRText').innerHTML = '<strong>' + metry(N.pole.r) + '</strong>';
        if (P.mapa) P.mapa.pole(N.pole);
      };
      if (el('polePryc')) el('polePryc').onclick = function () { N.pole = null; vykresliKdePanely(); vykresliKdeMapu(); };
    }
    var b = el('bodyBox');
    if (b) {
      if (!N.body.length) b.innerHTML = '<p class="drobne">Zatím žádné body. Vyberte „Kontrolní bod“ a klepejte do mapy.</p>';
      else {
        b.innerHTML = N.body.map(function (x, i) {
          return '<div class="bod-radek"><span class="bod-cislo">' + (i + 1) + '</span>'
            + '<input class="vstup" data-bod-n="' + i + '" data-pole="bod-n-' + i + '" maxlength="60" value="' + esc(x.n) + '" aria-label="Název bodu ' + (i + 1) + '">'
            + '<span class="bod-cisla"><label>body <input class="vstup maly" type="number" min="0" max="1000" step="1" data-bod-h="' + i + '" data-pole="bod-h-' + i + '" value="' + (jeCislo(x.h) ? x.h : '') + '" aria-label="Hodnota bodu ' + (i + 1) + '"></label>'
            + '<label>dosah <input class="vstup maly" type="number" min="5" max="1000" step="5" data-bod-r="' + i + '" data-pole="bod-r-' + i + '" value="' + (jeCislo(x.r) ? x.r : '') + '" aria-label="Dosah bodu ' + (i + 1) + ' v metrech"> m</label></span>'
            + '<span class="bod-tl"><button type="button" data-bod-nahoru="' + i + '" aria-label="Posunout bod ' + (i + 1) + ' nahoru"' + (i === 0 ? ' disabled' : '') + '>↑</button>'
            + '<button type="button" data-bod-dolu="' + i + '" aria-label="Posunout bod ' + (i + 1) + ' dolů"' + (i === N.body.length - 1 ? ' disabled' : '') + '>↓</button>'
            + '<button type="button" data-bod-pryc="' + i + '" aria-label="Odebrat bod ' + (i + 1) + '">×</button></span></div>';
        }).join('');
      }
      var cislo = function (v) { v = String(v).trim(); return /^\d+$/.test(v) ? parseInt(v, 10) : (v === '' ? null : NaN); };
      b.querySelectorAll('[data-bod-n]').forEach(function (x) { x.oninput = function () { N.body[+x.getAttribute('data-bod-n')].n = x.value; vykresliKdeMapu(); }; });
      b.querySelectorAll('[data-bod-h]').forEach(function (x) { x.oninput = function () { N.body[+x.getAttribute('data-bod-h')].h = cislo(x.value); }; });
      b.querySelectorAll('[data-bod-r]').forEach(function (x) { x.oninput = function () { N.body[+x.getAttribute('data-bod-r')].r = cislo(x.value); }; });
      var presun = function (i, j) { var x = N.body[i]; N.body[i] = N.body[j]; N.body[j] = x; vykresliKdePanely(); vykresliKdeMapu(); };
      b.querySelectorAll('[data-bod-nahoru]').forEach(function (x) { x.onclick = function () { var i = +x.getAttribute('data-bod-nahoru'); if (i > 0) presun(i, i - 1); }; });
      b.querySelectorAll('[data-bod-dolu]').forEach(function (x) { x.onclick = function () { var i = +x.getAttribute('data-bod-dolu'); if (i < N.body.length - 1) presun(i, i + 1); }; });
      b.querySelectorAll('[data-bod-pryc]').forEach(function (x) { x.onclick = function () { N.body.splice(+x.getAttribute('data-bod-pryc'), 1); vykresliKdePanely(); vykresliKdeMapu(); }; });
    }
  }
  function overKde() {
    var N = P.N, ch = {};
    if (N.sraz && N.sraz.n.trim().length > 60) ch.sraz = 'Název srazu může mít nejvýš 60 znaků.';
    if (N.rezim === 'body') {
      var zprava = [];
      N.body.forEach(function (b, i) {
        if (!b.n.trim() || b.n.trim().length > 60) { ch['bod-n-' + i] = ''; zprava[0] = 'Každý bod potřebuje název (nejvýš 60 znaků).'; }
        if (b.h !== null && !(jeCislo(b.h) && b.h >= 0 && b.h <= 1000)) { ch['bod-h-' + i] = ''; zprava[1] = 'Hodnota bodu je celé číslo 0 až 1000 (nebo nic).'; }
        if (b.r !== null && !(jeCislo(b.r) && b.r >= 5 && b.r <= 1000)) { ch['bod-r-' + i] = ''; zprava[2] = 'Dosah je 5 až 1000 m (nebo nic).'; }
      });
      if (zprava.length) ch.body = zprava.filter(Boolean).join(' ');
    }
    return ch;
  }

  /* ---------------------------------------------------------------- 5. týmy */
  function krokTymy(t) {
    var N = P.N, sTymy = N.tymy.length > 0;
    var limit = Math.max(MAX_TYMU, P.uprava ? P.puvodni.akce.tymy.length : 0);
    var h = '<h2>Týmy</h2><div class="volby">'
      + radio('rezimTymu', 'ne', 'Každý sám za sebe', 'Bez týmů.', !sTymy)
      + radio('rezimTymu', 'ano', 'V týmech', '2 až 8 týmů se jménem a barvou.', sTymy) + '</div>';
    if (sTymy) {
      h += '<div id="tymyEditor">' + N.tymy.map(function (tm, i) {
        return '<div class="tym-radek"><span class="vzorek" style="background:' + barvaOk(tm.b) + '"></span>'
          + '<input class="vstup" data-tym-n="' + i + '" data-pole="tym-n-' + i + '" maxlength="24" value="' + esc(tm.n) + '" aria-label="Jméno týmu ' + (i + 1) + '">'
          + '<select data-tym-b="' + i + '" data-pole="tym-b-' + i + '" aria-label="Barva týmu ' + (i + 1) + '">'
          + BARVY_TYMU.map(function (b) { return '<option value="' + b.b + '"' + (b.b.toLowerCase() === tm.b.toLowerCase() ? ' selected' : '') + '>' + b.n + '</option>'; }).join('')
          + (najdi(BARVY_TYMU, function (b) { return b.b.toLowerCase() === tm.b.toLowerCase(); }) ? '' : '<option value="' + esc(tm.b) + '" selected>vlastní</option>')
          + '</select><button type="button" class="odebrat" data-tym-pryc="' + i + '" aria-label="Odebrat tým ' + (i + 1) + '"' + (N.tymy.length <= 2 ? ' disabled' : '') + '>×</button></div>';
      }).join('')
        + (N.tymy.length < limit ? '<p><button type="button" class="tlacitko male obrys" id="pridatTym">+ Přidat tým</button></p>' : '')
        + '<p class="chyba" data-chyba="tymy"></p></div>'
        + '<h3>Jak se hráči rozdělí</h3><div class="volby">'
        + radio('tymyVyber', 'hraci', 'Vyberou si hráči', 'Při připojení si každý vybere tým.', N.tymyVyber === 'hraci')
        + radio('tymyVyber', 'organizator', 'Rozdělí organizátor', 'Hráči se připojí bez týmu a vy je rozdělíte ve správě akce.', N.tymyVyber === 'organizator')
        + radio('tymyVyber', 'nahodne', 'Náhodně', 'Tým se každému přidělí náhodně, aby byly týmy vyrovnané.', N.tymyVyber === 'nahodne')
        + '</div>';
    }
    t.innerHTML = h;
    naRadio(t, 'rezimTymu', function (v) {
      if (v === 'ano') { while (N.tymy.length < 2) N.tymy.push(novyTym(N.tymy)); }
      else {
        N.tymy = [];
        if (N.poloha === 'tym') {   // v úpravě jen na užší volbu (v21): bez organizátora původně → Nikdo
          var nahradni = P.uprava && polohaRozsiruje(P.puvodni.akce, 'organizator', true) ? 'nikdo' : 'organizator';
          N.poloha = nahradni;
          P.poznamkaPoloha = 'Volba „Spoluhráči v týmu“ potřebuje týmy, proto je poloha nastavená na „' + (nahradni === 'nikdo' ? 'Nikdo' : 'Jen organizátor') + '“.';
        }
      }
      krokTymy(t); oznacVolby(t);
    });
    naRadio(t, 'tymyVyber', function (v) { N.tymyVyber = v; });
    t.querySelectorAll('[data-tym-n]').forEach(function (x) { x.oninput = function () { N.tymy[+x.getAttribute('data-tym-n')].n = x.value; }; });
    t.querySelectorAll('[data-tym-b]').forEach(function (x) {
      x.onchange = function () { var i = +x.getAttribute('data-tym-b'); N.tymy[i].b = x.value; x.parentNode.querySelector('.vzorek').style.background = barvaOk(x.value); };
    });
    t.querySelectorAll('[data-tym-pryc]').forEach(function (x) { x.onclick = function () { if (N.tymy.length > 2) { N.tymy.splice(+x.getAttribute('data-tym-pryc'), 1); krokTymy(t); oznacVolby(t); } }; });
    if (el('pridatTym')) el('pridatTym').onclick = function () { N.tymy.push(novyTym(N.tymy)); krokTymy(t); oznacVolby(t); var p = t.querySelectorAll('[data-tym-n]'); if (p.length) p[p.length - 1].focus(); };
  }
  function overTymy() {
    var N = P.N, ch = {};
    if (!N.tymy.length) return ch;
    var limit = Math.max(MAX_TYMU, P.uprava ? P.puvodni.akce.tymy.length : 0);
    if (N.tymy.length < 2 || N.tymy.length > limit) ch.tymy = 'Týmy mohou být 2 až ' + limit + '.';
    var jmena = {}, barvy = {};
    N.tymy.forEach(function (t, i) {
      var n = t.n.trim().toLowerCase();
      if (!n || t.n.trim().length > 24) { ch['tym-n-' + i] = ''; ch.tymy = 'Pojmenujte všechny týmy (nejvýš 24 znaků).'; }
      else if (jmena[n]) { ch['tym-n-' + i] = ''; ch.tymy = ch.tymy || 'Každý tým potřebuje jiné jméno.'; }
      jmena[n] = 1;
      var b = t.b.toLowerCase();
      if (barvy[b]) { ch['tym-b-' + i] = ''; ch.tymy = ch.tymy || 'Každý tým potřebuje jinou barvu.'; }
      barvy[b] = 1;
    });
    return ch;
  }

  /* ---------------------------------------------------------------- 6. poloha a trasy */
  function krokPoloha(t) {
    var N = P.N, sTymy = N.tymy.length > 0, o = P.uprava ? P.puvodni.akce : null;
    // v21: v úpravě zašednout volby, které by sdílení rozšířily (tým se posuzuje bez organizátora = nejúžeji)
    var siri = function (poloha, org) { return !!o && polohaRozsiruje(o, poloha, org); };
    var zak = { organizator: siri('organizator', true), tym: siri('tym', false), vsichni: siri('vsichni', true) };
    var bezOrg = !!o && !vlajkyPolohy(o.poloha, o.polohaOrg).org;   // organizátora do týmové polohy už nejde přidat
    var zakStopy = function (s) { return !!o && stopyRozsiruji(o, s); };
    var uzsiPoloha = zak.organizator || zak.vsichni || (sTymy && zak.tym);
    var uzsiStopy = ['organizator', 'vysledky', 'zive'].some(zakStopy);
    var radekZuzeni = function (ukaz) { return ukaz ? '<p class="jen-zuzit">' + JEN_ZUZIT + '</p>' : ''; };
    var h = '<h2>Poloha a trasy</h2>';
    if (P.poznamkaPoloha) { h += '<p class="upozorneni">' + esc(P.poznamkaPoloha) + '</p>'; P.poznamkaPoloha = null; }
    h += '<h3>Kdo uvidí polohu účastníků na mapě</h3><div class="volby">'
      + radio('poloha', 'nikdo', 'Nikdo', 'Polohu nevidí nikdo, ani organizátor. Soutěž bez sledování.', N.poloha === 'nikdo')
      + radio('poloha', 'organizator', 'Jen organizátor', 'Vy vidíte polohu všech, účastníci se navzájem nevidí. Vhodné pro školy a děti.', N.poloha === 'organizator', zak.organizator)
      + radio('poloha', 'tym', 'Spoluhráči v týmu', sTymy ? 'Každý vidí polohu svého týmu, soupeře ne.' : 'Jen pro akci s týmy (nastavíte v kroku Týmy).', N.poloha === 'tym', !sTymy || zak.tym)
      + radio('poloha', 'vsichni', 'Všichni vidí všechny', 'Účastníci i organizátor vidí polohu všech. Pro společný výlet a rodinu.', N.poloha === 'vsichni', zak.vsichni)
      + '</div><p class="chyba" data-chyba="poloha"></p><div id="polohaOrgBox"></div>' + radekZuzeni(uzsiPoloha)
      + '<h3>Záznam tras</h3><div class="volby">'
      + radio('stopy', 'ne', 'Vypnuto', 'Trasa zůstane jen v telefonu účastníka.', N.stopy === 'ne')
      + radio('stopy', 'organizator', 'Vidí organizátor', 'Kousky trasy se nahrávají během akce a vidíte je ve správě.', N.stopy === 'organizator', zakStopy('organizator'))
      + radio('stopy', 'vysledky', 'Všichni po skončení', 'Trasy všech se účastníkům ukážou po konci akce, vy je vidíte i během ní.', N.stopy === 'vysledky', zakStopy('vysledky'))
      + radio('stopy', 'zive', 'Všichni živě', 'Trasy všech vidí účastníci i organizátor už během akce.', N.stopy === 'zive', zakStopy('zive'))
      + '</div><p class="chyba" data-chyba="stopy"></p>' + radekZuzeni(uzsiStopy && !uzsiPoloha)
      + '<div id="povinnaBox"></div>'   // jeden vypínač účastníka pro polohu i trasu → volba až pod oběma
      + '<h3>Co uvidí účastníci při připojení</h3><div class="souhlas-nahled" id="souhlasNahled"></div>'
      + '<p class="drobne">Tento text potvrdí v aplikaci každý účastník, než se připojí. Sdílení (polohy i trasy) si každý zapíná sám jedním vypínačem.</p>';
    t.innerHTML = h;
    function nahled() { el('souhlasNahled').innerHTML = nahledSouhlasu(N); }
    function doplnky() {
      if (N.poloha === 'tym' && bezOrg) N.polohaOrg = false;
      el('polohaOrgBox').innerHTML = N.poloha === 'tym'
        ? '<label class="zaskrtavatko' + (bezOrg ? ' zakazana' : '') + '"><input type="checkbox" id="fPolohaOrg"' + (N.polohaOrg !== false ? ' checked' : '') + (bezOrg ? ' disabled' : '') + '><span><strong>Organizátor také vidí polohu</strong>'
          + '<span class="popis">Bez zaškrtnutí uvidí polohu jen spoluhráči v týmu, vy ne.</span></span></label>'
          + (bezOrg && !uzsiPoloha ? '<p class="jen-zuzit">' + JEN_ZUZIT + '</p>' : '') : '';
      // kdy účastníci sdílejí – kdykoli akce sbírá polohu NEBO trasu (jako textSouhlasu); bez výhrůžek
      var sPolohou = N.poloha !== 'nikdo', sTrasou = N.stopy !== 'ne';
      var nadpis = sPolohou && sTrasou ? 'Sdílení polohy a trasy' : sPolohou ? 'Sdílení polohy' : 'Záznam trasy';
      el('povinnaBox').innerHTML = sPolohou || sTrasou ? '<h3>' + nadpis + '</h3><div class="volby">'
        + radio('povinna', 'ano', 'Při úkolech a na trase (doklad)', '', N.polohaPovinna !== false)
        + radio('povinna', 'ne', 'Dobrovolné', '', N.polohaPovinna === false) + '</div>'
        + '<p class="drobne">Nikoho to automaticky nevyřadí – v přehledu uvidíte, kdo nesdílí, a rozhodnete sami.</p>' : '';
      if (el('fPolohaOrg')) el('fPolohaOrg').onchange = function () { N.polohaOrg = this.checked; nahled(); };
      naRadio(el('povinnaBox'), 'povinna', function (v) { N.polohaPovinna = v === 'ano'; nahled(); });
    }
    naRadio(t, 'poloha', function (v) { N.poloha = v; doplnky(); oznacVolby(t); nahled(); });
    naRadio(t, 'stopy', function (v) { N.stopy = v; doplnky(); oznacVolby(t); nahled(); });
    doplnky(); nahled();
  }
  function overPoloha() {
    var N = P.N, ch = {};
    if (N.poloha === 'tym' && !N.tymy.length) ch.poloha = 'Volba „Spoluhráči v týmu“ potřebuje týmy. Vyberte jinou, nebo přidejte týmy.';
    if (P.uprava) {   // v21 – pojistka i mimo zašedlé volby
      if (!ch.poloha && polohaRozsiruje(P.puvodni.akce, N.poloha, N.polohaOrg)) ch.poloha = JEN_ZUZIT;
      if (stopyRozsiruji(P.puvodni.akce, N.stopy)) ch.stopy = JEN_ZUZIT;
    }
    return ch;
  }

  /* ---------------------------------------------------------------- 7. účastníci a uchování */
  function krokUcastnici(t) {
    var N = P.N, moznosti = UCHOVANI.slice(), o = P.uprava ? P.puvodni.akce : null;
    if (moznosti.indexOf(N.uchovatDni) < 0 && jeCislo(N.uchovatDni)) { moznosti.push(N.uchovatDni); moznosti.sort(function (a, b) { return a - b; }); }
    var delsi = function (d) { return !!o && d > o.uchovatDni; };   // v21: uchování jen zkrátit
    t.innerHTML = '<h2>Účastníci a data</h2>'
      + '<label class="popisek" for="fMax">Nejvyšší počet účastníků</label>'
      + '<input class="vstup" type="number" id="fMax" data-pole="max" min="2" max="15" step="1" inputmode="numeric" value="' + (jeCislo(N.max) ? N.max : '') + '" style="max-width:140px">'
      + '<p class="chyba" data-chyba="max"></p><p class="drobne">V Okolník Premium až 15 lidí. Větší akce připravujeme.</p>'
      + '<label class="zaskrtavatko"><input type="checkbox" id="fSchvalovani"' + (N.schvalovani ? ' checked' : '') + '><span><strong>Účast schvaluji já</strong>'
      + '<span class="popis">Nový účastník počká, až ho ve správě akce schválíte. Nechtěného účastníka můžete kdykoli zamítnout.</span></span></label>'
      + '<h3>Jak dlouho po akci uchovat polohu a trasy</h3><div class="volby radkem">'
      + moznosti.map(function (d) { return radio('uchovat', String(d), d === 0 ? 'Smazat hned' : d + ' ' + sklon(d, 'den', 'dny', 'dní'), '', N.uchovatDni === d, delsi(d)); }).join('')
      + '</div><p class="chyba" data-chyba="uchovatDni"></p>'
      + (moznosti.some(delsi) ? '<p class="jen-zuzit">' + JEN_ZUZIT + '</p>' : '')
      + '<p class="drobne">Potom se poloha a trasy ze serveru smažou. Výsledky si předtím můžete stáhnout jako CSV.</p>'
      + '<h3>Co uvidí účastníci při připojení</h3><div class="souhlas-nahled" id="souhlasNahled"></div>';
    function nahled() { el('souhlasNahled').innerHTML = nahledSouhlasu(N); }
    el('fMax').oninput = function () { var v = this.value.trim(); N.max = /^\d+$/.test(v) ? parseInt(v, 10) : NaN; };
    el('fSchvalovani').onchange = function () { N.schvalovani = this.checked; nahled(); };
    naRadio(t, 'uchovat', function (v) { N.uchovatDni = parseInt(v, 10); nahled(); });
    nahled();
  }
  function overUcastnici() {
    var N = P.N, ch = {};
    if (!(jeCislo(N.max) && N.max % 1 === 0 && N.max >= 2 && N.max <= MAX_UCASTNIKU)) ch.max = 'Zadejte počet od 2 do 15.';
    else if (P.uprava && aktivniUcastnici(P.ucastnici || []).length > N.max) {
      var n = aktivniUcastnici(P.ucastnici).length;
      ch.max = 'Připojeno je už ' + n + ' ' + sklon(n, 'účastník', 'účastníci', 'účastníků') + ', počet nemůže být menší.';
    }
    if (!(jeCislo(N.uchovatDni) && N.uchovatDni % 1 === 0 && N.uchovatDni >= 0 && N.uchovatDni <= 90)) ch.uchovatDni = 'Vyberte, jak dlouho data uchovat.';
    else if (P.uprava && N.uchovatDni > P.puvodni.akce.uchovatDni) ch.uchovatDni = JEN_ZUZIT;   // v21
    return ch;
  }

  /* ---------------------------------------------------------------- 8. souhrn a odeslání */
  function krokSouhrn(t) {
    var N = P.N, a = navrhNaAkci(N, P.uprava ? P.puvodni.akce.vlastnik : relace.uid);
    var r = function (dt, dd, krok) { return '<dt>' + dt + '</dt><dd>' + dd + ' <button type="button" class="odkaz-tl upravit" data-na-krok="' + krok + '">upravit</button></dd>'; };
    var h = '<h2>Souhrn</h2><dl class="souhrn">'
      + r('Název', esc(a.nazev), 1)
      + (a.popis ? r('Popis', esc(zkrat(a.popis, 160)), 1) : '')
      + r('Kdy', esc(fmtRozsah(a.od, a.do)) + (platneDatum(a.od) && platneDatum(a.do) ? ' <span class="drobne">(' + esc(trvani(a.do - a.od)) + ')</span>' : ''), 2)
      + r('Režim', esc(REZIMY[a.rezim] || a.rezim), 0)
      + r('Sraz', a.sraz ? esc(a.sraz.n) : '–', 3)
      + r('Hrací pole', a.pole ? 'kruh o poloměru ' + esc(metry(a.pole.r)) : '–', 3)
      + (a.rezim === 'body' ? r('Kontrolní body', N.body.length ? N.body.length + ' ' + sklon(N.body.length, 'bod', 'body', 'bodů') : '–', 3) : '')
      + r('Týmy', tymyHtml(a) + (a.tymy.length ? ' <span class="drobne">· ' + esc(VYBER[a.tymyVyber] || a.tymyVyber) + '</span>' : ''), 4)
      + r('Poloha', esc(popisPolohy(a)), 5)
      + r('Trasy', esc(popisTras(a)), 5)
      + r('Účastníci', 'nejvýš ' + esc(a.max) + (a.schvalovani ? ' · účast schvalujete' : ''), 6)
      + r('Uchování dat', a.uchovatDni === 0 ? 'smazat hned po akci' : esc(a.uchovatDni) + ' ' + sklon(a.uchovatDni, 'den', 'dny', 'dní') + ' po akci', 6)
      + '</dl><h3>Text souhlasu pro účastníky</h3><div class="souhlas-nahled">' + nahledSouhlasu(a) + '</div>';
    var v = [];
    if (P.premiumNeovereno) v.push('Předplatné Premium se nepodařilo ověřit. Založení ověří server.');
    if (a.rezim === 'body' && !N.body.length) v.push('Zatím nemáte žádný kontrolní bod. Přidat je můžete v kroku Kde, nebo později v úpravách akce.');
    if (P.uprava) {
      // (dřívější varování „souhlasili s původním nastavením“ odpadlo: v21 dovolí sdílení jen zúžit)
      var uc = aktivniUcastnici(P.ucastnici || []), klice = a.tymy.map(function (x) { return x.k; });
      if (uc.some(function (u) { return u.tym && klice.indexOf(u.tym) < 0; })) v.push('Někteří účastníci jsou v týmu, který už neexistuje. Zůstanou bez týmu, dokud je ve správě akce nerozdělíte.');
    }
    h += v.map(function (x) { return '<p class="upozorneni">' + esc(x) + '</p>'; }).join('');
    t.innerHTML = h;
    t.querySelectorAll('[data-na-krok]').forEach(function (b) { b.onclick = function () { jdiNaKrok(parseInt(b.getAttribute('data-na-krok'), 10)); }; });
  }
  function odeslatPruvodce() {
    for (var i = 0; i < KROKY.length - 1; i++) {   // znovu celé ověření – něco se mohlo změnit v jiném kroku
      var ch = KROKY[i].over ? KROKY[i].over() : {};
      if (Object.keys(ch).length) { jdiNaKrok(i); ukazChyby(ch); return; }
    }
    var btn = el('krokDal'), zpet = el('krokZpet'), id = pohled;
    btn.disabled = true; if (zpet) zpet.disabled = true;
    zpravaEl('odeslatZprava', P.uprava ? 'Ukládám změny…' : 'Zakládám akci…');
    (P.uprava ? ulozUpravy() : zalozNovou()).then(function (v) {
      if (id !== pohled) return;
      if (P.uprava) {
        hlaska = v.varovani ? { text: v.varovani, chyba: true } : { text: v.zmeneno ? 'Změny jsou uložené.' : 'Nic se nezměnilo.' };
        jdi(odkaz({ k: P.aid }), true);
      } else {
        hlaska = v.varovani ? { text: v.varovani, chyba: true } : null;
        jdi(odkaz({ k: v.aid, zalozeno: true }), true);
      }
    }).catch(function (e) {
      if (id !== pohled) return;
      btn.disabled = false; if (zpet) zpet.disabled = false;
      var textik = e && e.kod === 403 && !P.uprava
        ? 'Server akci odmítl. Zkontrolujte, že máte aktivní Okolník Premium (aplikace ho na server zapíše při spuštění), a zkuste to znovu.'
        : e && e.kod === 403
          ? 'Server změny odmítl. Po založení jde sdílení jen zúžit a běžící akci jen zkrátit – akce mohla mezitím začít. Načtěte stránku znovu a zkontrolujte nastavení.'
          : (P.uprava ? 'Změny se nepodařilo uložit: ' : 'Akci se nepodařilo založit: ') + chybaText(e);
      zpravaEl('odeslatZprava', textik, 'chyba');
    });
  }
  function zalozNovou() {
    var N = P.N;
    return (casZnam ? Promise.resolve() : api.synchronizujCas()).then(function () {
      var data = navrhNaAkci(N, relace.uid);
      data.vytvoreno = new Date(ted());   // pravidla: ±5 min od času serveru
      var pokusy = 0;
      function zkus() {
        var aid = novyKod();
        return api.zaloz(aid, akceNaPole(data)).then(function () { return aid; }, function (e) {
          pokusy++;
          if (pokusy < 4 && (e.kod === 409 || e.stav === 'ALREADY_EXISTS')) return zkus();
          // kolize kódu může pravidla vyhodnotit jako cizí update (403) – ověřit, jestli kód už existuje
          if (pokusy < 4 && e.kod === 403) return api.akce(aid).then(function (ex) { if (ex) return zkus(); throw e; }, function () { throw e; });
          throw e;
        });
      }
      return zkus();
    }).then(function (aid) {
      if (N.rezim !== 'body' || !N.body.length) return { aid: aid };
      return zapisBody(aid, N.body, []).then(function () { return { aid: aid }; }, function (e) {
        return { aid: aid, varovani: 'Akce je založená, ale kontrolní body se nepodařilo uložit (' + chybaText(e) + '). Doplníte je v úpravách akce.' };
      });
    });
  }
  function ulozUpravy() {
    var orig = P.puvodni.akce, nova = navrhNaAkci(P.N, orig.vlastnik);
    nova.stav = orig.stav; nova.vytvoreno = orig.vytvoreno; nova.souhlasVerze = orig.souhlasVerze;
    var fNove = akceNaPole(nova), fStare = akceNaPole(orig), maska = [], pole = {};
    ['nazev', 'popis', 'od', 'do', 'rezim', 'poloha', 'polohaOrg', 'polohaPovinna', 'schvalovani', 'stopy', 'tymy', 'tymyVyber', 'pole', 'sraz', 'max', 'uchovatDni']
      .forEach(function (k) {
        if (JSON.stringify(fNove[k]) === JSON.stringify(fStare[k])) return;
        maska.push(k);
        if (k in fNove) pole[k] = fNove[k];   // v masce bez hodnoty = smazat (vymazaný popis)
      });
    var uvN = P.N.uvitani.trim(), uvS = (orig.vzhled && typeof orig.vzhled.uvitani === 'string') ? orig.vzhled.uvitani : '';
    if (uvN !== uvS) { maska.push('vzhled.uvitani'); if (uvN) pole.vzhled = M({ uvitani: S(uvN) }); }
    var zapis = maska.length ? api.uprav(P.aid, pole, maska) : Promise.resolve();
    return zapis.then(function () {
      if (P.N.rezim !== 'body') return 0;
      return zapisBody(P.aid, P.N.body, P.puvodni.body).then(function (n) { return n; }, function (e) {
        return { varovani: 'Nastavení je uložené, ale kontrolní body se nepodařilo uložit celé (' + chybaText(e) + ').' };
      });
    }).then(function (b) {
      if (b && b.varovani) return b;
      return { zmeneno: maska.length > 0 || b > 0 };
    });
  }
  /* kontrolní body: nové a změněné zapsat (celý dokument), odebrané smazat → počet změn */
  function zapisBody(aid, body, puvodni) {
    var pouzite = {}, puv = {};
    puvodni.forEach(function (b) { pouzite[b._id] = 1; puv[b._id] = b; });
    body.forEach(function (b) { if (b.bid) pouzite[b.bid] = 1; });
    var n = 1;
    function novyBid() { while (pouzite['b' + n]) n++; pouzite['b' + n] = 1; return 'b' + n; }
    var zapisy = [], mazani = [];
    body.forEach(function (b, i) {
      if (!b.bid) b.bid = novyBid();
      var f = bodNaPole({ n: b.n.trim(), lat: b.lat, lon: b.lon, h: b.h, r: b.r }, i), s = puv[b.bid];
      var stary = s ? bodNaPole({ n: s.n, lat: s.lat, lon: s.lon, h: s.h, r: s.r }, (s.poradi || 0) - 1) : null;
      if (!stary || JSON.stringify(f) !== JSON.stringify(stary)) zapisy.push({ bid: b.bid, f: f });
    });
    puvodni.forEach(function (s) {
      if (!body.some(function (b) { return b.bid === s._id; })) mazani.push(s._cesta || ('akce/' + aid + '/body/' + s._id));
    });
    return poSkupinach(zapisy, 5, function (z) { return api.zapisBod(aid, z.bid, z.f); })
      .then(function () { return poSkupinach(mazani, 5, function (c) { return api.smaz(c); }); })
      .then(function () { return zapisy.length + mazani.length; });
  }

  /* ================================================================ start */
  function start() {
    if (UKAZKA) { demoInit(); relace = DEMO.relace; api = apiUkazka; }
    else { relace = nactiRelaci(); api = apiSit; }
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest && e.target.closest('a[data-jdi]');
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (a.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
      e.preventDefault();
      jdi(a.getAttribute('href'));
    });
    window.addEventListener('popstate', vykresli);
    // pro aplikaci a testy: stejná logika textu souhlasu a dekódování tras
    window.OkolnikAkce = { textSouhlasu: textSouhlasu, dekodujPolyline: dekodujPolyline, souhlasVerze: SOUHLAS_VERZE };
    // jen v ukázce: přímý zápis do paměťových dat – test, že kopie pravidel odmítne totéž co server
    if (UKAZKA) window.OkolnikAkce.ukazka = { uprav: apiUkazka.uprav, akce: apiUkazka.akce };
    vykresli();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
