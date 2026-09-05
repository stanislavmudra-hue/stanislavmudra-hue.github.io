/* ⭐ OKOLNÍK – OVLÁDÁNÍ MAPY NA WEBU PODLE APLIKACE (5. 9. 2026,
 * přání: „layout ovládání mapy na webu udělej podobné jako má appka
 * v mobilu – filtry, vrstvy, přepínání režimu, vyhledávání, seznam míst").
 *
 * Běží jen s `?web=1` (zavaděč), až PO web.js. Skryje demo panely enginu
 * a postaví chrome jako v telefonu:
 *   horní lišta: logo + režim | chipy Cestovatel / Objevitel / Dobyvatel
 *   řádek:       [Filtry n/12] [🔍 Hledat] [Seznam n]
 *   vlevo:       Odkryto (km² ze synchronizace)
 *   vpravo:      Pohled (styl), 2D/3D, Moje poloha
 * Místa: 455 kreseb (ilustrace.json) + 17 018 bodů (mista_info.json)
 * s ikonami po druzích jako v aplikaci (bubliny „emoji|…"). Body se posílají
 * enginu jen z výřezu a od zoomu 11 (jako to dělá aplikace).
 */
(function () {
  'use strict';
  if (new URLSearchParams(location.search).get('web') !== '1') return;

  var DRUHY = {
    castles: ['🏰', '#5D4037', 'Hrady a zámky'],
    peaks: ['⛰️', '#4E6E58', 'Vrcholy'],
    viewpoints: ['🔭', '#00695C', 'Rozhledny a vyhlídky'],
    towers: ['🗼', '#455A64', 'Věže'],
    caves: ['🦇', '#4E342E', 'Jeskyně'],
    waterfalls: ['💦', '#0277BD', 'Vodopády'],
    rocks: ['🪨', '#6D4C41', 'Skály'],
    jezera: ['🏞️', '#01579B', 'Rybníky a jezera'],
    archaeology: ['🏺', '#8D6E63', 'Archeologie'],
    fortifications: ['🪖', '#4E342E', 'Opevnění a bunkry'],
    mines: ['⛏️', '#424242', 'Doly a štoly'],
    memorial_trees: ['🌲', '#2E7D32', 'Památné stromy'],
  };
  var PORADI = ['castles', 'peaks', 'viewpoints', 'towers', 'caves',
    'waterfalls', 'rocks', 'jezera', 'archaeology', 'fortifications',
    'mines', 'memorial_trees'];
  var KLIC_FILTRY = 'okolnik.web.filtry.v1';
  var KLIC_REZIM = 'okolnik.web.rezim.v1';
  var MAX_BODU = 400;

  var rezim = 'objevitel';           // cestovatel | objevitel | dobyvatel
  var aktivni = {};                  // druh → bool
  var body = [];                     // {id, lat, lng, n, d, norm}
  var kresby = [];                   // z web.js (OkolnikWeb.kresby)
  var vVyrezu = [];
  var otevreno = null;               // 'filtry' | 'seznam' | null
  var casovac = null;

  /* ───────────── pomocníci ───────────── */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
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
    + '#leva-lista,#ovladani,#znacka,#napoveda,#web-karta.skryta{display:none !important}'
    + '.w-ui{font:14px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;'
    + 'color:var(--w-text)}'
    + '#w-top{position:absolute;left:0;right:0;top:0;z-index:20;'
    + 'background:rgba(253,246,246,.96);box-shadow:0 2px 10px rgba(0,0,0,.12)}'
    + '#w-top .rada{display:flex;align-items:center;gap:10px;padding:8px 14px}'
    + '#w-top .rada.druha{padding-top:0;padding-bottom:10px}'
    + '#w-logo{display:flex;align-items:center;gap:8px;text-decoration:none;color:var(--w-blue)}'
    + '#w-logo b{font-size:20px;letter-spacing:.2px}'
    + '#w-logo small{display:block;font-size:11px;font-weight:800;letter-spacing:.7px;'
    + 'color:var(--w-amber)}'
    + '#w-rezimy{display:flex;gap:6px;margin-left:auto}'
    + '.w-chip{border:0;border-radius:999px;padding:8px 14px;font:inherit;font-weight:700;'
    + 'cursor:pointer;background:#ece3d3;color:var(--w-blue)}'
    + '.w-chip.aktivni{background:var(--w-amber);color:#1d1400}'
    + '.w-chip.plum{background:var(--w-plum);color:#fff}'
    + '.w-chip:disabled{opacity:.55;cursor:default}'
    + '#w-hledat{flex:1;display:flex;align-items:center;gap:8px;border:1.5px solid #cfc4b2;'
    + 'border-radius:12px;padding:6px 12px;background:#fff;position:relative}'
    + '#w-hledat input{flex:1;border:0;outline:0;font:inherit;font-size:15px;background:none}'
    + '#w-vysledky{position:absolute;left:0;right:0;top:calc(100% + 6px);background:#fff;'
    + 'border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.18);max-height:60vh;'
    + 'overflow:auto;display:none;z-index:30}'
    + '#w-vysledky.zobraz{display:block}'
    + '.w-radek{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;'
    + 'border-bottom:1px solid #f0eae0}'
    + '.w-radek:hover{background:#faf5ea}'
    + '.w-radek .em{width:26px;text-align:center;font-size:18px}'
    + '.w-radek .n{flex:1}.w-radek .d{color:#7a7368;font-size:12px}'
    + '.w-radek small{display:block;color:#7a7368;font-size:12px}'
    + '#w-left{position:absolute;left:12px;top:132px;z-index:15;display:flex;'
    + 'flex-direction:column;gap:10px}'
    + '#w-right{position:absolute;right:12px;top:132px;z-index:15;display:flex;'
    + 'flex-direction:column;gap:10px;align-items:flex-end}'
    + '.w-tl{border:0;border-radius:16px;background:var(--w-amber);color:#1d1400;'
    + 'min-width:74px;padding:9px 10px;font:inherit;font-weight:800;font-size:12px;'
    + 'cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.2);text-align:center}'
    + '.w-tl .ik{display:block;font-size:20px;line-height:1.1}'
    + '.w-tl .vel{display:block;font-size:15px}'
    + '.w-tl.plum{background:var(--w-plum);color:#fff}'
    + '#w-panel{position:absolute;left:0;right:0;bottom:0;max-height:62vh;z-index:25;'
    + 'background:var(--w-sand);border-radius:18px 18px 0 0;box-shadow:0 -8px 30px rgba(0,0,0,.25);'
    + 'display:none;flex-direction:column}'
    + '#w-panel.zobraz{display:flex}'
    + '#w-panel .hlava{display:flex;align-items:center;gap:10px;padding:12px 16px 6px}'
    + '#w-panel .hlava b{font-size:17px;flex:1}'
    + '#w-panel .telo{overflow:auto;padding:4px 10px 14px}'
    + '.w-zavrit{border:0;background:none;font-size:22px;cursor:pointer;color:#55605d}'
    + '.w-druhy{display:flex;flex-wrap:wrap;gap:8px;padding:6px}'
    + '.w-druh{display:flex;align-items:center;gap:8px;border-radius:12px;padding:8px 12px;'
    + 'background:#fff;border:1.5px solid #d9ceb8;cursor:pointer;font-weight:600}'
    + '.w-druh.vyp{opacity:.45;text-decoration:line-through}'
    + '.w-druh .em{font-size:18px}'
    + '.w-mini{display:flex;gap:8px;padding:4px 6px 8px}'
    + '.w-mini button{border:0;background:none;color:var(--w-green);font:inherit;'
    + 'font-weight:700;cursor:pointer;padding:4px 8px}'
    + '#w-pohled{position:relative}'
    + '#w-pohled-menu{position:absolute;right:0;top:calc(100% + 6px);background:#fff;'
    + 'border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.18);display:none;min-width:170px;z-index:30}'
    + '#w-pohled-menu.zobraz{display:block}'
    + '#w-pohled-menu button{display:block;width:100%;text-align:left;border:0;background:none;'
    + 'padding:10px 14px;font:inherit;cursor:pointer}'
    + '#w-pohled-menu button.aktivni{font-weight:800;color:var(--w-green)}'
    + '#web-karta{bottom:34px}'
    + '@media (max-width:640px){#w-top .rada{padding:6px 8px;gap:6px}#w-logo b{font-size:17px}'
    + '.w-chip{padding:7px 10px;font-size:12px}#w-left,#w-right{top:118px}'
    + '.w-tl{min-width:62px;padding:7px 8px}#w-rezimy{margin-left:0}}';

  /* ───────────── stavba chrome ───────────── */
  var ui = {};
  function postav() {
    var s = el('style'); s.id = 'w-css'; s.textContent = CSS; document.head.appendChild(s);

    var top = el('div', 'w-ui'); top.id = 'w-top';
    var r1 = el('div', 'rada');
    var logo = el('a'); logo.id = 'w-logo'; logo.href = '/objevitel/';
    var lb = el('b', null, 'Okolník'); ui.rezimText = el('small', null, 'Objevitel');
    var lw = el('span'); lw.appendChild(lb); lw.appendChild(ui.rezimText);
    logo.appendChild(lw); r1.appendChild(logo);
    var rez = el('div'); rez.id = 'w-rezimy';
    ui.chipy = {};
    [['cestovatel', 'Cestovatel'], ['objevitel', 'Objevitel'], ['dobyvatel', 'Dobyvatel']]
      .forEach(function (p) {
        var b = el('button', 'w-chip', p[1]); b.dataset.rezim = p[0];
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
    ui.vstup = el('input'); ui.vstup.placeholder = 'Hledat místo…';
    ui.vstup.autocomplete = 'off';
    ui.vstup.oninput = hledej;
    ui.vstup.onfocus = hledej;
    hl.appendChild(ui.vstup);
    ui.vysledky = el('div'); ui.vysledky.id = 'w-vysledky';
    hl.appendChild(ui.vysledky);
    r2.appendChild(hl);
    ui.seznam = el('button', 'w-chip aktivni', 'Seznam');
    ui.seznam.onclick = function () { prepniPanel('seznam'); };
    r2.appendChild(ui.seznam);
    top.appendChild(r2);
    document.body.appendChild(top);

    var left = el('div', 'w-ui'); left.id = 'w-left';
    ui.odkryto = el('button', 'w-tl');
    ui.odkryto.innerHTML = '<span class="ik">⛶</span><span class="vel">–</span>odkryto';
    ui.odkryto.title = 'Odkrytá plocha ze synchronizace pod účtem';
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
    [['herni', 'Herní'], ['turisticka', 'Turistická'], ['zakladni', 'Základní'],
      ['letecka', 'Letecká']].forEach(function (p) {
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
    ui.panelNadpis = el('b', null, '');
    hlava.appendChild(ui.panelNadpis);
    var z = el('button', 'w-zavrit', '×'); z.onclick = function () { prepniPanel(null); };
    hlava.appendChild(z);
    ui.panel.appendChild(hlava);
    ui.panelTelo = el('div', 'telo');
    ui.panel.appendChild(ui.panelTelo);
    document.body.appendChild(ui.panel);

    document.addEventListener('click', function (e) {
      if (!ui.vysledky.contains(e.target) && e.target !== ui.vstup) {
        ui.vysledky.classList.remove('zobraz');
      }
      if (!poh.contains(e.target)) ui.pohledMenu.classList.remove('zobraz');
    });
  }

  /* ───────────── režimy a styl ───────────── */
  function nastavRezim(r) {
    if (r === 'dobyvatel') {
      // Dobyvatel má na webu vlastní mapu soutěže (dobyvatel.js pro web
      // ještě neumí stav soutěže z Firestore) – zatím odkaz
      location.href = '/dobyvatel/';
      return;
    }
    rezim = r;
    uloz(KLIC_REZIM, r);
    for (var k in ui.chipy) ui.chipy[k].classList.toggle('aktivni', k === r);
    ui.rezimText.textContent = r === 'cestovatel' ? 'Cestovatel' : 'Objevitel';
    ui.odkryto.style.display = r === 'objevitel' ? '' : 'none';
    nastavStyl(r === 'cestovatel' ? 'turisticka' : 'herni');
  }

  function nastavStyl(kod) {
    try {
      if (typeof aktualniKod !== 'undefined' && aktualniKod !== kod) {
        OkolnikMost.nastavStyl(kod);
      }
    } catch (e) { console.warn('[web-ui] styl', e); }
    var nazvy = { herni: 'Herní', turisticka: 'Turistická', zakladni: 'Základní',
      letecka: 'Letecká' };
    ui.pohled.innerHTML = '<span class="vel">Pohled</span>' + (nazvy[kod] || kod);
    ui.pohledMenu.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('aktivni', b.dataset.styl === kod);
    });
    // po výměně stylu engine znovu potřebuje místa
    setTimeout(posliMista, 900);
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
      try {
        mapa.jumpTo({ center: [p.coords.longitude, p.coords.latitude],
          zoom: Math.max(mapa.getZoom(), 13.5) });
      } catch (e) { }
    }, function () { ui.poloha.disabled = false; }, { timeout: 8000 });
  }

  /* ───────────── filtry ───────────── */
  function nactiFiltry() {
    var u = nacti(KLIC_FILTRY, null);
    PORADI.forEach(function (d) { aktivni[d] = u ? u[d] !== false : true; });
    obnovFiltryChip();
  }
  function obnovFiltryChip() {
    var n = PORADI.filter(function (d) { return aktivni[d]; }).length;
    ui.filtry.textContent = 'Filtry ' + n + '/' + PORADI.length;
  }
  function vykresliFiltry() {
    ui.panelNadpis.textContent = 'Filtry míst';
    var telo = ui.panelTelo; telo.innerHTML = '';
    var mini = el('div', 'w-mini');
    var vse = el('button', null, '✓ Vše'); vse.onclick = function () {
      PORADI.forEach(function (d) { aktivni[d] = true; }); poFiltru(); vykresliFiltry();
    };
    var nic = el('button', null, '☐ Nic'); nic.onclick = function () {
      PORADI.forEach(function (d) { aktivni[d] = false; }); poFiltru(); vykresliFiltry();
    };
    mini.appendChild(vse); mini.appendChild(nic); telo.appendChild(mini);
    var box = el('div', 'w-druhy');
    PORADI.forEach(function (d) {
      var info = DRUHY[d];
      var b = el('button', 'w-druh' + (aktivni[d] ? '' : ' vyp'));
      b.innerHTML = '<span class="em">' + info[0] + '</span><span>' + info[2] + '</span>';
      b.onclick = function () { aktivni[d] = !aktivni[d]; poFiltru(); vykresliFiltry(); };
      box.appendChild(b);
    });
    telo.appendChild(box);
    telo.appendChild(el('p', null,
      'Malovaná místa (kresby) se ukazují vždy; filtry řídí body podle druhu.'));
  }
  function poFiltru() {
    uloz(KLIC_FILTRY, aktivni);
    obnovFiltryChip();
    posliMista();
  }

  /* ───────────── místa: výřez → engine, seznam ───────────── */
  function spocitejVyrez() {
    if (!mapa) return [];
    var z = mapa.getZoom();
    var b = mapa.getBounds();
    var c = mapa.getCenter();
    var out = [];
    if (z >= 11) {
      var w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
      for (var i = 0; i < body.length; i++) {
        var m = body[i];
        if (!aktivni[m.d]) continue;
        if (m.lng < w || m.lng > e || m.lat < s || m.lat > n) continue;
        m.vzd = vzdalenostM(c.lat, c.lng, m.lat, m.lng);
        out.push(m);
      }
      out.sort(function (a, b2) { return a.vzd - b2.vzd; });
      if (out.length > MAX_BODU) out.length = MAX_BODU;
    }
    return out;
  }

  function posliMista() {
    if (typeof OkolnikMost === 'undefined') return;
    vVyrezu = spocitejVyrez();
    var pole = kresby.slice();
    for (var i = 0; i < vVyrezu.length; i++) {
      var m = vVyrezu[i], info = DRUHY[m.d] || ['📍', '#5B6B75'];
      pole.push({ id: m.id, lat: m.lat, lng: m.lng, b: info[1],
        ik: 'emoji|' + info[0] + '|' + info[1], t: m.n });
    }
    try {
      if (typeof vykresliMista === 'function') {
        vykresliMista._znama = new Set(pole.map(function (m) { return String(m.id); }));
      }
      OkolnikMost.mista(pole);
    } catch (e) { console.warn('[web-ui] mista', e); }
    // seznam: kresby ve výřezu + body, podle vzdálenosti
    var c = mapa.getCenter(), b = mapa.getBounds();
    var kr = kresby.filter(function (k) {
      return k.lng >= b.getWest() && k.lng <= b.getEast()
        && k.lat >= b.getSouth() && k.lat <= b.getNorth();
    }).map(function (k) {
      return { id: k.id, lat: k.lat, lng: k.lng, n: k.t, d: 'kresba',
        vzd: vzdalenostM(c.lat, c.lng, k.lat, k.lng) };
    });
    vSeznamu = kr.concat(vVyrezu).sort(function (a, b2) { return a.vzd - b2.vzd; });
    ui.seznam.textContent = 'Seznam ' + vSeznamu.length;
    if (otevreno === 'seznam') vykresliSeznam();
  }
  var vSeznamu = [];

  function radek(m, klik) {
    var r = el('div', 'w-radek');
    var info = m.d === 'kresba' ? ['🎨', '', 'Malované místo'] : (DRUHY[m.d] || ['📍', '', '']);
    var em = el('span', 'em', info[0]);
    var n = el('span', 'n'); n.textContent = m.n;
    var sm = el('small', null, info[2] + (m.vzd != null ? ' · ' + km(m.vzd) : ''));
    n.appendChild(sm);
    r.appendChild(em); r.appendChild(n);
    r.onclick = function () { klik(m); };
    return r;
  }

  function vykresliSeznam() {
    ui.panelNadpis.textContent = 'Místa ve výřezu (' + vSeznamu.length + ')';
    var telo = ui.panelTelo; telo.innerHTML = '';
    if (!vSeznamu.length) {
      telo.appendChild(el('p', null, mapa.getZoom() < 11
        ? 'Přibližte mapu, body míst se ukazují od zoomu 11. Kresby jsou vidět vždy.'
        : 'V tomhle výřezu nic není – zkuste jiné filtry.'));
      return;
    }
    vSeznamu.slice(0, 80).forEach(function (m) { telo.appendChild(radek(m, letNaMisto)); });
  }

  function letNaMisto(m) {
    prepniPanel(null);
    ui.vysledky.classList.remove('zobraz');
    try {
      mapa.jumpTo({ center: [m.lng, m.lat], zoom: Math.max(mapa.getZoom(), 14) });
    } catch (e) { }
    if (m.d === 'kresba') {
      setTimeout(function () {
        try {
          if (typeof Ilustrace !== 'undefined' && Ilustrace.ukazDetail) Ilustrace.ukazDetail(m.id);
        } catch (e) { }
      }, 400);
    }
  }

  /* ───────────── hledání ───────────── */
  function hledej() {
    var q = norm(ui.vstup.value).trim();
    ui.vysledky.innerHTML = '';
    if (q.length < 2) { ui.vysledky.classList.remove('zobraz'); return; }
    var c = mapa ? mapa.getCenter() : { lat: 49.8, lng: 15.5 };
    var kand = [];
    for (var i = 0; i < kresby.length && kand.length < 400; i++) {
      if (kresby[i].norm.indexOf(q) >= 0) {
        kand.push({ id: kresby[i].id, lat: kresby[i].lat, lng: kresby[i].lng,
          n: kresby[i].t, d: 'kresba' });
      }
    }
    for (var j = 0; j < body.length && kand.length < 400; j++) {
      if (body[j].norm.indexOf(q) >= 0) kand.push(body[j]);
    }
    kand.forEach(function (m) { m.vzd = vzdalenostM(c.lat, c.lng, m.lat, m.lng); });
    kand.sort(function (a, b) {
      var pa = a.norm ? a.norm.indexOf(q) : 0, pb = b.norm ? b.norm.indexOf(q) : 0;
      if ((pa === 0) !== (pb === 0)) return pa === 0 ? -1 : 1;
      return a.vzd - b.vzd;
    });
    kand.slice(0, 14).forEach(function (m) { ui.vysledky.appendChild(radek(m, letNaMisto)); });
    if (!kand.length) ui.vysledky.appendChild(el('div', 'w-radek', 'Nic nenalezeno'));
    ui.vysledky.classList.add('zobraz');
  }

  /* ───────────── panel ───────────── */
  function prepniPanel(co) {
    otevreno = (otevreno === co) ? null : co;
    ui.panel.classList.toggle('zobraz', !!otevreno);
    if (otevreno === 'filtry') vykresliFiltry();
    if (otevreno === 'seznam') vykresliSeznam();
  }

  /* ───────────── data ───────────── */
  function nactiBody() {
    return fetch('assets/mista_info.json').then(function (r) { return r.json(); })
      .then(function (pole) {
        body = [];
        for (var i = 0; i < pole.length; i++) {
          var m = pole[i];
          if (!DRUHY[m[0]]) continue;
          body.push({ id: 'poi:' + i, d: m[0], lat: m[1] / 1e5, lng: m[2] / 1e5,
            n: m[3] || '', norm: norm(m[3]) });
        }
        console.log('[web-ui] body:', body.length);
      }).catch(function (e) { console.warn('[web-ui] mista_info', e); });
  }

  function prevezmiKresby() {
    var w = window.OkolnikWeb;
    if (!w || !w.kresby) return;
    kresby = w.kresby.map(function (k) {
      var o = Object.assign({}, k); o.norm = norm(k.t); return o;
    });
  }

  function obnovOdkryto() {
    var w = window.OkolnikWeb;
    var n = w && w.stav && w.stav.trailCells ? w.stav.trailCells.length : 0;
    var km2 = n * 0.026;
    ui.odkryto.innerHTML = '<span class="ik">⛶</span><span class="vel">'
      + (n ? (km2 < 10 ? km2.toFixed(1).replace('.', ',') : Math.round(km2)) + ' km²' : '–')
      + '</span>odkryto';
  }

  function naplanujMista() {
    clearTimeout(casovac);
    casovac = setTimeout(posliMista, 350);
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
    nactiFiltry();
    var w = window.OkolnikWeb = window.OkolnikWeb || {};
    w.naStav = w.naStav || [];
    w.naStav.push(obnovOdkryto);
    cekej(function () {
      prevezmiKresby();
      obnovOdkryto();
      obnovTeren();
      var r = nacti(KLIC_REZIM, 'objevitel');
      nastavRezim(r === 'cestovatel' ? 'cestovatel' : 'objevitel');
      nactiBody().then(function () {
        posliMista();
        mapa.on('moveend', naplanujMista);
        mapa.on('zoomend', naplanujMista);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
