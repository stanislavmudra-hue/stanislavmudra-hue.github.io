// Okolník 3D — erby dokončených obcí v herním stylu (v2.2).
//
// Zdroj pravdy je APLIKACE (stejná zásada jako u mlhy a míst): přes most
// pošle `[{lat, lon, url}]` pro obce, které hráč dokončil — engine nic
// nedopočítává a seznam se NAHRAZUJE. `url` míří na asset server aplikace
// (`/assets/erby/<klíč>.webp`), v demu na `assets/erby/…` enginu.
//
// Obrázky se nahrávají líně podle vzoru `zajistiIkonu` v main.js:
// Map url→Promise (souběžná volání čekají na tentýž fetch) + negativní
// keš selhaných. Id v atlasu má předponu `erb:`, aby si erby nepletl
// s ikonami míst globální styleimagemissing hook v main.js.
//
// Chování zrcadlí 2D Okolník (_erbMarkers v home_screen): od z 10,4,
// velikost SKOKEM po prazích 11,4/12,6, contain, střed obce. Velikosti
// ale na přání uživatele (5. 8., „erby jsou moc malé") ×1,5 proti 2D:
// box 24/32/39 CSS px. Strop 55 značek z 2D se NEpřebírá — byla to
// mitigace ANR flutter_map MarkerLayeru, MapLibre kreslí symboly nativně.
// Kreslí se jen v HERNÍM stylu — dokončené obce jsou herní prvek a
// v ostatních stylech není mlha ani vybarvení obcí, erb by visel ve
// vzduchu.
'use strict';

const Erby = (() => {
  let mapa = null;
  let seznam = [];                  // [{lng, lat, url}] — posílá aplikace
  const rozpracovane = new Map();   // url → Promise<boolean>
  // ⚠️ Negativní keš je nutný: localhost server APK vrací na chybějící
  // soubor 200 s 0 bajty a chyba se ukáže až v createImageBitmap — bez
  // keše by se vadný erb stahoval při každém překreslení dokola.
  const selhane = new Set();
  let klikHook = false;
  let missingHook = false;

  const idObrazku = (url) => 'erb:' + url;

  // -------------------------------------------------------------------------
  // Líné nahrávání obrázků erbů
  // -------------------------------------------------------------------------
  function zajisti(url) {
    if (typeof url !== 'string' || !url || !mapa) {
      return Promise.resolve(false);
    }
    const id = idObrazku(url);
    if (mapa.hasImage(id)) return Promise.resolve(true);
    if (selhane.has(url)) return Promise.resolve(false);
    const bezici = rozpracovane.get(url);
    if (bezici) return bezici;      // souběžné volání čeká na tentýž fetch
    const prace = (async () => {
      try {
        const odpoved = await fetch(url);
        if (!odpoved.ok) throw new Error('HTTP ' + odpoved.status);
        const bitmapa = await createImageBitmap(await odpoved.blob());
        // Jako 2D FastMarker: erb přes contain do boxu s poměrem
        // šířka×(šířka+4) = 26:30. Erby jsou často VYŠŠÍ než box (Rtyně
        // 60×72) a omezuje je výška — proto contain doprostřed plátna
        // 72×83 (poměr 26:30; 72 ≈ nativní šířka zdrojů, ať se kvůli
        // větším boxům zbytečně nepodvzorkovává). icon-size pak škáluje
        // celý box.
        const platno = document.createElement('canvas');
        platno.width = 72;
        platno.height = 83;
        const ctx = platno.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        const s = Math.min(72 / bitmapa.width, 83 / bitmapa.height);
        const w = bitmapa.width * s;
        const h = bitmapa.height * s;
        ctx.drawImage(bitmapa, (72 - w) / 2, (83 - h) / 2, w, h);
        bitmapa.close();
        if (mapa && !mapa.hasImage(id)) {
          // ImageData, ne <canvas> — plátno by addImage tiše neprošlo
          // (stejná past jako u `odbarvi` v main.js)
          mapa.addImage(id, ctx.getImageData(0, 0, 72, 83),
                        { pixelRatio: 2 });
        }
        return true;
      } catch (e) {
        selhane.add(url);
        console.warn('[Erby] erb nejde načíst', url, e);
        return false;
      } finally {
        // hotový fetch z mapy zmizí — po výměně stylu (prázdný atlas)
        // rozhoduje zase jen hasImage a soubor přijde z HTTP keše
        rozpracovane.delete(url);
      }
    })();
    rozpracovane.set(url, prace);
    return prace;
  }

  function kolekce() {
    return {
      type: 'FeatureCollection',
      features: seznam
        .filter((e) => e && isFinite(e.lng) && isFinite(e.lat) && e.url)
        .map((e) => ({
          type: 'Feature',
          properties: { ik: idObrazku(e.url), url: e.url,
                        lat: e.lat, lon: e.lng },
          geometry: { type: 'Point', coordinates: [e.lng, e.lat] },
        })),
    };
  }

  // -------------------------------------------------------------------------
  // Vrstva a klikání
  // -------------------------------------------------------------------------
  function registrujKliky() {
    if (klikHook || !mapa) return;
    klikHook = true;
    // posluchač na ID vrstvy přežije i její smazání při výměně stylu
    mapa.on('click', 'erby-vrstva', (e) => {
      const f = e.features && e.features[0];
      if (!f) return;
      const p = f.properties;
      console.log('[Erby] klik', p.url);
      try {
        if (window.__okolnikApp && window.flutter_inappwebview) {
          window.flutter_inappwebview.callHandler('onErb',
              { lat: p.lat, lon: p.lon, url: p.url });
        }
      } catch (err) { /* mimo appku se nic neděje */ }
    });
    mapa.on('mouseenter', 'erby-vrstva',
            () => { mapa.getCanvas().style.cursor = 'pointer'; });
    mapa.on('mouseleave', 'erby-vrstva',
            () => { mapa.getCanvas().style.cursor = ''; });
  }

  // Záložní cesta: herní styl je bez spritu, takže styleimagemissing
  // funguje. Hlavní cestou je ale vlastní dotažení ve vykresli() —
  // na stylech se spritem se událost nespouští (past z v1.226.1).
  function registrujMissing() {
    if (missingHook || !mapa) return;
    missingHook = true;
    mapa.on('styleimagemissing', (e) => {
      const id = e && e.id;
      if (typeof id !== 'string' || !id.startsWith('erb:')) return;
      zajisti(id.slice(4)).then((ok) => {
        // setData po addImage — pozdě přidaný obrázek se do hotových
        // symbolů sám nepromítne
        const zdroj = ok && mapa && mapa.getSource('erby-zdroj');
        if (zdroj) zdroj.setData(kolekce());
      });
    });
  }

  let cekaniNaMlhu = 0;
  async function vykresli() {
    if (!mapa) return;
    // Jen v herním stylu — poznávacím znamením je mlha (jako Ilustrace).
    if (!mapa.getSource('mlha-maska')) {
      // ⛔ engine 204: dřív tichý konec BEZ opakování – když web poslal erby
      // dřív, než mlha založila zdroj (pomalé načtení), erby se už nikdy
      // nenakreslily („erby nevidím vůbec"). Teď se až 30 s zkouší znovu;
      // v jiném než herním stylu mlha nepřijde a čekání skončí samo.
      if (cekaniNaMlhu++ < 60) {
        clearTimeout(vykresli._m);
        vykresli._m = setTimeout(vykresli, 500);
      }
      return;
    }
    cekaniNaMlhu = 0;
    const gj = kolekce();
    try {
      const zdroj = mapa.getSource('erby-zdroj');
      if (zdroj) {
        zdroj.setData(gj);
      } else {
        // buffer 0: s allow-overlap netřeba přesah — levnější přeskládání
        mapa.addSource('erby-zdroj',
                       { maxzoom: 14, type: 'geojson', data: gj, buffer: 0 });
        mapa.addLayer({
          id: 'erby-vrstva', type: 'symbol', source: 'erby-zdroj',
          minzoom: 10.4,     // jako 2D — z větší dálky by erby přeplácaly mapu
          layout: {
            'icon-image': ['get', 'ik'],
            // ⚠️ BEZ text-* — chybějící text-font shodí vrstvu POTICHU
            'icon-allow-overlap': true,      // erb nesmí mizet kolizemi
            'icon-ignore-placement': true,   // …ani vytlačovat popisky mapy
            'icon-anchor': 'center',
            // Skoky po prazích jako 2D _erbMarkers, ale ×1,5 (přání
            // uživatele) — box šířky 24/32/39 CSS px při základu 36 px
            // (plátno 72 / pixelRatio 2)
            'icon-size': ['step', ['zoom'],
                          0.667, 11.4, 0.889, 12.6, 1.083],
          },
        });
        registrujKliky();
        registrujMissing();
      }
    } catch (e) {
      // výměna stylu zrovna běží — zkusit za chvíli znovu
      clearTimeout(vykresli._t);
      vykresli._t = setTimeout(vykresli, 400);
      return;
    }
    // Obrázky dotáhnout a zdroj přeparsovat ZNOVU (vzor nactiIkonyZdroje):
    // symbol slepený dřív, než byl erb v atlasu, by jinak zůstal prázdný.
    const urls = [...new Set(gj.features.map((f) => f.properties.url))];
    if (!urls.length) return;
    await Promise.all(urls.map(zajisti));
    const zdroj = mapa && mapa.getSource('erby-zdroj');
    if (zdroj) zdroj.setData(gj);
  }

  // -------------------------------------------------------------------------
  // Veřejné API
  // -------------------------------------------------------------------------
  // Volat po style.load herního stylu (z aplikujDoplnky); opakovaně bezpečné
  function pripoj(map) {
    mapa = map;
    cekaniNaMlhu = 0;   // nový styl = nové čekání na mlhu
    selhane.clear();   // nový styl = nová šance pro dřív selhané soubory
    vykresli();
  }

  // Nový seznam erbů (most, [{lng, lat, url}] už překlopené). NAHRAZUJE.
  function nastav(pole) {
    seznam = Array.isArray(pole) ? pole : [];
    cekaniNaMlhu = 0;
    vykresli();
  }

  return { pripoj, nastav };
})();
