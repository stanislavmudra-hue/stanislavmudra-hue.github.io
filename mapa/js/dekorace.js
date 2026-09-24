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
      rozestup: 40,               // m mezi kandidáty (NEJJEMNĚJŠÍ, viz Z_JEMNE)
                                  // v1.419: 70→62 („hustší lesy“)
                                  // ⭐ engine 340 (23. 9. 2026, „udělej stromy 2×“):
                                  // 62 → 44 m = 2× stromů (62/√2). Zátěžový test na TT:
                                  // ×2 bez měřitelného zhoršení, ×3 na hraně (viz
                                  // PLAN 150. kolo) – dál jen s měřením
                                  // engine 341 („ještě přidej malinko stromů“): 44 → 40 m
                                  // (+21 %, celkem ×2,4 proti 62 m)
      zjemnit: true,
      vrstvy: ['les'],              // sady a zahrady mají vlastní druh `ovocny`
      // ⭐ 8. 8. 2026: „stromy ať se ukazují už od zoomu 54 %".
      // Ukazatel v appce je `(zoom − 6,5) / 12,5`, takže 54 % = **z13,25**
      // (dřív 14,4 ≈ 63 %). ⚠️ Víc stromů z dálky = víc symbolů a kolizí;
      // kdyby to bolelo, tohle je první číslo, které jde zpět nahoru.
      // 29. 8.: „dlouho trvalo, než se objevily stromy" → dřív
      z0: 12.8,
      // 10 stromů ze sezónních listů (dvě řady po pěti) + engine 218
      // (6. 9. 2026 odpoledne, list od uživatele, tools/dekorace_stromy_rez.py):
      // 11 dub, 12 javor, 13 bříza, 14 modřín, 15 borovice, 16 vrba,
      // 17 javor červený, 19 topol, 20 borovice vysoká, 22 jedle, 25 jeřáb
      // (18 jabloň, 21 třešeň, 23 hloh, 24 túje jsou ovocné/zahradní)
      ikony: ['deko-strom-1', 'deko-strom-2', 'deko-strom-3',
              'deko-strom-4', 'deko-strom-5', 'deko-strom-6',
              'deko-strom-7', 'deko-strom-8', 'deko-strom-9',
              'deko-strom-10', 'deko-strom-11', 'deko-strom-12',
              'deko-strom-13', 'deko-strom-14', 'deko-strom-15',
              'deko-strom-16', 'deko-strom-17', 'deko-strom-19',
              'deko-strom-20', 'deko-strom-22', 'deko-strom-25'],
      k: 1.15,                    // 5. 9. večer: k = podíl výšky stromu (~25 m)
      hustota: 0.70,              // v1.425: 0,70→0,56 („uber o 20 %“); 18. 9. 2026 zpět 0,70 („přidej více stromů“)
    },
    // ⭐ 5. 9. noc: OVOCNÉ STROMY v sadech a zahradách (ZABAGED v2) – menší
    // než lesní strom, hustě (zahrada u domu mívá pár stromů). Dřív byly
    // zahrady v „sadu" a nesly stromy lesní velikosti přes střechy.
    ovocny: {
      rozestup: 26,               // engine 340: 40 → 28 m = 2×, engine 341: 26 m (+16 %)
      zjemnit: true,
      vrstvy: ['sad', 'zahrada'],
      z0: 15.4,                   // engine 202: 14,6 → 15,4 (kandidátů 40 m bylo moc)
      // engine 218: + jabloň 18, třešeň 21 (na jaře kvete), hloh 23, túje 24
      ikony: ['deko-strom-1', 'deko-strom-2', 'deko-strom-3',
              'deko-strom-4', 'deko-strom-5', 'deko-strom-18',
              'deko-strom-21', 'deko-strom-23', 'deko-strom-24'],
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
      rozestup: 72,               // engine 264 („louky více květnaté"): 100 → 72 m
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
      hustota: 0.8,               // engine 264: 0,62 → 0,8
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
    // ⭐ engine 340 (animace nad mapou): KOTVY NA VODĚ pro kroužky od ryb.
    // Nekreslí se jako dekorace – `sv:4` jde jen do evidence (přes mlhu, jen
    // objevené), body uvnitř vodních ploch; kreslí je animace.js. Ve starém
    // generátoru (záloha) se přeskakují (`kotva`). Ikona jen formálně.
    ryba: {
      kotva: true,
      sv: 4,
      rozestup: 70,
      zjemnit: true,
      vrstvy: ['voda'],
      naVode: true,
      z0: 14.8,
      ikony: ['svetluska-zare'],
      k: 0,
      hustota: 0.5,
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
  const RAMPA_ZAKLAD = [13.2, 13.55, 13.9, 14.25, 14.6, 14.95, 15.3, 15.65];
  // engine 321: DOHLED – posun všech prahů dekorací o `DZ` (main.js dohledDz()):
  // rampa nástupu, minzoom vrstvy i brány generování. Rampa je pole, které se
  // přepočítá v `nastavDohled`, aby výrazy níž nemusely znát nic dalšího.
  let DZ = (typeof window.dohledDz === 'function') ? window.dohledDz() : 0;
  let RAMPA = RAMPA_ZAKLAD.map((z) => z - DZ);
  // Jak široký (v zoomu) je náběh z nuly do plné viditelnosti. 0,35 je
  // zhruba půl štípnutí — „rychleji", jak si uživatel přál.
  const SIRKA_NASTUPU = 0.35;
  // ⭐ engine 349: zarážky NAD z15,65 pro drobnosti, které nastupují až zblízka (lavička, schránka,
  // studna; o11–o14 posílá worker jen jim – ostatním coalesce vrátí o8)
  const RAMPA_VYS_ZAKLAD = [16.0, 16.35, 16.7, 17.05];
  let RAMPA_VYS = RAMPA_VYS_ZAKLAD.map((z) => z - DZ);
  // ⭐ engine 349 (přání T 23. 9. 2026: „lampy, posedy, krmelce, lavičky, studny a poštovní schránky“):
  // DROBNOSTI SE ZNÁMOU POLOHOU z OpenStreetMap (archiv drobnosti1.pmtiles na R2, ODbL – samostatně,
  // nesloučeno se ZABAGED; tools/drobnosti_osm_export.py). Kreslí je worker jako stromy (mlha, rampa,
  // měřítko světa). Výška v metrech = 0,1167 × výška obrázku (px @2) × k; stylizované větší než
  // skutečnost (jako sovy a ptáci), z0 = zoom, kde mají ~5 px. Lampa v noci svítí (vrstva dekorace-lampy).
  const DROBNOSTI = {
    lampa:    { ikony: ['deko-lampa'],    H: 192, vyskaM: 8,   z0: 14.9, sv: 5, zare: 'lampa-zare' },
    posed:    { ikony: ['deko-posed'],    H: 192, vyskaM: 10,  z0: 14.6 },
    krmelec:  { ikony: ['deko-krmelec'],  H: 112, vyskaM: 5,   z0: 15.4 },
    lavicka:  { ikony: ['deko-lavicka'],  H: 72,  vyskaM: 2.0, z0: 16.1 },
    studna:   { ikony: ['deko-studna'],   H: 128, vyskaM: 4,   z0: 15.8 },
    schranka: { ikony: ['deko-schranka'], H: 96,  vyskaM: 3,   z0: 16.1 },
    // engine 350: lampy z dat měst – sadová lampa a svítidlo na zdi (jen noční svit, bez kresby)
    lampa_park: { ikony: ['deko-lampa-park'], H: 128, vyskaM: 5, z0: 15.2, sv: 5, zare: 'lampa-park-zare' },
    svit:     { ikony: [],                H: 192, vyskaM: 8,   z0: 14.9, sv: 5, zare: 'lampa-zare' },
    // engine 350: stromy z OSM (ikony stromů ZABAGED podle `j`, k 0,81–1,09)
    strom:    { strom: true, k: 0.95, z0: 13.9 },
    // engine 352 (T 24. 9.: „přejezdy, přechody / zebry, závory, semafory“): polohy spočítané při exportu
    // (výstražník vpravo u silnice ±5 m od trati, semafory na protilehlých rozích); zebry kreslí styl
    vystraznik:   { ikony: ['deko-vystraznik'],   H: 160, vyskaM: 4.5, z0: 15.4 },
    vystraznik_z: { ikony: ['deko-vystraznik-z'], H: 160, vyskaM: 4.5, z0: 15.4 },
    semafor:  { ikony: ['deko-semafor'],  H: 176, vyskaM: 5,   z0: 15.3, sv: 5, zare: ['semafor-zare-r', 'semafor-zare-z'] },
    zavora:   { ikony: ['deko-zavora'],   H: 72,  vyskaM: 2,   z0: 15.8 },
    // engine 356 (T 24. 9.: „využij ty data pro obohacení mapy“): body DTM ČR – drobné sakrální stavby (kříže, boží
    // muka), drobné kulturní stavby (pomníky) a studny (zahradní: skruž s víkem, třetina s litinovou pumpou – TT
    // Sezemice: 73 z 80 nejbližších bodů DTM mimo OSM jsou studny v zahradách). Worker je vynechá do ~20 m od OSM
    // a uvnitř půdorysu budovy (kaplička = 3D budova).
    kriz:     { ikony: ['deko-kriz'],     H: 160, vyskaM: 3.5, z0: 15.6 },
    pomnik:   { ikony: ['deko-pomnik'],   H: 128, vyskaM: 3,   z0: 15.8 },
    studna_dtm: { ikony: ['deko-skruz', 'deko-skruz', 'deko-pumpa'], H: 96, vyskaM: 2.4, z0: 16.3 },
  };
  // ⭐ engine 357: ELEKTRICKÉ VEDENÍ (worker dekorací + vedeni3d.js). Třídy t: 0 NN, 1 VN, 2 110 kV, 3 220 kV,
  // 4 400 kV, 5 lanovka/vlek. H = výška plátna kresbičky (px @2), h = výchozí výška podpěry (m), z0 = nástup
  // (~5 px jako ostatní drobnosti), zMin = nejnižší úroveň dlaždic dekorací s podpěrami.
  const VEDENI_KONZOLY_VVN = [[48, 26], [72, 38], [96, 30]];            // [y konzoly, polovina délky] (px, 128×256)
  const VEDENI_UCHYTY_ZVN = [[-80, 116], [-56, 116], [56, 116], [80, 116], [-46, 78], [46, 78]];   // [x, y] (192×256)
  const VEDENI_VETRNIK_NABOJ_Y = 38;                                    // náboj na plátně 96×512
  const VEDENI_CFG = {
    tridy: {
      0: { ikona: 'deko-sloup-nn', H: 128, h: 8.5, z0: 14.7, zMin: 14 },
      1: { ikona: 'deko-stozar-vn', H: 160, h: 11, z0: 14.4, zMin: 13 },
      2: { ikona: 'deko-stozar-vvn', H: 256, h: 28, z0: 13.5, zMin: 13 },
      3: { ikona: 'deko-stozar-zvn', H: 256, h: 38, z0: 13.3, zMin: 13 },
      4: { ikona: 'deko-stozar-zvn', H: 256, h: 45, z0: 13.2, zMin: 13 },
      5: { ikona: 'deko-stozar-lan', H: 160, h: 9, z0: 14.3, zMin: 13 },
    },
    vetrnik: { ikona: 'deko-vetrnik', H: 512, z0: 12.0, podilVezeH: (512 - 10 - VEDENI_VETRNIK_NABOJ_Y) / 512 },
  };
  /// Úchyty vodičů podle třídy – [výška nad KOTVOU, posun vpravo] v podílech výšky podpěry (= výšky plátna H).
  /// Kotva kresbičky: icon-anchor bottom + icon-offset [0, 8] (8 CSS px = 16 px @2) → bod plátna (W/2, H − 16);
  /// pata (H − 10) je tedy 6 px @2 pod kotvou (zapuštěná do terénu). Souřadnice úchytů = místa na kresbičce.
  const uchyt = (W, H, x, y) => [(H - 16 - y) / H, (x - W / 2) / H];
  const VEDENI_VODICE = {
    // NN: sloup v x = 22 (plátno 48×128), čtyři izolátory na konzolce x = 31, y = 16 + 8,5·i
    0: [0, 1, 2, 3].map((i) => uchyt(48, 128, 31, 16 + 8.5 * i)),
    // VN: izolátor na vrcholu (y 5) a dva na konzole ±20 (y 14), plátno 64×160
    1: [uchyt(64, 160, 32, 5), uchyt(64, 160, 12, 14), uchyt(64, 160, 52, 14)],
    // 110 kV: zemnicí lano na hrotu (y 14) + tři konzoly na stranu, vodič na spodku izolátoru (y + 10)
    2: [uchyt(128, 256, 64, 14)].concat(VEDENI_KONZOLY_VVN.flatMap(([y, L]) =>
         [uchyt(128, 256, 64 - (L - 2), y + 10), uchyt(128, 256, 64 + (L - 2), y + 10)])),
    // 220/400 kV: dvě zemnicí lana na hrotech (±22, y 14) + konce řetězců (VEDENI_UCHYTY_ZVN)
    3: [uchyt(192, 256, 74, 14), uchyt(192, 256, 118, 14)].concat(VEDENI_UCHYTY_ZVN.map(([x, y]) => uchyt(192, 256, 96 + x, y))),
    4: [uchyt(192, 256, 74, 14), uchyt(192, 256, 118, 14)].concat(VEDENI_UCHYTY_ZVN.map(([x, y]) => uchyt(192, 256, 96 + x, y))),
    // lanovka: lano přes kladky (±16, horní hrana kol y 20), plátno 64×160
    5: [uchyt(64, 160, 16, 20), uchyt(64, 160, 48, 20)],
  };
  window.__vedeniVodice = VEDENI_VODICE;
  window.__vedeniCfg = VEDENI_CFG;                 // vedeni3d.js: náběh zoomu tříd (z0)
  const drobnostiProWorker = () => {
    const out = {};
    for (const [t, c] of Object.entries(DROBNOSTI)) {
      if (c.strom) { out[t] = { strom: true, k: c.k, z0: c.z0, ikony: [], sv: 0 }; continue; }
      out[t] = { ikony: c.ikony, k: +(c.vyskaM / (c.H * 0.1167)).toFixed(4), z0: c.z0, sv: c.sv || 0, zare: c.zare || null };
    }
    return out;
  };

  /// ⭐ engine 342: výraz průhlednosti dekorací = zarážky RAMPA (posunuté o dohled, o1–o8)
  /// + pevné 15,0 a 15,45 (o9, o10 – plynulé zmizení lichých buněk jemné mřížky před
  /// přechodem na dlaždice z14, viz nastupX ve workeru). ⛔ Zoomový interpolate musí
  /// zůstat KOŘENEM výrazu (násobek nočního ztlumení jde dovnitř na výstupy).
  function vyrazRampy(faktor) {
    // engine 343: plná mřížka od dlaždic z14 → přechod lichých buněk 14,45 → 14,0
    const zar = RAMPA.map((z, i) => [z, 'o' + (i + 1)]).concat([[14.0, 'o9'], [14.45, 'o10']])
      .concat(RAMPA_VYS.map((z, i) => [z, 'o' + (11 + i)]));           // engine 349: drobnosti zblízka
    zar.sort((a, b) => a[0] - b[0]);
    const vyr = ['interpolate', ['linear'], ['zoom']];
    let posl = -Infinity;
    for (const [z, k] of zar) {
      if (z <= posl + 1e-6) continue;          // shodná zarážka – první vyhrává
      posl = z;
      let v = ['coalesce', ['get', k], ['get', 'o8'], 1];   // starý generátor o9/o10 nemá
      if (typeof faktor === 'number' && faktor < 1) v = ['*', v, faktor];
      vyr.push(z, v);
    }
    return vyr;
  }

  /// Předpočítané opacity pro `RAMPA` podle prahu druhu.
  // ⛔ 16. 9. 2026 (kontrola B3): hodnoty o1…o8 se MUSÍ počítat ze
  // ZÁKLADNÍ rampy – zarážky interpolace jsou posunuté o DZ, takže se
  // celá křivka posune o dohled pro staré i nové prvky. Z posunuté
  // rampy se posun vyrušil a u Dalekého končila rampa na z14,85: kytky,
  // byliny, balvany a plodiny (z0 ≥ 15) měly všech osm hodnot 0.
  function nastup(z0) {
    const o = {};
    RAMPA_ZAKLAD.forEach((z, i) => {
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
    if (wStav === 1) wPridejVrstvu();   // engine 336: dlaždice až s malbami v atlasu
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
  /// engine 217: stíny stromů a keřů kreslí main.js na plátno stínů spolu
  /// s domy (koruna jako elipsa promítnutá podle slunce + kmen). Symbolová
  /// elipsa `akvarel-dekorace-stin` (engine 213, krytí ≤ 0,3, měkký přechod)
  /// nebyla vidět („u obrázků stromu stín nevidím") a stála za každý snímek.
  /// API zůstává kvůli svetlo.js; směr světla bere main.js sám.
  function nastavStin() { /* nic – viz main.js prepoctiStinyDomu */ }

  /// Zdroj se zakládá LÍNĚ až s prvními daty (7. 8.): zdroj založený
  /// prázdný během style.load zůstal STERILNÍ — setData pak plnil data
  /// i querySourceFeatures, ale dlaždice se nikdy nevykreslily (ověřeno
  /// pokusně; zdroj založený rovnou s daty kreslí okamžitě).
  function pridejVrstvu(data, svetla, vektor) {
    if (!mapa || mapa.getSource('dekorace')) return;
    if (vektor) {
      // ⭐ engine 336: vektorové dlaždice z workeru (protokol dekorace://);
      // z15 nese vše včetně jemné mřížky, výš se jen přetahuje
      mapa.addSource('dekorace', { type: 'vector', minzoom: 12, maxzoom: 15,
                                   tiles: ['dekorace://v' + wVerze + '/{z}/{x}/{y}'] });
    } else {
      // buffer 0: s allow-overlap netřeba přesah — levnější přeskládání
      mapa.addSource('dekorace',
          { type: 'geojson', data, buffer: 0, maxzoom: 14 });
    }
    zapsaneFeatury = (!vektor && data && data.features) || [];
    // ⛔⛔ engine 264: SVĚTLA SÍDEL VE VLASTNÍM ZDROJI. Mihotání přes
    // `setFeatureState` na zdroji `dekorace` (tisíce stromů) přestavovalo
    // paint buffery všech dekorací každých 400 ms (dlouhé úlohy 60–88 ms)
    // a mapa se v noci překreslovala 26×/s i v klidu – noc měla o 100–170
    // pomalých snímků na sadu gest víc než den. Malý zdroj = levný stav.
    if (!mapa.getSource('dekorace-svetla-zdroj')) {
      mapa.addSource('dekorace-svetla-zdroj',
          { type: 'geojson', data: svetla || { type: 'FeatureCollection', features: [] },
            buffer: 0, maxzoom: 14 });
    }
    // (engine 217: sprite `deko-stin` zrušen – stíny stromů kreslí main.js)
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
    // (engine 217: vrstva `akvarel-dekorace-stin` zrušena – stíny stromů
    //  kreslí main.js na plátno stínů spolu s domy)
    mapa.addLayer({
      id: 'akvarel-dekorace', type: 'symbol', source: 'dekorace',
      ...(vektor ? { 'source-layer': 'd' } : {}),
      // stromy nastupují od z13,25 (54 % ukazatele), vrstva musí být dřív
      minzoom: 13.2 - DZ,
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
        // ⭐⭐ engine 345 (výtka T 23. 9.: „mění se jejich velikost podle terénu při
        // posunech“): MapLibre tlumí perspektivu symbolů (0,5 + 0,5·c2c/d) a zbytek
        // velikosti bral ze ZOOMU – a zoom se při posunu mění s terénem pod středem
        // (±0,2), takže všechny stromy „dýchaly“. Záplata bundlu (`#define
        // OKOLNIK_PERSPEKTIVA`, jen tahle vrstva) dává PLNOU perspektivu: velikost
        // = konst. / vzdálenost stromu od kamery – zoom se vykrátí. `ev` tím odpadá
        // (výš = blíž kameře = větší, teď skutečně).
        'icon-size': ['interpolate', ['exponential', 2], ['zoom'],
          13.25, ['*', ['get', 'k'], 0.046],
          22, ['*', ['get', 'k'], 19.7]],
      },
      paint: {
        // rychlý a pro všechny druhy stejně dlouhý nástup — hodnoty
        // předpočítal `nastup(z0)` podle prahu druhu (viz `RAMPA`)
        'icon-opacity': vyrazRampy(1),
      },
    }, kotva ? kotva.id : undefined);
    // ⭐ engine 354 (T 24. 9.: „ten kouř nad domy působí zvláštně, když nemají komíny“): KOMÍNY
    // rodinných domů z vrstvy `k` dlaždic workeru – cihlové tělo 0,9 m natočené podle domu, 1,5 m nad
    // střechou, tmavší hlava; kouř (animace.js) stoupá z jejich vrcholu. Jen odkryté (maska mlhy).
    if (vektor && !mapa.getLayer('dekorace-kominy')) {
      try {
        mapa.addLayer({
          id: 'dekorace-kominy', type: 'fill-extrusion', source: 'dekorace', 'source-layer': 'k',
          minzoom: 15,
          paint: {
            'fill-extrusion-color': ['case', ['has', 'c'], '#5A4B44', '#94553F'],
            'fill-extrusion-height': ['get', 'h'],
            'fill-extrusion-base': ['get', 'b'],
            'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 15.4, 1],
            'fill-extrusion-vertical-gradient': false,
          },
        }, 'akvarel-dekorace');
      } catch (e) { console.warn('[deko] komíny', e); }
    }
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
        mapa.setPaintProperty('akvarel-dekorace', 'icon-opacity', vyrazRampy(faktor));
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
    // engine 349: drobnosti (lampa, posed, krmelec, lavička, studna, schránka) + svit lampy
    for (const [jmeno, fn] of Object.entries(SPRITY_DROBNOSTI)) {
      if (!mapa.hasImage(jmeno)) {
        try { mapa.addImage(jmeno, fn(), { pixelRatio: 2 }); } catch (e) { console.warn('[deko] drobnost:', jmeno, e); }
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
      id: 'dekorace-svetla', type: 'symbol', source: 'dekorace-svetla-zdroj',   // engine 264
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
    // ⭐ engine 349: NOČNÍ SVIT LAMP (sv 5) – stejné měřítko, pata a PLNÁ perspektiva jako kresba
    // lampy (záplata bundlu: vrstva `dekorace-lampy` jako akvarel-dekorace), takže jas sedí na skle;
    // za domy se schová (hloubka jen pro čtení). Ve dne schovaná, zapíná `__lampyNoc` z aplikujNoc.
    if (!mapa.getLayer('dekorace-lampy')) {
      mapa.addLayer({
        id: 'dekorace-lampy', type: 'symbol', source: 'dekorace-svetla-zdroj',
        minzoom: DROBNOSTI.lampa.z0 - 0.4 - DZ,
        filter: ['==', ['get', 'sv'], 5],
        layout: {
          'icon-image': ['get', 'ik'],
          'icon-anchor': 'bottom',
          'icon-offset': [0, 8],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          visibility: 'none',
          'icon-size': ['interpolate', ['exponential', 2], ['zoom'],
            13.25, ['*', ['get', 'k'], 0.046],
            22, ['*', ['get', 'k'], 19.7]],
        },
        paint: { 'icon-opacity': vyrazLampy(1) },
      }, kotva ? kotva.id : undefined);
    }
    try { if (typeof Pocasi !== 'undefined' && Pocasi.stavNoci) window.__lampyNoc(Pocasi.stavNoci()); } catch (e) { /* nic */ }
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

  /// engine 349: průhlednost svitu lamp – nástup s lampou (z0 − dohled, šířka rampy) × síla noci
  let lampySila = 0;
  function vyrazLampy(sila) {
    const z0 = DROBNOSTI.lampa.z0 - DZ;
    return ['interpolate', ['linear'], ['zoom'], z0 - 0.01, 0, z0 + SIRKA_NASTUPU, Math.max(0.001, sila)];
  }
  /// engine 349: lampy svítí od soumraku (krok noci ≥ 1): 0,55 / 0,85 / 1; ve dne vrstva schovaná
  window.__lampyNoc = (krok) => {
    try {
      if (!mapa || !mapa.getLayer('dekorace-lampy')) return;
      const sila = [0, 0.55, 0.85, 1][Math.max(0, Math.min(3, krok | 0))];
      if (sila !== lampySila) { lampySila = sila; if (sila > 0) mapa.setPaintProperty('dekorace-lampy', 'icon-opacity', vyrazLampy(sila)); }
      const chce = sila > 0 ? 'visible' : 'none';
      if (mapa.getLayoutProperty('dekorace-lampy', 'visibility') !== chce) mapa.setLayoutProperty('dekorace-lampy', 'visibility', chce);
    } catch (e) { /* styl se zrovna mění */ }
  };

  // -------------------------------------------------------------------------
  // ⭐ engine 349: DROBNOSTI SE ZNÁMOU POLOHOU (OSM) – kresby v kódu jako sněhulák, malované
  // barvy a TMAVÝ OBRYS (drobnost má na mapě 5–40 px, obrys ji oddělí od podkladu). Pata stojí
  // 10 px nad spodkem obrázku (@2) kvůli `icon-offset` vrstvy; výška obrázku určuje k (viz DROBNOSTI).
  function platnoDrobnosti(W, H) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.lineJoin = 'round'; g.lineCap = 'round';
    return [c, g];
  }
  const OBRYS_D = 'rgba(28,22,16,0.85)';
  /// obdélník s obrysem (x, y, šířka, výška)
  function trs(g, x, y, w, h, barva, obrys) {
    g.fillStyle = barva; g.fillRect(x, y, w, h);
    if (obrys !== false) { g.strokeStyle = OBRYS_D; g.lineWidth = 1.6; g.strokeRect(x, y, w, h); }
  }
  function stinPaty(g, cx, cy, rx) {
    g.fillStyle = 'rgba(40,36,30,0.22)';
    g.beginPath(); g.ellipse(cx, cy, rx, rx * 0.26, 0, 0, Math.PI * 2); g.fill();
  }
  /// lampa veřejného osvětlení: šedý kuželový sloup, oblouk ramene a hlava se světlým sklem (64×192)
  function lampaSprite() {
    const W = 64, H = 192, yb = H - 10;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, 32, yb, 11);
    // sloup (kužel) s obrysem a světlejší hranou
    g.beginPath(); g.moveTo(29, yb); g.lineTo(30.4, 34); g.lineTo(33.6, 34); g.lineTo(35, yb); g.closePath();
    g.fillStyle = '#6d7379'; g.fill(); g.strokeStyle = OBRYS_D; g.lineWidth = 1.6; g.stroke();
    g.strokeStyle = 'rgba(200,206,212,0.7)'; g.lineWidth = 1.1;
    g.beginPath(); g.moveTo(30.6, yb - 2); g.lineTo(31.3, 38); g.stroke();
    trs(g, 27, yb - 12, 10, 12, '#5a5f65');                   // patka
    // rameno
    g.strokeStyle = OBRYS_D; g.lineWidth = 4.2;
    g.beginPath(); g.moveTo(32, 36); g.quadraticCurveTo(33, 22, 48, 24); g.stroke();
    g.strokeStyle = '#737a80'; g.lineWidth = 2.2;
    g.beginPath(); g.moveTo(32, 36); g.quadraticCurveTo(33, 22, 48, 24); g.stroke();
    // hlava (tmavý kryt, světlé sklo zespodu)
    g.beginPath(); g.moveTo(42, 22); g.quadraticCurveTo(52, 16, 60, 23); g.lineTo(58, 28); g.lineTo(44, 28); g.closePath();
    g.fillStyle = '#474d53'; g.fill(); g.strokeStyle = OBRYS_D; g.lineWidth = 1.6; g.stroke();
    g.beginPath(); g.ellipse(51, 28.5, 7, 2.4, 0, 0, Math.PI * 2);
    g.fillStyle = '#fff1c9'; g.fill(); g.strokeStyle = 'rgba(28,22,16,0.6)'; g.lineWidth = 1; g.stroke();
    return g.getImageData(0, 0, W, H);
  }
  /// noční svit lampy (256×192, stejné měřítko a pata jako lampa): jas u skla + kaluž světla na zemi
  const LAMPA_SKLO = [51 - 32, 29];                           // sklo vůči středu paty (px @2), y od horního okraje
  function lampaZareSprite() {
    const W = 256, H = 192, yb = H - 10, cx = W / 2;
    const [c, g] = platnoDrobnosti(W, H);
    // kaluž světla na zemi (plochá elipsa – billboard na zemi čte oko jako kruh v perspektivě)
    g.save(); g.translate(cx + 6, yb - 2); g.scale(1, 0.24);
    let r = g.createRadialGradient(0, 0, 0, 0, 0, 118);
    r.addColorStop(0, 'rgba(255,226,160,0.55)'); r.addColorStop(0.45, 'rgba(255,214,140,0.28)'); r.addColorStop(1, 'rgba(255,205,120,0)');
    g.fillStyle = r; g.beginPath(); g.arc(0, 0, 118, 0, Math.PI * 2); g.fill();
    g.restore();
    // kužel světla od skla k zemi
    const sx = cx + LAMPA_SKLO[0], sy = LAMPA_SKLO[1];
    const k = g.createLinearGradient(0, sy, 0, yb);
    k.addColorStop(0, 'rgba(255,236,190,0.2)'); k.addColorStop(1, 'rgba(255,226,170,0.03)');
    g.fillStyle = k;
    g.beginPath(); g.moveTo(sx - 5, sy + 2); g.lineTo(sx + 5, sy + 2); g.lineTo(sx + 46, yb); g.lineTo(sx - 46, yb); g.closePath(); g.fill();
    // jas u skla
    r = g.createRadialGradient(sx, sy, 0, sx, sy, 34);
    r.addColorStop(0, 'rgba(255,252,240,1)'); r.addColorStop(0.18, 'rgba(255,238,190,0.9)');
    r.addColorStop(0.5, 'rgba(255,214,140,0.32)'); r.addColorStop(1, 'rgba(255,205,120,0)');
    g.fillStyle = r; g.beginPath(); g.arc(sx, sy, 34, 0, Math.PI * 2); g.fill();
    return g.getImageData(0, 0, W, H);
  }
  /// posed (myslivecký posed): čtyři nohy do A, žebřík, kazatelna s okénkem a stříškou (128×192)
  function posedSprite() {
    const W = 128, H = 192, yb = H - 10;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, 64, yb, 42);
    const drevo = '#7b5a3b', svetle = '#9a7650', tmave = '#5c4029';
    const noha = (x0, y0, x1, y1, w, barva) => {
      g.strokeStyle = OBRYS_D; g.lineWidth = w + 2.4; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      g.strokeStyle = barva; g.lineWidth = w; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    };
    noha(40, yb - 2, 50, 84, 3.6, tmave); noha(88, yb - 2, 78, 84, 3.6, tmave);          // zadní
    noha(28, yb, 44, 84, 4.6, drevo); noha(100, yb, 84, 84, 4.6, drevo);                 // přední
    noha(34, 150, 94, 118, 2.4, tmave); noha(94, 150, 34, 118, 2.4, tmave);             // kříž
    // žebřík
    noha(52, yb, 56, 86, 2.6, svetle); noha(68, yb, 66, 86, 2.6, svetle);
    for (let y = yb - 10; y > 92; y -= 11) { g.strokeStyle = svetle; g.lineWidth = 2; g.beginPath(); g.moveTo(53, y); g.lineTo(68, y); g.stroke(); }
    // podlaha a kazatelna
    trs(g, 36, 80, 56, 6, tmave);
    g.fillStyle = drevo; g.fillRect(38, 44, 52, 36);
    g.strokeStyle = 'rgba(40,28,18,0.45)'; g.lineWidth = 1;
    for (let y = 50; y < 80; y += 6) { g.beginPath(); g.moveTo(38, y); g.lineTo(90, y); g.stroke(); }
    g.fillStyle = '#2a1f16'; g.fillRect(46, 50, 36, 12);                               // okénko
    g.strokeStyle = OBRYS_D; g.lineWidth = 1.6; g.strokeRect(38, 44, 52, 36);
    // stříška
    g.beginPath(); g.moveTo(30, 46); g.lineTo(64, 28); g.lineTo(98, 46); g.lineTo(94, 50); g.lineTo(34, 50); g.closePath();
    g.fillStyle = '#4e5a44'; g.fill(); g.strokeStyle = OBRYS_D; g.lineWidth = 1.6; g.stroke();
    return g.getImageData(0, 0, W, H);
  }
  /// krmelec: sedlová střecha na čtyřech sloupcích, žebřina se senem a korýtko (128×112)
  function krmelecSprite() {
    const W = 128, H = 112, yb = H - 10;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, 64, yb, 50);
    const drevo = '#7d5b3c', tmave = '#5a3f28';
    const sloup = (x, y0, w, barva) => trs(g, x - w / 2, y0, w, yb - y0, barva);
    sloup(34, 52, 5, tmave); sloup(94, 52, 5, tmave);                                   // zadní
    // žebřina se senem (do V)
    g.fillStyle = '#d9c27a';
    g.beginPath(); g.moveTo(40, 56); g.lineTo(88, 56); g.lineTo(74, 80); g.lineTo(54, 80); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(150,120,60,0.8)'; g.lineWidth = 1;
    for (let i = 0; i < 9; i++) { g.beginPath(); g.moveTo(44 + i * 5, 56); g.lineTo(55 + i * 2.3, 80); g.stroke(); }
    g.strokeStyle = OBRYS_D; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(40, 56); g.lineTo(88, 56); g.lineTo(74, 80); g.lineTo(54, 80); g.closePath(); g.stroke();
    trs(g, 48, 84, 32, 7, drevo);                                                      // korýtko
    sloup(22, 46, 6, drevo); sloup(106, 46, 6, drevo);                                  // přední
    // střecha
    g.beginPath(); g.moveTo(8, 50); g.lineTo(64, 14); g.lineTo(120, 50); g.lineTo(114, 55); g.lineTo(14, 55); g.closePath();
    g.fillStyle = '#6a4a31'; g.fill();
    g.strokeStyle = 'rgba(40,26,16,0.5)'; g.lineWidth = 1;
    for (let i = 1; i < 5; i++) { const t = i / 5; g.beginPath(); g.moveTo(8 + (64 - 8) * t, 50 - 36 * t + 2); g.lineTo(120 - (120 - 64) * t, 50 - 36 * t + 2); g.stroke(); }
    g.strokeStyle = OBRYS_D; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(8, 50); g.lineTo(64, 14); g.lineTo(120, 50); g.lineTo(114, 55); g.lineTo(14, 55); g.closePath(); g.stroke();
    return g.getImageData(0, 0, W, H);
  }
  /// lavička: dřevěný sedák a opěradlo na tmavých nohách, mírně z nadhledu (128×72)
  function lavickaSprite() {
    const W = 128, H = 72, yb = H - 10;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, 64, yb - 2, 50);
    const noha = '#3b3a38', drevo = '#a06f45', tmave = '#7c5433';
    trs(g, 28, 30, 4, yb - 36, noha); trs(g, 96, 30, 4, yb - 36, noha);               // zadní nohy (drží opěradlo)
    // opěradlo (dvě prkna)
    trs(g, 22, 16, 84, 7, drevo); trs(g, 22, 25, 84, 6, tmave);
    // sedák (kosodélník z nadhledu)
    g.beginPath(); g.moveTo(18, 38); g.lineTo(110, 38); g.lineTo(116, 46); g.lineTo(12, 46); g.closePath();
    g.fillStyle = drevo; g.fill();
    g.strokeStyle = 'rgba(70,46,26,0.6)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(15, 42); g.lineTo(113, 42); g.stroke();
    g.strokeStyle = OBRYS_D; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(18, 38); g.lineTo(110, 38); g.lineTo(116, 46); g.lineTo(12, 46); g.closePath(); g.stroke();
    trs(g, 16, 46, 5, yb - 46, noha); trs(g, 107, 46, 5, yb - 46, noha);             // přední nohy
    return g.getImageData(0, 0, W, H);
  }
  /// studna: kamenná roubení, dva sloupky, stříška, rumpál s okovem (96×128)
  function studnaSprite() {
    const W = 96, H = 128, yb = H - 10;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, 48, yb, 36);
    // roubení (válec z kamene)
    g.fillStyle = '#9b958b'; g.fillRect(16, 82, 64, yb - 86);
    g.beginPath(); g.ellipse(48, yb - 4, 32, 6, 0, 0, Math.PI); g.fill();
    g.fillStyle = 'rgba(70,66,60,0.55)';
    for (let r = 0; r < 4; r++) for (let i = 0; i < 5; i++) {
      const x = 18 + i * 13 + (r & 1) * 6, y = 86 + r * 7;
      if (x < 76 && y < yb - 4) g.fillRect(x, y, 1.2, 6);
    }
    g.strokeStyle = 'rgba(70,66,60,0.5)'; g.lineWidth = 1;
    for (let r = 1; r < 4; r++) { g.beginPath(); g.moveTo(16, 86 + r * 7); g.lineTo(80, 86 + r * 7); g.stroke(); }
    g.beginPath(); g.ellipse(48, 82, 32, 7, 0, 0, Math.PI * 2);
    g.fillStyle = '#b3ada3'; g.fill();
    g.beginPath(); g.ellipse(48, 82, 25, 4.6, 0, 0, Math.PI * 2); g.fillStyle = '#1f2a2e'; g.fill();   // voda/tma
    g.strokeStyle = OBRYS_D; g.lineWidth = 1.6;
    g.beginPath(); g.ellipse(48, 82, 32, 7, 0, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(16, 82); g.lineTo(16, yb - 4); g.ellipse(48, yb - 4, 32, 6, 0, Math.PI, 0, true); g.lineTo(80, 82); g.stroke();
    // sloupky, rumpál, okov
    trs(g, 19, 36, 5, 46, '#6e4f33'); trs(g, 72, 36, 5, 46, '#6e4f33');
    trs(g, 22, 52, 52, 6, '#8a6a47');
    g.strokeStyle = OBRYS_D; g.lineWidth = 2.4;
    g.beginPath(); g.moveTo(78, 55); g.lineTo(86, 55); g.lineTo(86, 62); g.stroke();                // klika
    g.strokeStyle = '#d8cfb8'; g.lineWidth = 1; g.beginPath(); g.moveTo(48, 58); g.lineTo(48, 68); g.stroke();
    trs(g, 43, 68, 10, 8, '#5f5a52');
    // stříška
    g.beginPath(); g.moveTo(8, 40); g.lineTo(48, 14); g.lineTo(88, 40); g.lineTo(84, 44); g.lineTo(12, 44); g.closePath();
    g.fillStyle = '#6b4a2f'; g.fill(); g.strokeStyle = OBRYS_D; g.lineWidth = 1.6; g.stroke();
    return g.getImageData(0, 0, W, H);
  }
  /// poštovní schránka: oranžová schránka České pošty s trubkou na šedém sloupku (64×96)
  function schrankaSprite() {
    const W = 64, H = 96, yb = H - 10;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, 32, yb, 12);
    trs(g, 29.5, 46, 5, yb - 46, '#7a7f84');
    g.beginPath(); g.moveTo(14, 48); g.lineTo(14, 26); g.quadraticCurveTo(32, 14, 50, 26); g.lineTo(50, 48); g.closePath();
    g.fillStyle = '#ef8a1f'; g.fill(); g.strokeStyle = OBRYS_D; g.lineWidth = 1.6; g.stroke();
    g.fillStyle = 'rgba(255,214,150,0.55)'; g.fillRect(16.5, 27, 3, 19);                   // odlesk
    trs(g, 20, 29, 24, 3.2, '#2a221c', false);                                              // štěrbina
    g.strokeStyle = '#3a2a1c'; g.lineWidth = 1.6;                                           // trubka pošty
    g.beginPath(); g.arc(32, 40, 4.2, Math.PI * 0.15, Math.PI * 1.1); g.stroke();
    g.beginPath(); g.moveTo(27.8, 40); g.lineTo(24, 42.6); g.stroke();
    return g.getImageData(0, 0, W, H);
  }
  /// engine 350: sadová lampa (Brno „Stožár sadový“): tmavý štíhlý sloupek s lucernou (64×128)
  function lampaParkSprite() {
    const W = 64, H = 128, yb = H - 10;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, 32, yb, 9);
    trs(g, 27, yb - 14, 10, 14, '#2f3a33');                    // patka
    g.beginPath(); g.moveTo(30.4, yb - 14); g.lineTo(31, 36); g.lineTo(33, 36); g.lineTo(33.6, yb - 14); g.closePath();
    g.fillStyle = '#34413a'; g.fill(); g.strokeStyle = OBRYS_D; g.lineWidth = 1.4; g.stroke();
    trs(g, 28, 32, 8, 4, '#2c3630');                           // límec
    // lucerna: stříška, sklo, spodek
    g.beginPath(); g.moveTo(22, 17); g.lineTo(32, 8); g.lineTo(42, 17); g.closePath();
    g.fillStyle = '#28322c'; g.fill(); g.strokeStyle = OBRYS_D; g.lineWidth = 1.4; g.stroke();
    g.beginPath(); g.moveTo(24, 17); g.lineTo(40, 17); g.lineTo(38, 30); g.lineTo(26, 30); g.closePath();
    g.fillStyle = '#fff0c4'; g.fill(); g.strokeStyle = OBRYS_D; g.lineWidth = 1.4; g.stroke();
    g.strokeStyle = 'rgba(40,50,44,0.8)'; g.lineWidth = 1; g.beginPath(); g.moveTo(32, 17); g.lineTo(32, 30); g.stroke();
    trs(g, 25, 30, 14, 3, '#28322c');
    return g.getImageData(0, 0, W, H);
  }
  /// engine 350: noční svit sadové lampy (256×128, stejná pata a k)
  const LAMPA_PARK_SKLO = [0, 23];
  function lampaParkZareSprite() {
    const W = 256, H = 128, yb = H - 10, cx = W / 2;
    const [c, g] = platnoDrobnosti(W, H);
    g.save(); g.translate(cx, yb - 2); g.scale(1, 0.26);
    let r = g.createRadialGradient(0, 0, 0, 0, 0, 84);
    r.addColorStop(0, 'rgba(255,226,160,0.5)'); r.addColorStop(0.5, 'rgba(255,214,140,0.24)'); r.addColorStop(1, 'rgba(255,205,120,0)');
    g.fillStyle = r; g.beginPath(); g.arc(0, 0, 84, 0, Math.PI * 2); g.fill();
    g.restore();
    const sx = cx + LAMPA_PARK_SKLO[0], sy = LAMPA_PARK_SKLO[1];
    r = g.createRadialGradient(sx, sy, 0, sx, sy, 30);
    r.addColorStop(0, 'rgba(255,252,240,1)'); r.addColorStop(0.2, 'rgba(255,238,190,0.85)');
    r.addColorStop(0.55, 'rgba(255,214,140,0.28)'); r.addColorStop(1, 'rgba(255,205,120,0)');
    g.fillStyle = r; g.beginPath(); g.arc(sx, sy, 30, 0, Math.PI * 2); g.fill();
    return g.getImageData(0, 0, W, H);
  }
  /// engine 352: výstražník železničního přejezdu – sloupek, výstražný kříž (bílé ramena s červeným lemem)
  /// a skříňka se dvěma červenými světly; `zavora` = navíc červenobílé břevno závory (64×160 / 192×160)
  function vystraznikSprite(zavora) {
    const W = zavora ? 192 : 64, H = 160, yb = H - 10, x = zavora ? 40 : 32;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, x, yb, 10);
    trs(g, x - 2.5, 30, 5, yb - 30, '#d4d3cc');                        // sloupek
    trs(g, x - 5, yb - 10, 10, 10, '#6d6c66');                          // patka
    // výstražný kříž
    for (const uhel of [0.62, -0.62]) {
      g.save(); g.translate(x, 24); g.rotate(uhel);
      g.fillStyle = '#ffffff'; g.fillRect(-19, -4, 38, 8);
      g.strokeStyle = '#c62a2e'; g.lineWidth = 2.2; g.strokeRect(-19, -4, 38, 8);
      g.restore();
    }
    g.strokeStyle = OBRYS_D; g.lineWidth = 0.8;
    // skříňka se světly
    g.beginPath(); g.moveTo(x - 15, 44); g.lineTo(x + 15, 44); g.lineTo(x + 15, 58); g.lineTo(x - 15, 58); g.closePath();
    g.fillStyle = '#1c1c1c'; g.fill(); g.strokeStyle = OBRYS_D; g.lineWidth = 1.4; g.stroke();
    for (const dx of [-8, 8]) { g.beginPath(); g.arc(x + dx, 51, 4.6, 0, Math.PI * 2); g.fillStyle = '#8c2422'; g.fill(); }
    if (zavora) {
      const y = yb - 40;                                                 // břevno závory
      g.fillStyle = OBRYS_D; g.fillRect(x - 4, y - 5, W - x - 4, 10);
      for (let i = 0, px = x; px < W - 10; px += 12, i++) { g.fillStyle = i % 2 ? '#ffffff' : '#d23a2f'; g.fillRect(px, y - 3.5, 12, 7); }
      trs(g, x - 8, y - 7, 10, 14, '#4a4a46');                           // protizávaží
    }
    return g.getImageData(0, 0, W, H);
  }
  /// engine 352: semafor – šedý stožár, černá hlava se třemi světly (ve dne svítí zelená) (64×176)
  function semaforSprite() {
    const W = 64, H = 176, yb = H - 10;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, 32, yb, 9);
    trs(g, 30, 60, 4, yb - 60, '#7b7f82');
    trs(g, 27, yb - 8, 10, 8, '#5d6063');
    g.beginPath(); g.moveTo(19, 12); g.lineTo(45, 12); g.lineTo(45, 64); g.lineTo(19, 64); g.closePath();
    g.fillStyle = '#f2f2ee'; g.fill(); g.strokeStyle = OBRYS_D; g.lineWidth = 1.4; g.stroke();   // bílý rámeček
    g.fillStyle = '#1d1f20'; g.fillRect(23, 15, 18, 46);
    const svetla = [['#5b1d1b', 24], ['#5b4a1a', 38], ['#46e27a', 52]];
    for (const [b, y] of svetla) { g.beginPath(); g.arc(32, y, 5.6, 0, Math.PI * 2); g.fillStyle = b; g.fill(); }
    return g.getImageData(0, 0, W, H);
  }
  /// engine 352: noční světlo semaforu (stejná pata a k jako semafor): červené nahoře, zelené dole
  function semaforZareSprite(rgb, y) {
    const W = 64, H = 176;
    const [c, g] = platnoDrobnosti(W, H);
    const r = g.createRadialGradient(32, y, 0, 32, y, 18);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(' + rgb + ',0.95)'); r.addColorStop(1, 'rgba(' + rgb + ',0)');
    g.fillStyle = r; g.beginPath(); g.arc(32, y, 18, 0, Math.PI * 2); g.fill();
    return g.getImageData(0, 0, W, H);
  }
  /// engine 352: závora na cestě – sloupek s protizávažím a červenobílé břevno (192×72)
  function zavoraSprite() {
    const W = 192, H = 72, yb = H - 10;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, 22, yb - 1, 14);                                       // stín sloupku (břevno ho nemá)
    trs(g, 14, yb - 30, 12, 30, '#6e6e68');
    const y = yb - 26;
    g.fillStyle = OBRYS_D; g.fillRect(20, y - 5, 168, 10);
    for (let i = 0, px = 22; px < 186; px += 12, i++) { g.fillStyle = i % 2 ? '#ffffff' : '#d23a2f'; g.fillRect(px, y - 3.5, Math.min(12, 186 - px), 7); }
    trs(g, 8, y - 7, 10, 14, '#4a4a46');
    trs(g, 180, y, 3, yb - y, '#6e6e68', false);                        // podpěra konce břevna
    return g.getImageData(0, 0, W, H);
  }
  /// engine 356: kříž / boží muka z DTM (drobná sakrální stavba) – stupňovitý kamenný podstavec, sloupek,
  /// hlavice a kovaný kříž se světlým náznakem těla (64×160)
  function krizSprite() {
    const W = 64, H = 160, yb = H - 10;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, 32, yb, 16);
    trs(g, 14, yb - 12, 36, 12, '#a99b82');
    trs(g, 19, yb - 26, 26, 14, '#b8aa90');
    trs(g, 26, 58, 12, yb - 26 - 58, '#c2b59a');
    g.fillStyle = 'rgba(80,70,55,0.35)'; g.fillRect(34, 58, 4, yb - 26 - 58);
    trs(g, 23, 52, 18, 7, '#b2a48a');
    trs(g, 30, 12, 4, 42, '#3b3833');
    trs(g, 21, 23, 22, 4, '#3b3833');
    g.fillStyle = '#d9d0bd'; g.fillRect(31, 27, 2, 11); g.fillRect(28, 28, 8, 1.6);
    return g.getImageData(0, 0, W, H);
  }
  /// engine 356: pomník z DTM (drobná kulturní stavba) – podstavec, kamenný kvádr s tmavou deskou nápisu, jehlan (80×128)
  function pomnikSprite() {
    const W = 80, H = 128, yb = H - 10;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, 40, yb, 26);
    trs(g, 14, yb - 12, 52, 12, '#9d978b');
    trs(g, 22, 40, 36, yb - 12 - 40, '#b7b1a4');
    g.fillStyle = 'rgba(70,66,58,0.3)'; g.fillRect(48, 40, 10, yb - 52);
    trs(g, 28, 56, 24, 22, '#5b5448');
    g.fillStyle = '#d8cfb6';
    for (let i = 0; i < 4; i++) g.fillRect(31, 60 + i * 4.5, 18 - (i % 2) * 5, 1.4);
    g.beginPath(); g.moveTo(20, 40); g.lineTo(40, 22); g.lineTo(60, 40); g.closePath();
    g.fillStyle = '#a8a194'; g.fill(); g.strokeStyle = OBRYS_D; g.lineWidth = 1.4; g.stroke();
    return g.getImageData(0, 0, W, H);
  }
  /// engine 356: studna z DTM – betonová skruž s víkem a poklopem (zahradní studna), 64×96; kreslená dole v plátně,
  /// aby měřítko sedělo s pumpou (obě 2,4 m na výšku plátna)
  function skruzSprite() {
    const W = 64, H = 96, yb = H - 10;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, 32, yb, 22);
    g.fillStyle = '#a7a39b'; g.fillRect(12, yb - 26, 40, 22);
    g.beginPath(); g.ellipse(32, yb - 4, 20, 5, 0, 0, Math.PI); g.fill();
    g.fillStyle = 'rgba(60,58,54,0.22)'; g.fillRect(40, yb - 26, 12, 22);
    g.beginPath(); g.ellipse(46, yb - 4, 6, 3.4, 0, 0, Math.PI); g.fill();
    g.strokeStyle = OBRYS_D; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(12, yb - 26); g.lineTo(12, yb - 4); g.ellipse(32, yb - 4, 20, 5, 0, Math.PI, 0, true);
    g.lineTo(52, yb - 26); g.stroke();
    g.beginPath(); g.ellipse(32, yb - 27, 23, 6, 0, 0, Math.PI * 2); g.fillStyle = '#bfbab0'; g.fill(); g.stroke();
    g.beginPath(); g.ellipse(32, yb - 28, 8, 2.4, 0, 0, Math.PI * 2); g.fillStyle = '#8e8a82'; g.fill(); g.stroke();
    return g.getImageData(0, 0, W, H);
  }
  /// engine 356: studna z DTM s litinovou pumpou (tmavě zelené tělo, hubice, zahnutá páka) na nízké skruži, 64×96
  function pumpaSprite() {
    const W = 64, H = 96, yb = H - 10;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, 30, yb, 20);
    g.fillStyle = '#a7a39b'; g.fillRect(12, yb - 16, 36, 12);
    g.beginPath(); g.ellipse(30, yb - 4, 18, 4.5, 0, 0, Math.PI); g.fill();
    g.strokeStyle = OBRYS_D; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(12, yb - 16); g.lineTo(12, yb - 4); g.ellipse(30, yb - 4, 18, 4.5, 0, Math.PI, 0, true);
    g.lineTo(48, yb - 16); g.stroke();
    g.beginPath(); g.ellipse(30, yb - 17, 20, 5, 0, 0, Math.PI * 2); g.fillStyle = '#bfbab0'; g.fill(); g.stroke();
    trs(g, 26, yb - 60, 8, 42, '#2f4a3a');
    trs(g, 24, yb - 65, 12, 6, '#263d30');
    g.lineCap = 'round';
    g.strokeStyle = OBRYS_D; g.lineWidth = 5;
    g.beginPath(); g.moveTo(26, yb - 44); g.lineTo(16, yb - 40); g.stroke();
    g.beginPath(); g.moveTo(34, yb - 62); g.quadraticCurveTo(47, yb - 73, 56, yb - 60); g.stroke();
    g.strokeStyle = '#2f4a3a'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(26, yb - 44); g.lineTo(16, yb - 40); g.stroke();
    g.beginPath(); g.moveTo(34, yb - 62); g.quadraticCurveTo(47, yb - 73, 56, yb - 60); g.stroke();
    return g.getImageData(0, 0, W, H);
  }
  // ⭐ engine 357: ELEKTRICKÉ VEDENÍ – kresbičky podpěr ve SKUTEČNÉ výšce (plátno = výška podpěry, pata 10 px
  // nad spodkem). Úchyty vodičů (VEDENI_VODICE) musí sedět s konzolami na kresbě – dráty kreslí vedeni3d.js.
  const OCEL = '#8f969c', OCEL_T = '#5c6369', IZOL = '#dcd5c6';
  /// stožár VVN 110 kV („soudek“): příhradová věž, tři konzoly na každou stranu (prostřední nejdelší), zemnicí hrot
  function stozarVvnSprite() {
    const W = 128, H = 256, yb = H - 10, cx = 64, vrch = 34;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, cx, yb, 18);
    const dole = 13, nahore = 4;
    g.fillStyle = 'rgba(92,99,105,0.16)';
    g.beginPath(); g.moveTo(cx - dole, yb); g.lineTo(cx - nahore, vrch); g.lineTo(cx + nahore, vrch); g.lineTo(cx + dole, yb); g.closePath(); g.fill();
    g.lineCap = 'round';
    g.strokeStyle = OCEL; g.lineWidth = 1.1;
    const pater = 9;
    for (let i = 0; i < pater; i++) {
      const t0 = i / pater, t1 = (i + 1) / pater;
      const y0 = yb + (vrch - yb) * t0, y1 = yb + (vrch - yb) * t1;
      const w0 = dole + (nahore - dole) * t0, w1 = dole + (nahore - dole) * t1;
      g.beginPath(); g.moveTo(cx - w0, y0); g.lineTo(cx + w1, y1); g.moveTo(cx + w0, y0); g.lineTo(cx - w1, y1);
      g.moveTo(cx - w1, y1); g.lineTo(cx + w1, y1); g.stroke();
    }
    g.strokeStyle = OCEL_T; g.lineWidth = 2.2;
    g.beginPath(); g.moveTo(cx - dole, yb); g.lineTo(cx - nahore, vrch); g.moveTo(cx + dole, yb); g.lineTo(cx + nahore, vrch); g.stroke();
    for (const [y, L] of VEDENI_KONZOLY_VVN) {
      g.strokeStyle = OCEL_T; g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx - L, y); g.lineTo(cx + L, y);
      g.moveTo(cx - L, y); g.lineTo(cx - nahore - 3, y + 8); g.moveTo(cx + L, y); g.lineTo(cx + nahore + 3, y + 8); g.stroke();
      g.strokeStyle = IZOL; g.lineWidth = 2.6;
      g.beginPath(); g.moveTo(cx - L + 2, y + 1); g.lineTo(cx - L + 2, y + 10); g.moveTo(cx + L - 2, y + 1); g.lineTo(cx + L - 2, y + 10); g.stroke();
    }
    g.strokeStyle = OCEL_T; g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx, vrch); g.lineTo(cx, 14); g.stroke();
    return g.getImageData(0, 0, W, H);
  }
  /// stožár ZVN 220/400 kV („Dunaj“): široké dolní rameno se dvěma vodiči na stranu, horní rameno s jedním,
  /// dva zemnicí hroty
  function stozarZvnSprite() {
    const W = 192, H = 256, yb = H - 10, cx = 96, vrch = 40;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, cx, yb, 24);
    const dole = 16, nahore = 6;
    g.fillStyle = 'rgba(92,99,105,0.16)';
    g.beginPath(); g.moveTo(cx - dole, yb); g.lineTo(cx - nahore, vrch); g.lineTo(cx + nahore, vrch); g.lineTo(cx + dole, yb); g.closePath(); g.fill();
    g.lineCap = 'round';
    g.strokeStyle = OCEL; g.lineWidth = 1.1;
    const pater = 9;
    for (let i = 0; i < pater; i++) {
      const t0 = i / pater, t1 = (i + 1) / pater;
      const y0 = yb + (vrch - yb) * t0, y1 = yb + (vrch - yb) * t1;
      const w0 = dole + (nahore - dole) * t0, w1 = dole + (nahore - dole) * t1;
      g.beginPath(); g.moveTo(cx - w0, y0); g.lineTo(cx + w1, y1); g.moveTo(cx + w0, y0); g.lineTo(cx - w1, y1);
      g.moveTo(cx - w1, y1); g.lineTo(cx + w1, y1); g.stroke();
    }
    g.strokeStyle = OCEL_T; g.lineWidth = 2.4;
    g.beginPath(); g.moveTo(cx - dole, yb); g.lineTo(cx - nahore, vrch); g.moveTo(cx + dole, yb); g.lineTo(cx + nahore, vrch); g.stroke();
    // ramena (příhradová: horní a dolní pás)
    for (const [y, L, pas] of [[104, 84, 10], [66, 50, 8]]) {
      g.strokeStyle = OCEL_T; g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx - L, y); g.lineTo(cx + L, y); g.moveTo(cx - L, y); g.lineTo(cx - nahore, y - pas);
      g.lineTo(cx + nahore, y - pas); g.lineTo(cx + L, y); g.stroke();
      g.strokeStyle = OCEL; g.lineWidth = 1;
      for (let k = 1; k < 6; k++) {
        const xa = cx - L + (L - nahore) * k / 6, xb = cx + L - (L - nahore) * k / 6;
        g.beginPath(); g.moveTo(xa, y); g.lineTo(xa + 6, y - pas * (k / 6)); g.moveTo(xb, y); g.lineTo(xb - 6, y - pas * (k / 6)); g.stroke();
      }
    }
    // izolátorové řetězce (V): dolní rameno 2 na stranu, horní 1 na stranu
    g.strokeStyle = IZOL; g.lineWidth = 2.8;
    for (const [x, y] of VEDENI_UCHYTY_ZVN) {
      g.beginPath(); g.moveTo(cx + x, y - 12); g.lineTo(cx + x, y); g.stroke();
    }
    // zemnicí hroty
    g.strokeStyle = OCEL_T; g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx - nahore, vrch); g.lineTo(cx - 22, 14); g.moveTo(cx + nahore, vrch); g.lineTo(cx + 22, 14); g.stroke();
    return g.getImageData(0, 0, W, H);
  }
  /// sloup VN 22 kV: betonový sloup, ocelová konzola se dvěma izolátory a jeden izolátor na vrcholu (64×160)
  function stozarVnSprite() {
    const W = 64, H = 160, yb = H - 10, cx = 32;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, cx, yb, 8);
    g.beginPath(); g.moveTo(cx - 3.2, yb); g.lineTo(cx - 1.8, 14); g.lineTo(cx + 1.8, 14); g.lineTo(cx + 3.2, yb); g.closePath();
    g.fillStyle = '#b9b5ac'; g.fill(); g.strokeStyle = OBRYS_D; g.lineWidth = 1.2; g.stroke();
    g.fillStyle = 'rgba(80,76,70,0.28)'; g.fillRect(cx + 0.3, 16, 1.6, yb - 18);
    trs(g, cx - 22, 22, 44, 3, '#5c6369');
    g.fillStyle = IZOL; g.strokeStyle = OBRYS_D; g.lineWidth = 1;
    for (const x of [-20, 20]) { g.beginPath(); g.ellipse(cx + x, 18, 2.4, 4, 0, 0, Math.PI * 2); g.fill(); g.stroke(); }
    g.beginPath(); g.ellipse(cx, 9, 2.4, 4, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    return g.getImageData(0, 0, W, H);
  }
  /// sloup NN (vesnice): dřevěný sloup se čtyřmi izolátory nad sebou na konzolce (48×128)
  function sloupNnSprite() {
    const W = 48, H = 128, yb = H - 10, cx = 22;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, cx, yb, 6);
    g.beginPath(); g.moveTo(cx - 2.6, yb); g.lineTo(cx - 1.8, 8); g.lineTo(cx + 1.8, 8); g.lineTo(cx + 2.6, yb); g.closePath();
    g.fillStyle = '#7a5a3c'; g.fill(); g.strokeStyle = OBRYS_D; g.lineWidth = 1.1; g.stroke();
    g.fillStyle = 'rgba(40,28,16,0.3)'; g.fillRect(cx + 0.4, 10, 1.4, yb - 12);
    trs(g, cx + 2, 12, 5, 34, '#4f555a', false);
    g.fillStyle = IZOL; g.strokeStyle = OBRYS_D; g.lineWidth = 0.9;
    for (let i = 0; i < 4; i++) { g.beginPath(); g.ellipse(cx + 9, 16 + i * 8.5, 2.2, 2.8, 0, 0, Math.PI * 2); g.fill(); g.stroke(); }
    return g.getImageData(0, 0, W, H);
  }
  /// podpěra lanovky / vleku: ocelový tubus, příčník a kladky nahoře (64×160)
  function stozarLanSprite() {
    const W = 64, H = 160, yb = H - 10, cx = 32;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, cx, yb, 8);
    trs(g, cx - 3, 22, 6, yb - 22, '#7c8a92');
    g.fillStyle = 'rgba(60,70,78,0.3)'; g.fillRect(cx, 24, 3, yb - 26);
    trs(g, cx - 24, 16, 48, 5, '#56616a');
    g.fillStyle = '#2d3236';
    for (const x of [-20, -12, 12, 20]) { g.beginPath(); g.ellipse(cx + x, 23, 3.4, 3.4, 0, 0, Math.PI * 2); g.fill(); }
    return g.getImageData(0, 0, W, H);
  }
  /// větrná elektrárna: bílý kuželový tubus, gondola a náboj BEZ listů (listy se točí v animace.js) (96×512)
  function vetrnikSprite() {
    const W = 96, H = 512, yb = H - 10, cx = 48, hub = VEDENI_VETRNIK_NABOJ_Y;
    const [c, g] = platnoDrobnosti(W, H);
    stinPaty(g, cx, yb, 12);
    g.beginPath(); g.moveTo(cx - 7, yb); g.lineTo(cx - 3.2, hub + 8); g.lineTo(cx + 3.2, hub + 8); g.lineTo(cx + 7, yb); g.closePath();
    g.fillStyle = '#eef0f1'; g.fill(); g.strokeStyle = OBRYS_D; g.lineWidth = 1.2; g.stroke();
    g.fillStyle = 'rgba(120,128,134,0.25)'; g.beginPath(); g.moveTo(cx + 1, yb); g.lineTo(cx + 0.6, hub + 8); g.lineTo(cx + 3.2, hub + 8); g.lineTo(cx + 7, yb); g.closePath(); g.fill();
    trs(g, cx - 7, hub - 5, 20, 10, '#e7eaec');                 // gondola
    g.beginPath(); g.ellipse(cx - 8, hub, 4.5, 4.5, 0, 0, Math.PI * 2);   // náboj
    g.fillStyle = '#f4f5f6'; g.fill(); g.strokeStyle = OBRYS_D; g.lineWidth = 1; g.stroke();
    return g.getImageData(0, 0, W, H);
  }
  const SPRITY_DROBNOSTI = { 'deko-lampa': lampaSprite, 'deko-posed': posedSprite, 'deko-krmelec': krmelecSprite,
                             'deko-lavicka': lavickaSprite, 'deko-studna': studnaSprite, 'deko-schranka': schrankaSprite,
                             'lampa-zare': lampaZareSprite,
                             'deko-lampa-park': lampaParkSprite, 'lampa-park-zare': lampaParkZareSprite,
                             'deko-vystraznik': () => vystraznikSprite(false), 'deko-vystraznik-z': () => vystraznikSprite(true),
                             'deko-semafor': semaforSprite, 'deko-zavora': zavoraSprite,
                             'deko-kriz': krizSprite, 'deko-pomnik': pomnikSprite,
                             'deko-skruz': skruzSprite, 'deko-pumpa': pumpaSprite,
                             'deko-stozar-vvn': stozarVvnSprite, 'deko-stozar-zvn': stozarZvnSprite,   // engine 357
                             'deko-stozar-vn': stozarVnSprite, 'deko-sloup-nn': sloupNnSprite,
                             'deko-stozar-lan': stozarLanSprite, 'deko-vetrnik': vetrnikSprite,
                             'semafor-zare-r': () => semaforZareSprite('255,70,55', 24),
                             'semafor-zare-z': () => semaforZareSprite('70,235,120', 52) };

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
  let svetlaPodpis = '';             // engine 264: podpis kolekce světel (vlastní zdroj)
  const svetlaCile = new Map();      // id → {ted, cil, krok}

  setInterval(() => {
    try {
      if (!mapa || !mapa.getSource('dekorace-svetla-zdroj')) return;
      if (document.visibilityState !== 'visible') return;
      // engine 264: během gesta se nemihotá (každý stav = přestavba bufferů zdroje);
      // engine 265: a ještě 1,5 s po něm („zkus těch 1,5 s klidu kvůli výkonu")
      if (mapa.isMoving && mapa.isMoving()) return;
      if (performance.now() - (window.__posledniPohybMs || 0) < 1500) return;
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
                  { source: 'dekorace-svetla-zdroj', id: f.id });
              if (st && typeof st.o === 'number') ted = st.o;
            } catch (e) { /* stav ještě není */ }
            svetlaCile.set(f.id, { ted, cil, krok: 0.12 });   // engine 264: tik 700 ms, stejné tempo
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
          mapa.setFeatureState({ source: 'dekorace-svetla-zdroj', id }, { o: s.ted });
        }
        // engine 333: změnilo se jen krytí → bez nového rozmístění symbolů
        if (window.bezPrerozmisteniSymbolu) window.bezPrerozmisteniSymbolu();
      }
    } catch (e) { /* zdroj se právě mění — příští tik */ }
  }, 700);

  // ⭐ v1.396: SVĚTLUŠKY VE VLASTNÍM RYCHLEJŠÍM TIKU (133 ms, „pohyb
  // udělej plynulejší“). Kroky jsou třetinové, takže rychlost letu
  // i tempo dechu zůstávají — jen po menších kouscích. setData na
  // ~40 bodech je zadarmo i při 7,5 Hz (velký zdroj se nesahá).
  // engine 310: křídla včel/netopýrů – jeden tik pro všechny (10 Hz včely,
  // netopýr každý 3. tik), žádná CSS animace = žádné snímky navíc
  let tikKridel = 0;
  function krokKridel() {
    tikKridel++;
    for (const m of musky) {
      const v = m.el && m.el.__vnitrni;
      if (!v || !v.__kridla) continue;
      if (v.__kridla > 1 && tikKridel % v.__kridla !== 0) continue;
      v.classList.toggle('mih');
    }
  }
  const tikRoje = () => {
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
  };
  // engine 287: 133 → 250 ms; engine 310: každý 2. tik společného tikače
  // (200 ms), bez něj vlastní časovač
  // ⚠️ dekorace.js se načítá PŘED main.js (kde KlidovyTakt vzniká; skripty
  // jdou za sebou přes onload) → přihlásit se až v `pripoj` z main.js
  let taktRoje = false;
  function nasadTaktRoje() {
    if (taktRoje) return;
    taktRoje = true;
    if (window.KlidovyTakt) {
      // engine 329: roj každý tik (≈15 Hz) – kroky se škálují časem (T v rojSvetlusek)
      KlidovyTakt.pridej('roj', tikRoje, 1);
      KlidovyTakt.pridej('kridla', () => { if (document.visibilityState === 'visible') krokKridel(); }, 1);
    } else {
      setInterval(tikRoje, 66);
      setInterval(krokKridel, 66);
    }
  }

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

  // směr „větru" pro babí léto a listí — náhodný jen jako záloha; engine 328
  // bere SKUTEČNÝ vítr z počasí (`Pocasi.vitr().smerRoj`), když nějaký fouká
  const VITR_ZALOHA = Math.random() * Math.PI * 2;
  function smerVetru() {
    try {
      const v = typeof Pocasi !== 'undefined' && Pocasi.vitr && Pocasi.vitr();
      if (v && !v.bezvetri) return v.smerRoj;
    } catch (e) { /* nic */ }
    return VITR_ZALOHA;
  }
  /// násobek kroku po větru: bezvětří 0,6 → 15 km/h 1,0 → 40+ km/h 1,5
  function silaVetru() {
    try {
      const v = typeof Pocasi !== 'undefined' && Pocasi.vitr && Pocasi.vitr();
      if (v) return 0.6 + Math.min(1, v.kmh / 40) * 0.9;
    } catch (e) { /* nic */ }
    return 1;
  }
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
  // ⭐ engine 272: ROZTOMILÁ VČELA (přání 9. 9. „ty nové včelky dej i do
  // Objevitele") – táž kresba jako na načítací obrazovce (nacitani_sveta.dart):
  // baculaté tělo s pruhy, velká hlava s očima, odlesky a tvářičkami, úsměv,
  // tykadla s kuličkami, průsvitná křidélka. Plátno 18×18, hlava nahoře,
  // křídla cvakají třídami vk-a/vk-b/vk-r jako dřív (mění se jen opacity).
  // Souřadnice = kresba z Flutteru posunutá o (9, 10) a ×0,78.
  const VCELA_SVG = '<svg viewBox="0 0 18 18" width="13" height="13">'
    // křidélka vzadu: rozmaz + dvě polohy v protifázi
    + '<g fill="#DDF3FF">'
    + '<ellipse class="vk-r" cx="5.6" cy="9.5" rx="3.1" ry="1.7" transform="rotate(-45 5.6 9.5)"/>'
    + '<ellipse class="vk-r" cx="12.4" cy="9.5" rx="3.1" ry="1.7" transform="rotate(45 12.4 9.5)"/>'
    + '<ellipse class="vk-a" cx="5.6" cy="9.5" rx="2.95" ry="1.4" transform="rotate(-32 5.6 9.5)"/>'
    + '<ellipse class="vk-a" cx="12.4" cy="9.5" rx="2.95" ry="1.4" transform="rotate(32 12.4 9.5)"/>'
    + '<ellipse class="vk-b" cx="5.6" cy="9.5" rx="2.95" ry="1.4" transform="rotate(-55 5.6 9.5)"/>'
    + '<ellipse class="vk-b" cx="12.4" cy="9.5" rx="2.95" ry="1.4" transform="rotate(55 12.4 9.5)"/>'
    + '</g>'
    // žihadlo
    + '<path fill="#3B2B12" d="M8.3 15.6 L9 17.2 L9.7 15.6 Z"/>'
    // tělo s pruhy (pruhy uvnitř těla – clipPath by po recyklaci ukazoval do prázdna,
    // proto jsou pruhy užší než tělo v dané výšce)
    + '<ellipse cx="9" cy="12" rx="3.35" ry="3.9" fill="#F5B942"/>'
    + '<rect x="6.15" y="9.6" width="5.7" height="1.1" rx="0.55" fill="#3B2B12"/>'
    + '<rect x="5.7" y="11.45" width="6.6" height="1.15" rx="0.55" fill="#3B2B12"/>'
    + '<rect x="6.2" y="13.5" width="5.6" height="1.05" rx="0.5" fill="#3B2B12"/>'
    // hlava
    + '<circle cx="9" cy="6.4" r="2.9" fill="#3B2B12"/>'
    // tykadla s kuličkami
    + '<g stroke="#3B2B12" stroke-width="0.5" stroke-linecap="round" fill="none">'
    + '<path d="M8 3.9 L6.95 1.9"/><path d="M10 3.9 L11.05 1.9"/></g>'
    + '<circle cx="6.85" cy="1.75" r="0.6" fill="#3B2B12"/>'
    + '<circle cx="11.15" cy="1.75" r="0.6" fill="#3B2B12"/>'
    // oči s odleskem a tvářičky
    + '<circle cx="7.85" cy="6.1" r="1.15" fill="#FFFFFF"/>'
    + '<circle cx="10.15" cy="6.1" r="1.15" fill="#FFFFFF"/>'
    + '<circle cx="7.75" cy="6.2" r="0.6" fill="#1A1208"/>'
    + '<circle cx="10.25" cy="6.2" r="0.6" fill="#1A1208"/>'
    + '<circle cx="8.0" cy="5.8" r="0.24" fill="#FFFFFF"/>'
    + '<circle cx="10.0" cy="5.8" r="0.24" fill="#FFFFFF"/>'
    + '<circle cx="6.95" cy="7.35" r="0.55" fill="#F08A7A" opacity="0.75"/>'
    + '<circle cx="11.05" cy="7.35" r="0.55" fill="#F08A7A" opacity="0.75"/>'
    // úsměv
    + '<path d="M8.15 7.5 Q9 8.25 9.85 7.5" stroke="#F5B942" stroke-width="0.35" '
    + 'stroke-linecap="round" fill="none"/>'
    + '</svg>';

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
      // engine 310: křídla NEpřepíná CSS animace (každá včela jindy = vlastní
      // snímek kompozitoru), ale JS v jednom tiku KlidovyTakt – třída `mih`
      // na vnitřním prvku přehazuje oba stavy naráz pro všechny
      + '.vk-a{opacity:.46}.vk-b{opacity:.10}.vk-r{opacity:.14}'
      + '.mih .vk-a{opacity:.10}.mih .vk-b{opacity:.44}.mih .vk-r{opacity:.34}'
      + '.nk-a{opacity:.46}.nk-b{opacity:.10}'
      + '.mih .nk-a{opacity:.10}.mih .nk-b{opacity:.44}'
      // otáčení padajícího listu – po krocích (12 snímků na otáčku)
      + '@keyframes listToc{from{transform:rotate(0deg)}'
      + 'to{transform:rotate(360deg)}}'
      // třpyt vlákna babího léta (v1.601.5) – po krocích
      + '@keyframes vlaknoTrpyt{0%,100%{opacity:.32}50%{opacity:.78}}';
    document.head.appendChild(st);
  })();

  let kridlaParita = 0;   // engine 310: každá druhá včela začíná s křídly obráceně
  /// Naplní vnitřní div vzhledem daného typu (zrod i přerod prvku).
  function naplnVnitrek(vnitrni, typ) {
    vnitrni.style.cssText = HMYZ_VZHLED[typ] || HMYZ_VZHLED.svetluska;
    // engine 310: náhodný počáteční stav křídel (jinak mávají jako sbor);
    // přepíná se z jednoho tiku pro všechny (viz krokKridel)
    vnitrni.classList.toggle('mih', (kridlaParita++ & 1) === 1);
    vnitrni.__kridla = typ === 'vcela' ? 1 : (typ === 'netopyr' ? 3 : 0);
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
          + (2.1 + Math.random() * 1.6).toFixed(2) + 's steps(12, end) infinite';
    } else if (typ === 'babileto') {
      vnitrni.innerHTML = BABILETO_SVG;
      vnitrni.style.animation = 'vlaknoTrpyt '
          + (1.6 + Math.random() * 1.2).toFixed(2) + 's steps(6, end) infinite';
    } else if (typ === 'vlocka') {
      vnitrni.innerHTML = VLOCKA_SVG;
      // pomalé otáčení — sníh se snáší, nepadá jak kámen
      vnitrni.style.animation = 'listToc '
          + (5 + Math.random() * 3).toFixed(2) + 's steps(16, end) infinite';
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
  const HMYZ_DEN_OD_Z = 16;
  /// engine 301 dal 0,20 na z16 → 0,60 na z19 – jenže včela je 13px prvek,
  /// takže z ní zbyly 3–4 px („hmyz zmizel", 13. 9.). Engine 311: 0,6 na z16
  /// (8 px) → 1,2 na z19 (16 px); prvky 44 px (světluška, můra) mají vlastní
  /// `velikostMusky`.
  function velikostHmyzuDen() {
    const z = Math.max(HMYZ_DEN_OD_Z, Math.min(19, mapa.getZoom()));
    return 0.6 + (z - HMYZ_DEN_OD_Z) / 3 * 0.6;
  }
  // ⭐ engine 345 (přání T 23. 9.): NETOPÝR v měřítku SVĚTA jako ptáci – rozpětí 3,5 m
  // (stylizace ~7 × 0,3 m^0,8), letí 8 m nad terénem; px na metr vodorovně na obrazovce
  // v místě a výšce netopýra (perspektiva). Dřív velikost podle zoomu s podlahou 60 %
  // → při oddálení rostl proti krajině. SVG má rozpětí 20 px.
  const NETOPYR_ROZPETI_M = 3.5, NETOPYR_NAD_M = 8;
  function meritkoNetopyra(m) {
    try {
      const tr = mapa._camera.transform, h = (typeof m.vyska === 'number' ? m.vyska : 0) + NETOPYR_NAD_M;
      const b = mapa.getBearing() * Math.PI / 180, kx = 111320 * Math.cos(m.y * Math.PI / 180);
      const a = tr.locationToScreenPoint(new maplibregl.LngLat(m.x, m.y), { getElevationForLngLat: () => h });
      const c = tr.locationToScreenPoint(new maplibregl.LngLat(m.x + Math.cos(b) * 3 / kx, m.y - Math.sin(b) * 3 / 111320),
                                         { getElevationForLngLat: () => h });
      return Math.min(3, NETOPYR_ROZPETI_M * (Math.hypot(c.x - a.x, c.y - a.y) / 3) / 20);
    } catch (e) { return 0.6; }
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
        const hM = typeof m.vyska === 'number' ? m.vyska + (m.typ === 'netopyr' ? NETOPYR_NAD_M : 0) : null;
        const p = (ter && hM !== null)
          ? tr.locationToScreenPoint(ll,
              { getElevationForLngLat: () => hM })
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
  // ⭐ engine 346 (výtka T 23. 9.: „po přesunu některé můry jakoby vyskakují (v gejzíru) na své
  // místo“): při přesunu na novou kotvu (můra/hmyz, který po posunu mapy uletěl z výřezu, nebo
  // zhaslá světluška) zůstávala VÝŠKA staré kotvy a dotahovala se lerpem 15 %/tik → můra
  // viditelně vyletěla/spadla na místo. Teď se výška nastaví HNED; bez výškopisu (terén zapnutý,
  // data ještě nejsou) se prvek neukáže, dokud výška nedorazí (`bezVysky`).
  function vyskaKotvyRoje(lon, lat) {
    const maTeren = !!(mapa.getTerrain && mapa.getTerrain());
    if (!maTeren) return 0;
    const v = mapa.queryTerrainElevation && mapa.queryTerrainElevation([lon, lat]);
    return (typeof v === 'number' && Math.abs(v) > 0.5) ? v : null;
  }
  function presunNaKotvu(m, lon, lat) {
    m.kx = lon; m.ky = lat; m.x = lon; m.y = lat;
    const v = vyskaKotvyRoje(lon, lat);
    if (v === null) { m.bezVysky = true; }
    else { m.vyska = m.vyskaCil = v; m.bezVysky = false; }
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
    // engine 329: T = násobek proti původnímu kroku 200 ms (5 Hz). Při 15 Hz je
    // T ≈ 0,33 – posun, zatáčení, dech i přerod se škálují, takže hmyz letí
    // stejně rychle jako dřív, jen po jemnějších krocích.
    const tedMs = performance.now();
    const T = Math.min(2, Math.max(0.15,
        (rojSvetlusek._posledniMs ? tedMs - rojSvetlusek._posledniMs : 200) / 200));
    rojSvetlusek._posledniMs = tedMs;
    const tikT = rojSvetlusek._tik * T;   // „tik v měřítku 5 Hz“ pro vlnění a přerod
    if (mapa.getZoom() < 13.2) rezim = null;   // jako mívala vrstva
    // ⭐ engine 301 (přání 11. 9. večer: „včelky a mouchy ať se ukazují až při
    // přiblížení, z dálky vypadají velké jako domy"): denní hmyz až od z16;
    // světlušky, můry, netopýři a vločky zůstávají od z13,2
    if ((rezim === 'den' || rezim === 'podzimden') && mapa.getZoom() < HMYZ_DEN_OD_Z) rezim = null;
    if (rojSvetlusek._rezim !== rezim) {
      rojSvetlusek._rezim = rezim;
      zrusRoj();           // jiný vzhled prvků — bazének postavit znovu
    }
    if (!rezim) return;
    const den = rezim === 'den' || rezim === 'podzimden'
        || rezim === 'zimaden';
    const kotvy = svetlaEvidence.filter((f) => f.properties.sv === 2);
    // můry krouží u OKEN vesnic (sv:1 = světla sídel)
    // engine 349: i u pouličních lamp (sv 5)
    const okna = rezim === 'podzimnoc'
        ? svetlaEvidence.filter((f) => f.properties.sv === 1 || f.properties.sv === 5)
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
        // engine 345: netopýři jen ve svém období (IV–X), v listopadu už spí
        const netopyri = !!window.__netopyriAktivni;
        if (!(okna && okna.length)) { if (!netopyri) break; typ = 'netopyr'; }
        else typ = (netopyri && musky.length % 7 === 3) ? 'netopyr' : 'mura';
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
        // engine 345: v létě létají mezi světluškami i netopýři (každý devátý)
        typ = (window.__netopyriAktivni && musky.length % 9 === 4) ? 'netopyr' : 'svetluska';
      }
      const zdrojKotev = (typ === 'mura' && okna && okna.length)
          ? okna : (kotvy.length ? kotvy : okna);
      if (!zdrojKotev || !zdrojKotev.length) break;
      const k = vyberKotvu(zdrojKotev, rezim !== 'noc');
      const [lon, lat] = k.geometry.coordinates;
      const nova = {
        kx: lon, ky: lat, x: lon, y: lat,
        smer: Math.random() * Math.PI * 2,
        // engine 346: rodí se ZHASNUTÁ a rozsvítí se (dřív denní hmyz a můry naskočily naplno)
        jas: 0,
        cil: rezim === 'noc' ? 0.4 + Math.random() * 0.6
                             : 0.9 + Math.random() * 0.1,
        typ: typ,
      };
      presunNaKotvu(nova, lon, lat);
      musky.push(nova);
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
        const VITR = smerVetru();
        zatoc = 0.22; krokM = (1.0 + Math.random() * 0.9) * silaVetru(); gumaOd = 90;
        const dv = Math.atan2(Math.sin(VITR - m.smer),
            Math.cos(VITR - m.smer));
        m.smer += dv * 0.02 * T;
      } else if (m.typ === 'list') {
        // list poskakuje větrem a kymácí se
        const VITR = smerVetru();
        zatoc = 0.5; krokM = (2.0 + Math.random() * 1.4) * silaVetru(); gumaOd = 80;
        const dv = Math.atan2(Math.sin(VITR - m.smer),
            Math.cos(VITR - m.smer));
        m.smer += (dv * 0.03
            + Math.sin((tikT + (m.rozfaze || 0)) / 5)
              * 0.22) * T;
      } else if (m.typ === 'vlocka') {
        // vločka se snáší zvolna, s jemným kolébáním po větru
        const VITR = smerVetru();
        zatoc = 0.3; krokM = (0.7 + Math.random() * 0.6) * silaVetru(); gumaOd = 100;
        const dv = Math.atan2(Math.sin(VITR - m.smer),
            Math.cos(VITR - m.smer));
        m.smer += (dv * 0.02
            + Math.sin((tikT + (m.rozfaze || 0)) / 8)
              * 0.12) * T;
      }
      m.smer += (Math.random() - 0.5) * zatoc * Math.sqrt(T);
      m.x += Math.cos(m.smer) * krokM * T * mLon;
      m.y += Math.sin(m.smer) * krokM * T * mLat;
      const dx = (m.x - m.kx) / mLon, dy = (m.y - m.ky) / mLat;
      const dal = Math.hypot(dx, dy);
      if (dal > gumaOd) {
        m.smer = Math.atan2(-dy, -dx) + (Math.random() - 0.5) * 0.6;
      }
      // dech jasu; po zhasnutí přerod u jiné kotvy
      // ⭐ v1.419: denní hmyz NEMIZÍ („ať přes den nemizí“) — jen
      // věčně krouží u kotvy s drobným třepetáním jasu 0,85–1,0.
      const dechKrok = (m.typ === 'svetluska' ? 0.027 : 0.09) * T;
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
          && ((rojSvetlusek._tik + m.rozfaze) % Math.max(1, Math.round(15 / T))) === 0
          && !naObrazovce(m.x, m.y, 80)) {
        const zk = (m.typ === 'mura' && okna && okna.length)
            ? okna : (kotvy.length ? kotvy : okna);
        const k = vyberKotvu(zk, true);
        const c = k.geometry.coordinates;
        presunNaKotvu(m, c[0], c[1]);
        m.jas = 0;                        // engine 346: na novém místě se rozsvítí, nenaskočí
      }
      if (m.bezVysky) {                   // engine 346: výška ještě není → nekreslit
        const v = vyskaKotvyRoje(m.x, m.y);
        if (v !== null) { m.vyska = m.vyskaCil = v; m.bezVysky = false; } else m.jas = 0;
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
          presunNaKotvu(m, lon, lat);     // engine 346: výška nové kotvy hned
          m.cil = 0.4 + Math.random() * 0.6;
        } else {
          m.cil = Math.random() < 0.22 ? 0 : 0.35 + Math.random() * 0.65;
        }
      }
    }
    const meritko = velikostMusky();
    const meritkoDen = velikostHmyzuDen();   // engine 301
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
        // výška hned při zrodu (engine 346: nastavuje ji presunNaKotvu; sem jen záloha)
        if (typeof m.vyska !== 'number') {
          const v0 = vyskaKotvyRoje(m.x, m.y);
          m.vyskaCil = v0 === null ? 0 : v0;
          m.vyska = m.vyskaCil;
        }
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
      const denniTyp = m.typ === 'vcela' || m.typ === 'moucha'
          || m.typ === 'babileto' || m.typ === 'list';
      const mer = m.typ === 'netopyr' ? meritkoNetopyra(m)
          : (m.typ === 'svetluska' ? meritko : (denniTyp ? meritkoDen : Math.max(podlaha, meritko) * 0.95));
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
  // ⛔ engine 247 („po rozšíření stromy lezou do silnice"): obal byl počítaný
  // pro POLOVIČNÍ šířky silnic (SILNICE_MERITKO 0,55). Od enginu 240 se kreslí
  // ve skutečné šířce, takže koruna přerostla vozovku. Hodnota = poloviční
  // šířka vozovky + ~4 m na korunu.
  const SIRKY_CAR = { motorway: 12, trunk: 11, primary: 9, secondary: 8,
                      tertiary: 7, minor: 6.2, service: 4.7, track: 4, path: 2.6 };
  const MRIZKA_CAR = 0.0025;        // ° (~280 m) – jemnější mřížka pro úseky
  // ⭐ 5. 9. 2026 večer: DRUH LESA (ZABAGED, vrstvy `les-jehlicnaty` /
  // `les-listnaty` v herním stylu) – jsou v indexu ploch, aby strom věděl,
  // v jakém lese stojí. Smíšený a neurčený les = plná směs jako dřív.
  const PLOCHY_DRUHU_LESA = ['les-jehlicnaty', 'les-listnaty'];
  // engine 218: + nové druhy (modřín 14, borovice 15 a 20, jedle 22;
  // dub 11, javor 12, bříza 13, vrba 16, javor červený 17, topol 19, jeřáb 25)
  const STROMY_JEHLICNATE = ['deko-strom-6', 'deko-strom-7', 'deko-strom-8',
                             'deko-strom-9', 'deko-strom-10', 'deko-strom-14',
                             'deko-strom-15', 'deko-strom-20', 'deko-strom-22'];
  const STROMY_LISTNATE = ['deko-strom-1', 'deko-strom-2', 'deko-strom-3',
                           'deko-strom-4', 'deko-strom-5', 'deko-strom-11',
                           'deko-strom-12', 'deko-strom-13', 'deko-strom-16',
                           'deko-strom-17', 'deko-strom-19', 'deko-strom-25'];
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
      if (!v.source || !v['source-layer']) continue;
      if (v.layout && v.layout.visibility === 'none') continue;
      // engine 308: sloučená vrstva nese původní členy (id + filtr + zoomy)
      // v metadata.okolnik.casti – index je čte, jako by vrstvy dál existovaly
      const casti = (v.metadata && v.metadata.okolnik && v.metadata.okolnik.casti) || [v];
      for (const c of casti) {
        const nosna = !!NOSNE[c.id];
        const cara = !!CARY_ZAKAZ[c.id];
        if (!nosna && !cara && SVEDCI.indexOf(c.id) < 0) continue;
        out.push({ id: c.id, zdroj: v.source, vrstva: v['source-layer'],
                   filtr: c.filter, nosna, cara,
                   zmin: c.minzoom == null ? v.minzoom : c.minzoom,
                   zmax: c.maxzoom == null ? v.maxzoom : c.maxzoom });
        zdroje.add(v.source);
      }
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
  // ⭐ engine 300: stavba indexu PO VRSTVÁCH (generátor) – `querySourceFeatures`
  // pro ~17 vrstev krajiny stálo 17–37 ms v jednom kroku hned po zastavení.
  // Rozpočet převodu geometrie počítá jen AKTIVNÍ čas (mezi yieldy se čeká
  // na další snímek). Starý index platí, dokud nový nedoběhne.
  function postavIndex() { for (const _ of postavIndexGen()) { /* synchronně */ } }
  function* postavIndexGen() {
    if (!mapa) return;
    const defs = definicePloch();
    if (!defs || !defs.length) { idxMrizka = null; return; }
    const z = mapa.getZoom();
    let spotreba = 0;
    let tKrok = performance.now();
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
        if (rozpocetVycerpan || spotreba + (performance.now() - tKrok) > PREVOD_ROZPOCET_MS) {
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
      spotreba += performance.now() - tKrok;
      yield;   // engine 300: další vrstva v dalším kroku dávky
      tKrok = performance.now();
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
  /// engine 300: totéž po dávkách – pro generátor `doplnJadro` (`yield*`)
  function* zajistiIndexGen() {
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
    try { yield* postavIndexGen(); } catch (e) {
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
  /// dlaždic zdroje `krajina` (dnes krajina7.pmtiles). Dedup klíčem
  /// souřadnic (body) / 8 m buňkou
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

  // ⭐ engine 300 (krok 3 opatrného návratu): PO DÁVKÁCH. `dopln()` na `moveend`
  // stálo 23–55 ms v jednom snímku (změřeno po posluchačích 11. 9.) – při
  // sledování hráče přijde moveend s každým fixem, tedy záškub každé 2 s.
  // Jádro je generátor, hnací smyčka odbaví ≤ 4 ms na snímek; při prstu na
  // mapě čeká; nový `dopln()` rozpracovaný průchod zruší a začne znovu (keš
  // buněk zůstává, takže opakování je levné).
  let doplnBeh = null;
  function dopln() {
    if (wStav === 1) { wNaplanujSvetla(); return; }   // engine 336: generuje worker
    if (doplnBeh) doplnBeh.zrus = true;
    const beh = { zrus: false, it: null, ms: 0 };
    doplnBeh = beh;
    try { beh.it = doplnJadro(); } catch (e) { console.warn('[dekorace] dopln', e); doplnBeh = null; return; }
    const krok = () => {
      if (beh.zrus) return;
      if (typeof prstuNaMape !== 'undefined' && prstuNaMape) { requestAnimationFrame(krok); return; }
      const t0 = performance.now();
      let hotovo = false;
      try {
        while (performance.now() - t0 < 4) { const r = beh.it.next(); if (r.done) { hotovo = true; break; } }
      } catch (e) { console.warn('[dekorace] dopln krok', e); hotovo = true; }
      beh.ms += performance.now() - t0;
      if (hotovo) { zapisCas('dopln', beh.ms); if (doplnBeh === beh) doplnBeh = null; return; }
      requestAnimationFrame(krok);
    };
    krok();
  }
  function* doplnJadro() {
    let bunekOdYield = 0;
    if (!mapa || !ikonyHotove) return;   // malby se ještě stahují
    const z = mapa.getZoom();
    // ⚠️ MUSÍ SEDĚT S NEJNIŽŠÍM `z0` V `DRUHY` (stromy 13,25 = 54 %
    // ukazatele) A S `minzoom` VRSTVY. Když tu zůstane vyšší číslo, jsou
    // prahy druhů mrtvé písmeno a stromy prostě nikdy nenastoupí —
    // přesně tak tu 8. 8. přežilo 14,0 proti stromům od 13,25.
    if (z < 13.2 - DZ) return;       // objekty ještě nejsou na scéně (engine 321: dohled)
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
      if (cfg.kotva) continue;              // engine 340: kotvy animací jen z workeru
      if (z < cfg.z0 - 0.4 - DZ) continue;
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
          if ((++bunekOdYield & 127) === 0) yield;   // engine 300: dávky
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
          yield* zajistiIndexGen();   // engine 300: index po vrstvách
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

    yield;   // engine 300: přesné dekorace, prořez a setData v dalším snímku
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
      // engine 264: světla sídel (sv 1) jdou do vlastního zdroje, stromy bez nich
      const svetlaFeat = featury.filter((f) => f.properties.sv === 1);
      const kolekce = { type: 'FeatureCollection',
                        features: svetlaFeat.length ? featury.filter((f) => f.properties.sv !== 1) : featury };
      const kolekceSvetel = { type: 'FeatureCollection', features: svetlaFeat };
      const zdroj = mapa.getSource('dekorace');
      if (zdroj) {
        const zs = mapa.getSource('dekorace-svetla-zdroj');
        if (zs) {
          const ps = svetlaFeat.length + ':' + (svetlaFeat.length ? posledniPodpis(svetlaFeat) : '');
          if (ps !== svetlaPodpis) {
            svetlaPodpis = ps;
            if (typeof zapisAzVKlidu === 'function') {
              zapisAzVKlidu('deko-svetla', () => zs.setData(kolekceSvetel));
            } else {
              zs.setData(kolekceSvetel);
            }
          }
        }
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
            zapisAzVKlidu('deko', () => { zdroj.setData(kolekce); zapsaneFeatury = kolekce.features; });
          } else {
            zdroj.setData(kolekce);
            zapsaneFeatury = kolekce.features;
          }
        }
      } else if (featury.length) {
        svetlaPodpis = svetlaFeat.length + ':' + (svetlaFeat.length ? posledniPodpis(svetlaFeat) : '');
        pridejVrstvu(kolekce, kolekceSvetel);   // líné založení s prvními daty
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
  // ⭐ engine 334: co je PRÁVĚ ZAPSANÉ ve zdroji `dekorace` (tytéž objekty
  // Feature). Stíny stromů v main.js čtou tohle místo
  // querySourceFeatures('dekorace'), které prvky znovu skládá z dlaždic –
  // změřeno na TT 23. 9.: 38 ms na přepočet stínů (z14,6, 1 400 prvků).
  let zapsaneFeatury = [];

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

  // =========================================================================
  // ⭐⭐ engine 336: DEKORACE VE WORKERU (krok 3 plánu výkonu, 23. 9. 2026)
  // =========================================================================
  // Index ploch (querySourceFeatures + převod geometrie) stál hlavní vlákno
  // 59–219 ms na jedno sestavení (TT 23. 9., z15,2) a dosyp běžel po 4 ms
  // v každém snímku. Teď body generuje js/dekorace-worker.js: sám čte
  // dlaždice krajiny (PMTiles přes proxy s keší na disku) a posílá je mapě
  // jako vektorové dlaždice protokolu dekorace:// (z12–15). Na mlhu a výšku
  // terénu se ptá sem (Mlha.jeObjeveno, DEM), světla sídel, kotvy roje
  // a stromy pro stíny chodí zpátky jako „evidence“ dlaždice.
  // Záloha: starý generátor na hlavním vlákně, když worker nejde / selže.
  // A/B: localStorage `okolnikDekoraceWorker` = '0' (platí po načtení stylu)
  // nebo window.__okolnikDekoraceWorker = false.
  let wDek = null;
  let wStav = 0;                     // 0 nezkoušeno, 1 worker, −1 starý generátor, −2 selhal
  let wVerze = 1;
  let wId = 0;
  const wCekani = new Map();         // id → resolve
  const wEvidence = new Map();       // 'z/x/y' → { z, x, y, sv, stromy, pf }
  const wChyby = new Map();          // 'z/x/y' → pokusů
  let wSvetlaT = null, wMlhaT = null, wMlhaReset = false;
  const wStat = { dlazdic: 0, prvku: 0, mlhaBodu: 0, mlhaMs: 0, demDotazu: 0, chyb: 0 };

  function wZapnuto() {
    if (window.__okolnikDekoraceWorker === false) return false;
    try { if (localStorage.getItem('okolnikDekoraceWorker') === '0') return false; } catch (e) { /* nic */ }
    return typeof Worker !== 'undefined' && typeof maplibregl !== 'undefined' && !!maplibregl.addProtocol;
  }
  /// URL archivů PMTiles zdrojů ploch; null = některý zdroj není PMTiles
  function wZdroje(defs) {
    const st = mapa.getStyle().sources || {};
    const out = {};
    const ids = new Set(defs.map((d) => d.zdroj));
    if (st.krajina) ids.add('krajina');
    for (const id of ids) {
      const zd = st[id];
      if (!zd) continue;
      const url = zd.url || '';
      if (!url.startsWith('pmtiles://')) return null;
      out[id] = url.slice('pmtiles://'.length);
    }
    // engine 349: drobnosti z OSM – samostatný archiv (není ve stylu, čte ho jen worker)
    // engine 350: drobnosti2 = + stromy z OSM; lampy_mesta1 = Brno (CC BY 4.0), Plzeň, Děčín
    // engine 352: drobnosti3 = + výstražníky, semafory, závory (a zebry pro styl); lampy_mesta2 = + ruční lampy
    // engine 356: drobnosti4 = + kontrolní body OSM (kříže, pomníky, pítka) pro vyřazení dvojníků z DTM
    try { out.drobnosti = r2('drobnosti4.pmtiles').slice('pmtiles://'.length); } catch (e) { /* bez drobností */ }
    // engine 356: body DTM ČR (studny, kříže a boží muka, pomníky) – archiv dtm2, vrstva `body`
    try { out.dtmbody = r2('dtm2.pmtiles').slice('pmtiles://'.length); } catch (e) { /* bez DTM bodů */ }
    // engine 357: elektrické vedení – ZABAGED (CC BY 4.0) a OSM (ODbL) ZVLÁŠŤ, dvojníky vyřadí worker
    try { out.vedenizab = r2('vedeni_zab1.pmtiles').slice('pmtiles://'.length); } catch (e) { /* bez vedení */ }
    try { out.vedeniosm = r2('vedeni_osm1.pmtiles').slice('pmtiles://'.length); } catch (e) { /* bez vedení OSM */ }
    // engine 354: lampy_mesta4 = ruční lampa Sezemice 52 u začátku horního vjezdu na točnu (T 24. 9.)
    try { out.lampymesta = r2('lampy_mesta4.pmtiles').slice('pmtiles://'.length); } catch (e) { /* bez lamp měst */ }
    return out;
  }
  function wNastaveni() {
    const defs = (definicePloch() || []).filter((d) => d.nosna || d.cara);
    if (!defs.length) return null;
    const zdroje = wZdroje(defs);
    if (!zdroje) return null;
    let ex = 1;
    try { ex = (mapa.getTerrain && mapa.getTerrain() && +mapa.getTerrain().exaggeration) || 1; } catch (e) { ex = 1; }
    return {
      verze: wVerze, herni: true, sezona: sezonaMalby(), dz: DZ, ex,
      druhy: DRUHY, jehlicnate: STROMY_JEHLICNATE, listnate: STROMY_LISTNATE,
      plochy: defs.map((d) => ({ id: d.id, zdroj: d.zdroj, vrstva: d.vrstva,
                                 filtr: d.filtr === undefined ? null : d.filtr,
                                 nosna: d.nosna, cara: d.cara,
                                 zmin: d.zmin == null ? null : d.zmin,
                                 zmax: d.zmax == null ? null : d.zmax })),
      zdroje, sirkyCar: SIRKY_CAR, rampa: RAMPA_ZAKLAD, sirkaNastupu: SIRKA_NASTUPU,
      rampaVys: RAMPA_VYS_ZAKLAD, drobnosti: drobnostiProWorker(),   // engine 349
      vedeni: VEDENI_CFG,                                            // engine 357
      ploty: true,                                                   // engine 358: 3D ploty z čar DTM
    };
  }
  function wPripravit() {
    if (wStav === -2) return;          // selhal – do konce běhu starý generátor
    wStav = 0;
    if (!wZapnuto()) { wStav = -1; return; }
    let cfg = null;
    try { cfg = wNastaveni(); } catch (e) { cfg = null; }
    if (!cfg) { wStav = -1; return; }
    try {
      if (!wDek) {
        const sk = Array.from(document.scripts).find((x) => /\/dekorace\.js/.test(x.src || ''));
        const q = sk && sk.src.indexOf('?') >= 0 ? sk.src.slice(sk.src.indexOf('?')) : '';
        wDek = new Worker('js/dekorace-worker.js' + q);
        wDek.onmessage = wZprava;
        wDek.onerror = (e) => wSelhal('onerror ' + (e && e.message ? e.message : e));
      }
      wProtokol();
      wDek.postMessage(Object.assign({ typ: 'nastav' }, cfg));
      wStav = 1;
      if (stinyP) wDek.postMessage(Object.assign({ typ: 'svetlo' }, stinyP));   // engine 357
      wPredgenZapoj();                   // engine 355
    } catch (e) { wStav = -1; console.warn('[dekorace] worker nejde:', e); }
  }
  // ⭐ engine 355 (T 24. 9.: „chtěl bych, aby to už všechno bylo načtené a já jen létal nad hotovou krajinou“):
  // PŘEDGENEROVÁNÍ – 0,5 s po zklidnění pošle workeru dlaždice, které přijdou na řadu při dalším gestu: prstenec
  // kolem výřezu na aktuální úrovni (posun), úroveň níž na dvojnásobném okně (oddálení) a úroveň výš uprostřed
  // (přiblížení). Seřazené od středu, nejvýš 64. Začátek pohybu frontu zastaví (skutečné dlaždice mají přednost).
  let predgenCas = null;
  function wPredgenPlan() {
    clearTimeout(predgenCas);
    predgenCas = setTimeout(wPredgenPosli, 500);
  }
  function wPredgenStop() {
    clearTimeout(predgenCas);
    try { if (wDek && wStav === 1) wDek.postMessage({ typ: 'predgeneruj', dlazdice: [] }); } catch (e) { /* nic */ }
    try { if (wDek && wStav === 1) wDek.postMessage({ typ: 'predstin', dlazdice: [] }); } catch (e) { /* nic */ }
  }
  function wPredgenPosli() {
    try {
      if (!wDek || wStav !== 1 || !mapa || !mapa.getSource('dekorace') || mapa.isMoving()) return;
      if (document.visibilityState !== 'visible') return;
      const z = mapa.getZoom();
      if (z < 12.8) return;
      const b = mapa.getBounds(), c = mapa.getCenter();
      const L = Math.max(13, Math.min(15, Math.floor(z)));
      const tx = (lon, n) => Math.floor((lon + 180) / 360 * n);
      const ty = (lat, n) => {
        const r = Math.max(-85, Math.min(85, lat)) * Math.PI / 180;
        return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
      };
      const seznam = [], vid = new Set();
      const okno = (zz, w, s, e, nn, max) => {
        const n = Math.pow(2, zz);
        const x0 = tx(w, n), x1 = tx(e, n), y0 = ty(nn, n), y1 = ty(s, n);
        const cx = tx(c.lng, n), cy = ty(c.lat, n);
        const k = [];
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) k.push([Math.hypot(x - cx, y - cy), x, y]);
        k.sort((p, q) => p[0] - q[0]);
        let pocet = 0;
        for (const [, x, y] of k) {
          if (pocet >= max) break;
          const kl = zz + '/' + x + '/' + y;
          if (vid.has(kl)) continue;
          vid.add(kl); seznam.push({ z: zz, x, y }); pocet++;
        }
      };
      const dLon = b.getEast() - b.getWest(), dLat = b.getNorth() - b.getSouth();
      okno(L, b.getWest() - dLon * 0.5, b.getSouth() - dLat * 0.5, b.getEast() + dLon * 0.5, b.getNorth() + dLat * 0.5, 32);
      if (L - 1 >= 13) okno(L - 1, b.getWest() - dLon, b.getSouth() - dLat, b.getEast() + dLon, b.getNorth() + dLat, 18);
      if (L + 1 <= 15) okno(L + 1, c.lng - dLon * 0.3, c.lat - dLat * 0.3, c.lng + dLon * 0.3, c.lat + dLat * 0.3, 14);
      wDek.postMessage({ typ: 'predgeneruj', dlazdice: seznam });
      // ⭐ engine 357: stíny po dlaždicích – úroveň rastru = zaokrouhlený zoom (dlaždice 512), prstenec kolem
      // výřezu a sousední úrovně; worker je nakreslí do keše až po dekoracích (jen pohodlí navíc)
      if (stinyP && stinyP.kryti > 0 && z >= 14.3 && mapa.getSource('stiny-domu')) {
        const zs = Math.max(15, Math.min(18, Math.round(z)));
        const puvodni = seznam.length;
        okno(zs, b.getWest() - dLon * 0.5, b.getSouth() - dLat * 0.5, b.getEast() + dLon * 0.5, b.getNorth() + dLat * 0.5, 30);
        if (zs + 1 <= 18) okno(zs + 1, c.lng - dLon * 0.3, c.lat - dLat * 0.3, c.lng + dLon * 0.3, c.lat + dLat * 0.3, 10);
        if (zs - 1 >= 15) okno(zs - 1, b.getWest() - dLon, b.getSouth() - dLat, b.getEast() + dLon, b.getNorth() + dLat, 12);
        const stiny = seznam.splice(puvodni);
        if (stiny.length) wDek.postMessage({ typ: 'predstin', verze: stinyP.verze, dlazdice: stiny });
      }
    } catch (e) { /* předgenerování je jen pohodlí navíc */ }
  }
  let predgenHook = null;
  function wPredgenZapoj() {
    if (!mapa || predgenHook === mapa) return;
    predgenHook = mapa;
    mapa.on('idle', wPredgenPlan);
    mapa.on('movestart', wPredgenStop);
  }
  function wPridejVrstvu() {
    if (wStav !== 1 || !mapa || mapa.getSource('dekorace')) return;
    try { pridejVrstvu(null, null, true); } catch (e) { console.warn('[dekorace] vrstva workeru', e); }
  }
  function wProtokol() {
    if (wProtokol.hotovo || typeof maplibregl === 'undefined' || !maplibregl.addProtocol) return;
    wProtokol.hotovo = true;
    maplibregl.addProtocol('dekorace', async (params) => {
      const m = /dekorace:\/\/v(\d+)\/(\d+)\/(\d+)\/(\d+)/.exec((params && params.url) || '');
      if (!m || !wDek || wStav !== 1) return { data: new ArrayBuffer(0) };
      const z = +m[2], x = +m[3], y = +m[4];
      const odp = await wPozadej({ typ: 'dlazdice', z, x, y });
      if (!odp || odp.chyba || !odp.data) {
        wChybaDlazdice(z, x, y, odp && odp.chyba);
        throw new Error('dekorace ' + z + '/' + x + '/' + y + ': ' + ((odp && odp.chyba) || 'bez odpovědi'));
      }
      wStat.dlazdic++;
      if (odp.ev) { wStat.prvku += odp.ev.prvku || 0; wUlozEvidenci(z, x, y, odp.ev); }
      return { data: odp.data };
    });
  }
  function wPozadej(zprava) {
    return new Promise((res) => {
      if (!wDek) { res(null); return; }
      const id = ++wId;
      const t = setTimeout(() => { if (wCekani.delete(id)) res(null); }, 20000);
      wCekani.set(id, (m) => { clearTimeout(t); res(m); });
      zprava.id = id;
      try { wDek.postMessage(zprava); } catch (e) { wCekani.delete(id); clearTimeout(t); res(null); }
    });
  }
  function wZprava(ev) {
    const m = ev.data || {};
    if (m.typ === 'dlazdice' || m.typ === 'stav' || m.typ === 'stin') {
      const f = wCekani.get(m.id);
      if (f) { wCekani.delete(m.id); f(m); }
      return;
    }
    if (m.typ === 'mlha') { wOdpovezMlha(m); return; }
    if (m.typ === 'silueta') { wOdpovezSilueta(m); return; }     // engine 357
    if (m.typ === 'dem') { wOdpovezDem(m); return; }
    if (m.typ === 'obnov') {
      try {
        if (mapa && mapa.getSource('dekorace') && mapa.refreshTiles) mapa.refreshTiles('dekorace', m.dlazdice);
      } catch (e) { /* styl se zrovna mění */ }
      return;
    }
    if (m.typ === 'chyba') wSelhal(m.msg);
  }
  /// ⭐ engine 357: STÍNY PO DLAŽDICÍCH – světlo, dlaždice, silueta spritu stromu (alfa v barvě stínu, main.js)
  let stinyP = null;
  function wNastavStiny(p) {
    stinyP = p;
    try { if (wDek && wStav === 1) wDek.postMessage(Object.assign({ typ: 'svetlo' }, p)); } catch (e) { /* nic */ }
  }
  async function wStinDlazdice(z, x, y, verze) {
    // worker se teprve chystá (start mapy) → počkat, jinak by dlaždice téhle verze zůstala prázdná
    for (let i = 0; i < 50 && wStav === 0; i++) await new Promise((res) => setTimeout(res, 200));
    if (!wDek || wStav !== 1) return null;
    return wPozadej({ typ: 'stin', z, x, y, verze });
  }
  function wOdpovezSilueta(m) {
    let s = null;
    try { s = (typeof siluetaSpritu === 'function') ? siluetaSpritu(m.ik) : null; } catch (e) { s = null; }
    try {
      if (s && s.px && s.w && s.h) {
        const px = s.px.slice().buffer;
        wDek.postMessage({ typ: 'silueta', id: m.id, w: s.w, h: s.h, px }, [px]);
      } else wDek.postMessage({ typ: 'silueta', id: m.id, w: 0, h: 0, px: null });
    } catch (e) { /* worker pryč */ }
  }
  /// mlha pro body z workeru – TÝŽ dotaz jako starý generátor (memo v Mlha)
  function wOdpovezMlha(m) {
    const t0 = performance.now();
    const b = m.body;
    const n = b.length / 2;
    const out = new Uint8Array(n);
    const M = (typeof Mlha !== 'undefined' && Mlha && typeof Mlha.jeObjeveno === 'function') ? Mlha : null;
    for (let i = 0; i < n; i++) {
      let ok = true;
      if (M) { try { ok = M.jeObjeveno(b[2 * i], b[2 * i + 1]); } catch (e) { ok = true; } }
      out[i] = ok ? 1 : 0;
    }
    wStat.mlhaBodu += n; wStat.mlhaMs += performance.now() - t0;
    try { if (wDek) wDek.postMessage({ typ: 'mlha', id: m.id, maska: out }, [out.buffer]); } catch (e) { /* nic */ }
  }
  /// výška terénu (DemSource jako stíny kopců) – kopie, originál je v keši
  function wOdpovezDem(m) {
    wStat.demDotazu++;
    const posli = (d) => {
      try { if (wDek) wDek.postMessage({ typ: 'dem', id: m.id, data: d }, d ? [d.buffer] : []); } catch (e) { /* nic */ }
    };
    const D = window.__okolnikDem;
    if (!D || !D.getDemTile) { posli(null); return; }
    D.getDemTile(m.z, m.x, m.y)
      .then((t) => posli((t && t.data && t.width === 256) ? new Float32Array(t.data) : null))
      .catch(() => posli(null));
  }
  function wChybaDlazdice(z, x, y, proc) {
    const k = z + '/' + x + '/' + y;
    const n = (wChyby.get(k) || 0) + 1;
    wChyby.set(k, n);
    wStat.chyb++;
    if (wStat.chyb <= 5) console.warn('[dekorace] dlaždice', k, proc || '');
    // zkusit znovu (MapLibre chybnou dlaždici sám znovu nežádá)
    if (n <= 3) {
      setTimeout(() => {
        try { if (mapa && mapa.getSource('dekorace')) mapa.refreshTiles('dekorace', [{ z, x, y }]); } catch (e) { /* nic */ }
      }, 2500 * n);
    }
  }
  function wSelhal(msg) {
    if (wStav === -2) return;
    console.warn('[dekorace] worker → starý generátor:', msg);
    wStav = -2;
    try { if (wDek) wDek.terminate(); } catch (e) { /* nic */ }
    wDek = null;
    for (const f of wCekani.values()) f(null);
    wCekani.clear();
    wEvidence.clear();
    try {
      if (mapa) {
        for (const id of ['akvarel-dekorace', 'dekorace-svetla', 'dekorace-lampy']) if (mapa.getLayer(id)) mapa.removeLayer(id);
        for (const id of ['dekorace', 'dekorace-svetla-zdroj']) if (mapa.getSource(id)) mapa.removeSource(id);
      }
    } catch (e) { /* nic */ }
    dekoracePodpis = ''; svetlaPodpis = '';
    try { naplanujDosyp(); dopln(); } catch (e) { /* nic */ }
  }
  /// nová verze URL = MapLibre přenačte všechny dlaždice (dohled, reset mlhy)
  function wPrenacti(sNastavenim) {
    wVerze++;
    if (sNastavenim && wDek) {
      let cfg = null;
      try { cfg = wNastaveni(); } catch (e) { cfg = null; }
      if (cfg) wDek.postMessage(Object.assign({ typ: 'nastav' }, cfg));
      if (cfg && stinyP) wDek.postMessage(Object.assign({ typ: 'svetlo' }, stinyP));   // engine 357
    }
    try {
      const zd = mapa && mapa.getSource('dekorace');
      if (zd && zd.setTiles) zd.setTiles(['dekorace://v' + wVerze + '/{z}/{x}/{y}']);
    } catch (e) { /* styl se zrovna mění */ }
  }
  /// odkrytí mlhy (kruh) / reset (null) – worker přeptá neobjevené body
  function wZmenaMlhy(o) {
    if (o === null) wMlhaReset = true;
    clearTimeout(wMlhaT);
    wMlhaT = setTimeout(() => {
      if (!wDek || wStav !== 1) return;
      if (wMlhaReset) {
        wMlhaReset = false;
        wDek.postMessage({ typ: 'mlha-zmena', o: null });
        wPrenacti(false);
      } else {
        wDek.postMessage({ typ: 'mlha-zmena', o: {} });
      }
    }, 700);
  }
  /// ⭐ engine 345 (výtka T 23. 9.: „stíny stromů se stále načtou až po zastavení“):
  /// stromy (evidence) pro CELÝ rozsah plátna stínů PŘEDEM – MapLibre žádá jen dlaždice
  /// výřezu, takže stromy v okraji plátna chyběly a jejich stíny naskočily až po zastavení.
  /// Worker je vyrobí hned (a má je v keši, až je mapa při posunu bude chtít).
  const wPrip = new Set();
  function wPripravOblast(w, s, e, n) {
    if (!wDek || wStav !== 1 || !mapa) return Promise.resolve(0);
    let zD = 14;
    try { zD = Math.max(12, Math.min(15, Math.floor(mapa.getZoom()))); } catch (er) { /* nic */ }
    const N = Math.pow(2, zD);
    const tx = (lon) => Math.floor((lon + 180) / 360 * N);
    const tyF = (lat) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N; };
    const x0 = tx(w), x1 = tx(e), y0 = Math.floor(tyF(n)), y1 = Math.floor(tyF(s));
    let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    try { const c = mapa.getCenter(); cx = (c.lng + 180) / 360 * N; cy = tyF(c.lat); } catch (er) { /* nic */ }
    const fronta = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = zD + '/' + x + '/' + y;
      if (wEvidence.has(k) || wPrip.has(k)) continue;
      fronta.push([x, y, (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2]);
    }
    if (!fronta.length) return Promise.resolve(0);
    fronta.sort((a, b) => a[2] - b[2]);
    if (fronta.length > 60) fronta.length = 60;
    let nove = 0, i = 0;
    const jeden = () => {
      if (i >= fronta.length) return Promise.resolve();
      const [x, y] = fronta[i++];
      const k = zD + '/' + x + '/' + y;
      wPrip.add(k);
      return wPozadej({ typ: 'dlazdice', z: zD, x, y }).then((odp) => {
        wPrip.delete(k);
        if (odp && !odp.chyba && odp.ev) { wUlozEvidenci(zD, x, y, odp.ev); nove++; }
      }).then(jeden);
    };
    return Promise.all([jeden(), jeden(), jeden()]).then(() => nove);
  }
  function wUlozEvidenci(z, x, y, ev) {
    const k = z + '/' + x + '/' + y;
    wEvidence.delete(k);
    wEvidence.set(k, { z, x, y, sv: ev.sv || [], stromy: ev.stromy, pf: null,
                       draty: ev.draty || null, vrtule: ev.vrtule || null });   // engine 357
    while (wEvidence.size > 140) wEvidence.delete(wEvidence.keys().next().value);
    wKotvyVerze++;
    if (ev.draty || ev.vrtule) wVedeniVerze++;
    // ⭐ engine 358: 3D ploty jen z dlaždic z15 (úseky ve zlomcích dlaždice, ploty3d.js); null = dlaždice bez plotů
    if (z === 15 && 'ploty' in ev) {
      const bylo = wPloty.has(k);
      wPloty.delete(k);
      if (ev.ploty && ev.ploty.length) wPloty.set(k, { x, y, d: ev.ploty });
      while (wPloty.size > 64) wPloty.delete(wPloty.keys().next().value);
      if (bylo || wPloty.has(k)) wPlotyVerze++;
    }
    // ⭐ engine 358: místa odlesků na vodě (animace.js) – [fx, fy, e]… z dlaždic z15
    if (z === 15 && 'voda' in ev) {
      const bylo = wVoda.has(k);
      wVoda.delete(k);
      if (ev.voda && ev.voda.length) wVoda.set(k, { x, y, d: ev.voda });
      while (wVoda.size > 64) wVoda.delete(wVoda.keys().next().value);
      if (bylo || wVoda.has(k)) wVodaVerze++;
    }
    wNaplanujSvetla();
  }
  const wPloty = new Map(), wVoda = new Map();
  let wPlotyVerze = 0, wVodaVerze = 0;
  /// ⭐ engine 357: rozpětí vodičů a vrtule větrníků ze všech dlaždic evidence (bez dvojníků): { verze, draty:
  /// Float64Array [a,b,c,d,ha,hb,t]…, vrtule: [lon,lat,h]… }. Kreslí vedeni3d.js (dráty) a animace.js (listy).
  let wVedeniVerze = 0, wVedeniKes = null;
  function wVedeni() {
    if (wVedeniKes && wVedeniKes.verze === wVedeniVerze) return wVedeniKes;
    const vid = new Set(), d = [], v = [];
    for (const t of wEvidence.values()) {
      const D = t.draty;
      if (D) {
        for (let i = 0; i + 6 < D.length; i += 7) {
          const k = Math.round(D[i] * 1e6) + ',' + Math.round(D[i + 1] * 1e6) + ',' + Math.round(D[i + 2] * 1e6) + ',' + Math.round(D[i + 3] * 1e6);
          if (vid.has(k)) continue;
          vid.add(k);
          for (let j = 0; j < 7; j++) d.push(D[i + j]);
        }
      }
      const W = t.vrtule;
      if (W) {
        // ⛔ poloha větrníku je z geometrie dlaždice – na z14 a z15 se liší o kvantizaci (~0,5 m) → klíč po ~10 m
        // i se sousedy (prohlížeč 24. 9.: tentýž větrník ze dvou zoomů = dva rotory, šest listů)
        for (let i = 0; i + 2 < W.length; i += 3) {
          const gx = Math.round(W[i] * 1e4), gy = Math.round(W[i + 1] * 1e4);
          let uz = false;
          for (let a = -1; a <= 1 && !uz; a++) for (let b = -1; b <= 1; b++) if (vid.has('w' + (gx + a) + ',' + (gy + b))) { uz = true; break; }
          if (uz) continue;
          vid.add('w' + gx + ',' + gy);
          v.push(W[i], W[i + 1], W[i + 2]);
        }
      }
    }
    wVedeniKes = { verze: wVedeniVerze, draty: Float64Array.from(d), vrtule: Float64Array.from(v) };
    return wVedeniKes;
  }
  /// ⭐ engine 340: kotvy animací nad mapou (animace.js) z evidence dlaždic z15 –
  /// komíny (sv:3, těžiště domů) a voda (sv:4); jen objevené (worker je pustí přes mlhu)
  let wKotvyVerze = 0;
  function wKotvyAnimaci() {
    const out = { komin: [], voda: [] };
    if (wStav !== 1) return out;
    const vid = new Set();
    for (const t of wEvidence.values()) {
      if (t.z !== 15) continue;
      for (const f of t.sv) {
        if (f.sv !== 3 && f.sv !== 4) continue;
        const k = f.sv + ':' + f.id;
        if (vid.has(k)) continue;
        vid.add(k);
        (f.sv === 3 ? out.komin : out.voda).push(f);
      }
    }
    return out;
  }
  /// ptáci nad mapou (animace.js, engine 342): kolik kotev komínů (3), vody (4) a světel
  /// sídel (1, jsou na všech úrovních) leží v obdélníku – výběr druhu podle okolí
  function wKontextPtaku(w, s, e, n) {
    const out = { komin: 0, voda: 0, svetla: 0 };
    if (wStav !== 1) return out;
    const vid = new Set();
    for (const t of wEvidence.values()) {
      for (const f of t.sv) {
        if (f.lon < w || f.lon > e || f.lat < s || f.lat > n) continue;
        const k = f.sv + ':' + f.id;
        if (vid.has(k)) continue;
        vid.add(k);
        if (f.sv === 3) { if (f.r > 0) out.komin++; }     // engine 354: jen kouřící (dřív ~35 % domů)
        else if (f.sv === 4) out.voda++;
        else if (f.sv === 1) out.svetla++;
      }
    }
    return out;
  }
  function wNaplanujSvetla() {
    if (wSvetlaT) return;
    wSvetlaT = setTimeout(() => { wSvetlaT = null; wObnovSvetla(); }, 400);
  }
  /// světla sídel (vlastní zdroj, mihotání), kotvy roje a díry nočního
  /// překryvu z evidence dlaždic ve výřezu ± půl obrazovky (jako dřív)
  function wObnovSvetla() {
    if (!mapa || wStav !== 1) return;
    let b = null;
    try { b = mapa.getBounds(); } catch (e) { return; }
    const w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
    const rw = (e - w) * 0.5, rh = (n - s) * 0.5;
    const podleId = new Map();
    for (const t of wEvidence.values()) {
      for (const f of t.sv) {
        if (f.sv !== 1 && f.sv !== 2 && f.sv !== 5) continue;   // engine 340: 3/4 = kotvy animací; 349: 5 = lampa
        if (f.lon < w - rw || f.lon > e + rw || f.lat < s - rh || f.lat > n + rh) continue;
        const k = f.sv + ':' + f.id;              // týž bod z různých úrovní má totéž id
        if (!podleId.has(k)) podleId.set(k, f);
      }
    }
    const featury = [];
    for (const f of podleId.values()) {
      if (f.sv === 5) {                         // engine 349: svit lampy – k jako kresba lampy
        featury.push({ type: 'Feature', id: f.id, properties: { ik: f.ik, k: f.r, sv: 5 },
                       geometry: { type: 'Point', coordinates: [f.lon, f.lat] } });
        continue;
      }
      const cfg = DRUHY[f.sv === 1 ? 'svetlo' : 'svetluska'];
      featury.push({ type: 'Feature', id: f.id,
                     properties: Object.assign({ ik: f.ik, k: cfg.k, sv: f.sv, rot: 0 }, nastup(cfg.z0)),
                     geometry: { type: 'Point', coordinates: [f.lon, f.lat] } });
    }
    svetlaEvidence = featury;
    const svetlaFeat = featury.filter((f) => f.properties.sv === 1 || f.properties.sv === 5);
    try {
      window.__svetlaBody = svetlaFeat.filter((f) => f.properties.sv === 1).map((f) => f.geometry.coordinates);
      if (window.__nocniDiry) window.__nocniDiry();
    } catch (err) { /* nevadí */ }
    const zs = mapa.getSource('dekorace-svetla-zdroj');
    if (!zs) return;
    const ps = svetlaFeat.length + ':' + (svetlaFeat.length ? posledniPodpis(svetlaFeat) : '');
    if (ps === svetlaPodpis) return;
    svetlaPodpis = ps;
    const kolekce = { type: 'FeatureCollection', features: svetlaFeat };
    if (typeof zapisAzVKlidu === 'function') zapisAzVKlidu('deko-svetla', () => zs.setData(kolekce));
    else zs.setData(kolekce);
  }
  /// stromy pro stíny (main.js) z evidence dlaždic právě kreslené úrovně
  function wZapsane() {
    let zD = 14;
    try { zD = Math.max(12, Math.min(15, Math.floor(mapa.getZoom()))); } catch (e) { /* nic */ }
    const out = [];
    for (const t of wEvidence.values()) {
      if (t.z !== zD || !t.stromy) continue;
      if (!t.pf) {
        const S = t.stromy, m = S.lon.length, pf = new Array(m);
        for (let j = 0; j < m; j++) {
          const p = Object.assign({ ik: S.ik[j], k: S.k[j] }, nastup(S.z0[j]));
          if (S.ev[j]) p.ev = S.ev[j];
          if (S.lic && S.lic[j]) p.lic = 1;        // engine 342: lichá buňka (plynulé zmizení pod z15,45)
          pf[j] = { type: 'Feature', properties: p, geometry: { type: 'Point', coordinates: [S.lon[j], S.lat[j]] } };
        }
        t.pf = pf;
      }
      for (const f of t.pf) out.push(f);
    }
    return out;
  }
  /// ladění (CDP): proč (ne)vznikla dekorace u bodu (z15)
  function wDiag(lon, lat) { return wDek ? wPozadej({ typ: 'diag', lon, lat }) : Promise.resolve(null); }
  /// ladění (CDP): stav workeru dekorací
  function wLadeni() {
    const zakl = { stav: wStav, verze: wVerze, evidence: wEvidence.size, cekani: wCekani.size,
                   chybDlazdic: wChyby.size, stat: Object.assign({}, wStat, { mlhaMs: +wStat.mlhaMs.toFixed(1) }) };
    if (!wDek) return Promise.resolve(zakl);
    return wPozadej({ typ: 'stav' }).then((m) => Object.assign(zakl, { worker: m }));
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
    // ⛔⛔ engine 333 (výtka T 22. 9.: „při posunu stromy nejsou – vidím jen
    // ty z keše“): dosyp běží v pevných kolech 0,5 / 1,2 / 2,5 / 5 s a
    // stromy potřebují NAČTENÉ dlaždice ploch (les, louka…). Když dlaždice
    // dojely později (telefon, z14 = velký výřez), všechna kola proběhla
    // naprázdno a stromy chyběly až do dalšího posunu (změřeno na TT: po
    // skoku 3 stromy, po posunu za 1,5 s 0, za 7,5 s 74). Když zdroj ploch
    // dohraje, doplnit znovu (s plnou keší to nestojí skoro nic).
    let doplnPoDlazdicichT = null;
    mapa.on('sourcedata', (e) => {
      if (!e || !e.tile || !e.isSourceLoaded) return;
      const def = plochyDef;
      const zdrojPloch = def ? def.some((d) => d.zdroj === e.sourceId)
                             : (e.sourceId === 'omt' || e.sourceId === 'krajina');
      if (!zdrojPloch) return;
      clearTimeout(doplnPoDlazdicichT);
      doplnPoDlazdicichT = setTimeout(() => {
        try {
          if (mapa.isMoving && mapa.isMoving()) return;   // doplní moveend
          dopln();
        } catch (err) { /* styl se zrovna mění */ }
      }, 350);
    });
    // po odkrytí mlhy dosypat – čerstvě odkryté území by jinak zůstalo
    // holé až do dalšího posunu mapy (dekorace v mlze nevznikají)
    if (typeof Mlha !== 'undefined' && Mlha
        && typeof Mlha.priObjeveni === 'function') {
      try {
        Mlha.priObjeveni(function (o) {
          if (wStav === 1) wZmenaMlhy(o === undefined ? {} : o);   // engine 336
          else naplanujDosyp();
        });
      } catch (e) { /* mlha ještě neběží */ }
    }
  }

  // Volat po style.load herního stylu (aplikujDoplnky); opakovaně OK.
  // Body v keši přežívají výměnu stylu — zdroj se založí rovnou s nimi
  // (líně; prázdný zdroj ze style.load byl sterilní, viz pridejVrstvu).
  function pripoj(map) {
    nasadTaktRoje();   // engine 310: roj a křídla na společném klidovém tikači
    mapa = map;
    ikonyHotove = false;      // atlas je po výměně stylu prázdný
    // Nový styl = jiné filtry ploch (les v Kronice ≠ les jinde), takže
    // definice i převedené polygony do koše. Dlaždice samotné v MapLibre
    // zůstávají, převede se z nich jen to, co bude znovu potřeba.
    plochyDef = null;
    kesDlazdic.clear();
    idxMrizka = null;
    wPripravit();             // engine 336: worker (jinak starý generátor níž)
    nactiMalby();             // async; dopln čeká na ikonyHotove
    registrujHooky();
    if (wStav === 1) return;  // body do vrstvy dodá worker (vrstva po malbách)
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
  /// engine 321: změna dohledu – posunout rampu, rozsah vrstvy a dosypat.
  function nastavDohled(dz) {
    DZ = Number(dz) || 0;
    RAMPA = RAMPA_ZAKLAD.map((z) => z - DZ);
    RAMPA_VYS = RAMPA_VYS_ZAKLAD.map((z) => z - DZ);
    try {
      if (mapa && mapa.getLayer('dekorace-lampy')) {                   // engine 349
        mapa.setLayerZoomRange('dekorace-lampy', DROBNOSTI.lampa.z0 - 0.4 - DZ, 24);
        mapa.setPaintProperty('dekorace-lampy', 'icon-opacity', vyrazLampy(lampySila));
      }
      if (mapa && mapa.getLayer('akvarel-dekorace')) {
        mapa.setLayerZoomRange('akvarel-dekorace', 13.2 - DZ, 24);
        const f = (typeof window.__nocniFaktorDekorace === 'number') ? window.__nocniFaktorDekorace : 1;
        if (window.__ztlumDekorace) window.__ztlumDekorace(f);
      }
      if (wStav === 1) wPrenacti(true);     // engine 336: obsah úrovní závisí na dohledu
      else dopln();
    } catch (e) { /* styl se zrovna mění */ }
  }
  /// engine 334: zapsané dekorace pro stíny (prázdné, když zdroj neexistuje –
  /// po přepnutí na styl bez dekorací nesmí zůstat stíny „starých“ stromů)
  function zapsane() {
    if (!mapa || !mapa.getSource('dekorace')) return [];
    return wStav === 1 ? wZapsane() : zapsaneFeatury;
  }
  return { pripoj, nastavStin, nastavDohled, zapsane,
    nastavStiny: wNastavStiny, stinDlazdice: wStinDlazdice,                    // engine 357
    vedeni: () => (wStav === 1 ? wVedeni() : null),
    ploty: () => (wStav === 1 ? { verze: wPlotyVerze, dlazdice: [...wPloty.values()] } : null),   // engine 358
    odleskyVoda: () => (wStav === 1 ? { verze: wVodaVerze, dlazdice: [...wVoda.values()] } : null),
    stinyStav: () => wPozadej({ typ: 'stiny-stav' }),
    kotvyAnimaci: () => wKotvyAnimaci(), kotvyVerze: () => wKotvyVerze,
    pripravOblast: (w, s, e, n) => wPripravOblast(w, s, e, n),
    kontextPtaku: (w, s, e, n) => wKontextPtaku(w, s, e, n),
    _ladeni: { worker: wLadeni, diag: wDiag,
    zmenaMlhy: (o) => { if (wStav === 1) wZmenaMlhy(o === undefined ? {} : o); },
    selhani: (d) => wSelhal(d || 'ruční test zálohy'), postavIndex, plochyPodBodem, dopln, casy: () => casy,
    stav: () => ({ kes: kesDlazdic.size, mrizka: idxMrizka && idxMrizka.size,
                   velke: idxVelke.length, zoomy: idxZoomy, zCil: idxZCil,
                   dlazdic: idxDlazdice && idxDlazdice.size }) } };
})();
