// Okolník 3D — mlha objevování v2 „Kronika" pro herní styl.
//
// Neobjevený svět vypadá jako pergamenová rytina (assets/kronika_cr.jpg,
// vyrábí pipeline/30_kronika_assety.py). Objevená místa jsou v rytině
// „vygumovaná" měkkým štětcem (canvas + destination-out) a zpod ní se
// vybarví živá malovaná mapa. Skladba pater (zdola nahoru):
//
//   barevné vrstvy stylu → [mlha: plochý pergamen mimo rytinu → rytina ČR
//   s děrami] → inkoustové vrstvy stylu (ink-*) → zrno papíru (CSS overlay)
//
// Zásady (poučení z ANR v Okolníku a z ladění v1):
//   · žádný rozostřovací filtr za běhu — měkkost dělají radiální gradienty
//   · vektorová maska má JEDINOU díru (obdélník rytiny) — překrývající se
//     kruhové díry rozbíjí even-odd pravidlo výplně (vyplněné čočky)
//   · odkrývání řeší výhradně canvas: destination-out je idempotentní,
//     kreslí se přírůstkově a překresluje jen při objevení, ne při pohybu
//   · sépiový lem děr přes source-atop — kreslí se jen tam, kde pergamen
//     zůstal, nikdy přes odkrytou barevnou mapu
'use strict';

const Mlha = (() => {
  const KLIC = 'okolnik3d.mlha.v2';
  // Vnější obvod masky — stačí velkoryse okolí střední Evropy
  const SVET = [[-30, 20], [45, 20], [45, 66], [-30, 66], [-30, 20]];
  const DOBA_RUSTU = 600;        // ms — jak dlouho roste díra po objevení
  // Sépiová verze pergamenu #E9DCBE (přání 6. 8.: neobjevený svět má mít
  // stejný černobílý tón jako nenavštívené kresby) — spočteno toutéž
  // maticí, kterou se odbarvuje rytina níž; navazuje na její okraj
  const PERGAMEN_BARVA = '#C8C6C3';
  // Záložní rohy rytiny — použijí se JEN když se kronika_meta.json nenačte
  const META_ZALOHA = { west: 10.8984375, east: 20.0390625,
                        north: 51.83577752, south: 47.75409798 };

  const KLIC_OBCI = 'okolnik3d.mlha.obce.v1';

  let objevene = nacti();        // [{lng, lat, r}] r v km
  let obce = nactiObce();        // [{kruhy, stred, bbox}] dokončené obce
  let mapa = null;
  let bezici = null;             // časovač běžící demo výpravy
  let posluchaci = [];           // callbacky objevení (ilustrace apod.)
  let ulozCasovac = null;        // odložený zápis do localStorage
  let tikCislo = 0;              // škrcení GPU uploadů během animace
  let rostouci = [];             // právě animované díry [{o, t0}]
  let rafBezi = false;

  // Rytina: metadata + obrázek + kreslicí plátno (přežívají přepnutí stylu)
  let meta = null;
  let rytina = null;             // Image
  let platno = null;             // canvas pro zdroj 'mlha-kronika'
  let ctx2d = null;
  let pripraveno = false;        // rytina načtena a plátno vykresleno

  // -------------------------------------------------------------------------
  // ⭐⭐⭐ KEŠ HOTOVÉHO PLÁTNA (12. 8. 2026, „šedá mapa ~10 s po startu").
  //
  // Změřeno logem výš: plátno 2048×1418 se při KAŽDÉM startu gumovalo
  // celé znovu — 130 940 děr za 3 451 ms v jednom synchronním bloku,
  // a celou tu dobu (plus dekódování rytiny) krylo barevné patro Kroniky
  // plochou maskou. Hotové plátno se proto ukládá jako obrázek
  // (Cache API, WebP) a příští start ho jen NAKRESLÍ (~50 ms)
  // a dogumuje pouze body přibylé od uložení.
  //
  // ⚠️ Do počtu uložených děr se NEpočítají právě rostoucí (`rostouci`)
  // — animovaná díra je na plátně jen z půlky, a kdyby se započítala,
  // zůstala by v keši poloviční navěky. Delta je dogumuje celé.
  // ⚠️ Klíč nese rozměr plátna i georeferenci meta — jiná rytina nebo
  // jiné zařízení keš tiše zahodí. Stav couvl (reset) → keš se přepíše.
  // -------------------------------------------------------------------------
  let ulozenoDer = -1;           // kolik děr má uložený obraz (-1 = žádný)
  const KES_JMENO = 'mlha-platno-v1';

  function klicPlatna() {
    // |b1 = verze s buňkami vlajek (starší keš bez nich musí propadnout)
    return platno.width + 'x' + platno.height + '|'
        + meta.west + ',' + meta.north + ',' + meta.east + ',' + meta.south
        + '|b3';
  }

  async function nactiKesPlatna() {
    try {
      // diagnostika 27. 8.: startu se vrátil plný ryt 131k děr (3,9 s)
      // — každé odmítnutí keše se musí hlásit JMÉNEM brány
      if (typeof caches === 'undefined') {
        console.log('[Mlha] keš MIMO: caches API není (origin '
            + location.origin + ')');
        return null;
      }
      const c = await caches.open(KES_JMENO);
      const mR = await c.match('/meta');
      if (!mR) {
        console.log('[Mlha] keš MIMO: žádná meta (první start / '
            + 'smazané úložiště / jiný port ' + location.origin + ')');
        return null;
      }
      const m = await mR.json();
      if (m.klic !== klicPlatna()) {
        console.log('[Mlha] keš MIMO: klíč nesedí (' + m.klic
            + ' vs ' + klicPlatna() + ')');
        return null;
      }
      // stav couvl (reset/mazání) nebo se změnily obce → keš neplatí.
      // ⭐ 27. 8.: TOLERANCE PÁR DĚR NAVÍC — do plátna stihne přibýt
      // bod, který se do localStorage už nezapíše (debounce vs. konec
      // appky), a přesná rovnost pak KAŽDÝ start posílala na plné
      // rytí 131k děr (3,9 s). Díry jsou monotónní: obraz s dírou
      // navíc je neškodný; reset se pozná propadem o stovky.
      if (m.n > objevene.length + 500 || m.o !== obce.length) {
        console.log('[Mlha] keš MIMO: stav nesedí (děr ' + m.n + '/'
            + objevene.length + ', obcí ' + m.o + '/' + obce.length
            + ')');
        return null;
      }
      const bR = await c.match('/obraz');
      if (!bR) return null;
      const bitmap = await createImageBitmap(await bR.blob());
      return { bitmap: bitmap, n: m.n };
    } catch (e) { return null; }
  }

  function ulozKesPlatna() {
    try {
      if (!pripraveno || typeof caches === 'undefined') return;
      const n = objevene.length - rostouci.length;   // jen dokreslené
      const o = obce.length;
      if (n <= 0) return;
      platno.toBlob((blob) => {
        if (!blob) return;
        caches.open(KES_JMENO).then(async (c) => {
          await c.put('/obraz', new Response(blob));
          await c.put('/meta', new Response(JSON.stringify(
              { klic: klicPlatna(), n: n, o: o })));
          ulozenoDer = n;
        }).catch(() => { /* plný disk apod. — keš je jen zrychlení */ });
      }, 'image/webp', 0.95);
    } catch (e) { /* toBlob není / jiná chyba — nevadí */ }
  }

  function vychozi() {
    return [
      { lng: 16.0725, lat: 50.5050, r: 6 },   // Rtyně v Podkrkonoší — domov
      { lng: 15.9090, lat: 50.5610, r: 4 },   // Trutnov
      { lng: 16.2717, lat: 50.6180, r: 3 },   // Adršpach
    ];
  }

  function nacti() {
    try {
      const s = localStorage.getItem(KLIC);
      if (s) { const d = JSON.parse(s); if (Array.isArray(d) && d.length) return d; }
    } catch (e) { /* soukromý režim apod. */ }
    return vychozi();
  }

  function nactiObce() {
    try {
      const s = localStorage.getItem(KLIC_OBCI);
      if (s) { const d = JSON.parse(s); if (Array.isArray(d)) return d; }
    } catch (e) { /* soukromý režim / plné úložiště */ }
    return [];
  }

  // ——— DOKONČENÉ OBCE (v2.1) ———
  // 2D Okolník vybarvuje dokončenou obec CELOU podle hranic – mlha
  // Kroniky uměla jen kruhy stopy a tvarem se rozcházela. Obec je
  // polygon (víc kruhů = enklávy; even-odd), guma na canvasu se s
  // kruhy snáší bez even-odd pasti vektorové masky.
  function pripravObec(kruhy) {
    if (!Array.isArray(kruhy) || !kruhy.length
        || !Array.isArray(kruhy[0]) || kruhy[0].length < 3) return null;
    let sx = 0;
    let sy = 0;
    let minX = 999; let maxX = -999; let minY = 999; let maxY = -999;
    for (const [x, y] of kruhy[0]) {
      sx += x; sy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { kruhy,
             stred: [sx / kruhy[0].length, sy / kruhy[0].length],
             bbox: [minX, minY, maxX, maxY] };
  }

  function bodVObci(lng, lat, ob) {
    const b = ob.bbox;
    if (b && (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3])) {
      return false;
    }
    let uvnitr = false;
    for (const kruh of ob.kruhy) {
      for (let i = 0, j = kruh.length - 1; i < kruh.length; j = i++) {
        const xi = kruh[i][0]; const yi = kruh[i][1];
        const xj = kruh[j][0]; const yj = kruh[j][1];
        if (((yi > lat) !== (yj > lat)) &&
            (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
          uvnitr = !uvnitr;
        }
      }
    }
    return uvnitr;
  }

  // Zápis je odložený (serializace celého pole je O(n) — při dávce objevů
  // z GPS by běžela pro každý kruh zvlášť); před schováním stránky se spláchne
  function uloz() {
    if (ulozCasovac) return;
    ulozCasovac = setTimeout(ulozHned, 1000);
  }

  function ulozHned() {
    if (ulozCasovac) { clearTimeout(ulozCasovac); ulozCasovac = null; }
    try { localStorage.setItem(KLIC, JSON.stringify(objevene)); } catch (e) {}
    // obce můžou být velké (stovky vrcholů) – když se úložiště brání,
    // prostě se po obnovení stránky pošlou z aplikace znovu
    try { localStorage.setItem(KLIC_OBCI, JSON.stringify(obce)); } catch (e) {}
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) ulozHned();
  });

  // -------------------------------------------------------------------------
  // Geometrie
  // -------------------------------------------------------------------------
  // Maska pergamenu: celý svět; díra (obdélník rytiny) se vyřízne AŽ ve
  // chvíli, kdy rytinu opravdu kreslí canvas vrstva. Jinak by dírou po dobu
  // načítání (nebo napořád, když se JPG nenačte) prosvítala barevná mapa.
  function maska(sDirou) {
    const kruhy = [SVET];
    if (sDirou) {
      kruhy.push([[meta.west, meta.north], [meta.west, meta.south],
                  [meta.east, meta.south], [meta.east, meta.north],
                  [meta.west, meta.north]]);
    }
    return { type: 'Feature', properties: {},
             geometry: { type: 'Polygon', coordinates: kruhy } };
  }

  // Zeměpis → pixel plátna (Mercator; rytina je slepená z mercator dlaždic)
  function mercY(lat) {
    const fi = lat * Math.PI / 180;
    return (1 - Math.asinh(Math.tan(fi)) / Math.PI) / 2;
  }

  function naPlatno(lng, lat) {
    const x = (lng - meta.west) / (meta.east - meta.west) * platno.width;
    const y = (mercY(lat) - mercY(meta.north))
      / (mercY(meta.south) - mercY(meta.north)) * platno.height;
    return [x, y];
  }

  function polomerPx(o) {
    const dLat = o.r / 110.574;
    const [, y1] = naPlatno(o.lng, o.lat);
    const [, y2] = naPlatno(o.lng, o.lat + dLat);
    return Math.abs(y1 - y2);
  }

  // -------------------------------------------------------------------------
  // Kreslení plátna rytiny
  // -------------------------------------------------------------------------
  // Vygumuje díru měkkým štětcem; faktor 0..1 = průběh růstu.
  // `sLemem` přidá sépiový ožeh na hraně — jen při dokončení, opakované
  // kreslení lemu během růstu by se přes source-atop sčítalo do tmava.
  function vygumuj(o, faktor, sLemem) {
    if (!pripraveno) return;
    const [x, y] = naPlatno(o.lng, o.lat);
    const r = Math.max(2, polomerPx(o) * faktor);
    // Široké čisté jádro (0.62): v odkrytém pruhu nezůstává sépiový závoj
    let g = ctx2d.createRadialGradient(x, y, r * 0.62, x, y, r);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx2d.globalCompositeOperation = 'destination-out';
    ctx2d.fillStyle = g;
    ctx2d.fillRect(x - r, y - r, r * 2, r * 2);
    if (sLemem) {
      const rl = r * 1.25;
      // ožeh v sépiovém tónu (96,74,46 přes matici → 57,54,51)
      g = ctx2d.createRadialGradient(x, y, r * 0.9, x, y, rl);
      g.addColorStop(0, 'rgba(57,54,51,0.20)');
      g.addColorStop(0.35, 'rgba(57,54,51,0.10)');
      g.addColorStop(1, 'rgba(57,54,51,0)');
      ctx2d.globalCompositeOperation = 'source-atop';
      ctx2d.fillStyle = g;
      ctx2d.fillRect(x - rl, y - rl, rl * 2, rl * 2);
    }
    ctx2d.globalCompositeOperation = 'source-over';
  }

  // Vygumuje BUŇKU VLAJKY s MĚKKÝM okrajem: výplň dírou a k tomu tři
  // soustředné tahy podél hranice s klesající neprůhledností — vnější
  // půlka tahu přesahuje za hranici, takže mlha do buňky plynule
  // zasahuje jako dřív u kroužků. Bez rozmazání (blur za běhu je
  // zdokumentovaná past ANR), jen levné tahy.
  function vygumujBunku(ob, faktor, sLemem) {
    if (!pripraveno || !ob || !ob.kruhy) return;
    const [scx, scy] = naPlatno(ob.stred[0], ob.stred[1]);
    ctx2d.beginPath();
    for (const kruh of ob.kruhy) {
      for (let i = 0; i < kruh.length; i++) {
        let [x, y] = naPlatno(kruh[i][0], kruh[i][1]);
        if (faktor < 1) {
          x = scx + (x - scx) * faktor;
          y = scy + (y - scy) * faktor;
        }
        if (i === 0) ctx2d.moveTo(x, y);
        else ctx2d.lineTo(x, y);
      }
      ctx2d.closePath();
    }
    const f = Math.max(2, platno.width * 0.0011);
    ctx2d.globalCompositeOperation = 'destination-out';
    ctx2d.fillStyle = 'rgba(0,0,0,1)';
    ctx2d.fill('evenodd');
    ctx2d.lineJoin = 'round';
    for (const [sirka, alfa] of [[f, 0.55], [f * 2, 0.3],
                                 [f * 3.2, 0.14]]) {
      ctx2d.strokeStyle = 'rgba(0,0,0,' + alfa + ')';
      ctx2d.lineWidth = sirka;
      ctx2d.stroke();
    }
    if (sLemem) {
      // sépiový ožeh na straně pergamenu — stejný jako u kroužků/obcí
      ctx2d.globalCompositeOperation = 'source-atop';
      ctx2d.strokeStyle = 'rgba(57,54,51,0.16)';
      ctx2d.lineWidth = f * 1.6;
      ctx2d.stroke();
    }
    ctx2d.globalCompositeOperation = 'source-over';
  }

  // Vygumuje CELOU OBEC podle hranic; růst = zvětšování od těžiště.
  // Lem: sépiový tah PODÉL hranice přes source-atop zůstane jen na
  // straně pergamenu (vnitřek už je vygumovaný) – stejný ožeh jako u děr.
  function vygumujObec(ob, faktor, sLemem) {
    if (!pripraveno || !ob || !ob.kruhy) return;
    const [scx, scy] = naPlatno(ob.stred[0], ob.stred[1]);
    ctx2d.beginPath();
    for (const kruh of ob.kruhy) {
      for (let i = 0; i < kruh.length; i++) {
        let [x, y] = naPlatno(kruh[i][0], kruh[i][1]);
        if (faktor < 1) {
          x = scx + (x - scx) * faktor;
          y = scy + (y - scy) * faktor;
        }
        if (i === 0) ctx2d.moveTo(x, y);
        else ctx2d.lineTo(x, y);
      }
      ctx2d.closePath();
    }
    ctx2d.globalCompositeOperation = 'destination-out';
    ctx2d.fillStyle = 'rgba(0,0,0,1)';
    ctx2d.fill('evenodd');
    if (sLemem) {
      ctx2d.globalCompositeOperation = 'source-atop';
      ctx2d.strokeStyle = 'rgba(57,54,51,0.18)';
      ctx2d.lineWidth = Math.max(2, platno.width * 0.0012);
      ctx2d.stroke();
    }
    ctx2d.globalCompositeOperation = 'source-over';
  }

  // SÉPIE RYTINY — tatáž matice, kterou ilustrace odbarvují nenavštívené
  // kresby (přání 6. 8.: neobjevená mapa stejně černobílá jako neobjevené
  // obrázky). Nativní SVG feColorMatrix; NUTNÉ color-interpolation-filters
  // sRGB, jinak tón nesedí. Bez podpory filtrů zůstane rytina původní.
  let sepieFiltr = false;

  function zajistiSepiovyFiltr() {
    if (sepieFiltr) return;
    sepieFiltr = true;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    const filtr = document.createElementNS(NS, 'filter');
    filtr.setAttribute('id', 'kronika-sepie');
    filtr.setAttribute('color-interpolation-filters', 'sRGB');
    const matice = document.createElementNS(NS, 'feColorMatrix');
    matice.setAttribute('type', 'matrix');
    matice.setAttribute('values',
        '0.307 0.629 0.063 0 -0.08627 '
        + '0.187 0.749 0.063 0 -0.08627 '
        + '0.187 0.629 0.183 0 -0.08627 '
        + '0 0 0 1 0');
    filtr.appendChild(matice);
    svg.appendChild(filtr);
    document.body.appendChild(svg);
  }

  // Plné překreslení (start, reset): rytina + všechny hotové díry
  //
  // ⭐⭐⭐ SÉPIE UŽ NENÍ RUNTIME FILTR (12. 8. 2026, hon na „šedou mapu
  // ~10 s po startu"). `ctx.filter = url(#kronika-sepie)` přes drawImage
  // obrazu 4096×2836 je v Android WebView SOFTWAROVÁ cesta — hlavní
  // vlákno stálo sekundy a barevné patro Kroniky se celou dobu skrývalo
  // za plochou maskou. Rytina je od téhle verze PŘEDTÓNOVANÁ přímo
  // v souboru `assets/kronika_cr.jpg` (tatáž matice, aplikovaná jednou
  // offline v PIL: 0.307/0.629/0.063… offset −22) — kreslí se holým
  // drawImage. `zajistiSepiovyFiltr` zůstává jen pro případné budoucí
  // použití na MALÝCH plochách; na celou rytinu ho nikdy nevracet.
  // Časy se logují, ať je vidět, kde plátno tráví čas.
  function prekresliPlatno() {
    if (!pripraveno) return;
    const t0 = performance.now();
    ctx2d.globalCompositeOperation = 'source-over';
    ctx2d.clearRect(0, 0, platno.width, platno.height);
    ctx2d.drawImage(rytina, 0, 0, platno.width, platno.height);
    const t1 = performance.now();
    // ⭐ 26. 8.: kroužky podél stopy se UŽ NEKRESLÍ — odkrývá se
    // výhradně po buňkách vlajek (seznam `objevene` zůstává: nese
    // persistenci, dotazy jeObjeveno i odvození buněk). Dokud data
    // buněk nedojela, kreslí se kroužky jako záloha, ať mapa není
    // celá v mlze.
    if (bunkyData) {
      zpracujBunky();
      for (const idx of bunkyOdkryte) {
        const tvar = bunkaTvar(idx);
        if (tvar) vygumujBunku(tvar, 1, true);
      }
      // body projeté autem nedělají buňku — kreslí úzký pruh jako dřív
      for (const o of objevene) {
        if (o.r < BUNKA_PESKY_R) vygumuj(o, 1, true);
      }
    } else {
      for (const o of objevene) vygumuj(o, 1, true);
    }
    for (const ob of obce) vygumujObec(ob, 1, true);
    const t2 = performance.now();
    console.log('[Mlha] plátno ' + platno.width + '×' + platno.height
        + ': rytina ' + (t1 - t0).toFixed(0) + ' ms, děr '
        + objevene.length + '+' + obce.length + ' obcí za '
        + (t2 - t1).toFixed(0) + ' ms');
    obnovZdroj();
    ulozKesPlatna();   // plná kresba = čerstvý obraz pro příští start
  }

  // Canvas source překreslíme „šťouchnutím" — play() zapne nahrávání textury,
  // pauza po NĚKOLIKA vykreslených snímcích. ⚠️ NIKDY nečekat na `idle`:
  // hrající canvas zdroj sám každý snímek žádá překreslení, takže idle
  // s ním NIKDY nepřijde — zdroj pak hrál věčně a plátno celé ČR se
  // nahrávalo na GPU KAŽDÝ snímek až do konce sezení (hlavní příčina
  // „náklon neskutečně seká i na výkonném PC", 8. 8.; navíc věčné
  // překreslování dusilo idle pro všechny ostatní moduly). Jeden render
  // zase NESTAČÍ: událost mohla patřit snímku naplánovanému před play()
  // a na GPU zůstal prázdný obraz (v2.1, plochý pergamen) — proto se
  // počká na 5 snímků; každý z nich texturu nahrává, obsah plátna je
  // v tu chvíli už finální (kreslí se synchronně před obnovZdroj).
  function obnovZdroj() {
    if (!mapa) return;
    const z = mapa.getSource('mlha-kronika');
    if (!z || !z.play) return;
    z.play();
    mapa.triggerRepaint();
    obnovZdroj._tik = (obnovZdroj._tik || 0) + 1;
    const muj = obnovZdroj._tik;
    let zbyva = 5;
    const krok = () => {
      if (obnovZdroj._tik !== muj || !mapa) return;   // běží novější obnova
      const ted = mapa.getSource('mlha-kronika');
      if (!ted || !ted.pause) return;                 // styl mezitím vyměněn
      if (rostouci.length) return;                    // růst si volá obnovy sám
      if (--zbyva > 0) { mapa.once('render', krok); return; }
      ted.pause();
    };
    mapa.once('render', krok);
  }

  // Animace růstu čerstvě objevených děr. Upload celého plátna na GPU je
  // drahý (canvas source neumí částečný přenos), proto se během růstu
  // obnovuje jen každý druhý snímek; závěrečný stav vždy.
  function tikni() {
    const ted = performance.now();
    rostouci = rostouci.filter(({ o, ob, bunka, t0 }) => {
      const f = Math.min(1, (ted - t0) / DOBA_RUSTU);
      const mek = 1 - Math.pow(1 - f, 3);          // ease-out
      if (bunka) vygumujBunku(ob, mek, f >= 1);
      else if (ob) vygumujObec(ob, mek, f >= 1);
      else vygumuj(o, mek, f >= 1);
      return f < 1;
    });
    tikCislo++;
    if (!rostouci.length || tikCislo % 2 === 0) obnovZdroj();
    if (rostouci.length) {
      requestAnimationFrame(tikni);
    } else {
      rafBezi = false;
    }
  }

  function spustAnimaci() {
    if (!rafBezi) { rafBezi = true; requestAnimationFrame(tikni); }
  }

  // -------------------------------------------------------------------------
  // Načtení assetů (jednou; přežívá přepínání stylů)
  // -------------------------------------------------------------------------
  let nacitaniBezi = false;

  function nactiAssety() {
    if (nacitaniBezi) return;                // už běží / hotovo
    nacitaniBezi = true;
    // meta zůstává null, dokud fetch neskončí — plátno se nesmí georeferencovat
    // podle zálohy, když skutečná meta dorazí o chvíli později (posun děr)
    fetch('assets/kronika_meta.json')
      .then(r => r.json())
      .then(m => { meta = m; })
      .catch(() => { meta = META_ZALOHA; })
      .then(pripravPlatno);
    rytina = new Image();
    rytina.onload = pripravPlatno;
    rytina.onerror = () => console.warn('[Mlha] rytina se nenačetla — '
      + 'ČR kryje plochý pergamen bez rytiny');
    rytina.src = 'assets/kronika_cr.jpg';
  }

  function pripravPlatno() {
    if (pripraveno || !rytina || !rytina.complete || !rytina.naturalWidth
        || !meta) return;
    // ⛔⛔ NE DŘÍV, NEŽ JE MAPA. Stahování assetu se předbíhá (viz konec
    // modulu), ale STAVBA PLÁTNA musí zůstat přesně tam, kde byla —
    // v `pripoj`. Zkoušeno postavit ho hned po stažení (20. 8. 2026)
    // a keš plátna přestala platit: `nactiKesPlatna` porovnává počet
    // dokončených obcí (`m.o`), a ty appka posílá teprve po `onPripraveno`.
    // Místo keše (7 ms) se pak jelo překreslení 131 tisíc děr — změřeno
    // **8 869 ms na hlavním vlákně**, tedy start mapy ve 14. vteřině.
    if (!mapa) return;
    const sirka = meta.sirka || rytina.naturalWidth;
    const vyska = meta.vyska || rytina.naturalHeight;
    platno = document.createElement('canvas');
    // Na slabších zařízeních (mobil) poloviční plátno — šetří paměť i upload
    const pomer = (Math.min(screen.width, screen.height) < 500) ? 0.5 : 1;
    platno.width = Math.round(sirka * pomer);
    platno.height = Math.round(vyska * pomer);
    ctx2d = platno.getContext('2d');
    pripraveno = true;
    // Napřed zkusit hotové plátno z keše (viz blok KEŠ výš) — plná cesta
    // (131k děr, ~3,5 s na hlavním vlákně) zůstává jen pro první start,
    // reset a neplatnou keš.
    nactiKesPlatna().then((kes) => {
      if (kes) {
        const t0 = performance.now();
        ctx2d.globalCompositeOperation = 'source-over';
        ctx2d.drawImage(kes.bitmap, 0, 0, platno.width, platno.height);
        for (let i = kes.n; i < objevene.length; i++) {
          vygumuj(objevene[i], 1, true);
        }
        ulozenoDer = kes.n;
        console.log('[Mlha] plátno z keše + '
            + (objevene.length - kes.n) + ' nových děr za '
            + (performance.now() - t0).toFixed(0) + ' ms');
        pridejVrstvuRytiny();
        obnovZdroj();
        if (objevene.length - kes.n > 200) ulozKesPlatna();
      } else {
        prekresliPlatno();
        pridejVrstvuRytiny();
        // ⭐⭐ v1.514: PLNÉ PŘEKRESLENÍ SI ULOŽIT. Do teď se keš zapisovala
        // jen při `visibilitychange` (odchod appky do pozadí) a při
        // >200 nových dírách — takže kdo appku zavřel jinak (nebo mu ji
        // Android zabil), měl při KAŽDÉM startu znovu 3,8 s rytí
        // 130 941 děr na hlavním vlákně. A protože zablokované vlákno
        // pozdrží i časovače, přišlo s tím pozdě i noční patro a mapa
        // problikla denními barvami (změřeno v logu: noc až 6,4 s po
        // dokreslení mlhy).
        // ⚠️ Odloženo o 1,5 s: `toBlob` kóduje 2048×1418 WebP a hned po
        // překreslení má hlavní vlákno lepší práci (první snímky mapy).
        setTimeout(() => { try { ulozKesPlatna(); } catch (e) {} }, 1500);
      }
    });
    // uložit i při odchodu appky do pozadí — nasbírané díry ze session
    // se promítnou do keše a příští start je nemusí dogumovávat
    try {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && ulozenoDer >= 0
            && objevene.length - rostouci.length > ulozenoDer) {
          ulozKesPlatna();
        }
      });
    } catch (e) { /* nevadí */ }
  }

  // -------------------------------------------------------------------------
  // Vrstvy mlhy ve stylu
  // -------------------------------------------------------------------------
  // Kotva: mlha patří pod první inkoustovou vrstvu (ink-*)
  function kotva() {
    if (!mapa) return undefined;
    const vrstva = mapa.getStyle().layers.find(v => v.id.startsWith('ink-'));
    return vrstva ? vrstva.id : undefined;
  }

  /// První NEdrapovaná vrstva = konec drapovaného bloku. Cokoli typu
  /// line/fill/… vložené AŽ ZA ni založí druhý RTT stack, tedy další
  /// texturu na každou terénní dlaždici a snímek (viz navigace.js).
  function predSymboly() {
    if (!mapa) return undefined;
    const drapuje = { background: 1, fill: 1, line: 1, raster: 1,
                      hillshade: 1, 'color-relief': 1 };
    try {
      for (const v of mapa.getStyle().layers) {
        if (!drapuje[v.type]) return v.id;
      }
    } catch (e) { /* styl se zrovna mění */ }
    return undefined;
  }

  function pridejVrstvuRytiny() {
    if (!mapa || !pripraveno || !mapa.getSource('mlha-maska')) return;
    if (mapa.getSource('mlha-kronika')) return;
    mapa.addSource('mlha-kronika', {
      type: 'canvas', canvas: platno, animate: false,
      coordinates: [[meta.west, meta.north], [meta.east, meta.north],
                    [meta.east, meta.south], [meta.west, meta.south]],
    });
    mapa.addLayer({ id: 'mlha-rytina', type: 'raster',
      source: 'mlha-kronika',
      paint: { 'raster-fade-duration': 0 } }, kotva());
    // Rytina už kreslí — teprve teď se do masky vyřízne její obdélník
    const m = mapa.getSource('mlha-maska');
    if (m) m.setData(maska(true));
    obnovZdroj();
    // ⏱ chvíle, kdy mlha přestane být plná deska a ukáže objevený svět
    try {
      window.__casy = window.__casy || {};
      window.__casy.mlhaRytina = Math.round(performance.now());
      if (typeof window.__naSvetHotov === 'function') window.__naSvetHotov();
    } catch (e) { /* nevadí */ }
  }

  // Přidá zdroje a vrstvy do právě načteného stylu (volat po style.load)
  function pripoj(map) {
    mapa = map;
    try {
      window.__casy = window.__casy || {};
      window.__casy.mlhaPripoj = Math.round(performance.now());
    } catch (e) { /* nevadí */ }
    nactiAssety();
    nactiBunky();      // Voroného buňky vlajek (odkrývání po oblastech)
    pripravPlatno();   // assety už bývají stažené (předstih), takže hned
    if (map.getSource('mlha-maska')) return;
    const pred = kotva();

    // Plochý pergamen kryje celý svět; díru pro rytinu vyřízne až
    // pridejVrstvuRytiny. Barva navazuje na okraj rytiny → neviditelný šev
    map.addSource('mlha-maska', { type: 'geojson', maxzoom: 8,
      data: maska(!!map.getSource('mlha-kronika')) });
    map.addLayer({ id: 'mlha-pergamen', type: 'fill', source: 'mlha-maska',
      paint: { 'fill-color': PERGAMEN_BARVA, 'fill-opacity': 1 } }, pred);

    // Rytina ČR (canvas) — čeká na načtení assetů
    pridejVrstvuRytiny();
  }

  // -------------------------------------------------------------------------
  // Veřejné API (stejné volá i mobilní aplikace přes JS most)
  // -------------------------------------------------------------------------
  // Registrace posluchače objevů: cb({lng, lat, r}) po každém novém objevu,
  // cb(null) po resetu (nutno přepočítat vše)
  function priObjeveni(cb) { posluchaci.push(cb); }

  // ⚡ MŘÍŽKOVÝ INDEX OBJEVENÝCH KRUHŮ (7. 8. 2026, hon na sekání).
  //
  // `jeObjeveno` procházelo VŠECHNY kruhy stopy lineárně. Po pár měsících
  // chození jich uživatel má v úložišti 2,4 MB, takže JEDEN dotaz stál
  // **1,46 ms** (změřeno na telefonu). A kaskáda kreseb se na mlhu ptá
  // u KAŽDÉHO ze 455 malovaných míst při každém přepočtu → ~660 ms na
  // jeden průchod. V profilu oddálené mapy to byla největší položka
  // vůbec: **28 % veškerého času** (a odtud i 300–590ms bloky hlavního
  // vlákna, tedy to, co uživatel vidí jako sekání při oddálení).
  //
  // Index je obyčejná mřížka 0,02° (~2,2 km): kruh se zapíše do všech
  // buněk, které protíná jeho obálka, a dotaz sáhne jen do jedné buňky.
  // Staví se líně a udržuje se přírůstkově v `objev`.
  const MRIZKA_MLHY = 0.02;
  let indexKruhu = null;

  function zaradDoIndexu(o) {
    if (!indexKruhu) return;
    const dLat = o.r / 110.574;
    const dLng = o.r / (111.32 * Math.cos(o.lat * Math.PI / 180));
    const gx0 = Math.floor((o.lng - dLng) / MRIZKA_MLHY);
    const gx1 = Math.floor((o.lng + dLng) / MRIZKA_MLHY);
    const gy0 = Math.floor((o.lat - dLat) / MRIZKA_MLHY);
    const gy1 = Math.floor((o.lat + dLat) / MRIZKA_MLHY);
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const k = gx + ':' + gy;
        const s = indexKruhu.get(k);
        if (s) s.push(o); else indexKruhu.set(k, [o]);
      }
    }
  }

  /// Index se zahazuje při každé změně seznamu kruhů (reset, dávka obcí).
  function zahodIndex() { indexKruhu = null; }

  // ⚡ PAMĚŤ ODPOVĚDÍ (12. 8. 2026, hon na sekání): kaskáda kreseb
  // a výsev dekorací se ptají na TYTÉŽ souřadnice při každém průchodu
  // a hlavně smyčka přes obce (ray-casting po vrcholech polygonů) stála
  // 113 ms za jedno gesto zoomu. Mlha jen roste, takže `true` platí
  // navěky; `false` jen do dalšího přírůstku (kruh/obec) – ten maže
  // pouze zapamatovaná `false` přes zapomenNeobjevene(). Reset a dávka
  // obcí (nahrazují seznam) mažou vše.
  const memoMlhy = new Map();     // "lng:lat" → bool
  function zapomenNeobjevene() {
    for (const [k, v] of memoMlhy) { if (!v) memoMlhy.delete(k); }
  }

  // Leží bod v už objeveném území? (kruhy stopy NEBO dokončená obec)
  function jeObjeveno(lng, lat) {
    const klic = lng + ':' + lat;
    const zapamatovano = memoMlhy.get(klic);
    if (zapamatovano !== undefined) return zapamatovano;
    if (!indexKruhu) {
      indexKruhu = new Map();
      for (const o of objevene) zaradDoIndexu(o);
    }
    let vysledek = false;
    const kruhy = indexKruhu.get(
      Math.floor(lng / MRIZKA_MLHY) + ':' + Math.floor(lat / MRIZKA_MLHY));
    if (kruhy) {
      const naKmLat = 110.574;
      const naKmLng = 111.32 * Math.cos(lat * Math.PI / 180);
      for (const o of kruhy) {
        const dx = (lng - o.lng) * naKmLng;
        const dy = (lat - o.lat) * naKmLat;
        if (dx * dx + dy * dy <= o.r * o.r) { vysledek = true; break; }
      }
    }
    if (!vysledek) {
      // obcí jsou desítky a mají obálku, takže lineárně stačí
      for (const ob of obce) {
        if (bodVObci(lng, lat, ob)) { vysledek = true; break; }
      }
    }
    if (memoMlhy.size > 50000) memoMlhy.clear();   // pojistka růstu
    memoMlhy.set(klic, vysledek);
    return vysledek;
  }

  /// HROMADNÉ PŘEDÁNÍ DOKONČENÝCH OBCÍ (bez animace – při startu jich
  /// aplikace pošle klidně stovky). `pole` = [[kruh, kruh…], …], kruh =
  /// [[lng,lat], …]. Seznam se NAHRAZUJE (zdroj pravdy je aplikace).
  /// Levý otisk seznamu obcí — na poznání, že se NIC nezměnilo.
  const KLIC_OTISK = 'mlha-obce-otisk-v1';
  let otiskObci = (function () {
    try { return localStorage.getItem(KLIC_OTISK) || ''; } catch (e) { return ''; }
  })();

  function spocitejOtiskObci(pole) {
    let n = 0;
    let s = 0;
    for (const kruhy of pole || []) {
      for (const k of kruhy || []) {
        n++;
        s = (s + (k[0] * 1000 | 0) + (k[1] * 1000 | 0) * 7) | 0;
      }
    }
    return n + ':' + s;
  }

  function objevObceDavka(pole) {
    // ⭐⭐ v1.514: STEJNÝ SEZNAM = NIC NEDĚLAT.
    //
    // Aplikace posílá dokončené obce při KAŽDÉM startu a engine na to
    // odpovídal `prekresliPlatno()`, tedy plným vyrytím 130 941 děr —
    // **změřeno 3,8–3,9 s na hlavním vlákně, při každém spuštění**,
    // a to i tehdy, když bylo plátno právě načtené z keše. Blokované
    // vlákno pak zdrželo i noční patro, takže mapa při nočním startu
    // problikla denními barvami.
    //
    // ⚠️ Otisk se ukládá do localStorage, protože po startu je `obce`
    // sice načtené z úložiště, ale jako zpracované objekty — ze
    // syrových kruhů od appky by se stejný otisk spočítat nedal.
    const novy = spocitejOtiskObci(pole);
    if (novy === otiskObci && pripraveno) return;

    obce = [];
    memoMlhy.clear();            // seznam obcí se NAHRAZUJE, mohl se zmenšit
    for (const kruhy of pole || []) {
      const ob = pripravObec(kruhy);
      if (ob) obce.push(ob);
    }
    otiskObci = novy;
    try { localStorage.setItem(KLIC_OTISK, novy); } catch (e) { /* nevadí */ }
    prekresliPlatno();
    uloz();
    for (const cb of posluchaci) { try { cb(null); } catch (e) {} }
  }

  /// PRÁVĚ DOKONČENÁ OBEC – vyroste od středu (oslava jako v 2D).
  function dokoncenaObec(kruhy) {
    const ob = pripravObec(kruhy);
    if (!ob) return;
    obce.push(ob);
    zapomenNeobjevene();         // růst mlhy: zapamatovaná `false` neplatí
    rostouci.push({ ob, t0: performance.now() });
    spustAnimaci();
    oslavObec(ob);
    uloz();
    for (const cb of posluchaci) { try { cb(null); } catch (e) {} }
  }

  // ——— OSLAVA ODEMČENÍ (v2.1, obdoba _flashRing ve 2D) ———
  // Zlatý obrys obce zazáří a během ~1,8 s pohasne. Kreslí se vlastní
  // vrstvou (ne na plátno rytiny – záři nejde z canvasu „odkreslit").
  let oslavaCasovac = null;

  function oslavObec(ob) {
    if (!mapa) return;
    try {
      const gj = { type: 'Feature', properties: {},
                   geometry: { type: 'Polygon', coordinates: ob.kruhy } };
      const zdroj = mapa.getSource('mlha-oslava');
      if (zdroj) {
        zdroj.setData(gj);
      } else {
        mapa.addSource('mlha-oslava', { type: 'geojson', data: gj });
        // ⛔⛔ DO DRAPOVANÉHO BLOKU (7. 8. 2026). Tahle vrstva je `line`,
        // tedy DRAPOVANÁ, a přidávala se BEZ `beforeId` — seděla nad
        // symboly a tím zakládala DRUHÝ RTT stack, tedy další texturu na
        // každou terénní dlaždici a snímek. Celá práce v1.275 přitom byla
        // o cestě ze tří stacků na jeden; stačilo dokončit jednu obec
        // a byli jsme zpátky na dvou — do konce sezení, protože
        // `isHidden` v MapLibre kouká na `visibility` a zoom, NE na
        // `line-opacity`, takže zhasnutá vrstva stack drží dál.
        mapa.addLayer({
          id: 'mlha-oslava', type: 'line', source: 'mlha-oslava',
          paint: { 'line-color': '#E7B84C', 'line-width': 3.5,
                   'line-opacity': 0.95, 'line-blur': 0.5 },
        }, predSymboly());
      }
      if (oslavaCasovac) clearInterval(oslavaCasovac);
      const t0 = performance.now();
      mapa.setPaintProperty('mlha-oslava', 'line-opacity', 0.95);
      oslavaCasovac = setInterval(() => {
        const f = (performance.now() - t0) / 1800;
        try {
          if (f >= 1) {
            clearInterval(oslavaCasovac);
            oslavaCasovac = null;
            // ⭐ VRSTVU ROVNOU ODSTRANIT, ne jen zhasnout. Zhasnutá
            // drapovaná vrstva se dál kreslí do textury KAŽDÉ terénní
            // dlaždice (MapLibre ji nepovažuje za skrytou — `isHidden`
            // řeší jen visibility a zoom). Po oslavě už není k ničemu.
            if (mapa.getLayer('mlha-oslava')) mapa.removeLayer('mlha-oslava');
            if (mapa.getSource('mlha-oslava')) mapa.removeSource('mlha-oslava');
          } else {
            // dvě zablikání a dohasnutí (jako rozsvícení obce ve 2D)
            const puls = 0.5 + 0.5 * Math.cos(f * Math.PI * 3);
            mapa.setPaintProperty('mlha-oslava', 'line-opacity',
                (1 - f) * (0.55 + 0.40 * puls));
          }
        } catch (e) {
          // výměna stylu vrstvu smazala – prostě skončit
          clearInterval(oslavaCasovac);
          oslavaCasovac = null;
        }
      }, 60);
    } catch (e) { /* oslava je jen ozdoba */ }
  }

  // ── BUŇKY VLAJEK (26. 8.: „vybarvoval tyto oblasti kolem pozice
  // uživatele při pohybu… v objeviteli s jemnými hranami") ──────────
  //
  // Stejná Voroného území jako v Dobyvateli (assets/vlajky_oblasti.json,
  // feature id = index vlajky). Členství v buňce = NEJBLIŽŠÍ vlajka —
  // to je definice Voroného diagramu, žádné testy polygonů.
  //
  // ⚠️ ŽÁDNÝ NOVÝ STAV SE NEUKLÁDÁ: odkryté buňky se ODVOZUJÍ ze
  // seznamu `objevene` (bod v buňce = buňka odkrytá), takže přežijí
  // ztrátu keše plátna i reinstalaci stejně jako mlha sama.
  let bunkyData = null;          // {body, oblasti, mrizka}
  let bunkyNacitani = null;
  let bunkyOdkryte = new Set();
  let bunkyZpracovano = 0;       // kolik bodů `objevene` už je promítnuto
  // Buňku odkrývá jen bod s PĚŠÍM poloměrem (0,232 km); menší poloměr
  // (0,174 km) značí buňku stopy jen PROJETOU AUTEM — ta kreslí dál
  // jen úzký kroužek jako dřív. Ověřený nález 26. 8.: „odmlženo víc,
  // než jsem prošel" dělaly právě celé buňky podél projetých silnic.
  const BUNKA_PESKY_R = 0.2;
  const B_KLON = 111.32 * Math.cos(49.75 * Math.PI / 180);
  const B_KLAT = 110.574;

  function nactiBunky() {
    if (bunkyNacitani) return bunkyNacitani;
    bunkyNacitani = (async () => {
      try {
        const [vl, obl] = await Promise.all([
          (await fetch('assets/vlajky.json')).json(),
          (await fetch('assets/vlajky_oblasti.json')).json(),
        ]);
        const body = vl.vlajky.map((v) => [v.lon, v.lat]);
        const oblasti = new Array(body.length).fill(null);
        for (const f of obl.features) oblasti[f.id] = f.geometry;
        const mrizka = new Map();
        for (let i = 0; i < body.length; i++) {
          const k = Math.floor(body[i][0] / 0.04) + '_'
              + Math.floor(body[i][1] / 0.027);
          const seznam = mrizka.get(k);
          if (seznam) seznam.push(i); else mrizka.set(k, [i]);
        }
        bunkyData = { body, oblasti, mrizka };
        // keš plátna mohla vzniknout dřív, než data dojela — dovodit
        // buňky ze všech dosavadních objevů a překreslit
        if (pripraveno && objevene.length) {
          const pred = bunkyOdkryte.size;
          zpracujBunky();
          if (bunkyOdkryte.size > pred) prekresliPlatno();
        }
      } catch (e) { /* bez dat prostě zůstanou jen kruhy */ }
    })();
    return bunkyNacitani;
  }

  function najdiBunku(lng, lat) {
    const gx = Math.floor(lng / 0.04);
    const gy = Math.floor(lat / 0.027);
    for (let r = 0; r <= 5; r++) {
      let nej = -1;
      let nejD = Infinity;
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const seznam = bunkyData.mrizka.get((gx + dx) + '_' + (gy + dy));
          if (!seznam) continue;
          for (const i of seznam) {
            const b = bunkyData.body[i];
            const ddx = (lng - b[0]) * B_KLON;
            const ddy = (lat - b[1]) * B_KLAT;
            const d = ddx * ddx + ddy * ddy;
            if (d < nejD) { nejD = d; nej = i; }
          }
        }
      }
      // kandidát z okruhu r může být dál než nejbližší z okruhu r+1,
      // proto se po nálezu projde ještě jeden prstenec
      if (nej >= 0 && r > 0) return nej;
      if (nej >= 0) {
        const gr = r + 1;
        for (let dx = -gr; dx <= gr; dx++) {
          for (let dy = -gr; dy <= gr; dy++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== gr) continue;
            const seznam = bunkyData.mrizka.get(
                (gx + dx) + '_' + (gy + dy));
            if (!seznam) continue;
            for (const i of seznam) {
              const b = bunkyData.body[i];
              const ddx = (lng - b[0]) * B_KLON;
              const ddy = (lat - b[1]) * B_KLAT;
              const d = ddx * ddx + ddy * ddy;
              if (d < nejD) { nejD = d; nej = i; }
            }
          }
        }
        return nej;
      }
    }
    return -1;
  }

  function bunkaTvar(idx) {
    const g = bunkyData.oblasti[idx];
    if (!g) return null;
    const kruhy = g.type === 'Polygon'
        ? [g.coordinates[0]]
        : g.coordinates.map((p) => p[0]);
    return { kruhy, stred: bunkyData.body[idx] };
  }

  /// Promítne dosud nezpracované objevy do množiny buněk; vrací nové.
  function zpracujBunky() {
    const nove = [];
    if (!bunkyData) return nove;
    for (; bunkyZpracovano < objevene.length; bunkyZpracovano++) {
      const o = objevene[bunkyZpracovano];
      if (o.r < BUNKA_PESKY_R) continue;   // auto = jen úzký pruh
      const idx = najdiBunku(o.lng, o.lat);
      if (idx >= 0 && !bunkyOdkryte.has(idx)) {
        bunkyOdkryte.add(idx);
        nove.push(idx);
      }
    }
    return nove;
  }

  function objev(lng, lat, r) {
    // Stojící hráč (GPS hlásí pořád totéž) nesmí nafukovat seznam:
    // přeskočit, pokud bod už pokrývá nedávný stejně velký kruh
    const naKmLat = 110.574;
    const naKmLng = 111.32 * Math.cos(lat * Math.PI / 180);
    for (let i = objevene.length - 1, k = 0; i >= 0 && k < 400; i--, k++) {
      const s = objevene[i];
      const dx = (lng - s.lng) * naKmLng;
      const dy = (lat - s.lat) * naKmLat;
      const prah = s.r * 0.45;
      if (s.r >= r && dx * dx + dy * dy < prah * prah) return;
    }
    const o = { lng, lat, r };
    objevene.push(o);
    zaradDoIndexu(o);            // index se udržuje přírůstkově
    zapomenNeobjevene();         // růst mlhy: zapamatovaná `false` neplatí
    // ⭐ 26. 8.: odkrývá se po BUŇKÁCH — kroužek roste jen jako záloha,
    // dokud data buněk nedojela (pak by nový bod nebyl vidět vůbec)
    if (bunkyData) {
      if (o.r < BUNKA_PESKY_R) {
        rostouci.push({ o, t0: performance.now() });   // autem: kroužek
      }
      for (const idx of zpracujBunky()) {
        const tvar = bunkaTvar(idx);
        if (tvar) {
          rostouci.push({ ob: tvar, bunka: true,
                          t0: performance.now() });
        }
      }
    } else {
      rostouci.push({ o, t0: performance.now() });
      nactiBunky();
    }
    spustAnimaci();
    uloz();
    for (const cb of posluchaci) { try { cb(o); } catch (e) {} }
  }

  function reset() {
    zastav();
    bunkyOdkryte = new Set();
    bunkyZpracovano = 0;
    objevene = vychozi();
    zahodIndex();
    memoMlhy.clear();
    obce = [];
    rostouci = [];
    prekresliPlatno();
    ulozHned();
    for (const cb of posluchaci) { try { cb(null); } catch (e) {} }
  }

  function zastav() {
    if (bezici) { clearInterval(bezici); bezici = null; }
  }

  // Demo: výprava Rtyně → Trutnov → Pec pod Sněžkou → Sněžka.
  // Postupně odkrývá mlhu podél trasy, na závěr 3D přílet na Sněžku.
  function demoVyprava(map) {
    zastav();
    const trasa = [
      [16.0725, 50.5050],  // Rtyně v Podkrkonoší
      [16.0130, 50.5390],  // Malé Svatoňovice
      [15.9090, 50.5610],  // Trutnov
      [15.8330, 50.6050],  // Mladé Buky
      [15.8170, 50.6260],  // Svoboda nad Úpou
      [15.7330, 50.6930],  // Pec pod Sněžkou
      [15.7396, 50.7360],  // Sněžka
    ];
    // Hustá interpolace trasy
    const body = [];
    const NA_USEK = 12;
    for (let i = 0; i < trasa.length - 1; i++) {
      for (let k = 0; k < NA_USEK; k++) {
        const t = k / NA_USEK;
        body.push([
          trasa[i][0] + (trasa[i + 1][0] - trasa[i][0]) * t,
          trasa[i][1] + (trasa[i + 1][1] - trasa[i][1]) * t,
        ]);
      }
    }
    body.push(trasa[trasa.length - 1]);

    // Nadhled na Podkrkonoší, pak krokové odkrývání
    map.flyTo({ center: [15.88, 50.62], zoom: 10.2, pitch: 45, bearing: -12,
                duration: 2600, essential: true });
    let i = 0;
    bezici = setInterval(() => {
      if (i >= body.length) {
        zastav();
        // Závěrečný 3D přílet na Sněžku
        map.flyTo({ center: [15.7396, 50.7325], zoom: 13.2, pitch: 68,
                    bearing: 15, duration: 4200, essential: true });
        return;
      }
      const [lng, lat] = body[i++];
      objev(lng, lat, 1.15 + Math.abs(Math.sin(i * 1.7)) * 0.35);
    }, 110);
  }

  // ⭐⭐ v1.509: ASSETY MLHY SE STAHUJÍ HNED, NE AŽ S MAPOU.
  //
  // ZMĚŘENO (razítka `window.__casy`, dva starty): mapa má první
  // snímek v 1,2 s, ale rytina mlhy byla hotová až v 5,3–6,3 s — tedy
  // 2,4–2,8 s poté, co se mlha připojila. Do té doby kryje svět PLNÁ
  // deska pergamenu, a to je ta „nejdřív se vykreslí světlá mapa
  // a pak herní", na kterou si uživatel stěžuje.
  //
  // Přitom stažení `kronika_cr.jpg` + `kronika_meta.json` na mapě
  // vůbec nezávisí. Rozjede se už při načtení skriptu, tedy souběžně
  // se stavěním mapy, a v `pripoj` už je plátno většinou hotové.
  // ⚠️ PŘEDBÍHÁ SE JEN STAŽENÍ, NE STAVBA PLÁTNA — ta zůstává
  // v `pripoj` (viz strašák v `pripravPlatno`: dřív postavené plátno
  // shodilo keš a start se protáhl na 14 s).
  try { nactiAssety(); } catch (e) { /* dohoní to `pripoj` */ }

  return { pripoj, objev, objevObceDavka, dokoncenaObec, reset, demoVyprava,
           zastav, priObjeveni, jeObjeveno };
})();
