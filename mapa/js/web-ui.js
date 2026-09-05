/* ⭐ OKOLNÍK – OVLÁDÁNÍ MAPY NA WEBU PODLE APLIKACE (5. 9. 2026,
 * 2. kolo: „v Objevitelovi na webu chybí většina filtrů, erby a obrázky
 * míst").
 *
 * Běží jen s `?web=1` (zavaděč), až PO web.js. Skryje demo panely enginu
 * a postaví chrome jako v telefonu:
 *   horní lišta: logo + režim | chipy Cestovatel / Objevitel / Dobyvatel
 *   řádek:       [Filtry n/N] [🔍 Hledat] [Seznam n]
 *   vlevo:       Odkryto (km² ze synchronizace)
 *   vpravo:      Pohled (styl), 2D/3D, Moje poloha
 *
 * MÍSTA jako v aplikaci: `data/kategorie.json` (skupiny filtrů, chipy se
 * sloučenými kategoriemi, obrázek `/assets/icons/<a>.webp`, emoji) +
 * dlaždice `data/mista/{la}_{lo}.json` po 0,25° z databáze aplikace
 * (web_mista_export.py). Body se posílají enginu jen z výřezu od zoomu 12,
 * nejvýš 400 nejbližších, s obrázkem kategorie (nebo bublinou s emoji).
 * ERBY: `data/erby_index.json` × objevené obce ze synchronizace
 * (`trailCounts`) → `OkolnikMost.erby`, jako v aplikaci (do 300 nejbližších).
 */
(function () {
  'use strict';
  if (new URLSearchParams(location.search).get('web') !== '1') return;

  var KLIC_FILTRY = 'okolnik.web.filtry.v2';
  var KLIC_REZIM = 'okolnik.web.rezim.v1';
  var MAX_BODU = 400;
  var MAX_ERBU = 300;
  var KROK = 0.25;
  var ZOOM_BODU = 12;
  var EMOJI_VYCHOZI = '📍';

  var rezim = 'objevitel';
  var kat = null;                    // data/kategorie.json
  var aktivni = {};                  // chip → bool
  var chipKategorie = {};            // kategorie (i sloučená) → chip
  var dlazdice = {};                 // "la_lo" → {kategorie: [[lat5, lon5, n]]} | 'nacitam'
  var kresby = [];
  var vVyrezu = [];
  var vSeznamu = [];
  var erbyIndex = null;              // [[k, lat, lon, n]]
  var poslErbyOtisk = '';
  var otevreno = null;
  var casovac = null;

  /* ───────────── pomocníci ───────────── */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function vzdalenostM(a, b, c, d) {
    var R = 6371000, p = Math.PI / 180;
    var x = (c - a) * p, y = (d - b) * p * Math.cos((a + c) / 2 * p);
    return Math.sqrt(x * x + y * y) * R;
  }
  function km(m) {
    return m < 950 ? Math.round(m / 10) * 10 + ' m'
      : (m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',') + ' km';
  }
  function uloz(klic, v) { try { localStorage.setItem(klic, JSON.stringify(v)); } catch (e) { } }
  function nacti(klic, vychozi) {
    try { var s = localStorage.getItem(klic); return s ? JSON.parse(s) : vychozi; }
    catch (e) { return vychozi; }
  }

  /* ───────────── vzhled (barvy appky) ───────────── */
  var CSS = ''
    + ':root{--w-amber:#F29D38;--w-blue:#0D2B2E;--w-green:#2E7D5B;--w-sand:#F2E8CF;'
    + '--w-plum:#7B4B6E;--w-text:#1d2624}'
    + '#leva-lista,#ovladani,#znacka,#napoveda{display:none !important}'
    + '.w-ui{font:14px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--w-text)}'
    + '#w-top{position:absolute;left:0;right:0;top:0;z-index:20;'
    + 'background:rgba(253,246,246,.96);box-shadow:0 2px 10px rgba(0,0,0,.12)}'
    + '#w-top .rada{display:flex;align-items:center;gap:10px;padding:8px 14px}'
    + '#w-top .rada.druha{padding-top:0;padding-bottom:10px}'
    + '#w-logo{display:flex;align-items:center;gap:8px;text-decoration:none;color:var(--w-blue)}'
    + '#w-logo b{font-size:20px;letter-spacing:.2px}'
    + '#w-logo small{display:block;font-size:11px;font-weight:800;letter-spacing:.7px;color:var(--w-amber)}'
    + '#w-rezimy{display:flex;gap:6px;margin-left:auto}'
    + '.w-chip{border:0;border-radius:999px;padding:8px 14px;font:inherit;font-weight:700;'
    + 'cursor:pointer;background:#ece3d3;color:var(--w-blue)}'
    + '.w-chip.aktivni{background:var(--w-amber);color:#1d1400}'
    + '.w-chip.plum{background:var(--w-plum);color:#fff}'
    + '#w-hledat{flex:1;display:flex;align-items:center;gap:8px;border:1.5px solid #cfc4b2;'
    + 'border-radius:12px;padding:6px 12px;background:#fff;position:relative}'
    + '#w-hledat input{flex:1;border:0;outline:0;font:inherit;font-size:15px;background:none}'
    + '#w-vysledky{position:absolute;left:0;right:0;top:calc(100% + 6px);background:#fff;'
    + 'border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.18);max-height:60vh;overflow:auto;display:none;z-index:30}'
    + '#w-vysledky.zobraz{display:block}'
    + '.w-radek{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;border-bottom:1px solid #f0eae0}'
    + '.w-radek:hover{background:#faf5ea}'
    + '.w-radek .em{width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:18px}'
    + '.w-radek .em img{width:26px;height:26px;object-fit:contain}'
    + '.w-radek .n{flex:1}.w-radek small{display:block;color:#7a7368;font-size:12px}'
    + '#w-left{position:absolute;left:12px;top:132px;z-index:15;display:flex;flex-direction:column;gap:10px}'
    + '#w-right{position:absolute;right:12px;top:132px;z-index:15;display:flex;flex-direction:column;gap:10px;align-items:flex-end}'
    + '.w-tl{border:0;border-radius:16px;background:var(--w-amber);color:#1d1400;min-width:74px;padding:9px 10px;'
    + 'font:inherit;font-weight:800;font-size:12px;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.2);text-align:center}'
    + '.w-tl .ik{display:block;font-size:20px;line-height:1.1}.w-tl .vel{display:block;font-size:15px}'
    + '.w-tl.plum{background:var(--w-plum);color:#fff}'
    + '#w-panel{position:absolute;left:0;right:0;bottom:0;max-height:66vh;z-index:25;background:var(--w-sand);'
    + 'border-radius:18px 18px 0 0;box-shadow:0 -8px 30px rgba(0,0,0,.25);display:none;flex-direction:column}'
    + '#w-panel.zobraz{display:flex}'
    + '#w-panel .hlava{display:flex;align-items:center;gap:10px;padding:12px 16px 6px}'
    + '#w-panel .hlava b{font-size:17px;flex:1}'
    + '#w-panel .telo{overflow:auto;padding:4px 10px 14px}'
    + '.w-zavrit{border:0;background:none;font-size:22px;cursor:pointer;color:#55605d}'
    + '.w-skupina{margin:6px 4px 10px}'
    + '.w-skupina h4{margin:0 0 6px;font-size:14px;display:flex;align-items:center;gap:8px}'
    + '.w-skupina h4 span{color:#7a7368;font-weight:500;font-size:12px}'
    + '.w-skupina h4 button{border:0;background:none;color:var(--w-green);font:inherit;font-weight:700;cursor:pointer;padding:2px 6px}'
    + '.w-druhy{display:flex;flex-wrap:wrap;gap:6px}'
    + '.w-druh{display:flex;align-items:center;gap:6px;border-radius:12px;padding:6px 10px;'
    + 'background:#fff;border:1.5px solid #d9ceb8;cursor:pointer;font-weight:600;font-size:13px}'
    + '.w-druh.vyp{opacity:.45;text-decoration:line-through}'
    + '.w-druh .em{font-size:16px;display:flex;align-items:center}.w-druh .em img{width:20px;height:20px;object-fit:contain}'
    + '.w-mini{display:flex;gap:8px;padding:4px 6px 8px}'
    + '.w-mini button{border:0;background:none;color:var(--w-green);font:inherit;font-weight:700;cursor:pointer;padding:4px 8px}'
    + '#w-pohled{position:relative}'
    + '#w-pohled-menu{position:absolute;right:0;top:calc(100% + 6px);background:#fff;border-radius:12px;'
    + 'box-shadow:0 8px 28px rgba(0,0,0,.18);display:none;min-width:170px;z-index:30}'
    + '#w-pohled-menu.zobraz{display:block}'
    + '#w-pohled-menu button{display:block;width:100%;text-align:left;border:0;background:none;padding:10px 14px;font:inherit;cursor:pointer}'
    + '#w-pohled-menu button.aktivni{font-weight:800;color:var(--w-green)}'
    + '#web-karta{bottom:34px}'
    + '@media (max-width:640px){#w-top .rada{padding:6px 8px;gap:6px}#w-logo b{font-size:17px}'
    + '.w-chip{padding:7px 10px;font-size:12px}#w-left,#w-right{top:118px}.w-tl{min-width:62px;padding:7px 8px}#w-rezimy{margin-left:0}}';

  /* ───────────── stavba chrome ───────────── */
  var ui = {};
  function postav() {
    var s = el('style'); s.id = 'w-css'; s.textContent = CSS; document.head.appendChild(s);
    var top = el('div', 'w-ui'); top.id = 'w-top';
    var r1 = el('div', 'rada');
    var logo = el('a'); logo.id = 'w-logo'; logo.href = '/objevitel/';
    var lw = el('span'); lw.appendChild(el('b', null, 'Okolník'));
    ui.rezimText = el('small', null, 'Objevitel'); lw.appendChild(ui.rezimText);
    logo.appendChild(lw); r1.appendChild(logo);
    var rez = el('div'); rez.id = 'w-rezimy'; ui.chipy = {};
    [['cestovatel', 'Cestovatel'], ['objevitel', 'Objevitel'], ['dobyvatel', 'Dobyvatel']]
      .forEach(function (p) {
        var b = el('button', 'w-chip', p[1]);
        b.onclick = function () { nastavRezim(p[0]); };
        ui.chipy[p[0]] = b; rez.appendChild(b);
      });
    r1.appendChild(rez); top.appendChild(r1);
    var r2 = el('div', 'rada druha');
    ui.filtry = el('button', 'w-chip plum', 'Filtry');
    ui.filtry.onclick = function () { prepniPanel('filtry'); };
    r2.appendChild(ui.filtry);
    var hl = el('div'); hl.id = 'w-hledat';
    hl.appendChild(el('span', null, '🔍'));
    ui.vstup = el('input'); ui.vstup.placeholder = 'Hledat místo…'; ui.vstup.autocomplete = 'off';
    ui.vstup.oninput = hledej; ui.vstup.onfocus = hledej;
    hl.appendChild(ui.vstup);
    ui.vysledky = el('div'); ui.vysledky.id = 'w-vysledky'; hl.appendChild(ui.vysledky);
    r2.appendChild(hl);
    ui.seznam = el('button', 'w-chip aktivni', 'Seznam');
    ui.seznam.onclick = function () { prepniPanel('seznam'); };
    r2.appendChild(ui.seznam);
    top.appendChild(r2);
    document.body.appendChild(top);

    var left = el('div', 'w-ui'); left.id = 'w-left';
    ui.odkryto = el('button', 'w-tl');
    ui.odkryto.innerHTML = '<span class="ik">⛶</span><span class="vel">–</span>odkryto';
    ui.odkryto.onclick = function () { location.href = '/objevitel/'; };
    left.appendChild(ui.odkryto);
    document.body.appendChild(left);

    var right = el('div', 'w-ui'); right.id = 'w-right';
    var poh = el('div'); poh.id = 'w-pohled';
    ui.pohled = el('button', 'w-tl');
    ui.pohled.innerHTML = '<span class="vel">Pohled</span>Herní';
    ui.pohled.onclick = function () { ui.pohledMenu.classList.toggle('zobraz'); };
    poh.appendChild(ui.pohled);
    ui.pohledMenu = el('div'); ui.pohledMenu.id = 'w-pohled-menu';
    [['herni', 'Herní'], ['turisticka', 'Turistická'], ['zakladni', 'Základní'], ['letecka', 'Letecká']]
      .forEach(function (p) {
        var b = el('button', null, p[1]); b.dataset.styl = p[0];
        b.onclick = function () { nastavStyl(p[0]); ui.pohledMenu.classList.remove('zobraz'); };
        ui.pohledMenu.appendChild(b);
      });
    poh.appendChild(ui.pohledMenu);
    right.appendChild(poh);
    ui.teren = el('button', 'w-tl');
    ui.teren.innerHTML = '<span class="ik">⛰</span>3D';
    ui.teren.onclick = function () {
      var t = document.getElementById('teren-prepinac');
      if (t) t.click();
      setTimeout(obnovTeren, 300);
    };
    right.appendChild(ui.teren);
    ui.poloha = el('button', 'w-tl plum');
    ui.poloha.innerHTML = '<span class="ik">◎</span>Moje poloha';
    ui.poloha.onclick = mojePoloha;
    right.appendChild(ui.poloha);
    document.body.appendChild(right);

    ui.panel = el('div', 'w-ui'); ui.panel.id = 'w-panel';
    var hlava = el('div', 'hlava');
    ui.panelNadpis = el('b', null, ''); hlava.appendChild(ui.panelNadpis);
    var z = el('button', 'w-zavrit', '×'); z.onclick = function () { prepniPanel(null); };
    hlava.appendChild(z); ui.panel.appendChild(hlava);
    ui.panelTelo = el('div', 'telo'); ui.panel.appendChild(ui.panelTelo);
    document.body.appendChild(ui.panel);

    document.addEventListener('click', function (e) {
      if (!ui.vysledky.contains(e.target) && e.target !== ui.vstup) ui.vysledky.classList.remove('zobraz');
      if (!poh.contains(e.target)) ui.pohledMenu.classList.remove('zobraz');
    });
  }

  /* ───────────── režimy a styl ───────────── */
  function nastavRezim(r) {
    if (r === 'dobyvatel') { location.href = '/dobyvatel/'; return; }
    rezim = r;
    uloz(KLIC_REZIM, r);
    for (var k in ui.chipy) ui.chipy[k].classList.toggle('aktivni', k === r);
    ui.rezimText.textContent = r === 'cestovatel' ? 'Cestovatel' : 'Objevitel';
    ui.odkryto.style.display = r === 'objevitel' ? '' : 'none';
    nastavStyl(r === 'cestovatel' ? 'turisticka' : 'herni');
  }

  function nastavStyl(kod) {
    try {
      if (typeof aktualniKod !== 'undefined' && aktualniKod !== kod) OkolnikMost.nastavStyl(kod);
    } catch (e) { console.warn('[web-ui] styl', e); }
    var nazvy = { herni: 'Herní', turisticka: 'Turistická', zakladni: 'Základní', letecka: 'Letecká' };
    ui.pohled.innerHTML = '<span class="vel">Pohled</span>' + (nazvy[kod] || kod);
    ui.pohledMenu.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('aktivni', b.dataset.styl === kod);
    });
    setTimeout(function () { posliMista(); posliErby(true); }, 900);
  }

  function obnovTeren() {
    var t = document.getElementById('teren-prepinac');
    var zap = t ? t.classList.contains('aktivni') : true;
    ui.teren.innerHTML = '<span class="ik">' + (zap ? '⛰' : '▭') + '</span>' + (zap ? '3D' : '2D');
  }

  function mojePoloha() {
    if (!navigator.geolocation) return;
    ui.poloha.disabled = true;
    navigator.geolocation.getCurrentPosition(function (p) {
      ui.poloha.disabled = false;
      try { mapa.jumpTo({ center: [p.coords.longitude, p.coords.latitude], zoom: Math.max(mapa.getZoom(), 13.5) }); }
      catch (e) { }
    }, function () { ui.poloha.disabled = false; }, { timeout: 8000 });
  }

  /* ───────────── filtry (jako v aplikaci: skupiny + sloučené chipy) ───────────── */
  function chipyVse() {
    var out = [];
    (kat.skupiny || []).forEach(function (sk) { sk.k.forEach(function (k) { out.push(k); }); });
    return out;
  }
  function nactiFiltry() {
    var u = nacti(KLIC_FILTRY, null);
    chipyVse().forEach(function (k) { aktivni[k] = u ? u[k] !== false : true; });
    chipKategorie = {};
    chipyVse().forEach(function (k) {
      chipKategorie[k] = k;
      ((kat.chipy[k] || {}).s || []).forEach(function (c) { chipKategorie[c] = k; });
    });
    obnovFiltryChip();
  }
  function obnovFiltryChip() {
    var vse = chipyVse();
    var n = vse.filter(function (k) { return aktivni[k]; }).length;
    ui.filtry.textContent = 'Filtry ' + n + '/' + vse.length;
  }
  function ikonaChipu(k) {
    var ch = kat.chipy[k] || {};
    var em = el('span', 'em');
    if (ch.a) {
      var img = el('img'); img.src = '/assets/icons/' + ch.a + '.webp'; img.alt = '';
      img.onerror = function () { em.textContent = ch.e || EMOJI_VYCHOZI; };
      em.appendChild(img);
    } else {
      em.textContent = ch.e || EMOJI_VYCHOZI;
    }
    return em;
  }
  function vykresliFiltry() {
    ui.panelNadpis.textContent = 'Filtry míst';
    var telo = ui.panelTelo; telo.innerHTML = '';
    var mini = el('div', 'w-mini');
    var vse = el('button', null, '✓ Vše'); vse.onclick = function () {
      chipyVse().forEach(function (k) { aktivni[k] = true; }); poFiltru(); vykresliFiltry();
    };
    var nic = el('button', null, '☐ Nic'); nic.onclick = function () {
      chipyVse().forEach(function (k) { aktivni[k] = false; }); poFiltru(); vykresliFiltry();
    };
    mini.appendChild(vse); mini.appendChild(nic); telo.appendChild(mini);
    (kat.skupiny || []).forEach(function (sk) {
      var box = el('div', 'w-skupina');
      var h = el('h4');
      var zap = sk.k.filter(function (k) { return aktivni[k]; }).length;
      h.appendChild(document.createTextNode(sk.n + ' '));
      h.appendChild(el('span', null, zap + '/' + sk.k.length));
      var cela = el('button', null, zap === sk.k.length ? '☑ Celá' : '☐ Celá');
      cela.onclick = function () {
        var na = zap !== sk.k.length;
        sk.k.forEach(function (k) { aktivni[k] = na; });
        poFiltru(); vykresliFiltry();
      };
      h.appendChild(cela);
      box.appendChild(h);
      var druhy = el('div', 'w-druhy');
      sk.k.forEach(function (k) {
        var ch = kat.chipy[k] || { l: k };
        var b = el('button', 'w-druh' + (aktivni[k] ? '' : ' vyp'));
        b.appendChild(ikonaChipu(k));
        b.appendChild(el('span', null, ch.l));
        b.onclick = function () { aktivni[k] = !aktivni[k]; poFiltru(); vykresliFiltry(); };
        druhy.appendChild(b);
      });
      box.appendChild(druhy);
      telo.appendChild(box);
    });
    telo.appendChild(el('p', null, 'Malovaná místa se ukazují vždy; filtry řídí ostatní místa jako v aplikaci. Body jsou vidět od přiblížení na město.'));
  }
  function poFiltru() {
    uloz(KLIC_FILTRY, aktivni);
    obnovFiltryChip();
    posliMista();
  }

  /* ───────────── dlaždice míst ───────────── */
  function klicDlazdice(la, lo) { return la + '_' + lo; }
  function dlazdiceVyrezu(b) {
    var out = [];
    var la0 = Math.floor(b.getSouth() / KROK), la1 = Math.floor(b.getNorth() / KROK);
    var lo0 = Math.floor(b.getWest() / KROK), lo1 = Math.floor(b.getEast() / KROK);
    for (var la = la0; la <= la1; la++) for (var lo = lo0; lo <= lo1; lo++) out.push([la, lo]);
    return out.length > 12 ? [] : out;    // moc velký výřez = žádné body
  }
  function zajistiDlazdici(la, lo) {
    var k = klicDlazdice(la, lo);
    if (dlazdice[k] !== undefined) return dlazdice[k] === 'nacitam' ? null : dlazdice[k];
    dlazdice[k] = 'nacitam';
    fetch('data/mista/' + k + '.json').then(function (r) {
      if (r.status === 404) return {};
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      dlazdice[k] = d || {};
      naplanujMista();
    }).catch(function () { dlazdice[k] = {}; });
    return null;
  }

  function spocitejVyrez() {
    if (!mapa || !kat) return [];
    var z = mapa.getZoom();
    if (z < ZOOM_BODU) return [];
    var b = mapa.getBounds(), c = mapa.getCenter();
    var w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
    var out = [];
    dlazdiceVyrezu(b).forEach(function (t) {
      var d = zajistiDlazdici(t[0], t[1]);
      if (!d) return;
      for (var c2 in d) {
        var chip = chipKategorie[c2];
        if (!chip || !aktivni[chip]) continue;
        var pole = d[c2];
        for (var i = 0; i < pole.length; i++) {
          var lat = pole[i][0] / 1e5, lng = pole[i][1] / 1e5;
          if (lng < w || lng > e || lat < s || lat > n) continue;
          out.push({ id: 'poi:' + c2 + ':' + pole[i][0] + ':' + pole[i][1], d: c2, chip: chip,
            lat: lat, lng: lng, n: pole[i][2] || (kat.chipy[chip] || {}).l || '',
            vzd: vzdalenostM(c.lat, c.lng, lat, lng) });
        }
      }
    });
    out.sort(function (a, b2) { return a.vzd - b2.vzd; });
    if (out.length > MAX_BODU) out.length = MAX_BODU;
    return out;
  }

  function ikonaMista(m) {
    var ch = kat.chipy[m.chip] || {};
    var asset = kat.ikony[m.d] || ch.a;
    if (asset) return '/assets/icons/' + asset + '.webp';
    var em = kat.emoji[m.d] || ch.e || EMOJI_VYCHOZI;
    return 'emoji|' + em + '|#5B6B75';
  }

  function posliMista() {
    if (typeof OkolnikMost === 'undefined' || !kat) return;
    vVyrezu = spocitejVyrez();
    var pole = kresby.slice();
    for (var i = 0; i < vVyrezu.length; i++) {
      var m = vVyrezu[i];
      pole.push({ id: m.id, lat: m.lat, lng: m.lng, b: '#5B6B75', ik: ikonaMista(m), t: m.n });
    }
    try {
      if (typeof vykresliMista === 'function') {
        vykresliMista._znama = new Set(pole.map(function (x) { return String(x.id); }));
      }
      OkolnikMost.mista(pole);
    } catch (e) { console.warn('[web-ui] mista', e); }
    var c = mapa.getCenter(), b = mapa.getBounds();
    var kr = kresby.filter(function (k) {
      return k.lng >= b.getWest() && k.lng <= b.getEast() && k.lat >= b.getSouth() && k.lat <= b.getNorth();
    }).map(function (k) {
      return { id: k.id, lat: k.lat, lng: k.lng, n: k.t, d: 'kresba', vzd: vzdalenostM(c.lat, c.lng, k.lat, k.lng) };
    });
    vSeznamu = kr.concat(vVyrezu).sort(function (a, b2) { return a.vzd - b2.vzd; });
    ui.seznam.textContent = 'Seznam ' + vSeznamu.length;
    if (otevreno === 'seznam') vykresliSeznam();
  }

  /* ───────────── erby objevených obcí ───────────── */
  function objeveneObce() {
    var w = window.OkolnikWeb;
    var stav = w && w.stav;
    if (!stav) return null;
    var klice = {};
    try {
      var counts = typeof stav.trailCounts === 'string' ? JSON.parse(stav.trailCounts) : (stav.trailCounts || {});
      for (var k in counts) klice[k] = true;
    } catch (e) { }
    (stav.trailDone || []).forEach(function (k) { klice[k] = true; });
    return klice;
  }
  function posliErby(vynutit) {
    if (typeof OkolnikMost === 'undefined' || !erbyIndex || !mapa) return;
    var obce = objeveneObce();
    if (!obce) return;
    var c = mapa.getCenter();
    var moje = [];
    for (var i = 0; i < erbyIndex.length; i++) {
      var e = erbyIndex[i];
      if (!obce[e[0]]) continue;
      moje.push({ lat: e[1], lon: e[2], url: '/assets/erby/' + e[0].replace(':', '_') + '.webp',
        vzd: vzdalenostM(c.lat, c.lng, e[1], e[2]) });
    }
    moje.sort(function (a, b) { return a.vzd - b.vzd; });
    if (moje.length > MAX_ERBU) moje.length = MAX_ERBU;
    var otisk = moje.length + ':' + (moje[0] ? moje[0].url : '') + ':' + (moje[moje.length - 1] ? moje[moje.length - 1].url : '');
    if (!vynutit && otisk === poslErbyOtisk) return;
    poslErbyOtisk = otisk;
    try { OkolnikMost.erby(moje); console.log('[web-ui] erby:', moje.length); }
    catch (e) { console.warn('[web-ui] erby', e); }
  }

  /* ───────────── seznam + hledání ───────────── */
  function radek(m, klik) {
    var r = el('div', 'w-radek');
    var em;
    if (m.d === 'kresba') { em = el('span', 'em', '🎨'); }
    else { em = ikonaChipu(m.chip || chipKategorie[m.d] || ''); }
    var n = el('span', 'n'); n.textContent = m.n;
    var popis = m.d === 'kresba' ? 'Malované místo' : ((kat.chipy[m.chip] || {}).l || m.d);
    n.appendChild(el('small', null, popis + (m.vzd != null ? ' · ' + km(m.vzd) : '')));
    r.appendChild(em); r.appendChild(n);
    r.onclick = function () { klik(m); };
    return r;
  }
  function vykresliSeznam() {
    ui.panelNadpis.textContent = 'Místa ve výřezu (' + vSeznamu.length + ')';
    var telo = ui.panelTelo; telo.innerHTML = '';
    if (!vSeznamu.length) {
      telo.appendChild(el('p', null, mapa.getZoom() < ZOOM_BODU
        ? 'Přibližte mapu na město, body míst se ukazují od zoomu 12. Kresby jsou vidět vždy.'
        : 'V tomhle výřezu nic není – zkuste jiné filtry.'));
      return;
    }
    vSeznamu.slice(0, 80).forEach(function (m) { telo.appendChild(radek(m, letNaMisto)); });
  }
  function letNaMisto(m) {
    prepniPanel(null);
    ui.vysledky.classList.remove('zobraz');
    try { mapa.jumpTo({ center: [m.lng, m.lat], zoom: Math.max(mapa.getZoom(), 14) }); } catch (e) { }
    if (m.d === 'kresba') {
      setTimeout(function () {
        try { if (typeof Ilustrace !== 'undefined' && Ilustrace.ukazDetail) Ilustrace.ukazDetail(m.id); } catch (e) { }
      }, 400);
    }
  }
  function hledej() {
    var q = norm(ui.vstup.value).trim();
    ui.vysledky.innerHTML = '';
    if (q.length < 2) { ui.vysledky.classList.remove('zobraz'); return; }
    var c = mapa ? mapa.getCenter() : { lat: 49.8, lng: 15.5 };
    var kand = [];
    for (var i = 0; i < kresby.length; i++) {
      if (kresby[i].norm.indexOf(q) >= 0) {
        kand.push({ id: kresby[i].id, lat: kresby[i].lat, lng: kresby[i].lng, n: kresby[i].t, d: 'kresba', norm: kresby[i].norm });
      }
    }
    // načtené dlaždice (okolí výřezu) – celá databáze se do prohlížeče nenačítá
    for (var k in dlazdice) {
      var d = dlazdice[k];
      if (!d || d === 'nacitam') continue;
      for (var c2 in d) {
        var pole = d[c2];
        for (var j = 0; j < pole.length && kand.length < 400; j++) {
          var nm = norm(pole[j][2]);
          if (nm && nm.indexOf(q) >= 0) {
            kand.push({ id: 'poi:' + c2 + ':' + pole[j][0] + ':' + pole[j][1], d: c2, chip: chipKategorie[c2],
              lat: pole[j][0] / 1e5, lng: pole[j][1] / 1e5, n: pole[j][2], norm: nm });
          }
        }
      }
    }
    kand.forEach(function (m) { m.vzd = vzdalenostM(c.lat, c.lng, m.lat, m.lng); });
    kand.sort(function (a, b) {
      var pa = a.norm.indexOf(q), pb = b.norm.indexOf(q);
      if ((pa === 0) !== (pb === 0)) return pa === 0 ? -1 : 1;
      return a.vzd - b.vzd;
    });
    kand.slice(0, 14).forEach(function (m) { ui.vysledky.appendChild(radek(m, letNaMisto)); });
    if (!kand.length) ui.vysledky.appendChild(el('div', 'w-radek', 'Nic nenalezeno v okolí výřezu'));
    ui.vysledky.classList.add('zobraz');
  }

  function prepniPanel(co) {
    otevreno = (otevreno === co) ? null : co;
    ui.panel.classList.toggle('zobraz', !!otevreno);
    if (otevreno === 'filtry') vykresliFiltry();
    if (otevreno === 'seznam') vykresliSeznam();
  }

  /* ───────────── data ───────────── */
  function nactiKategorie() {
    return fetch('data/kategorie.json').then(function (r) { return r.json(); })
      .then(function (d) { kat = d; kat.ikony = kat.ikony || {}; kat.emoji = kat.emoji || {}; nactiFiltry(); })
      .catch(function (e) {
        console.warn('[web-ui] kategorie', e);
        kat = { skupiny: [], chipy: {}, ikony: {}, emoji: {} };
        nactiFiltry();
      });
  }
  function nactiErbyIndex() {
    return fetch('data/erby_index.json').then(function (r) { return r.json(); })
      .then(function (d) { erbyIndex = d; posliErby(true); })
      .catch(function (e) { console.warn('[web-ui] erby index', e); });
  }
  function prevezmiKresby() {
    var w = window.OkolnikWeb;
    if (!w || !w.kresby) return;
    kresby = w.kresby.map(function (k) { var o = Object.assign({}, k); o.norm = norm(k.t); return o; });
  }
  function obnovOdkryto() {
    var w = window.OkolnikWeb;
    var n = w && w.stav && w.stav.trailCells ? w.stav.trailCells.length : 0;
    var km2 = n * 0.026;
    ui.odkryto.innerHTML = '<span class="ik">⛶</span><span class="vel">'
      + (n ? (km2 < 10 ? km2.toFixed(1).replace('.', ',') : Math.round(km2)) + ' km²' : '–') + '</span>odkryto';
    posliErby(true);
  }
  function naplanujMista() {
    clearTimeout(casovac);
    casovac = setTimeout(function () { posliMista(); posliErby(false); }, 350);
  }

  /* ───────────── start ───────────── */
  function cekej(cb) {
    var n = 0;
    (function tik() {
      var ok = false;
      try {
        ok = typeof mapa !== 'undefined' && mapa && typeof OkolnikMost !== 'undefined'
          && ((mapa.style && mapa.style._loaded) || (mapa.isStyleLoaded && mapa.isStyleLoaded()))
          && window.OkolnikWeb && window.OkolnikWeb.kresby && window.OkolnikWeb.kresby.length;
      } catch (e) { ok = false; }
      if (ok) { cb(); return; }
      if (++n > 800) return;
      setTimeout(tik, 250);
    })();
  }

  function start() {
    postav();
    var w = window.OkolnikWeb = window.OkolnikWeb || {};
    w.naStav = w.naStav || [];
    w.naStav.push(obnovOdkryto);
    nactiKategorie().then(function () {
      cekej(function () {
        prevezmiKresby();
        obnovOdkryto();
        obnovTeren();
        var r = nacti(KLIC_REZIM, 'objevitel');
        nastavRezim(r === 'cestovatel' ? 'cestovatel' : 'objevitel');
        posliMista();
        nactiErbyIndex();
        mapa.on('moveend', naplanujMista);
        mapa.on('zoomend', naplanujMista);
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
