/* ⭐ OKOLNÍK – WEBOVÝ REŽIM ENGINU (`?web=1`), 5. 9. 2026.
 *
 * Tatáž herní mapa jako v aplikaci, jen na okolnik.cz/mapa/. Stav hry se
 * bere ze synchronizace pod účtem (Firestore hraci/{uid}/sync/stav +
 * cast0…N, gzip JSON – viz app lib/sync.dart), relace je SDÍLENÁ s Můj
 * Okolník (localStorage `okolnikUcet1`, stejný origin). Bez přihlášení
 * zůstane mapa v mlze a dole je výzva k přihlášení.
 *
 * Co web umí a co ne (v1):
 *  • odkryté buňky mlhy (kotouče 232 m jako v aplikaci), trasy fotovýprav,
 *    malovaná místa z assets/ilustrace.json (455), počasí a světlo si
 *    engine stahuje sám (pocasi.js), styly jde přepínat chipy vlevo;
 *  • NEUMÍ: vybarvení dokončených obcí (web nemá jejich polygony),
 *    barevné „navštívené" kresby (web nezná id míst z databáze),
 *    buňky autem (v synchronizaci nejsou) – všechno kreslí plným kotoučem.
 *
 * Skript se načte jen s `?web=1` (zavaděč v index.html), po main.js;
 * sahá na globály enginu (`mapa`, `OkolnikMost`, `Mlha`).
 */
(function () {
  'use strict';
  if (new URLSearchParams(location.search).get('web') !== '1') return;

  var PROJEKT = 'sarcher-b32a1';
  var KLIC = 'AIzaSyB3sj8qS-Lh4lHow6AUrWH-JayEtJ70igQ';
  var ZAKLAD = 'https://firestore.googleapis.com/v1/projects/' + PROJEKT +
    '/databases/(default)/documents';
  var ULOZISTE = 'okolnikUcet1';
  var KLIC_UID = 'okolnik.web.uid';      // čí mlha leží v localStorage
  var TIMEOUT_MS = 20000;
  var BUNKA = 0.0018;                    // TrailStore.cell (stupně)
  var KOTOUC_KM = 160 * 1.45 / 1000;     // uncoverMeters × haloFactor
  var relace = null;
  // sdílený stav pro web-ui.js (kresby, stav ze synchronizace, posluchači)
  var W = window.OkolnikWeb = window.OkolnikWeb || {};
  W.kresby = W.kresby || [];
  W.stav = W.stav || null;
  W.naStav = W.naStav || [];

  /* ───────────── vzhled ───────────── */
  function css() {
    var s = document.createElement('style');
    s.id = 'okolnik-web-css';
    s.textContent =
      '#mlha-ovladani,#nav-prepinac,#nav-profil-vyber,#nav-prolet,' +
      '#nav-zrusit,#nav-info,#nav-graf{display:none !important}' +
      '#znacka a{color:#F2E8CF;text-decoration:underline}' +
      '#web-karta{position:absolute;left:50%;bottom:34px;' +
      'transform:translateX(-50%);z-index:12;max-width:min(560px,90vw);' +
      'background:rgba(242,232,207,0.96);color:#1d2624;border-radius:12px;' +
      'padding:12px 16px;font:14px/1.45 system-ui,sans-serif;' +
      'box-shadow:0 6px 24px rgba(0,0,0,0.25)}' +
      '#web-karta b{display:block;color:#0D2B2E;margin-bottom:4px}' +
      '#web-karta a{color:#2E7D5B;font-weight:600}' +
      '#web-karta .zavrit{position:absolute;right:6px;top:2px;border:0;' +
      'background:none;font-size:18px;cursor:pointer;color:#55605d}';
    document.head.appendChild(s);
    var zn = document.getElementById('znacka');
    if (zn) {
      zn.innerHTML = '<b>OKOLNÍK</b><small>moje herní mapa · ' +
        '<a href="/objevitel/">zpět na okolnik.cz</a></small>';
    }
  }

  function karta(nadpis, text, odkaz, odkazText, samaZmizi) {
    var stara = document.getElementById('web-karta');
    if (stara) stara.remove();
    var k = document.createElement('div');
    k.id = 'web-karta';
    var b = document.createElement('b');
    b.textContent = nadpis;
    k.appendChild(b);
    k.appendChild(document.createTextNode(text + ' '));
    if (odkaz) {
      var a = document.createElement('a');
      a.href = odkaz;
      a.textContent = odkazText;
      k.appendChild(a);
    }
    var z = document.createElement('button');
    z.className = 'zavrit';
    z.textContent = '×';
    z.title = 'Zavřít';
    z.onclick = function () { k.remove(); };
    k.appendChild(z);
    document.body.appendChild(k);
    if (samaZmizi) setTimeout(function () { k.remove(); }, 9000);
  }

  /* ───────────── relace a Firestore (jako rezimy/rezim.js) ───────────── */
  function sit(url, volby) {
    volby = volby || {};
    var ovladac = ('AbortController' in window) ? new AbortController() : null;
    var casovac = setTimeout(function () { if (ovladac) ovladac.abort(); },
      TIMEOUT_MS);
    if (ovladac) volby.signal = ovladac.signal;
    return fetch(url, volby).then(function (r) {
      clearTimeout(casovac);
      return r;
    }, function (e) {
      clearTimeout(casovac);
      throw e;
    });
  }

  function zFirestore(v) {
    if (!v || typeof v !== 'object') return null;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('booleanValue' in v) return !!v.booleanValue;
    if ('timestampValue' in v) return v.timestampValue;
    if ('bytesValue' in v) return v.bytesValue;
    return null;
  }

  function dokumentNaObjekt(doc) {
    var o = {}, pole = (doc && doc.fields) || {};
    for (var k in pole) {
      if (Object.prototype.hasOwnProperty.call(pole, k)) o[k] = zFirestore(pole[k]);
    }
    return o;
  }

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

  function zBase64(s) {
    var b = atob(s || ''), u = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return u;
  }

  function rozbal(bajty) {
    if (!('DecompressionStream' in window)) {
      return Promise.reject(new Error('Prohlížeč neumí rozbalit data, zkuste novější.'));
    }
    var ds = new DecompressionStream('gzip');
    var w = ds.writable.getWriter();
    w.write(bajty);
    w.close();
    return new Response(ds.readable).text();
  }

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

  /* ───────────── stav hry → engine ───────────── */
  function bunkyNaBody(cells) {
    var body = [];
    (cells || []).forEach(function (k) {
      var p = String(k).split(':');
      var a = parseInt(p[0], 10), b = parseInt(p[1], 10);
      if (isNaN(a) || isNaN(b)) return;
      body.push([(a + 0.5) * BUNKA, (b + 0.5) * BUNKA, KOTOUC_KM]);
    });
    return body;
  }

  function aplikuj(stav) {
    W.stav = stav;
    W.naStav.forEach(function (f) { try { f(stav); } catch (e) { } });
    var body = bunkyNaBody(stav.trailCells);
    // cizí mlha z minulého účtu v tomhle prohlížeči → pryč
    var minulyUid = null;
    try { minulyUid = localStorage.getItem(KLIC_UID); } catch (e) { }
    if (minulyUid !== relace.uid && typeof Mlha !== 'undefined' && Mlha.reset) {
      try { Mlha.reset(); } catch (e) { console.warn('[web] reset mlhy', e); }
      try { localStorage.setItem(KLIC_UID, relace.uid); } catch (e) { }
    }
    if (body.length) OkolnikMost.objevDavka(body);
    var trasy = (stav.trips || []).map(function (t) {
      return (t.track || []).map(function (b) { return [b.la, b.lo]; })
        .filter(function (b) { return isFinite(b[0]) && isFinite(b[1]); });
    }).filter(function (t) { return t.length >= 2; });
    if (trasy.length) OkolnikMost.vypravy(trasy);
    // kamera na poslední odkrytou buňku (pořadí buněk = pořadí odkrytí).
    // ⚠️ `OkolnikMost.letNa` tu nedržel (usazování kamery enginu ho
    // přebilo), přímý `jumpTo` drží – ověřeno 5. 9. v náhledu
    if (body.length) {
      var p = body[body.length - 1];
      var skok = function () {
        try { mapa.jumpTo({ center: [p[1], p[0]], zoom: 12.2 }); } catch (e) { }
      };
      skok();
      setTimeout(skok, 1500);
    }
    var kdy = stav._hlavicka && stav._hlavicka.aktualizovano
      ? new Date(stav._hlavicka.aktualizovano) : null;
    karta('Vaše mapa',
      'Odkryto ' + body.length + ' buněk, ' + trasy.length + ' fotovýprav' +
      (kdy && !isNaN(kdy.getTime())
        ? ' · stav z ' + kdy.getDate() + '. ' + (kdy.getMonth() + 1) + '. ' +
          kdy.getFullYear() : '') +
      '. Vidíte to jen vy.', null, null, true);
  }

  /* malovaná místa – z indexu ilustrací (455), id = slug */
  function mista() {
    return fetch('assets/ilustrace.json').then(function (r) { return r.json(); })
      .then(function (seznam) {
        var pole = (seznam || []).filter(function (m) {
          return m && m.s && isFinite(m.lat) && isFinite(m.lon);
        }).map(function (m) {
          return { id: m.s, lat: m.lat, lng: m.lon, b: '#2e7d5b', ik: m.s, t: m.n || '' };
        });
        // engine „rodí" nová místa po jednom (180 ms) – pro appku správně
        // (posílá pár míst z výřezu), tady by 455 kreseb naskakovalo přes
        // minutu; označit je za známá, ať se vykreslí naráz
        try {
          if (typeof vykresliMista === 'function') {
            vykresliMista._znama = new Set(pole.map(function (m) { return String(m.id); }));
          }
        } catch (e) { }
        W.kresby = pole;
        OkolnikMost.mista(pole);
        console.log('[web] místa:', pole.length);
      }).catch(function (e) { console.warn('[web] místa', e); });
  }

  /* ───────────── start ───────────── */
  function cekejNaMapu(cb) {
    var pokusy = 0;
    (function tik() {
      var hotovo = false;
      try {
        // ⚠️ `isStyleLoaded()` je skoro nikdy true (čeká i na obrázky
        // vzorů a dlaždice) – stačí načtený styl (interní `_loaded`)
        hotovo = typeof mapa !== 'undefined' && mapa &&
          typeof OkolnikMost !== 'undefined' &&
          ((mapa.style && mapa.style._loaded) ||
            (mapa.isStyleLoaded && mapa.isStyleLoaded()));
      } catch (e) { hotovo = false; }
      if (hotovo) { cb(); return; }
      if (++pokusy > 600) { console.warn('[web] mapa se nenačetla'); return; }
      setTimeout(tik, 250);
    })();
  }

  /* chip stylu vlevo má odpovídat skutečnému stylu (?styl=herni) */
  function oznacStyl() {
    try {
      var kod = typeof aktualniKod !== 'undefined' ? aktualniKod : 'zakladni';
      document.querySelectorAll('#styly button').forEach(function (b) {
        b.classList.toggle('aktivni', b.dataset.styl === kod);
      });
    } catch (e) { }
  }

  function start() {
    css();
    cekejNaMapu(function () {
      // ⚠️ plátno mapy se měří při startu; ve skryté kartě prohlížeče
      // bylo 400×300 a noční překryv pak seděl jen v rohu – přepočítat
      try { mapa.resize(); } catch (e) { }
      window.addEventListener('resize', function () {
        try { mapa.resize(); } catch (e) { }
      });
      oznacStyl();
      mista();
      relace = nactiRelaci();
      if (!relace) {
        karta('Vaše mapa po přihlášení',
          'Přihlaste se stejným účtem jako v aplikaci a mapa ukáže, co jste ' +
          'odkryli. Aplikace stav ukládá pod účet od verze 1.608.',
          '/ucet/', 'Přihlásit se na Můj Okolník');
        return;
      }
      token().then(stahniStav).then(function (stav) {
        if (!stav) {
          karta('Zatím žádná mapa',
            'Aplikace pošle stav hry po přihlášení a po každé procházce. ' +
            'Ručně: Více → Můj Okolník → Synchronizovat teď.');
          return;
        }
        aplikuj(stav);
      }).catch(function (e) {
        console.warn('[web] stav', e);
        var zprava = String((e && e.message) || e);
        if (zprava === 'obnova tokenu selhala' || zprava === 'nepřihlášen') {
          relace = null;
          ulozRelaci();
          karta('Přihlášení vypršelo', 'Přihlaste se znovu.', '/ucet/',
            'Můj Okolník');
        } else {
          karta('Mapu se nepovedlo načíst', zprava);
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
