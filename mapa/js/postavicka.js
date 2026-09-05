// Okolník 3D — POSTAVIČKA UŽIVATELE (v2.1).
//
// Přenos figurky z 2D Okolníku (skins.dart, v1.212): sprite atlas
// 16 směrů; statický atlas = mřížka 4×4 (snímek 0 = záda/sever, index
// PO směru hodinových ručiček), atlas CHŮZE = 8×8, 16 směrů × 4 fáze
// a snímek 0 je POHLED ZEPŘEDU s indexem PROTI směru ručiček – proto
// se u chůze azimut ODEČÍTÁ (`8 − kroky`; bez toho se postava otáčela
// „přesně obráceně").
//
// ⚠️ NOHY NA BOD POLOHY: čára nohou je v ~90 % výšky snímku (změřeno
// z alfa kanálu atlasů) a musí padnout přesně na souřadnici – jinak
// postava „levituje". Marker kotví středem plátna, kresba se posouvá
// tak, aby nohy ležely ve středu (stejná matematika jako _SkinPainter).
//
// Za chůze (≥ 0,7 m/s) se přehrávají 4 fáze kroku (143 ms, svižně
// 111 ms); při stání fáze 0 a směr podle KOMPASU (kam se dívám), ne
// podle posledního pohybu.
'use strict';

const Postavicka = (() => {
  // ⚠️ 6. 8. 2026 („postavička vypadá rozmazaně a měla by se od určité
  // chvíle zvětšovat"): plátno se kreslilo v CSS pixelech, takže na
  // displeji s DPR 3 se výsledek TŘIKRÁT roztáhl — odtud rozmazání.
  // Backing store je nově v zařízených pixelech (`dpr`) a kontext se
  // škáluje; CSS rozměr zůstává stejný.
  // 6. 8. 2026 („postavička možná moc velká"): základ 96 → 78 px
  // a strop růstu ×2,0 → ×1,55. Po přiblížení tedy nejvýš ~121 px
  // místo dřívějších 192.
  const ZAKLAD_PX = 78;             // CSS px plátna značky při z ≤ 15
  const ROST_OD_Z = 15.0;
  const ROST_TEMPO = 0.5;
  const ROST_STROP = 1.55;
  let VELIKOST = ZAKLAD_PX;         // aktuální CSS px (mění se zoomem)
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const PODIL = 0.58;               // podíl postavy na plátně (jako 2D)
  const NOHY = 0.90;                // čára nohou v podílu výšky snímku
  const JDE_OD = 0.9;               // m/s – nad tím se ROZEJDE…
  const STANI_OD = 0.5;             // …a pod tím zase ZASTAVÍ (hystereze)
  const ROZCHOD_MS = 1500;          // jak dlouho musí rychlost vydržet
  const SVIZNE_OD = 1.6;            // m/s
  // ⭐ PLATNOST RYCHLOSTI: bez ní hystereze NEPOMŮŽE. `rychlost` se plní
  // jen s příchozím fixem, ale filtr aplikace při stání pustí fix třeba
  // až po 10 s – jediná šumová hodnota 1,0 m/s tak drží figurku v chůzi
  // donekonečna. Po téhle době bez čerstvého údaje platí, že stojíme.
  const RYCHLOST_PLATI_MS = 2500;
  // ⭐ v1.537: PLATNOST SE ŘÍDÍ SKUTEČNÝM ROZESTUPEM FIXŮ.
  //
  // Výtka testera: *„rychlost není plynulá a občas mizí."* Konstanta
  // 2,5 s byla kratší než rozestup fixů při dávkovaném odběru
  // (až 5 s) — mezi dvěma dávkami tedy rychlost „vypršela", cedulka
  // zhasla a za chvíli se zase rozsvítila. Platnost se proto počítá
  // z měřeného rozestupu; konstanta je už jen spodní mez.
  let mezeraRychlosti = 0;          // ms mezi posledními dvěma údaji
  function platnostRychlosti() {
    return Math.max(RYCHLOST_PLATI_MS,
        Math.min(12000, mezeraRychlosti * 2.2));
  }
  // Vyhlazená hodnota POUZE PRO CEDULKU. Krokování figurky a hystereze
  // chůze čtou dál syrovou `rychlost` — tam by vyhlazení jen zpozdilo
  // rozejití a zastavení.
  let rychlostHladka = 0;
  // ⭐ KLIDOVÉ PÁSMO SMĚRU: 16 snímků = krok 22,5°, takže azimut kmitající
  // kolem hranice překlápěl figurku mezi dvěma snímky sem a tam (další
  // část „přešlapování"). Směr se proto přepne, až se azimut vzdálí
  // o víc než polovinu kroku plus rezerva.
  const SMER_PASMO = 16;            // stupňů

  let mapa = null;
  let marker = null;
  let ctx = null;
  let atlas = null;
  let atlasNacten = false;
  let cfg = { sloupce: 8, faze: 4, obraceny: true };
  let smerPohybu = 0;
  let smerPohybuMs = 0;      // kdy naposled přišel VĚROHODNÝ kurz
  let smerKompasu = null;
  let rychlost = 0;
  let rychlostMs = 0;               // kdy naposledy přišel údaj o rychlosti
  let posledni = null;              // {lng, lat, ms} poslední známá poloha
  let kotva = null;                 // starší bod, ze kterého se měří posun
  let dir = -1;
  let faze = -1;
  let tikac = null;
  let jdeStav = false;        // hystereze chůze (viz JDE_OD / STANI_OD)
  let nadPrahemOd = 0;
  let smerKresleny = null;    // azimut, podle kterého je nakreslený snímek
  let fazePos = 0;            // fáze kroku v setinách (vlastní čas)
  let tikMs = 0;              // předchozí tik – pro přírůstek fáze

  function snimekProSmer(deg) {
    const kroky = Math.round(deg / 22.5);
    const i = cfg.obraceny ? 8 - kroky : kroky;
    return ((i % 16) + 16) % 16;
  }

  /// Velikost plátna podle zoomu (viz ROST_* výš). Vrací CSS px.
  function velikostProZoom() {
    if (!mapa) return ZAKLAD_PX;
    const z = mapa.getZoom();
    const nasobek = Math.min(ROST_STROP,
        Math.pow(2, ROST_TEMPO * Math.max(0, z - ROST_OD_Z)));
    return Math.round(ZAKLAD_PX * nasobek);
  }

  /// Přenastaví plátno, když se velikost znatelně změnila (≥ 4 px).
  /// Změna `width` plátno vyčistí, proto hned překreslit.
  function prizpusobVelikost() {
    const nova = velikostProZoom();
    if (!marker || Math.abs(nova - VELIKOST) < 4) return;
    VELIKOST = nova;
    const el = marker.getElement();
    el.width = VELIKOST * dpr;
    el.height = VELIKOST * dpr;
    el.style.width = VELIKOST + 'px';
    el.style.height = VELIKOST + 'px';
    ctx = el.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    kresli();
  }

  /// ⭐ v1.522: CEDULKA S RYCHLOSTÍ POD POSTAVIČKOU.
  ///
  /// Ve 2D mapě to bývalo (`_SpeedPill` v `home_screen.dart`), jenže od
  /// sjednocení na engine (v1.258) kreslí figurku engine a cedulka
  /// zůstala viset u `flutter_map`, který je dnes jen pro offline mapu.
  /// Uživateli tedy „zmizela rychlost" — ne regresí, ale tím, že se
  /// přestala kreslit vrstva, ve které žila.
  ///
  /// ⚠️ Text se kreslí do TÉHOŽ plátna jako postava, takže nestojí
  /// žádnou další značku ani vrstvu. Ale plátno se při každé změně
  /// nahrává na GPU, takže se překresluje jen tehdy, když se ZMĚNÍ
  /// ZOBRAZENÝ TEXT (ne při každém tiku a ne při šumu v desetinách).
  let textRychlosti = '';

  function popisRychlosti() {
    // pod 0,5 m/s je to šum GPS; plovoucí „0,3 km/h" pod nohama ruší
    // ⚠️ `jdeStav` je stav CHŮZE a při jízdě se překlápí s hysterezí —
    // proto se nad 4 m/s (≈ 15 km/h) na něj už neptáme; kdo jede, ten
    // se určitě hýbe a cedulka nemá proč blikat.
    if (rychlostHladka < 0.5) return '';
    if (!jdeStav && rychlostHladka < 4.0) return '';
    const kmh = rychlostHladka * 3.6;
    return kmh >= 10
        ? Math.round(kmh) + ' km/h'
        : (Math.round(kmh * 10) / 10).toFixed(1).replace('.', ',') + ' km/h';
  }

  function kresli() {
    if (!ctx || !atlasNacten) return;
    const bunka = atlas.naturalWidth / cfg.sloupce;
    const index = cfg.faze > 1 ? dir * cfg.faze + faze : dir;
    const col = index % cfg.sloupce;
    const row = Math.floor(index / cfg.sloupce);
    const s = VELIKOST * PODIL;
    ctx.clearRect(0, 0, VELIKOST, VELIKOST);
    // ⛔ žádný vlastní stín – kresby ho mají zapečený (v1.212.1)
    ctx.drawImage(atlas, col * bunka, row * bunka, bunka, bunka,
        VELIKOST / 2 - s / 2, VELIKOST / 2 - s * NOHY, s, s);
    if (textRychlosti) {
      const x = VELIKOST / 2;
      const y = VELIKOST / 2 + 11;
      ctx.font = '700 10.5px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const w = ctx.measureText(textRychlosti).width + 10;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x - w / 2, y - 7, w, 14, 7);
        ctx.fill();
      } else {
        ctx.fillRect(x - w / 2, y - 7, w, 14);
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillText(textRychlosti, x, y);
    }
  }

  /// ⭐ v1.565: hlásí aplikace z krokoměru (viz `postavickaKroky`).
  let krokyJdou = false;

  function tik() {
    if (!marker || !atlasNacten) return;
    // ⭐ HYSTEREZE CHŮZE (6. 8. 2026, „telefon leží na stole a postavička
    // stále přešlapuje"). GPS hlásí i vleže rychlost kolem 0,5–1,5 m/s,
    // takže holé `rychlost >= 0,7` cyklus chůze pořád spouštělo a zase
    // zastavovalo. Nově: rozejde se, až rychlost vydrží nad prahem
    // ROZCHOD_MS, a zastaví, až klesne pod NIŽŠÍ práh (STANI_OD).
    const ted = Date.now();
    // …a nejdřív ZAPOMENOUT starou rychlost, jinak je hystereze k ničemu
    if (rychlostMs && ted - rychlostMs > platnostRychlosti()) {
      rychlost = 0;
      rychlostHladka = 0;
    }
    if (rychlost >= JDE_OD) {
      if (!nadPrahemOd) nadPrahemOd = ted;
    } else {
      nadPrahemOd = 0;
    }
    if (!jdeStav && nadPrahemOd && ted - nadPrahemOd >= ROZCHOD_MS) {
      jdeStav = true;
    } else if (jdeStav && rychlost < STANI_OD) {
      jdeStav = false;
    }
    // ⭐ KROKOMĚR PŘEBÍJÍ RYCHLOST. Práh 0,9 m/s je 3,2 km/h; pomalá
    // chůze do kopce nebo mezi stromy se pod něj vejde a postavička
    // pak jen stojí, ačkoli člověk jde. Kroky jsou přímý důkaz, a
    // aplikace posílá až deset kroků za dvacet sekund, takže ťuknutí
    // do telefonu na stole tudy neprojde.
    const jde = jdeStav || krokyJdou;
    // ⭐⭐ SMĚR VŽDY Z KOMPASU, NIKDY Z KURZU GPS (10. 8. 2026).
    //
    // Výtka: „postavička občas přeskočí přesně opačně, než by měla."
    // Do teď se při CHŮZI bral `smerPohybu`, tedy kurz z GPS. Ten je
    // u pomalé chůze nepoužitelný — v `dumpsys location` na telefonu
    // stálo `bear=205.12 bAcc=179.9`, tedy přesnost ±180°, a přijímač
    // v takovém stavu běžně hlásí RECIPROČNÍ směr. Odtud ten skok
    // přesně o 180°, a odtud i to „občas": šum kurzu je nahodilý.
    //
    // Poznávací znamení, že vina není v kompasu: MAPA se natáčí
    // správně, a ta jede JEN z kompasu (`aplikujSmer`). Lišila se
    // právě jen postavička, a jen tím kurzem.
    //
    // Rychlost dál rozhoduje o tom, jestli se přehrává CHŮZE nebo stání
    // (`jde` níž) — mění se jen to, KAM je figurka otočená.
    // ⭐ v1.566: ZA CHŮZE PODLE POHYBU, PŘI STÁNÍ PODLE KOMPASU.
    //
    // Výtka 23. 8.: *„natáčení postavy blbne, občas nekouká správným
    // směrem."* Engine bral směr VŽDY z kompasu, tedy podle toho, kam
    // míří TELEFON. Jenže při chůzi ho člověk drží v ruce našikmo,
    // houpe s ním nebo ho má v kapse — a postava pak kouká jinam, než
    // kam se jde. **2D vykreslovač (`skins.dart`) to takhle dělá
    // odjakživa; rozcházel se s ním jen engine.**
    //
    // ⚠️ KURZ MUSÍ BÝT PROVĚŘENÝ. Do 10. 8. se bral syrový a `dumpsys`
    // ukazoval `bear=205.12 bAcc=179.9`, tedy přesnost ±180° a občas
    // RECIPROČNÍ směr — odtud tehdejší skoky přesně o 180°. Aplikace ho
    // proto propouští až přes bránu `_kurzZFixu` (rychlost ≥ 1 m/s,
    // kurz ≠ 0, přesnost kurzu ≤ 45°). Tady se navíc hlídá stáří:
    // zvětralý kurz by figurku držel natočenou po zastavení.
    const kurzCerstvy = smerPohybuMs > 0 && ted - smerPohybuMs < 8000;
    const deg = (jde && kurzCerstvy)
        ? smerPohybu
        : (smerKompasu !== null ? smerKompasu : smerPohybu);
    // ⚠️ ODEČÍST NATOČENÍ MAPY (oprava 6. 8. 2026, „GPS neukazuje správný
    // směr"). Značka je obyčejný HTML canvas, který se s mapou NEOTÁČÍ
    // (MapLibre má u markerů rotationAlignment 'auto' = viewport), kdežto
    // azimut je zeměpisný. Ve 3D se přitom mapa natáčí podle kompasu, a
    // tak postava mířila vedle přesně o to natočení: chůze na východ při
    // mapě otočené k východu má na obrazovce ukazovat VZHŮRU.
    const bearing = (mapa && typeof mapa.getBearing === 'function')
        ? mapa.getBearing() : 0;
    // ⭐ v1.398: pásmo tlumí JEN šum AZIMUTU (kompas/kurz), nikdy
    // natočení mapy. Dřív se hystereze počítala z rozdílu deg-bearing,
    // takže při rotaci mapy prstem figurka stála a pak SKOKEM dohnala
    // přes pásmo 16° („při rotaci mapy se postava občas otočí, když
    // je telefon nehnutý“). Teď: geo směr drží pásmo, otočení mapy
    // se promítá okamžitě a spojitě.
    if (smerKresleny === null
        || Math.abs(((deg - smerKresleny) % 360 + 540) % 360 - 180)
            > SMER_PASMO) {
      smerKresleny = deg;
    }
    const d = snimekProSmer(smerKresleny - bearing);
    // ⭐ FÁZE Z VLASTNÍHO ČASU. Dřív se počítala z volnoběžných hodin
    // (`Date.now() / krok`), takže jakmile `jde` bliklo, noha skočila na
    // náhodnou fázi a hned zpět na nulu – viditelný záškub i bez otočení.
    // Navíc tikač 140 ms proti periodě 111/143 ms aliasoval.
    let f = 0;
    if (cfg.faze > 1) {
      const dt = tikMs ? ted - tikMs : 0;
      if (jde) {
        const krok = rychlost >= SVIZNE_OD ? 111 : 143;
        fazePos = (fazePos + dt / krok) % cfg.faze;
      } else {
        fazePos = 0;              // při stání se stojí v základním postoji
      }
      f = Math.floor(fazePos);
    }
    tikMs = ted;
    const novyText = popisRychlosti();
    if (d !== dir || f !== faze || novyText !== textRychlosti) {
      dir = d;
      faze = f;
      textRychlosti = novyText;
      kresli();
    }
    prizpusobVelikost();   // růst s přiblížením (levné, jen při změně)
  }

  /// Nastaví (nebo vymění) atlas postavičky. `url === null` figurku
  /// odstraní – most se pak vrátí k modré tečce.
  function nastav(url, nastaveni) {
    if (!url) {
      zrus();
      return;
    }
    cfg = {
      sloupce: (nastaveni && nastaveni.sloupce) || 8,
      faze: (nastaveni && nastaveni.faze) || 4,
      obraceny: !nastaveni || nastaveni.obraceny !== false,
    };
    atlasNacten = false;
    atlas = new Image();
    atlas.onload = () => {
      atlasNacten = true;
      dir = -1;                     // vynutit první překreslení
      tik();
    };
    atlas.onerror = () => console.warn('[Postavicka] atlas se nenačetl:', url);
    atlas.src = url;
    // tikač 70 ms (dřív 140): perioda fáze je 111/143 ms, takže pomalejší
    // tikač fáze přeskakoval. Tik je levný – jen čte proměnné.
    if (!tikac) tikac = setInterval(tik, 70);
  }

  /// Posun figurky. `smer` = azimut pohybu (stupně), `spd` = m/s;
  /// když chybí, odhadnou se z předchozí polohy.
  function poloha(lng, lat, smer, spd) {
    if (!mapa || !atlas) return false;   // bez atlasu ať most kreslí tečku
    const ted = Date.now();
    if (typeof spd === 'number' && isFinite(spd)) {
      if (rychlostMs) mezeraRychlosti = ted - rychlostMs;
      rychlost = spd;
      // ⚠️ Cedulka se překresluje jen při ZMĚNĚ TEXTU, takže syrová
      // hodnota poskakující o jednotky km/h ji nutí do překreslení
      // pořád dokola a číslo pod nohama tančí. Klouzavý průměr to
      // uklidní, aniž by zpozdil velké změny (rozjezd, brzdění).
      rychlostHladka = rychlostHladka > 0
          ? rychlostHladka * 0.6 + spd * 0.4
          : spd;
      rychlostMs = ted;
    } else if (kotva) {
      // ⚠️ ODHAD Z POLOH JE JEN NOUZOVKA a musí být přísný: čas je čas
      // DORUČENÍ do WebView, ne GPS razítko. Dřív stačilo dt > 0,3 s, a
      // tak z pětimetrového skoku vyšel „sprint" 5 m/s. Teď se měří
      // z DELŠÍHO úseku (vlastní kotva, ne poslední fix) a jen když je
      // posun větší než šum.
      const dt = (ted - kotva.ms) / 1000;
      if (dt >= 1.5) {
        const dx = (lng - kotva.lng) * 111320
            * Math.cos(lat * Math.PI / 180);
        const dy = (lat - kotva.lat) * 111320;
        const posun = Math.hypot(dx, dy);
        let v = posun >= 6 ? posun / dt : 0;
        if (v < 0.5) v = 0;
        if (rychlostMs) mezeraRychlosti = ted - rychlostMs;
        rychlost = v;
        rychlostHladka =
            rychlostHladka > 0 ? rychlostHladka * 0.6 + v * 0.4 : v;
        rychlostMs = ted;
        if (v > 0) {
          smerPohybu = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
        }
        kotva = { lng, lat, ms: ted };
      }
    } else {
      kotva = { lng, lat, ms: ted };
    }
    // ⚠️ KURZ JEN ZA CHŮZE. `heading` z geolocatoru není nulovatelný a při
    // stání vrací 0.0 – bez téhle podmínky se figurka na stole otočila
    // k SEVERU jako by to byl platný údaj (nález prověrky 6. 8. 2026).
    if (jdeStav && typeof smer === 'number' && isFinite(smer) && smer !== 0) {
      smerPohybu = smer;
      smerPohybuMs = ted;
    }
    posledni = { lng, lat, ms: ted };
    if (!marker) {
      VELIKOST = velikostProZoom();
      const el = document.createElement('canvas');
      el.width = VELIKOST * dpr;      // ostře: backing store v px zařízení
      el.height = VELIKOST * dpr;
      el.style.cssText = 'width:' + VELIKOST + 'px;height:' + VELIKOST
          + 'px;pointer-events:none;';
      ctx = el.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // ⚠️ `opacityWhenCovered: '1'` (6. 8. 2026, „při větším naklonění
      // se zprůhlednila postava hráče"): MapLibre značky, které mu terén
      // zakryje, sám ztlumí. Postavička stojí NA terénu, takže je to
      // falešný poplach – zůstane plná.
      marker = new maplibregl.Marker({
        element: el, anchor: 'center', opacityWhenCovered: '1',
      }).setLngLat([lng, lat]).addTo(mapa);
      // ⛔⛔ VYPNOUT TEST ZÁKRYTU TERÉNEM (6. 8. 2026, hon na sekání).
      // MapLibre u KAŽDÉ značky volá `Marker._updateOpacity`, a ten se
      // zapnutým terénem dělá DVA `terrain.depthAtPoint()` – a to je
      // `gl.readPixels`, tedy SYNCHRONNÍ ČTENÍ Z GPU (zastaví frontu).
      // K tomu `getElevationForLngLat`, který uvnitř prochází strom
      // dlaždic. Plánuje se z každé události `move` (škrceno na 100 ms,
      // na `moveend` bez škrcení) = 10–20 zámků GPU za vteřinu právě při
      // posouvání mapy. `opacityWhenCovered: '1'` to NEOBEJDE – ta větev
      // se uplatní jen když terén vůbec není.
      // Postavička stojí NA terénu, takže test stejně nikdy nemá co
      // schovat; nahradíme ho prázdnou funkcí.
      try { marker._updateOpacity = function () {}; } catch (e) { /* nevadí */ }
      dir = -1;
      tik();
    } else {
      marker.setLngLat([lng, lat]);
    }
    return true;
  }

  /// Azimut z kompasu aplikace – směr postoje při stání.
  function kompas(deg) { smerKompasu = deg; }

  /// Hlásí aplikace: chodí uživatel právě teď podle krokoměru?
  function kroky(ano) { krokyJdou = !!ano; }

  function pripoj(map) { mapa = map; }

  function zrus() {
    if (tikac) { clearInterval(tikac); tikac = null; }
    if (marker) { marker.remove(); marker = null; }
    ctx = null;
    atlas = null;
    atlasNacten = false;
    posledni = null;
    kotva = null;
    rychlost = 0;
    rychlostHladka = 0;
    mezeraRychlosti = 0;
    rychlostMs = 0;
    jdeStav = false;
  }

  /// Poslední známá poloha uživatele ({lng, lat}) nebo null. Používá ji
  /// hlášení kamery do aplikace (modrá šipka k uživateli).
  function poslednPoloha() {
    return posledni ? { lng: posledni.lng, lat: posledni.lat } : null;
  }

  /// ŠETŘENÍ BATERIE (10. 8. 2026): když appka mapu překryje vlastní
  /// obrazovkou, nemá cenu hýbat figurkou. `document.hidden` to nepozná —
  /// stránka je pořád „viditelná", jen ji nikdo nevidí. Hlásí to appka
  /// mostem (`OkolnikMost.vidno`).
  /// ⚠️ Tikač se nesmí jen zastavit a zapomenout: bez `dir = -1` by po
  /// návratu figurka zůstala v poslední fázi, dokud se nepohne.
  function nastavVidno(ano) {
    if (ano) {
      if (!tikac && atlas) { dir = -1; tikac = setInterval(tik, 70); tik(); }
    } else if (tikac) {
      clearInterval(tikac);
      tikac = null;
    }
  }

  return { pripoj, nastav, poloha, kompas, kroky, zrus, poslednPoloha,
           nastavVidno };
})();
