/* =====================================================================
   Můj Okolník – přihlášení účtem Google a prohlížení vlastních výsledků.

   Web na okolnik.cz je STATICKÝ (GitHub Pages), žádný backend tu není.
   Přihlášení proto jede přes dvě veřejná REST rozhraní Googlu:

     1) Google Identity Services (skript gsi/client) vrátí po kliknutí
        na tlačítko **Google ID token** (podepsaný JWT);
     2) ten se vymění ve Firebase Identity Toolkit
        (`accounts:signInWithIdp`) za **Firebase idToken + refreshToken**;
     3) idToken se pak posílá Firestore REST API v hlavičce
        `Authorization: Bearer …`, takže pravidla vidí `request.auth.uid`.

   ⚠️ ŽÁDNÉ Firebase SDK. Je to schválně: zbytek webu je taky jen fetch
   bez knihoven, a tři REST volání jsou míň než 300 kB SDK z CDN.

   Formát dokumentů a Firestore pravidla: /UCET-POZNAMKY.md v kořeni
   tohoto repozitáře.
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------------
   Konfigurace
   ---------------------------------------------------------------------
   PROJEKT a KLIC jsou stejné jako v žebříčku – veřejné klientské
   identifikátory, data chrání Firestore Rules.

   ⚠️ KLIENT_ID SE MUSÍ DOPLNIT. Je to „Web client" OAuth klienta, kterého
   Firebase projektu založil sám:
      Google Cloud Console → APIs & Services → Credentials →
      OAuth 2.0 Client IDs → „Web client (auto created by Google Service)"
   Ke zprovoznění je potřeba ještě:
      • Firebase → Authentication → Sign-in method → povolit **Google**;
      • Firebase → Authentication → Settings → Authorized domains →
        přidat `okolnik.cz` (a `<uziv>.github.io`, pokud se testuje tam);
      • u toho OAuth klienta v Cloud Console přidat do
        „Authorized JavaScript origins" `https://okolnik.cz`.
   Dokud je KLIENT_ID prázdné, stránka to slušně napíše místo rozbitého
   tlačítka.
--------------------------------------------------------------------- */
var PROJEKT = 'sarcher-b32a1';
// ⚠️ JINÝ KLÍČ NEŽ V APLIKACI. Tenhle je omezený na okolnik.cz
// (Websites restrikce) + jen tři API: Identity Toolkit, Firestore
// a Token Service. Klíč z APK sem NEPATŘÍ — appka volá Firestore
// holým REST, takže referrer neposílá a s omezením by přestala
// fungovat (proto má vlastní, neomezený).
var KLIC = 'AIzaSyB3sj8qS-Lh4lHow6AUrWH-JayEtJ70igQ';
var KLIENT_ID =
    '878915340826-4mc76u4anq2mbvh07glgnnugnvdbr4gt.apps.googleusercontent.com';

var ZAKLAD = 'https://firestore.googleapis.com/v1/projects/' + PROJEKT +
             '/databases/(default)/documents';
var TIMEOUT_MS = 12000;
var ULOZISTE = 'okolnikUcet1';

/* ---------------------------------------------------------------------
   Drobná pomocná kuchyň
--------------------------------------------------------------------- */
function el(id) { return document.getElementById(id); }

function prvek(tag, trida, text) {
  var e = document.createElement(tag);
  if (trida) e.className = trida;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}

/** Uživatelský text (přezdívka, název úspěchu) – bez řídicích znaků. */
function ocisti(s, max) {
  if (typeof s !== 'string') return '';
  // \x00-\x1F \x7F  řídící znaky
  // \u200B-\u200F \u202A-\u202E \u2066-\u2069 \uFEFF  neviditelné
  //   a obousměrné — jimi jde v tabulce převrátit cizí text
  var v = s.replace(
    /[\x00-\x1F\x7F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g,
    '').trim();
  return v.length > (max || 60) ? v.slice(0, max || 60) + '…' : v;
}

function cislo(v, desetinna) {
  if (typeof v !== 'number' || !isFinite(v)) return '–';
  return v.toLocaleString('cs-CZ', {
    minimumFractionDigits: desetinna || 0,
    maximumFractionDigits: desetinna || 0,
  });
}

function obdobiKlic(d) {
  var m = d.getMonth() + 1;
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : String(m));
}

/** fetch s časovým stropem – bez něj se stránka umí zaseknout napořád. */
function sit(url, volby) {
  volby = volby || {};
  var ovladac = new AbortController();
  var casovac = setTimeout(function () { ovladac.abort(); }, TIMEOUT_MS);
  volby.signal = ovladac.signal;
  return fetch(url, volby).then(function (r) {
    clearTimeout(casovac);
    return r;
  }, function (e) {
    clearTimeout(casovac);
    throw e;
  });
}

/* ---------------------------------------------------------------------
   Firestore REST ⇄ obyčejné JS hodnoty
   ---------------------------------------------------------------------
   REST API balí každou hodnotu do obálky podle typu
   (`{"stringValue":"…"}`). Tohle je rozbalí i zabalí, včetně map a polí,
   ať se se strukturou dá pracovat normálně.
--------------------------------------------------------------------- */
function zFirestore(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return !!v.booleanValue;
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
   Relace (přihlášení)
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
  } catch (e) { /* privátní režim – relace prostě nepřežije obnovení */ }
}

/**
 * Platný idToken. Firebase tokeny žijí hodinu, takže se před každým
 * použitím obnoví, když už jim zbývá míň než minuta.
 */
function token() {
  if (!relace) return Promise.reject(new Error('nepřihlášen'));
  if (relace.idToken && relace.vyprsi > Date.now() + 60000) {
    return Promise.resolve(relace.idToken);
  }
  return sit('https://securetoken.googleapis.com/v1/token?key=' + KLIC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=refresh_token&refresh_token=' +
          encodeURIComponent(relace.refreshToken),
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

/** Firestore GET jednoho dokumentu; `null` = neexistuje (404). */
function precti(cesta) {
  return token().then(function (t) {
    return sit(ZAKLAD + '/' + cesta, {
      headers: { Authorization: 'Bearer ' + t },
    });
  }).then(function (r) {
    if (r.status === 404) return null;
    if (r.status === 403) throw new Error('PERMISSION_DENIED');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json().then(dokumentNaObjekt);
  });
}

/** Firestore PATCH (vytvoří i přepíše). `telo` je už zabalené do fields. */
function zapis(cesta, telo) {
  return token().then(function (t) {
    return sit(ZAKLAD + '/' + cesta, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer ' + t,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(telo),
    });
  }).then(function (r) {
    if (r.status === 403) throw new Error('PERMISSION_DENIED');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

function smaz(cesta) {
  return token().then(function (t) {
    return sit(ZAKLAD + '/' + cesta, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + t },
    });
  }).then(function (r) {
    if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status);
    return true;
  });
}

/* ---------------------------------------------------------------------
   Přihlášení přes Google
--------------------------------------------------------------------- */
function prihlasGoogleTokenem(googleIdToken) {
  return sit('https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=' + KLIC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      postBody: 'id_token=' + encodeURIComponent(googleIdToken) +
                '&providerId=google.com',
      requestUri: location.origin,
      returnIdpCredential: true,
      returnSecureToken: true,
    }),
  }).then(function (r) {
    return r.json().then(function (d) {
      if (!r.ok) {
        var kod = (d && d.error && d.error.message) || ('HTTP ' + r.status);
        throw new Error(kod);
      }
      return d;
    });
  }).then(function (d) {
    relace = {
      uid: d.localId,
      idToken: d.idToken,
      refreshToken: d.refreshToken,
      vyprsi: Date.now() + (Number(d.expiresIn || 3600) * 1000),
      jmeno: ocisti(d.displayName || '', 40),
      mail: ocisti(d.email || '', 60),
      foto: (typeof d.photoUrl === 'string' && /^https:\/\//.test(d.photoUrl))
        ? d.photoUrl : '',
    };
    ulozRelaci();
    return relace;
  });
}

function odhlas() {
  relace = null;
  ulozRelaci();
  try {
    if (window.google && google.accounts && google.accounts.id) {
      google.accounts.id.disableAutoSelect();
    }
  } catch (e) { /* nevadí */ }
  vykresli();
}

/* ---------------------------------------------------------------------
   Vykreslení: 1) přihlášení
--------------------------------------------------------------------- */
function vykresliPrihlaseni() {
  var karta = el('kartaPrihlaseni');
  karta.setAttribute('aria-busy', 'false');
  karta.textContent = '';

  if (relace) {
    var profil = prvek('div', 'profil');
    if (relace.foto) {
      var img = document.createElement('img');
      img.src = relace.foto;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', function () { img.remove(); });
      profil.appendChild(img);
    }
    var kdo = prvek('div');
    kdo.appendChild(prvek('div', 'jmeno', relace.jmeno || 'Přihlášen'));
    if (relace.mail) kdo.appendChild(prvek('div', 'mail', relace.mail));
    profil.appendChild(kdo);

    var odhlasit = prvek('button', 'druha', 'Odhlásit se');
    odhlasit.style.marginLeft = 'auto';
    odhlasit.addEventListener('click', odhlas);
    profil.appendChild(odhlasit);
    karta.appendChild(profil);
    return;
  }

  karta.appendChild(prvek('h2', null, 'Přihlášení'));
  karta.appendChild(prvek('p', null,
    'Přihlášení účtem Google slouží jen k tomu, aby web poznal, čí ' +
    'výsledky má ukázat. Do aplikace se přihlašovat nemusíte.'));

  if (!KLIENT_ID) {
    var h = prvek('div', 'hlaska info',
      'Přihlašování se ještě dokončuje – chybí OAuth klient. ' +
      'Žebříček funguje i bez něj.');
    karta.appendChild(h);
    return;
  }

  var misto = prvek('div');
  misto.id = 'googleTlacitko';
  karta.appendChild(misto);
  var chyba = prvek('div', 'hlaska chyba', '');
  chyba.id = 'chybaPrihlaseni';
  chyba.hidden = true;
  karta.appendChild(chyba);

  nasadGoogleTlacitko(misto);
}

function chybaPrihlaseni(text) {
  var e = el('chybaPrihlaseni');
  if (!e) return;
  e.textContent = text;
  e.hidden = false;
}

function nasadGoogleTlacitko(misto) {
  var pripravit = function () {
    try {
      google.accounts.id.initialize({
        client_id: KLIENT_ID,
        callback: function (odpoved) {
          if (!odpoved || !odpoved.credential) {
            chybaPrihlaseni('Google nevrátil přihlašovací údaj. Zkuste to prosím znovu.');
            return;
          }
          prihlasGoogleTokenem(odpoved.credential)
            .then(vykresli)
            .catch(function (e) {
              chybaPrihlaseni(popisChybyPrihlaseni(e));
            });
        },
      });
      google.accounts.id.renderButton(misto, {
        theme: 'outline', size: 'large', shape: 'pill',
        text: 'signin_with', locale: 'cs',
      });
    } catch (e) {
      misto.appendChild(prvek('div', 'hlaska chyba',
        'Přihlašovací tlačítko Googlu se nepodařilo připravit.'));
    }
  };

  if (window.google && google.accounts && google.accounts.id) {
    pripravit();
    return;
  }
  var s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = pripravit;
  s.onerror = function () {
    misto.appendChild(prvek('div', 'hlaska chyba',
      'Nepodařilo se načíst přihlášení Googlu. Zkontrolujte připojení ' +
      'nebo blokování skriptů.'));
  };
  document.head.appendChild(s);
}

function popisChybyPrihlaseni(e) {
  var m = (e && e.message) || '';
  if (/OPERATION_NOT_ALLOWED/.test(m)) {
    return 'Přihlášení Googlem zatím není v projektu zapnuté.';
  }
  if (/INVALID_IDP_RESPONSE|INVALID_ID_TOKEN/.test(m)) {
    return 'Přihlašovací údaj od Googlu se nepodařilo ověřit. Zkuste to znovu.';
  }
  return 'Přihlášení se nepovedlo (' + (m || 'neznámá chyba') + ').';
}

/* ---------------------------------------------------------------------
   Vykreslení: 2) spárování s aplikací
--------------------------------------------------------------------- */
var ucet = null;   // {hrac, spojeno} z kolekce `ucty/{uid}`

function vykresliParovani() {
  var karta = el('kartaParovani');
  var obsah = el('parovaniObsah');
  obsah.textContent = '';
  karta.hidden = !relace;
  if (!relace) return;

  if (ucet && ucet.hrac) {
    obsah.appendChild(prvek('p', null,
      'Web je spárovaný s aplikací. Vaše výsledky se načítají níž.'));
    var odpojit = prvek('button', 'druha', 'Odpojit aplikaci');
    odpojit.addEventListener('click', function () {
      odpojit.disabled = true;
      smaz('ucty/' + relace.uid).then(function () {
        ucet = null;
        vykresli();
      }).catch(function () {
        odpojit.disabled = false;
        obsah.appendChild(prvek('div', 'hlaska chyba',
          'Odpojení se nepovedlo. Zkuste to prosím za chvíli.'));
      });
    });
    obsah.appendChild(odpojit);
    return;
  }

  obsah.appendChild(prvek('p', null,
    'V aplikaci otevřete Více → Můj Okolník → Spárovat s webem. ' +
    'Zobrazí se šestimístný kód, který platí 15 minut – opište ho sem.'));

  var radek = prvek('div', 'radek');
  var vstup = document.createElement('input');
  vstup.type = 'text';
  vstup.id = 'kod';
  vstup.maxLength = 7;              // 6 znaků + případná mezera při vkládání
  vstup.autocomplete = 'one-time-code';
  vstup.setAttribute('aria-label', 'Párovací kód z aplikace');
  vstup.placeholder = 'ABC123';
  radek.appendChild(vstup);

  var tlacitko = prvek('button', null, 'Spárovat');
  radek.appendChild(tlacitko);
  obsah.appendChild(radek);

  var hlaska = prvek('div', 'hlaska chyba', '');
  hlaska.hidden = true;
  obsah.appendChild(hlaska);

  var rekni = function (text, druh) {
    hlaska.className = 'hlaska ' + (druh || 'chyba');
    hlaska.textContent = text;
    hlaska.hidden = false;
  };

  var spustit = function () {
    var kod = String(vstup.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (kod.length !== 6) {
      rekni('Kód má šest znaků – písmena a číslice.');
      return;
    }
    tlacitko.disabled = true;
    hlaska.hidden = true;
    sparuj(kod).then(function () {
      vykresli();
    }).catch(function (e) {
      tlacitko.disabled = false;
      rekni(popisChybyParovani(e));
    });
  };

  tlacitko.addEventListener('click', spustit);
  vstup.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); spustit(); }
  });
}

function sparuj(kod) {
  return precti('parovani/' + kod).then(function (d) {
    if (!d || !d.hrac) throw new Error('NENALEZEN');
    if (d.plati) {
      var doKdy = Date.parse(d.plati);
      if (isFinite(doKdy) && doKdy < Date.now()) throw new Error('VYPRSEL');
    }
    // ⚠️ `kod` SE MUSÍ ULOŽIT S SEBOU. Pravidlo u `ucty/{uid}` si
    // přes něj ověřuje, že vazba vznikla ze živé párovací karty — bez
    // toho by stačilo opsat cizí `hrac` ze žebříčku (id dokumentu je
    // veřejné) a číst cizí profil.
    // ⛔ A proto se karta maže AŽ POTÉ, co je vazba zapsaná.
    return zapis('ucty/' + relace.uid, {
      fields: {
        hrac: { stringValue: d.hrac },
        kod: { stringValue: kod },
        spojeno: { timestampValue: new Date().toISOString() },
      },
    }).then(function () {
      ucet = { hrac: d.hrac };
      // kód je jednorázový; když se smazat nepovede, sám vyprší
      return smaz('parovani/' + kod).catch(function () { return true; });
    });
  });
}

function popisChybyParovani(e) {
  var m = (e && e.message) || '';
  if (m === 'NENALEZEN') {
    return 'Takový kód neznáme. Zkontrolujte ho, nebo si v aplikaci ' +
           'nechte vygenerovat nový.';
  }
  if (m === 'VYPRSEL') {
    return 'Kód už vypršel. Nechte si v aplikaci vygenerovat nový.';
  }
  if (m === 'PERMISSION_DENIED') {
    return 'Párování zatím není na serveru povolené.';
  }
  return 'Spárování se nepovedlo (' + (m || 'neznámá chyba') + ').';
}

/* ---------------------------------------------------------------------
   Vykreslení: 3) moje výsledky
--------------------------------------------------------------------- */
function vykresliVysledky() {
  var karta = el('kartaVysledky');
  var box = el('vysledky');
  karta.hidden = !(relace && ucet && ucet.hrac);
  if (karta.hidden) return;

  box.textContent = '';
  var stav = prvek('div', 'stav');
  stav.appendChild(prvek('div', 'tocka'));
  stav.appendChild(prvek('p', null, 'Načítám vaše výsledky…'));
  box.appendChild(stav);

  var obdobi = obdobiKlic(new Date());
  Promise.all([
    precti('hraci/' + ucet.hrac).catch(function () { return null; }),
    precti('zebricek/' + ucet.hrac + '_' + obdobi).catch(function () { return null; }),
  ]).then(function (v) {
    vypisVysledky(v[0], v[1], obdobi);
  }).catch(function () {
    box.textContent = '';
    box.appendChild(stavovaKarta('Výsledky se nepovedlo načíst',
      'Zkuste stránku za chvíli obnovit.'));
  });
}

function stavovaKarta(nadpis, text) {
  var s = prvek('div', 'stav');
  s.appendChild(prvek('h2', null, nadpis));
  s.appendChild(prvek('p', null, text));
  return s;
}

function vypisVysledky(hrac, mesic, obdobi) {
  var box = el('vysledky');
  box.textContent = '';

  if (!hrac && !mesic) {
    box.appendChild(stavovaKarta('Zatím tu nic není',
      'Aplikace ještě neposlala žádná data. Otevřete Okolník ' +
      'v telefonu – profil se odešle při nejbližší příležitosti.'));
    return;
  }

  if (hrac && hrac.prezdivka) {
    var h = prvek('h3', null, ocisti(hrac.prezdivka, 30));
    box.appendChild(h);
  }

  var souhrn = (hrac && hrac.souhrn) || {};
  var dlazdice = [
    ['Úroveň', souhrn.uroven, 0],
    ['Ušlé km', souhrn.km, 1],
    ['Obce', souhrn.obce, 0],
    ['Doložené návštěvy', souhrn.navstevy, 0],
    ['Fotovýpravy', souhrn.vypravy, 0],
    ['Aktivní dny', souhrn.dny, 0],
  ].filter(function (d) { return typeof d[1] === 'number'; });

  if (dlazdice.length) {
    var mrizka = prvek('div', 'cisla');
    dlazdice.forEach(function (d) {
      var k = prvek('div', 'cislo');
      k.appendChild(prvek('div', 'h', cislo(d[1], d[2])));
      k.appendChild(prvek('div', 'p', d[0]));
      mrizka.appendChild(k);
    });
    box.appendChild(mrizka);
  }

  if (mesic) {
    box.appendChild(prvek('h3', null, 'Tento měsíc (' + obdobi + ')'));
    var m = prvek('div', 'cisla');
    [['Ušlé km', mesic.km, 1], ['Nové obce', mesic.obce, 0],
     ['Fotovýpravy', mesic.vypravy, 0]].forEach(function (d) {
      if (typeof d[1] !== 'number') return;
      var k = prvek('div', 'cislo');
      k.appendChild(prvek('div', 'h', cislo(d[1], d[2])));
      k.appendChild(prvek('div', 'p', d[0]));
      m.appendChild(k);
    });
    box.appendChild(m);
    var odkaz = prvek('p');
    var a = document.createElement('a');
    a.href = '/zebricek';
    a.textContent = 'Zobrazit celý žebříček';
    odkaz.appendChild(a);
    box.appendChild(odkaz);
  }

  var rekordy = (hrac && hrac.rekordy) || [];
  if (Array.isArray(rekordy) && rekordy.length) {
    box.appendChild(prvek('h3', null, 'Osobní rekordy'));
    var ur = prvek('ul', 'seznam');
    rekordy.slice(0, 20).forEach(function (r) {
      if (!r || !r.nazev) return;
      var li = prvek('li');
      li.appendChild(prvek('span', 'nazev', ocisti(r.nazev, 50)));
      var h = typeof r.hodnota === 'number'
        ? cislo(r.hodnota, r.desetinna || 0) + (r.jednotka ? ' ' + ocisti(r.jednotka, 8) : '')
        : ocisti(String(r.hodnota || ''), 24);
      li.appendChild(prvek('span', 'hodnota', h));
      ur.appendChild(li);
    });
    box.appendChild(ur);
  }

  var uspechy = (hrac && hrac.uspechy) || [];
  if (Array.isArray(uspechy) && uspechy.length) {
    var hotovo = uspechy.filter(function (u) { return u && u.hotovo; }).length;
    box.appendChild(prvek('h3', null,
      'Úspěchy (' + hotovo + ' z ' + uspechy.length + ')'));
    var uu = prvek('ul', 'seznam');
    uspechy.slice(0, 200).forEach(function (u) {
      if (!u || !u.nazev) return;
      var li = prvek('li', u.hotovo ? '' : 'nehotovo');
      var text = prvek('div');
      text.appendChild(prvek('div', 'nazev',
        (u.hotovo ? '✓ ' : '') + ocisti(u.nazev, 60)));
      if (u.popis) text.appendChild(prvek('div', 'popis', ocisti(u.popis, 120)));
      li.appendChild(text);
      if (typeof u.stupen === 'number' && u.stupen > 0) {
        li.appendChild(prvek('span', 'hodnota', 'stupeň ' + u.stupen));
      }
      uu.appendChild(li);
    });
    box.appendChild(uu);
  }

  if (hrac && hrac.aktualizovano) {
    var kdy = new Date(hrac.aktualizovano);
    if (!isNaN(kdy)) {
      box.appendChild(prvek('p', 'podtitul',
        'Naposledy odesláno z aplikace: ' + kdy.toLocaleString('cs-CZ')));
    }
  }
}

/* ---------------------------------------------------------------------
   Sešití dohromady
--------------------------------------------------------------------- */
function vykresli() {
  vykresliPrihlaseni();
  vykresliParovani();
  vykresliVysledky();
}

function start() {
  relace = nactiRelaci();
  if (!relace) { vykresli(); return; }

  // ověřit, že uložená relace ještě žije, a rovnou zjistit spárování
  token().then(function () {
    return precti('ucty/' + relace.uid).catch(function () { return null; });
  }).then(function (d) {
    ucet = (d && d.hrac) ? d : null;
    vykresli();
  }).catch(function () {
    relace = null;      // refresh token neplatí (odvolaný účet, změna hesla…)
    ulozRelaci();
    vykresli();
  });
}

document.addEventListener('DOMContentLoaded', start);
