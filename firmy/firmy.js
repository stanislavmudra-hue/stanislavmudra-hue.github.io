/* Okolník pro firmy – správa STRÁNKY OVĚŘENÉHO PODNIKU (1.613.152, fáze 1).
   Majitel (účet, pod kterým v aplikaci objednal zvýraznění) tu mění:
   - hned: otevírací dobu, vlastnosti, aktualitu, telefon a web (Firestore `podniky/{id}`,
     pravidla v17 dovolí majiteli jen tato pole),
   - po schválení správcem: název, popis, tři důvody a fotky (`podniky_zmeny/{id}`),
   a vidí měsíční návštěvnost stránky (`podniky/{id}/stat/{RRRR-MM}`, anonymní počítadla appky).
   Přihlášení sdílí s Můj Okolník (localStorage okolnikUcet1). */
(function () {
  'use strict';
  var PROJEKT = 'sarcher-b32a1';
  var KLIC = 'AIzaSyB3sj8qS-Lh4lHow6AUrWH-JayEtJ70igQ';
  var ZAKLAD = 'https://firestore.googleapis.com/v1/projects/' + PROJEKT + '/databases/(default)/documents/';
  var LIVE_URL = 'https://raw.githubusercontent.com/stanislavmudra-hue/Sarcher-data/main/live.json';
  var VLASTNOSTI = [
    ['psi', 'Psi vítáni'], ['kola', 'Stojan na kola'], ['nabijeni', 'Nabití elektrokola'],
    ['voda', 'Voda do lahve'], ['wc', 'WC pro hosty'], ['deti', 'Dětský koutek'],
    ['terasa', 'Posezení venku'], ['karta', 'Platba kartou'], ['bezbar', 'Bezbariérový vstup'],
    ['parkovani', 'Parkování'], ['wifi', 'Wi-Fi'], ['jidlo', 'Teplá jídla'],
  ];
  var DNY = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];
  var DNY_OSM = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  var DNY_VE = ['v pondělí', 'v úterý', 've středu', 've čtvrtek', 'v pátek', 'v sobotu', 'v neděli'];

  var el = function (id) { return document.getElementById(id); };
  var podniky = [], podnik = null, zmena = null, fotkyNove = [], fotkyPryc = {};

  /* ---------------------------------------------------------------- přihlášení a Firestore REST */
  function nactiRelaci() {
    try { var s = localStorage.getItem('okolnikUcet1'); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function platnyToken() {
    var r = nactiRelaci();
    if (!r) return Promise.reject(new Error('bez přihlášení'));
    if (r.idToken && r.vyprsi > Date.now() + 60000) return Promise.resolve(r.idToken);
    return fetch('https://securetoken.googleapis.com/v1/token?key=' + KLIC, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(r.refreshToken),
    }).then(function (o) { return o.json(); }).then(function (d) {
      if (!d.id_token) throw new Error('obnova přihlášení selhala');
      r.idToken = d.id_token; r.refreshToken = d.refresh_token || r.refreshToken;
      r.vyprsi = Date.now() + (parseInt(d.expires_in, 10) || 3600) * 1000;
      try { localStorage.setItem('okolnikUcet1', JSON.stringify(r)); } catch (e) { /* nic */ }
      return r.idToken;
    });
  }
  function cti(v) {
    if (!v || typeof v !== 'object') return null;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return parseInt(v.integerValue, 10);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('booleanValue' in v) return v.booleanValue;
    if ('timestampValue' in v) return v.timestampValue;
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(cti);
    if ('mapValue' in v) { var m = {}, f = v.mapValue.fields || {}; for (var k in f) m[k] = cti(f[k]); return m; }
    return null;
  }
  function ven(v) {
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return (v % 1 === 0) ? { integerValue: String(v) } : { doubleValue: v };
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(ven) } };
    return { stringValue: String(v) };
  }
  function dokument(doc) {
    var d = { _id: String(doc.name || '').split('/').pop() }, f = doc.fields || {};
    for (var k in f) d[k] = cti(f[k]);
    return d;
  }
  function ctiDoc(cesta, token) {
    return fetch(ZAKLAD + cesta + '?key=' + KLIC, { headers: token ? { Authorization: 'Bearer ' + token } : {} })
      .then(function (r) { if (r.status === 404) return null; if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (doc) { return doc ? dokument(doc) : null; });
  }
  /* PATCH s maskou: pole v `data` se zapíšou, pole v `smazat` (jen v masce) se odstraní */
  function zapisPole(cesta, data, smazat, celyDokument) {
    return platnyToken().then(function (token) {
      var url = ZAKLAD + cesta + '?key=' + KLIC, f = {};
      if (!celyDokument) {
        Object.keys(data).concat(smazat || []).forEach(function (k) { url += '&updateMask.fieldPaths=' + k; });
      }
      for (var k in data) f[k] = ven(data[k]);
      return fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
                          body: JSON.stringify({ fields: f }) });
    }).then(function (o) { if (!o.ok) throw new Error('HTTP ' + o.status); return true; });
  }
  function smazDoc(cesta) {
    return platnyToken().then(function (token) {
      return fetch(ZAKLAD + cesta + '?key=' + KLIC, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
    }).then(function (o) { if (!o.ok) throw new Error('HTTP ' + o.status); return true; });
  }
  function mojePodniky(uid, token) {
    var telo = { structuredQuery: { from: [{ collectionId: 'podniky' }],
      where: { fieldFilter: { field: { fieldPath: 'vlastnik' }, op: 'EQUAL', value: { stringValue: uid } } }, limit: 20 } };
    return fetch(ZAKLAD.slice(0, -1) + ':runQuery?key=' + KLIC, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(telo),
    }).then(function (o) { return o.json(); }).then(function (v) {
      return (v || []).filter(function (r) { return r.document; }).map(function (r) { return dokument(r.document); });
    });
  }

  /* ---------------------------------------------------------------- otevírací doba (zápis OSM, jako appka) */
  function minuty(t) { var m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null; }
  function hhmm(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
  function rozloz(oh) {
    var s = String(oh || '').trim();
    if (!s) return null;
    var dny = {}, i;
    if (s === '24/7') { for (i = 0; i < 7; i++) dny[i] = [[0, 1440]]; return dny; }
    var pravidla = s.split(';');
    for (var p = 0; p < pravidla.length; p++) {
      var r = pravidla[p].trim(); if (!r) continue;
      var m = /^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:\s*,\s*(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:\s*-\s*(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)\s+(.*)$/.exec(r);
      var seznam = [], zbytek = r;
      if (m) {
        zbytek = m[2].trim();
        m[1].split(',').forEach(function (cast) {
          var k = cast.trim().split(/\s*-\s*/), a = DNY_OSM.indexOf(k[0]), b = DNY_OSM.indexOf(k[1] || k[0]);
          for (var d = a; ; d = (d + 1) % 7) { seznam.push(d); if (d === b) break; }
        });
      } else { seznam = [0, 1, 2, 3, 4, 5, 6]; }
      if (zbytek === 'off' || zbytek === 'closed') { seznam.forEach(function (d) { dny[d] = []; }); continue; }
      var iv = [];
      var casti = zbytek.split(',');
      for (var c = 0; c < casti.length; c++) {
        var t = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(casti[c].trim());
        if (!t) return null;
        var od = minuty(t[1]), doo = minuty(t[2]); if (doo === 0) doo = 1440;
        iv.push([od, doo]);
      }
      seznam.forEach(function (d) { dny[d] = iv.map(function (x) { return x.slice(); }); });
    }
    return dny;
  }
  function sloz(dny) {
    var casti = dny.map(function (iv) { return iv.length ? iv.map(function (i) { return hhmm(i[0]) + '-' + hhmm(i[1]); }).join(',') : 'off'; });
    if (casti.every(function (c) { return c === '00:00-24:00'; })) return '24/7';
    var out = [], i = 0;
    while (i < 7) {
      var j = i; while (j + 1 < 7 && casti[j + 1] === casti[i]) j++;
      out.push((i === j ? DNY_OSM[i] : DNY_OSM[i] + '-' + DNY_OSM[j]) + ' ' + casti[i]); i = j + 1;
    }
    return out.join('; ');
  }
  function stavOtevreni(oh, ted) {
    var dny = rozloz(oh); if (!dny) return null;
    var d = (ted.getDay() + 6) % 7, m = ted.getHours() * 60 + ted.getMinutes();
    var dnes = dny[d] || [];
    for (var i = 0; i < dnes.length; i++) if (m >= dnes[i][0] && m < dnes[i][1]) return { otevreno: true, text: 'Otevřeno · zavírá v ' + hhmm(dnes[i][1]).replace(/^0/, '') };
    for (var posun = 0; posun < 8; posun++) {
      var den = (d + posun) % 7, iv = (dny[den] || []).slice().sort(function (a, b) { return a[0] - b[0]; });
      for (var k = 0; k < iv.length; k++) {
        if (posun === 0 && iv[k][0] <= m) continue;
        var cas = hhmm(iv[k][0]).replace(/^0/, '');
        return { otevreno: false, text: 'Zavřeno · otevírá ' + (posun === 0 ? 'v ' + cas : posun === 1 ? 'zítra v ' + cas : DNY_VE[den] + ' v ' + cas) };
      }
    }
    return { otevreno: false, text: 'Zavřeno' };
  }

  /* ---------------------------------------------------------------- vykreslení */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function zprava(id, text, chyba) { var z = el(id); if (z) { z.textContent = text; z.style.color = chyba ? '#b3261e' : '#2e7d32'; } }

  function start() {
    var box = el('mujPodnik');
    var relace = nactiRelaci();
    if (!relace || !relace.uid) {
      box.hidden = false;
      el('podnikObsah').innerHTML = '<p>Máte podnik zvýrazněný v aplikaci? <a href="/ucet/">Přihlaste se</a> stejným účtem, '
        + 'pod kterým jste zvýraznění objednali, a upravte jeho stránku – fotky, akce, otevírací dobu a uvidíte i návštěvnost.</p>';
      return;
    }
    platnyToken().then(function (token) { return mojePodniky(relace.uid, token); }).then(function (seznam) {
      podniky = seznam;
      box.hidden = false;
      if (!seznam.length) {
        el('podnikObsah').innerHTML = '<p class="drobne">Pod účtem ' + esc(relace.mail || '') + ' zatím žádnou stránku podniku nemáte. '
          + 'Stránka vznikne se schválením zvýraznění objednaného v aplikaci (níže, Jak objednat).</p>';
        return;
      }
      vyberPodnik(seznam[0]._id);
    }).catch(function (e) {
      box.hidden = false;
      el('podnikObsah').innerHTML = '<p class="drobne">Stránky podniků se nepodařilo načíst (' + esc(e.message) + '). Zkuste to prosím později.</p>';
    });
  }

  function vyberPodnik(id) {
    podnik = podniky.filter(function (p) { return p._id === id; })[0];
    fotkyNove = []; fotkyPryc = {};
    platnyToken().then(function (token) {
      return Promise.all([ctiDoc('podniky_zmeny/' + id, token).catch(function () { return null; }), nactiStatistiky(id, token), nactiZvyrazneni(podnik.misto || id)]);
    }).then(function (v) {
      zmena = v[0];
      vykresliEditor(v[1], v[2]);
    });
  }

  function nactiZvyrazneni(mistoId) {
    return fetch(LIVE_URL + '?t=' + Math.floor(Date.now() / 600000)).then(function (r) { return r.json(); }).then(function (j) {
      var e = ((j.promoted || {}).places || []).filter(function (x) { return x.id === mistoId; })[0];
      return e ? e.until : null;
    }).catch(function () { return undefined; });
  }

  function nactiStatistiky(id, token) {
    var d = new Date(), mesice = [];
    for (var i = 0; i < 3; i++) { var x = new Date(d.getFullYear(), d.getMonth() - i, 1); mesice.push(x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0')); }
    return Promise.all(mesice.map(function (m) {
      return ctiDoc('podniky/' + id + '/stat/' + m, token).then(function (s) { return { mesic: m, s: s || {} }; }).catch(function () { return { mesic: m, s: {} }; });
    }));
  }

  function vykresliEditor(stat, zvyrazneniDo) {
    var p = podnik, h = [];
    if (podniky.length > 1) {
      h.push('<p><label>Podnik <select id="pVyber">' + podniky.map(function (x) {
        return '<option value="' + esc(x._id) + '"' + (x._id === p._id ? ' selected' : '') + '>' + esc(x.nazev || x._id) + '</option>'; }).join('') + '</select></label></p>');
    }
    var plati = zvyrazneniDo && new Date(zvyrazneniDo + 'T23:59:59') > new Date();
    h.push('<div class="karta" style="margin:10px 0"><h3 style="margin:0 0 4px">' + esc(p.nazev || 'Stránka podniku') + '</h3>'
      + '<p class="drobne" style="margin:0">' + (zvyrazneniDo === undefined ? 'Stav zvýraznění se nepodařilo zjistit.'
        : plati ? 'Zvýraznění platí do ' + esc(new Date(zvyrazneniDo).toLocaleDateString('cs-CZ')) + ' – stránku vidí uživatelé aplikace.'
          : '⚠️ Zvýraznění neplatí – stránka se v aplikaci neukazuje. Prodloužíte ho v aplikaci (Více → Okolník Premium → Zvýraznit svůj podnik).') + '</p>'
      + '<div id="pNahled" style="margin-top:10px"></div></div>');

    // návštěvnost
    h.push('<h3>Návštěvnost stránky</h3><div style="overflow-x:auto"><table class="tabulka" style="width:100%;border-collapse:collapse;font-size:.95rem">'
      + '<thead><tr><th style="text-align:left">Měsíc</th><th>Otevření</th><th>Trasa</th><th>Volání</th><th>Web</th><th>Sdílení</th></tr></thead><tbody>'
      + stat.map(function (r) {
        var s = r.s, t = function (k) { return '<td style="text-align:center">' + (s[k] || 0) + '</td>'; };
        return '<tr><td>' + esc(r.mesic) + '</td>' + t('otevreni') + t('trasa') + t('volani') + t('web') + t('sdileni') + '</tr>';
      }).join('') + '</tbody></table></div>'
      + '<p class="drobne">Anonymní souhrnné počty z aplikace – z jednoho telefonu nejvýš jednou denně za každou akci.</p>');

    // rychlé úpravy
    h.push('<h3>Hned v aplikaci</h3><p class="drobne">Otevírací doba, vlastnosti, aktualita, telefon a web se projeví hned po uložení.</p>');
    h.push('<div id="pHodiny"></div>');
    h.push('<p style="margin:12px 0 4px"><strong>Vlastnosti</strong></p><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:4px">'
      + VLASTNOSTI.map(function (v) {
        return '<label><input type="checkbox" class="pVl" value="' + v[0] + '"' + ((p.vlastnosti || []).indexOf(v[0]) >= 0 ? ' checked' : '') + '> ' + esc(v[1]) + '</label>';
      }).join('') + '</div>');
    var akt = p.aktualitaDo ? new Date(p.aktualitaDo) : null;
    var aktPlati = p.aktualita && (!akt || akt > new Date());
    var vychoziDo = new Date(); vychoziDo.setHours(23, 59, 0, 0);
    h.push('<p style="margin:12px 0 4px"><strong>Aktualita</strong> <span class="drobne">(krátká zpráva nahoře na stránce – např. „Dnes švestkové koláče“, „Do 10. 10. dovolená“)</span></p>'
      + '<input id="pAkt" maxlength="140" style="width:100%;padding:6px" placeholder="Dnes čerstvé švestkové koláče" value="' + esc(aktPlati ? p.aktualita : '') + '">'
      + '<p style="margin:6px 0"><label>Platí do <input type="datetime-local" id="pAktDo" value="' + esc(mistniCas(aktPlati && akt ? akt : vychoziDo)) + '"></label> <span class="drobne">nejvýš 14 dní</span></p>');
    h.push('<p style="display:flex;gap:10px;flex-wrap:wrap;margin:12px 0"><label style="flex:1;min-width:200px">Telefon<br><input id="pTel" maxlength="40" style="width:100%;padding:6px" value="' + esc(p.telefon || '') + '"></label>'
      + '<label style="flex:2;min-width:240px">Web<br><input id="pWeb" maxlength="200" style="width:100%;padding:6px" value="' + esc(p.web || '') + '"></label></p>');
    h.push('<p><button id="pUlozit" class="tlacitko">Uložit</button> <span id="pUlozitZprava" class="drobne"></span></p>');

    // texty a fotky
    h.push('<h3>Texty a fotky (po schválení)</h3>');
    if (zmena) {
      h.push('<p class="karta" style="padding:8px 12px">⏳ Změna odeslaná ' + esc(String(zmena.kdy || '').slice(0, 16).replace('T', ' '))
        + ' čeká na schválení. Nový návrh ji nahradí. <button id="pStahnout">Stáhnout návrh</button></p>');
    }
    h.push('<p class="drobne">Správce texty a fotky zkontroluje (obvykle do 1 dne) – musí být slušné a věcné, fotky vlastní.</p>'
      + '<label>Název<br><input id="pNazev" maxlength="80" style="width:100%;padding:6px" value="' + esc(p.nazev || '') + '"></label>'
      + '<p style="margin:10px 0 4px"><strong>Proč sem zajít</strong> <span class="drobne">(tři krátké důvody)</span></p>'
      + [0, 1, 2].map(function (i) {
        return '<input class="pProc" maxlength="80" style="width:100%;padding:6px;margin-bottom:4px" placeholder="' + ['Kvásek z vlastní mouky', 'Lavička u potoka, psi vítáni', 'Rodinná pekárna od roku 1923'][i] + '" value="' + esc((p.proc || [])[i] || '') + '">';
      }).join('')
      + '<label>Popis<br><textarea id="pPopis" maxlength="1000" rows="4" style="width:100%;padding:6px">' + esc(p.popis || '') + '</textarea></label>'
      + '<p style="margin:10px 0 4px"><strong>Fotky</strong> <span class="drobne">(nejvýš 6; první je v hlavičce)</span></p><div id="pFotky" style="display:flex;flex-wrap:wrap;gap:8px"></div>'
      + '<p><input type="file" id="pFotoSoubor" accept="image/*" multiple></p>'
      + '<label>Poznámka pro správce<br><input id="pPozn" maxlength="300" style="width:100%;padding:6px"></label>'
      + '<p><button id="pOdeslat" class="tlacitko">Odeslat ke schválení</button> <span id="pOdeslatZprava" class="drobne"></span></p>');
    el('podnikObsah').innerHTML = h.join('');

    if (el('pVyber')) el('pVyber').onchange = function () { vyberPodnik(this.value); };
    vykresliHodiny(rozloz(p.hodiny));
    vykresliFotky();
    vykresliNahled();
    el('podnikObsah').addEventListener('input', vykresliNahled);
    el('podnikObsah').addEventListener('change', vykresliNahled);
    el('pUlozit').onclick = ulozRychle;
    el('pOdeslat').onclick = odesliKeSchvaleni;
    el('pFotoSoubor').onchange = pridejFotky;
    if (el('pStahnout')) el('pStahnout').onclick = function () {
      smazDoc('podniky_zmeny/' + podnik._id).then(function () { vyberPodnik(podnik._id); })
        .catch(function (e) { alert('Stažení se nepovedlo: ' + e.message); });
    };
  }

  function mistniCas(d) {
    var z = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + 'T' + z(d.getHours()) + ':' + z(d.getMinutes());
  }

  function vykresliHodiny(dny) {
    var h = ['<p style="margin:0 0 4px"><strong>Otevírací doba</strong>' + (dny === null && podnik.hodiny ? ' <span class="drobne">(zápis „' + esc(podnik.hodiny) + '“ neumíme rozložit – uložením ho nahradíte)</span>' : '') + '</p>'];
    for (var d = 0; d < 7; d++) {
      var iv = dny ? (dny[d] || []) : (d < 5 ? [[480, 1020]] : []);
      var ot = iv.length > 0, a = iv[0] || [480, 1020], b = iv[1];
      h.push('<div class="pDen" data-den="' + d + '" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:3px 0">'
        + '<strong style="width:26px">' + DNY[d] + '</strong>'
        + '<label><input type="checkbox" class="pOt"' + (ot ? ' checked' : '') + '> otevřeno</label>'
        + '<input type="time" class="pOd1" value="' + hhmm(a[0]) + '"> – <input type="time" class="pDo1" value="' + hhmm(a[1] >= 1440 ? 0 : a[1]) + '">'
        + '<label class="drobne"><input type="checkbox" class="pPrest"' + (b ? ' checked' : '') + '> odpoledne zvlášť</label>'
        + '<span class="pDruhy"' + (b ? '' : ' hidden') + '><input type="time" class="pOd2" value="' + hhmm(b ? b[0] : 780) + '"> – <input type="time" class="pDo2" value="' + hhmm(b ? (b[1] >= 1440 ? 0 : b[1]) : 1020) + '"></span>'
        + '</div>');
    }
    h.push('<p><button type="button" id="pKopie">Pondělí na všední dny</button></p>');
    el('pHodiny').innerHTML = h.join('');
    el('pHodiny').querySelectorAll('.pPrest').forEach(function (c) {
      c.onchange = function () { c.closest('.pDen').querySelector('.pDruhy').hidden = !c.checked; };
    });
    el('pKopie').onclick = function () {
      var r = el('pHodiny').querySelectorAll('.pDen'), vzor = r[0];
      for (var i = 1; i < 5; i++) {
        ['.pOt', '.pPrest'].forEach(function (s) { r[i].querySelector(s).checked = vzor.querySelector(s).checked; });
        ['.pOd1', '.pDo1', '.pOd2', '.pDo2'].forEach(function (s) { r[i].querySelector(s).value = vzor.querySelector(s).value; });
        r[i].querySelector('.pDruhy').hidden = !vzor.querySelector('.pPrest').checked;
      }
      vykresliNahled();
    };
  }

  function hodinyZFormulare() {
    var dny = [];
    el('pHodiny').querySelectorAll('.pDen').forEach(function (r) {
      if (!r.querySelector('.pOt').checked) { dny.push([]); return; }
      var iv = [], od1 = minuty(r.querySelector('.pOd1').value), do1 = minuty(r.querySelector('.pDo1').value);
      if (od1 === null || do1 === null) { dny.push([]); return; }
      iv.push([od1, do1 === 0 ? 1440 : do1]);
      if (r.querySelector('.pPrest').checked) {
        var od2 = minuty(r.querySelector('.pOd2').value), do2 = minuty(r.querySelector('.pDo2').value);
        if (od2 !== null && do2 !== null) iv.push([od2, do2 === 0 ? 1440 : do2]);
      }
      dny.push(iv);
    });
    return sloz(dny);
  }

  function vykresliFotky() {
    var h = [];
    (podnik.fotky || []).forEach(function (u, i) {
      var pryc = !!fotkyPryc[u];
      h.push('<div style="position:relative;width:110px"><img src="' + esc(u) + '" alt="" style="width:110px;height:80px;object-fit:cover;border-radius:8px;' + (pryc ? 'opacity:.3' : '') + '">'
        + '<button type="button" class="pFotoPryc" data-url="' + esc(u) + '" style="position:absolute;top:2px;right:2px">' + (pryc ? '↺' : '×') + '</button>'
        + (i === 0 ? '<div class="drobne">hlavička</div>' : '') + '</div>');
    });
    fotkyNove.forEach(function (b, i) {
      h.push('<div style="position:relative;width:110px"><img src="data:image/jpeg;base64,' + b + '" alt="" style="width:110px;height:80px;object-fit:cover;border-radius:8px;outline:2px solid #F29D38">'
        + '<button type="button" class="pFotoNovaPryc" data-i="' + i + '" style="position:absolute;top:2px;right:2px">×</button><div class="drobne">nová</div></div>');
    });
    el('pFotky').innerHTML = h.join('') || '<span class="drobne">Zatím žádné fotky.</span>';
    el('pFotky').querySelectorAll('.pFotoPryc').forEach(function (b) {
      b.onclick = function () { var u = b.dataset.url; if (fotkyPryc[u]) delete fotkyPryc[u]; else fotkyPryc[u] = true; vykresliFotky(); };
    });
    el('pFotky').querySelectorAll('.pFotoNovaPryc').forEach(function (b) {
      b.onclick = function () { fotkyNove.splice(parseInt(b.dataset.i, 10), 1); vykresliFotky(); };
    });
  }

  /* fotka → JPEG ≤ 1280 px a ≤ 290 000 znaků base64 (dokument ke schválení má strop 1 MiB) */
  function zmensi(soubor) {
    return createImageBitmap(soubor).then(function (bmp) {
      var k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
      var c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      for (var q = 0.82; q >= 0.4; q -= 0.08) {
        var b64 = c.toDataURL('image/jpeg', q).split(',')[1];
        if (b64.length <= 290000) return b64;
      }
      throw new Error('fotka je po zmenšení pořád moc velká');
    });
  }
  function pridejFotky() {
    var soubory = Array.prototype.slice.call(el('pFotoSoubor').files || []);
    el('pFotoSoubor').value = '';
    var zbyva = Math.min(3 - fotkyNove.length, 6 - ((podnik.fotky || []).length - Object.keys(fotkyPryc).length) - fotkyNove.length);
    if (soubory.length > zbyva) { alert('Najednou jdou poslat nejvýš 3 nové fotky a celkem 6.'); soubory = soubory.slice(0, Math.max(0, zbyva)); }
    soubory.reduce(function (pr, f) {
      return pr.then(function () { return zmensi(f).then(function (b) { fotkyNove.push(b); }); });
    }, Promise.resolve()).then(vykresliFotky).catch(function (e) { alert('Fotku se nepodařilo zpracovat: ' + e.message); });
  }

  function ulozRychle() {
    var btn = el('pUlozit'); btn.disabled = true;
    var akt = el('pAkt').value.trim(), aktDo = el('pAktDo').value ? new Date(el('pAktDo').value) : null;
    var max = new Date(Date.now() + 14 * 86400000);
    if (aktDo && aktDo > max) aktDo = max;
    var data = {
      hodiny: hodinyZFormulare(),
      vlastnosti: Array.prototype.map.call(document.querySelectorAll('.pVl:checked'), function (c) { return c.value; }),
      zmeneno: new Date(),
    };
    var smazat = [];
    if (akt) { data.aktualita = akt; data.aktualitaDo = aktDo || max; } else { smazat.push('aktualita', 'aktualitaDo'); }
    var tel = el('pTel').value.trim(), web = el('pWeb').value.trim();
    if (tel) data.telefon = tel; else smazat.push('telefon');
    if (web) data.web = web; else smazat.push('web');
    zapisPole('podniky/' + podnik._id, data, smazat).then(function () {
      Object.assign(podnik, data); smazat.forEach(function (k) { delete podnik[k]; });
      zprava('pUlozitZprava', 'Uloženo – v aplikaci se projeví do 10 minut.');
    }).catch(function (e) {
      zprava('pUlozitZprava', /40[13]/.test(e.message) ? 'Uložení odmítl server – přihlaste se prosím znovu (Můj Okolník).' : 'Uložení se nepovedlo (' + e.message + ').', true);
    }).then(function () { btn.disabled = false; });
  }

  function odesliKeSchvaleni() {
    var btn = el('pOdeslat');
    var nazev = el('pNazev').value.trim();
    if (!nazev) { zprava('pOdeslatZprava', 'Vyplňte název.', true); return; }
    btn.disabled = true;
    var relace = nactiRelaci();
    var data = { uid: relace.uid, kdy: new Date(), nazev: nazev, popis: el('pPopis').value.trim(),
                 proc: Array.prototype.map.call(document.querySelectorAll('.pProc'), function (i) { return i.value.trim(); }).filter(Boolean) };
    var ponechane = (podnik.fotky || []).filter(function (u) { return !fotkyPryc[u]; });
    if (ponechane.length !== (podnik.fotky || []).length) data.fotky = ponechane;
    if (fotkyNove.length) data.fotkyNove = fotkyNove.slice(0, 3);
    var pozn = el('pPozn').value.trim(); if (pozn) data.poznamka = pozn;
    zapisPole('podniky_zmeny/' + podnik._id, data, null, true).then(function () {
      zprava('pOdeslatZprava', 'Odesláno ke schválení – obvykle do 1 dne.');
      setTimeout(function () { vyberPodnik(podnik._id); }, 1200);
    }).catch(function (e) {
      zprava('pOdeslatZprava', 'Odeslání se nepovedlo (' + e.message + ').', true);
      btn.disabled = false;
    });
  }

  /* náhled jako v aplikaci (z rozpracovaného formuláře) */
  function vykresliNahled() {
    var n = el('pNahled'); if (!n) return;
    var hodiny = el('pHodiny') && el('pHodiny').querySelector('.pDen') ? hodinyZFormulare() : podnik.hodiny;
    var st = stavOtevreni(hodiny, new Date());
    var vl = Array.prototype.map.call(document.querySelectorAll('.pVl:checked'), function (c) { return c.value; });
    var proc = Array.prototype.map.call(document.querySelectorAll('.pProc'), function (i) { return i.value.trim(); }).filter(Boolean);
    var akt = el('pAkt') ? el('pAkt').value.trim() : '';
    var foto = ((podnik.fotky || []).filter(function (u) { return !fotkyPryc[u]; })[0]) || (fotkyNove[0] ? 'data:image/jpeg;base64,' + fotkyNove[0] : '');
    var h = '<div style="max-width:360px;border:1px solid #ddd3bf;border-radius:14px;overflow:hidden;background:#fffdf8">';
    h += foto ? '<img src="' + esc(foto) + '" alt="" style="width:100%;height:150px;object-fit:cover;display:block">' : '<div style="height:60px;background:#0D2B2E"></div>';
    h += '<div style="padding:10px 12px"><strong style="font-size:1.05rem">' + esc(el('pNazev') ? el('pNazev').value : podnik.nazev) + '</strong> '
      + '<span style="font-size:.8rem;color:#A85D12;background:#fbe9d2;border-radius:5px;padding:1px 5px">✔ Ověřeno</span>';
    if (st) h += '<div style="margin:6px 0"><span style="font-weight:700;border-radius:8px;padding:2px 8px;' + (st.otevreno ? 'color:#2E7D32;background:#e6f2e7' : 'color:#C62828;background:#fbe8e8') + '">' + esc(st.text) + '</span></div>';
    if (akt) h += '<div style="border:1px solid #f5c68d;background:#fdf1e2;border-radius:10px;padding:6px 8px;margin:6px 0">📣 ' + esc(akt) + '</div>';
    if (proc.length) h += '<div style="margin:6px 0">' + proc.map(function (p) { return '<div>✓ ' + esc(p) + '</div>'; }).join('') + '</div>';
    if (vl.length) h += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">' + vl.map(function (k) {
      var v = VLASTNOSTI.filter(function (x) { return x[0] === k; })[0]; return '<span style="border:1px solid #ddd3bf;border-radius:8px;padding:1px 7px;font-size:.85rem">' + esc(v ? v[1] : k) + '</span>'; }).join('') + '</div>';
    h += '</div></div><p class="drobne" style="margin:4px 0 0">Náhled – takhle zhruba stránku uvidí uživatelé aplikace.</p>';
    n.innerHTML = h;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
