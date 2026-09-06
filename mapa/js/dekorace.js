// Okolník 3D — MALOVANÉ DEKORACE KRAJINY (stromy, kytky, střechy).
//
// Vzniklo 7. 8. po výtce „stromy, květy i střechy pořád poskakují,
// přibývají a zmenšují se": dlaždicový vzor (fill-pattern) se s každým
// celým zoomem přeskládá, takže objekty v něm NIKDY nedrží na místě.
// Objekty proto přestěhovány do SKUTEČNÝCH bodů mapy (symbol vrstva):
//
//   · pozice je DETERMINISTICKÁ — pevná zeměpisná mřížka s jitterem
//     z hashe (ix, iy), takže tentýž strom stojí navěky na témže místě,
//   · z dálky malé, s přiblížením PLYNULE ROSTOU (icon-size =
//     interpolate exponential(2) přes zoom — GPU, žádné přepočty),
//   · NIKDY nepřibývají ani nemění pozice při zoomu — jen jednou měkce
//     nastoupí na svém prahu (opacity rampa) a pak už jen rostou;
//     s posunem mapy se doplňují jen NOVÉ buňky na kraji (mimo obraz).
//
// Kam co patří, se zjišťuje z NAČTENÝCH VEKTOROVÝCH DLAŽDIC
// (querySourceFeatures nad zdrojovými vrstvami stylu) — jednou na buňku,
// výsledek se keší. Dřívější dotaz na vykreslený obraz
// (queryRenderedFeatures) se zapnutým terénem sahal do GPU a byl NEJTĚŽŠÍ
// položkou profilu; viz sekci „PLOCHY Z NAČTENÝCH DLAŽDIC" níž. Ikony se
// pečou na canvasu v sezónní paletě (SEZONY v main.js); dodané malby
// uživatele je nahradí 1:1.
'use strict';

const Dekorace = (() => {
  let mapa = null;
  let hooky = false;
  let posledniPass = 0;
  // klíč "druh:iy:ix" → Feature nebo null (mimo plochu); keš je
  // deterministická, takže nikdy nevzniknou dvě verze téhož bodu
  const bunky = new Map();
  let pocetFeatur = 0;
  let ikonyHotove = false;        // dopln čeká, než se malby zapíšou
  const bitmapy = new Map();      // jméno → ImageBitmap (přežívá styly)

  // 8. 8.: stromy/kytky/keře/kameny = MALBY OD UŽIVATELE („Tady máš
  // dekorace"), řezané po sezónách přes pipeline/32_dekorace.py
  // (základ 44 CSS px, 88 px @2). Ladění dle výtek 8. 8. večer:
  // ① čistá konstanta na obrazovce působila, že se motivy PROTI
  // rostoucí krajině zmenšují („stále se zmenšují zoomováním") →
  // rostou zhruba s krajinou a u ×2,0 se zastaví (žádné „gigantické"
  // z divokého ×8); ② „počet ještě zvyš" — rozestupy ↓, hustoty ↑.
  const DRUHY = {
    // 6. 8. 2026: „přidej více stromů, kamenů a květin" – rozestupy dolů,
    // hustoty nahoru (stromů ×1,7, květin ×1,8, kamenů ×2,2). Keře
    // zůstávají, o ty uživatel nežádal. Pozor při dalším zvyšování:
    // dekorace jsou body symbolové vrstvy, každý kus stojí kolizi.
    strom: {
      rozestup: 62,               // m mezi kandidáty (NEJJEMNĚJŠÍ, viz Z_JEMNE)
                                  // v1.419: 70→62 („hustší lesy“)
      zjemnit: true,
      vrstvy: ['les'],              // sady a zahrady mají vlastní druh `ovocny`
      // ⭐ 8. 8. 2026: „stromy ať se ukazují už od zoomu 54 %".
      // Ukazatel v appce je `(zoom − 6,5) / 12,5`, takže 54 % = **z13,25**
      // (dřív 14,4 ≈ 63 %). ⚠️ Víc stromů z dálky = víc symbolů a kolizí;
      // kdyby to bolelo, tohle je první číslo, které jde zpět nahoru.
      // 29. 8.: „dlouho trvalo, než se objevily stromy" → dřív
      z0: 12.8,
      // 10 stromů ze sezónních listů (dvě řady po pěti)
      ikony: ['deko-strom-1', 'deko-strom-2', 'deko-strom-3',
              'deko-strom-4', 'deko-strom-5', 'deko-strom-6',
              'deko-strom-7', 'deko-strom-8', 'deko-strom-9',
              'deko-strom-10'],
      k: 1.15,                    // 5. 9. večer: k = podíl výšky stromu (~25 m)
      hustota: 0.56,              // v1.425: „stromů uber o 20 %“ (0,70→0,56)
    },
    // ⭐ 5. 9. noc: OVOCNÉ STROMY v sadech a zahradách (ZABAGED v2) – menší
    // než lesní strom, hustě (zahrada u domu mívá pár stromů). Dřív byly
    // zahrady v „sadu" a nesly stromy lesní velikosti přes střechy.
    ovocny: {
      rozestup: 40,
      zjemnit: true,
      vrstvy: ['sad', 'zahrada'],
      z0: 15.4,                   // engine 202: 14,6 → 15,4 (kandidátů 40 m bylo moc)
      ikony: ['deko-strom-1', 'deko-strom-2', 'deko-strom-3',
              'deko-strom-4', 'deko-strom-5'],
      k: 0.55,                    // ~12 m
      hustota: 0.5,
    },
    // skalní útvary (ZABAGED v2): balvany hustě a větší
    skalka: {
      rozestup: 45,
      zjemnit: true,
      vrstvy: ['skaly'],
      z0: 15.0,                   // engine 202: 14,2 → 15,0
      ikony: ['deko-kamen-1', 'deko-kamen-2', 'deko-kamen-3'],
      k: 0.45,                    // ~10 m
      hustota: 0.7,
    },
    kvet: {
      rozestup: 100,
      zjemnit: true,
      // ⚠️ 6. 8. 2026 („nevidím obrázky květin a keřů"): `louka` je
      // v OMT jen `grass`/`wetland` – v české krajině vzácnost, takže
      // květiny skoro neměly kde vyrůst. Přidáno `pole` (farmland),
      // což je většina otevřené krajiny u nás.
      vrstvy: ['louka', 'pole'],
      z0: 15.4,                   // 5. 9. večer: kytka ~5 m (přání „kytky větší"), ≥ 5 px
      // 6 květin: pátá řada listu + luční směs ze čtvrté řady
      ikony: ['deko-kvet-1', 'deko-kvet-2', 'deko-kvet-3',
              'deko-kvet-4', 'deko-kvet-5', 'deko-kvet-6'],
      k: 0.25,                    // ~5 m (malba, ne měřítko)
      hustota: 0.62,
    },
    // ⭐ v1.423: rostliny od uživatele (archy jaro/léto/podzim,
    // zima = podzimní suché; řez 5×4, standardní kolotoč čištění)
    plodina: {
      sezony: ['jaro', 'leto', 'podzim'],   // v zimě nic (v1.424)
      rozestup: 85,
      zjemnit: true,
      vrstvy: ['pole'],
      z0: 15.2,                   // 5. 9. večer: plodina ~6 m
      // obilní pás (1–5) + kukuřice, slunečnice, řepka, len, pohanka
      ikony: ['deko-plodina-1', 'deko-plodina-2', 'deko-plodina-3',
              'deko-plodina-4', 'deko-plodina-5', 'deko-plodina-6',
              'deko-plodina-7', 'deko-plodina-8', 'deko-plodina-9',
              'deko-plodina-10'],
      k: 0.3,                     // ~6 m
      hustota: 0.5,
    },
    bylina: {
      sezony: ['jaro', 'leto', 'podzim'],   // v zimě nic (v1.424)
      rozestup: 95,
      zjemnit: true,
      vrstvy: ['louka'],
      z0: 15.4,                   // 5. 9. večer: bylina ~5 m
      // luční trávy (1–5), třtina, orobinec, jetel
      ikony: ['deko-bylina-1', 'deko-bylina-2', 'deko-bylina-3',
              'deko-bylina-4', 'deko-bylina-5', 'deko-bylina-6',
              'deko-bylina-7', 'deko-bylina-8'],
      k: 0.25,                    // ~5 m
      hustota: 0.5,
    },
    podrost: {
      sezony: ['jaro', 'leto', 'podzim'],   // v zimě nic (v1.424)
      rozestup: 120,
      zjemnit: true,
      vrstvy: ['les'],
      z0: 15.2,                   // 5. 9. večer: kopřiva ~6 m (čtvrtina stromu)
      // kopřiva a kapradí do podlesí
      ikony: ['deko-podrost-1', 'deko-podrost-2'],
      k: 0.3,                     // ~6 m
      hustota: 0.35,
    },
    ker: {
      // 29. 8.: „malinko uber keře na loukách" — řidší
      rozestup: 155,
      zjemnit: true,
      vrstvy: ['louka', 'les', 'pole'],
      z0: 14.8,                   // 5. 9. večer: keř ~9 m
      // ⚠️ Listy nesou jen DVA keře (borůvčí a kvetoucí keřík); dřívější
      // `ker-3`/`ker-4` byly z pečených ikon a v malbách nejsou.
      ikony: ['deko-ker-1', 'deko-ker-2'],
      k: 0.4,                     // ~9 m
      hustota: 0.33,              // 29. 8.: −20 % (louky)
    },
    kamen: {
      rozestup: 170,
      zjemnit: true,
      vrstvy: ['louka', 'les'],
      z0: 15.4,                   // 5. 9. večer: balvan ~5 m („kameny větší")
      ikony: ['deko-kamen-1', 'deko-kamen-2', 'deko-kamen-3'],
      k: 0.25,                    // ~5 m
      hustota: 0.42,
    },
    // ⭐ SVĚTLA SÍDEL (v1.384–385, „ať města a vesničky v noci
    // světélkují — záře z oken, lampy… kulatá, každé jinak mihotá").
    // Prvky nesou `sv:1` + číselné `id` (feature-state pro mihotání)
    // a kreslí je VLASTNÍ vrstva `dekorace-svetla` — KULATÉ pečené
    // radiální záře ve třech teplých odstínech (hash vybírá ikonu).
    // Ve dne je vrstva schovaná — rozsvěcí ji `aplikujNoc()` v main.js.
    svetlo: {
      rozestup: 60,               // hustě — vesnice má pár desítek oken
      zjemnit: true,
      vrstvy: ['zastavba'],
      z0: 13.2,
      ikony: ['svetlo-zare-0', 'svetlo-zare-1', 'svetlo-zare-2'],
      k: 0.5,
      hustota: 0.55,
    },
    // ⭐ SVĚTLUŠKY (v1.385): drobná zelenkavá světýlka v lese, jen letní
    // noci (gate v aplikujNoc: měsíce 6–8, test __vynutLeto). Mihotají
    // rychleji a víc zhasínají — řídí týž animátor podle `sv:2`.
    // seedy pro DYNAMICKÝ roj (v1.386): mřížka dává jen KOTVY otestované
    // na polygon (lesy, louky i pole — přání); pohyb a mihotání dělá
    // `rojSvetlusek` níž na vlastním malém zdroji.
    svetluska: {
      rozestup: 120,
      zjemnit: true,
      vrstvy: ['les', 'louka', 'pole'],
      z0: 13.2,
      ikony: ['svetluska-zare'],
      k: 0.3,
      hustota: 0.35,
    },
    // ⭐ SNĚHULÁK (v1.593, „v zimě sem tam stojí sněhulák"): jen
    // v zimě a řídce — na loukách a polích, kde by ho děti postavily.
    // Kresba se PEČE ŠTĚTCEM V KÓDU (snehulakSprite) — zimní list
    // maleb ho nemá, fetch 404 tiše projde a obrázek už v atlasu je.
    snehulak: {
      rozestup: 600,
      zjemnit: true,
      vrstvy: ['louka', 'pole'],
      z0: 15.2,                   // 5. 9. večer: sněhulák ~6 m
      ikony: ['deko-snehulak'],
      k: 0.3,
      hustota: 0.2,
      sezony: ['zima'],
    },
    // ⛔ POLÍČKA A RYBNÍKY VYPNUTY (přání uživatele 9. 8. 2026:
    // „obrázky jezírek a polí dej pryč, nech pouze stromy, kameny, keře
    // a květiny"). Kresby zůstávají v `assets/dekorace/` i v řezačce —
    // vrátit je znamená jen odkomentovat blok níž.
    //
    // ⚠️ Tím se z atlasu ztratí i jejich obrázky (registrují se podle
    // `ikony` v `DRUHY`), takže to zároveň o něco zmenší atlas —
    // 4 kresby ze 25, tedy ~0,11 M z 0,69 M pixelů skupiny dekorací.
    //
    // // ⭐ NOVÉ Z DODANÝCH LISTŮ (8. 8. 2026): řádky plodin a rybníčky.
    // // Uživatel: „minule jsi psal, že obrázky rybníků atd. nemáš, tak
    // // znovu přidávám sadu."
    // pole: {
    // rozestup: 300,
    // vrstvy: ['pole'],           // farmland — tam řádky plodin patří
    // z0: 14.8,
    // ikony: ['deko-pole-1', 'deko-pole-2'],
    // k: 0.85,                    // políčko je široké, ať je poznat
    // hustota: 0.34,
    // },
    // rybnik: {
    // // ⭐⭐ RYBNÍK PATŘÍ NA VODU (opraveno 8. 8. 2026 večer).
    // // ⛔ Dřív tu bylo `vrstvy: ['louka']` s odůvodněním „je to rybníček
    // // V KRAJINĚ, ne výplň jezera". Byla to chyba ve dvou směrech:
    // //  ① kreslili jsme rybník tam, kde žádný není — na mapě, podle které
    // //     lidi chodí, je to nepravda;
    // //  ② mřížka NEZNÁ koleje, silnice ani domy, takže náhodný bod v louce
    // //     může padnout kamkoli. Uživatel to našel: *„u Velvět je rybník
    // //     napůl na kolejích."* Je to přesně ta vada, kvůli které se 8. 8.
    // //     vypnuly střechy („lezou do řek a přes silnice") — u rybníků
    // //     zůstala.
    // // Na vodní ploše tenhle problém z principu nevzniká a kresba sedí.
    // // ⚠️ `voda` je zároveň ve `SVEDCI`; tím, že je teď i nosná, se jí
    // // NAVÍC převádí geometrie (dřív stačilo jméno dlaždice). Kešuje se
    // // po dlaždicích jako u ostatních, ale kdyby to někdy bolelo, tady
    // // je ta změna.
    // // ⚠️ ROZESTUP MUSÍ BÝT MENŠÍ NEŽ SÁM RYBNÍK, jinak se do něj mřížka
    // // netrefí a druh je fakticky vypnutý. Změřeno na telefonu: vodní
    // // plochy kolem Velvět mají ~72 m, takže mřížka po 150 m dala NULA
    // // rybníků (a to bych „opravil" tak, že bych je potichu zrušil).
    // // ⚠️ A ZÁROVEŇ NE PŘÍLIŠ JEMNÝ. Měřeno na telefonu u rybníka nad
    // // Rtyní: 55 m + hustota 0,55 dalo **6 kreseb v jednom výřezu** —
    // // všechny sice na vodě, ale přes sebe. 75 m + 0,35 je jedna kresba
    // // na ~16 000 m² vodní plochy, tedy zhruba dvě v obraze.
    // // Počet zůstane nízký sám od sebe — vody je v krajině zlomek.
    // rozestup: 75,
    // zjemnit: true,              // v dálce po 150 m (viz Z_JEMNE)
    // vrstvy: ['voda'],
    // z0: 15.0,
    // naVode: true,               // jediný druh, který na vodu PATŘÍ
    // ikony: ['deko-rybnik-1', 'deko-rybnik-2'],
    // // menší než dřív (1,05): kresba nemá přerůstat vlastní rybník
    // k: 0.8,
    // hustota: 0.35,
    // },
    // STŘECHY VYPNUTY (8. 8., „střechy schovej, lezou do řek a přes
    // silnice") — mřížka nezná ulice, pečené střechy padaly kamkoli
    // do plochy zástavby. Vrátí se, až bude umístění podle skutečných
    // budov (OSM building) nebo malované střechy od uživatele.
  };

  // Zimní list nemá květiny (řada prázdná) — chybějící jména dostanou
  // ALIAS na náhradu, aby feature s libovolným 'ik' vždy kreslila:
  // suché bodláky a šípkový keř zimní louce sluší.
  // ⚠️ Zimní list má prázdné tři buňky po květinách (řezačka je hlásí:
  // „zima: 22 kreseb, prázdné: kvet-1, kvet-2, kvet-3"). Náhradou jsou
  // suché bodláky a keřík, které zimní louce sluší.
  const NAHRADY = {
    'kvet-1': 'kvet-5', 'kvet-2': 'kvet-6',
    'kvet-3': 'kvet-5', 'kvet-4': 'kvet-6',
  };

  // ⭐ NÁSTUPOVÁ RAMPA (9. 8. 2026). Zoomy, na kterých se odečítá opacita.
  // `["zoom"]` smí být jen vstupem vrchního `interpolate`, takže se rampa
  // nedá spočítat výrazem — předpočítá se do těchhle čtyř bodů a každý
  // druh si v nich nese svůj náběh podle vlastního prahu `z0`.
  // ⚠️ BODY MUSÍ BÝT HUSTĚJI, NEŽ JE ŠÍŘKA NÁSTUPU — jinak se náběh
  // rozmaže lineární interpolací mezi vzdálenými body a trvá dvakrát
  // dýl, než má (na tom jsem se chytil při vlastní kontrole 9. 8.).
  // ⭐ ZAHUŠTĚNÍ V PŘIBLÍŽENÍ (8. 8. 2026, „mapa mi připadá prázdná").
  // Rozestupy jsou v METRECH, takže v přiblížení se do obrazovky vejde
  // málo krajiny a s ní i málo dekorací. Změřeno na telefonu po opravě
  // projekce: na z13,3 bylo v obraze 67 kreseb, na z15,6 jen 5–8.
  // Druhy s `zjemnit` proto nesou rovnou POLOVIČNÍ rozestup a v dálce se
  // z jejich mřížky bere jen každá druhá buňka v obou osách (= původní
  // hustota). ⚠️ PROČ TAKHLE, A NE DVĚ RŮZNÉ MŘÍŽKY: hrubá sada je
  // PODMNOŽINOU jemné, takže se při zoomu jen doplní nové kusy mezi
  // stávající — žádný nepřeskočí ani se nepřestěhuje. Přesně to bylo
  // 7. 8. na dlaždicovém vzoru („stromy pořád poskakují") a nesmí se to
  // vrátit. Jitter i výběr ikony visí na (ix, iy) JEMNÉ mřížky, takže
  // sudé buňky vypadají v obou režimech stejně.
  const Z_JEMNE = 15.2;
  const RAMPA = [13.2, 13.55, 13.9, 14.25, 14.6, 14.95, 15.3, 15.65];
  // Jak široký (v zoomu) je náběh z nuly do plné viditelnosti. 0,35 je
  // zhruba půl štípnutí — „rychleji", jak si uživatel přál.
  const SIRKA_NASTUPU = 0.35;

  /// Předpočítané opacity pro `RAMPA` podle prahu druhu.
  function nastup(z0) {
    const o = {};
    RAMPA.forEach((z, i) => {
      o['o' + (i + 1)] = Math.max(0, Math.min(1, (z - z0) / SIRKA_NASTUPU));
    });
    return o;
  }

  // deterministický hash mřížky → [0,1)
  function hash(ix, iy, sul) {
    let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263)
      + Math.imul(sul, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // -------------------------------------------------------------------------
  // Ikony: malby od uživatele (sezónní listy)
  // -------------------------------------------------------------------------
  // Malby dle sezóny (assets/dekorace/<sezona>/*.webp). Bitmapy se drží
  // v modulu — výměna stylu maže atlas, ale znovu se jen registrují.
  // Chybějící soubor (zimní květiny) dostane alias dle NAHRADY.
  async function nactiMalby() {
    const sezona = sezonaMalby();
    const jmena = [];
    for (const cfg of Object.values(DRUHY)) {
      // v1.424: mimosezónní druhy (zimní pole) nemají soubory — nefetchovat
      if (cfg.sezony && !cfg.sezony.includes(sezona)) continue;
      for (const ik of cfg.ikony) {
        const j = ik.slice(5);           // bez „deko-"
        if (!jmena.includes(j)) jmena.push(j);
      }
    }
    await Promise.all(jmena.map(async (j) => {
      if (bitmapy.has(sezona + '/' + j)) return;
      try {
        const odp = await fetch('assets/dekorace/' + sezona + '/' + j
                                + '.webp');
        if (!odp.ok) throw new Error(String(odp.status));
        bitmapy.set(sezona + '/' + j,
                    await createImageBitmap(await odp.blob()));
      } catch (e) { /* chybějící buňka listu — vyřeší náhrada níž */ }
    }));
    if (!mapa) return;
    for (const j of jmena) {
      const bmp = bitmapy.get(sezona + '/' + j)
        || bitmapy.get(sezona + '/' + (NAHRADY[j] || ''))
        || bitmapy.get(sezona + '/' + j.replace(/-\d+$/, '-1'));
      if (bmp && !mapa.hasImage('deko-' + j)) {
        // ⭐ v1.412: PRŮHLEDNÝ OKRAJ 4 px kolem každé kresby („kameny
        // mají na obrázku fragmenty z jiných obrázků“) — v atlasu
        // textur leží sprity těsně vedle sebe a při zmenšení
        // (icon-size ~0,3) lineární vzorkování sahá do sousedů.
        mapa.addImage('deko-' + j, sOkrajem(bmp), { pixelRatio: 2 });
      }
    }
    ikonyHotove = true;
  }

  /// Podloží bitmapu na plátno s průhledným okrajem 4 px — ochrana
  /// proti prosakování sousedů z atlasu textur při zmenšení (v1.412).
  function sOkrajem(bmp) {
    const O = 4;
    const c = document.createElement('canvas');
    c.width = bmp.width + O * 2;
    c.height = bmp.height + O * 2;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, O, O);
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  // -------------------------------------------------------------------------
  // Vrstva a doplňování bodů
  // -------------------------------------------------------------------------
  /// Zdroj se zakládá LÍNĚ až s prvními daty (7. 8.): zdroj založený
  /// prázdný během style.load zůstal STERILNÍ — setData pak plnil data
  /// i querySourceFeatures, ale dlaždice se nikdy nevykreslily (ověřeno
  /// pokusně; zdroj založený rovnou s daty kreslí okamžitě).
  /// ⭐ engine 213: STÍN STROMU NA ZEMI – měkká elipsa (128×64 @2) zarovnaná
  /// s mapou pod stromem, posunutá od slunce (`nastavStin`). Vertikální
  /// billboard + ležící stín = hloubka („podpoř 3D efekt").
  function stinSprite() {
    const w = 128, h = 64;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(1, 0.5);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, w / 2);
    g.addColorStop(0, 'rgba(24,16,8,0.9)');
    g.addColorStop(0.55, 'rgba(24,16,8,0.55)');
    g.addColorStop(1, 'rgba(24,16,8,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, w / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return ctx.getImageData(0, 0, w, h);
  }

  /// Směr a síla stínů stromů podle světla (volá svetlo.js): az = azimut
  /// zdroje od severu, el = výška; stín míří od zdroje, délka roste s nízkým
  /// sluncem (12 CSS px × 1/tan(el), 0,4–2×), za tmy stín mizí.
  function nastavStin(az, el, zdroj) {
    if (!mapa || !mapa.getLayer('akvarel-dekorace-stin')) return;
    try {
      const d = ((az || 0) + 180) * Math.PI / 180;
      const delka = 12 * Math.max(0.4, Math.min(2.0,
        1 / Math.tan(Math.max(8, el || 8) * Math.PI / 180)));
      mapa.setLayoutProperty('akvarel-dekorace-stin', 'icon-offset',
          [+(Math.sin(d) * delka).toFixed(1), +(-Math.cos(d) * delka).toFixed(1)]);
      const sila = zdroj === 'slunce' ? 0.32 : (zdroj === 'mesic' ? 0.18 : 0);
      mapa.setPaintProperty('akvarel-dekorace-stin', 'icon-opacity',
          ['interpolate', ['linear'], ['zoom']].concat(
            RAMPA.flatMap((z, i) => [z, ['*', ['get', 'o' + (i + 1)], sila]])));
    } catch (e) { /* styl se zrovna mění */ }
  }

  function pridejVrstvu(data) {
    if (!mapa || mapa.getSource('dekorace')) return;
    // buffer 0: s allow-overlap netřeba přesah — levnější přeskládání
    mapa.addSource('dekorace',
        { type: 'geojson', data, buffer: 0, maxzoom: 14 });
    try { if (!mapa.hasImage('deko-stin')) mapa.addImage('deko-stin', stinSprite(), { pixelRatio: 2 }); }
    catch (e) { /* obrázek už je */ }
    // POD MLHU: dekorace patří do barevného světa a odkrývají se
    // objevováním — nad šedou rytinou zelené stromky svítily (chyba
    // z prvního nasazení). Zdroj vzniká LÍNĚ až po mlze, takže kotvit
    // „před první ink-*" nestačí: mlha (mlha-rytina) u téže kotvy už
    // sedí a pozdější vklad by skončil NAD ní. Kotva = přímo vrstva
    // mlhy, ink-* jen jako záloha, než mlha existuje.
    // ⚠️ id NESMÍ začínat „ink-" — kotvu mlhy hledá prefixem.
    //
    //
    // ⚠️ id NESMÍ začínat „ink-" — kotvu mlhy hledá prefixem.
    //
    // ⛔ NEPŘESOUVAT NAD MLHU KVŮLI VÝKONU (zkoušeno 7. 8. 2026 a VRÁCENO).
    // Tahle symbolová vrstva rozřezává drapovaný blok na dva „stacky",
    // ale nahoru patřit nemůže: musí zůstat POD rytinou mlhy, jinak
    // v neobjevené krajině svítí malované stromky přes šedou rytinu.
    // Pokus vynechat dekorace v zamlžených buňkách (a vrstvu tím pustit
    // nahoru) SHODIL ENGINE – mapa zůstala černá. Než to někdo zkusí
    // znovu: nejdřív ověřit, že `Mlha` v `dopln()` vůbec existuje a že
    // se `dopln` nevolá dřív než mlha, a měřit až po snímku obrazovky.
    // ⭐ NAD MLHU (7. 8. 2026). Šlo to až poté, co se dekorace přestaly
    // generovat v neobjevené krajině (viz `dopln`). Kotvíme na PRVNÍ
    // nedrapovanou vrstvu, tedy hned za konec drapovaného bloku – tím
    // vrstva blok nerozřízne a zbyde jediný „stack".
    const vrstvy = mapa.getStyle().layers;
    const drapuje = { background: 1, fill: 1, line: 1, raster: 1,
                      hillshade: 1, 'color-relief': 1 };
    let kotva = null;
    for (var vi = 0; vi < vrstvy.length; vi++) {
      if (!drapuje[vrstvy[vi].type]) { kotva = vrstvy[vi]; break; }
    }
    if (!kotva) {
      kotva = vrstvy.find((v) => v.id === 'mlha-rytina')
        || vrstvy.find((v) => v.id.startsWith('ink-'));
    }
    // engine 213: stín pod stromem (stromy, keře, aleje: k ≥ 0,4) – vloží se
    // PŘED vrstvu stromů, tedy pod ni; šířka elipsy ≈ šířka stromu (64 CSS px
    // základ proti 94 px stromu → ×1,47)
    mapa.addLayer({
      id: 'akvarel-dekorace-stin', type: 'symbol', source: 'dekorace',
      minzoom: 14.5,
      filter: ['all', ['!', ['has', 'sv']], ['>=', ['coalesce', ['get', 'k'], 0], 0.4]],
      layout: {
        'icon-image': 'deko-stin',
        'icon-anchor': 'center',
        'icon-pitch-alignment': 'map',
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-offset': [0, 0],
        'icon-size': ['interpolate', ['exponential', 2], ['zoom'],
          13.25, ['*', ['get', 'k'], ['coalesce', ['get', 'ev'], 1], 0.0676],
          22, ['*', ['get', 'k'], ['coalesce', ['get', 'ev'], 1], 28.9]],
      },
      paint: {
        'icon-opacity': ['interpolate', ['linear'], ['zoom']].concat(
          RAMPA.flatMap((z, i) => [z, ['*', ['get', 'o' + (i + 1)], 0.3]])),
      },
    }, kotva ? kotva.id : undefined);
    mapa.addLayer({
      id: 'akvarel-dekorace', type: 'symbol', source: 'dekorace',
      // stromy nastupují od z13,25 (54 % ukazatele), vrstva musí být dřív
      minzoom: 13.2,
      // světla sídel (sv) kreslí vlastní vrstva `dekorace-svetla` níž
      filter: ['!', ['has', 'sv']],
      layout: {
        'icon-image': ['get', 'ik'],
        'icon-anchor': 'bottom',
        // ⭐ engine 210 („stromy / rostliny levitují nad povrchem při
        // přiblížení"): billboard stojí patou na kotvě; ve svahu a při
        // náklonu je terén pod jedním okrajem paty níž, takže část paty
        // (i zapečený stín) visí nad zemí. Pata se proto lehce zapouští
        // do terénu (8 px obrázku @2 = 4 CSS px × velikost); ve svahu ji
        // terén překryje, na rovině zmizí jen spodek stínu.
        'icon-offset': [0, 8],
        'icon-rotate': ['get', 'rot'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        // ⭐⭐ VELIKOST UKOTVENÁ V KRAJINĚ, NE NA OBRAZOVCE (9. 8. 2026).
        // Uživatel: *„ať se drží perspektiva. Nejdřív malinké z dálky
        // a pak se přibližují zvětšují stejně s mapou."*
        //
        // ⛔ Dřív tu byla KONSTANTA (`['get','k']`) — pevná velikost na
        // obrazovce. To vzniklo na starší výtku „zafixuj", jenže má to
        // vadu: při náklonu do velikosti pořád mluví perspektiva podle
        // vzdálenosti symbolu, a ta se přepočítává až s rozmístěním
        // popisků, ne každý snímek. Odtud *„poskakuje jejich velikost při
        // posouvání po mapě, jak kamera kopíruje terén"*.
        //
        // `exponential(2)` s krajními body v poměru 2 na jeden zoom je
        // PŘESNĚ ukotvení v krajině: strom má pořád tutéž velikost
        // v metrech, takže roste spolu s mapou a vyhodnocuje se na GPU
        // každý snímek (tedy plynule, žádné skoky).
        //   13,0 → 0,7 × k × 2^(13−15,4) = 0,133 × k   (malinké z dálky)
        //   15,4 → 0,7 × k                              (cílová velikost)
        //
        // ⚠️ NAD 15,4 UŽ NEROSTOU. Kdyby růst pokračoval, byly by na
        // z16,4 o 40 % VĚTŠÍ než dnešní konstanta — přesný opak zadání
        // „udělej je menší tak o 30 %". Takhle je splněné obojí: roste to
        // s krajinou, dokud se nedojde k cílové (o 30 % zmenšené)
        // velikosti, a tam se to zastaví.
        // ⚠️ INTERPOLACE MUSÍ BÝT NEJVÝŠ, `k` patří DO HODNOT. Napsat
        // `['*', ['get','k'], ['interpolate', …]]` je chyba, kterou
        // MapLibre odmítne celou vrstvu: „zoom expression may only be
        // used as input to a top-level step or interpolate expression" —
        // a dekorace pak nejsou vůbec (naběhl jsem si na to 9. 8., i když
        // jsem si totéž omezení o pár řádků níž sám poznamenal u opacity).
        // ⚠️ PŘESNÉ UKOTVENÍ V KRAJINĚ JE NEPOUŽITELNÉ (ověřeno 9. 8.).
        // `exponential(2)` z 15,4 dolů dá na z13,25 jen 0,133 × k, tedy
        // ~10 px — strom je tam fakticky neviditelný. „Od 54 % ať jsou
        // vidět" a „ať rostou stejně s mapou" se v tom rozsahu vylučují,
        // protože jde o 5,3násobek. Zvolena viditelnost: dole mírnější
        // růst, nahoře skoro plné ukotvení v krajině.
        //
        // ⭐⭐ STROP NA 15,4 BYLA CHYBA (8. 8. 2026 večer, „obrázky se
        // stále zmenšují nepřiměřeně zoomu"). Nad 15,4 držely kresby
        // PEVNÝ POČET PIXELŮ, zatímco krajina pod nimi dál rostla — oko
        // to čte přesně jako zmenšování. A protože mapa startuje na 15,6,
        // byl uživatel v tom useknutém pásmu prakticky pořád.
        // Nově roste dál až do 17,6 s podílem 1,8× na zoom (mapa má 2×,
        // takže to je „skoro stejně s mapou"):
        //   13,25 → 0,30 × k   (~24 px u stromu — malé, ale poznat)
        //   15,40 → 0,70 × k   (~55 px)
        //   16,40 → 1,26 × k   (~100 px)
        //   17,60 → 2,55 × k   (~202 px, tj. 56 % šířky obrazovky)
        // ⭐ 5. 9. 2026 večer: NAD 17,6 ROSTE DÁL S MAPOU (×2 na zoom, stop
        // na z22 = 2,55 × 2^4,4 = 53,8 × k). Výtka: „rostliny se nesmyslně
        // přestanou přibližovat" – strom stál, zatímco řeka (plocha) rostla.
        // Strom je pak na z20 stejných ~20 m jako na z17,6, jen blíž.
        // ⛔ v1.397: PLOŠINA 15,1–16,3 VRÁCENA (zkoušena ve v1.396 proti
        // „poskočení velikosti u 73–74 %“) — uživatel: „nyní jsou ještě
        // horší než předtím, skáče jim stále velikost“. Teorie „posun
        // čísla zoomu při převzetí výšky“ skok NEVYSVĚTLILA; křivka je
        // zpět původní a příčina se musí hledat jinde (kandidáti:
        // přepočet composite icon-size při výměně bucketu dlaždice,
        // nástupová rampa jemné kohorty končící na 15,65).
        // ⭐⭐ 5. 9. 2026 večer, 4. kolo („vše má růst jako řeka, jako
        // malba; vše ostatní poskakuje po krocích"): MapLibre peče
        // velikost symbolu po DLAŽDICÍCH mezi dvěma krycími stopy výrazu
        // (symbol_size.ts getSizeData) – s více stopy měla každá dlaždice
        // jinou křivku a na hraně zmrzla, než dojela nová (= poskakování).
        // Proto PRÁVĚ DVA STOPY se základem 2: strom `k` = 1 je ~22 m
        // (základ obrázku je 94 CSS px = 188 px @2, ⛔ ne 44: první odhad
        // 0,08 dělal stromy 38 m), roste a klesá přesně s krajinou.
        // `ev` = výškový faktor terénu (vyskovyFaktor): co je výš, je blíž
        // k oku, tak o kus větší (přání 5. 9. večer)
        'icon-size': ['interpolate', ['exponential', 2], ['zoom'],
          13.25, ['*', ['get', 'k'], ['coalesce', ['get', 'ev'], 1], 0.046],
          22, ['*', ['get', 'k'], ['coalesce', ['get', 'ev'], 1], 19.7]],
      },
      paint: {
        // rychlý a pro všechny druhy stejně dlouhý nástup — hodnoty
        // předpočítal `nastup(z0)` podle prahu druhu (viz `RAMPA`)
        'icon-opacity': ['interpolate', ['linear'], ['zoom']].concat(
          RAMPA.flatMap((z, i) => [z, ['get', 'o' + (i + 1)]])),
      },
    }, kotva ? kotva.id : undefined);
    // ⭐ v1.425: NOČNÍ ZTLUMENÍ DEKORACÍ („bijí do očí“) — rampu
    // rození nesmíme přepsat konstantou, násobí se celý výraz.
    // Volá aplikujNoc() při změně kroku; tady se aplikuje stav
    // uložený z posledního volání (vrstva mohla vzniknout až po něm).
    window.__ztlumDekorace = (faktor) => {
      try {
        if (!mapa || !mapa.getLayer('akvarel-dekorace')) return;
        // ⚠️ faktor do VLASTNÍHO globálu — funkce se při každé
        // přestavbě vrstvy definuje znovu a vlastnost by zanikla
        window.__nocniFaktorDekorace = faktor;
        // ⛔ násobek MUSÍ dovnitř na výstupy: zoomový interpolate
        // musí u kompozitních vlastností zůstat KOŘENEM výrazu —
        // ['*', interpolate, f] projde bez výjimky, ale validace ho
        // TIŠE ZAHODÍ (chyceno 13. 8.: globál nastavený, výraz ne)
        const rampa = ['interpolate', ['linear'], ['zoom']].concat(
          RAMPA.flatMap((z, i) => [z, faktor >= 1
            ? ['get', 'o' + (i + 1)]
            : ['*', ['get', 'o' + (i + 1)], faktor]]));
        mapa.setPaintProperty('akvarel-dekorace', 'icon-opacity', rampa);
      } catch (e) { /* styl se zrovna mění */ }
    };
    if (typeof window.__nocniFaktorDekorace === 'number'
        && window.__nocniFaktorDekorace < 1) {
      window.__ztlumDekorace(window.__nocniFaktorDekorace);
    }

    // ⭐ SVĚTLA SÍDEL + SVĚTLUŠKY (v1.385): KULATÉ pečené radiální záře
    // (přání „udělej je kulatá") — bílé jádro → teplý tón → průhledno.
    // Ve dne schované (visibility none = nulová cena), rozsvěcí
    // `aplikujNoc()`. Mihotání řídí feature-state `o` (animátor níž).
    const TONY_ZARE = {
      'svetlo-zare-0': [255, 209, 128],
      'svetlo-zare-1': [255, 183, 77],
      'svetlo-zare-2': [255, 224, 130],
      'svetluska-zare': [212, 255, 122],
    };
    for (const [jmeno, rgb] of Object.entries(TONY_ZARE)) {
      if (!mapa.hasImage(jmeno)) {
        try {
          mapa.addImage(jmeno, zareSprite(rgb), { pixelRatio: 2 });
        } catch (e) { console.warn('[deko] záře:', jmeno, e); }
      }
    }
    // sněhulák pečený v kódu (v1.593) — viz DRUHY.snehulak
    if (!mapa.hasImage('deko-snehulak')) {
      try {
        mapa.addImage('deko-snehulak', snehulakSprite(),
            { pixelRatio: 2 });
      } catch (e) { console.warn('[deko] snehulak:', e); }
    }
    const mihot = (zaklad) => ['*', zaklad,
        ['coalesce', ['feature-state', 'o'], 1]];
    mapa.addLayer({
      id: 'dekorace-svetla', type: 'symbol', source: 'dekorace',
      minzoom: 12.6,
      filter: ['==', ['get', 'sv'], 1],
      layout: {
        'icon-image': ['get', 'ik'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        visibility: 'none',
        'icon-size': ['interpolate', ['exponential', 1.6], ['zoom'],
                      12.6, 0.24, 15.4, 0.72, 17.6, 1.2],
      },
      paint: { 'icon-opacity': mihot(0.95) },
    }, kotva ? kotva.id : undefined);
    // ⛔⛔ v1.400: SVĚTLUŠKY ŽIJÍ MIMO MAPU — jako DOM markery.
    // Symboly: každé setData = nové rozmístění s prolínáním 300 ms,
    // překrývající se při tiku 133 ms → mapa nikdy neusnula (56/s).
    // Kruhy: setData jde přes worker a stále budí ~35 překreslení/s.
    // DOM markery se hýbou v kompozitoru a mapu NEBUDÍ VŮBEC —
    // noční vesnice spadla na cenu mihotání oken. Roj kreslí
    // `rojSvetlusek` přímo do markerů (viz níž), žádný zdroj.
    // po založení vrstev hned srovnat noční stav (jinak až tik za minutu)
    if (typeof aplikujNoc === 'function') setTimeout(aplikujNoc, 0);
  }

  /// Kulatá pečená záře 96 px: bílé jádro → tón → průhledno. Kreslí se
  /// jednou do ImageData; v atlasu jsou 4 kusy (3 okna + světluška).
  function zareSprite(rgb) {
    const s = 96;
    const p = document.createElement('canvas');
    p.width = s; p.height = s;
    const ctx = p.getContext('2d');
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    const [r, gr, b] = rgb;
    // ⭐ v1.399: KALUŽ SVĚTLA místo neprůsvitné koule („ať je opravdu
    // osvětlená mapa“) — jen malé jasné jádro (zdroj světla), zbytek
    // je PRŮSVITNÝ teplý tón, skrz který zůstává mapa čitelná.
    // Opravdové odkrytí tmy dělají díry v noc-prekryv (main.js).
    g.addColorStop(0, 'rgba(255,250,235,0.9)');
    g.addColorStop(0.09, 'rgba(' + r + ',' + gr + ',' + b + ',0.55)');
    g.addColorStop(0.38, 'rgba(' + r + ',' + gr + ',' + b + ',0.32)');
    g.addColorStop(0.72, 'rgba(' + r + ',' + gr + ',' + b + ',0.13)');
    g.addColorStop(1, 'rgba(' + r + ',' + gr + ',' + b + ',0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    return ctx.getImageData(0, 0, s, s);
  }

  /// ⭐ Sněhulák pečený štětcem (v1.593): tři koule se studeným
  /// stínem, uhlíky, mrkev, klacíkové ruce, hrnec a šála. Kreslí se
  /// jednou; do atlasu jde jako `deko-snehulak` (pixelRatio 2).
  function snehulakSprite() {
    const W = 72;
    const H = 96;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    const koule = (cx, cy, r) => {
      const g = x.createRadialGradient(cx - r * 0.35, cy - r * 0.4,
          r * 0.2, cx, cy, r);
      g.addColorStop(0, '#FFFFFF');
      g.addColorStop(0.7, '#F2F6FA');
      g.addColorStop(1, '#CBD9E6');
      x.fillStyle = g;
      x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
      x.strokeStyle = 'rgba(120,145,170,0.45)';
      x.lineWidth = 1.2;
      x.stroke();
    };
    // stín na sněhu
    x.fillStyle = 'rgba(90,110,140,0.20)';
    x.beginPath();
    x.ellipse(36, 90, 24, 5, 0, 0, Math.PI * 2);
    x.fill();
    // klacíkové ruce (kreslí se PŘED koulemi, ať rostou za tělem) —
    // vycházejí z BOKŮ prostřední koule mírně vzhůru (výtka 1. 9.
    // „ruce malinko jinde")
    x.strokeStyle = '#6B4A26'; x.lineWidth = 2.2; x.lineCap = 'round';
    x.beginPath(); x.moveTo(22, 44); x.lineTo(5, 33);
    x.moveTo(11, 37); x.lineTo(7, 41); x.stroke();
    x.beginPath(); x.moveTo(50, 44); x.lineTo(67, 34);
    x.moveTo(61, 38); x.lineTo(66, 42); x.stroke();
    koule(36, 70, 22);      // spodní
    koule(36, 44, 16);      // prostřední
    koule(36, 22, 11.5);    // hlava
    // hrnec
    x.fillStyle = '#3E4A55';
    x.beginPath();
    x.moveTo(27, 13); x.lineTo(45, 13); x.lineTo(43, 3);
    x.lineTo(29, 3); x.closePath(); x.fill();
    x.fillRect(24, 12, 24, 3);
    // šála
    x.strokeStyle = '#C43B2E'; x.lineWidth = 4.4;
    x.beginPath();
    x.arc(36, 31, 9.5, Math.PI * 0.15, Math.PI * 0.85);
    x.stroke();
    x.lineWidth = 3.6;
    x.beginPath(); x.moveTo(42, 36); x.lineTo(45, 46); x.stroke();
    // oči a knoflíky
    x.fillStyle = '#26221E';
    const uhliky = [[32, 19, 1.3], [40, 19, 1.3], [36, 42, 1.5],
                    [36, 48, 1.5], [36, 64, 1.7], [36, 71, 1.7]];
    for (let i = 0; i < uhliky.length; i++) {
      x.beginPath();
      x.arc(uhliky[i][0], uhliky[i][1], uhliky[i][2], 0, Math.PI * 2);
      x.fill();
    }
    // mrkev (z profilu doprava)
    x.fillStyle = '#E07B2A';
    x.beginPath(); x.moveTo(36, 22.3); x.lineTo(46.5, 24.6);
    x.lineTo(36, 25.4); x.closePath(); x.fill();
    // úsměv z kamínků
    x.fillStyle = '#4A4038';
    const kaminky = [[32.2, 27.4], [34.6, 28.5], [37.4, 28.5],
                     [39.8, 27.4]];
    for (let i = 0; i < kaminky.length; i++) {
      x.beginPath();
      x.arc(kaminky[i][0], kaminky[i][1], 0.75, 0, Math.PI * 2);
      x.fill();
    }
    return x.getImageData(0, 0, W, H);
  }

  // -------------------------------------------------------------------------
  // ⭐ ANIMÁTOR MIHOTÁNÍ (v1.385): „každé jinak, pozvolna; zhasínat
  // a rozsvěcet se jinde; světlušky přes léto". Každých 400 ms se pár
  // náhodných světel rozejde k novému cíli jasu (feature-state `o` —
  // jen paint, žádné přeskládání symbolů). Okna: občas zhasnout (15 %),
  // jinak jemné zakolísání; světlušky: rychlejší a hlubší (35 % zhasnutí).
  // Zhasnuté kusy si příště vylosují nový cíl → „rozsvítí se jinde".
  // Běží jen v noci (vlajky z aplikujNoc) a při viditelné stránce.
  // -------------------------------------------------------------------------
  let svetlaEvidence = [];           // features s sv (plní `dopln`)
  const svetlaCile = new Map();      // id → {ted, cil, krok}

  setInterval(() => {
    try {
      if (!mapa || !mapa.getSource('dekorace')) return;
      if (document.visibilityState !== 'visible') return;
      const okna = !!window.__svetlaAktivni;
      if (!okna) {
        if (svetlaCile.size) svetlaCile.clear();
        return;
      }
      // OKNA: jemné mihotání přes feature-state (jen paint)
      if (okna) {
        const kandidati = svetlaEvidence.filter(
            (f) => f.properties.sv === 1);
        if (kandidati.length) {
          const kolik = Math.max(1, Math.round(kandidati.length * 0.02));
          for (let i = 0; i < kolik; i++) {
            const f = kandidati[(Math.random() * kandidati.length) | 0];
            if (svetlaCile.has(f.id)) continue;
            const cil = Math.random() < 0.15
                ? 0.12 : 0.55 + Math.random() * 0.45;
            let ted = 1;
            try {
              const st = mapa.getFeatureState(
                  { source: 'dekorace', id: f.id });
              if (st && typeof st.o === 'number') ted = st.o;
            } catch (e) { /* stav ještě není */ }
            svetlaCile.set(f.id, { ted, cil, krok: 0.07 });
          }
        }
        for (const [id, s] of svetlaCile) {
          const d = s.cil - s.ted;
          if (Math.abs(d) <= s.krok) {
            s.ted = s.cil;
            svetlaCile.delete(id);
          } else {
            s.ted += Math.sign(d) * s.krok;
          }
          mapa.setFeatureState({ source: 'dekorace', id }, { o: s.ted });
        }
      }
    } catch (e) { /* zdroj se právě mění — příští tik */ }
  }, 400);

  // ⭐ v1.396: SVĚTLUŠKY VE VLASTNÍM RYCHLEJŠÍM TIKU (133 ms, „pohyb
  // udělej plynulejší“). Kroky jsou třetinové, takže rychlost letu
  // i tempo dechu zůstávají — jen po menších kouscích. setData na
  // ~40 bodech je zadarmo i při 7,5 Hz (velký zdroj se nesahá).
  setInterval(() => {
    try {
      if (!mapa) return;
      if (document.visibilityState !== 'visible') return;
      // v1.441: UKLID MUSI PREDBEHNOUT BRANU ZDROJE. Mimo hru zdroj
      // `dekorace` NEEXISTUJE, takze puvodni `return` na tomhle miste
      // uklid roje nikdy nespustil a musky zustaly viset na platne
      // ("po skoku z herniho a zpet jsou svetlusky videt, jen se
      // nehybou"). Brana z v1.436 zastavila jen POHYB, ne prvky.
      const hraStyl = typeof aktualniKod !== 'undefined'
          && typeof STYLY !== 'undefined'
          && STYLY[aktualniKod]
          // v1.592 roj i v Dobyvateli — ZRUŠENO v1.599 (přání 2. 9.
          // večer: „z Dobyvatele dej můry a netopýry pryč"): roj jen
          // v herním stylu s mlhou; v Dobyvateli v noci září vlajky
          && !!STYLY[aktualniKod].mlha;
      if (!hraStyl) { rojSvetlusek(null); return; }
      if (!mapa.getSource('dekorace')) return;
      // ⭐ v1.418: dvouréžimový roj — v noci světlušky, ve dne včely
      // a mouchy („přidej sem tam létající včely a mouchy během dne“)
      // ⭐ v1.436: HMYZ JEN VE HŘE („mouchy a světlušky vidím
      // i v neherním“) — vlajky z aplikujNoc přežívaly přepnutí
      // stylu (aplikujNoc mimo hru vůbec neběží a nikdo je nesmazal)
      // ⭐ v1.592 PODZIM: po světluškách nastupují můry a netopýři
      // (září–listopad v noci), ve dne babí léto a padající listí
      let rezim = null;
      if (window.__svetluskyAktivni) {
        rezim = 'noc';
      } else if (window.__muryAktivni) {
        rezim = 'podzimnoc';
      } else if (window.__hmyzDenniAktivni) {
        if (window.__vlockyAktivni) {
          rezim = 'zimaden';        // v zimě včely spí, poletuje sníh
        } else if (window.__babiLetoAktivni || window.__listiAktivni) {
          rezim = 'podzimden';
        } else {
          rezim = 'den';
        }
      }
      rojSvetlusek(rezim);
    } catch (e) { /* zdroj se právě mění — příští tik */ }
  }, 133);

  // -------------------------------------------------------------------------
  // ⭐ ROJ SVĚTLUŠEK (v1.386): „malé svítivé POHYBUJÍCÍ SE tečky, občas
  // zhasínají" v lesích, na loukách a polích. Kotvy dává mřížka (sv:2 =
  // otestované na polygon), kolem kotvy muška POLETUJE náhodnou
  // procházkou (~4 m/tik, gumička zpět od 30 m), pozvolna dýchá jas
  // a občas zhasne — pak se PŘERODÍ u jiné kotvy („rozsvítí se jinde").
  // Kreslí se z vlastního malého zdroje (~40 prvků, setData zadarmo).
  // -------------------------------------------------------------------------
  const MUSEK_MAX = 40;
  let musky = [];

  // DOM roj: bazének markerů se recykluje, prvek je pečený radiální
  // gradient (jádro + halo), velikost se řídí zoomem až v transformu.
  const HMYZ_VZHLED = {
    // noční světluška: měkká záře
    svetluska: 'width:44px;height:44px;border-radius:50%;'
      + 'margin:-22px 0 0 -22px;will-change:transform,opacity;'
      + 'background:radial-gradient(circle,'
      + 'rgba(242,255,200,0.95) 0%,rgba(212,255,122,0.5) 26%,'
      + 'rgba(212,255,122,0.16) 55%,rgba(212,255,122,0) 75%)',
    // včela = SVG: hlava, hruď, zlatý zadeček se třemi pruhy a křídla
    // jako pohybová skvrna; celý prvek se natáčí po směru letu.
    // ⚠️ 13 px — TŘETÍ KOLO LADĚNÍ, TEĎ UŽ SE SPRÁVNOU PŘÍČINOU.
      // 22. 8. byly při 18 px „moc velké“, po zmenšení na 13 px přišlo
      // „úplně zmizely“ — jenže to nebylo velikostí, nýbrž tím, že
      // létaly mimo výřez (viz `vyberKotvu`). Jakmile se rodí na
      // obrazovce, je 16 px zase moc; 13 px je čitelných a nevtíravých.
      // Kresba má pořád viewBox 18×18, mění se jen vykreslená velikost.
      vcela: 'width:13px;height:13px;'
      + 'margin:-6.5px 0 0 -6.5px;will-change:transform,opacity;',
    // moucha: drobná tmavá tečka
    moucha: 'width:4px;height:4px;border-radius:50%;'
      + 'margin:-2px 0 0 -2px;will-change:transform,opacity;'
      + 'background:radial-gradient(circle,'
      + '#3C3C38 0%,#1E1E1B 70%,rgba(18,18,16,0) 100%)',
    // ⭐ PODZIM (v1.592): můra u rozsvícených oken (září–listopad)
    mura: 'width:12px;height:12px;'
      + 'margin:-6px 0 0 -6px;will-change:transform,opacity;',
    // netopýr za šera — černá silueta s mávajícími křídly
    netopyr: 'width:20px;height:12px;'
      + 'margin:-6px 0 0 -10px;will-change:transform,opacity;',
    // babí léto — pavučinkové vlákno nesené větrem.
    // ⭐ v1.601.5 (výtka 3. 9. „kolem hmyzu se dělají světlé čárky"):
    // bílý proužek 30×2 px vypadal na denní mapě jako škrábanec. Teď je
    // to tenká (0,8 px) prohnutá nit v SVG s průhledným přechodem,
    // jemným tmavým stínem (ať je vidět i na světlém poli) a pomalým
    // třpytem (keyframes `vlaknoTrpyt` ve stylMihu).
    babileto: 'width:34px;height:8px;'
      + 'margin:-4px 0 0 -17px;will-change:transform,opacity;'
      + 'transform:rotate(-18deg);'
      + 'filter:drop-shadow(0 0 0.6px rgba(40,30,10,0.45));',
    // padající list — barvu a otáčení dostává při zrodu
    list: 'width:12px;height:12px;'
      + 'margin:-6px 0 0 -6px;will-change:transform,opacity;',
    // ⭐ ZIMA (v1.593): poletující vločka (prosinec–únor místo hmyzu)
    vlocka: 'width:10px;height:10px;'
      + 'margin:-5px 0 0 -5px;will-change:transform,opacity;',
  };

  // šesticípá vločka: modravý podklad pod bílou, ať je vidět
  // i na světlém zimním podkladu
  const VLOCKA_SVG = '<svg viewBox="0 0 10 10" width="10" '
    + 'height="10">'
    + '<g stroke="#9FC4E8" stroke-width="1.7" stroke-linecap="round" '
    + 'opacity="0.55">'
    + '<path d="M5 0.9 L5 9.1 M1.45 2.95 L8.55 7.05 '
    + 'M8.55 2.95 L1.45 7.05"/></g>'
    + '<g stroke="#FFFFFF" stroke-width="0.85" '
    + 'stroke-linecap="round">'
    + '<path d="M5 0.9 L5 9.1 M1.45 2.95 L8.55 7.05 '
    + 'M8.55 2.95 L1.45 7.05"/>'
    + '<path d="M4 2 L5 2.9 L6 2 M4 8 L5 7.1 L6 8"/></g>'
    + '<circle cx="5" cy="5" r="0.8" fill="#FFFFFF"/></svg>';

  // směr „větru" pro babí léto a listí — jeden na celý běh appky
  const VITR = Math.random() * Math.PI * 2;
  const LISTI_BARVY = ['#C9862B', '#B4541E', '#8E6B1F', '#C7A22F'];

  // ⭐ v1.530: VČELA PODLE FOTOGRAFIE (uživatel poslal předlohu).
  //
  // Co se z předlohy četlo jinak, než jsem kreslil napoprvé:
  //  • křídla jsou **dlouhá** — sahají až za špičku zadečku,
  //    nežijí vedle těla jako pahýlky;
  //  • svírají s tělem jen ~20–25° a **leží PŘES zadeček**, který
  //    jimi prosvítá — proto se kreslí až nakonec, průsvitně;
  //  • hruď je ryšavě chlupatá, ne hladce zlatá;
  //  • zadeček se kuželovitě **zužuje do špičky** a pruhy jsou
  //    amberové na tmavém, ne tmavé na zlatém;
  //  • včela má nožky — bez nich to byl brouk bez siluety.
  //
  // ⚠️ PRUHY JSOU AMBEROVÉ ELIPSY NA TMAVÉM TĚLE, ne řezy skrz zlaté.
  // Zadeček je bezierová kapka a spočítat přesné výseče by z ní nešlo;
  // takhle stačí, aby byl pruh UžŠÍ než tělo v té výšce — dovnitř
  // nakreslený tvar z něj nemůže vylézt a `clipPath` není potřeba
  // (sdílené `id` by po recyklaci značky ukazovalo do prázdna).
  const VCELA_SVG = '<svg viewBox="0 0 18 18" width="13" height="13">'
    // nožky (pod vším)
    + '<g stroke="#241B08" stroke-width="0.5" fill="none" '
    + 'stroke-linecap="round" opacity="0.85">'
    + '<path d="M7.1 6.0 L4.8 4.3"/><path d="M6.5 7.3 L3.9 7.2"/>'
    + '<path d="M6.9 8.6 L4.6 11.0"/>'
    + '<path d="M10.9 6.0 L13.2 4.3"/><path d="M11.5 7.3 L14.1 7.2"/>'
    + '<path d="M11.1 8.6 L13.4 11.0"/></g>'
    // tykadla (lomená, jako na předloze)
    + '<g stroke="#241B08" stroke-width="0.5" fill="none" '
    + 'stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M8.2 2.4 L7.0 1.3 L5.5 1.5"/>'
    + '<path d="M9.8 2.4 L11.0 1.3 L12.5 1.5"/></g>'
    // zadeček: tmavá kapka zužující se do špičky
    + '<path d="M9 7.3 C10.95 7.3 11.8 9.3 11.8 11.5 '
    + 'C11.8 13.9 10.3 16.5 9 16.5 C7.7 16.5 6.2 13.9 6.2 11.5 '
    + 'C6.2 9.3 7.05 7.3 9 7.3 Z" fill="#241B08"/>'
    // amberové pruhy (užší než tělo, takže nemohou vylézt)
    + '<g fill="#E8A72B">'
    + '<ellipse cx="9" cy="8.7" rx="2.25" ry="0.62" opacity="0.98"/>'
    + '<ellipse cx="9" cy="10.5" rx="2.5" ry="0.66"/>'
    + '<ellipse cx="9" cy="12.3" rx="2.35" ry="0.62"/>'
    + '<ellipse cx="9" cy="13.95" rx="1.8" ry="0.5" opacity="0.9"/></g>'
    // hruď: ryšavá a chlupatá
    + '<ellipse cx="9" cy="6.7" rx="2.85" ry="2.45" fill="#8E5C1E"/>'
    + '<ellipse cx="9" cy="6.6" rx="2.35" ry="1.95" fill="#C98A32"/>'
    + '<ellipse cx="8.8" cy="6.2" rx="1.35" ry="1.05" fill="#E0A445" '
    + 'opacity="0.75"/>'
    // hlava s okem
    + '<ellipse cx="9" cy="3.7" rx="2.05" ry="1.85" fill="#241B08"/>'
    + '<ellipse cx="7.9" cy="3.5" rx="0.62" ry="0.85" fill="#4A3A18"/>'
    + '<ellipse cx="10.1" cy="3.5" rx="0.62" ry="0.85" fill="#4A3A18"/>'
    // ⭐ KŘÍDLA AŽ NAKONEC A PRŮSVITNĚ — na předloze jimi jsou
    // pruhy zadečku vidět. Na každé straně přední (dlouhé) a zadní
    // (kratší, víc rozevřené) křídlo.
    // ⭐ v1.532: KŘÍDLA SE MIHOTAJÍ (výtka „nehýbají křídly, vypadá
    // to, jako by běhaly“). Statická pohybová skvrna nestačila — oko
    // čeká POHYB, ne rozmazaný tvar.
    //
    // Každá strana má TŘI prvky: široký bílý **rozmaz** (opsaný oblouk
    // mávnutí) a dvě **polohy křídla**, které se střídají v protifázi.
    // Běží to na CSS a mění se **jen `opacity`** — nikdy `transform`,
    // protože CSS transform by přebil atribut `rotate(...)` a křídla by
    // se srovnala do jedné osy.
    //
    // ⚠️ `steps(1,end)` je záměr: křídlo má CVAKAT mezi dvěma
    // polohami, ne se plynule prolínat — plynulé prolínání vypadá
    // jako dýchání, ne jako mávnutí.
    + '<g fill="#F4F9F7" stroke="rgba(90,105,98,0.28)" '
    + 'stroke-width="0.16">'
    + '<ellipse class="vk-r" cx="5.9" cy="10.4" rx="4.9" ry="2.3" '
    + 'stroke="none" transform="rotate(120 5.9 10.4)"/>'
    + '<ellipse class="vk-r" cx="12.1" cy="10.4" rx="4.9" ry="2.3" '
    + 'stroke="none" transform="rotate(60 12.1 10.4)"/>'
    + '<ellipse class="vk-a" cx="6.31" cy="10.97" rx="4.5" ry="1.5" '
    + 'transform="rotate(112 6.31 10.97)"/>'
    + '<ellipse class="vk-a" cx="11.69" cy="10.97" rx="4.5" ry="1.5" '
    + 'transform="rotate(68 11.69 10.97)"/>'
    + '<ellipse class="vk-b" cx="5.35" cy="9.5" rx="4.3" ry="1.25" '
    + 'transform="rotate(134 5.35 9.5)"/>'
    + '<ellipse class="vk-b" cx="12.65" cy="9.5" rx="4.3" ry="1.25" '
    + 'transform="rotate(46 12.65 9.5)"/></g></svg>';

  // ⭐ MŮRA (v1.592): bledá nenápadná křídla, mihotají týmž cvakáním
  // jako včela (třídy vk-a/vk-b s vlastní fází).
  const MURA_SVG = '<svg viewBox="0 0 12 12" width="12" height="12">'
    + '<g fill="#E2D7BC" stroke="rgba(90,80,55,0.35)" '
    + 'stroke-width="0.2">'
    + '<ellipse class="vk-a" cx="3.6" cy="5.6" rx="3.3" ry="1.7" '
    + 'transform="rotate(-28 3.6 5.6)"/>'
    + '<ellipse class="vk-a" cx="8.4" cy="5.6" rx="3.3" ry="1.7" '
    + 'transform="rotate(28 8.4 5.6)"/>'
    + '<ellipse class="vk-b" cx="3.8" cy="6.4" rx="3.1" ry="1.35" '
    + 'transform="rotate(-52 3.8 6.4)"/>'
    + '<ellipse class="vk-b" cx="8.2" cy="6.4" rx="3.1" ry="1.35" '
    + 'transform="rotate(52 8.2 6.4)"/></g>'
    + '<ellipse cx="6" cy="6.3" rx="0.85" ry="2.5" fill="#8A7A54"/>'
    + '<path d="M5.5 4.2 L4.6 2.8 M6.5 4.2 L7.4 2.8" '
    + 'stroke="#8A7A54" stroke-width="0.35" fill="none"/></svg>';

  // ⭐ NETOPÝR (v1.592): silueta se dvěma polohami křídel — mávání
  // pomalejší než včela (třídy nk-a/nk-b, 0,34 s).
  const NETOPYR_SVG = '<svg viewBox="0 0 20 12" width="20" '
    + 'height="12"><g fill="#17120E">'
    + '<path class="nk-a" d="M10 6 C8 2.2 5.2 1.4 1.2 2.4 '
    + 'C3.4 3.4 3.6 4.4 4.4 5.4 C5.8 5 7.6 5.2 10 6 Z"/>'
    + '<path class="nk-a" d="M10 6 C12 2.2 14.8 1.4 18.8 2.4 '
    + 'C16.6 3.4 16.4 4.4 15.6 5.4 C14.2 5 12.4 5.2 10 6 Z"/>'
    + '<path class="nk-b" d="M10 6 C8 6.8 5.6 8.6 2.2 8.2 '
    + 'C4 6.8 4.2 6 4.8 5.2 C6.2 5.4 8 5.4 10 6 Z"/>'
    + '<path class="nk-b" d="M10 6 C12 6.8 14.4 8.6 17.8 8.2 '
    + 'C16 6.8 15.8 6 15.2 5.2 C13.8 5.4 12 5.4 10 6 Z"/>'
    + '<ellipse cx="10" cy="6" rx="1.5" ry="2.1"/>'
    + '<path d="M9.2 4.4 L8.8 3.2 L9.8 3.9 Z"/>'
    + '<path d="M10.8 4.4 L11.2 3.2 L10.2 3.9 Z"/></g></svg>';

  // ⭐ PADAJÍCÍ LIST (v1.592): kapkovitý lístek se stopkou; barva
  // z LISTI_BARVY, otáčení dělá CSS animace listToc na vnitřním divu.
  function LIST_SVG(barva) {
    return '<svg viewBox="0 0 12 12" width="12" height="12">'
      + '<path d="M6 1.2 C8.6 2.6 9.6 5.2 9.2 8.0 C8.8 10 7.4 11 '
      + '6 11 C4.6 11 3.2 10 2.8 8.0 C2.4 5.2 3.4 2.6 6 1.2 Z" '
      + 'fill="' + barva + '"/>'
      + '<path d="M6 2.2 L6 10.4" stroke="rgba(80,45,10,0.55)" '
      + 'stroke-width="0.5"/>'
      + '<path d="M6 11 L6 12" stroke="rgba(80,45,10,0.8)" '
      + 'stroke-width="0.7"/></svg>';
  }

  // Babí léto: prohnutá nit, oba konce do ztracena, uprostřed slabší
  // (jako by ji nesl vítr a chytala světlo jen na dvou místech).
  const BABILETO_SVG =
    '<svg viewBox="0 0 34 8" width="34" height="8" '
    + 'xmlns="http://www.w3.org/2000/svg" style="display:block">'
    + '<defs><linearGradient id="okolnikNit" x1="0" y1="0" x2="1" y2="0">'
    + '<stop offset="0" stop-color="#fff" stop-opacity="0"/>'
    + '<stop offset="0.22" stop-color="#fff" stop-opacity="0.9"/>'
    + '<stop offset="0.5" stop-color="#fff" stop-opacity="0.3"/>'
    + '<stop offset="0.74" stop-color="#fff" stop-opacity="0.85"/>'
    + '<stop offset="1" stop-color="#fff" stop-opacity="0"/>'
    + '</linearGradient></defs>'
    + '<path d="M0.5 5.6 C 8 2.2, 16 7.2, 24 3.6 S 31 2.4, 33.5 3.2" '
    + 'fill="none" stroke="url(#okolnikNit)" stroke-width="0.8" '
    + 'stroke-linecap="round"/></svg>';

  // Styl mihotání se vloží jednou pro celou stránku.
  // ⚠️ `--vfaze` dává KAŽDÉ včele jiný začátek — bez toho mávají
  // všechny naráz jako sbor a je to na první pohled strojové.
  (function stylMihu() {
    if (document.getElementById('vcela-mih')) return;
    const st = document.createElement('style');
    st.id = 'vcela-mih';
    st.textContent =
      '@keyframes vcelaA{0%,49%{opacity:.46}50%,100%{opacity:.10}}'
      + '@keyframes vcelaB{0%,49%{opacity:.10}50%,100%{opacity:.44}}'
      + '@keyframes vcelaR{0%,49%{opacity:.14}50%,100%{opacity:.34}}'
      + '.vk-a{animation:vcelaA .1s steps(1,end) infinite '
      + 'var(--vfaze,0ms)}'
      + '.vk-b{animation:vcelaB .1s steps(1,end) infinite '
      + 'var(--vfaze,0ms)}'
      + '.vk-r{animation:vcelaR .1s steps(1,end) infinite '
      + 'var(--vfaze,0ms)}'
      // netopýr mává pomaleji (tytéž keyframes, delší perioda)
      + '.nk-a{animation:vcelaA .34s steps(1,end) infinite '
      + 'var(--vfaze,0ms)}'
      + '.nk-b{animation:vcelaB .34s steps(1,end) infinite '
      + 'var(--vfaze,0ms)}'
      // otáčení padajícího listu
      + '@keyframes listToc{from{transform:rotate(0deg)}'
      + 'to{transform:rotate(360deg)}}'
      // třpyt vlákna babího léta (v1.601.5)
      + '@keyframes vlaknoTrpyt{0%,100%{opacity:.32}50%{opacity:.78}}';
    document.head.appendChild(st);
  })();

  /// Naplní vnitřní div vzhledem daného typu (zrod i přerod prvku).
  function naplnVnitrek(vnitrni, typ) {
    vnitrni.style.cssText = HMYZ_VZHLED[typ] || HMYZ_VZHLED.svetluska;
    // náhodná fáze mávnutí (jinak mávají všechny naráz jako sbor)
    vnitrni.style.setProperty(
        '--vfaze', (-Math.random() * 340).toFixed(0) + 'ms');
    if (typ === 'vcela') {
      vnitrni.innerHTML = VCELA_SVG;
    } else if (typ === 'mura') {
      vnitrni.innerHTML = MURA_SVG;
    } else if (typ === 'netopyr') {
      vnitrni.innerHTML = NETOPYR_SVG;
    } else if (typ === 'list') {
      vnitrni.innerHTML = LIST_SVG(
          LISTI_BARVY[(Math.random() * LISTI_BARVY.length) | 0]);
      vnitrni.style.animation = 'listToc '
          + (2.1 + Math.random() * 1.6).toFixed(2) + 's linear infinite';
    } else if (typ === 'babileto') {
      vnitrni.innerHTML = BABILETO_SVG;
      vnitrni.style.animation = 'vlaknoTrpyt '
          + (1.6 + Math.random() * 1.2).toFixed(2) + 's ease-in-out infinite';
    } else if (typ === 'vlocka') {
      vnitrni.innerHTML = VLOCKA_SVG;
      // pomalé otáčení — sníh se snáší, nepadá jak kámen
      vnitrni.style.animation = 'listToc '
          + (5 + Math.random() * 3).toFixed(2) + 's linear infinite';
    } else {
      vnitrni.innerHTML = '';
    }
  }

  function muskaPrvek(typ) {
    // ⚠️ transform VNĚJŠÍHO prvku patří Markeru (posun na souřadnici)
    // — škála a vzhled žijí na vnitřním, jinak by se přetáhly.
    const el = document.createElement('div');
    el.style.cssText = 'pointer-events:none;';
    const vnitrni = document.createElement('div');
    naplnVnitrek(vnitrni, typ);
    el.appendChild(vnitrni);
    el.__vnitrni = vnitrni;
    el.__typ = typ;
    return el;
  }
  function velikostMusky() {
    const z = Math.max(13.2, Math.min(17.6, mapa.getZoom()));
    // exp 1,6 mezi 13,2→0,27 a 17,6→1,0 (44 px prvek)
    const t = (Math.pow(1.6, z - 13.2) - 1) / (Math.pow(1.6, 4.4) - 1);
    return 0.27 + t * 0.73;
  }
  // ⭐⭐ v1.429.3: ZÁPIS TRANSFORMŮ Z UDÁLOSTI `render` MAPY.
  // Historie zpoždění: Marker dostával transform o snímek později;
  // vlastní rAF (v1.429.2) zase závodila s rAF MapLibre — gesta se
  // aplikují UVNITŘ jeho render smyčky, takže pořadí callbacků
  // rozhodovalo a občas zbyl snímek zpoždění. `render` událost se
  // střílí PO aplikaci kamery daného snímku uvnitř TÉHOŽ úkolu —
  // zápis CSS dopadne do kompozice stejného snímku. Deterministické.
  function zapisMusky() {
    try {
      if (!mapa) return;
      const tr = mapa._camera.transform;
      const ter = mapa.terrain;
      for (const m of musky) {
        if (!m.el) continue;
        const ll = new maplibregl.LngLat(m.x, m.y);
        const p = (ter && typeof m.vyska === 'number')
          ? tr.locationToScreenPoint(ll,
              { getElevationForLngLat: () => m.vyska })
          : tr.locationToScreenPoint(ll);
        m.el.style.transform = 'translate(-50%, -50%) translate('
            + p.x + 'px, ' + p.y + 'px)';
      }
    } catch (e) { /* styl se zrovna mění */ }
  }
  let renderMusekNasazen = false;
  function nasadRenderMusky() {
    if (renderMusekNasazen || !mapa) return;
    renderMusekNasazen = true;
    mapa.on('render', () => {
      // v klidu polohy mění jen tik (volá zapisMusky sám)
      if (mapa.isMoving && mapa.isMoving()) zapisMusky();
    });
  }
  function zrusRoj() {
    for (const m of musky) {
      if (m.el) { try { m.el.remove(); } catch (e) { /* pryč */ } }
      m.el = null;
    }
    musky = [];
  }
  // ⭐⭐ v1.556: DENNÍ HMYZ SE RODÍ NA OBRAZOVCE.
  //
  // Výtka 23. 8.: *„včelka není vidět vůbec, není to její velikostí."*
  // Měl pravdu — změřeno přes CDP: v DOMu **8 včel, na obrazovce
  // jedna**. Kotvy (`sv:2`) pokrývají výřez PLUS půl obrazovky na
  // každou stranu, tedy zhruba čtyřnásobek plochy; osm náhodně
  // vybraných jich tedy do viditelné části trefí v průměru dvě.
  // V noci to nevadí (světlušek je 40 a každá je 44px zář), ve dne
  // z toho zbyla jedna dvanáctipixelová tečka někde v rohu.
  //
  // ⚠️ PROJEKCE ANO, ODPROJEKTOVÁNÍ NE. `locationToScreenPoint` je
  // násobení maticí; `unproject` nebo `getBounds` se zapnutým terénem
  // znamenají raycast a `gl.readPixels` — past, která už jednou sežrala
  // 31 % času snímku (schovaný `ScaleControl`).
  function naObrazovce(lon, lat, okraj) {
    try {
      const p = mapa._camera.transform.locationToScreenPoint(
          new maplibregl.LngLat(lon, lat));
      const pl = mapa.getCanvas();
      const o = okraj || 0;
      return p.x > -o && p.y > -o
          && p.x < pl.clientWidth + o && p.y < pl.clientHeight + o;
    } catch (e) {
      return true;     // netušíme → nebránit zrodu
    }
  }

  /// Kotva pokud možno UVNITŘ výřezu; po pár marných pokusech vezme
  /// jakoukoli (v lese za obzorem je pořád lepší muška než žádná).
  function vyberKotvu(kotvy, uvnitr) {
    if (!uvnitr) return kotvy[(Math.random() * kotvy.length) | 0];
    for (let i = 0; i < 8; i++) {
      const k = kotvy[(Math.random() * kotvy.length) | 0];
      const c = k.geometry.coordinates;
      if (naObrazovce(c[0], c[1], -24)) return k;
    }
    return kotvy[(Math.random() * kotvy.length) | 0];
  }

  function rojSvetlusek(rezim) {
    rojSvetlusek._tik = (rojSvetlusek._tik || 0) + 1;
    if (mapa.getZoom() < 13.2) rezim = null;   // jako mívala vrstva
    if (rojSvetlusek._rezim !== rezim) {
      rojSvetlusek._rezim = rezim;
      zrusRoj();           // jiný vzhled prvků — bazének postavit znovu
    }
    if (!rezim) return;
    const den = rezim === 'den' || rezim === 'podzimden'
        || rezim === 'zimaden';
    const kotvy = svetlaEvidence.filter((f) => f.properties.sv === 2);
    // můry krouží u OKEN vesnic (sv:1 = světla sídel)
    const okna = rezim === 'podzimnoc'
        ? svetlaEvidence.filter((f) => f.properties.sv === 1)
        : null;
    if (!kotvy.length && !(okna && okna.length)) return;
    // doplnit populaci (rodí se zhasnuté, jas si nadýchají)
    // ⚠️ DVANÁCT, NE DVACET DVA. Když se hmyz rodí ve výřezu, dostane
    // se na obrazovku skoro všechen — z 22 kusů jich bylo vidět 13
    // a uživatel to měl za nálet. Dvanáct dělá ~8 včel, z toho na
    // obrazovce sedm; to je koření, ne roj. (V noci zůstává 40, ale
    // světlušky se rodí kdekoli a půlka jich zhasíná.)
    const mesicTed = window.__vynutMesic || (new Date().getMonth() + 1);
    let strop;
    if (rezim === 'podzimnoc') {
      // hrst můr na vesnici + pár netopýrů nad krajinou
      strop = Math.min(22, ((okna && okna.length) || 0) + 3);
    } else if (den) {
      // 5. 9. 2026: „uber včel“ – 12 → 6
      strop = Math.min(6, Math.max(kotvy.length, 1));
    } else {
      strop = Math.min(MUSEK_MAX, kotvy.length);
    }
    while (musky.length < strop) {
      // ⚠️ VČEL DVĚ ZE TŘÍ. Moucha je čtyřpixelová tmavá tečka —
      // jako atmosféra dobrá, ale uživatel si přál VČELY a při dělení
      // půl na půl jich byla polovina k nerozeznání od smítka.
      let typ;
      if (rezim === 'podzimnoc') {
        typ = (musky.length % 7 === 3 || !(okna && okna.length))
            ? 'netopyr' : 'mura';
      } else if (rezim === 'zimaden') {
        typ = 'vlocka';
      } else if (rezim === 'podzimden') {
        // září: babí léto mezi včelami; říjen: vlákna a první listí;
        // listopad: už skoro jen listí
        const pool = mesicTed === 9
            ? ['vcela', 'babileto', 'vcela', 'moucha', 'babileto']
            : (mesicTed === 10
                ? ['babileto', 'list', 'vcela', 'list', 'moucha']
                : ['list', 'list', 'moucha', 'list']);
        typ = pool[musky.length % pool.length];
      } else if (den) {
        typ = musky.length % 2 === 0 ? 'moucha' : 'vcela';
      } else {
        typ = 'svetluska';
      }
      const zdrojKotev = (typ === 'mura' && okna && okna.length)
          ? okna : (kotvy.length ? kotvy : okna);
      if (!zdrojKotev || !zdrojKotev.length) break;
      const k = vyberKotvu(zdrojKotev, rezim !== 'noc');
      const [lon, lat] = k.geometry.coordinates;
      musky.push({
        kx: lon, ky: lat, x: lon, y: lat,
        smer: Math.random() * Math.PI * 2,
        jas: rezim === 'noc' ? 0 : 0.9,
        cil: rezim === 'noc' ? 0.4 + Math.random() * 0.6
                             : 0.9 + Math.random() * 0.1,
        typ: typ,
      });
    }
    const mLat = 1 / 110574;             // ~metr v stupních
    for (const m of musky) {
      const mLon = 1 / (111320 * Math.cos(m.ky * Math.PI / 180));
      // náhodná procházka ~4 m/tik s gumičkou ke kotvě od ~30 m
      // třetinové kroky (tik 133 ms): světluška pluje, denní hmyz
      // kličkuje rychleji a trhaněji (včela/moucha)
      // fyzika letu podle druhu (v1.592): zatáčivost, krok a délka
      // gumičky ke kotvě
      let zatoc = den ? 1.5 : 0.63;
      let krokM = den ? 1.6 + Math.random() * 1.6
                      : 1 + Math.random() * 0.85;
      let gumaOd = 30;
      if (m.typ === 'mura') {
        // těsné kroužení u rozsvíceného okna
        zatoc = 2.6; krokM = 1.1 + Math.random() * 1.3; gumaOd = 8;
      } else if (m.typ === 'netopyr') {
        // rychlé trhané nálety nad krajinou
        zatoc = 1.05; krokM = 4.2 + Math.random() * 2.6; gumaOd = 140;
      } else if (m.typ === 'babileto') {
        // vlákno se nese větrem, skoro rovně
        zatoc = 0.22; krokM = 1.0 + Math.random() * 0.9; gumaOd = 90;
        const dv = Math.atan2(Math.sin(VITR - m.smer),
            Math.cos(VITR - m.smer));
        m.smer += dv * 0.02;
      } else if (m.typ === 'list') {
        // list poskakuje větrem a kymácí se
        zatoc = 0.5; krokM = 2.0 + Math.random() * 1.4; gumaOd = 80;
        const dv = Math.atan2(Math.sin(VITR - m.smer),
            Math.cos(VITR - m.smer));
        m.smer += dv * 0.03
            + Math.sin((rojSvetlusek._tik + (m.rozfaze || 0)) / 5)
              * 0.22;
      } else if (m.typ === 'vlocka') {
        // vločka se snáší zvolna, s jemným kolébáním po větru
        zatoc = 0.3; krokM = 0.7 + Math.random() * 0.6; gumaOd = 100;
        const dv = Math.atan2(Math.sin(VITR - m.smer),
            Math.cos(VITR - m.smer));
        m.smer += dv * 0.02
            + Math.sin((rojSvetlusek._tik + (m.rozfaze || 0)) / 8)
              * 0.12;
      }
      m.smer += (Math.random() - 0.5) * zatoc;
      m.x += Math.cos(m.smer) * krokM * mLon;
      m.y += Math.sin(m.smer) * krokM * mLat;
      const dx = (m.x - m.kx) / mLon, dy = (m.y - m.ky) / mLat;
      const dal = Math.hypot(dx, dy);
      if (dal > gumaOd) {
        m.smer = Math.atan2(-dy, -dx) + (Math.random() - 0.5) * 0.6;
      }
      // dech jasu; po zhasnutí přerod u jiné kotvy
      // ⭐ v1.419: denní hmyz NEMIZÍ („ať přes den nemizí“) — jen
      // věčně krouží u kotvy s drobným třepetáním jasu 0,85–1,0.
      const dechKrok = m.typ === 'svetluska' ? 0.027 : 0.09;
      const dj = m.cil - m.jas;
      m.jas += Math.abs(dj) <= dechKrok ? dj : Math.sign(dj) * dechKrok;
      // ⚠️ DENNÍ HMYZ, KTERÝ ULETĚL Z VÝŘEZU, SE PŘERODÍ V DOHLEDU.
      // Bez tohohle se roj po pár posunech mapy rozprskne do okolí
      // a na obrazovce nezbyde nic — přesně to, co uživatel hlásil.
      // V noci se to nedělá: světluška se přerozuje sama, až zhasne.
      // ⛔⛔ ŽÁDNÉ `i` — TAHLE SMYČKA HO NEMÁ (`for…of`). Sáhl jsem po
      // něm a `ReferenceError` spolkl `try/catch` kolem celého tiku,
      // takže PŘESTAL LÍTAT VŠECHEN HMYZ. Rozptyl přes čas dělá vlastní
      // pole `m.rozfaze`, ať se všechny mušky nepřerozují naráz.
      if (m.rozfaze === undefined) m.rozfaze = (Math.random() * 15) | 0;
      if (rezim !== 'noc'
          && ((rojSvetlusek._tik + m.rozfaze) % 15) === 0
          && !naObrazovce(m.x, m.y, 80)) {
        const zk = (m.typ === 'mura' && okna && okna.length)
            ? okna : (kotvy.length ? kotvy : okna);
        const k = vyberKotvu(zk, true);
        const c = k.geometry.coordinates;
        m.kx = c[0]; m.ky = c[1]; m.x = c[0]; m.y = c[1];
      }
      if (Math.abs(dj) <= dechKrok) {
        if (m.typ === 'mura') {
          m.cil = 0.55 + Math.random() * 0.4;
        } else if (m.typ === 'babileto') {
          m.cil = 0.45 + Math.random() * 0.35;
        } else if (m.typ === 'netopyr' || m.typ === 'list') {
          m.cil = 0.9 + Math.random() * 0.1;
        } else if (m.typ === 'vlocka') {
          m.cil = 0.7 + Math.random() * 0.3;
        } else if (den) {
          m.cil = 0.85 + Math.random() * 0.15;
        } else if (m.cil === 0) {
          const k = kotvy[(Math.random() * kotvy.length) | 0];
          const [lon, lat] = k.geometry.coordinates;
          m.kx = lon; m.ky = lat; m.x = lon; m.y = lat;
          m.cil = 0.4 + Math.random() * 0.6;
        } else {
          m.cil = Math.random() < 0.22 ? 0 : 0.35 + Math.random() * 0.65;
        }
      }
    }
    const meritko = velikostMusky();
    // ⭐⭐ v1.429.3: STABILNÍ PÁR muška↔div (m.el). Dřív se párovalo
    // INDEXEM filtrovaného pole — pohasnutí jediné mušky posunulo
    // indexy a všechny divy za ní skočily na cizí místa
    // („některé světlušky divně poskakují“). Div žije a umírá
    // se SVOU muškou.
    for (let i = 0; i < musky.length; i++) {
      const m = musky[i];
      const zije = m.jas > 0.02;
      if (!zije) {
        if (m.el) { try { m.el.remove(); } catch (e) { /* pryč */ } }
        m.el = null;
        continue;
      }
      if (!m.el) {
        // ⭐⭐ v1.429.2: holý div v kontejneru plátna, žádný Marker
        // (historie: v1.424 no-op zákrytu — readPixels; v1.429 plochá
        // projekce — paralaxa; v1.429.1 atrapa výšky — pořád snímek
        // zpoždění za rychlým prstem; teď rAF smyčka výš)
        const el = muskaPrvek(m.typ);
        el.style.position = 'absolute';
        el.style.top = '0';
        el.style.left = '0';
        el.style.willChange = 'transform';
        mapa.getCanvasContainer().appendChild(el);
        m.el = el;
        m.elTyp = m.typ;
        // výška hned při zrodu (bez DEM = 0; dorovná lerp níž)
        const v0 = mapa.queryTerrainElevation
            && mapa.queryTerrainElevation([m.x, m.y]);
        m.vyskaCil = (typeof v0 === 'number') ? v0 : 0;
        m.vyska = m.vyskaCil;
        nasadRenderMusky();
      }
      if (m.elTyp !== m.typ) {
        m.elTyp = m.typ;
        naplnVnitrek(m.el.__vnitrni, m.typ);
      }
      // ⭐ v1.429.3: výška PLYNULE — čerstvý vzorek ~1× za 4 s na
      // mušku (rozloženě), dotahuje se lerpem 15 %/tik. Skoková
      // změna (DEM dojel po startu: 0 → 264 m) dřív muškou VIDITELNĚ
      // škubla o desítky px; teď doplave za ~2 s.
      // ⛔ NULA NENÍ VÝŠKA, JE TO „JEŠTĚ NEVÍM" (v1.546).
      //
      // Výtka: *„v noci po přepnutí mapy světlušky mnohdy dolétají na
      // svoji pozici přes mapu."* Při výměně stylu se terén na chvíli
      // odpojí a `queryTerrainElevation` začne vracet nulu — muška
      // dostane cíl 0, lerp ji rozjede dolů, a jakmile výškopis
      // doteče, letí zase zpátky. Při náklonu je 264 m výšky desítky
      // až stovky pixelů, takže to je ten přelet přes mapu.
      //
      // ⚠️ TŘI STAVY, NE DVA: terén vypnutý = výška opravdu 0;
      // terén zapnutý s daty = skutečná výška; terén zapnutý bez dat
      // = **nechat starou hodnotu**. Bez třetí větve by v plochém
      // režimu mušky naopak zůstaly viset ve výšce.
      if (((rojSvetlusek._tik + i) % 30) === 0) {
        const maTeren = !!(mapa.getTerrain && mapa.getTerrain());
        if (!maTeren) {
          m.vyskaCil = 0;
        } else {
          const vy = mapa.queryTerrainElevation
              && mapa.queryTerrainElevation([m.x, m.y]);
          if (typeof vy === 'number' && Math.abs(vy) > 0.5) m.vyskaCil = vy;
        }
      }
      m.vyska += (m.vyskaCil - m.vyska) * 0.15;
      m.el.__vnitrni.style.opacity = m.jas.toFixed(2);
      // podlaha 0,6: na 60% zoomu byl hmyz ~2 px a „skoro nevidět“
      // ⚠️ VČELA MÁ PODLAHU VÝŠ (0,78). Je to kresba s detaily, ne
      // svítící tečka — pod tou hranicí z ní zbyde beztvará skvrna
      // a uživatel hlásí, že „zmizela“. Světluška si vystačí s málem,
      // protože svítí.
      const podlaha = m.typ === 'vcela' ? 0.72 : 0.6;
      const mer = m.typ === 'svetluska'
          ? meritko : Math.max(podlaha, meritko) * 0.95;
      // včela se natáčí po směru letu (SVG má hlavu nahoře)
      const otoceni = m.typ === 'vcela'
          ? ' rotate(' + ((m.smer * 180 / Math.PI + 90) % 360).toFixed(0)
            + 'deg)'
          : '';
      m.el.__vnitrni.style.transform =
          'scale(' + mer.toFixed(3) + ')' + otoceni;
    }
    zapisMusky();   // klidová animace letu — polohy po tiku
  }

  // -------------------------------------------------------------------------
  // PLOCHY Z NAČTENÝCH DLAŽDIC (kam smí strom) — BEZ DOTAZU DO GPU
  // -------------------------------------------------------------------------
  // ⭐ 7. 8. 2026, nález PROFILERU. Dřív se každá kandidátní buňka ptala
  // `mapa.queryRenderedFeatures([px])`, jestli pod ní leží les/louka/pole.
  // Se ZAPNUTÝM TERÉNEM to uvnitř MapLibre znamená `unproject` →
  // `pointCoordinate` → **`gl.readPixels`**, tedy SYNCHRONNÍ ČTENÍ Z GPU,
  // které zastaví vykreslovací frontu. V profilu panování to byla nejtěžší
  // položka vůbec: **21,2 % veškerého času**.
  //
  // Náhrada čte TÁŽ data, jen z druhé strany: `querySourceFeatures` bere
  // vektorové prvky z už načtených dlaždic v PAMĚTI (GPU se neptá vůbec).
  // Zdrojové vrstvy ani filtry se sem NEOPISUJÍ natvrdo — vytáhnou se ze
  // ŽIVÉHO stylu (`getStyle().layers`), takže filtruje sám MapLibre stejným
  // strojem jako při kreslení a úpravy barevného patra ve `styles.js` se
  // nemusí zrcadlit sem. Bod v polygonu si spočítáme sami (ray casting)
  // nad hrubou mřížkou; převedené polygony se drží po DLAŽDICÍCH, takže
  // cesta tam a zpět je podruhé zadarmo.
  //
  // ⚠️ Umístění dekorací se tím MĚNIT NESMÍ — mřížka je deterministická
  // (viz `hash`) a testuje se přesně tentýž zeměpisný bod jako dřív.

  // plochy, na kterých dekorace ROSTOU (sesbírané z DRUHY)
  // ⛔⛔ VODA MUSÍ BÝT V INDEXU, I KDYŽ NA NÍ NIC NEROSTE (9. 8. 2026).
  // Slouží jako ZÁKAZ: lesní polygon v OSM se běžně táhne PŘES rybník
  // (nemá v sobě díru), takže bod projde testem „je v lese" a přistane
  // na hladině — *„Bažantník v Sedmihorkách má na ploše rybníku strom."*
  // ⚠️ Dokud tu byly rybníky, dostala se sem `voda` sama přes jejich
  // `vrstvy`. Po jejich vypnutí by vypadla a strom by se na hladinu
  // vrátil, proto je vyjmenovaná zvlášť. `SVEDCI` NESTAČÍ — těm se
  // geometrie nepřevádí, takže by se v `plochyPodBodem` nikdy neobjevila.
  // ⭐ 5. 9. noc: budovy jako ZÁKAZ („dávej pozor, kde jsou stromy") –
  // `budovy-vypln` je od z14 v indexu jako každá jiná plocha; kandidát
  // v půdorysu domu se zahodí (světla oken na domech zůstávají).
  const ZAKAZ_PLOCHY = ['voda', 'budovy-vypln'];
  // silnice a cesty jako ČÁRY se šířkou podle třídy (m, včetně rezervy)
  const CARY_ZAKAZ = { 'silnice-asfalt': 1, 'silnice-servisni': 1, 'cesty': 1 };
  const SIRKY_CAR = { motorway: 9, trunk: 8, primary: 6, secondary: 5,
                      tertiary: 4.5, minor: 4, service: 3, track: 2.2, path: 1.2 };
  const MRIZKA_CAR = 0.0025;        // ° (~280 m) – jemnější mřížka pro úseky
  // ⭐ 5. 9. 2026 večer: DRUH LESA (ZABAGED, vrstvy `les-jehlicnaty` /
  // `les-listnaty` v herním stylu) – jsou v indexu ploch, aby strom věděl,
  // v jakém lese stojí. Smíšený a neurčený les = plná směs jako dřív.
  const PLOCHY_DRUHU_LESA = ['les-jehlicnaty', 'les-listnaty'];
  const STROMY_JEHLICNATE = ['deko-strom-6', 'deko-strom-7', 'deko-strom-8',
                             'deko-strom-9', 'deko-strom-10'];
  const STROMY_LISTNATE = ['deko-strom-1', 'deko-strom-2', 'deko-strom-3',
                           'deko-strom-4', 'deko-strom-5'];
  const NOSNE = (() => {
    const s = {};
    for (const cfg of Object.values(DRUHY)) {
      for (const v of cfg.vrstvy) s[v] = 1;
    }
    for (const v of ZAKAZ_PLOCHY) s[v] = 1;
    for (const v of PLOCHY_DRUHU_LESA) s[v] = 1;
    return s;
  })();
  // SVĚDCI: dekoraci nenesou, ale dokazují, že v tom místě data OPRAVDU
  // jsou (dlaždice dorazila). Bez důkazu nelze odlišit „tady nic neroste"
  // od „ještě nevím" — a zaměnit to znamená buď holou krajinu, nebo
  // navěky přepočítávané buňky (7. 8., „stromy věčně 3").
  // Jejich geometrie se PROTO ANI NEPŘEVÁDÍ, stačí jméno dlaždice.
  const SVEDCI = ['zastavba', 'voda'];

  const MRIZKA = 0.01;              // ° (~1,1 km) — hrubý prostorový index
  const KES_DLAZDIC = 260;          // převedených dvojic vrstva × dlaždice (5. 9.: +budovy, +silnice)

  let plochyDef = null;             // [{id, zdroj, vrstva, filtr, nosna}]
  const kesDlazdic = new Map();     // "vrstva|z/x/y" → [polygon]
  let idxMrizka = null;             // "gx:gy" → [polygon]
  let idxCary = null;               // "gx:gy" (MRIZKA_CAR) → [úsek silnice]
  let idxBudovy = null;             // "gx:gy" (MRIZKA_CAR) → [půdorys domu] (engine 201)
  let idxVelke = [];                // polygony přes moc buněk mřížky
  let idxDlazdice = null;           // Set("z/x/y") — kde data MÁME
  let idxZoomy = [];                // zoomy dlaždic v indexu, od nejjemnější
  let idxZCil = 0;                  // zoom dlaždic, které mapa právě chce

  /// Zdrojová vrstva + filtr každé plochy ze ŽIVÉHO stylu. Drží se do
  /// výměny stylu (`pripoj`) — `getStyle()` serializuje celý styl, takže
  /// se na to neptáme za běhu.
  function definicePloch() {
    if (plochyDef) return plochyDef;
    let vrstvy = null;
    try { vrstvy = mapa.getStyle().layers; } catch (e) { return null; }
    if (!vrstvy) return null;
    const out = [];
    const zdroje = new Set();
    for (const v of vrstvy) {
      const nosna = !!NOSNE[v.id];
      const cara = !!CARY_ZAKAZ[v.id];
      if (!nosna && !cara && SVEDCI.indexOf(v.id) < 0) continue;
      if (!v.source || !v['source-layer']) continue;
      if (v.layout && v.layout.visibility === 'none') continue;
      out.push({ id: v.id, zdroj: v.source, vrstva: v['source-layer'],
                 filtr: v.filter, nosna, cara,
                 zmin: v.minzoom, zmax: v.maxzoom });
      zdroje.add(v.source);
    }
    plochyDef = out;
    return plochyDef;
  }

  /// ⚠️ Index se staví POKAŽDÉ ZNOVU a NEKEŠUJE se přes průchody. Zkoušel
  /// jsem to (otisk výřezu + počítadlo došlých dlaždic) a je to PAST:
  /// sada vykreslovaných dlaždic se mění i BEZ události `sourcedata` (po
  /// skoku mapy jsou chvíli vykreslení jen hrubí rodiče, a jakmile se
  /// jemné dlaždice vezmou z keše MapLibre, žádná událost nepřijde).
  /// Index z rodičů pak přežil a krajina zůstala holá. Levné to je i tak:
  /// průchod jen vyjmenuje prvky načtených dlaždic, GEOMETRIE SE PŘEVÁDÍ
  /// JEN U NOVÝCH (viz `kesDlazdic`), a `dopln` si o index řekne jen když
  /// opravdu přibyla netknutá buňka.
  const PREVOD_ROZPOCET_MS = 14;    // engine 202: převod nových dlaždic na průchod
  function postavIndex() {
    if (!mapa) return;
    const defs = definicePloch();
    if (!defs || !defs.length) { idxMrizka = null; return; }
    const z = mapa.getZoom();
    const tStart = performance.now();
    let rozpocetVycerpan = false;
    const mrizka = new Map();
    const mrizkaCary = new Map();
    const mrizkaBudovy = new Map();
    const velke = [];
    const dlazdice = new Set();
    for (const d of defs) {
      // engine 201: půdorysy domů (tisíce na dlaždici) až od z15 – níž jsou
      // stromy drobné a prořez to dohoní
      if (d.id === 'budovy-vypln' && z < 15) continue;
      // vrstva mimo svůj zoomový rozsah se nekreslí → neplatí ani tady
      if (d.zmin != null && z < d.zmin) continue;
      if (d.zmax != null && z >= d.zmax) continue;
      let prvky = null;
      try {
        // validate:false — filtr přišel ze stylu, ověřovat ho podruhé
        // by znamenalo projít validátorem při každém průchodu
        prvky = mapa.querySourceFeatures(d.zdroj, {
          sourceLayer: d.vrstva, filter: d.filtr, validate: false,
        });
      } catch (e) { continue; }      // zdroj/vrstva zrovna chybí
      if (!prvky || !prvky.length) continue;
      // ① které dlaždice tu jsou a které z nich ještě nemáme převedené
      //    (`f.tile` je kanonické z/x/y dlaždice, ze které prvek pochází;
      //    dává ho MapLibre i ve v5 i ve v6 — čtení NEPŘEVÁDÍ geometrii).
      //    Prvky chodí po dlaždicích a všechny z jedné sdílejí TENTÝŽ
      //    objekt, takže porovnání identity přeskočí stovky opakování;
      //    kdyby to knihovna změnila, jen se práce udělá po prvcích.
      const klice = new Set();
      const nove = new Set();
      let poslT = null;
      for (const f of prvky) {
        const t = f.tile;
        if (!t || t === poslT) continue;
        poslT = t;
        const dk = t.z + '/' + t.x + '/' + t.y;
        dlazdice.add(dk);
        if (!d.nosna && !d.cara) continue;   // svědek — geometrii nepotřebujeme
        const kk = d.id + '|' + dk;
        klice.add(kk);
        if (!kesDlazdic.has(kk)) nove.add(kk);
      }
      // ② převod geometrie (jediné opravdu drahé místo) jen u NOVÝCH
      if (nove.size) {
        // ⭐ engine 202: ROZPOČET – převod geometrie (tisíce půdorysů domů na
        // dlaždici) se dělí mezi průchody; co se nestihne, není v keši a
        // převede se příště (body v těch dlaždicích zatím jen počkají)
        if (rozpocetVycerpan || performance.now() - tStart > PREVOD_ROZPOCET_MS) {
          rozpocetVycerpan = true;
          for (const kk of nove) klice.delete(kk);
          nove.clear();
        }
        for (const kk of nove) kesDlazdic.set(kk, []);
        for (const f of prvky) {
          const t = f.tile;
          if (!t) continue;
          const kk = d.id + '|' + t.z + '/' + t.x + '/' + t.y;
          if (!nove.has(kk)) continue;
          // ⛔ GEOMETRIE SE ČTE LÍNĚ, A TO AŽ TADY. `querySourceFeatures`
          // výš je v `try`, jenže ten nestačí: prvek si drží jen odkaz do
          // dlaždice a teprve `prevedPlochu` sáhne na souřadnice. Když se
          // dlaždice mezitím recykluje (při zoomu jich odtéká spousta),
          // hodí MapLibre „feature index out of bounds" — a protože to
          // padalo VEN, byly z toho nezachycené výjimky (naměřeno 38 za
          // jedno projetí zoomu). Nezachycená výjimka v obsluze události
          // přitom umí spolknout `moveend` se vším, co na něm visí, viz
          // poznámka u `pitchend` v main.js.
          try {
            if (d.cara) prevedCaru(f, kesDlazdic.get(kk));
            else prevedPlochu(f, d.id, kesDlazdic.get(kk));
          } catch (e) {
            // dlaždice je pryč – zahodit rozdělaný záznam, příště se
            // postaví znovu z čerstvé dlaždice
            kesDlazdic.delete(kk);
            klice.delete(kk);
            nove.delete(kk);
          }
        }
      }
      // ③ do mřížky (a čerstvě použité dlaždice na konec keše = LRU)
      for (const kk of klice) {
        const polygony = kesDlazdic.get(kk);
        if (!polygony) continue;
        kesDlazdic.delete(kk);
        kesDlazdic.set(kk, polygony);
        if (d.cara) { for (const p of polygony) doMrizkyCara(mrizkaCary, p); }
        else if (d.id === 'budovy-vypln') { for (const p of polygony) doMrizkyCara(mrizkaBudovy, p); }
        else { for (const p of polygony) doMrizky(mrizka, velke, p); }
      }
    }
    while (kesDlazdic.size > KES_DLAZDIC) {
      kesDlazdic.delete(kesDlazdic.keys().next().value);
    }
    idxMrizka = mrizka;
    idxCary = mrizkaCary;
    idxBudovy = mrizkaBudovy;
    idxVelke = velke;
    idxDlazdice = dlazdice;
    idxZoomy = [];
    for (const dk of dlazdice) {
      const zd = parseInt(dk, 10);
      if (idxZoomy.indexOf(zd) < 0) idxZoomy.push(zd);
    }
    idxZoomy.sort((a, b) => b - a);     // od nejjemnější dlaždice
    // jakou úroveň dlaždic mapa v tomhle zoomu vůbec chce (strop zdroje
    // je nejvýš maxzoom, výš už se dlaždice jen přetahují)
    let strop = 14;
    try {
      const zd = mapa.getSource(defs[0].zdroj);
      if (zd && zd.maxzoom != null) strop = zd.maxzoom;
    } catch (e) { /* zdroj zrovna chybí */ }
    idxZCil = Math.min(Math.floor(z), strop);
  }

  /// Feature → polygony {x0,y0,x1,y1, k}. Souřadnice počítá MapLibre až
  /// při prvním sáhnutí na `geometry` (zeměpisné, WGS-84), proto se každá
  /// dlaždice převádí JEN JEDNOU a pak žije v keši. Prstence se ukládají
  /// jako ploché Float32Array (x,y,x,y…) — proti polím dvojic je to
  /// čtvrtinová paměť a rychlejší průchod; přesnost float32 vychází na
  /// desetinu metru, což je pro „stojí strom v lese?" víc než dost.
  function prevedPlochu(f, id, kam) {
    let g = null;
    try { g = f.geometry; } catch (e) { return; }
    if (!g) return;
    const kusy = g.type === 'Polygon' ? [g.coordinates]
      : (g.type === 'MultiPolygon' ? g.coordinates : null);
    if (!kusy) return;
    for (const prstence of kusy) {
      if (!prstence || !prstence.length || prstence[0].length < 3) continue;
      const k = [];
      for (const r of prstence) {
        const pole = new Float32Array(r.length * 2);
        for (let i = 0; i < r.length; i++) {
          pole[2 * i] = r[i][0];
          pole[2 * i + 1] = r[i][1];
        }
        k.push(pole);
      }
      // obálka se počítá z UŽ PŘEVEDENÝCH čísel, aby nemohla rozhodnout
      // jinak než samotný test bodu
      const v = k[0];
      let x0 = v[0], x1 = v[0], y0 = v[1], y1 = v[1];
      for (let i = 2; i < v.length; i += 2) {
        if (v[i] < x0) x0 = v[i];
        if (v[i] > x1) x1 = v[i];
        if (v[i + 1] < y0) y0 = v[i + 1];
        if (v[i + 1] > y1) y1 = v[i + 1];
      }
      // ⭐ VELKÁ VODA DOSTANE JINÉ JMÉNO, ale v indexu ZŮSTANE (9. 8. 2026).
      // Rybník se sází na `voda`, jenže kresba rybníčku nepatří doprostřed
      // přehrady ani do koryta Labe. Zprvu jsem velké plochy z indexu
      // vyhazoval — jenže voda musí zůstat i jako ZÁKAZ pro souš (viz
      // `ZAKAZ_NA_VODE`), a to platí i pro přehradu. Velké plochy proto
      // dostanou id `voda-velka`: nic na nich neroste a rybník se na ně
      // nesází, ale strom se na ně nesmí postavit taky.
      // Práh ~0,012° ≈ 1,3 km.
      const jmeno = (id === 'voda' && (x1 - x0 > 0.012 || y1 - y0 > 0.012))
        ? 'voda-velka' : id;
      kam.push({ id: jmeno, x0, y0, x1, y1, k });
    }
  }

  function doMrizky(mrizka, velke, p) {
    const gx0 = Math.floor(p.x0 / MRIZKA);
    const gx1 = Math.floor(p.x1 / MRIZKA);
    const gy0 = Math.floor(p.y0 / MRIZKA);
    const gy1 = Math.floor(p.y1 / MRIZKA);
    // obr (rodičovská dlaždice při doskakování detailu) by zabral stovky
    // buněk — ten se prochází zvlášť, je jich pár
    if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > 48) { velke.push(p); return; }
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const k = gx + ':' + gy;
        const s = mrizka.get(k);
        if (s) s.push(p); else mrizka.set(k, [p]);
      }
    }
  }

  /// Bod v polygonu (ray casting). Prstence se počítají VŠECHNY dohromady
  /// — liché/sudé křížení vyřeší díry (rybník uprostřed lesa) samo.
  function vBodu(prstence, lon, lat) {
    let uvnitr = false;
    for (let ri = 0; ri < prstence.length; ri++) {
      const r = prstence[ri];
      const n = r.length;
      for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
        const yi = r[i + 1], yj = r[j + 1];
        if ((yi > lat) === (yj > lat)) continue;
        if (lon < (r[j] - r[i]) * (lat - yi) / (yj - yi) + r[i]) {
          uvnitr = !uvnitr;
        }
      }
    }
    return uvnitr;
  }

  /// Do které dlaždice bod padá (Web Mercator, schéma zdroje).
  function dlazdiceKlic(lon, lat, z) {
    const n = Math.pow(2, z);
    const x = Math.floor((lon + 180) / 360 * n);
    const s = Math.sin(lat * Math.PI / 180);
    const y = Math.floor(
      (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
    return z + '/' + x + '/' + y;
  }

  function sesbirej(pole, lon, lat, nalez) {
    for (let i = 0; i < pole.length; i++) {
      const p = pole[i];
      if (lon < p.x0 || lon > p.x1 || lat < p.y0 || lat > p.y1) continue;
      if (nalez.indexOf(p.id) >= 0) continue;
      if (vBodu(p.k, lon, lat)) nalez.push(p.id);
    }
  }

  /// Které plochy leží pod bodem — nebo NULL, když o tom místě zatím nic
  /// nevíme. Ten rozdíl je zásadní: „nic tu neroste" smí do keše natrvalo,
  /// „nevím" se musí zkusit znovu.
  ///
  /// ⛔ HRUBÝ RODIČ NEROZHODUJE (chyba nalezená při ověřování 7. 8.).
  /// Po skoku mapy je chvíli vykreslená jen rodičovská dlaždice (z7 pod
  /// z15) a v jejích generalizovaných datech drobná louka NEEXISTUJE.
  /// Kdyby se z toho uzavřelo „tady nic neroste", zapíše se to do keše
  /// a krajina zůstane holá NATRVALO. Rozhodovat proto smí jen dlaždice
  /// do dvou úrovní od té, kterou mapa v tomhle zoomu chce (rezerva je
  /// na LOD: dálka při náklonu se kreslí z hrubších dlaždic).
  function plochyPodBodem(lon, lat) {
    if (!idxMrizka) return null;
    let zNalez = -1;
    for (let i = 0; i < idxZoomy.length; i++) {   // od nejjemnější
      if (idxDlazdice.has(dlazdiceKlic(lon, lat, idxZoomy[i]))) {
        zNalez = idxZoomy[i];
        break;
      }
    }
    if (zNalez < 0 || zNalez < idxZCil - 2) return null;
    const nalez = [];
    const bunka = idxMrizka.get(Math.floor(lon / MRIZKA) + ':'
                                + Math.floor(lat / MRIZKA));
    if (bunka) sesbirej(bunka, lon, lat, nalez);
    if (idxVelke.length) sesbirej(idxVelke, lon, lat, nalez);
    if (idxBudovy) {                 // půdorysy domů v jemné mřížce (engine 201)
      const bb = idxBudovy.get(Math.floor(lon / MRIZKA_CAR) + ':'
                               + Math.floor(lat / MRIZKA_CAR));
      if (bb) sesbirej(bb, lon, lat, nalez);
    }
    return nalez;                    // i prázdno je teď JISTÉ
  }

  /// ⭐ 5. 9. 2026 večer: VELIKOST PODLE VÝŠKY TERÉNU („co je výš, udělat
  /// malinko větší, perspektivně je blíž k oku"). Faktor 1 ve 400 m
  /// (průměr ČR), ±1 % na 30 m: 200 m → 0,93, 800 m → 1,13, 1 200 m →
  /// 1,27, strop 1,35. Výška z DEM (`queryTerrainElevation`, bez GPU);
  /// dokud dlaždice terénu není, faktor chybí a doplní se příště.
  /// Úseky silnic/cest pro zákaz (5. 9. noc): každý segment s obalem
  /// rozšířeným o šířku třídy; `naCare` měří vzdálenost bodu od úsečky v m.
  function prevedCaru(f, kam) {
    let g = null, trida = null;
    try { g = f.geometry; trida = f.properties && f.properties.class; } catch (e) { return; }
    if (!g) return;
    const w = SIRKY_CAR[trida] || 2.5;
    const casti = g.type === 'LineString' ? [g.coordinates]
      : (g.type === 'MultiLineString' ? g.coordinates : null);
    if (!casti) return;
    for (const linie of casti) {
      for (let i = 1; i < linie.length; i++) {
        const ax = linie[i - 1][0], ay = linie[i - 1][1];
        const bx = linie[i][0], by = linie[i][1];
        const ex = w / (111320 * Math.cos(ay * Math.PI / 180)), ey = w / 111320;
        kam.push({ ax, ay, bx, by, w,
                   x0: Math.min(ax, bx) - ex, x1: Math.max(ax, bx) + ex,
                   y0: Math.min(ay, by) - ey, y1: Math.max(ay, by) + ey });
      }
    }
  }

  function doMrizkyCara(mrizka, u) {
    const gx0 = Math.floor(u.x0 / MRIZKA_CAR), gx1 = Math.floor(u.x1 / MRIZKA_CAR);
    const gy0 = Math.floor(u.y0 / MRIZKA_CAR), gy1 = Math.floor(u.y1 / MRIZKA_CAR);
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const k = gx + ':' + gy;
        const a = mrizka.get(k);
        if (a) a.push(u); else mrizka.set(k, [u]);
      }
    }
  }

  function naCare(lon, lat) {
    if (!idxCary) return false;
    const useky = idxCary.get(Math.floor(lon / MRIZKA_CAR) + ':'
                              + Math.floor(lat / MRIZKA_CAR));
    if (!useky) return false;
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 111320;
    for (let i = 0; i < useky.length; i++) {
      const u = useky[i];
      if (lon < u.x0 || lon > u.x1 || lat < u.y0 || lat > u.y1) continue;
      const dx = (u.bx - u.ax) * kx, dy = (u.by - u.ay) * ky;
      const px = (lon - u.ax) * kx, py = (lat - u.ay) * ky;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? (px * dx + py * dy) / l2 : 0;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      const ddx = px - t * dx, ddy = py - t * dy;
      if (ddx * ddx + ddy * ddy < u.w * u.w) return true;
    }
    return false;
  }

  /// Index ploch se staví nejvýš jednou za průchod `dopln` (líně – až když
  /// ho někdo potřebuje: netknutá buňka, přesné dekorace nebo prořez).
  let passId = 0;
  let indexPass = -1;
  let indexKamera = '';
  let indexDlazdiceHotovy = false;
  let indexCas = 0;
  const casy = { index: [], dopln: [] };
  function zapisCas(klic, ms) {
    const a = casy[klic];
    a.push(+ms.toFixed(1));
    if (a.length > 12) a.shift();
  }
  /// ⭐ engine 201: index se NESTAVÍ 5× po každém zastavení (19–44 ms kus,
  /// změřeno Ústí z16,5), ale jen když se od minula pohnula kamera, dojely
  /// dlaždice (`areTilesLoaded` false → true) nebo uplynulo 2,5 s.
  function zajistiIndex() {
    if (indexPass === passId) return;
    indexPass = passId;
    let kamera = '';
    let hotovo = false;
    try {
      const c = mapa.getCenter();
      kamera = mapa.getZoom().toFixed(2) + '|' + c.lng.toFixed(5) + '|' + c.lat.toFixed(5);
      hotovo = !!mapa.areTilesLoaded();
    } catch (e) { /* mapa se zrovna mění */ }
    const ted = performance.now();
    if (idxMrizka && kamera === indexKamera
        && (hotovo === indexDlazdiceHotovy || !hotovo)
        && ted - indexCas < 2500) return;
    indexKamera = kamera;
    indexDlazdiceHotovy = hotovo;
    indexCas = ted;
    const t0 = performance.now();
    try { postavIndex(); } catch (e) {
      console.warn('[dekorace] index se nepostavil:', e);
      idxMrizka = null;
      idxCary = null;
      idxBudovy = null;
    }
    zapisCas('index', performance.now() - t0);
  }

  /// ⭐ 5. 9. noc: PROŘEZ – dekorace postavené dřív (z hrubších dlaždic bez
  /// malých domů, nebo před touto verzí) se v půdorysu domu / na silnici
  /// zahodí a buňka se zamkne. Běží ve 2. (500 ms) a 5. (5 s) průchodu po
  /// zastavení mapy, jen od z14,5 a jen s dlaždicemi z14 v indexu.
  let prorezPass = -1;
  let prorezKolo = 0;
  let presnePass = -1;
  let presneKoloN = 0;
  function presneKolo() {
    if (presnePass !== posledniPass) { presnePass = posledniPass; presneKoloN = 0; }
    presneKoloN++;
    return presneKoloN === 1 || presneKoloN === 3 || presneKoloN >= 5;
  }
  function prorez(z, x0, x1, y0, y1) {
    if (prorezPass !== posledniPass) { prorezPass = posledniPass; prorezKolo = 0; }
    prorezKolo++;
    if (z < 15 || (prorezKolo !== 2 && prorezKolo !== 5)) return false;
    // engine 202: index se NEVYNUCUJE – prořez běží jen s indexem, který
    // v tomto průchodu postavily nové buňky (v prozkoumané krajině nic)
    if (indexPass !== passId) return false;
    if (!idxMrizka || !idxZoomy.length || idxZoomy[0] < 14) return false;
    let zmena = false;
    for (const [klic, f] of bunky) {
      if (!f || f.properties.sv || f.properties.ik.startsWith('deko-stricha')) continue;
      const c = f.geometry.coordinates;
      if (c[0] < x0 || c[0] > x1 || c[1] < y0 || c[1] > y1) continue;
      const q = plochyPodBodem(c[0], c[1]);
      if ((q && q.indexOf('budovy-vypln') >= 0) || naCare(c[0], c[1])) {
        bunky.set(klic, null);
        zmena = true;
      }
    }
    return zmena;
  }

  /// ⭐ 5. 9. noc: PŘESNÉ DEKORACE ZE ZABAGED („dávej pozor, kde jsou
  /// stromy a další objekty"). Osamělé stromy a lesíky, balvany a
  /// stromořadí (aleje) stojí tam, kde skutečně jsou – vrstvy `body`/`cary`
  /// dlaždic krajina2.pmtiles. Dedup klíčem souřadnic (body) / 8 m buňkou
  /// (aleje), nic v mlze, nic na střeše ani na silnici; nejvýš 600 kusů na
  /// průchod, aleje až od z14,6 (počet).
  const ALEJ_ROZESTUP = 13;
  const ALEJ_OD_Z = 14.6;
  const PRESNE_MAX = 600;
  function presneDekorace(z, x0, x1, y0, y1) {
    if (z < 13.2 || !mapa || !mapa.getSource('krajina')) return false;
    let n = 0;
    let pridano = false;
    const objeveno = (lon, lat) => {
      if (typeof Mlha === 'undefined' || !Mlha
          || typeof Mlha.jeObjeveno !== 'function') return true;
      try { return Mlha.jeObjeveno(lon, lat); } catch (e) { return true; }
    };
    // ⭐ engine 202: NEJDŘÍV kandidáti (klíč, mlha, výřez) BEZ indexu – v už
    // prozkoumané krajině žádní nejsou a index se nestaví (dřív se stavěl
    // po každém zastavení = 20–40 ms jank). Index až pro skutečné nováčky.
    const kandidati = [];
    let body = [];
    try {
      body = mapa.querySourceFeatures('krajina', { sourceLayer: 'body', validate: false });
    } catch (e) { body = []; }
    for (let i = 0; i < body.length && kandidati.length < PRESNE_MAX; i++) {
      const f = body[i];
      const t = f.properties && f.properties.t;
      if (t !== 'strom' && t !== 'balvan') continue;
      let c = null;
      try { c = f.geometry && f.geometry.coordinates; } catch (e) { continue; }
      if (!c || c[0] < x0 || c[0] > x1 || c[1] < y0 || c[1] > y1) continue;
      const klic = 'zb:' + t + ':' + c[0].toFixed(5) + ',' + c[1].toFixed(5);
      if (bunky.has(klic)) continue;
      if (!objeveno(c[0], c[1])) continue;
      kandidati.push({ klic, lon: c[0], lat: c[1], t, lesik: f.properties.s === 'L' });
    }
    if (z >= ALEJ_OD_Z) {
      let cary = [];
      try {
        cary = mapa.querySourceFeatures('krajina', {
          sourceLayer: 'cary', filter: ['==', ['get', 't'], 'stromoradi'], validate: false });
      } catch (e) { cary = []; }
      const D = ALEJ_ROZESTUP;
      for (let i = 0; i < cary.length && kandidati.length < PRESNE_MAX; i++) {
        let g = null;
        try { g = cary[i].geometry; } catch (e) { continue; }
        if (!g) continue;
        const casti = g.type === 'LineString' ? [g.coordinates]
          : (g.type === 'MultiLineString' ? g.coordinates : null);
        if (!casti) continue;
        for (const linie of casti) {
          let zbytek = D / 2;
          for (let j = 1; j < linie.length && kandidati.length < PRESNE_MAX; j++) {
            const ax = linie[j - 1][0], ay = linie[j - 1][1];
            const bx = linie[j][0], by = linie[j][1];
            const kx = 111320 * Math.cos(ay * Math.PI / 180), ky = 111320;
            const dx = (bx - ax) * kx, dy = (by - ay) * ky;
            const delka = Math.sqrt(dx * dx + dy * dy);
            if (delka < 0.01) continue;
            let sD = zbytek;
            while (sD <= delka) {
              const lon = ax + (bx - ax) * sD / delka;
              const lat = ay + (by - ay) * sD / delka;
              sD += D;
              if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
              const gx = Math.floor(lon * kx / 8), gy = Math.floor(lat * ky / 8);
              const klic = 'zc:' + gx + ':' + gy;
              if (bunky.has(klic)) continue;
              if (!objeveno(lon, lat)) continue;
              kandidati.push({ klic, lon, lat, t: 'alej', gx, gy });
            }
            zbytek = sD - delka;
          }
        }
      }
    }
    if (!kandidati.length) return false;
    zajistiIndex();
    // true = volno, false = střecha/silnice, null = dlaždici ještě nemám
    const volno = (lon, lat) => {
      const q = plochyPodBodem(lon, lat);
      if (!q) return null;
      if (q.indexOf('budovy-vypln') >= 0) return false;
      return !naCare(lon, lat);
    };
    const pridej = (klic, lon, lat, ikona, k, z0) => {
      bunky.set(klic, {
        type: 'Feature',
        properties: { ik: ikona, k, rot: 0, ...nastup(z0) },
        geometry: { type: 'Point', coordinates: [lon, lat] },
      });
      pocetFeatur++; n++; pridano = true;
    };
    const listnaty = (a, b) => STROMY_LISTNATE[
      Math.floor(hash(a, b, 5) * STROMY_LISTNATE.length)];
    for (const kd of kandidati) {
      if (n >= PRESNE_MAX) break;
      const v = volno(kd.lon, kd.lat);
      if (v === null) continue;
      if (v === false) { bunky.set(kd.klic, null); continue; }
      if (kd.t === 'alej') { pridej(kd.klic, kd.lon, kd.lat, listnaty(kd.gx, kd.gy), 0.85, 12.8); continue; }
      const a = Math.round(kd.lon * 1e5), b = Math.round(kd.lat * 1e5);
      if (kd.t === 'balvan') {
        pridej(kd.klic, kd.lon, kd.lat, 'deko-kamen-' + (1 + Math.floor(hash(a, b, 6) * 3)), 0.4, 14.2);
        continue;
      }
      pridej(kd.klic, kd.lon, kd.lat, listnaty(a, b), kd.lesik ? 1.0 : 1.15, 12.8);
      if (kd.lesik) {
        const kx = 111320 * Math.cos(kd.lat * Math.PI / 180), ky = 111320;
        pridej(kd.klic + ':2', kd.lon + 9 / kx, kd.lat + 4 / ky, listnaty(a + 1, b), 0.95, 12.8);
        pridej(kd.klic + ':3', kd.lon - 7 / kx, kd.lat + 8 / ky, listnaty(a, b + 1), 0.9, 12.8);
      }
    }
    return pridano;
  }

  function vyskovyFaktor(lon, lat) {
    try {
      const v = mapa.queryTerrainElevation && mapa.queryTerrainElevation([lon, lat]);
      if (typeof v !== 'number' || !isFinite(v)) return null;
      return +Math.max(0.9, Math.min(1.35, 1 + (v - 400) / 3000)).toFixed(3);
    } catch (e) { return null; }
  }

  function dopln() {
    const t0 = performance.now();
    try { doplnJadro(); } finally { zapisCas('dopln', performance.now() - t0); }
  }
  function doplnJadro() {
    if (!mapa || !ikonyHotove) return;   // malby se ještě stahují
    const z = mapa.getZoom();
    // ⚠️ MUSÍ SEDĚT S NEJNIŽŠÍM `z0` V `DRUHY` (stromy 13,25 = 54 %
    // ukazatele) A S `minzoom` VRSTVY. Když tu zůstane vyšší číslo, jsou
    // prahy druhů mrtvé písmeno a stromy prostě nikdy nenastoupí —
    // přesně tak tu 8. 8. přežilo 14,0 proti stromům od 13,25.
    if (z < 13.2) return;            // objekty ještě nejsou na scéně
    const hranice = mapa.getBounds();
    const zapad = hranice.getWest();
    const vychod = hranice.getEast();
    const jih = hranice.getSouth();
    const sever = hranice.getNorth();
    // rezerva půl obrazovky — nové body vznikají MIMO obraz
    const rw = (vychod - zapad) * 0.5;
    const rh = (sever - jih) * 0.5;
    let pridano = false;

    // Index ploch se staví LÍNĚ — až když opravdu přijde na řadu první
    // netknutá buňka. Průchod s plnou keší (a těch je většina: čtyři
    // dosypy po každém zastavení) tak nestojí vůbec nic.
    passId++;
    for (const [druh, cfg] of Object.entries(DRUHY)) {
      if (z < cfg.z0 - 0.4) continue;
      // v1.592 rostla v Dobyvateli světla sídel a kotvy roje —
      // v1.599 (přání 2. 9. večer) v Dobyvateli NIC: bojiště je bez
      // dekorací, v noci místo světel oken září vlajky (dobyvatel.js)
      if (typeof STYLY !== 'undefined'
          && typeof aktualniKod !== 'undefined'
          && STYLY[aktualniKod] && !STYLY[aktualniKod].mlha) continue;
      // v1.424: sezónní druhy — „pole jsou v zimě prázdná a zoraná“
      if (cfg.sezony && !cfg.sezony.includes(sezonaMalby())) continue;
      // v dálce jen sudé buňky = původní rozestup (viz Z_JEMNE)
      const hrube = cfg.zjemnit && z < Z_JEMNE;
      const dLat = cfg.rozestup / 111320;
      const iy0 = Math.floor((jih - rh) / dLat);
      const iy1 = Math.ceil((sever + rh) / dLat);
      for (let iy = iy0; iy <= iy1; iy++) {
        if (hrube && (iy & 1)) continue;
        const lat = iy * dLat;
        const dLon = cfg.rozestup
          / (111320 * Math.cos(lat * Math.PI / 180));
        const ix0 = Math.floor((zapad - rw) / dLon);
        const ix1 = Math.ceil((vychod + rw) / dLon);
        for (let ix = ix0; ix <= ix1; ix++) {
          if (hrube && (ix & 1)) continue;
          const klic = druh + ':' + iy + ':' + ix;
          if (bunky.has(klic)) continue;
          // řídkost + jitter deterministicky z mřížky
          if (hash(ix, iy, 7) > cfg.hustota) {
            bunky.set(klic, null);
            continue;
          }
          const lon = (ix + 0.2 + hash(ix, iy, 1) * 0.6) * dLon;
          const latB = (iy + 0.2 + hash(ix, iy, 2) * 0.6) * dLat;
          // ⛔⛔ TADY BYL TEST „JE BOD NA OBRAZOVCE?" PŘES `mapa.project()`
          // A ZABÍJEL DEKORACE (nalezeno měřením 8. 8. 2026).
          // Se zapnutým terénem promítá MapLibre bod NA POVRCH KOPCŮ, ne
          // na nulovou hladinu — a při náklonu ho to vytlačí vzhůru.
          // Změřeno na telefonu (z15,6, náklon 42°, obrazovka 360×500):
          //   mapa.project(mapa.getCenter())  →  y = 1 px   (má být 250!)
          //   rozsah projekce kandidátů: y ∈ ⟨−11402, 2591⟩ px
          // Test tedy prohlásil skoro celý výřez za „mimo obrazovku":
          // ze 114 kandidátů na stromy jich prošlo **10** a v lese z nich
          // ležel JEDEN. Odtud „stále nejsou vidět stromy, kameny, keře".
          // ⚠️ NEVRACET ANI V OPRAVENÉ PODOBĚ. Poctivý test by musel znát
          // skutečně viditelnou plochu, a ta se zjistí jen `unproject`em
          // rohů — což je s terénem `pointCoordinate` → **gl.readPixels**,
          // tedy přesně to synchronní čtení z GPU, kvůli kterému se odsud
          // dotazy do GPU 7. 8. vyhazovaly. A hlavně je zbytečný: smyčka
          // sama běží jen přes buňky ve `výřezu ± půl obrazovky`, takže
          // geografický filtr už proběhl o dvě úrovně výš.
          // ⭐ V MLZE SE DEKORACE NEGENERUJÍ (7. 8. 2026, dohodnuto).
          // Dřív vznikaly všude a mlha je zakrývala – jenže kvůli tomu
          // musela vrstva ležet POD mlhou, a protože je to jediný SYMBOL
          // uprostřed drapovaných vrstev, rozřezávala drapování na dva
          // „stacky" (= dvojnásobek textur na terénní dlaždici a snímek).
          // Bez dekorací v mlze může vrstva nad mlhu → jeden stack.
          // Je to i logičtější: v neodkryté krajině nemá co růst.
          // ⚠️ Buňka se NEUKLÁDÁ do keše, aby se po odkrytí zkusila znovu.
          if (typeof Mlha !== 'undefined' && Mlha
              && typeof Mlha.jeObjeveno === 'function') {
            var odkryto = true;
            try { odkryto = Mlha.jeObjeveno(lon, latB); } catch (e) {}
            if (!odkryto) continue;
          }
          // patří bod do plochy? (vrstvy barevného patra stylu — čte se
          // z načtených dlaždic, viz „PLOCHY Z NAČTENÝCH DLAŽDIC" výš)
          // ⛔ POJISTKA KOLEM CELÉHO PRŮCHODU. Uvnitř se čte geometrie
          // z dlaždic, které MapLibre může kdykoli zahodit, a hodí pak
          // „feature index out of bounds". Jednotlivá místa jsou ošetřená,
          // ale ať odsud nemůže uniknout nic: nezachycená výjimka
          // v obsluze události spolkne `moveend` se vším, co na něm visí
          // (viz poznámka u `pitchend` v main.js). Bez indexu se dekorace
          // jen na tenhle průchod nedokreslí a zkusí se to znovu.
          zajistiIndex();
          const q = plochyPodBodem(lon, latB);
          if (!q) continue;         // dlaždice tu není → zkusí se příště
          // ⭐⭐ NA VODU SE SOUŠ NESTAVÍ (9. 8. 2026).
          // Uživatel: *„Bažantník v Sedmihorkách má na ploše rybníku
          // strom."* Není to chyba mřížky — je to chyba v datech krajiny:
          // lesní polygon v OSM se běžně táhne PŘES rybník (nemá v sobě
          // díru), takže bod projde testem „je v lese" a přistane na
          // hladině. Totéž umí louka kolem rybníčku.
          // Voda je od téhle verze v indexu (kvůli rybníkům), takže se dá
          // použít jako ZÁKAZ — a je to skoro zadarmo, `q` už je spočítané.
          // ⚠️ Platí i pro `voda-velka` (přehrady, koryta řek), proto se
          // testuje předpona.
          if (!cfg.naVode) {
            let mokro = false;
            for (let vi = 0; vi < q.length; vi++) {
              if (q[vi] === 'voda' || q[vi] === 'voda-velka') { mokro = true; break; }
            }
            if (mokro) {
              bunky.set(klic, null);   // tady prokazatelně nic neroste
              continue;
            }
          }
          // ⭐ 5. 9. noc: NIC NA STŘECHÁCH A SILNICÍCH („dávej pozor, kde
          // jsou stromy"): budovy jsou v indexu jako zákaz, silnice jako
          // čáry se šířkou podle třídy. Světla oken na domech zůstávají.
          if (druh !== 'svetlo'
              && (q.indexOf('budovy-vypln') >= 0 || naCare(lon, latB))) {
            bunky.set(klic, null);
            continue;
          }
          let uvnitr = false;
          for (let vi = 0; vi < cfg.vrstvy.length; vi++) {
            if (q.indexOf(cfg.vrstvy[vi]) >= 0) { uvnitr = true; break; }
          }
          if (!uvnitr) {
            bunky.set(klic, null);  // tady prokazatelně nic neroste
            continue;
          }
          // strom podle druhu lesa pod bodem (ZABAGED); jinde celá směs
          let ikony = cfg.ikony;
          if (druh === 'strom' && q) {
            if (q.indexOf('les-jehlicnaty') >= 0) ikony = STROMY_JEHLICNATE;
            else if (q.indexOf('les-listnaty') >= 0 || q.indexOf('sad') >= 0) {
              ikony = STROMY_LISTNATE;   // sady = ovocné (listnaté) stromy
            }
          }
          const ikona = ikony[Math.floor(hash(ix, iy, 3) * ikony.length)];
          // světla a světlušky: číselné id pro feature-state (mihotání)
          const svDruh = druh === 'svetlo' ? 1
              : (druh === 'svetluska' ? 2 : 0);
          const ev = vyskovyFaktor(lon, latB);
          bunky.set(klic, {
            type: 'Feature',
            ...(svDruh ? { id: ((ix * 92821 + iy * 31397 + svDruh * 7451)
                                >>> 0) } : {}),
            properties: {
              ik: ikona,
              k: cfg.k,
              ...(ev != null ? { ev } : {}),
              ...(svDruh ? { sv: svDruh } : {}),
              rot: druh === 'stricha'
                ? Math.round((hash(ix, iy, 4) - 0.5) * 70) : 0,
              // ⭐ RYCHLÝ A STEJNÝ NÁSTUP PRO VŠECHNY DRUHY (9. 8. 2026).
              // Uživatel: *„to jejich objevování ať probíhá rychleji.
              // Kolikrát jsou některé obrázky stromů napůl vidět a jiné
              // už jsou vidět dávno."* Dřív měl každý druh vlastní dvojici
              // hodnot na dvou pevných zoomech, takže se nastupovalo
              // rozházeně a dlouho.
              // ⚠️ PROČ TAKHLE NEOHRABANĚ: `["zoom"]` smí být JEN vstupem
              // vrchního `interpolate`/`step`, takže se nedá napsat
              // `(zoom − z0) / šířka`. Rampa se proto předpočítá do čtyř
              // hodnot na pevných zoomech (viz `RAMPA` u vrstvy) a každý
              // druh si v nich nese svůj vlastní náběh podle svého `z0`.
              ...nastup(cfg.z0),
            },
            geometry: { type: 'Point', coordinates: [lon, latB] },
          });
          pocetFeatur++;
          pridano = true;
        }
      }
    }

    // přesné dekorace ze ZABAGED a prořez střech/silnic (5. 9. noc)
    try {
      // engine 202: jen 1., 3. a 5. průchod po zastavení (procházení alejí
      // v načtených dlaždicích není zadarmo)
      if (presneKolo() && presneDekorace(z, zapad - rw, vychod + rw, jih - rh, sever + rh)) pridano = true;
    } catch (e) { console.warn('[dekorace] přesné:', e); }
    try {
      if (prorez(z, zapad - rw, vychod + rw, jih - rh, sever + rh)) pridano = true;
    } catch (e) { console.warn('[dekorace] prořez:', e); }

    if (pridano) {
      // ROZPOČET VÝKONU: zdroj se drží malý (setData přeparsovává celou
      // kolekci — nesmí růst s délkou toulání). Daleké buňky se zapomenou
      // a při návratu se spočítají znovu ÚPLNĚ STEJNĚ (deterministický
      // hash) — pozice tím nikdy neutrpí.
      if (pocetFeatur > 7000 || bunky.size > 25000) {
        pocetFeatur = 0;
        for (const [klic, f] of bunky) {
          if (!f) { bunky.delete(klic); continue; }
          const [lonF, latF] = f.geometry.coordinates;
          if (lonF < zapad - 2 * rw || lonF > vychod + 2 * rw
              || latF < jih - 2 * rh || latF > sever + 2 * rh) {
            bunky.delete(klic);
          } else {
            pocetFeatur++;
          }
        }
      }
      const featury = [];
      let evDoplneno = 0;
      for (const f of bunky.values()) {
        // stricha v keši může přežívat z dřívějška v běžící stránce
        if (f && !f.properties.ik.startsWith('deko-stricha')) {
          // výškový faktor doplnit, když při zrození terén ještě nebyl
          if (f.properties.ev === undefined && evDoplneno < 400) {
            const ev = vyskovyFaktor(f.geometry.coordinates[0],
                                     f.geometry.coordinates[1]);
            if (ev != null) { f.properties.ev = ev; evDoplneno++; }
          }
          featury.push(f);
        }
      }
      // evidence světel pro animátor mihotání (v1.385)
      svetlaEvidence = featury.filter((f) => f.properties.sv);
      // ⭐ v1.399: souradnice oken pro DÍRY v nočním překryvu (main.js)
      try {
        window.__svetlaBody = svetlaEvidence
            .filter((f) => f.properties.sv === 1)
            .map((f) => f.geometry.coordinates);
        if (window.__nocniDiry) window.__nocniDiry();
      } catch (e) { /* nevadí */ }
      const kolekce = { type: 'FeatureCollection', features: featury };
      const zdroj = mapa.getSource('dekorace');
      if (zdroj) {
        // ⛔⛔ NEZAPISOVAT, KDYŽ SE NIC NEZMĚNILO (6. 8. 2026, hon na
        // sekání). Se ZAPNUTÝM TERÉNEM je `setData` mimořádně drahé:
        // vyvolá per-dlaždici událost `data`, na kterou MapLibre zahodí
        // DRAPOVACÍ TEXTURY (1024² na každou terénní dlaždici) – a celý
        // podklad včetně stínování se musí vykreslit znovu. Přesně to
        // uživatel popsal jako „na kopcích je vidět, jak se po posunu
        // barvy přepočítávají".
        // A dosyp po `moveend` běží 4× (500/1200/2500/5000 ms), takže se
        // to dělo ještě několik vteřin po zastavení prstu, i když už
        // dávno nepřibyla ani jedna dekorace.
        const podpis = featury.length + ':' + posledniPodpis(featury);
        if (podpis !== dekoracePodpis) {
          dekoracePodpis = podpis;
          // ⚡ zápis až v klidu (zapisAzVKlidu v main.js): během gesta
          // by shodil drapovací textury; dávky se slévají na poslední
          if (typeof zapisAzVKlidu === 'function') {
            zapisAzVKlidu('deko', () => zdroj.setData(kolekce));
          } else {
            zdroj.setData(kolekce);
          }
        }
      } else if (featury.length) {
        pridejVrstvu(kolekce);       // líné založení s prvními daty
      }
    }
  }

  // Dlaždice nové oblasti stojí až chvíli PO moveend a událost `idle`
  // v herním stylu NIKDY nepřijde (mraky + mlha překreslují mapu každý
  // snímek, mapa se neusadí — 7. 8., třetí kolo „pořád jen 3 stromy").
  // Dosyp odložených buněk proto jede dávkou časovaných opakování;
  // průchody s plnou keší jsou skoro zadarmo, takže dávka nebolí.
  // Otisk poslední odeslané sestavy dekorací (viz `setData` výš).
  let dekoracePodpis = '';

  /// Levný otisk sestavy: počet + souřadnice prvního a posledního prvku.
  /// Dekorace se rodí po buňkách, takže když přibude nebo ubude bod,
  /// změní se délka nebo krajní prvek – na rozhodnutí „psát/nepsat" to
  /// stačí a projít tisíce prvků nemusíme.
  function posledniPodpis(f) {
    if (!f.length) return '';
    const a = f[0].geometry.coordinates;
    const b = f[f.length - 1].geometry.coordinates;
    return a[0].toFixed(4) + ',' + a[1].toFixed(4) + '|'
        + b[0].toFixed(4) + ',' + b[1].toFixed(4);
  }

  let dosypT = [];
  function naplanujDosyp() {
    for (const t of dosypT) clearTimeout(t);
    dosypT = [500, 1200, 2500, 5000].map((ms) => setTimeout(dopln, ms));
  }

  function registrujHooky() {
    if (hooky || !mapa) return;
    hooky = true;
    // ⛔⛔ ZA POHYBU SE DEKORACE NEDOPLŇUJÍ (7. 8. 2026, nalezeno
    // PROFILEREM). `dopln()` tehdy stálo na `queryRenderedFeatures` NA
    // KAŽDOU kandidátní buňku – a se zapnutým terénem to uvnitř knihovny
    // znamenalo `unproject` → `pointCoordinate` → **`gl.readPixels`**,
    // tedy SYNCHRONNÍ ČTENÍ Z GPU, které zastaví celou frontu.
    // Naměřeno: `readPixels` = **21,2 % veškerého času** při panování
    // (nejtěžší položka profilu, víc než celý zbytek MapLibre), z toho
    // 195 volání za čtyři tahy prstem šlo právě odsud.
    // Dekorace se proto doplňují až po zastavení (`moveend` + dosyp) –
    // což je mimochodem přesně to „domalovávání po zastavení", které
    // uživatel navrhoval. Tady je zadarmo, protože práci UBÍRÁ.
    // ZMĚŘENO 7. 8. 2026 (counterbalanced A,B,B,A, z14, terén):
    //   dekorace po zastavení … 34 a 33 fps, nejhorší snímek 10 a 14
    //   dekorace za pohybu ..... 31 a 29 fps, nejhorší snímek  8 a  5
    // Průměr je na hraně rozptylu (~3,5 fps), ale NEJHORŠÍ SNÍMEK se
    // půlí – tedy přesně ty záškuby.
    // ⚠️ I když dotaz do GPU už tady není (viz `postavIndex`), zůstává
    // `dopln()` průchod přes tisíce buněk – nevracet `mapa.on('move', …)`
    // bez profilu.
    mapa.on('moveend', () => {
      posledniPass = performance.now();
      dopln();
      naplanujDosyp();
    });
    // po odkrytí mlhy dosypat – čerstvě odkryté území by jinak zůstalo
    // holé až do dalšího posunu mapy (dekorace v mlze nevznikají)
    if (typeof Mlha !== 'undefined' && Mlha
        && typeof Mlha.priObjeveni === 'function') {
      try { Mlha.priObjeveni(function () { naplanujDosyp(); }); }
      catch (e) { /* mlha ještě neběží */ }
    }
  }

  // Volat po style.load herního stylu (aplikujDoplnky); opakovaně OK.
  // Body v keši přežívají výměnu stylu — zdroj se založí rovnou s nimi
  // (líně; prázdný zdroj ze style.load byl sterilní, viz pridejVrstvu).
  function pripoj(map) {
    mapa = map;
    ikonyHotove = false;      // atlas je po výměně stylu prázdný
    // Nový styl = jiné filtry ploch (les v Kronice ≠ les jinde), takže
    // definice i převedené polygony do koše. Dlaždice samotné v MapLibre
    // zůstávají, převede se z nich jen to, co bude znovu potřeba.
    plochyDef = null;
    kesDlazdic.clear();
    idxMrizka = null;
    nactiMalby();             // async; dopln čeká na ikonyHotove
    registrujHooky();
    const featury = [];
    for (const f of bunky.values()) {
      if (f && !f.properties.ik.startsWith('deko-stricha')) {
        featury.push(f);
      }
    }
    if (featury.length) {
      pridejVrstvu({ type: 'FeatureCollection', features: featury });
    }
    naplanujDosyp();          // až se plochy stylu vykreslí
  }

  // ⭐ HÁK NA OVĚŘENÍ UMÍSTĚNÍ (nechat!). Tímhle se dá kdykoli — i na
  // telefonu přes CDP — proti sobě postavit STARÁ cesta (dotaz do GPU)
  // a NOVÁ (zdrojové dlaždice) a spočítat, jak často se liší:
  //
  //   Dekorace._ladeni.postavIndex();
  //   const px = mapa.project([lon, lat]);
  //   mapa.queryRenderedFeatures([px.x, px.y], {layers:['les','louka','pole']});
  //   Dekorace._ladeni.plochyPodBodem(lon, lat);
  //
  // Změřeno 7. 8. 2026 (Rtyně, z15,4, náklon 42°, terén, ostrá data ČR):
  // 2567 bodů, shoda 99,03 %; VŠECH 25 rozdílů leželo do 1,31 m od hrany
  // polygonu — tam se starý dotaz mýlí sám (zpětný průmět přes terén bod
  // posouvá; u jednoho stromu v dálce dokonce o 41 m).
  return { pripoj, nastavStin, _ladeni: { postavIndex, plochyPodBodem, dopln, casy: () => casy,
    stav: () => ({ kes: kesDlazdic.size, mrizka: idxMrizka && idxMrizka.size,
                   velke: idxVelke.length, zoomy: idxZoomy, zCil: idxZCil,
                   dlazdic: idxDlazdice && idxDlazdice.size }) } };
})();
