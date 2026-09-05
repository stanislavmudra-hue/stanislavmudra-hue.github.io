// Okolník 3D — malované ilustrace míst v herním stylu (v2.5).
//
// Model po zpětné vazbě z 5. 8. večer (v2.3 „katastrofa": problikávání,
// překrývání, kresby přes celý výhled, nejednotné mizení). JEDNOTNÝ
// ŽIVOTNÍ CYKLUS každé kresby:
//
//   1. NARODÍ SE MALÁ (58 px) ve chvíli, kdy je její území akorát
//      čitelné (zIn z pozemní šířky v km dle úrovně a důležitosti);
//      důležitost smí nástup posunout dřív (drží pak 58 px).
//   2. ROSTE PLYNULE S KRAJINOU: icon-size = interpolate(exponential 2)
//      přes zoom s min/max klampy v zastávkách — škáluje GPU každý
//      snímek, žádné přepočty. JS zrcadlí PŘESNĚ render (po úsecích
//      mezi celočíselnými zastávkami), ať boxy sedí na pixely.
//   3. Jakmile PŘEROSTE STROP (≤ 30 % šířky obrazovky VŽDY — i na
//      telefonu), POMALU SE ROZPLYNE (1,3 zoomu) a předá scénu
//      podoblastem. Žádné výjimky (persist/duch zrušeny).
//   4. SLADĚNÉ NÁSTUPY (výtka 5. 8. pozdě večer): dítě rodiče ani
//      slabší soused vůdce skupiny (překrývající se místa stejné
//      úrovně) se nenarodí dřív, než zdroj začne předávat — z dálky
//      jeden zástupce oblasti, při jeho předávce nastoupí celá skupina
//      najednou, malá a vedle sebe (žádné náhodné střídání rovnocenných).
//
// ROZMÍSTĚNÍ = logika 2D: důležitější rezervuje místo (rezervaci
// nevynechává nikdo kromě skutečně SE ROZPLÝVAJÍCÍCH, op ≤ 0,75 při
// fade-outu), kdo se nevejde → STUŽKA s uhýbáním → shluk „+N";
// hystereze okrajů + prodleva režimu 650 ms/0,35 zoomu; odložená změna
// se dotáhne časovačem i na stojící mapě.
//
// PROLÍNÁNÍ: každá featura (obrázek/stužka pod ním/samotná stužka/odznak)
// má VLASTNÍ klíč, cíl a stav průhlednosti (feature-state, vlastní id)
// — výměna obrázek↔stužka je obyčejný odchod+příchod s crossfade, nikdy
// tvrdý střih. Odchozí featury dohasnou a uklidí se (i bez pohybu mapy).
// Obrázek se nerozsvěcí, dokud není kresba v atlasu (žádné cvaknutí po
// fetch); přednačítá se 0,8 zoomu před narozením.
//
// setData jen při změně PODPISU sestavy (klíče+režimy+uhnutí+odznaky+sw)
// — čistý zoom nechává vše na GPU výrazech a feature-state. Opožděný
// druhý setData (po dotažení kreseb) se zahazuje, když už platí novější
// sestava.
//
// STUŽKY (skutečný text na assets/stuha.webp) drží u kresby ve VŠECH
// fázích: v růstové fázi zeměpisnou kotvou na spodní hraně území,
// v klamp fázích (58 px / strop) konstantním px ofsetem od místa —
// v obou případech je geometrie za zoomu neměnná, přechod mezi režimy
// je spojitý a projde jedním setData (režim je v podpisu).
//
// Ostatní: místa VIDĚT VŠUDE (v1.246, mlha nefiltruje), nenavštívené
// sépiově (matice z 2D), barva návštěvou (`Ilustrace.navstivene()`).
'use strict';

const Ilustrace = (() => {
  // ——— zdroj kreseb (?ilus= + ?ilusext=): v aplikaci assety Okolníku ———
  const ILUS_PAR = new URLSearchParams(location.search);
  const ILUS_ZAKLAD = ILUS_PAR.get('ilus') || 'assets/ilustrace/';
  // od 6. 8. WebP (65 MB PNG → ~15 MB, rychlejší stažení i dekódování)
  const ILUS_PRIPONA = ILUS_PAR.get('ilusext') || '.webp';
  const cestaKresby = (slug) => ILUS_ZAKLAD + slug + ILUS_PRIPONA;

  // ——— konstanty ———
  const MIN_PX = 58;             // velikost při narození
  const FADE_SPAN = 1.3;         // rozplynutí po přerůstu stropu (zoom)
  const BANNER_BIAS = 0.07;      // stará zapečená cedule (dnes 1 kresba)
  const LABEL_W_FRAC = 0.94;
  const LABEL_OVERLAP_PX = 4;    // stužka těsně pod spodkem kresby
  const FADE_KROK = 0.11;        // opacity za snímek
  const MIN_LABEL_W = 66.0;
  const MAX_LABEL_W = 168.0;
  // 104 px místo 84 z 2D — jména na samotných stužkách byla nečitelná
  const RIBBON_ONLY_W = 104.0;
  const RIB_ASPECT = 57.0 / 300.0;
  const ZAKLAD_CSS = 140;        // kresby 280 px / pixelRatio 2
  const PRODLEVA_MS = 650;       // režim se nesmí měnit častěji…
  const PRODLEVA_ZOOM = 0.35;    // …leda by zoom znatelně ujel

  // Pozemní šířka v km podle footprintu; důležitost moduluje, města ×1,24
  const KM_LV = { 0: 26.0, 1: 7.0, 2: 2.9 };
  function pozemniKm(p) {
    const zaklad = KM_LV[p.lv] !== undefined ? KM_LV[p.lv] : 2.9;
    const mesto = p.d === 'mesta' ? 1.24 : 1.0;
    return zaklad * (0.75 + 0.06 * p.imp) * mesto;
  }

  // Strop kreslené šířky. ⚠️ NIKDY přes 30 % obrazovky — dolní mez 170 px
  // je jen rezerva růstu a na úzkých displejích ji 0,30·sw PŘEBÍJÍ
  // (bez toho by na telefonu kresba zabrala 42 % šířky).
  // ⚠️ STROP ZVEDNUT 6. 8. 2026 (opakovaná výtka „kresby se pořád
  // zmenšují / nezvětšují se s přiblížením"). Na telefonu (sw ≈ 360 CSS)
  // dával starý vzorec strop 108 px, tedy jen log2(108/58) ≈ 0,9 zoomu
  // růstu — kresba prakticky celý život STÁLA na místě, zatímco krajina
  // rostla. Nově ≈ 150–180 px, což je 1,4–1,6 zoomu skutečného růstu.
  // Kdyby začaly zakrývat mapu, snižovat TENHLE podíl (ne podlahu).
  function stropPx(p, sw) {
    const podil = p.lv === 0 ? 0.50 : (p.d === 'mesta' ? 0.42 : 0.36);
    return Math.min(0.50 * sw, Math.max(150, podil * sw));
  }

  const DRUHY = {
    hrady: 'Hrady a zámky', mesta: 'Města a městečka', hory: 'Hory a vrcholy',
    skaly: 'Skály a skalní města', voda: 'Příroda a voda',
    jeskyne: 'Jeskyně a podzemí', pamatky: 'Památky a zajímavosti',
  };

  let mapa = null;
  let seznam = null;
  let indexDleSlugu = null;
  let nacitani = null;
  let skupina = 'vse';
  let navstivene = new Set(['snezka', 'krkonose']);

  const rozpracovane = new Map();
  const selhane = new Set();

  let stuhaAsp = RIB_ASPECT;
  let stuhaZaklad = 42;
  let stuhaNactena = false;
  let stuhaBezi = false;

  // režim místa: {rezim: 0 obrázek | 5 stužka | 6 nic, ms, z}
  const stavRezimu = new Map();
  // PRŮHLEDNOST PER FEATURA (klíč slug#o / #s0 / #s1 / #z): výměna
  // režimu = odchod jedné a příchod druhé featury s crossfade
  const prolnuti = new Map();       // klíč → aktuální opacity
  let cile = new Map();             // klíč → cílová opacity
  const odchazejici = new Map();    // klíč → featura držená do dohasnutí
  const posledniFeatury = new Map();
  let posledniShluky = new Map();
  let posledniPodpis = '';
  let animBezi = false;

  const merak = document.createElement('canvas').getContext('2d');

  // Vlastní id featury podle druhu (feature-state je per zdroj, ale s0 a
  // s1 téhož místa se při crossfade potkají VE STEJNÉM zdroji stužek)
  const DRUH_ID = { o: 0, s0: 1, s1: 2, z: 3 };
  const idFeatury = (slug, druh) =>
    indexDleSlugu.get(slug) * 4 + DRUH_ID[druh];
  const ZDROJ_DRUHU = { o: 'ilus-obrazky', s0: 'ilus-stuhy',
                        s1: 'ilus-stuhy', z: 'ilus-odznaky' };

  // -------------------------------------------------------------------------
  // Data a životní cyklus místa
  // -------------------------------------------------------------------------
  function nactiSeznam() {
    if (!nacitani) {
      nacitani = fetch('assets/ilustrace.json')
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status);
                     return r.json(); })
        .then(d => {
          seznam = d;
          indexDleSlugu = new Map(d.map((p, i) => [p.s, i]));
          for (const p of d) {
            // px šířka území při zoomu 0 (Mercator na dané šířce)
            p.g0 = pozemniKm(p) * 1000 * 512
              / (40075016.686 * Math.cos(p.lat * Math.PI / 180));
            // narození na 58 px; NÁSKOK dle úrovně a důležitosti pouští
            // místa na mapu už z dálky (výtka 6. 8.: „okolí Tábora,
            // Jihlavy, Písku… je při oddálení zbytečně prázdné").
            // Náskok se reálně projeví jen u VOLNĚ STOJÍCÍCH míst —
            // koho zastupuje rodič/vůdce, toho stejně drží předávka
            // (srovnejPasma přepíše zInEff). Do té doby kresba drží
            // 58 px (min klamp), než ji území dožene.
            // laděno 6. 8.: města lv2 (Tábor, Jihlava, Písek…) mají
            // zIn_size ~9,9 a s náskokem musí stihnout půlkrajský
            // pohled z≈7,3 — proto lv2 základ 2,4
            const zakladNaskoku =
              p.lv === 0 ? 0.7 : (p.lv === 1 ? 1.6 : 2.4);
            const naskok = Math.min(3.6,
                zakladNaskoku + 0.3 * Math.max(0, p.imp - 4.0));
            p.zIn = Math.log2(MIN_PX / p.g0) - naskok;
            // kotva stužky v růstové fázi: spodní hrana území
            p.latStuha = p.lat
              - (pozemniKm(p) * (p.vy / 280) / 2) / 110.574;
            p.maPotomky = false;
            p.rodicIdx = null;
            p.vudceIdx = null;
            p.zInEff = p.zIn;
          }
          // POTOMCI (hierarchie z 2D illus_lod): místo BEZ ilustrovaného
          // nástupce nesmí po dosednutí na strop hned zmizet — drží
          // připnuté, dokud nenastoupí POI vrstva (výtka 5. 8. večer:
          // „Veselý Kopec mizí, když je zoom daleko od jeho velikosti")
          const dosahKm = (q) =>
            (q.lv === 0 ? 26.0 : (q.lv === 1 ? 6.5 : 2.5));
          for (let i = 0; i < d.length; i++) {
            let best = Infinity;
            let rodic = -1;
            for (let j = 0; j < d.length; j++) {
              if (i === j) continue;
              const vetsi = d[j].lv < d[i].lv
                && d[j].imp >= d[i].imp - 0.4;
              const dominantni = d[j].lv === d[i].lv
                && d[j].imp >= d[i].imp + 0.8;
              if (!vetsi && !dominantni) continue;
              const dosah = dosahKm(d[j]) * (dominantni ? 0.35 : 1.0);
              const dy = (d[i].lat - d[j].lat) * 110.9;
              const dx = (d[i].lon - d[j].lon) * 111.32
                * Math.cos((d[i].lat + d[j].lat) / 2 * Math.PI / 180);
              const dist = Math.hypot(dx, dy);
              if (dist > dosah) continue;
              const skore = dist / dosah;
              if (skore < best) { best = skore; rodic = j; }
            }
            if (rodic >= 0) {
              d[rodic].maPotomky = true;
              d[i].rodicIdx = rodic;
            }
          }
          // VŮDCE SKUPINY: mezi podobně velkými PŘEKRÝVAJÍCÍMI se
          // sousedy STEJNÉ úrovně se z dálky ukazuje jen nejdůležitější;
          // ostatní se narodí společně, až vůdce předává (výtka 5. 8.
          // pozdě večer: Broumovsko/Kladské pomezí/Adršpach se střídaly
          // „náhodně" — teď jeden zástupce → pak celá skupina vedle
          // sebe, každý na svém území). Přísné pořadí (imp, index)
          // vylučuje cykly.
          for (let i = 0; i < d.length; i++) {
            let best = -1;
            let bestKlic = -Infinity;
            for (let j = 0; j < d.length; j++) {
              if (i === j || d[j].lv !== d[i].lv) continue;
              const silnejsi = d[j].imp > d[i].imp
                || (d[j].imp === d[i].imp && j < i);
              if (!silnejsi) continue;
              const dy = (d[i].lat - d[j].lat) * 110.9;
              const dx = (d[i].lon - d[j].lon) * 111.32
                * Math.cos((d[i].lat + d[j].lat) / 2 * Math.PI / 180);
              const dist = Math.hypot(dx, dy);
              // skupina jen při SKUTEČNÉM překryvu území — paušální
              // dosah (0,9×reach) dusil i sousedy 20 km od vůdce a
              // jejich kraj zůstával při oddálení prázdný
              if (dist > 0.75
                  * (pozemniKm(d[i]) + pozemniKm(d[j])) / 2) continue;
              const klic = d[j].imp * 1000 - dist;
              if (klic > bestKlic) { best = j; bestKlic = klic; }
            }
            if (best >= 0) d[i].vudceIdx = best;
          }
        })
        .catch(() => {
          console.warn('[Ilustrace] seznam se nenačetl — zkusí se příště');
          nacitani = null;
        });
    }
    return nacitani;
  }

  /// Kreslená šířka v px — PŘESNĚ zrcadlí GPU: interpolate(exponential 2)
  /// mezi CELOČÍSELNÝMI zastávkami s klampy v zastávkách. Prostá
  /// clamp(g0·2^z) by se od renderu lišila až o ~17 % u přechodů klampů
  /// a rozmisťovací boxy by neseděly na pixely.
  // ROSTOUCÍ PODLAHA (6. 8. 2026, výtka „obrázky se stále moc zmenšují
  // s přibližováním"). Kresba narozená s náskokem měla velikost PŘIBITOU
  // na MIN_PX, zatímco krajina pod ní rostla — oko to čte jako
  // zmenšování. Podlaha proto od narození roste polovičním tempem
  // krajiny (2^(0,5·Δz)), dokud ji vlastní velikost území nedožene.
  // Stejnou opravou prošly dřív dekorace („rostou zhruba s krajinou").
  // ⚠️ TENTÝŽ VZOREC MUSÍ BÝT I V `vyrazVelikosti()` (GPU) a v
  // `zStrop()`, jinak se rozejde logika kaskády s tím, co je vidět.
  // ⚠️ PODLAHA MÁ VLASTNÍ STROP a nikdy nesmí sama dosáhnout stropu
  // kresby. Bez toho by kresba dosedla na strop dřív, spustila rozplynutí
  // a ŽIVOT KRESBY BY SE ZKRÁTIL ze 4,6 na 3,1 zoomu – tedy přesně to
  // vyprazdňování mapy, které kaskáda řešila. Takhle zůstává `zStrop`
  // beze změny (rozhoduje dál vlastní velikost území).
  // ⚠️ 6. 8. 2026, DRUHÝ POKUS: první verze měla podlahu useknutou na
  // 2,2×MIN_PX a 0,75×strop. Při tehdejším stropu 108 px to znamenalo
  // strop podlahy 81 px, tedy růst 58 → 81 a dost — uživatel právem
  // hlásil, že se nic nezměnilo. Teď se podlaha zastaví až těsně pod
  // stropem kresby (0,85), takže roste přes celý život kresby.
  const PODLAHA_TEMPO = 0.35;
  const PODLAHA_STROP_DIL = 0.85;   // podíl stropu kresby

  function podlahaPx(p, zz, mx) {
    const zi = (typeof p.zInEff === 'number') ? p.zInEff : 0;
    const roste = MIN_PX * Math.pow(2, PODLAHA_TEMPO * Math.max(0, zz - zi));
    return Math.min(roste, PODLAHA_STROP_DIL * mx);
  }

  function sirkaPx(p, z, sw) {
    const mx = stropPx(p, sw);
    const ohran = (zz) =>
      Math.min(mx, Math.max(podlahaPx(p, zz, mx), p.g0 * Math.pow(2, zz)));
    const z0 = Math.max(4, Math.min(15, Math.floor(z)));
    const t = Math.max(0, Math.min(1, Math.pow(2, z - z0) - 1));
    return ohran(z0) + t * (ohran(z0 + 1) - ohran(z0));
  }

  // zoom, kdy RENDER skutečně dosedne na strop (celá zastávka — mezi
  // zastávkami interpolace strop podleze); odtud se rozplývá
  // Beze změny i po zavedení rostoucí podlahy: ta má vlastní strop
  // (≤ 0,75 stropu kresby), takže na strop dosedne vždy až SKUTEČNÁ
  // velikost území — délka života kresby zůstává, jaká byla.
  function zStrop(p, sw) {
    return Math.min(16, Math.ceil(Math.log2(stropPx(p, sw) / p.g0)));
  }

  function fadeStart(p, sw) {
    const strop = Math.max(zStrop(p, sw), p.zInEff + 1.2);
    // LIST (nikdo ho nestřídá) zůstává připnutý na stropu až do nástupu
    // POI vrstvy aplikace (13,4 jako v 2D) — jinak by malá místa mizela,
    // dokud je zoom daleko od jejich skutečné velikosti
    return p.maPotomky ? strop : Math.max(strop, 13.4);
  }

  // SLADĚNÍ PÁSEM: následovník (dítě rodiče / slabší soused vůdce) se
  // nenarodí dřív, než jeho zdroj začne předávat — do té doby ho stejně
  // dusila rezervace a pak „náhodně" vyskočil. Teď skupina nastoupí
  // společně při předávce. Pořadí (lv, imp sestupně) zaručuje, že zdroj
  // má zInEff hotové dřív než jeho následovníci (řetězy se sčítají).
  // Posun počítá předávku BEZ výdrže listu 13,4 — ta znamená „vydrž
  // vidět", ne „blokuj nástupce".
  let posledniSw = 0;

  function srovnejPasma(sw) {
    if (!seznam || sw === posledniSw) return;
    posledniSw = sw;
    const poradi = seznam.map((p, i) => i).sort((a, b) => {
      const pa = seznam[a];
      const pb = seznam[b];
      return (pa.lv - pb.lv) || (pb.imp - pa.imp) || (a - b);
    });
    for (const i of poradi) {
      const p = seznam[i];
      p.zInEff = p.zIn;
      for (const zdroj of [p.rodicIdx, p.vudceIdx]) {
        if (zdroj === null || zdroj === undefined) continue;
        const q = seznam[zdroj];
        const predavka = Math.max(zStrop(q, sw), q.zInEff + 1.2);
        p.zInEff = Math.max(p.zInEff, predavka - 0.4);
      }
    }
  }

  /// Průhlednost v životním cyklu (null = neviditelné). Od narození
  /// PLNÁ — měkký příchod obstará ČASOVÝ animátor (zoomový náběh dřív
  /// nechával na stojící mapě věčně poloprůhledné kresby, výtka 6. 8.).
  /// Zoomem řízené zůstává jen rozplynutí (předávka scény).
  // ⭐⭐ Z DÁLKY JEN TO VÝZNAMNÉ (zadání 10. 8. 2026: „kresby se mají
  // ukazovat dle důležitosti, významnosti a logiky; ukazovat z dálky vše
  // najednou ani nechci").
  //
  // Do teď rozhodovala jen ČITELNOST ÚZEMÍ (`zIn` podle velikosti místa),
  // takže na pohledu na kraj vyskákalo všechno, co se vešlo — na z9,5
  // 44 kreseb ve výřezu. Nově musí místo navíc přesáhnout práh
  // významnosti; pod ním se prostě ještě nenarodí.
  //
  // Kolik míst projde (dat je 455, `imp` je 2,0–10,0):
  //   ≥ 6,0 →  19 v celé ČR (Praha 10, Brno 9, Krkonoše a Šumava 8…)
  //   ≥ 5,0 →  55
  //   ≥ 4,0 → 147
  //   ≥ 3,4 → 275
  //   ≥ 2,9 → 397
  // Obrazovka na z9,4 pokrývá zhruba dvacetinu republiky (55 km na šířku),
  // takže práh 5,0 dělá ~3 kresby na obrazovku — přehled, ne seznam.
  // ⚠️ Práh 6,0 byl VYZKOUŠEN A JE PŘÍLIŠ PŘÍSNÝ: nad Mělníkem nezůstala
  // ani jedna kresba (Říp i Mělník mají imp pod 6). Kdyby to mělo být
  // řidší nebo hustší, stačí sáhnout do žebříku níž — nic jiného.
  //
  // ⚠️ Zbytek kaskády zůstává: pořadí, kolize, prodlevy i prolínání.
  // Tohle je jen VSTUPNÍ SÍTO, takže se místo pod prahem chová stejně,
  // jako by ještě nemělo čitelné území — včetně rozplynutí přes
  // `odchazejici`, když práh při oddálení překročí.
  // ⚠️ Prahy jsou schválně skokové na půlkách zoomu: kaskáda tak přidá
  // vrstvu kreseb naráz a s prolnutím, ne po jedné během celého gesta.
  function prahImp(z) {
    if (z < 9.5) return 5.0;
    if (z < 10.5) return 4.0;
    if (z < 11.5) return 3.4;
    if (z < 12.5) return 2.9;
    return 0;
  }

  function viditelnost(p, z, sw) {
    if (p.imp < prahImp(z)) return null;
    if (z <= p.zInEff) return null;
    const start = fadeStart(p, sw);
    const op = z <= start ? 1.0 : 1.0 - (z - start) / FADE_SPAN;
    return op <= 0.02 ? null : op;
  }

  function vyrazVelikosti() {
    const v = ['interpolate', ['exponential', 2], ['zoom']];
    for (let z = 4; z <= 16; z++) {
      // podlaha roste od narození (vlastnost `zi`) polovičním tempem —
      // musí přesně odpovídat `podlahaPx` v JS
      const podlaha = ['min',
        ['*', MIN_PX,
          ['^', 2, ['*', PODLAHA_TEMPO,
            ['max', 0, ['-', z, ['coalesce', ['get', 'zi'], 0]]]]]],
        ['*', PODLAHA_STROP_DIL, ['get', 'mx']]];
      v.push(z, ['/',
        ['min', ['get', 'mx'],
         ['max', podlaha, ['*', ['get', 'g0'], Math.pow(2, z)]]],
        ZAKLAD_CSS]);
    }
    return v;
  }

  // -------------------------------------------------------------------------
  // Obrázky: stuha, kresby (líně + přednačtení), sépie, odznak +N
  // -------------------------------------------------------------------------
  function nactiStuhu() {
    if (stuhaBezi) return;
    stuhaBezi = true;
    (async () => {
      try {
        const odpoved = await fetch('assets/stuha.webp');
        if (!odpoved.ok) throw new Error('HTTP ' + odpoved.status);
        const b = await createImageBitmap(await odpoved.blob());
        stuhaAsp = b.height / b.width;
        stuhaZaklad = b.width / 2;
        if (mapa && !mapa.hasImage('ilus-stuha')) {
          // ⭐⭐ DEVÍTIDÍLNÝ OBRÁZEK (9. 8. 2026: „ne vždy se tam text vejde").
          // Bez `stretchX`/`content` roztahuje `icon-text-fit` CELOU stuhu
          // i s ozdobnými cípy a text jde přes ně ven. Změřeno na kresbě
          // (300×57): souvislá část je od x=33 do x=266, cípy tedy zabírají
          // 33 bodů na každé straně; svisle kresba sahá od y=1 do y=47.
          //   · `stretchX/Y` = kde se smí natahovat (jen střed),
          //   · `content`    = kam smí text (uvnitř souvislé části).
          // Cípy si tak drží tvar a text se vejde vždycky.
          // ⚠️ SVISLE SE NENATAHUJE. Když jsem to zkusil (`stretchY`),
          // rozmazal se ozdobný horní okraj stuhy do pruhu — uživatel to
          // hned viděl. Natahuje se JEN do šířky a JEN v úzkém proužku
          // uprostřed, kde je kresba nejhladší (změřeno na obrázku).
          // ⚠️ Souřadnice jsou v bodech OBRÁZKU (300×47 po ořezu lístků).
          mapa.addImage('ilus-stuha', b, {
            pixelRatio: 2,
            stretchX: [[135, 165]],
            content: [40, 3, 260, 34],
          });
        }
        b.close();
        stuhaNactena = true;
        naplanuj();
      } catch (e) {
        console.warn('[Ilustrace] stuha se nenačetla', e);
        stuhaBezi = false;
      }
    })();
  }

  // Sépie nenavštívených — PŘESNĚ matice z 2D _IllusPainter.
  // Pomalá záloha (smyčka po pixelech) pro prostředí bez canvas filtrů.
  function odbarvi(data) {
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i]; const g = px[i + 1]; const b = px[i + 2];
      px[i] = Math.max(0, Math.min(255,
          0.307 * r + 0.629 * g + 0.063 * b - 22));
      px[i + 1] = Math.max(0, Math.min(255,
          0.187 * r + 0.749 * g + 0.063 * b - 22));
      px[i + 2] = Math.max(0, Math.min(255,
          0.187 * r + 0.629 * g + 0.183 * b - 22));
    }
    return data;
  }

  // Tatáž matice jako SVG feColorMatrix — odbarvení jede nativně místo
  // smyčky v JS, která při přívalu kreseb zadrhávala hlavní vlákno
  // (výtka 6. 8. „mapa se seká při načítání"). Ofsety −22/255; NUTNÉ
  // color-interpolation-filters sRGB, jinak barvy nesedí s 2D.
  let filtrPripraven = false;

  function zajistiSepiovyFiltr() {
    if (filtrPripraven) return;
    filtrPripraven = true;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    const filtr = document.createElementNS(NS, 'filter');
    filtr.setAttribute('id', 'ilus-sepie');
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

  // SPOLEČNÉ PLÁTNO pro přebarvování (6. 8. 2026, „výkon při oddálení").
  // Dřív se pro KAŽDOU kresbu zakládalo nové plátno a četlo se z něj
  // `getImageData` — na čerstvém (GPU) plátně je to drahý readback.
  // Naměřeno ~12 ms na kresbu, a při oddalování jich přišlo skoro dvě
  // stě. `willReadFrequently` drží plátno v CPU paměti, kde je čtení
  // levné; jedno plátno navíc ušetří alokace a práci GC.
  let platno = null;
  let platnoCtx = null;

  function plocha(w, h) {
    if (!platno) {
      platno = document.createElement('canvas');
      platnoCtx = platno.getContext('2d', { willReadFrequently: true });
    }
    if (platno.width !== w || platno.height !== h) {
      platno.width = w;                 // změna rozměru plátno vyčistí
      platno.height = h;
    } else {
      platnoCtx.clearRect(0, 0, w, h);
    }
    // ⚠️ stav po předchozí kresbě: bez tohohle by sépiový filtr nebo
    // `source-in` přetekly do další (silueta by vyšla sépiová apod.)
    platnoCtx.globalCompositeOperation = 'source-over';
    platnoCtx.filter = 'none';
    return platnoCtx;
  }

  /// ⭐ 5. 9. 2026: STÍN KRESBY – tmavá silueta zploštělá na 45 % výšky
  /// (leží na zemi, vrstva `ink-ilustrace-stin` má icon-pitch-alignment
  /// map), lehce rozostřená. Směr a délku podle slunce/měsíce dává
  /// `svetlo()` přes offset featury, sílu paint vrstvy.
  const STIN_ZPLOSTENI = 0.45;
  function stinData(bitmapa) {
    const w = bitmapa.width;
    const h = Math.max(4, Math.round(bitmapa.height * STIN_ZPLOSTENI));
    const ctx = plocha(w, h);
    ctx.filter = 'blur(1.5px)';
    ctx.drawImage(bitmapa, 0, 0, w, h);
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = '#1a1208';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    return ctx.getImageData(0, 0, w, h);
  }

  function odbarvenaData(bitmapa) {
    const w = bitmapa.width; const h = bitmapa.height;
    const ctx = plocha(w, h);
    zajistiSepiovyFiltr();
    ctx.filter = 'url(#ilus-sepie)';
    if (ctx.filter && ctx.filter !== 'none') {
      ctx.drawImage(bitmapa, 0, 0);
      return ctx.getImageData(0, 0, w, h);
    }
    // canvas filtry nepodporovány — pomalá záloha
    ctx.filter = 'none';
    ctx.drawImage(bitmapa, 0, 0);
    return odbarvi(ctx.getImageData(0, 0, w, h));
  }

  // SILUETA S OTAZNÍKEM pro neobjevené (přání 6. 8.: „obrázek za
  // odměnu") — tvar kresby vyplněný tmavou tuší, otazník v TĚŽIŠTI
  // siluety (kresby mají průhledné okraje a motiv bývá mimo střed
  // plátna); jméno na stužce zůstává jako lákadlo.
  function siluetaData(bitmapa) {
    const p = { width: bitmapa.width, height: bitmapa.height };
    const ctx = plocha(p.width, p.height);
    ctx.drawImage(bitmapa, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = '#4E4A44';        // tmavá tuš na sépiovém světě
    ctx.fillRect(0, 0, p.width, p.height);
    ctx.globalCompositeOperation = 'source-over';
    // těžiště a rozměr neprůhledné plochy (vzorkování mřížkou 3 px)
    const data = ctx.getImageData(0, 0, p.width, p.height).data;
    let sx = 0; let sy = 0; let n = 0;
    let minX = p.width; let maxX = 0; let minY = p.height; let maxY = 0;
    for (let y = 0; y < p.height; y += 3) {
      for (let x = 0; x < p.width; x += 3) {
        if (data[(y * p.width + x) * 4 + 3] > 96) {
          sx += x; sy += y; n++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const cx = n ? sx / n : p.width / 2;
    const cy = n ? sy / n : p.height / 2;
    const rozmer = n ? Math.min(maxX - minX, maxY - minY)
                     : Math.min(p.width, p.height);
    const velikost = Math.max(30, Math.round(rozmer * 0.5));
    ctx.font = '700 ' + velikost + 'px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#EFE7D4';        // pergamenový otazník
    ctx.fillText('?', cx, cy);
    return ctx.getImageData(0, 0, p.width, p.height);
  }

  // VKLÁDÁNÍ DO ATLASU PO DÁVKÁCH (≤2 na snímek): dekódování je async,
  // ale sépie + addImage (upload textury) jedou na hlavním vlákně a
  // příval příchozích kreseb dřív vyrobil sérii dlouhých snímků.
  const frontaVkladani = [];
  let pumpaBezi = false;
  let frontaOdMs = 0;

  // ⚠️ S POHYBUJÍCÍ SE KAMEROU SE DO ATLASU NESAHÁ (oprava 6. 8. 2026,
  // výtka „výkon při oddálení"). Každý `addImage` nutí MapLibre přeskládat
  // symboly dotčených dlaždic; „≤2 na snímek" tedy rozprostřelo tuhle
  // práci do KAŽDÉHO snímku celého gesta — naměřeno min 7 fps, průměr
  // 36 fps při oddalování. Vkládá se proto až po zastavení kamery, zato
  // po větších dávkách: jeden krátký hrbol místo trvalého sekání.
  // Pojistka proti hladovění: při nepřetržitém posunu (kdy se kamera
  // nezastaví vůbec) pustí po 1,2 s jednu kresbu, ať mapa neosleplá.
  //
  // ⚠️ Dávka zůstává MALÁ. Jedna kresba stojí ~12 ms (canvas + upload),
  // takže osm najednou = 100ms zámrz. Dvě se vejdou do snímku.
  //
  // ⛔ ZKOUŠENO 10. 8. 2026 A NEPOTVRDILO SE: zvětšit dávku na 24 s časovým
  // stropem 40 ms (úvaha: přestavba atlasu ikon je společná pro celou dávku,
  // takže větší dávka = méně přestaveb). Naprázdno — **fronta se nestihne
  // naplnit**, kresby chodí ze sítě po jedné, takže i s dávkou 24 se vkládá
  // po jedné. Změřeno: 44 přestaveb / 724 ms proti 34 / 452 ms s dávkou 2.
  // Ani záměrné shromažďování `addImage` do vln po 350 ms nepomohlo
  // (22 přestaveb / 411 ms proti 32 / 587 ms, ale ve vlnovém režimu se
  // přidávaly nula až jedna kresba — takže se neměřilo, co se mělo).
  // ⚠️ Neproměřený zbytek: PŘÍJEZD DO NOVÉHO KRAJE, kdy fronta opravdu
  // naroste na desítky. Tam by velká dávka smysl dávat mohla — chce to
  // ale měřit se studenou keší kreseb, ne opakovaným gestem na jednom místě.
  const DAVKA_KLID = 2;
  const HLAD_MS = 1200;

  // ═══ ZMENŠENÁ KRESBA PRO VZDÁLENÝ POHLED (10. 8. 2026) ══════════════
  //
  // PROČ: největší zbylé sekání herního režimu byla přestavba atlasu ikon
  // dlaždice — při jednom oddálení 20–40× po 15–65 ms (dohromady 400–870 ms,
  // jednotlivé nahrání delší než celý snímek). Cena je úměrná PLOŠE atlasu
  // a ta byla na dálku absurdní: na z9,5 držely čtyři dlaždice 44 ikon
  // v plném rozlišení = **3,12 Mpx, přitom vykreslených kreseb bylo devět**.
  //
  // Pět pokusů zmenšit POČET přestaveb selhalo (viz paměť
  // „sarcher-atlas-ilustraci"), protože cena je v ploše. Tohle ji mění.
  //
  // JAK: kresba se do atlasu vloží ve zmenšenině, dokud se vykresluje
  // malá. Rozhoduje SKUTEČNÁ ŠÍŘKA NA OBRAZOVCE, ne zoom — kaskáda je
  // celá postavená na velikosti, ne na zoomu, a různá místa dorůstají
  // v různý čas.
  //
  // ⚠️ HYSTEREZE JE NUTNÁ. Bez ní by kresba na hranici přeskakovala mezi
  // dvěma ikonami a každý přeskok znamená JINÝ `icon-image`, tedy novou
  // přestavbu atlasu — přesně to, čemu se vyhýbáme.
  // ⛔⛔ POZOR NA PREMISU (spálil jsem se na ní 10. 8. 2026):
  // „na dálku je kresba pár desítek pixelů" NEPLATÍ. Kaskáda drží podlahu
  // `MIN_PX` = 58 CSS px a ta ještě ROSTE od narození (`podlahaPx`).
  // Změřeno na z9,5: geometrická šířka 37–180 px (medián 41), ale po
  // podlaze se skoro nic nevykresluje pod 58 a běžně to je 80–170.
  // První pokus se zmenšeninou na 140 px se proto NEUPLATNIL ANI JEDNOU
  // (atlas zůstal 3,12 Mpx) — a kdyby ano, kresby by se dopočítávaly.
  //
  // Práh je proto postavený tak, aby se zmenšenina NIKDY NEDOPOČÍTÁVALA:
  // 200 px zdroje = 1:1 při 100 CSS px na displeji s DPR 2. Nad 100 px
  // se sáhne po plné kresbě. Plocha atlasu klesne na 51 %.
  //
  // ⚠️ `pixelRatio` se musí dopočítat, ne napevno 2 — `icon-size` počítá
  // se ZAKLAD_CSS = 140, takže CSS šířka ikony musí zůstat 140 u obou
  // variant (280/2 = 140 ✓, 200/1,4286 = 140 ✓). Napevno 2 by zmenšeninu
  // vykreslilo o třetinu menší.
  const MALA_SIRKA = 200;
  // ⭐ v1.425: TŘETÍ PATRO '@s' (120 px) pro hluboký nadhled — atlas
  // v z<11,2 klesne z ~2,1 na ~0,75 Mpx, přestavby při oddálení
  // (20–40× za gesto, viz memory atlas ilustrací) zlevní ~3×.
  // Kresby se tam kreslí 58–80 CSS px, měkké natažení je nepoznat.
  const MINI_SIRKA = 120;
  const MALA_DO_PX = 100;     // pod tuhle šířku na obrazovce stačí menší
  const VELKA_OD_PX = 112;    // nad tuhle se přepne na plnou (hystereze)
  const velikostniTrida = new Map();   // slug → 's' | 'm' | 'v'

  function pripona(varianta) {
    return varianta.endsWith('@m') ? '@m'
      : (varianta.endsWith('@s') ? '@s' : '');
  }
  function jeMala(varianta) { return pripona(varianta) !== ''; }
  function zakladVarianty(varianta) {
    return pripona(varianta) ? varianta.slice(0, -2) : varianta;
  }

  // ⭐ v1.397: POD z11,5 SE PLNÁ KRESBA DO ATLASU NEDÁVÁ NIKDY
  // (uživatel 12. 8.: „do atlasu ilustrací bych klidně šel“). Při
  // přehledu držel atlas desítky 280px kreseb kvůli podlaze MIN_PX
  // (kreslí se 58–170 px) a každá přestavba stojí úměrně PLOŠE.
  // Zmenšenina 200 px stačí (do 100 CSS px je 1:1, nad tím měkce
  // natažená) a plocha atlasu klesne na polovinu. Hystereze 11,5/11,8,
  // ať hranice nepřepíná třídy tam a zpět (každý přeskok = jiný
  // icon-image = další přestavba).
  let prehledAtlasu = false;
  let miniAtlas = false;
  function priponaVelikosti(slug, sirkaNaObrazovce) {
    try {
      const z = mapa.getZoom();
      // ⭐ v1.404: strop rozšířen z 11,5 na 13 (schváleno 13. 8.) —
      // i v pásmu 11,5–13 stačí zmenšenina 200 px (nad 100 CSS px se
      // měkce natáhne); atlas regionálního přehledu je menší a třídy
      // nepřeskakují. Hystereze 13,0/13,3.
      if (prehledAtlasu ? z >= 13.3 : z < 13.0) prehledAtlasu = !prehledAtlasu;
      // ⭐ v1.425: hluboký nadhled → '@s' 120 px. Hystereze 11,2/11,6.
      if (miniAtlas ? z >= 11.6 : z < 11.2) miniAtlas = !miniAtlas;
    } catch (e) { /* mapa ještě není — platí šířka */ }
    if (miniAtlas) {
      velikostniTrida.set(slug, 's');
      return '@s';
    }
    if (prehledAtlasu) {
      velikostniTrida.set(slug, 'm');
      return '@m';
    }
    let t = velikostniTrida.get(slug);
    if (t === undefined) t = sirkaNaObrazovce < MALA_DO_PX ? 'm' : 'v';
    else if (t === 'm' && sirkaNaObrazovce >= VELKA_OD_PX) t = 'v';
    else if (t === 'v' && sirkaNaObrazovce < MALA_DO_PX) t = 'm';
    velikostniTrida.set(slug, t);
    return t === 'm' ? '@m' : '';
  }

  function zaradVlozeni(id, bitmapa, varianta) {
    return new Promise((res) => {
      if (!frontaVkladani.length) frontaOdMs = Date.now();
      frontaVkladani.push({ id, bitmapa, varianta, res });
      if (!pumpaBezi) {
        pumpaBezi = true;
        requestAnimationFrame(pumpujVkladani);
      }
    });
  }

  function pumpujVkladani() {
    // isMoving() pokrývá gesta i programové přelety; ⛔ NE `isEasing()`,
    // ten v MapLibre 6 neexistuje a výjimka by tichounce zabila celou
    // rAF smyčku (past popsaná v předávce enginu).
    const jede = !!(mapa && typeof mapa.isMoving === 'function'
                    && mapa.isMoving());
    const davka = jede
      ? (Date.now() - frontaOdMs > HLAD_MS ? 1 : 0)
      : DAVKA_KLID;
    const tStart = performance.now();
    let n = 0;
    while (frontaVkladani.length && n < davka) {
      const u = frontaVkladani.shift();
      try {
        if (mapa && !mapa.hasImage(u.id)) {
          // ⚠️ Filtr se řídí ZÁKLADEM varianty — přípona `@m` (zmenšenina)
          // s barvou nesouvisí, bitmapa přišla zmenšená už z dekodéru.
          const prip = pripona(u.varianta);
          const zaklad = zakladVarianty(u.varianta);
          const data = zaklad === '#sil' ? siluetaData(u.bitmapa)
            : (zaklad === '#stin' ? stinData(u.bitmapa)
            : (zaklad === '#bw' ? odbarvenaData(u.bitmapa)
                                : u.bitmapa));
          // ⚠️⚠️ `pixelRatio` DOPOČÍTAT, NE NAPEVNO 2.
          // `icon-size` počítá „žádaná šířka v CSS px / ZAKLAD_CSS" (140)
          // a CSS šířka ikony je pixely / pixelRatio. Obě varianty proto
          // musí vyjít na 140 CSS: 280/2 ✓, 200/1,4286 ✓. Napevno 2 by
          // zmenšeninu vykreslilo o třetinu menší.
          mapa.addImage(u.id, data,
              { pixelRatio: prip === '@s' ? MINI_SIRKA / ZAKLAD_CSS
                : (prip === '@m' ? MALA_SIRKA / ZAKLAD_CSS : 2) });
        }
        u.res(true);
      } catch (e) {
        console.warn('[Ilustrace] vložení kresby', u.id, e);
        u.res(false);
      } finally {
        try { u.bitmapa.close(); } catch (e2) { /* už zavřená */ }
      }
      n++;
    }
    if (n) {
      frontaOdMs = Date.now();   // dávka prošla → hlídka hladu od nuly
      // ⭐⭐⭐ ROZSVĚCET AŽ PO DOJETÍ FRONTY, NE PO KAŽDÉ DÁVCE
      // (10. 8. 2026 — největší zbylý zdroj sekání v herním režimu).
      //
      // Časová osa jednoho oddálení na z11 (skutečné gesto, 2,5 s):
      //   80× `addImage`, 130× `_updateTilesForChangedImages`,
      //   27× `setData` (= 9 přepočtů kaskády po třech zdrojích),
      //   **40× přestavba atlasu ikon, dohromady 358–606 ms**,
      //   jednotlivé nahrání 20–54 ms — tedy DELŠÍ NEŽ CELÝ SNÍMEK.
      // Uvnitř dlouhých snímků to dělalo `tile.upload` 17 ms/snímek
      // (atlas 846×1387 px se staví a nahrává do GPU znovu a znovu).
      //
      // Vlákno příčin: pumpa vkládá 2 kresby za snímek → každá dávka
      // volala `naplanuj()` → přepočet → `setData` na tři zdroje →
      // dlaždice každého se přeparsují → nový atlas → upload.
      // Přepočet tak běžel ~6× za vteřinu, i když se v mezidobí změnily
      // dvě kresby ze sta.
      //
      // Slučování řeší rychlostní strop přímo v `naplanuj` (viz tam):
      // průchod nejvýš jednou za `MIN_ROZESTUP_MS` a s doběhem, takže se
      // dávky slijí samy a nic se neztratí.
      naplanuj();
      const trvani = performance.now() - tStart;
      if (trvani > 15) {
        console.log('[Ilustrace] atlas', n, 'kreseb za',
            Math.round(trvani), 'ms | ve frontě', frontaVkladani.length);
      }
    }
    if (frontaVkladani.length) {
      requestAnimationFrame(pumpujVkladani);
    } else {
      pumpaBezi = false;
    }
  }

  /// varianta: '' barevná, '#bw' sépiová, '#sil' silueta s otazníkem;
  /// přípona `@m` = ZMENŠENÁ kresba pro vzdálený pohled (viz `MALA_SIRKA`).
  function zajisti(slug, varianta) {
    const id = 'ilus:' + slug + varianta;
    if (!mapa) return Promise.resolve(false);
    // ⭐ 'uz' × 'nove': volající u `Promise.all(potreba)` podle toho pozná,
    // jestli má SMYSL přeposlat data. Obojí je pravdivé (kresba je
    // k dispozici), ale jen 'nove' znamená, že se něco změnilo.
    if (mapa.hasImage(id)) return Promise.resolve('uz');
    if (selhane.has(slug)) return Promise.resolve(false);
    const klic = slug + varianta;
    const bezici = rozpracovane.get(klic);
    if (bezici) return bezici;
    const prip = pripona(varianta);
    const prace = (async () => {
      try {
        const odpoved = await fetch(cestaKresby(slug));
        if (!odpoved.ok) throw new Error('HTTP ' + odpoved.status);
        const blob = await odpoved.blob();
        // ⭐ Zmenšuje se UŽ PŘI DEKÓDOVÁNÍ (`resizeWidth`), ne přes canvas:
        // je to práce dekodéru mimo hlavní vlákno a rovnou ušetří i paměť.
        // Výška se dopočítá poměrem, takže kresby s jinými proporcemi
        // (jsou všechny 280 px široké, ale různě vysoké) zůstanou celé.
        const bitmapa = prip
          ? await createImageBitmap(blob,
              { resizeWidth: prip === '@s' ? MINI_SIRKA : MALA_SIRKA,
                resizeQuality: 'high' })
          : await createImageBitmap(blob);
        // do atlasu přes frontu (≤2 na snímek) — bez zadrhnutí
        return (await zaradVlozeni(id, bitmapa, varianta)) ? 'nove' : false;
      } catch (e) {
        selhane.add(slug);
        console.warn('[Ilustrace] nejde načíst kresba', slug, e);
        return false;
      } finally {
        rozpracovane.delete(klic);
      }
    })();
    rozpracovane.set(klic, prace);
    return prace;
  }

  function pridejOdznakovyPodklad() {
    if (!mapa || mapa.hasImage('ilus-odznak')) return;
    const s = 2;
    const w = 36 * s; const h = 18 * s; const r = 9 * s;
    const p = document.createElement('canvas');
    p.width = w;
    p.height = h;
    const ctx = p.getContext('2d');
    const x = s; const y = s; const rw = w - 2 * s; const rh = h - 2 * s;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(x, y, rw, rh, r);
    } else {
      // starší WebView/Firefox bez roundRect — obejít přes arcTo
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + rw, y, x + rw, y + rh, r);
      ctx.arcTo(x + rw, y + rh, x, y + rh, r);
      ctx.arcTo(x, y + rh, x, y, r);
      ctx.arcTo(x, y, x + rw, y, r);
      ctx.closePath();
    }
    ctx.fillStyle = '#F2E2BC';
    ctx.fill();
    ctx.lineWidth = s;
    ctx.strokeStyle = '#8C6B3F';
    ctx.stroke();
    mapa.addImage('ilus-odznak', ctx.getImageData(0, 0, w, h), {
      pixelRatio: s,
      stretchX: [[14 * s, 22 * s]],
      stretchY: [[8 * s, 10 * s]],
      content: [7 * s, 3 * s, 29 * s, 15 * s],
    });
  }

  function pismoProStuhu(jmeno, labW, labH) {
    merak.font = '700 100px "Noto Sans", sans-serif';
    const sirka100 = Math.max(1, merak.measureText(jmeno).width);
    // ⚠️ 10. 8. 2026 zkoušeno 0,56 / 0,78 (výtka „názvy pod obrázky jsou
    // moc drobné"); VRÁCENO na původní, uživatel chce zadat přesněji.
    return Math.min(0.46 * labH, 0.72 * labW * 100 / sirka100 * 0.96);
  }

  // -------------------------------------------------------------------------
  // Vrstvy a zdroje
  // -------------------------------------------------------------------------
  function pridejVrstvy() {
    if (!mapa || mapa.getSource('ilus-obrazky')) return;
    if (!mapa.getSource('mlha-maska')) return;   // jen herní styl
    const prazdny = { type: 'FeatureCollection', features: [] };
    const opacita = ['coalesce', ['feature-state', 'op'], 0];

    // buffer 0: symboly u kraje dlaždice se jinak skládají 2–4× (v každé
    // sousední dlaždici znovu) — s allow-overlap není přesah k ničemu.
    // ⛔ v1.402: maxzoom 14 tehdy TIŠE rozbil kresby (po setData většího
    // nákladu worker serviroval prázdné dlaždice; data ve zdroji byla,
    // buckety 0) — strop šel pryč, mechanismus nevysvětlen.
    // 🧪 v1.426: ŘÍZENÝ NÁVRAT („zkus test maxzoom“): maxzoom 12 —
    // nad z12 se nepřeřezává (overzoom), zoomová gesta ušetří krájení
    // 3 zdrojů. Nástraha: kotva Karlštejn z11,5 (kresba+stužka+zdroj)
    // po těžkém cyklování kaskády; při návratu symptomu strop SUNDAT.
    mapa.addSource('ilus-stuhy',
                   { type: 'geojson', data: prazdny, buffer: 0, maxzoom: 12 });
    mapa.addSource('ilus-obrazky',
                   { type: 'geojson', data: prazdny, buffer: 0, maxzoom: 12 });
    mapa.addSource('ilus-odznaky',
                   { type: 'geojson', data: prazdny, buffer: 0, maxzoom: 12 });

    // stužky POD obrázky
    mapa.addLayer({
      id: 'ink-ilustrace-stuhy', type: 'symbol', source: 'ilus-stuhy',
      // ⭐ v1.405 (bod A): stuhy kreseb se účastní kolizí — jména
      // sídel mají přednost (rozmisťují se dřív), kolidující stuha
      // se schová; kresba samotná zůstává.
      layout: {
        'icon-image': 'ilus-stuha',
        'icon-size': ['get', 'isz'],
        // pod kresbou: kotva horním okrajem (zeměpisný bod / místo);
        // samotná uhýbající stužka (rb=1) kotví středem
        'icon-anchor': ['case', ['==', ['get', 'rb'], 1], 'center', 'top'],
        'icon-offset': ['get', 'iof'],
        'icon-allow-overlap': false,
        'icon-ignore-placement': false,
        'text-field': ['get', 't'],
        'text-font': ['Noto Sans Bold'],
        'text-size': ['get', 'ts'],
        // text VŽDY středem (tof míří na střed stuhy) — kotva 'top'
        // posílala text i s výškou řádku přes spodní hranu stuhy
        'text-anchor': 'center',
        'text-offset': ['get', 'tof'],
        'text-allow-overlap': false,
        'text-ignore-placement': false,
        'symbol-sort-key': ['get', 'srt'],
      },
      paint: {
        'icon-opacity': opacita,
        'text-opacity': opacita,
        'text-color': '#3A2812',
      },
    });

    // ⭐ 5. 9. 2026: STÍNY KRESEB – tatáž featura, obrázek `st`
    // (varianta #stin), leží na mapě (pitch/rotation alignment map),
    // posun `sof` od světla (viz vyrobFeatury + svetlo()), síla paint.
    // kontaktní stín u paty kresby (elipsa `stin-pata` z main.js)
    try { if (window.zajistiStinPatu) window.zajistiStinPatu(); } catch (e) { }
    mapa.addLayer({
      id: 'ink-ilustrace-pata', type: 'symbol', source: 'ilus-obrazky',
      filter: ['has', 'pof'],
      layout: {
        'icon-image': 'stin-pata',
        'icon-size': vyrazVelikosti(),
        'icon-offset': ['get', 'pof'],
        'icon-anchor': 'center',
        'icon-pitch-alignment': 'map',
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['get', 'srt'],
      },
      paint: { 'icon-opacity': ['*', opacita, 0.26] },
    });
    mapa.addLayer({
      id: 'ink-ilustrace-stin', type: 'symbol', source: 'ilus-obrazky',
      filter: ['has', 'st'],
      layout: {
        'icon-image': ['get', 'st'],
        'icon-size': vyrazVelikosti(),
        'icon-offset': ['get', 'sof'],
        'icon-anchor': 'center',
        'icon-pitch-alignment': 'map',
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['get', 'srt'],
      },
      paint: { 'icon-opacity': ['*', opacita, stinSila] },
    });

    mapa.addLayer({
      id: 'ink-ilustrace', type: 'symbol', source: 'ilus-obrazky',
      layout: {
        'icon-image': ['get', 'ik'],
        'icon-size': vyrazVelikosti(),
        'icon-offset': ['get', 'iof'],
        'icon-anchor': 'center',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': ['get', 'srt'],
      },
      paint: { 'icon-opacity': opacita },
    });

    try {
      pridejOdznakovyPodklad();
    } catch (e) {
      console.warn('[Ilustrace] odznakový podklad', e);
    }
    mapa.addLayer({
      id: 'ink-ilustrace-odznaky', type: 'symbol', source: 'ilus-odznaky',
      layout: {
        'icon-image': 'ilus-odznak',
        'icon-text-fit': 'both',
        'icon-text-fit-padding': [1, 6, 1, 6],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'text-field': ['get', 't'],
        'text-font': ['Noto Sans Bold'],
        'text-size': 11,
        'text-offset': ['get', 'tof'],
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'icon-opacity': opacita,
        'text-opacity': opacita,
        'text-color': '#4A3418',
      },
    });

    // V Dobyvateli jsou kresby schované (má vlastní odznaky z webu) —
    // vrstvy vznikají i PO jeho zapnutí (styledata závod), proto se
    // rodí rovnou skryté; zpět je ukáže Dobyvatel.vypni()
    if (window.Dobyvatel && Dobyvatel.jeAktivni && Dobyvatel.jeAktivni()) {
      for (const id of ['ink-ilustrace-stuhy', 'ink-ilustrace',
                        'ink-ilustrace-odznaky']) {
        if (mapa.getLayer(id)) {
          mapa.setLayoutProperty(id, 'visibility', 'none');
        }
      }
    }

    registrujKlikani();
  }

  // -------------------------------------------------------------------------
  // Rozmístění: obrázek → stužka → shluk; prodleva režimů s dotažením
  // -------------------------------------------------------------------------
  const prekryv = (a, b) =>
    a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  const nafoukni = (r, o) =>
    ({ l: r.l - o, t: r.t - o, r: r.r + o, b: r.b + o });
  const obdelnik = (cx, cy, w, h) =>
    ({ l: cx - w / 2, t: cy - h / 2, r: cx + w / 2, b: cy + h / 2 });

  function zmenaRezimuOK(slug, novy, z) {
    const s = stavRezimu.get(slug);
    if (!s || s.rezim === novy) return true;
    const ted = performance.now();
    if (ted - s.ms > PRODLEVA_MS) return true;
    if (Math.abs(z - s.z) > PRODLEVA_ZOOM) return true;
    return false;
  }

  function nastavRezim(slug, rezim, z) {
    const s = stavRezimu.get(slug);
    if (!s || s.rezim !== rezim) {
      stavRezimu.set(slug, { rezim, ms: performance.now(), z });
    }
  }

  // Odložená změna režimu se musí dotáhnout i na STOJÍCÍ mapě — jinak
  // vydrží špatný stav do dalšího gesta a tam PROBLIKNE
  let dalsiPas = 0;

  function odlozPas(slug) {
    const s = stavRezimu.get(slug);
    if (!s) return;
    const t = s.ms + PRODLEVA_MS + 30;
    if (!dalsiPas || t < dalsiPas) dalsiPas = t;
  }

  // Diagnostika dlouhých průchodů (bez ní se „seká to při oddálení"
  // hádá naslepo). Loguje jen skutečné špičky, ne každý pas.
  const DIAG_MS = 30;

  /// ⭐⭐ PROJEKCE BEZ SÁHNUTÍ NA VÝŠKOVÝ MODEL (9. 8. 2026 večer).
  ///
  /// `mapa.project()` se ZAPNUTÝM TERÉNEM promítá na povrch kopců, a to
  /// znamená dotaz do výškového modelu při KAŽDÉM volání. Kaskáda ho
  /// přitom volá pro každé z 455 míst v každém průchodu.
  /// Změřeno na telefonu (455 volání, náklon 42°):
  ///     se zapnutým terénem … 289–382 ms
  ///     bez terénu ………………………   1–2 ms
  /// To je 170× a **je to celý ten průchod** (144–239 ms). Tady se proto
  /// promítá naplocho — na rozmístění kreseb výška terénu stejně nemá vliv,
  /// řeší se překryvy na obrazovce.
  ///
  /// ⚠️ TATÁŽ PAST BYLA RÁNO V `dekorace.js` a stála tam skoro všechny
  /// stromy (ze 114 kandidátů prošlo 10). Když se někde počítá poloha
  /// mnoha bodů za snímek, `mapa.project()` s terénem tam nepatří.
  /// ⚠️ Pojistka: když knihovna tuhle metodu nemá, použije se původní
  /// `mapa.project` a chování zůstane jako dřív.
  function promitniPloche(lon, lat) {
    const t = mapa.painter && mapa.painter.transform;
    if (t && typeof t.locationToScreenPoint === 'function') {
      try { return t.locationToScreenPoint({ lng: lon, lat: lat }); } catch (e) { /* níž */ }
    }
    return mapa.project([lon, lat]);
  }

  function prepocitej() {
    if (!mapa || !seznam) return;
    const zdrojO = mapa.getSource('ilus-obrazky');
    if (!zdrojO) return;
    const tStart = performance.now();
    const z = mapa.getZoom();
    const el = mapa.getContainer();
    const sw = el.clientWidth || 360;
    const sh = el.clientHeight || 640;
    dalsiPas = 0;
    srovnejPasma(sw);
    const stred = mapa.getCenter();   // pro zeměpisný řez kandidátů

    // 1) kandidáti (i mimo obrazovku); přednačtení 0,8 zoomu předem
    const cand = [];
    for (const p of seznam) {
      if (skupina !== 'vse' && p.d !== skupina) continue;
      const op = viditelnost(p, z, sw);
      const brzy = op === null && z > p.zInEff - 0.8 && z < p.zInEff + 1;
      if (op === null && !brzy) continue;
      // ⛔⛔ v1.403: KANDIDÁTY ŘEZAT ZEMĚPISNĚ, NE OBRAZOVKOU (13. 8.,
      // vyřešení „zmizelých kreseb“). Při náklonu se VZDÁLENÁ místa
      // promítají k horizontu (Plzeň ze Sezemic: y=−1103 px na z14!),
      // obrazovkový filtr ±2,5 obrazovky je pustil dál a desítky
      // dálkových obrů pak v rozmisťování vytlačily místní kresby —
      // „zmizely“ a atlas nesl 44 zbytečných ikon. Zeměpisná meřítka
      // náklon nezajímají: 3,5 obrazovky při rovném pohledu.
      const mNaPx = 156543.03 * Math.cos(stred.lat * Math.PI / 180)
          / Math.pow(2, z);
      const maxLat = 3.5 * sh * mNaPx / 111320;
      const maxLon = 3.5 * sw * mNaPx
          / (111320 * Math.cos(stred.lat * Math.PI / 180));
      if (Math.abs(p.lat - stred.lat) > maxLat
          || Math.abs(p.lon - stred.lng) > maxLon) {
        continue;
      }
      const pos = promitniPloche(p.lon, p.lat);
      const w = sirkaPx(p, z, sw);
      if (pos.x + w < -2.5 * sw || pos.x - w > 3.5 * sw
          || pos.y + w < -2.5 * sh || pos.y - w > 3.5 * sh) {
        continue;
      }
      // TŘI STAVY (přání 6. 8.): navštívené barevně, objevené (dle
      // mlhy) černobíle, neobjevené jen SILUETA s otazníkem — kresba
      // je odměna za objevení, jméno na stužce zůstává jako lákadlo
      const stav = (navstivene.has(p.s) ? ''
        : (typeof Mlha !== 'undefined' && Mlha.jeObjeveno(p.lon, p.lat)
            ? '#bw' : '#sil'))
        // zmenšenina, dokud je kresba na obrazovce malá (viz `MALA_SIRKA`)
        + priponaVelikosti(p.s, w);
      if (brzy) {
        // PŘEDNAČÍTÁNÍ JEN NA STOJÍCÍ MAPĚ A JEN KOLEM VÝŘEZU (6. 8.
        // 2026, „výkon při oddálení"). Kandidátské síto výš pouští
        // okolí o velikosti 6×6 obrazovek — při oddalování se tím
        // stihlo do fronty nasypat 196 kreseb a každá stojí ~12 ms
        // canvasu a uploadu do atlasu (= přes dvě sekundy hlavního
        // vlákna). Co se opravdu ukáže, dotáhne `Promise.all(potreba)`
        // níž; tohle je jen pohodlí navíc, ne nutnost.
        if (!mapa.isMoving()
            && pos.x > -0.5 * sw && pos.x < 1.5 * sw
            && pos.y > -0.5 * sh && pos.y < 1.5 * sh) {
          zajisti(p.s, stav);
        }
        continue;
      }
      cand.push({
        p, slug: p.s, imp: p.imp, op, w, h: w * p.vy / 280,
        ax: pos.x, ay: pos.y, nb: !!p.nb, stav,
        // rezervaci smí vynechat JEN skutečné rozplývání (fade-out) —
        // rodící se kresby (op<0,75 při náběhu) rezervovat MUSÍ, jinak
        // se souběžně narození sousedé překreslí přes sebe
        rozplyva: z > fadeStart(p, sw),
      });
    }

    // 2) důležitější má přednost (velikost se rozmístěním NEMĚNÍ)
    cand.sort((a, b) => (b.imp - a.imp) || (b.w - a.w));
    const obsazene = [];
    const umistene = [];
    const schovane = [];

    for (const it of cand) {
      const stav = stavRezimu.get(it.slug);
      const minule = stav ? stav.rezim : 9;
      let placed = null;

      // — obrázek (+ stužka pod ním) —
      {
        // KOLIZE JEN PŘES MOTIV (samotnou kresbu): box nafouknutý o
        // stužku a okraje dřív vyřazoval sousedy, kteří by se vešli
        // (výtka 6. 8.: „Středohoří je dlouho prázdné, ač by se vešlo"
        // — vytlačovalo ho České Švýcarsko 143 px daleko kvůli stuze).
        // Překryv stuh je vizuálně neškodný (pergamen, řazení dle imp).
        const cy = it.ay + (it.nb ? 0 : BANNER_BIAS * it.h);
        const bounds = obdelnik(it.ax, cy, it.w, it.h);
        // i NOVÉ umístění smí do souseda mírně zakousnout (−8 % šířky):
        // kresby jsou nepravidelné s průhlednými okraji a binární zákaz
        // nechával „skoro se vešel" dvojice (Středohoří × Švýcarsko,
        // svislý překryv 3,5 px) schované
        const okraj = minule === 0
          ? -(it.w * 0.10 + 6.0) : -(it.w * 0.08);
        const koliduje =
          obsazene.some((r) => prekryv(r, nafoukni(bounds, okraj)));
        if (!koliduje && (minule === 0 || zmenaRezimuOK(it.slug, 0, z))) {
          placed = { it, obrazek: true, bounds };
          nastavRezim(it.slug, 0, z);
        } else if (!koliduje) {
          odlozPas(it.slug);          // povýšení čeká na prodlevu
        } else if (koliduje && minule === 0
                   && !zmenaRezimuOK(it.slug, 5, z)) {
          // kolize může být přechodná — podržet a dotáhnout časovačem
          placed = { it, obrazek: true, bounds };
          odlozPas(it.slug);
        }
      }

      // — aspoň stužka (uhýbá svisle); z dálky se osamocené nekreslí —
      if (!placed && stuhaNactena && z >= 10.8) {
        const labW = RIBBON_ONLY_W;
        const labH = labW * stuhaAsp;
        const okraj = minule === 5 ? -9.0 : 3.0;
        const kroky = [0.0, labH * 1.15, -labH * 1.15, labH * 2.3,
                       -labH * 2.3, labH * 3.45, -labH * 3.45,
                       labH * 4.6];
        for (const dy of kroky) {
          const rect = obdelnik(it.ax, it.ay + dy, labW, labH);
          if (obsazene.some((r) => prekryv(r, nafoukni(rect, okraj)))) {
            continue;
          }
          if (minule !== 5 && !zmenaRezimuOK(it.slug, 5, z)) {
            odlozPas(it.slug);
            break;
          }
          placed = { it, obrazek: false, bounds: rect, dy };
          nastavRezim(it.slug, 5, z);
          break;
        }
      }

      if (!placed) {
        if (zmenaRezimuOK(it.slug, 6, z)) nastavRezim(it.slug, 6, z);
        else odlozPas(it.slug);
        schovane.push(it);
      } else {
        if (it.op > 0.75 || !it.rozplyva) obsazene.push(placed.bounds);
        umistene.push(placed);
      }
    }

    // schované → shluk nejbližšího umístěného
    const shluk = new Map();
    for (const h of schovane) {
      let best = null;
      let bestD = Infinity;
      for (const p of umistene) {
        const px = (p.bounds.l + p.bounds.r) / 2;
        const py = (p.bounds.t + p.bounds.b) / 2;
        const d = (px - h.ax) * (px - h.ax) + (py - h.ay) * (py - h.ay);
        if (d < bestD) { bestD = d; best = p; }
      }
      if (best) {
        if (!shluk.has(best.it.slug)) shluk.set(best.it.slug, [best.it.p]);
        shluk.get(best.it.slug).push(h.p);
      }
    }
    posledniShluky = shluk;

    // 3) featury per KLÍČ (slug#druh) + cílové opacity
    const noveCile = new Map();
    const zive = new Map();          // klíč → featura
    for (const pl of umistene) {
      const it = pl.it;
      const featury = vyrobFeatury(pl, z, sw, shluk.get(it.slug));
      for (const [druh, feat] of Object.entries(featury)) {
        const klic = it.slug + '#' + druh;
        zive.set(klic, feat);
        if (!prolnuti.has(klic)) prolnuti.set(klic, 0);
        // obrázek nerozsvěcet, dokud kresba není v atlasu — po fetch
        // proběhne setData + naplanuj a teprve pak se prolne z nuly
        let cil = it.op;
        if (druh === 'o' && !mapa.hasImage(feat.properties.ik)
            && !selhane.has(it.slug)) {
          cil = 0;
        }
        noveCile.set(klic, cil);
      }
    }

    // odchozí featury: nechat dohasnout, pak vypadnou samy
    for (const [klic, feat] of odchazejici) {
      if (zive.has(klic)) { odchazejici.delete(klic); continue; }
      if ((prolnuti.get(klic) || 0) <= 0.02) {
        odchazejici.delete(klic);
        prolnuti.delete(klic);
        continue;
      }
      zive.set(klic, feat);
      noveCile.set(klic, 0);
    }
    for (const [klic, hodnota] of prolnuti) {
      if (zive.has(klic) || hodnota <= 0.02) continue;
      const feat = posledniFeatury.get(klic);
      if (feat) {
        odchazejici.set(klic, feat);
        zive.set(klic, feat);
        noveCile.set(klic, 0);
      }
    }
    cile = noveCile;

    const fO = [];
    const fS = [];
    const fZ = [];
    const podpisDily = [];
    for (const [klic, feat] of zive) {
      posledniFeatury.set(klic, feat);
      const druh = klic.slice(klic.indexOf('#') + 1);
      if (druh === 'o') fO.push(feat);
      else if (druh === 'z') fZ.push(feat);
      else fS.push(feat);
      // PODPIS: klíč (nese režim) + diskriminátory neměnné za zoomu:
      // uhnutí stužky, text odznaku, režim kotvy stužky
      podpisDily.push(klic + ':' + (feat.properties.pd || ''));
    }
    // sw v podpisu: po změně velikosti okna se musí přepočítat stropy
    const podpis = podpisDily.sort().join(',') + '|' + skupina + '|' + sw;
    const drivejsiPodpis = posledniPodpis;   // jen pro diagnostiku níž

    if (podpis !== posledniPodpis) {
      posledniPodpis = podpis;
      const gjO = { type: 'FeatureCollection', features: fO };
      // ⛔⛔ v1.402.1: setData NIKDY synchronně Z OBSLUHY moveend.
      // Zevnitř události mapy se náklad ve v6 TIŠE ZTRATÍ (worker
      // index zůstane prázdný, dlaždice 0 bucketů, data přitom v
      // serialize() jsou — změřeno mnohokrát při honu 13. 8.);
      // totéž posláno z konzole V KLIDU projde vždy. setTimeout 0
      // jen vystupuje ze zásobníku události.
      setTimeout(() => {
        if (posledniPodpis !== podpis) return;   // už platí novější
        try { zdrojO.setData(gjO); } catch (e) { /* styl v přestavbě */ }
        const zdrojS = mapa.getSource('ilus-stuhy');
        if (zdrojS) zdrojS.setData({ type: 'FeatureCollection',
                                     features: fS });
        const zdrojZ = mapa.getSource('ilus-odznaky');
        if (zdrojZ) zdrojZ.setData({ type: 'FeatureCollection',
                                     features: fZ });
      }, 0);
      // kresby dotáhnout a PŘEPARSOVAT (past pozdního addImage) —
      // ale jen dokud platí TAHLE sestava; opožděný fetch nesmí
      // přepsat novější setData (závod při rychlém zoomu)
      const potreba = [...new Set(fO.map((f) => f.properties.ik)
        .concat(fO.map((f) => f.properties.st).filter(Boolean)))];
      Promise.all(potreba.map((ik) => {
        // `ilus:<slug>[#bw|#sil][@m]` — odloupnout obojí, ať se dotáhne
        // právě ta varianta, kterou sestava opravdu žádá
        const male = ik.endsWith('@m');
        const bezM = male ? ik.slice(0, -2) : ik;
        const zaklad = bezM.endsWith('#bw') ? '#bw'
          : (bezM.endsWith('#sil') ? '#sil'
          : (bezM.endsWith('#stin') ? '#stin' : ''));
        const slug = bezM.slice(5, zaklad ? -zaklad.length : undefined);
        return zajisti(slug, zaklad + (male ? '@m' : ''));
      })).then((vysledky) => {
        if (posledniPodpis !== podpis) return;   // už platí novější
        // ⭐⭐ PŘEPOSLAT JEN KDYŽ OPRAVDU PŘIBYLA KRESBA (10. 8. 2026).
        //
        // Bylo tu `vysledky.some(Boolean)`, jenže `zajisti` vracelo `true`
        // i pro kresbu, která v atlasu DÁVNO JE. Podmínka tedy platila
        // skoro vždycky a **na každý průchod kaskády šel druhý `setData`
        // se stejnými daty** — tedy přeparsování dlaždic a PŘESTAVBA
        // ATLASU IKON (nejdražší věc v celém herním režimu, 11–65 ms)
        // úplně pro nic.
        //
        // Bylo to i vysvětlení, proč ruční slučování `setData` zvenčí
        // pořád slévalo devět volání, i když průchodů bylo málo: polovina
        // volání nešla z průchodu, ale odsud.
        if (vysledky.some((v) => v === 'nove')) {
          const zdroj = mapa && mapa.getSource('ilus-obrazky');
          if (zdroj) zdroj.setData(gjO);
          naplanuj();   // rozsvítit obrázky, které na atlas čekaly
        }
      });
    }
    zapisStavy();
    spustAnimaci();

    const trvani = performance.now() - tStart;
    if (trvani > DIAG_MS) {
      console.log('[Ilustrace] pas', Math.round(trvani), 'ms | z',
          z.toFixed(1), '| kandidátů', cand.length, '| umístěno',
          umistene.length, '| setData', podpis !== drivejsiPodpis ? 'ano' : 'ne');
    }

    // dotažení odložených změn režimu na stojící mapě
    clearTimeout(prepocitej._t);
    if (dalsiPas) {
      prepocitej._t = setTimeout(prepocitej,
          Math.max(30, dalsiPas - performance.now()));
    }
  }

  // Pevná šířka stužky místa (ze středu jeho pásma) — čitelná, neroste
  function sirkaStuhy(p, sw) {
    const stredni = Math.sqrt(MIN_PX * stropPx(p, sw));
    return Math.min(MAX_LABEL_W,
        Math.max(MIN_LABEL_W, LABEL_W_FRAC * stredni));
  }

  /// Featury jednoho umístěného místa. Klíče: o (obrázek), s0 (stužka
  /// pod obrázkem), s1 (samotná stužka), z (odznak +N). properties.pd =
  /// diskriminátor do podpisu (věci neměnné za čistého zoomu).
  function vyrobFeatury(pl, z, sw, clenove) {
    const it = pl.it;
    const p = it.p;
    const vysledek = {};
    if (pl.obrazek) {
      vysledek.o = {
        type: 'Feature', id: idFeatury(it.slug, 'o'),
        properties: {
          s: it.slug,
          ik: 'ilus:' + it.slug + it.stav,
          g0: p.g0,
          mx: stropPx(p, sw),
          // zrození – od něj roste podlaha velikosti (viz podlahaPx);
          // bez téhle vlastnosti by GPU křivka počítala od nuly a kresby
          // by po narození skočily do stropu
          zi: p.zInEff,
          iof: [0, it.nb ? 0 : 0.035 * p.vy],
          srt: it.imp,
          // stav v podpisu — objevení/návštěva musí projít setData
          pd: it.stav || 'c',
          // kontaktní stín: elipsa u paty kresby (vždy)
          pof: [0, (it.nb ? 0 : 0.035 * p.vy) + p.vy / 2],
          // ⭐ 5. 9. 2026 STÍN: obrázek #stin (týž rozměr @m/@s) a posun od
          // světla – pata stínu u paty kresby, dál podle azimutu a výšky
          // světla (stinDx/stinDy v násobcích výšky kresby, viz svetlo())
          ...(stinSila > 0 ? {
            st: 'ilus:' + it.slug + '#stin' + pripona(it.stav || ''),
            sof: [stinDx * p.vy,
                  (it.nb ? 0 : 0.035 * p.vy) + p.vy * (1 + STIN_ZPLOSTENI) / 2
                    + stinDy * p.vy],
          } : {}),
        },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      };
      if (it.nb && stuhaNactena) {
        const labW = sirkaStuhy(p, sw);
        const labH = labW * stuhaAsp;
        const isz = labW / stuhaZaklad;
        const ts = Math.max(5, pismoProStuhu(p.n, labW, labH));
        // KOTVA DLE FÁZE: v růstové fázi zeměpisně na spodní hraně
        // území (drží za zoomu samospádem); v klamp fázích (58 px /
        // strop) je kreslená velikost KONSTANTNÍ, takže drží konstantní
        // px ofset od místa. Přechody jsou spojité; režim jde do
        // podpisu, takže překlopení projde jedním setData.
        const uzemi = p.g0 * Math.pow(2, z);
        const mx = stropPx(p, sw);
        let geometrie;
        let posunPx;
        let rezimKotvy;
        if (uzemi < MIN_PX) {
          geometrie = [p.lon, p.lat];
          posunPx = MIN_PX * (p.vy / 280) / 2 + LABEL_OVERLAP_PX;
          rezimKotvy = 'm';
        } else if (uzemi > mx) {
          geometrie = [p.lon, p.lat];
          posunPx = mx * (p.vy / 280) / 2 + LABEL_OVERLAP_PX;
          rezimKotvy = 'x';
        } else {
          geometrie = [p.lon, p.latStuha];
          posunPx = LABEL_OVERLAP_PX;
          rezimKotvy = 'g';
        }
        vysledek.s0 = {
          type: 'Feature', id: idFeatury(it.slug, 's0'),
          properties: {
            s: it.slug, t: p.n, rb: 0, isz,
            iof: [0, posunPx / isz],
            ts,
            // STŘED textu na střed stuhy (kotva 'center'); −3 % výšky
            // jako u pečeného labelu v 2D
            tof: [0, (posunPx + labH * 0.5 - 0.03 * labH) / ts],
            srt: it.imp,
            pd: rezimKotvy,
          },
          geometry: { type: 'Point', coordinates: geometrie },
        };
      }
    } else {
      const labW = RIBBON_ONLY_W;
      const labH = labW * stuhaAsp;
      const isz = labW / stuhaZaklad;
      const ts = Math.max(5, pismoProStuhu(p.n, labW, labH));
      vysledek.s1 = {
        type: 'Feature', id: idFeatury(it.slug, 's1'),
        properties: {
          s: it.slug, t: p.n, rb: 1, isz,
          iof: [0, pl.dy / isz],
          ts,
          tof: [0, (pl.dy - 0.03 * labH) / ts],
          srt: it.imp,
          // uhnutí do podpisu — přeskok slotu musí projít setData
          pd: String(Math.round(pl.dy)),
        },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      };
    }
    if (clenove && clenove.length > 1) {
      const n = clenove.length - 1;
      const pillW = 14 + 7 * String(n).length;
      const dx = (pl.bounds.r - pl.bounds.l) / 2 - pillW / 2 - 2;
      const dy = pl.bounds.t - it.ay + 11;
      vysledek.z = {
        type: 'Feature', id: idFeatury(it.slug, 'z'),
        properties: {
          s: it.slug, t: '+' + n, tof: [dx / 11, dy / 11],
          // počet i kvantovaný roh do podpisu (jinak zůstane staré +N
          // a odznak po přiblížení ujede z rohu kresby)
          pd: n + '@' + Math.round(dy / 24),
        },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      };
    }
    return vysledek;
  }

  // ⛔ VYZKOUŠENO A NEPOTVRDILO SE (10. 8. 2026): přeskakovat zápisy stavu,
  // který se nezměnil. Vyfiltrovalo 47 % volání `setFeatureState`, ale na
  // dlouhých snímcích se to neprojevilo (19,7 vs 20,5 při rozptylu ±8).
  // Škrcení zápisů na 100 ms dopadlo stejně (A 21 · B 18,3 · C 19,7).
  // Cena tedy NENÍ v počtu zápisů stavů — je v přestavbě atlasu ikon,
  // viz rychlostní strop v `naplanuj`. Kdyby se k tomu někdo vracel: měřit
  // POČET PŘESTAVEB ATLASU, ne dlouhé snímky (ty tu mají rozptyl 16–32
  // u naprosto stejného kódu).
  function zapisStavy() {
    // Style.setFeatureState chybějící zdroj neshazuje výjimkou, ale
    // sype ErrorEventy do konzole — po odchodu z herního stylu se
    // zdroje ilus-* ruší společně, stačí jedna kontrola
    if (!mapa || !mapa.getSource('ilus-obrazky')) return;
    for (const [klic, hodnota] of prolnuti) {
      const i = klic.indexOf('#');
      const slug = klic.slice(0, i);
      const druh = klic.slice(i + 1);
      const id = indexDleSlugu.get(slug);
      if (id === undefined) continue;
      try {
        mapa.setFeatureState(
            { source: ZDROJ_DRUHU[druh], id: id * 4 + DRUH_ID[druh] },
            { op: hodnota });
      } catch (e) { /* styl se zrovna načítá */ }
    }
  }

  function spustAnimaci() {
    if (animBezi) return;
    animBezi = true;
    requestAnimationFrame(krokAnimace);
  }

  function krokAnimace() {
    let zije = false;
    for (const [klic, cur] of prolnuti) {
      const cil = cile.get(klic) || 0;
      if (Math.abs(cil - cur) < 0.01) continue;
      const dalsi = cur
        + Math.max(-FADE_KROK, Math.min(FADE_KROK, cil - cur));
      prolnuti.set(klic, dalsi);
      zije = true;
    }
    zapisStavy();
    if (zije) {
      requestAnimationFrame(krokAnimace);
    } else {
      animBezi = false;
      // dohaslé odchozí featury uklidit hned (ne až při dalším pohybu
      // mapy) — neviditelný symbol jinak chytal kliky
      for (const klic of odchazejici.keys()) {
        if ((prolnuti.get(klic) || 0) <= 0.02) { naplanuj(); break; }
      }
      // zamrzlé nulové stavy bez featury nechat zapomenout (jinak by
      // zapisStavy každé kolo psal stovky nul)
      for (const [klic, cur] of prolnuti) {
        if (cur <= 0.02 && (cile.get(klic) || 0) === 0
            && !odchazejici.has(klic)) {
          prolnuti.delete(klic);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Klikání a karta detailu (demo; v aplikaci je modul vypnutý)
  // -------------------------------------------------------------------------
  function registrujKlikani() {
    if (!mapa || mapa.__ilusKlikHook) return;
    mapa.__ilusKlikHook = true;
    mapa.on('click', (e) => {
      if (!mapa.getLayer('ink-ilustrace')) { schovejDetail(); return; }
      const vrstvy = ['ink-ilustrace', 'ink-ilustrace-stuhy',
                      'ink-ilustrace-odznaky']
        .filter((v) => mapa.getLayer(v));
      if (window.Dobyvatel && Dobyvatel.spolklKlik(e)) return;
      const prvky = mapa.queryRenderedFeatures(e.point, { layers: vrstvy });
      // dohaslé (odchozí) featury nesmí chytat kliky
      const prvek = prvky.find((f) => !f.state
          || f.state.op === undefined || f.state.op > 0.05);
      if (!prvek) { schovejDetail(); return; }
      const slug = prvek.properties.s;
      if (window.__okolnikApp) {
        // Shluk (odznak „+N") musí do appky jít jako SEZNAM slugů — jinak
        // by se sousedé schovaní pod kresbou nedali otevřít vůbec. Appka
        // na to má tentýž seznam jako 2D (home_screen._onIllusClusterTap).
        const cleni = posledniShluky.get(slug);
        try {
          if (cleni && cleni.length > 1) {
            window.flutter_inappwebview.callHandler(
                'onShlukMist', cleni.map((m) => m.s));
          } else {
            window.flutter_inappwebview.callHandler('onMisto', slug);
          }
        } catch (err) { console.warn('[most] onMisto', err); }
        return;
      }
      const clen = posledniShluky.get(slug);
      if (clen && clen.length > 1) ukazShluk(clen);
      else ukazDetail(slug);
    });
    for (const v of ['ink-ilustrace', 'ink-ilustrace-stuhy']) {
      mapa.on('mouseenter', v,
              () => { mapa.getCanvas().style.cursor = 'pointer'; });
      mapa.on('mouseleave', v,
              () => { mapa.getCanvas().style.cursor = ''; });
    }
  }

  function ukazDetail(slug) {
    const m = (seznam || []).find((x) => x.s === slug);
    const karta = document.getElementById('ilus-detail');
    if (!m || !karta) return;
    karta.querySelector('img').src = cestaKresby(m.s);
    karta.querySelector('h3').textContent = m.n;
    karta.querySelector('.druh').textContent = DRUHY[m.d] || '';
    const popis = karta.querySelector('p');
    popis.textContent = m.o || '';
    popis.style.display = m.o ? 'block' : 'none';
    const stary = karta.querySelector('.shluk');
    if (stary) stary.remove();
    karta.style.display = 'block';
  }

  function ukazShluk(mista) {
    const karta = document.getElementById('ilus-detail');
    if (!karta) return;
    ukazDetail(mista[0].s);
    const rad = [...mista].sort((a, b) => b.imp - a.imp);
    const box = document.createElement('div');
    box.className = 'shluk';
    box.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:8px';
    for (const p of rad) {
      const b = document.createElement('button');
      b.textContent = p.n;
      b.style.cssText = 'border:1px solid rgba(74,59,40,.45);cursor:pointer;'
        + 'border-radius:9px;background:#EFE0BE;color:#3A2812;'
        + 'font-size:11px;padding:2px 8px';
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ukazDetail(p.s);
      });
      box.appendChild(b);
    }
    karta.appendChild(box);
  }

  function schovejDetail() {
    const karta = document.getElementById('ilus-detail');
    if (karta) karta.style.display = 'none';
  }

  // -------------------------------------------------------------------------
  // Filtr druhů (chipy #ilus-filtr — jen demo)
  // -------------------------------------------------------------------------
  function filtruj(nova) {
    skupina = nova || 'vse';
    for (const b of document.querySelectorAll('#ilus-filtr button')) {
      b.classList.toggle('aktivni', b.dataset.skupina === skupina);
    }
    schovejDetail();
    prepocitej();
  }

  const panelFiltru = document.getElementById('ilus-filtr');
  if (panelFiltru) {
    panelFiltru.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) filtruj(b.dataset.skupina);
    });
  }
  const zavritDetail = document.querySelector('#ilus-detail .zavrit');
  if (zavritDetail) zavritDetail.addEventListener('click', schovejDetail);

  // -------------------------------------------------------------------------
  // Napojení (volá aplikujDoplnky po style.load herního stylu)
  // -------------------------------------------------------------------------
  let posledniPass = 0;
  let hookyMapy = false;
  let mlhaHook = false;

  /// Kdy naposledy proběhl přepočet kaskády (rychlostní strop níž).
  let poslPrepocetMs = 0;

  /// ⭐⭐ RYCHLOSTNÍ STROP NA PRŮCHOD KASKÁDY (10. 8. 2026).
  ///
  /// Každý průchod končí `setData` na tři zdroje `ilus-*`, a to znamená
  /// přeparsování jejich dlaždic a **přestavbu atlasu ikon**. Časová osa
  /// jednoho oddálení ukázala 9 průchodů za 2,5 s, tedy ~6× za vteřinu.
  ///
  /// ⚠️ Dokud byl atlas drahý (3,12 Mpx), slučování průchodů se ve výsledku
  /// UTOPILO V ŠUMU a vypadalo jako nulový nález. Teprve s levným atlasem
  /// (0,51 Mpx po prahu významnosti) se ukázalo, co dělá: **67 ms proti
  /// 150 ms v přestavbách a 11 proti 16,5 dlouhých snímků**. Pořadí oprav
  /// tady rozhodovalo o tom, jestli je vidět — proto to sem píšu.
  ///
  /// Je to strop s DOBĚHEM, ne prosté zahazování: co se nestihlo, doběhne
  /// na konci intervalu. Průchod se tím nikdy neztratí, jen počká.
  ///
  /// ⛔ RYCHLOSTNÍ STROP NA CELÝ PRŮCHOD BYL ZKOUŠEN A ZAMÍTNUT.
  /// 300 ms mezi průchody nepřineslo nic (A 298 ms proti B 197 ms
  /// v přestavbách — ruční slučování `setData` pořád slévalo devět volání,
  /// takže průchody zjevně nebyly to, co jich chodí moc). Skutečný viník
  /// byl ZBYTEČNÝ DRUHÝ `setData` po dotažení kreseb — viz níž u
  /// `Promise.all(potreba)`. Kdyby se k tomu někdo vracel: cross-build
  /// srovnání tady NEPLATÍ, telefon má po hodinách měření 51 °C a čísla
  /// se tím zdvojnásobí; platný je jen A/B uvnitř jednoho běhu.
  function naplanuj() {
    clearTimeout(naplanuj._t);
    naplanuj._t = setTimeout(() => {
      poslPrepocetMs = Date.now();
      prepocitej();
    }, 40);
  }

  // ZAHŘÁTÍ KEŠE (výtka 6. 8. „nedá se to přednačíst?"): na pozadí po
  // dávkách stáhnout soubory kreseb podle důležitosti — jen fetch do
  // HTTP keše, bez dekódování a bez atlasu. Pozdější příchody pak
  // nečekají na síť a zbylou práci rozprostře fronta vkládání.
  let zahrivaniBezi = false;

  function zahrejKese() {
    if (zahrivaniBezi || !seznam) return;
    zahrivaniBezi = true;
    const poradi = [...seznam].sort((a, b) => b.imp - a.imp);
    let i = 0;
    const krok = () => {
      for (let k = 0; k < 4 && i < poradi.length; k++, i++) {
        fetch(cestaKresby(poradi[i].s)).catch(() => {});
      }
      if (i < poradi.length) setTimeout(krok, 200);
    };
    setTimeout(krok, 1500);   // až se rozjede styl a první sestava
  }

  function registrujHookyMapy() {
    if (hookyMapy || !mapa) return;
    hookyMapy = true;
    mapa.on('move', () => {
      const ted = performance.now();
      // Při AKTIVNÍM ZOOMU stačí průchod zřídka (9. 8., „posekává se
      // při oddálení hodně": plný přepočet 455 míst + setData bouře
      // každých 150 ms = špičky 300 ms a 33 fps; jen pár míst = 152
      // fps). Velikosti kreseb během zoomu řeší GPU křivka icon-size
      // a výměny režimů stejně drží prodleva 650 ms — častý přepočet
      // nemá co zlepšit. Posun bez zoomu zůstává na 150 ms (uhýbání
      // stužek u krajů).
      // ⭐⭐ BĚHEM ZOOMU SE NEPŘEPOČÍTÁVÁ VŮBEC (9. 8. 2026 večer).
      // Změřeno z vlastního logu enginu: při 1,3s zoomové trase proběhly
      // DVA průchody a sežraly **330 ms** (186 + 144 ms, 147 kandidátů) —
      // tedy čtvrtinu času, a to v kusech po 11 zmeškaných snímcích.
      // Při posunu ani v klidu neproběhl ANI JEDEN. Je to tedy přesně to,
      // co uživatel roky hlásí jako „seká to při zoomování".
      // ⚠️ Vynechat ho lze bez ztráty, jak říká poznámka o řádek níž už
      // od rána: velikosti řeší GPU křivka `icon-size` a výměny režimů
      // stejně drží prodleva 650 ms. Zbylý průchod na `moveend` dožene
      // všechno v okamžiku, kdy mapa už stojí — tam 150 ms nikdo nevidí.
      // Snížení frekvence na 1200 ms (dřívější pokus téhož dne) NESTAČILO:
      // jeden průchod uprostřed gesta zmrazí obraz stejně jako deset.
      if (mapa.isZooming && mapa.isZooming()) return;
      if (ted - posledniPass < 150) return;
      posledniPass = ted;
      prepocitej();
    });
    mapa.on('moveend', () => {
      posledniPass = performance.now();
      prepocitej();
    });
    mapa.on('resize', naplanuj);
  }

  function pripoj(map) {
    // ⚠️ KASKÁDA JEDE I V APLIKACI (od 6. 8. 2026, přání uživatele
    // „pořadí objevování obrázků udělej podle enginu"). Do té doby si
    // velká malovaná místa kreslil Okolník sám přes `mista()` — všechna
    // najednou, s pevnou růstovou křivkou, bez stužek se jmény a bez
    // předávek mezi úrovněmi. Teď je posílat NESMÍ (jinak by byla
    // dvakrát); seznam i důležitosti si engine bere z assets/ilustrace.json
    // (455 kreseb, shoduje se se `kIllusPlaces` v appce — ověřeno) a
    // navštívená hlásí aplikace přes `OkolnikMost.navstivenaMista()`.
    mapa = map;
    selhane.clear();
    stuhaBezi = false;
    stuhaNactena = false;
    posledniPodpis = '';       // nový styl = zdroje znovu naplnit
    nactiStuhu();
    nactiSeznam().then(() => {
      if (!mapa || !seznam) return;
      pridejVrstvy();
      registrujHookyMapy();
      // objev mlhy mění stav kreseb (silueta → černobílá) → přepočet
      if (!mlhaHook && typeof Mlha !== 'undefined') {
        mlhaHook = true;
        Mlha.priObjeveni(() => naplanuj());
      }
      // vrchol se jménem malovaného místa by byl dvakrát (kresba + ▲)
      if (mapa.getLayer('ink-vrcholy')) {
        mapa.setFilter('ink-vrcholy', ['all',
          ['case', ['<', ['zoom'], 12],
           ['<=', ['coalesce', ['get', 'rank'], 9], 2], true],
          ['!', ['in', ['coalesce', ['get', 'name:cs'], ['get', 'name']],
                 ['literal', seznam.map((p) => p.n)]]]]);
      }
      prepocitej();
      zahrejKese();
      console.log('[Ilustrace] kaskáda v2.7: míst', seznam.length,
                  '| vrstvy', !!mapa.getLayer('ink-ilustrace'),
                  '| zdroj kreseb', cestaKresby('…'));
    });
  }

  function nastavNavstivene(pole) {
    navstivene = new Set(pole || []);
    posledniPodpis = '';
    prepocitej();
  }

  /// ⭐ 5. 9. 2026: SVĚTLO → STÍNY KRESEB. Volá svetlo.js po každém
  /// přepočtu (slunce / měsíc / tma). Směr = OD světla (azimut + 180°),
  /// délka podle výšky světla (cot, ohraničeno), síla podle zdroje
  /// a oblačnosti. Vlastní posun nese každá featura (`sof`), takže se
  /// po změně přestaví featury; síla je paint vrstvy.
  let stinSila = 0;
  let stinDx = 0;
  let stinDy = 0;
  function svetlo(sv, st) {
    try {
      if (!sv) return;
      let sila = 0;
      if (sv.zdroj === 'slunce') {
        sila = 0.32 * Math.max(0.45, Math.min(1, (sv.el || 0) / 25));
      } else if (sv.zdroj === 'mesic') {
        sila = 0.16 * Math.max(0.3, Math.min(1, (st && st.mesicOsvit) || 0.5));
      }
      if (st && typeof st.oblacnost === 'number') sila *= (1 - 0.6 * st.oblacnost);
      const elRad = Math.max(8, Math.min(80, sv.el || 45)) * Math.PI / 180;
      const delka = 0.35 * Math.max(0.25, Math.min(2.2, 1 / Math.tan(elRad)));
      const smer = ((sv.az || 0) + 180) * Math.PI / 180;
      const dx = Math.sin(smer) * delka;
      const dy = -Math.cos(smer) * delka;
      const zmena = Math.abs(dx - stinDx) > 0.02 || Math.abs(dy - stinDy) > 0.02
        || Math.abs(sila - stinSila) > 0.02 || (sila > 0) !== (stinSila > 0);
      stinSila = +sila.toFixed(3);
      stinDx = +dx.toFixed(3);
      stinDy = +dy.toFixed(3);
      if (mapa && mapa.getLayer && mapa.getLayer('ink-ilustrace-stin')) {
        // `opacita` je lokální výraz vrstvy kreseb – vzít ho z ní
        const op = mapa.getPaintProperty('ink-ilustrace', 'icon-opacity');
        mapa.setPaintProperty('ink-ilustrace-stin', 'icon-opacity',
                              ['*', op == null ? 1 : op, stinSila]);
      }
      if (zmena) naplanuj();
    } catch (e) { console.warn('[Ilustrace] stín', e); }
  }

  return { pripoj, filtruj, zavri: schovejDetail,
           navstivene: nastavNavstivene, svetlo, stin: stinData };
})();
