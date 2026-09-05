// Okolník 3D — MRAKY PODLE SKUTEČNÉHO POČASÍ pro herní styl (v2.1).
//
// Přenos chování z 2D Okolníku (atmosphere.dart + weather.dart, laděno
// uživatelem ve v1.248 – „mraky menší, ale sytější"):
//   · počasí z Open-Meteo pro 14 krajských bodů (jeden dotaz, bez klíče),
//   · mrak visí NAD SVÝM KRAJEM (ne nad kamerou), pomalu se pohupuje,
//   · velikost ve světě ~28 km (roste s mapou, s pojistkami vůči displeji),
//   · základní síla 0,80; skoro jasno (< 30 % oblačnosti) = žádný mrak,
//   · stejné počasí kousek vedle = druhý mrak se nekreslí,
//   · den/noc: v noci tmavší a modřejší tón,
//   · déšť/sníh/bouřka/mlha mají drobné dokreslení (čárky, vločky, blesk).
//
// Kreslí se na VLASTNÍ canvas přes mapou (pointer-events: none): žádné
// zásahy do stylu, žádné symboly – jen pár drawImage na překreslení.
// Zásada z Okolníku: žádný blur za běhu, tónované sprity se pečou do
// keše jednou (kombinací druh × denní fáze je hrstka).
'use strict';

const Pocasi = (() => {
  // Krajská města (lng, lat) — stejná logika jako weather.dart (kraje)
  const KRAJE = [
    [14.42, 50.09], [14.66, 49.88], [14.47, 48.97], [13.38, 49.75],
    [12.87, 50.23], [14.05, 50.66], [15.06, 50.77], [15.83, 50.21],
    [16.31, 49.95], [15.59, 49.40], [16.61, 49.20], [17.25, 49.59],
    [17.67, 49.22], [18.29, 49.82],
  ];
  const OBNOVA_MS = 30 * 60 * 1000;   // počasí stačí po půlhodinách
  // ⭐ 5. 9. 2026: 25 Hz – při 10 Hz mraky viditelně poskakovaly
  const TIK_MS = 40;
  // ⭐ 5. 9. 2026: MRAKY NA SKUTEČNÝCH MÍSTECH – jemnější pevná mřížka
  // bodů po ČR (0,45° × 0,3°, ~120 bodů) jen pro oblačnost; bez polohy
  // uživatele (stejně jako KRAJE). Krajská data z aplikace zůstávají
  // zdrojem pro světlo, sníh a déšť.
  const MRAKY_MRIZKA = (() => {
    const out = [];
    for (let lat = 48.6; lat <= 51.05; lat += 0.3) {
      for (let lng = 12.15; lng <= 18.85; lng += 0.45) {
        out.push([+lng.toFixed(2), +lat.toFixed(2)]);
      }
    }
    return out;
  })();
  let dataMraky = [];                 // [{lng, lat, druh, oblacnost}]
  let dataMrakyCas = 0;
  function stahniMraky() {
    if (Date.now() - dataMrakyCas < 15 * 60 * 1000) return;
    dataMrakyCas = Date.now();
    const lat = MRAKY_MRIZKA.map((k) => k[1]).join(',');
    const lng = MRAKY_MRIZKA.map((k) => k[0]).join(',');
    fetch('https://api.open-meteo.com/v1/forecast?latitude=' + lat
          + '&longitude=' + lng + '&current=weather_code,cloud_cover')
      .then((r) => r.json())
      .then((d) => {
        const pole = Array.isArray(d) ? d : [d];
        dataMraky = pole.map((m, i) => ({
          lng: MRAKY_MRIZKA[i][0],
          lat: MRAKY_MRIZKA[i][1],
          druh: druhZKodu((m.current && m.current.weather_code) || 0),
          oblacnost: ((m.current && m.current.cloud_cover) || 0) / 100,
        }));
        console.log('[Pocasi] mřížka mraků:', dataMraky.length);
      })
      .catch((e) => console.warn('[Pocasi] mřížka mraků', e));
  }
  const VELIKOST_KM = 28.0;           // v1.248: 45 → 28 km
  const SILA = 0.80;                  // v1.248: 0,55 → 0,80

  // VÝŠKA MRAKU NAD KRAJINOU (km) — projeví se až při náklonu; shora
  // (pitch 0) je posun nulový, takže 2D pohled zůstává beze změny.
  // Mlha leží při zemi, bouřkový mrak čouhá nejvýš — z toho vzniká
  // dojem skutečné oblohy (10. 8., „ať to vypadá jako simulace počasí").
  const VYSKA_KM = {
    mlha: 0.12, dest: 1.3, snih: 1.3,
    polojasno: 1.7, zatazeno: 1.9, bourka: 2.6,
  };

  // MRAK MÁ SVOU HLADINU A KAMERA K NÍ MŮŽE SESTOUPIT (přání 10. 8.:
  // „aby byly vidět jen do určité výšky a pak zmizely… ať mají prostě
  // svou výšku, kde se drží"). Jakmile se kamera přiblíží k hladině
  // mraku, mrak se vytratí — pod mraky se přece na oblohu nekouká
  // skrz ně. Poměr výška kamery / výška mraku: pod SPODEM není nic,
  // nad VRCHEM plná síla, mezi tím plynule.
  const MIZENI_SPODEK = 1.15;
  const MIZENI_VRCH = 2.4;
  // ⭐ 5. 9. 2026: TVARY, VÝŠKY A ODSTÍNY MRAKŮ PODLE POČASÍ (přání
  // „mraky by mohly mít i různé tvary, výšky a odstíny dle deště“).
  // Jeden malovaný sprite (mrak.webp) se skládá do několika tvarů:
  //   kupa   – beránek, jak byl doteď (polojasno)
  //   hrozen – dva slepené beránky (větší oblačnost)
  //   plochy – nízká roztažená vrstva (zataženo, sníh)
  //   veze   – vysoká věž s hlavou (bouřka, silný déšť)
  //   mlha   – roztažený řídký opar
  // Tvar, velikost, zrcadlení i výška každého mraku plynou z jeho pevné
  // identity (hash jemné buňky / pořadí bodu), takže se mezi překresleními
  // nemění. Odstín: déšť a bouřka mají TĚŽKÝ TMAVÝ SPODEK (gradient při
  // tónování), beránky jen lehký stín zespodu.
  const TVARY_DRUHU = {
    polojasno: ['kupa', 'kupa', 'kupa', 'hrozen'],
    zatazeno: ['plochy', 'plochy', 'hrozen', 'kupa'],
    dest: ['plochy', 'hrozen', 'veze', 'plochy'],
    snih: ['plochy', 'plochy', 'hrozen', 'plochy'],
    bourka: ['veze', 'veze', 'hrozen', 'veze'],
    mlha: ['mlha', 'mlha', 'mlha', 'mlha'],
  };
  const SPODEK = { polojasno: 0.86, zatazeno: 0.80, dest: 0.66, snih: 0.84,
                   bourka: 0.58, mlha: 0.96 };
  function tvarMraku(druh, h) {
    const t = TVARY_DRUHU[druh] || TVARY_DRUHU.zatazeno;
    return t[Math.floor(h * t.length) % t.length];
  }
  /// výška konkrétního mraku: základ druhu × 0,78–1,25
  function vyskaMrakuKm(druh, h) {
    return (VYSKA_KM[druh] || 1.7) * (0.78 + 0.47 * h);
  }
  // Nejjemnější mřížka, ze které se odvozuje identita a poloha mraku.
  // Musí být DĚLITELEM všech použitých kroků (ty jsou mocniny dvou v km),
  // aby zástupná buňka při změně kroku zůstala tatáž — na tom stojí, že
  // se mraky při zoomu nepřeskupují. 0,25 km = nejmenší možný krok.
  const JEMNY_KM = 0.25;

  // Výška kamery nad krajinou v metrech. MapLibre drží kameru ve
  // vzdálenosti 1,5 × výška plátna (svislý fov 36,87°, tan = 1/3);
  // náklon tu vzdálenost sklopí, takže skutečná výška je × cos(pitch).
  function vyskaKameryM(hCss, lat, zoom, pitch) {
    const metryNaPx = 156543.03392
      * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    return 1.5 * hCss * metryNaPx * Math.cos(pitch * Math.PI / 180);
  }

  function silaVysky(druh, vyskaKamery, vyskaKm) {
    const hladina = (vyskaKm || VYSKA_KM[druh] || 1.7) * 1000;
    const pomer = vyskaKamery / hladina;
    if (pomer <= MIZENI_SPODEK) return 0;
    if (pomer >= MIZENI_VRCH) return 1;
    return (pomer - MIZENI_SPODEK) / (MIZENI_VRCH - MIZENI_SPODEK);
  }

  let mapa = null;
  let platno = null;
  let ctx = null;
  let mrak = null;                    // Image spritu
  let mrakNacten = false;
  let data = [];                      // [{lng, lat, druh, oblacnost}]
  let dataCas = 0;
  let tikac = null;
  let faze = 0;
  let posledniKresba = 0;
  // plátno mraků kreslíme v polovičním rozlišení (roztažené CSS)
  const MERITKO_PLATNA = 0.5;
  const tonovane = new Map();         // "druh|krokDne|tvar" → canvas
  const tvary = new Map();            // tvar → složený netónovaný canvas

  // ——— Počasí ———
  function druhZKodu(k) {
    if (k >= 95) return 'bourka';
    if ((k >= 71 && k <= 77) || k === 85 || k === 86) return 'snih';
    if ((k >= 51 && k <= 67) || (k >= 80 && k <= 82)) return 'dest';
    if (k === 45 || k === 48) return 'mlha';
    if (k === 3) return 'zatazeno';
    if (k === 2) return 'polojasno';
    return 'jasno';
  }

  /// POČASÍ Z APLIKACE (6. 8. 2026). ⚠️ VLASTNÍ `fetch` NA OPEN-METEO
  /// V APK SELHÁVÁ („[Pocasi] stažení selhalo TypeError: Failed to fetch"
  /// – ověřeno na zařízení, přitom z PC tatáž adresa vrací 200 i CORS).
  /// Okolník si počasí stahuje sám v Dartu (`weather.dart`) a od té doby
  /// ho posílá sem – engine tedy NEMÁ svůj síťový dotaz, jen dostane
  /// hotová data. Formát: [{lat, lon, kod, oblacnost, den}].
  function nastavZvenku(pole) {
    const nova = (pole || []).map((p) => ({
      lng: +p.lon, lat: +p.lat,
      druh: druhZKodu(+p.kod),
      oblacnost: Math.max(0, Math.min(1, +p.oblacnost)),
      den: p.den !== false,
      // v1.606: sníh na zemi (cm) a teplota – pro sezónu malby
      snih: isFinite(+p.snih) ? Math.max(0, +p.snih) : 0,
      teplota: isFinite(+p.teplota) ? +p.teplota : null,
    })).filter((p) => isFinite(p.lat) && isFinite(p.lng));
    if (!nova.length) return;
    data = nova;
    dataCas = Date.now();
    obloha.klic = '';        // vynutit přepočet sestavy
    console.log('[Pocasi] z aplikace:', data.length, 'bodů');
    // v1.607: pamatovat si, kdy u středu mapy naposled pršelo (louže)
    try {
      const c = mapa && mapa.getCenter && mapa.getCenter();
      const w = c ? nejblizsiPocasi(c.lng, c.lat) : null;
      if (w && (w.druh === 'dest' || w.druh === 'bourka')) {
        poslDestMs = Date.now();
      }
      if (typeof Svetlo !== 'undefined') Svetlo.aktualizuj();
      if (typeof Trpyt !== 'undefined') Trpyt.vzorkuj();
    } catch (e) { /* nic */ }
    // v1.606: napadl/roztál sníh nebo nový den → přemíchat paletu
    try { if (window.aktualizujSezonu) window.aktualizujSezonu(); }
    catch (e) { /* nic */ }
  }

  /// v1.606: sníh na zemi (cm) u středu mapy – nejbližší bod počasí.
  function snihCm() {
    try {
      if (!data.length || !window.mapa) return 0;
      const c = mapa.getCenter();
      const b = nejblizsiPocasi(c.lng, c.lat);
      return b && isFinite(b.snih) ? b.snih : 0;
    } catch (e) { return 0; }
  }

  function stahni() {
    // data z aplikace mají přednost – vlastní dotaz je jen záloha pro demo
    if (data.length && Date.now() - dataCas < OBNOVA_MS) return;
    dataCas = Date.now();
    const lat = KRAJE.map((k) => k[1]).join(',');
    const lng = KRAJE.map((k) => k[0]).join(',');
    fetch('https://api.open-meteo.com/v1/forecast?latitude=' + lat
          + '&longitude=' + lng + '&current=weather_code,cloud_cover')
      .then((r) => r.json())
      .then((d) => {
        const pole = Array.isArray(d) ? d : [d];
        data = pole.map((m, i) => ({
          lng: KRAJE[i][0],
          lat: KRAJE[i][1],
          druh: druhZKodu((m.current && m.current.weather_code) || 0),
          oblacnost: ((m.current && m.current.cloud_cover) || 0) / 100,
        }));
        console.log('[Pocasi] načteno bodů:', data.length);
      })
      .catch((e) => console.warn('[Pocasi] stažení selhalo', e));
  }

  // ——— Tónování spritu (jednou do keše; žádné filtry za běhu) ———
  // ⭐ v1.396: SKUTEČNÁ VÝŠKA SLUNCE („stmívání reguluj dle reálného
  // západu slunce — ve 22:00 může být větší tma“). NOAA aproximace
  // (deklinace + rovnice času), přesnost ~1° bohatě stačí. Fáze:
  // slunce ≥ +8° = plný den (1), ≤ −8° = plná noc (0), mezi tím
  // lineárně — soumrak tak trvá reálných ~70 minut a v létě přijde
  // později než v zimě sám od sebe.
  function vyskaSlunce(lat, lon, d) {
    const rad = Math.PI / 180;
    const zacatek = new Date(d.getFullYear(), 0, 0);
    const den = Math.floor((d - zacatek) / 864e5);
    const dekl = -23.44 * Math.cos(rad * (360 / 365) * (den + 10));
    const B = rad * (360 * (den - 81) / 365);
    const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B)
        - 1.5 * Math.sin(B);                       // minuty
    const utc = d.getUTCHours() + d.getUTCMinutes() / 60
        + d.getUTCSeconds() / 3600;
    const slunecniCas = utc + lon / 15 + eot / 60;  // hodiny
    const H = rad * 15 * (slunecniCas - 12);        // hodinový úhel
    const el = Math.asin(
        Math.sin(rad * lat) * Math.sin(rad * dekl)
        + Math.cos(rad * lat) * Math.cos(rad * dekl) * Math.cos(H));
    return el / rad;                                // stupně
  }

  // ⭐ v1.607: SLUNCE I S AZIMUTEM (od severu po směru hodin) – světlo
  // budov, směr stínování a odlesky (Svetlo, Trpyt). Tatáž NOAA
  // aproximace jako `vyskaSlunce`.
  function polohaSlunce(lat, lon, d) {
    const rad = Math.PI / 180;
    const zacatek = new Date(d.getFullYear(), 0, 0);
    const den = Math.floor((d - zacatek) / 864e5);
    const dekl = -23.44 * Math.cos(rad * (360 / 365) * (den + 10));
    const B = rad * (360 * (den - 81) / 365);
    const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B)
        - 1.5 * Math.sin(B);
    const utc = d.getUTCHours() + d.getUTCMinutes() / 60
        + d.getUTCSeconds() / 3600;
    const H = rad * 15 * (utc + lon / 15 + eot / 60 - 12);
    const el = Math.asin(
        Math.sin(rad * lat) * Math.sin(rad * dekl)
        + Math.cos(rad * lat) * Math.cos(rad * dekl) * Math.cos(H));
    const az = Math.atan2(Math.sin(H),
        Math.cos(H) * Math.sin(rad * lat)
        - Math.tan(rad * dekl) * Math.cos(rad * lat));
    return { el: el / rad, az: (az / rad + 180 + 360) % 360 };
  }

  // MĚSÍC (port SunCalc, V. Agafonkin, BSD): výška a azimut od severu,
  // osvětlená část kotouče 0–1 – modravé odlesky a noční světlo budov.
  function polohaMesice(lat, lon, d) {
    const rad = Math.PI / 180;
    const dny = d.valueOf() / 864e5 - 0.5 + 2440588 - 2451545;
    const e = rad * 23.4397;
    const ra = (l, b) => Math.atan2(
        Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
    const dec = (l, b) => Math.asin(
        Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
    const L = rad * (218.316 + 13.176396 * dny);
    const M = rad * (134.963 + 13.064993 * dny);
    const F = rad * (93.272 + 13.229350 * dny);
    const l = L + rad * 6.289 * Math.sin(M);
    const b = rad * 5.128 * Math.sin(F);
    const dist = 385001 - 20905 * Math.cos(M);
    const mRa = ra(l, b);
    const mDec = dec(l, b);
    const phi = rad * lat;
    const H = rad * (280.16 + 360.9856235 * dny) + rad * lon - mRa;
    const h = Math.asin(Math.sin(phi) * Math.sin(mDec)
        + Math.cos(phi) * Math.cos(mDec) * Math.cos(H));
    const azJ = Math.atan2(Math.sin(H),
        Math.cos(H) * Math.sin(phi) - Math.tan(mDec) * Math.cos(phi));
    const Ms = rad * (357.5291 + 0.98560028 * dny);
    const C = rad * (1.9148 * Math.sin(Ms) + 0.02 * Math.sin(2 * Ms)
        + 0.0003 * Math.sin(3 * Ms));
    const Ls = Ms + C + rad * 102.9372 + Math.PI;
    const sRa = ra(Ls, 0);
    const sDec = dec(Ls, 0);
    const sdist = 149598000;
    const fi = Math.acos(Math.sin(sDec) * Math.sin(mDec)
        + Math.cos(sDec) * Math.cos(mDec) * Math.cos(sRa - mRa));
    const inc = Math.atan2(sdist * Math.sin(fi), dist - sdist * Math.cos(fi));
    return { el: h / rad, az: (azJ / rad + 180 + 360) % 360,
             osvit: (1 + Math.cos(inc)) / 2 };
  }

  let poslDestMs = 0;   // v1.607: kdy naposled u středu mapy pršelo (louže)

  /// Souhrn pro světlo a třpyt: slunce, měsíc, počasí u středu mapy.
  /// Test: `window.__vynutSvetlo = {slunceEl: 30, oblacnost: 0}` přepíše.
  function stavSvetla() {
    let lat = 50.08;
    let lon = 14.43;
    try {
      const c = mapa && mapa.getCenter && mapa.getCenter();
      if (c && isFinite(c.lat)) { lat = c.lat; lon = c.lng; }
    } catch (e) { /* mapa ještě není */ }
    const d = new Date();
    const sl = polohaSlunce(lat, lon, d);
    const me = polohaMesice(lat, lon, d);
    let w = null;
    try { if (data.length) w = nejblizsiPocasi(lon, lat); } catch (e) { }
    const st = {
      slunceEl: sl.el, slunceAz: sl.az,
      mesicEl: me.el, mesicAz: me.az, mesicOsvit: me.osvit,
      oblacnost: w ? w.oblacnost : 0.3,
      druh: w ? w.druh : 'jasno',
      snih: w && isFinite(w.snih) ? w.snih : 0,
      mokro: Date.now() - poslDestMs < 3 * 3600e3,
    };
    if (window.__vynutSvetlo && typeof window.__vynutSvetlo === 'object') {
      Object.assign(st, window.__vynutSvetlo);
    }
    return st;
  }

  function denniFaze() {
    let lat = 50.08, lon = 14.43;                   // střed ČR jako záloha
    try {
      const c = mapa && mapa.getCenter && mapa.getCenter();
      if (c && isFinite(c.lat)) { lat = c.lat; lon = c.lng; }
    } catch (e) { /* mapa ještě není */ }
    const el = vyskaSlunce(lat, lon, new Date());
    return Math.max(0, Math.min(1, (el + 8) / 16));
  }

  const TONY = {
    jasno: null,
    polojasno: [0xED, 0xF1, 0xF6],
    zatazeno: [0x9A, 0xA4, 0xB2],
    mlha: [0xC2, 0xCA, 0xD4],
    // 5. 9.: tmu nese gradient spodku (SPODEK), vrch smí být světlejší
    dest: [0x7E, 0x88, 0x94],
    snih: [0xA4, 0xAD, 0xB9],
    bourka: [0x62, 0x68, 0x74],
  };
  const NOC = [0x5C, 0x66, 0x75];

  /// Složení tvaru z jediného malovaného spritu (jednou do keše).
  function slozTvar(tvar) {
    let c = tvary.get(tvar);
    if (c) return c;
    const W = mrak.naturalWidth;
    const H = mrak.naturalHeight;
    c = document.createElement('canvas');
    const cc = c.getContext('2d');
    if (tvar === 'plochy') {
      // ⚠️ 0,6 výšky × 1,5 šířky byl na telefonu tenký bledý proužek,
      // který na zamlžené mapě zanikal (ověřeno výpisem plátna 5. 9.)
      c.width = Math.round(W * 1.35);
      c.height = Math.round(H * 0.78);
      cc.drawImage(mrak, 0, c.height * 0.04, c.width, c.height * 0.96);
    } else if (tvar === 'mlha') {
      c.width = Math.round(W * 1.7);
      c.height = Math.round(H * 0.45);
      cc.globalAlpha = 0.85;
      cc.drawImage(mrak, 0, 0, c.width, c.height);
    } else if (tvar === 'hrozen') {
      c.width = Math.round(W * 1.45);
      c.height = Math.round(H * 1.1);
      cc.drawImage(mrak, c.width - W * 0.92, 0, W * 0.92, H * 0.92);   // zadní
      cc.drawImage(mrak, 0, c.height - H, W, H);                       // přední
    } else if (tvar === 'veze') {
      c.width = Math.round(W * 1.05);
      c.height = Math.round(H * 1.85);
      cc.drawImage(mrak, c.width * 0.12, 0, W * 0.8, H * 0.85);          // hlava
      cc.drawImage(mrak, c.width * 0.18, H * 0.55, W * 0.7, H * 0.8);    // dřík
      cc.drawImage(mrak, 0, c.height - H, c.width, H);                   // základna
    } else {
      c.width = W;
      c.height = H;
      cc.drawImage(mrak, 0, 0);
    }
    tvary.set(tvar, c);
    return c;
  }

  function tonovany(druh, den, tvar) {
    tvar = tvar || 'kupa';
    const krok = Math.round(den * 4);          // 5 kroků den/noc stačí
    const klic = druh + '|' + krok + '|' + tvar;
    const hotovy = tonovane.get(klic);
    if (hotovy) return hotovy;
    if (!mrakNacten) return null;
    const zaklad = slozTvar(tvar);
    const t = TONY[druh] || TONY.zatazeno;
    const d = krok / 4;
    const barva = [
      Math.round(NOC[0] + (t[0] - NOC[0]) * d),
      Math.round(NOC[1] + (t[1] - NOC[1]) * d),
      Math.round(NOC[2] + (t[2] - NOC[2]) * d),
    ];
    const sp = SPODEK[druh] || 0.85;
    const c = document.createElement('canvas');
    c.width = zaklad.width;
    c.height = zaklad.height;
    const cc = c.getContext('2d');
    cc.drawImage(zaklad, 0, 0);
    // násobení barvou zachová stínování spritu (jako modulate ve 2D);
    // svislý gradient udělá těžký spodek dešťových a bouřkových mraků
    cc.globalCompositeOperation = 'multiply';
    const g = cc.createLinearGradient(0, 0, 0, c.height);
    g.addColorStop(0, 'rgb(' + barva.join(',') + ')');
    g.addColorStop(0.5, 'rgb(' + barva.join(',') + ')');
    g.addColorStop(1, 'rgb(' + barva.map((x) => Math.round(x * sp)).join(',') + ')');
    cc.fillStyle = g;
    cc.fillRect(0, 0, c.width, c.height);
    cc.globalCompositeOperation = 'destination-in';
    cc.drawImage(zaklad, 0, 0);    // vrátit průhlednost spritu
    tonovane.set(klic, c);
    return c;
  }

  // ——— Obloha v nakloněném detailu ———
  //
  // 14 krajských mraků je dobrý PŘEHLED počasí nad celou republikou,
  // ale v přiblíženém 3D pohledu leží všechny krajské body daleko za
  // horizontem (změřeno 10. 8. u Rtyně: y ≈ −360 px) — nad krajinou
  // tedy nevisí NIC a jediné, co bývalo vidět, byl vzdálený mrak
  // nafouknutý měřítkem středu (ten „blesk přes čtvrt obrazovky").
  // Proto se při náklonu obloha DOPLŇUJE mraky na zeměpisné mřížce:
  // počasí každého mraku se bere z nejbližšího krajského bodu, takže
  // pořád jde o skutečná data — jen jich je nad krajinou vidět víc.
  function hash(ix, iy, sul) {
    let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263)
      + Math.imul(sul, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // ⚠️ ROZPOČET VÝKONU (změřeno 10. 8. se zapnutým terénem):
  //   unproject ≈ 0,95 ms, project ≈ 0,17 ms za volání!
  // Původní návrh počítal mřížku každý snímek (9 unproject + 120
  // project ≈ 28 ms) a herní styl při náklonu spadl na 14 fps.
  // Proto: DRAHÝ ROZPOČET JEN OBČAS, každý snímek jediná projekce.
  //   · sestava mraků (unproject rozsahu, mřížka, projekce, měřítka)
  //     se spočítá při klidu kamery a uloží v obrazovkových pixelech
  //     vůči KOTVĚ (zeměpisný bod uprostřed výhledu),
  //   · během pohybu se jen promítne kotva a celá obloha se posune
  //     o rozdíl — mraky jsou daleko, takže drobná nepřesnost
  //     perspektivy není poznat,
  //   · po dojetí (nebo když posun přeroste půl obrazovky) se
  //     sestava přepočítá.
  let obloha = {
    klic: '', kotva: null, kotvaPx: null, mraky: [], cas: 0,
  };
  const DOJEZD_MS = 900;   // v1.599: plynulý dojezd mraků po přepočtu

  function nejblizsiPocasi(lng, lat) {
    let nej = null;
    let nejD = Infinity;
    for (const b of data) {
      const d = (b.lng - lng) * (b.lng - lng) * 0.41
        + (b.lat - lat) * (b.lat - lat);
      if (d < nejD) { nejD = d; nej = b; }
    }
    return nej;
  }

  // Tvar výhledu na obrazovce (rohy vůči středu) – závisí jen na velikosti
  // plátna, zoomu, náklonu a natočení, ne na poloze. Viz `prepoctiOblohu`.
  let rohyTvar = '';
  let rohyOdchylky = [];

  // Drahý přepočet sestavy — volá se jen při klidu kamery.
  function prepoctiOblohu(w, h, kratsi, sinP, naklon, klic) {
    const stred = mapa.getCenter();
    // ROZSAH ZE SKUTEČNĚ VIDITELNÉ PLOCHY: getBounds() dá při náklonu
    // obdélník kolem lichoběžníku a ořez „± N kroků kolem středu"
    // míří špatným směrem (výhled jde tam, kam ukazuje bearing) —
    // 10. 8. tím vycházely mraky tisíce pixelů mimo obraz. Bereme
    // proto zpětnou projekci rohů OBRAZOVKY (nad horizontem unproject
    // diverguje, takže začínáme až ve 0,32 výšky).
    // ⛔⛔ `unproject` JE SE ZAPNUTÝM TERÉNEM MIMOŘÁDNĚ DRAHÉ (6. 8. 2026,
    // hon na sekání). MapLibre kvůli němu vykreslí terén DVAKRÁT přes celou
    // obrazovku (`maybeDrawDepth` + `maybeDrawCoords`) a pak čte pixel
    // z GPU (`gl.readPixels`) – synchronní zámek fronty. Změřeno na
    // zařízení: při posouvání mapy šlo 100 volání `readPixels` na jeden
    // swipe a VŠECHNA pocházela odsud (`pointCoordinate`).
    //
    // Tvar výhledu na obrazovce ale nezávisí na tom, KDE jsme – jen na
    // zoomu, náklonu a natočení. Rohy si proto spočítáme jednou a pak
    // je jen posouváme se středem.
    // ⚠️ KLÍČ MUSÍ BÝT HRUBÝ (7. 8. 2026). Dřív tu byl zoom na dvě
    // desetinná místa – jenže se zapnutým terénem si MapLibre po každém
    // posunu dorovnává zoom podle výšky pod kamerou (`recalculateZoomAndCenter`),
    // takže se zoom pořád mikroskopicky kmitá (změřeno: 15,243–15,298 na
    // tři posunutí = šest různých klíčů). Keš se tím zahazovala pořád
    // dokola a KAŽDÉ minutí stojí PĚT `unproject` po ~3,3 ms, protože
    // se zapnutým terénem to je čtení pixelu z GPU. Tvar výhledu se
    // přitom mezi 15,24 a 15,30 nezmění ani o chlup.
    const tvar = w + 'x' + h + '|' + Math.round(mapa.getZoom() * 4) + '|'
        + Math.round(naklon / 3) + '|' + Math.round(mapa.getBearing() / 6);
    if (rohyTvar !== tvar) {
      const nove = [];
      for (const [sx, sy] of [[0, 0.32], [1, 0.32], [0, 1], [1, 1],
                              [0.5, 0.66]]) {
        let b;
        try { b = mapa.unproject([sx * w, sy * h]); } catch (e) { continue; }
        if (!b || !isFinite(b.lat) || !isFinite(b.lng)) continue;
        if (Math.abs(b.lat - stred.lat) > 3
            || Math.abs(b.lng - stred.lng) > 5) continue;
        nove.push([b.lat - stred.lat, b.lng - stred.lng]);
      }
      if (nove.length) { rohyTvar = tvar; rohyOdchylky = nove; }
    }
    let jih = 90, sever = -90, zapad = 180, vychod = -180;
    for (const [dlat, dlng] of rohyOdchylky) {
      const la = stred.lat + dlat;
      const lo = stred.lng + dlng;
      if (la < jih) jih = la;
      if (la > sever) sever = la;
      if (lo < zapad) zapad = lo;
      if (lo > vychod) vychod = lo;
    }
    const kotvaPx = mapa.project([stred.lng, stred.lat]);
    // ⭐ v1.599 („občas poskakují mraky po posunu"): během gesta jede
    // obloha na posunu kotvy, po dojetí se přepočítá a mrak by skočil
    // z posunuté polohy na skutečnou. Zapamatujeme si, KDE každý mrak
    // právě byl, a nová sestava k tomu místu plynule dojede.
    const stare = {};
    if (obloha.kotva && obloha.kotvaPx) {
      let dxS = 0, dyS = 0;
      try {
        const pk = mapa.project(obloha.kotva);
        dxS = pk.x - obloha.kotvaPx.x;
        dyS = pk.y - obloha.kotvaPx.y;
      } catch (e) { /* bez posunu */ }
      const tedS = performance.now();
      for (const m of obloha.mraky) {
        if (!m.id) continue;
        const kS = m.t0 ? Math.min(1, (tedS - m.t0) / DOJEZD_MS) : 1;
        const eS = 1 - Math.pow(1 - kS, 3);
        stare[m.id] = { x: obloha.kotvaPx.x + m.x + dxS + (m.ox || 0) * (1 - eS),
                        y: obloha.kotvaPx.y + m.y + dyS + (m.oy || 0) * (1 - eS) };
      }
    }
    obloha = { klic, kotva: [stred.lng, stred.lat], kotvaPx,
               mraky: [], cas: performance.now() };
    if (sever < jih || vychod < zapad) return;

    // KROK MŘÍŽKY AŽ ZE SKUTEČNÉHO VÝHLEDU (měřítko středu při
    // náklonu 64° tvrdilo 26 km, zatímco reálně bylo vidět 8×7 km —
    // do obrazu se pak vešly 4 mraky a všechny vylétly nad horní
    // okraj). Kvantováno na mocniny dvou, aby se mraky při zoomování
    // nepřeskládávaly plynule.
    const kmNaStupen = 111.32 * Math.cos(stred.lat * Math.PI / 180);
    const sirkaKm = Math.max((vychod - zapad) * kmNaStupen,
                             (sever - jih) * 111.32) || 8;
    const krok = Math.pow(2, Math.round(Math.log2(
        Math.max(0.25, sirkaKm / 3.2))));
    const dLat = krok / 111.32;
    jih -= dLat; sever += dLat; zapad -= dLat * 1.6; vychod += dLat * 1.6;

    // MĚŘÍTKO MĚŘ VODOROVNĚ: svislý rozdíl projekce je při náklonu
    // zkrácený (48 px/km proti skutečným ~200 u blízkých bodů), takže
    // filtr „za horizontem" jinak zahazuje právě ty mraky, které mají
    // viset nad krajinou.
    const s2 = mapa.project([stred.lng + 0.05, stred.lat]);
    const pxNaKmVodorovne = Math.abs(s2.x - kotvaPx.x)
      / (0.05 * kmNaStupen);
    if (!isFinite(pxNaKmVodorovne) || pxNaKmVodorovne <= 0) return;

    const mraky = [];
    let bunek = 0;
    // počítadla zahozených mraků podle důvodu (diagnostika 6. 8. 2026:
    // „nevidím ani jeden mrak" – bez nich se nedá poznat KTERÝ filtr je bere)
    const _zah = { bezDat: 0, jasno: 0, hustota: 0, projekce: 0, lokal: 0,
                   horizont: 0, maly: 0, mimo: 0, nizko: 0 };
    for (let iy = Math.floor(jih / dLat); iy <= Math.ceil(sever / dLat);
         iy++) {
      const lat0 = iy * dLat;
      const dLng = krok / (111.32 * Math.cos(lat0 * Math.PI / 180));
      for (let ix = Math.floor(zapad / dLng);
           ix <= Math.ceil(vychod / dLng); ix++) {
        if (++bunek > 400) break;          // pojistka proti explozi
        // ⚠️ IDENTITA I POLOHA MRAKU JDE Z JEMNÉ MŘÍŽKY, NE Z AKTUÁLNÍHO
        // KROKU (oprava 6. 8. 2026, „mraky se stále přeskupují
        // přibližováním a oddalováním"). `krok` se s zoomem mění, takže
        // dokud z něj vycházel hash i souřadnice, každý přepočet mřížky
        // všechny mraky PŘESADIL. Zástupcem buňky je nově pevná jemná
        // buňka (JEMNY_KM) v jejím levém dolním rohu — a ta se při
        // půlení/zdvojení kroku NEMĚNÍ (ix·nas zůstává). Mraky, které
        // v záběru zůstávají, tedy drží své místo; při oddálení jich
        // ubude, při přiblížení přibudou nové mezi ně.
        const nas = Math.max(1, Math.round(krok / JEMNY_KM));
        const fx = ix * nas;
        const fy = iy * nas;
        const dLatJ = JEMNY_KM / 111.32;
        const dLngJ = JEMNY_KM / (111.32 * Math.cos(lat0 * Math.PI / 180));
        const lng = (fx + 0.5 + (hash(fx, fy, 1) - 0.5) * 3.0) * dLngJ;
        const lat = (fy + 0.5 + (hash(fx, fy, 2) - 0.5) * 3.0) * dLatJ;
        const pocasi = nejblizsiPocasi(lng, lat);
        // ⚠️ ROZDĚLENO: „nenašlo se počasí" a „je jasno" jsou ÚPLNĚ jiné
        // diagnózy – dokud se počítaly dohromady, nešlo poznat, jestli je
        // opravdu jasno, nebo se rozbil výběr nejbližšího bodu.
        if (!pocasi) { _zah.bezDat++; continue; }
        if (pocasi.druh === 'jasno') { _zah.jasno++; continue; }
        // Řídkost dle oblačnosti. ⚠️ MAPA MUSÍ ZŮSTAT ČITELNÁ: při
        // 100% oblačnosti se sytá mřížka slila v peřinu přes 37 %
        // obrazu a krajina zmizela — obloha dokresluje náladu,
        // nesmí přebít obsah. Hash TAKY z jemné buňky, jinak by se
        // výběr „který mrak je" měnil s každým krokem.
        const husto = pocasi.druh === 'polojasno'
          ? 0.12 + 0.26 * pocasi.oblacnost : 0.30;
        if (hash(fx, fy, 3) > husto) { _zah.hustota++; continue; }
        const p = mapa.project([lng, lat]);
        if (!isFinite(p.x) || !isFinite(p.y)) { _zah.projekce++; continue; }
        // měřítko v místě mraku (perspektiva: vzdálené menší)
        const q = mapa.project([lng + dLng, lat]);
        const lokal = Math.hypot(q.x - p.x, q.y - p.y) / krok;
        if (!isFinite(lokal) || lokal <= 0.0001) { _zah.lokal++; continue; }
        // u horizontu projekce diverguje (2622 px/km proti 48 ve
        // středu) — takový bod je prakticky v nekonečnu
        if (lokal > pxNaKmVodorovne * 4.5) { _zah.horizont++; continue; }
        // 5. 9.: každý mrak má svou velikost (±), tvar a výšku
        const g = Math.min(kratsi * 0.21, krok * 0.52 * lokal)
          * (0.95 + 0.4 * hash(fx, fy, 11));
        if (g < 16) { _zah.maly++; continue; }
        const vKm = vyskaMrakuKm(pocasi.druh, hash(fx, fy, 9));
        const y = p.y - vKm * lokal * sinP;
        if (p.x < -g * 1.6 || p.x > w + g * 1.6 || y < -g * 1.5) {
          _zah.mimo++;
          continue;
        }
        // OBLOHA JE NAD KRAJINOU, NE PŘES NI: mraky se drží v horní
        // části obrazu a k dolní hranici se vytrácejí — jinak by ty
        // nejbližší (a tím největší) zakryly mapu, kvůli které tu
        // uživatel je
        const mez = h * 0.62;
        if (y > mez) { _zah.nizko++; continue; }
        const dohas = Math.min(1, (mez - y) / (h * 0.30));
        let alfa = SILA * (1 + 0.20 * naklon) * (0.25 + 0.75 * dohas);
        if (pocasi.druh === 'polojasno') {
          alfa *= 0.45 + 0.55 * pocasi.oblacnost;
        }
        // drift v pixelech (mraky plují) — vlastní fáze podle buňky;
        // `yz` = kam mrak dopadá na zem (pro závoj mokra/mlhy)
        // identita z JEMNÉ buňky — stejná při každém kroku i zoomu;
        // fáze driftu taky z ní, ať se při přepočtu nezmění
        mraky.push({ id: fx + '|' + fy,
                     x: p.x - kotvaPx.x, y: y - kotvaPx.y,
                     yz: p.y - kotvaPx.y, g,
                     druh: pocasi.druh, alfa,
                     tvar: tvarMraku(pocasi.druh, hash(fx, fy, 8)),
                     vyskaKm: vKm,
                     zrc: hash(fx, fy, 10) > 0.5,
                     f1: hash(fx, fy, 5) * 6.3,
                     f2: hash(fx, fy, 6) * 6.3 });
      }
    }
    // odzadu dopředu (vzdálené jsou výš) — a když je jich moc,
    // přednost mají BLIŽŠÍ (dřív se ořezávalo obráceně a zbyly jen
    // mraky slepené u horizontu)
    mraky.sort((a, b) => a.y - b.y);
    obloha.mraky = mraky.slice(-11);
    // dojezd ze staré polohy (a plynulé rozsvícení nových mraků)
    const tedN = performance.now();
    for (const m of obloha.mraky) {
      const st = stare[m.id];
      if (st) {
        m.ox = st.x - (kotvaPx.x + m.x);
        m.oy = st.y - (kotvaPx.y + m.y);
        // drobné rozdíly nedojíždět (šum projekce), velké skoky ano
        if (Math.abs(m.ox) < 1.5 && Math.abs(m.oy) < 1.5) { m.ox = 0; m.oy = 0; }
        m.t0 = tedN;
        m.novy = false;
      } else {
        m.ox = 0; m.oy = 0; m.t0 = tedN; m.novy = true;
      }
    }
    // DIAGNOSTIKA (6. 8. 2026, „nevidím ani jeden mrak"): bez ní se
    // nedá odlišit „je jasno, takže se nic nekreslí" od „je zataženo,
    // ale sestava se nespočítala". Loguje se jen při ZMĚNĚ počtu.
    if (obloha.mraky.length !== _diagPocet) {
      _diagPocet = obloha.mraky.length;
      const druhy = {};
      for (const d of data) druhy[d.druh] = (druhy[d.druh] || 0) + 1;
      console.log('[Pocasi] mraků v obraze:', obloha.mraky.length,
          '| krajů podle druhu:', JSON.stringify(druhy),
          '| buněk mřížky:', bunek,
          '| zahozeno:', JSON.stringify(_zah),
          '| krok km:', krok, '| pxNaKm:', Math.round(pxNaKmVodorovne),
          '| sinP:', sinP.toFixed(2),
          '| nad středem:', (() => {
            const s = mapa.getCenter();
            const p = nejblizsiPocasi(s.lng, s.lat);
            return p ? p.druh + ' ' + Math.round(p.oblacnost * 100) + '%'
                     : 'BEZ DAT';
          })());
    }
  }
  let _diagPocet = -1;

  function kresliOblohu(w, h, kratsi, sinP, naklon, den, vyskaKamery) {
    // Kamera pod hladinou i těch nejvyšších mraků → obloha se vůbec
    // nepočítá (ušetří to i drahý přepočet sestavy)
    if (vyskaKamery <= MIZENI_SPODEK * 1000
        * Math.min(...Object.values(VYSKA_KM))) {
      obloha.mraky = [];
    }
    const klic = [Math.round(mapa.getZoom() * 4),
      Math.round(mapa.getBearing() / 6), Math.round(mapa.getPitch() / 6),
      Math.round(w / 40), Math.round(h / 40), data.length].join('|');
    let dx = 0;
    let dy = 0;
    let sedi = obloha.klic === klic && obloha.kotva;
    if (sedi) {
      const pk = mapa.project(obloha.kotva);       // JEDINÁ projekce
      dx = pk.x - obloha.kotvaPx.x;
      dy = pk.y - obloha.kotvaPx.y;
      // ujel-li obraz daleko, sestava už neodpovídá krajině
      if (Math.abs(dx) > w * 0.55 || Math.abs(dy) > h * 0.55) sedi = false;
    }
    if (!sedi) {
      // přepočet je drahý (~15 ms) — během gesta ho odložíme, aby
      // nekazil plynulost; obloha zatím jede na posunu kotvy
      // ⛔ 6. 8. 2026: bylo tu `!mapa.isMoving() || !obloha.mraky.length`,
      // takže ZA JASNA (prázdná sestava mraků) běžel patnáctimilisekundový
      // přepočet i UPROSTŘED posunu, každých 260 ms. Počítáme jen v klidu.
      const klid = !mapa.isMoving();
      if (klid && performance.now() - obloha.cas > 260) {
        prepoctiOblohu(w, h, kratsi, sinP, naklon, klic);
        dx = 0;
        dy = 0;
      }
    }
    // ZEM POD MRAKEM (přání 10. 8.: „ať se mapa pod dešťovými mraky
    // leskne jako mokrá, v mlze lehce zamlžená"): závoj se kreslí na
    // SKUTEČNOU pozici mraku na zemi (m.yz), zatímco mrak sám visí
    // výš — proto dvě smyčky, ať mraky zůstanou nad závoji.
    const videt = [];
    for (const m of obloha.mraky) {
      const sila = silaVysky(m.druh, vyskaKamery, m.vyskaKm);
      if (sila <= 0.01) continue;
      // drift počítáme zvlášť, ať ho stín a mokro na zemi kopírují —
      // jinak by mrak plul a jeho stín stál
      const driftX = Math.cos(faze * 0.13 + m.f1) * m.g * 0.09;
      const driftY = Math.sin(faze * 0.17 + m.f2) * m.g * 0.05;
      // v1.599: dojezd z polohy před přepočtem + nástup nových mraků
      const kD = m.t0 ? Math.min(1, (performance.now() - m.t0) / DOJEZD_MS) : 1;
      const eD = 1 - Math.pow(1 - kD, 3);
      const ox = (m.ox || 0) * (1 - eD);
      const oy = (m.oy || 0) * (1 - eD);
      const nastup = m.novy ? eD : 1;
      videt.push({ m, sila: sila * nastup,
                   x: obloha.kotvaPx.x + m.x + dx + driftX + ox,
                   y: obloha.kotvaPx.y + m.y + dy + driftY + oy,
                   yz: obloha.kotvaPx.y + m.yz + dy + driftY + oy });
    }
    for (const v of videt) {
      kresliStin(v.x, v.yz, v.m.g, v.sila * naklon * v.m.alfa);
      kresliZavoj(v.m.druh, v.x, v.yz, v.m.g, v.sila * naklon);
    }
    for (const v of videt) {
      kresliMrak(v.m.druh, v.x, v.y, v.m.g,
                 Math.min(1, v.m.alfa * v.sila), den, naklon, v.m.tvar, v.m.zrc);
    }
    return videt.length;
  }

  // Barva a síla „počasí na zemi" — mokrý povrch pod deštěm, bělavý
  // opar v mlze, stín pod hustou oblačností.
  // ⚠️ JEN NÁZNAK: závoje sousedních mraků se sčítají, takže při
  // souvislém dešti pokryjí celý obraz — první pokus (0,30–0,42) udělal
  // z krajiny šedou plochu (10. 8.). Suchá oblačnost (zataženo,
  // polojasno) závoj nemá vůbec; mokro patří jen tam, kde něco padá.
  const ZAVOJ = {
    dest: ['rgba(74,104,140,', 0.13],
    bourka: ['rgba(46,54,74,', 0.15],
    mlha: ['rgba(226,233,240,', 0.20],
    snih: ['rgba(238,244,250,', 0.13],
  };

  // STÍN MRAKU NA KRAJINĚ (přání 10. 8.: „kde jsou mraky, dodělej
  // jejich stíny na mapě — stačí lokální lehké pohybující se
  // ztmavení"). Padá na místo dopadu mraku (`yz`) a plave s ním,
  // protože drift se počítá společně s mrakem. Má ho KAŽDÝ mrak, i
  // suchý — proto musí být hodně jemný, jinak se sousední stíny
  // sečtou do šedi (viz poučení u ZAVOJ).
  const STIN_SILA = 0.13;

  function kresliStin(x, y, g, sila) {
    if (sila <= 0.02) return;
    const r = g * 0.82;
    const pruh = ctx.createRadialGradient(x, y, r * 0.1, x, y, r);
    const a = (STIN_SILA * sila).toFixed(3);
    pruh.addColorStop(0, 'rgba(38,44,56,' + a + ')');
    pruh.addColorStop(0.6, 'rgba(38,44,56,'
      + (STIN_SILA * sila * 0.6).toFixed(3) + ')');
    pruh.addColorStop(1, 'rgba(38,44,56,0)');
    ctx.fillStyle = pruh;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function kresliZavoj(druh, x, y, g, sila) {
    const def = ZAVOJ[druh];
    if (!def || sila <= 0.02) return;
    const r = g * 0.95;
    const pruh = ctx.createRadialGradient(x, y, r * 0.15, x, y, r);
    pruh.addColorStop(0, def[0] + (def[1] * sila).toFixed(3) + ')');
    pruh.addColorStop(0.65, def[0]
      + (def[1] * sila * 0.55).toFixed(3) + ')');
    pruh.addColorStop(1, def[0] + '0)');
    ctx.fillStyle = pruh;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    // MOKRÝ LESK: úzký světlý pás přes střed skvrny — odlesk oblohy
    // na mokré krajině; jen u deště a bouřky, ať to nevypadá jako
    // světelná koule
    if (druh === 'dest' || druh === 'bourka') {
      ctx.globalAlpha = Math.min(1, 0.10 * sila);
      ctx.fillStyle = 'rgba(214,232,247,1)';
      ctx.beginPath();
      ctx.ellipse(x, y, r * 0.62, r * 0.16, -0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // ——— Slunce a Měsíc nad krajinou ———
  //
  // Přenos z 2D (atmosphere.dart + sky.dart): kotouč je SOUČÁST SVĚTA,
  // visí nad severním okrajem republiky a putuje od východu na západ
  // podle denní doby. Obě „nalepené" varianty (kotva na displeji
  // i paralaxa) uživatel ve 2D odmítl, proto se sem nepřenášejí. Na
  // oblohu se kouká jen v oddáleném plakátovém pohledu, takže se kotouč
  // s přiblížením vytratí.
  const OBLOHA_LAT = 51.60273;        // _maxLat + 0,35 z atmosphere.dart
  const OBLOHA_LNG_V = 19.49381;      // _maxLon + 0,3 (východ, ráno)
  const OBLOHA_LNG_Z = 11.45476;      // _minLon − 0,3 (západ, večer)
  // Kresby bere engine V APLIKACI z assetů Okolníku (?obloha=) — týž
  // trik jako u kreseb míst (?ilus=), ať stejné obrázky nejsou v APK
  // dvakrát. Samostatné demo si vezme vlastní z assets/.
  const OBLOHA_ZAKLAD =
    new URLSearchParams(location.search).get('obloha') || 'assets/';
  let slunce = null;                  // Image kotouče slunce
  let mesic = null;                   // Image kotouče měsíce
  let casyDne = null;                 // ['5:12', '20:44'] — jednou za den
  let casyDen = -1;

  // Stav oblohy podle DENNÍ DOBY (ne podle azimutu) — přenos `TimeSky.at`
  // ze sky.dart, ať 2D i 3D mají kotouč na témž místě.
  function stavOblohy() {
    const d = new Date();
    const h = d.getHours() + d.getMinutes() / 60;
    const den = h >= 6 && h < 20;
    const p = den ? (h - 6) / 14 : ((h - 20 + 24) % 24) / 10;
    const oblouk = Math.sin(p * Math.PI);
    const jas = den
      ? Math.min(1, Math.max(0.3, 0.4 + 0.6 * oblouk))
      : Math.min(0.85, Math.max(0.35, 0.5 + 0.35 * oblouk));
    return { p, den, jas };
  }

  // Východ a západ slunce pro PEVNÝ bod uprostřed ČR (sunrise equation,
  // přenos `SunTimes` ze sky.dart). ⚠️ Nikdy ne podle polohy uživatele —
  // rozdíl Aš/Ostrava je ~25 minut a za ozdobný údaj v kotouči to
  // nestojí (a nechceme kvůli ozdobě sahat na polohu).
  function vychodZapad() {
    const d = new Date();
    const den = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100
      + d.getDate();
    if (casyDne && casyDen === den) return casyDne;
    const rad = Math.PI / 180;
    const lat = 49.80;
    const lng = 15.47;
    const jd = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
      / 86400000 + 2440587.5;
    const n = Math.ceil(jd - 2451545.0 + 0.0008);
    const jStar = n - lng / 360;
    const m = (357.5291 + 0.98560028 * jStar) % 360;
    const c = 1.9148 * Math.sin(m * rad) + 0.02 * Math.sin(2 * m * rad)
      + 0.0003 * Math.sin(3 * m * rad);
    const lambda = (m + c + 180 + 102.9372) % 360;
    const tranzit = 2451545.0 + jStar + 0.0053 * Math.sin(m * rad)
      - 0.0069 * Math.sin(2 * lambda * rad);
    const sinDek = Math.sin(lambda * rad) * Math.sin(23.44 * rad);
    const cosHa = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * sinDek)
      / (Math.cos(lat * rad) * Math.cos(Math.asin(sinDek)));
    const ha = Math.acos(Math.max(-1, Math.min(1, cosHa))) / rad;
    const hhmm = (j) => {
      const t = new Date((j - 2440587.5) * 86400000);
      return t.getHours() + ':' + String(t.getMinutes()).padStart(2, '0');
    };
    casyDne = [hhmm(tranzit - ha / 360), hhmm(tranzit + ha / 360)];
    casyDen = den;
    return casyDne;
  }

  /// Kotouč na obloze. ⚠️ Kreslí se PŘED mraky (mrak smí slunce zakrýt)
  /// a MIMO hlavní smyčku počasí — za jasna se nekreslí ani jeden mrak
  /// a než dorazí počasí z aplikace, je `data` prázdné.
  function kresliSlunce(w, h) {
    const z = mapa.getZoom();
    // 2D `skyFade`: plná síla do z9, v 10,5 nic (přiblíženo koukáš na zem)
    const zeslabeni = z <= 9 ? 1 : (z >= 10.5 ? 0 : (10.5 - z) / 1.5);
    if (zeslabeni <= 0.01) return;
    const st = stavOblohy();
    const obr = st.den ? slunce : mesic;
    if (!obr || !obr.complete || !obr.naturalWidth) return;
    // celkově zataženo → kotouč se přitlumí (sunDim ve 2D)
    let oblacno = 0.4;
    if (data.length) {
      oblacno = 0;
      for (const b of data) oblacno += b.oblacnost;
      oblacno /= data.length;
    }
    const tlum = Math.max(0.2, Math.min(1, 1 - 0.7 * oblacno));
    // 2D násobí ještě rozpadem mraků (_opacity) — kvadratický doběh
    const r0 = Math.max(0, (11.2 - z) / 2.2);
    const rozpad = z <= 9 ? 1 : Math.min(1, r0 * r0);
    const alfa = Math.min(1, 0.95 * st.jas * tlum * zeslabeni * rozpad);
    if (alfa <= 0.01) return;
    const lng = OBLOHA_LNG_V - st.p * (OBLOHA_LNG_V - OBLOHA_LNG_Z);
    const p = mapa.project([lng, OBLOHA_LAT]);
    if (!isFinite(p.x) || !isFinite(p.y)) return;
    // ⚠️ `faze` roste 1,0 za sekundu, kdežto 2D `_phase` jen 0,225 —
    // bez přepočtu by kotouč vířil čtyřikrát rychleji než na staré mapě.
    const t = faze * 0.225;
    const kratsi = Math.min(w, h);
    const sirka = kratsi * (st.den ? 0.72 : 0.60)
      * (1 + 0.025 * Math.sin(t));
    if (p.x < -sirka || p.x > w + sirka
        || p.y < -sirka || p.y > h + sirka) return;
    const vyska = sirka * obr.naturalHeight / obr.naturalWidth;
    ctx.save();
    ctx.globalAlpha = alfa;
    // paprsky se pomalu točí, časy v kotouči ne — proto vlastní save
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(t * (st.den ? 0.035 : 0.012));
    ctx.drawImage(obr, -sirka / 2, -vyska / 2, sirka, vyska);
    ctx.restore();
    // ČASY PŘÍMO V KOTOUČI (jako 2D od v1.139): kotouč zabírá ~21,5 %
    // šířky kresby, zbytek je koróna.
    const r = sirka * 0.215;
    const casy = vychodZapad();
    ctx.fillStyle = st.den ? '#5A3B00' : '#203046';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '900 ' + (r * 0.40).toFixed(1)
      + 'px Montserrat, system-ui, sans-serif';
    ctx.fillText('↑ ' + casy[0], p.x, p.y - r * 0.30);
    ctx.fillText('↓ ' + casy[1], p.x, p.y + r * 0.34);
    ctx.restore();
  }

  // ——— Kreslení ———
  function kresli() {
    if (!ctx || !mapa) return;
    // Souřadnice počítáme v CSS pixelech; plátno samo je POLOVIČNÍ
    // (viz velikostPlatna) — měkkým mrakům to neublíží a překreslení
    // i nahrání textury do GPU stojí čtvrtinu (10. 8., obloha jinak
    // brala 40 % snímkové rychlosti).
    const w = platno.width / MERITKO_PLATNA;
    const h = platno.height / MERITKO_PLATNA;
    ctx.setTransform(MERITKO_PLATNA, 0, 0, MERITKO_PLATNA, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // ⚠️ PŘED návratem kvůli chybějícím datům: Slunce a Měsíc patří na
    // oblohu i za jasna, kdy se nekreslí ani jeden mrak (a než dorazí
    // počasí z aplikace, je `data` prázdné).
    kresliSlunce(w, h);
    if (!data.length || !mrakNacten) return;
    const kratsi = Math.min(w, h);
    // NÁKLON: 0 = pohled shora (chování 2D beze změny), 1 = plný náklon.
    // Při náklonu se mraky zvednou nad krajinu a dostanou perspektivu
    // (bližší větší, vzdálené menší) — jinak leží jako koberec na zemi
    // a při přiblížení zabírají celý obraz.
    const pitch = mapa.getPitch();
    const naklon = Math.max(0, Math.min(1, pitch / 60));
    const sinP = Math.sin(pitch * Math.PI / 180);
    // px na km ve STŘEDU pohledu (záloha, když lokální měřítko selže)
    const stred = mapa.getCenter();
    // ⭐ 5. 9. 2026: PROJEKCE S PEVNOU VÝŠKOU (terén pod středem) –
    // `mapa.project` bere výšku terénu pod bodem a při donačítání DEM
    // dlaždic mraky poskakovaly; pevná výška je stabilní.
    let elevStred = 0;
    try {
      const v = mapa.queryTerrainElevation
          && mapa.queryTerrainElevation([stred.lng, stred.lat]);
      if (typeof v === 'number') elevStred = v;
    } catch (e) { /* bez terénu */ }
    const proj = (lng, lat) => {
      try {
        if (mapa.terrain && mapa._camera && mapa._camera.transform) {
          return mapa._camera.transform.locationToScreenPoint(
              new maplibregl.LngLat(lng, lat),
              { getElevationForLngLat: () => elevStred });
        }
      } catch (e) { /* níž obyčejná projekce */ }
      return mapa.project([lng, lat]);
    };
    const sv = (typeof stavSvetla === 'function') ? stavSvetla() : null;
    const a = proj(stred.lng, stred.lat);
    const b = proj(stred.lng, stred.lat + 0.1);
    const pxNaKmStred = Math.abs(a.y - b.y) / 11.12;
    // strop velikosti: shora jako dřív (0,85 kratší strany), při plném
    // náklonu polovina — jinak jediný mrak přerazí celý výhled
    const strop = kratsi * (0.85 - 0.42 * naklon);
    const den = denniFaze();
    // NAKLONĚNÝ DETAIL = vlastní obloha (krajské body jsou tam za
    // horizontem, viz kresliOblohu). Oddálený a kolmý pohled si drží
    // odladěné chování „mrak nad svým krajem".
    if (naklon > 0.25 && mapa.getZoom() > 10.5) {
      const vyskaKamery = vyskaKameryM(h, stred.lat, mapa.getZoom(),
                                       pitch);
      kresliOblohu(w, h, kratsi, sinP, naklon, den, vyskaKamery);
      return;
    }
    const nakreslene = [];
    let idx = 0;
    stahniMraky();
    const zdrojMraku = dataMraky.length ? dataMraky : data;
    for (const bod of zdrojMraku) {
      idx++;
      if (bod.druh === 'jasno') continue;
      let alfa = SILA;
      if (bod.druh === 'polojasno') {
        if (bod.oblacnost < 0.30) continue;
        alfa *= 0.30 + 0.70 * bod.oblacnost;
      }
      // pohupování nad vlastním územím (v zeměpisných stupních);
      // 6. 8. zpomaleno ~3× („mraky ať se pohybují pomaleji") —
      // periody ~37 s a ~48 s místo ~12/16 s
      const wLat = Math.sin(faze * 0.17 + idx * 1.7) * 0.060;
      const wLng = Math.cos(faze * 0.13 + idx * 0.9) * 0.105;
      const lng = bod.lng + wLng;
      const lat = bod.lat + wLat;
      const p = proj(lng, lat);
      if (!isFinite(p.x) || !isFinite(p.y)) continue;
      // LOKÁLNÍ měřítko v místě mraku — teprve tím vznikne perspektiva
      // (měřítko ze středu dělalo vzdálené mraky stejně velké jako
      // blízké a blesk přes půl obrazovky, 10. 8.)
      let pxNaKm = pxNaKmStred;
      if (naklon > 0.01) {
        const kmNaStupen = 111.32 * Math.cos(lat * Math.PI / 180);
        const q = proj(lng + 0.02, lat);
        const d = Math.hypot(q.x - p.x, q.y - p.y) / (0.02 * kmNaStupen);
        if (isFinite(d) && d > 0.0001) pxNaKm = d;
      }
      const g = Math.max(kratsi * 0.07, Math.min(strop,
          VELIKOST_KM * pxNaKm)) * (0.9 + 0.3 * hash(idx, 4, 4));
      // 5. 9.: tvar, výška a zrcadlení z pořadí bodu (pevné)
      const tvar = tvarMraku(bod.druh, hash(idx, 1, 4));
      const vKm = vyskaMrakuKm(bod.druh, hash(idx, 2, 4));
      const zrc = hash(idx, 3, 4) > 0.5;
      // zvednutí nad krajinu: svislá osa se do obrazu promítá se
      // sinem náklonu (shora = nula, u horizontu plná výška)
      const vyska = vKm * pxNaKm * sinP;
      const y = p.y - vyska;
      if (p.x < -g || p.x > w + g || y < -g * 1.4 || y > h + g) continue;
      // stejné počasí kousek vedle nic nepřidá
      let preskoc = false;
      for (const n of nakreslene) {
        if (n.druh === bod.druh
            && Math.hypot(n.x - p.x, n.y - y) < g * 1.35) {
          preskoc = true;
          break;
        }
      }
      if (preskoc) continue;
      nakreslene.push({ x: p.x, y, druh: bod.druh });
      // ⭐ 5. 9. 2026: STÍN MRAKU na zemi – od slunce, délka podle výšky
      // mraku a výšky slunce (nejvýš 6 km), slabší při nízkém slunci
      if (sv && typeof sv.slunceEl === 'number' && sv.slunceEl > 2
          && bod.druh !== 'mlha') {
        const elR = Math.max(6, sv.slunceEl) * Math.PI / 180;
        const delkaKm = Math.min(6, vKm / Math.tan(elR));
        const smer = ((sv.slunceAz || 0) + 180) * Math.PI / 180;
        const sx = p.x + Math.sin(smer) * delkaKm * pxNaKm;
        const sy = p.y - Math.cos(smer) * delkaKm * pxNaKm;
        const silaStinu = alfa * 0.22 * Math.min(1, sv.slunceEl / 30);
        kresliStinMraku(sx, sy, g * (tvar === 'plochy' ? 1.25 : 1), silaStinu, naklon);
      }
      // ať jsou při náklonu ZŘETELNĚJŠÍ (přání 10. 8.) — obloha má
      // být čitelná i proti pestré krajině
      kresliMrak(bod.druh, p.x, y, g,
                 Math.min(1, alfa * (1 + 0.20 * naklon)), den, naklon, tvar, zrc);
    }
  }

  /// Stín mraku: měkká tmavá elipsa na zemi (zploštělá podle náklonu).
  function kresliStinMraku(x, y, g, alfa, naklon) {
    if (alfa <= 0.01) return;
    const rx = g * 0.9;
    const ry = rx * (1 - 0.55 * naklon);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, ry / rx);
    const gr = ctx.createRadialGradient(0, 0, rx * 0.1, 0, 0, rx);
    gr.addColorStop(0, 'rgba(30,26,20,' + alfa.toFixed(3) + ')');
    gr.addColorStop(0.6, 'rgba(30,26,20,' + (alfa * 0.5).toFixed(3) + ')');
    gr.addColorStop(1, 'rgba(30,26,20,0)');
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function kresliMrak(druh, x, y, g, alfa, den, naklon, tvar, zrc) {
    tvar = tvar || 'kupa';
    const sprite = tonovany(druh, den, tvar);
    if (!sprite) return;
    const sirka = g * (druh === 'polojasno' ? 1.0 : 1.2)
      * (tvar === 'plochy' || tvar === 'mlha' ? 1.3 : 1);
    const vyska = sirka * sprite.height / sprite.width;
    ctx.globalAlpha = Math.min(1,
        alfa * (druh === 'mlha' ? 0.6 : (druh === 'bourka' ? 0.95 : 0.92)));
    // SPOLEČNÁ ZÁKLADNA: všechny tvary sedí spodkem tam, kde seděl
    // beránek (y + 0,31 šířky); věže a hrozny rostou nahoru
    const spodek = y + sirka * 0.31;
    if (zrc) {
      ctx.save();
      ctx.translate(x, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(sprite, -sirka / 2, spodek - vyska, sirka, vyska);
      ctx.restore();
    } else {
      ctx.drawImage(sprite, x - sirka / 2, spodek - vyska, sirka, vyska);
    }
    // SRÁŽKOVÁ CLONA POD MRAKEM (jen při náklonu): mrak visí nad
    // krajinou, takže déšť/sníh smí padat celou tu výšku k zemi —
    // z pár čárek pod obláčkem je rázem vidět, KDE zrovna prší
    // (10. 8., „ať to vypadá jako simulace počasí"). Délka clony se
    // odvíjí od zvednutí mraku, které spočítal kresli().
    const clona = naklon > 0.15 && (druh === 'dest' || druh === 'snih');
    ctx.globalAlpha = Math.min(1, alfa * 0.85);
    ctx.strokeStyle = druh === 'dest' ? 'rgba(157,180,204,0.9)'
        : 'rgba(194,202,212,0.9)';
    ctx.lineWidth = Math.max(1.5, g * (clona ? 0.028 : 0.05));
    ctx.lineCap = 'round';
    if (druh === 'dest') {
      // clona smí jen naznačit, kde prší — devět dlouhých pruhů přes
      // celou obrazovku dělalo z krajiny mříž (10. 8., Liberec)
      const pruhu = clona ? 5 : 3;
      const delka = g * (clona ? 0.42 + 0.28 * naklon : 0.36);
      for (let i = 0; i < pruhu; i++) {
        const t = pruhu === 1 ? 0 : (i / (pruhu - 1)) * 2 - 1;   // −1..1
        const rx = x + t * g * (clona ? 0.46 : 0.26);
        const ry = y + g * 0.34 + (clona ? Math.abs(t) * g * 0.10 : g * 0.08);
        ctx.globalAlpha = Math.min(1, alfa * (clona ? 0.30 : 0.85));
        ctx.beginPath();
        ctx.moveTo(rx, ry);
        ctx.lineTo(rx - delka * 0.16, ry + delka);
        ctx.stroke();
      }
    } else if (druh === 'mlha') {
      for (let i = 0; i < 3; i++) {
        const ry = y + g * (0.30 + i * 0.16);
        ctx.beginPath();
        ctx.moveTo(x - g * 0.42, ry);
        ctx.lineTo(x + g * 0.42, ry);
        ctx.stroke();
      }
    } else if (druh === 'snih') {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      const kusu = clona ? 9 : 3;
      for (let i = 0; i < kusu; i++) {
        const t = kusu === 1 ? 0 : (i / (kusu - 1)) * 2 - 1;
        const sx = x + t * g * (clona ? 0.44 : 0.26);
        const sy = y + g * (clona
            ? 0.40 + ((i * 0.37) % 1) * (0.35 + 0.35 * naklon) : 0.58);
        ctx.globalAlpha = Math.min(1, alfa * (clona ? 0.45 : 0.9));
        ctx.beginPath();
        ctx.arc(sx, sy, g * (clona ? 0.035 : 0.06), 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (druh === 'bourka') {
      // blesk šlehá z mraku k zemi — při náklonu je mrak výš, takže
      // klička smí být delší, ale UŽŠÍ (dřív z něj bylo žluté „béčko"
      // přes čtvrtinu obrazovky, protože velikost brala měřítko středu)
      const s = g * (naklon > 0.15 ? 0.62 : 1.0);
      ctx.globalAlpha = Math.min(1, alfa * 0.95);
      ctx.fillStyle = 'rgba(255,210,63,0.95)';
      ctx.beginPath();
      ctx.moveTo(x + s * 0.06, y + g * 0.30);
      ctx.lineTo(x - s * 0.14, y + g * 0.30 + s * 0.36);
      ctx.lineTo(x + s * 0.02, y + g * 0.30 + s * 0.36);
      ctx.lineTo(x - s * 0.08, y + g * 0.30 + s * 0.70);
      ctx.lineTo(x + s * 0.22, y + g * 0.30 + s * 0.22);
      ctx.lineTo(x + s * 0.04, y + g * 0.30 + s * 0.22);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function velikostPlatna() {
    if (!platno || !mapa) return;
    const el = mapa.getContainer();
    const w = Math.max(1, Math.round(el.clientWidth * MERITKO_PLATNA));
    const h = Math.max(1, Math.round(el.clientHeight * MERITKO_PLATNA));
    if (platno.width !== w) platno.width = w;
    if (platno.height !== h) platno.height = h;
  }

  // ——— Životní cyklus ———
  function pripoj(map) {
    mapa = map;
    if (!platno) {
      platno = document.createElement('canvas');
      platno.id = 'pocasi-mraky';
      platno.style.cssText = 'position:absolute;inset:0;'
          + 'width:100%;height:100%;pointer-events:none;z-index:3;';
      map.getContainer().appendChild(platno);
      ctx = platno.getContext('2d');
      mrak = new Image();
      mrak.onload = () => { mrakNacten = true; };
      mrak.onerror = () => console.warn('[Pocasi] sprite mraku chybí');
      mrak.src = 'assets/mrak.webp';
      // Slunce a Měsíc: v aplikaci z assetů Okolníku (?obloha=), v demu
      // z assetů enginu. Když kresba chybí, zůstane obloha bez kotouče
      // a nic dalšího se nerozbije.
      slunce = new Image();
      slunce.onerror = () => console.warn('[Pocasi] kresba slunce chybí');
      slunce.src = OBLOHA_ZAKLAD + 'sun_disc.webp';
      mesic = new Image();
      mesic.onerror = () => console.warn('[Pocasi] kresba měsíce chybí');
      mesic.src = OBLOHA_ZAKLAD + 'moon_disc.webp';
      // ⚠️ THROTTLE: `move` chodí každý snímek a kreslení oblohy
      // projektuje desítky bodů — se zapnutým terénem je project()
      // raycast do modelu, takže herní styl při náklonu spadl na
      // 24 fps (10. 8.). 30 Hz je pro plující mraky víc než dost.
      map.on('move', () => {
        posledniPohybMs = Date.now();   // zrychlí tikot, viz rozjedTikac
        const ted = performance.now();
        if (ted - posledniKresba < 16) return;
        posledniKresba = ted;
        kresli();
      });
      map.on('resize', () => { velikostPlatna(); kresli(); });
    }
    platno.style.display = '';
    velikostPlatna();
    stahni();
    if (!tikac) rozjedTikac();
    kresli();
  }

  // ═══ ŠETŘENÍ BATERIE (10. 8. 2026) ═══════════════════════════════════
  //
  // Stížnosti uživatelů „appka hodně žere baterii". Změřeno `adb shell top`
  // na telefonu, kterého se nikdo nedotýká:
  //   mapa na obrazovce ……… 45–52 % jádra
  //   mapa schovaná za seznamem … 20–26 %
  // Mraky se překreslovaly přes celou obrazovku 10× za vteřinu bez ohledu
  // na to, jestli se něco děje a jestli je na mapu vůbec vidět.
  // (Poloha za tím není: FLP i dávkování jsou hotové od v1.251 a jeden fix
  //  za 5 s stojí desítky mW proti stovkám za půl jádra procesoru.)
  //
  // Dvě opatření:
  //  1. V KLIDU ŘIDČEJI. Když se s mapou 3 s nehýbalo, tik se zpomalí
  //     na `TIK_KLID_MS`. ⚠️ Fáze se posouvá podle SKUTEČNĚ uplynulého
  //     času, ne o pevný krok — jinak by mraky v klidu plavaly pomaleji.
  //     Pohyb je pak trhanější (2,5 Hz), ale mraky se sunou stejně rychle.
  //  2. NEVIDITELNÁ MAPA NEKRESLÍ. `document.hidden` nestačí: když appka
  //     překryje WebView vlastní obrazovkou (seznam, detail…), stránka je
  //     pořád „viditelná". Proto to appka říká mostem (`OkolnikMost.vidno`).
  const TIK_KLID_MS = 40;   // 5. 9. 2026: i v klidu plynule (25 Hz)
  const KLID_PO_MS = 3000;
  let posledniPohybMs = 0;
  let posledniTikMs = 0;
  let vidnoZvenku = true;

  function rozjedTikac() {
    clearTimeout(tikac);
    const ted = Date.now();
    const klid = ted - posledniPohybMs > KLID_PO_MS;
    tikac = setTimeout(() => {
      tikac = null;
      if (!document.hidden && vidnoZvenku) {
        const t = Date.now();
        // ⚠️ Strop 1 s: po návratu z pozadí (nebo po uspání časovačů) by
        // jinak mraky skokem přeletěly půl obrazovky.
        faze += Math.min(1.0, (posledniTikMs ? t - posledniTikMs : TIK_MS) / 1000);
        posledniTikMs = t;
        kresli();
      } else {
        posledniTikMs = 0;   // ať se po probuzení nezapočítá celá pauza
      }
      rozjedTikac();
    }, klid ? TIK_KLID_MS : TIK_MS);
  }

  /// Říká appka, když mapu překryje vlastní obrazovkou (seznam, detail…).
  function nastavVidno(ano) {
    vidnoZvenku = !!ano;
    if (vidnoZvenku) { posledniTikMs = 0; kresli(); }
  }

  function zavri() {
    if (tikac) { clearTimeout(tikac); tikac = null; }
    if (platno) {
      platno.style.display = 'none';
      if (ctx) ctx.clearRect(0, 0, platno.width, platno.height);
    }
  }

  /// ⭐ KROK NOCI 0–3 pro barvení mapy a světla sídel (v1.384):
  /// 0 = den, 1 = šero, 2 = soumrak, 3 = noc. Z denní fáze (hodiny
  /// 5–8 a 19–22 pozvolna) + počasí ve středu mapy: zataženo/déšť/
  /// bouřka ubere za dne stupeň (pošmourno), nikdy ale až do noci.
  /// Test: `window.__vynutKrokNoci = 0..3`.
  function stavNoci() {
    if (typeof window.__vynutKrokNoci === 'number') {
      return Math.max(0, Math.min(3, Math.round(window.__vynutKrokNoci)));
    }
    let krok = 3 - Math.round(denniFaze() * 3);
    if (krok < 2 && mapa && data && data.length) {
      try {
        const c = mapa.getCenter();
        const w = nejblizsiPocasi(c.lng, c.lat);
        if (w && (w.druh === 'zatazeno' || w.druh === 'dest'
                  || w.druh === 'bourka')) {
          krok = Math.min(krok + 1, 2);
        }
      } catch (e) { /* počasí ještě nedorazilo */ }
    }
    return krok;
  }

  return { pripoj, zavri, nastavZvenku, nastavVidno, stavNoci, snihCm,
           polohaSlunce, polohaMesice, stavSvetla };
})();
