// Okolník 3D — ATMOSFÉRA: OPRAVDOVÉ MRAKY (engine 368, 24. 9. 2026).
//
// T 24. 9.: „Chtěl bych zapracovat na mracích, aby to byly opravdu mraky…“ (po článku o Three.js: billboardy mraků,
// mlha FogExp2 na GPU, déšť jako jeden draw call, blesk světlem). Dosud mraky kreslil Pocasi (pocasi.js) jako
// malované sprity na 2D plátno – ve 2D „na obloze“ nad krajinou, kam kamera s náklonem ≤ 42° nikdy nedohlédne
// (při z15 je kamera ~850 m nad zemí, mraky NAD ní), bez skutečného pohybu s větrem a s plným překreslením na CPU.
//
// Teď JEDEN průchod WebGL přes obrazovku: za pohybu přímo do snímku MapLibre (vlastní vrstva nahoře), v klidu na
// zmenšené plátno #okolnik-atmosfera hned nad mapou (plující mraky bez překreslování mapy). Pro každý pixel paprsek
// z kamery (matice snímku MapLibre z vlastní vrstvy):
//  • průsečík s HLADINAMI MRAKŮ (nízká ~1,4 km, střední ~3,6 km, vysoká ~8 km nad zemí u středu): hustota = FBM
//    šum ve světových souřadnicích unášený skutečným větrem (jemné oktávy rychleji → mraky se mění), práh podle
//    pokrytí z bodů počasí (mřížka 48×48, IDW; vrstvy z MET Norway, jinak odvozené z oblačnosti a druhu);
//    boule nasvícené sluncem (gradient hustoty jako výška), pigment na okrajích (akvarel), noc = měsíc;
//  • průsečík se ZEMÍ: stín mraku = hustota v bodě posunutém ke slunci o výšku vrstvy / tan(výška slunce);
//    za zataženo/deště šedý závoj (pošmourno) místo ostrých stínů.
// Kamera nad vrstvou = mraky pod ní (oddálení), pod vrstvou = jen stíny (přiblížení), uvnitř = jemný závoj.
// V klidu po KlidovyTakt (~5 Hz), po 5 min nečinnosti nebo se skrytou mapou vůbec.
// A/B `?atmosfera=0` / `window.__atmosferaVyp = true` = staré mraky Pocasi.
'use strict';
const Atmosfera = (() => {
  const ID_KAMERA = 'okolnik-atmosfera-kamera';
  const MERITKO = 0.5;                  // plátno vůči CSS px (mraky i stíny jsou měkké; TT 360×499 → 180×250)
  const OBVOD = 2 * Math.PI * 6371008.8;
  const LAT_REF = 49.8;                 // pevné měřítko pole (km) – mraky při posunu nekloužou
  const C_REF = OBVOD * Math.cos(LAT_REF * Math.PI / 180);
  // oktávy šumu: perioda textury (km) – mřížka 32 buněk na periodu → buňka 6 / 1,6 / 0,8 / 0,4 / 0,2 km
  const OKT_P = [192, 51.2, 25.6, 12.8, 6.4];
  const OKT_UHEL = [0.35, 1.1, 2.3, 0.7, 1.9];          // natočení oktáv (rad) – mřížka textury se neopakuje
  const OKT_VITR = [1.0, 1.0, 1.12, 1.3, 1.55];         // jemné oktávy se sunou rychleji → tvar se mění
  const OKT_VAHA = [0.30, 0.28, 0.22, 0.13, 0.07];     // víc střední oktávy (0,8 km) = kupovité boule
  // bbox mřížky počasí (lon, lat) – ČR s okrajem
  const POC = { w: 11.6, e: 19.4, s: 48.2, n: 51.4, N: 48 };
  // ⭐ engine 370 – MLHA PODLE POČASÍ (T 24. 9.: „…na mlze, aby to byla opravdu mlha (i mlha dle počasí, ne pouze
  // ta, kterou odkrývá uživatel postupem)“). Mlha = vrstva u země v témže průchodu jako mraky: paprsek pixelu se
  // dotáhne na TERÉN (výškopis z mozaiky DEM 3×3 dlaždic kolem středu, 2 kroky) a tloušťka mlhy nad zemí je
  // větší z ÚDOLNÍ (hladina = dno okolí ~1,6 km + 35–150 m podle síly; kopce z ní trčí) a PŘÍZEMNÍ (všude tenká,
  // na kopcích slabší). Optická hloubka = síla × tloušťka / sinus paprsku (šikmo hustší, dálka mizí), chuchvalce =
  // šum unášený přízemním větrem. Síla v bodě počasí: podíl mlhy MET (fog_area_fraction), kód 45/48, vlhkost nad
  // 93 %. Strop krytí 0,8 (mapa musí zůstat čitelná), při přiblížení (kamera pod ~900 m) slabší.
  const OKT_MLHA_P = [9.6, 4.0, 1.2], OKT_MLHA_UHEL = [0.9, 2.6, 1.3], OKT_MLHA_VITR = [1.0, 1.35, 1.6];   // 372: + 1,2 km
  const TER_UROVNE = [[14.2, 12], [11.7, 10], [9.2, 8], [-99, 6]];     // od zoomu → úroveň mozaiky DEM

  let mapa = null, platno = null, gl = null;
  let sumData = null, lut = null;
  let M = null, mCas = 0;               // mainMatrix posledního snímku mapy
  let pocVerze = -1, maMraky = false, maMlhu = false, maSrazky = false;
  let srazkyZive = false, zmrazeno = false;          // engine 371: padají srážky; po 5 min klidu stojí
  let kapkyZive = false;                             // engine 371c: kapky na displeji se hýbou
  let chyba = '';
  let pripojeno = false, taktNasazen = false;
  let posledniPohybMs = 0, posledniInterakceMs = Date.now();
  const vypnutoUrl = new URLSearchParams(location.search).get('atmosfera') === '0';
  const stat = { snimku: 0, msSum: 0, msMax: 0, klid: 0, pohyb: 0, dojezd: 0, vynechano: 0 };

  // ---------------------------------------------------------------- šum (dlaždicový, izotropní 256²)
  // engine 368: bílý šum rozmazaný Gaussem (σ 3,6 px, dlaždicově s přetečením) – kulaté přirozené tvary; hodnotový
  // šum na mřížce 32 dával z dálky čtverečkované shluky. Kontrast srovnaný na střed ± 3 σ → 0..255.
  function vyrobSum() {
    const N = 256;
    let a = 0x2545F491;
    const rnd = () => {                                  // mulberry32 – pokaždé stejné mraky
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let A = new Float32Array(N * N), B = new Float32Array(N * N);
    for (let i = 0; i < A.length; i++) A[i] = rnd() - 0.5;
    const sig = 3.6, R = 11, jadro = new Float32Array(2 * R + 1);
    let sj = 0;
    for (let k = -R; k <= R; k++) { jadro[k + R] = Math.exp(-k * k / (2 * sig * sig)); sj += jadro[k + R]; }
    for (let k = 0; k < jadro.length; k++) jadro[k] /= sj;
    for (let pruchod = 0; pruchod < 2; pruchod++) {           // vodorovně, pak svisle (s přetečením = dlaždice)
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          let v = 0;
          for (let k = -R; k <= R; k++) {
            const i = pruchod === 0 ? y * N + ((x + k + N) % N) : ((y + k + N) % N) * N + x;
            v += A[i] * jadro[k + R];
          }
          B[y * N + x] = v;
        }
      }
      const t = A; A = B; B = t;
    }
    let m = 0, q = 0;
    for (let i = 0; i < A.length; i++) { m += A[i]; q += A[i] * A[i]; }
    m /= A.length;
    const sd = Math.sqrt(Math.max(1e-12, q / A.length - m * m));
    const out = new Uint8Array(N * N);
    for (let i = 0; i < A.length; i++) out[i] = Math.max(0, Math.min(255, Math.round((0.5 + (A[i] - m) / (6 * sd)) * 255)));
    return out;
  }
  /// šum v JS (bilineárně jako textura s REPEAT) – pro kalibraci prahů a závoj průletu
  function sumJs(u0, v0) {
    const N = 256;
    const x = (u0 - Math.floor(u0)) * N - 0.5, y = (v0 - Math.floor(v0)) * N - 0.5;
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const g = (i, j) => sumData[(((j % N) + N) % N) * N + (((i % N) + N) % N)] / 255;
    return (g(ix, iy) * (1 - fx) + g(ix + 1, iy) * fx) * (1 - fy) + (g(ix, iy + 1) * (1 - fx) + g(ix + 1, iy + 1) * fx) * fy;
  }
  function fbmJs(pxKm, pyKm, off, n) {
    let v = 0, w = 0;
    for (let k = 0; k < n; k++) {
      const c = Math.cos(OKT_UHEL[k]), s = Math.sin(OKT_UHEL[k]);
      const ux = (c * pxKm - s * pyKm) / OKT_P[k] + off[2 * k], uy = (s * pxKm + c * pyKm) / OKT_P[k] + off[2 * k + 1];
      v += OKT_VAHA[k] * sumJs(ux, uy);
      w += OKT_VAHA[k];
    }
    return v / w;
  }
  /// práh FBM pro pokrytí c: kvantil 1 − c rozdělení FBM (20 000 vzorků) → tabulka po 0,05
  function kalibruj() {
    const vz = new Float32Array(20000);
    let a = 7;
    const r = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
    const nula = new Float64Array(10);
    for (let i = 0; i < vz.length; i++) vz[i] = fbmJs(r() * 4000, r() * 4000, nula, 5);
    vz.sort();
    lut = [];
    for (let i = 0; i <= 20; i++) {
      const c = i / 20;
      lut.push(vz[Math.max(0, Math.min(vz.length - 1, Math.round((1 - c) * (vz.length - 1))))]);
    }
  }
  function prah(c) {
    if (!lut) return 0.5;
    const x = Math.max(0, Math.min(1, c)) * 20, i = Math.min(19, Math.floor(x)), f = x - i;
    return lut[i] * (1 - f) + lut[i + 1] * f;
  }

  // ---------------------------------------------------------------- mřížka počasí (textura 48×48 RGBA)
  // R = práh nízké vrstvy, G = tmavost (druh), B = práh střední vrstvy, A = práh vysoké (cirry); 255 = bez mraků
  const TMAVOST = { jasno: 0, polojasno: 0, zatazeno: 0.28, mlha: 0.12, snih: 0.34, dest: 0.56, bourka: 0.92 };
  function vrstvyBodu(b) {
    const o = Math.max(0, Math.min(1, b.oblacnost || 0));
    let n = b.mrakyN, s = b.mrakyS, v = b.mrakyV;
    if (!(n >= 0)) {                                     // stará data bez vrstev → odvodit
      n = b.druh === 'jasno' ? 0.3 * o : o;
      s = 0; v = 0;
      if (b.druh === 'zatazeno' || b.druh === 'snih') { n = Math.max(o, 0.88); s = 0.45 * o; }
      if (b.druh === 'dest') { n = Math.max(o, 0.93); s = 0.6; }
      if (b.druh === 'bourka') { n = Math.max(o, 0.78); s = 0.5; }
      if (b.druh === 'mlha') { n = 0.25; }
    } else {
      if (b.druh === 'dest' || b.druh === 'bourka') n = Math.max(n, 0.7);   // prší-li, nízká vrstva je
    }
    // engine 370: při mlze je „nízká oblačnost“ MET z velké části mlha sama – z výšky ji nezakrývat souvislou vrstvou
    if ((b.mlha || 0) > 0.2) n *= 1 - 0.8 * Math.min(1, b.mlha);
    return { n, s: s >= 0 ? s : 0, v: v >= 0 ? v : 0, t: TMAVOST[b.druh] || 0 };
  }
  const hlJs = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  /// engine 370: síla mlhy v bodě počasí 0–1 (podíl mlhy MET, kód mlhy, vlhkost nad 93 % = opar v údolích)
  function mlhaBodu(b) {
    let f = Math.max(0, Math.min(1, +b.mlha || 0));
    if (b.druh === 'mlha') f = Math.max(f, 0.75);
    if (b.vlhkost >= 0) f = Math.max(f, 0.35 * hlJs(93, 99.5, b.vlhkost));
    return f;
  }
  function postavPocasi() {
    if (typeof Pocasi === 'undefined' || !Pocasi.body) return false;
    const body = Pocasi.body();
    const ver = Pocasi.verze ? Pocasi.verze() : 0;
    if (ver === pocVerze && pocPx) return true;
    pocVerze = ver;
    const N = POC.N, px = new Uint8Array(N * N * 4), px2 = new Uint8Array(N * N * 4);
    maMraky = false; maMlhu = false; maSrazky = false;
    const vr = body.map((b) => ({ lng: b.lng, lat: b.lat, v: vrstvyBodu(b), m: mlhaBodu(b),
      d: Math.min(1, Math.max(0, +b.srazky || 0) / 6), bo: Math.max(0, Math.min(1, +b.bourka || 0)),
      sn: (b.druh === 'snih' || (isFinite(b.teplota) && b.teplota < 0.8 && (+b.srazky || 0) > 0.05)) ? 1 : 0 }));
    const kosLat = Math.cos(50 * Math.PI / 180);
    for (let j = 0; j < N; j++) {
      const lat = POC.n - (j + 0.5) / N * (POC.n - POC.s);
      for (let i = 0; i < N; i++) {
        const lng = POC.w + (i + 0.5) / N * (POC.e - POC.w);
        let sw = 0, n = 0, s = 0, v = 0, t = 0, ml = 0, de = 0, bo = 0, sn = 0;
        for (const b of vr) {
          const dx = (b.lng - lng) * kosLat, dy = b.lat - lat;
          const w = 1 / (dx * dx + dy * dy + 0.004);
          sw += w; n += w * b.v.n; s += w * b.v.s; v += w * b.v.v; t += w * b.v.t;
          ml += w * b.m; de += w * b.d; bo += w * b.bo; sn += w * b.sn;
        }
        const k = (j * N + i) * 4;
        if (!sw) { px[k] = 255; px[k + 1] = 0; px[k + 2] = 255; px[k + 3] = 255; continue; }
        n /= sw; s /= sw; v /= sw; t /= sw; ml /= sw; de /= sw; bo /= sw; sn /= sw;
        // engine 370: R = mlha, G = srážky (6 mm/h = 1), B = bouřka, A = sníh (déšť a blesky v dalším kole)
        px2[k] = ml < 0.03 ? 0 : Math.round(ml * 255);
        px2[k + 1] = Math.round(de * 255); px2[k + 2] = Math.round(bo * 255); px2[k + 3] = Math.round(sn * 255);
        if (px2[k] > 0) maMlhu = true;
        if (px2[k + 1] > 3 || px2[k + 3] > 60 || px2[k + 2] > 50) maSrazky = true;   // engine 371: déšť, sníh, bouřka
        px[k] = n < 0.02 ? 255 : Math.round(prah(n) * 255);
        px[k + 1] = Math.round(Math.max(0, Math.min(1, t)) * 255);
        px[k + 2] = s < 0.05 ? 255 : Math.round(prah(s * 0.9) * 255);
        px[k + 3] = v < 0.08 ? 255 : Math.round(prah(v * 0.7) * 255);
        if (px[k] < 250 || px[k + 2] < 250 || px[k + 3] < 250) maMraky = true;
      }
    }
    pocPx = px; poc2Px = px2;                            // do textury je nahraje každý kreslič (plátno i mapa)
    return true;
  }
  /// síla mlhy v mřížce u bodu (lon, lat) – nejvyšší v okolí ±r buněk (zda vůbec stavět výškopis)
  function mlhaVOkoli(lng, lat, r) {
    if (!poc2Px) return 0;
    const N = POC.N;
    const ci = Math.floor((lng - POC.w) / (POC.e - POC.w) * N), cj = Math.floor((POC.n - lat) / (POC.n - POC.s) * N);
    let m = 0;
    for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
      const ii = Math.max(0, Math.min(N - 1, i)), jj = Math.max(0, Math.min(N - 1, j));
      m = Math.max(m, poc2Px[(jj * N + ii) * 4]);
    }
    return m / 255;
  }

  // ---------------------------------------------------------------- výškopis pro údolní mlhu (mozaika DEM 3×3)
  // Dlaždice z DemSource (`__okolnikDem.getDemTile`, táž keš jako terén a vrstevnice) na úrovni podle zoomu, zmenšené
  // na 384² (R16F). „Dno okolí“ = minimum po blocích ~800 m, pak minimum ±~1,6 km a dvakrát rozmazat – hladina
  // mlhy je nad ním, takže mlha leží v údolích a kotlinách a kopce z ní trčí. Přestavba po přejetí do jiné dlaždice
  // nebo změně úrovně; stará mozaika se 0,9 s prolíná s novou (mlha se nepřeklápí skokem).
  let TER = null, terCeka = '', terVerze = 0, terPrechodMs = 0, terChyba = '';
  function urovenTer(z) { for (const [od, zD] of TER_UROVNE) if (z >= od) return zD; return 6; }
  function terenEx() {
    try { const t = mapa.getTerrain && mapa.getTerrain(); return t ? (+t.exaggeration || 1) : 0; } catch (e) { return 1; }
  }
  function zajistiTeren(K, zoom) {
    const D = window.__okolnikDem;
    if (!D || !D.getDemTile) return;
    let zD = urovenTer(zoom);
    if (TER && zD !== TER.zD && (urovenTer(zoom + 0.3) === TER.zD || urovenTer(zoom - 0.3) === TER.zD)) zD = TER.zD;
    const N2 = Math.pow(2, zD);
    const cx = Math.floor(K.Ox * N2), cy = Math.floor(K.Oy * N2);
    const klic = zD + '/' + cx + '/' + cy;
    if ((TER && TER.klic === klic) || terCeka === klic) return;
    terCeka = klic;
    const dl = [];
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const x = ((cx + i) % N2 + N2) % N2, y = cy + j;
        dl.push(y < 0 || y >= N2 ? Promise.resolve(null)
          : Promise.resolve().then(() => D.getDemTile(zD, x, y))
              .then((t) => (t && t.data && t.width === 256) ? t.data : null).catch(() => null));
      }
    }
    const lat = K.lat;
    Promise.all(dl).then((data) => {
      if (terCeka !== klic) return;                       // mezitím se chce jiná
      if (!data.some(Boolean)) { terCeka = ''; terChyba = 'bez DEM ' + klic; return; }
      const w = terWorker();
      if (!w) { terCeka = ''; return; }                   // bez workeru jen přízemní mlha (bez údolí)
      // ⚠️ bez přenosu (transfer) – pole patří keši DemSource, kopie 9 × 256 kB je levná
      w.postMessage({ klic, zD, x0: cx - 1, y0: cy - 1, lat, data });
    }).catch((e) => { terCeka = ''; terChyba = String(e && e.message || e); });
  }
  // ⭐ stavba mozaiky ve WORKERU (js/atmosfera-worker.js): v hlavním vlákně stála na TT 84–121 ms
  let terW = null, terWChyba = false;
  function terWorker() {
    if (terW || terWChyba) return terW;
    try {
      const sk = Array.from(document.scripts).find((x) => /\/atmosfera\.js/.test(x.src || ''));
      const q = sk && sk.src.indexOf('?') >= 0 ? sk.src.slice(sk.src.indexOf('?')) : '';
      terW = new Worker('js/atmosfera-worker.js' + q);
      terW.onmessage = (ev) => {
        const T = ev.data;
        if (!T || T.klic !== terCeka) return;            // starší požadavek
        terCeka = '';
        T.verze = ++terVerze;
        TER = T; terPrechodMs = performance.now();
      };
      terW.onerror = (e) => {
        terWChyba = true; terChyba = 'worker: ' + String(e && e.message || e); terCeka = '';
        try { terW.terminate(); } catch (x) { /* nic */ }
        terW = null;
      };
    } catch (e) { terWChyba = true; terW = null; terChyba = 'worker: ' + String(e && e.message || e); }
    return terW;
  }
  /// uv mozaiky z lokálních metrů kolem středu: [kx, ky, u0, v0]
  function mapaTer(T, K) {
    const N2 = Math.pow(2, T.zD), k = N2 / (K.Cm * 3);
    return [k, k, (K.Ox * N2 - T.x0) / 3, (K.Oy * N2 - T.y0) / 3];
  }

  // ---------------------------------------------------------------- shadery
  // ⭐ engine 368 (měřeno na TT): rohy obrazovky jako UNIFORMY podle gl_VertexID – přepis vertex bufferu každý snímek
  // čekal na GPU, dokud předchozí snímek buffer používal (průměr 0,8 ms místo 0,23 ms JS)
  const VS = `#version 300 es
uniform vec3 uBlizko[4];
uniform vec3 uDaleko[4];
out vec3 vB;
out vec3 vD;
void main() {
  int i = gl_VertexID;
  vec2 p = vec2((i & 1) == 1 ? 1.0 : -1.0, i >= 2 ? 1.0 : -1.0);
  vB = uBlizko[i]; vD = uDaleko[i];
  gl_Position = vec4(p, 0.0, 1.0);
}`;
  const FS = `#version 300 es
precision highp float;
in vec3 vB;
in vec3 vD;
uniform sampler2D uSum;
uniform sampler2D uPoc;
uniform vec2 uOkt[5];        // posun oktáv 0..1 (střed mapy + vítr, spočtené v JS)
uniform float uKmNaM;        // km pole na lokální metr
uniform vec4 uPocMap;        // uv počasí = xy_m * uPocMap.xy + uPocMap.zw
uniform vec3 uSlunce;        // směr KE slunci / měsíci (x východ, y jih, z nahoru)
uniform vec3 uSvetlo;        // přímé světlo (barva × síla)
uniform vec3 uOkoli;         // rozptýlené světlo oblohy
uniform float uStin;         // síla stínů mraků na zemi
uniform vec3 uVyska;         // výšky vrstev nad zemí (m): nízká, střední, vysoká
uniform vec3 uViditelnost;   // náběh vrstev podle výšky kamery 0..1
uniform float uKryti;        // strop krytí mraků (čitelnost mapy)
uniform float uZavoj;        // průlet mrakem 0..1
uniform float uPonuro;       // síla šedého závoje za zatažena
uniform vec2 uPrahZ;         // prahy pokrytí 0,97 a 0,85 – souvislá vrstva nevrhá ostré stíny
uniform vec3 uOktUtlum;      // útlum oktáv 2–4 při oddálení (0 = plná, 1 = střed) – z dálky bez „popcornu“
uniform float uOktNorm;      // vyrovnání rozptylu po útlumu → stejné pokrytí na každém zoomu
uniform float uPixUhel;      // úhel jednoho pixelu plátna (rad) – úroveň mipmapy bez derivací
uniform sampler2D uPoc2;     // engine 370: R = mlha 0..1, G = srážky, B = bouřka, A = sníh (mřížka jako uPoc)
uniform sampler2D uTerH;     // výška terénu (m n. m.), mozaika DEM 3×3 dlaždic kolem středu
uniform sampler2D uTerDno;   // dno okolí (m n. m.): minimum v okolí ~1,6 km, rozmazané
uniform vec4 uTerMap;        // uv mozaiky = xy_m * uTerMap.xy + uTerMap.zw
uniform sampler2D uTerH2;    // předchozí mozaika (prolnutí po přestavbě)
uniform sampler2D uTerDno2;
uniform vec4 uTerMap2;
uniform vec4 uTer;           // x = váha nové mozaiky, y = je mozaika, z = prolínat se starou, w = převýšení (0 = plochá mapa)
uniform vec4 uMlha;          // x = výška země u středu (vykreslené m), y = strop krytí, z = je mlha
uniform vec2 uOktMlha[3];    // posun oktáv chuchvalců (přízemní vítr); [2] = jemná 1,2 km (mlha neobjeveného)
uniform vec3 uMlhaBarva;     // barva mlhy (slunce/měsíc + obloha)
uniform sampler2D uNeob;     // engine 372: maska neobjeveného = alfa plátna rytiny (fog.js), 1 = neobjeveno
uniform vec4 uNeobMap;       // uv masky = xy_m * uNeobMap.xy + uNeobMap.zw (Mercator lineárně, v dolů = jih)
uniform vec4 uNeobPar;       // x = zapnuto, y = strop krytí, z = výška mlhy nad zemí (m), w = velikost texelu masky (m)
uniform vec3 uNeobBarva;     // barva mlhy neobjeveného (světlo + nádech pergamenu)
uniform vec4 uSrazky;        // engine 371: x = déšť 0..1, y = sníh 0..1, z = čas (s), w = náběh podle zoomu
uniform vec3 uKamera;        // engine 371b: poloha kamery (lokální m) – nadir = kam kapky „padají“ na obrazovce
uniform vec2 uOffPad[14];    // posun buněk srážek po oktávách (svět mod 64 buněk, buňka oktávy k = 2^k m)
uniform vec2 uVitrPad;       // vítr v rovině (x východ, y jih) × síla 0..1
uniform vec3 uBarvaDeste;    // barva čárek a vloček (den světlá, noc tmavší)
uniform vec4 uBlesk;         // x, y = místo úderu (lokální m), z = jas záblesku 0..1, w = poloměr záře (m)
uniform vec2 uBleskBody[9];  // klikatý kanál blesku v px plátna (od mraku k zemi)
uniform float uBleskKanal;   // jas kanálu 0..1
uniform vec4 uKapky[8];      // engine 371c: kapky na „skle“ – x, y (px plátna, y nahoru), poloměr (px), krytí
uniform int uKapekN;
float gStopa = 0.0;          // velikost pixelu v místě vzorku (km pole) – nastavuje main před každou vrstvou
out vec4 o;

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
// ⛔⛔ engine 368 (TT, Mali): ŽÁDNÉ implicitní derivace – šum se čte ve větvích, které se liší pixel od pixelu
// (předčasné return, podmínky podle počasí), a tam jsou derivace nedefinované: Mali vzal nejmenší mipmapu, šum
// zprůměroval na 0,5 a z kupek nezbylo nic (zataženo = rovný závoj). Úroveň mipmapy = log2(stopa pixelu / texel).
float okt(vec2 p, int k) {
  const float P[5] = float[5](192.0, 51.2, 25.6, 12.8, 6.4);
  const float U[5] = float[5](0.35, 1.1, 2.3, 0.7, 1.9);
  float lod = log2(max(gStopa * 256.0 / P[k], 1.0));
  return textureLod(uSum, rot(U[k]) * p / P[k] + uOkt[k], lod).r;
}
float stopa(vec3 r, float t) {                       // velikost pixelu v průsečíku (m), protažená šikmým pohledem
  float d = t * length(r);
  float s = abs(r.z) / length(r);
  return d * uPixUhel / max(s, 0.1);
}
float oktU(vec2 p, int k) {                       // oktáva s útlumem jemných při oddálení (plynule, bez skoku)
  float o = okt(p, k);
  if (k >= 2) o = mix(o, 0.5, uOktUtlum[k - 2]);
  return o;
}
float fbm(vec2 p, int n) {
  const float W[5] = float[5](0.30, 0.28, 0.22, 0.13, 0.07);
  float v = 0.0, w = 0.0;
  for (int k = 0; k < 5; k++) { if (k >= n) break; v += W[k] * oktU(p, k); w += W[k]; }
  return v / w;
}
vec4 pocasi(vec2 xy) { return textureLod(uPoc, xy * uPocMap.xy + uPocMap.zw, 0.0); }

// nízká vrstva: kupovité boule nasvícené sluncem
vec4 nizka(vec2 xy, vec4 poc, float vid) {
  if (poc.r > 0.99 || vid <= 0.0) return vec4(0.0);
  vec2 p = xy * uKmNaM;
  float f3 = fbm(p, 3);
  float f = f3 * 0.80 + 0.13 * oktU(p, 3) + 0.07 * oktU(p, 4);        // = fbm 5 oktáv (váhy 0,8 + 0,2)
  f = 0.5 + (f - 0.5) * uOktNorm;
  float d = smoothstep(poc.r - 0.03, poc.r + 0.15, f);                // měkký, průsvitný okraj
  if (d <= 0.001) return vec4(0.0);
  // světlo „o krok ke slunci“: hustota 350 m směrem ke slunci – kde je tam mrak hustší, je tady stín
  // (odvrácená strana boulí tmavá, strana ke slunci jasná) → objem místo ploché skvrny
  vec3 sl = normalize(uSlunce);
  vec2 kS = sl.xy / max(length(sl.xy), 1e-3);
  float fs = fbm(p + kS * 0.35, 3);
  float svet = clamp(0.64 + (f3 - fs) * 6.0, 0.15, 1.0);
  float souvisla = 1.0 - smoothstep(uPrahZ.x, uPrahZ.y, poc.r);       // 1 = souvislá vrstva (zataženo)
  vec3 bila = mix(vec3(1.0), vec3(0.44, 0.47, 0.52), poc.g);          // tmavost podle druhu počasí
  vec3 stin = bila * mix(vec3(0.62, 0.68, 0.79), vec3(0.74, 0.76, 0.80), souvisla);   // souvislá vrstva šedší
  svet = mix(svet, 0.5 + 0.5 * svet, souvisla * 0.6);                 // a měkčí kontrast boulí
  vec3 c = mix(stin * uOkoli * 1.15, bila * uSvetlo, svet);
  c *= 0.9 + 0.14 * d;                                                // hustší jádro světlejší (víc rozptylu)
  float okraj = smoothstep(0.05, 0.3, d) * (1.0 - smoothstep(0.3, 0.65, d));
  c *= 1.0 - 0.10 * okraj;                                            // pigment na okraji (akvarel)
  float a = pow(d, 1.25) * uKryti * vid * (1.0 - 0.32 * souvisla);   // souvislou vrstvou mapa prosvítá
  return vec4(c * a, a);
}
// střední vrstva: plošší a průsvitnější (altocumulus/altostratus)
vec4 stredni(vec2 xy, vec4 poc, float vid) {
  if (poc.b > 0.99 || vid <= 0.0) return vec4(0.0);
  vec2 p = xy * uKmNaM * 0.7 + vec2(37.0, 11.0);
  float f = fbm(p, 4);
  float d = smoothstep(poc.b, poc.b + 0.09, f);
  if (d <= 0.001) return vec4(0.0);
  vec3 bila = mix(vec3(0.96, 0.97, 0.99), vec3(0.55, 0.58, 0.63), poc.g);
  vec3 c = bila * (uOkoli * 0.75 + uSvetlo * 0.55);
  float a = d * 0.62 * uKryti * vid;
  return vec4(c * a, a);
}
// vysoká vrstva: cirry – protažené chomáče
vec4 vysoka(vec2 xy, vec4 poc, float vid) {
  if (poc.a > 0.99 || vid <= 0.0) return vec4(0.0);
  vec2 p = xy * uKmNaM;
  p = vec2(p.x * 0.35 + p.y * 0.12, p.y * 1.6) + vec2(91.0, 53.0);
  float f = fbm(p, 4);
  float d = smoothstep(poc.a, poc.a + 0.12, f);
  if (d <= 0.001) return vec4(0.0);
  vec3 c = vec3(0.97, 0.98, 1.0) * (uOkoli * 0.6 + uSvetlo * 0.6);
  float a = d * 0.34 * uKryti * vid;
  return vec4(c * a, a);
}
vec4 nad(vec4 horni, vec4 dolni) { return horni + dolni * (1.0 - horni.a); }

// ---- engine 370: MLHA
vec4 pocasi2(vec2 xy) { return textureLod(uPoc2, xy * uPocMap.xy + uPocMap.zw, 0.0); }

// ---- engine 372: MLHA NEOBJEVENÉHO (T: „mlha neobjeveného jako skutečná mlha s prosvítající rytinou“ – varianta b)
// Maska = alfa plátna rytiny z fog.js (díry = objeveno, stejné jako v rytině mapy). Mlha je VRSTVA nad terénem
// (výška H): paprsek od země zpět ke kameře v 5 krocích sčítá hustotu = neobjeveno × profil výšky (dole hustá,
// nahoře řídne, lavice různě vysoké) → na hranici objeveného stojí měkká stěna, která se při náklonu přes
// hranici naklání; lavice (3 oktávy, jemná 1,2 km) pomalu táhnou s větrem. Strop krytí – rytina prosvítá.
float neobjeveno(vec2 xy) {
  vec2 uv = xy * uNeobMap.xy + uNeobMap.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;       // mimo rytinu = pergamen = neobjeveno
  return textureLod(uNeob, uv, log2(max(gStopa / uKmNaM / uNeobPar.w, 1.0))).a;
}
float lavice(vec2 xy) {                                   // 0,75..1,2 (mlha, ne kupy mraků)
  vec2 p = xy * uKmNaM;
  float a = textureLod(uSum, rot(0.9) * p / 9.6 + uOktMlha[0], log2(max(gStopa * 256.0 / 9.6, 1.0))).r;
  float b = textureLod(uSum, rot(2.6) * p / 4.0 + uOktMlha[1], log2(max(gStopa * 256.0 / 4.0, 1.0))).r;
  float c = textureLod(uSum, rot(1.3) * p / 1.2 + uOktMlha[2], log2(max(gStopa * 256.0 / 1.2, 1.0))).r;
  return 0.75 + 0.45 * smoothstep(0.32, 0.68, 0.45 * a + 0.3 * b + 0.25 * c);
}
vec4 mlhaNeob(vec3 B, vec3 r, float tg) {
  float s = abs(r.z) / length(r);
  float H = uNeobPar.z;
  float dt = H / max(-r.z, 1e-6);                         // o kolik t výš je horní hladina vrstvy
  float u0 = neobjeveno((B + r * tg).xy), uH = neobjeveno((B + r * (tg - dt)).xy);
  if (u0 < 0.01 && uH < 0.01) return vec4(0.0);           // objeveno pod i nad – nic
  // ⚡ měřeno TT (tahy +1 p. b. snímků nad 33 ms): lavice jen JEDNOU na pixel (uprostřed vrstvy) a uvnitř
  // neobjeveného (dole i nahoře plně) se maska v krocích nevzorkuje – jen u hranice
  bool uvnitr0 = u0 > 0.98 && uH > 0.98;
  float w = lavice((B + r * (tg - 0.5 * dt)).xy);
  float sum = 0.0, vys = 0.0;
  for (int i = 0; i < 5; i++) {
    float hr = (float(i) + 0.5) / 5.0;                    // výška nad zemí / H
    float u = uvnitr0 ? 1.0 : neobjeveno((B + r * (tg - hr * dt)).xy);
    float d = u * (1.0 - smoothstep(0.3 * w, w, hr));
    sum += d;
    vys += d * hr;
  }
  float tau = 0.0081 * (H / 5.0) / max(s, 0.25) * sum;
  float a = (1.0 - exp(-tau)) * uNeobPar.y;
  float horni = sum > 0.0 ? vys / sum : 0.0;              // horní části lavic jasnější (nasvícené shora)
  return vec4(uNeobBarva * (0.93 + 0.12 * horni) * a, a);
}

// ---- engine 371b: SRÁŽKY V PROSTORU (T: „…aby to působilo, že se posouvám v dešti nebo ve sněžení“)
// Tři vodorovné vrstvy mezi kamerou a zemí (25 / 50 / 72 % výšky kamery, nejvýš pod mraky). Paprsek pixelu protne
// rovinu vrstvy a kapky leží v buňkách UKOTVENÝCH VE SVĚTĚ (posun buněk v JS v double) → při posunu kamery se
// bližší vrstvy sunou rychleji než zem (paralaxa), při přiblížení kapky rostou a přibývají jemnější (dvě oktávy
// buněk se prolínají podle velikosti pixelu). Kapka „padá“ k nadiru kamery (na obrazovce dolů, sbíhavě jako
// skutečný déšť pod nakloněnou kamerou) a vítr ji unáší; sníh = vločky, pomalu, s kolébáním.
float hash1(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }   // bez sin (levné na Mali)
// jedna oktáva buněk: q = bod roviny (m, rámec oktávy), sb = velikost buňky (m), C = nadir kamery ve stejném rámci
float padOktava(vec2 q, float sb, vec2 C, float fp, float hustota, float seed, bool snih) {
  // 2×2 buňky u bodu posunutého o 0,3 buňky k nadiru – ocas kapky sahá od hlavy ven, takže kapky, které sem
  // dosáhnou, bydlí spíš v buňkách blíž k nadiru
  vec2 uq = q - C;
  uq = uq / max(length(uq), 1e-3);
  vec2 cq = (q - uq * 0.3 * sb) / sb;
  vec2 cell = floor(cq);
  vec2 o = step(0.5, cq - cell) - 1.0;
  float v = 0.0;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec2 c = cell + o + vec2(float(i), float(j));
      vec2 cm = mod(c, 64.0);
      float h1 = hash1(cm.x * 12.9898 + cm.y * 78.233 + seed);
      if (h1 > hustota) continue;
      float h2 = hash1(h1 * 91.37 + 3.1), h3 = hash1(h1 * 47.71 + 7.3), h4 = hash1(h1 * 13.13 + 1.7);
      vec2 D = (c + 0.25 + 0.5 * vec2(h2, h3)) * sb;
      vec2 u = D - C;
      u = u / max(length(u), 1e-3);                      // od nadiru ven = na obrazovce nahoru
      float fz = fract(h4 + uSrazky.z * (snih ? 0.32 : 2.4) * (0.8 + 0.4 * h2));   // fáze pádu 0..1
      float jas = 4.0 * fz * (1.0 - fz);                 // náběh a dohasnutí kapky
      if (!snih) {
        vec2 hl = D + (u * (0.5 - fz) * 0.5 + uVitrPad * (fz - 0.5) * 0.3) * sb;   // hlava padá k nadiru, vítr unáší
        vec2 ba = u * 0.55 * sb;                                                   // ocas nad hlavou
        vec2 pa = q - hl;
        float hh = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
        float d = length(pa - ba * hh);
        float w = fp * 0.9;
        v = max(v, (1.0 - smoothstep(w * 0.4, w * 1.4, d)) * (1.0 - 0.7 * hh) * jas);
      } else {
        vec2 sw = vec2(-u.y, u.x) * sin(uSrazky.z * (0.9 + h2) + h3 * 6.283) * 0.14;
        vec2 p = D + (u * (0.5 - fz) * 0.45 + sw + uVitrPad * (fz - 0.5) * 0.25) * sb;
        float rr = max(sb * (0.08 + 0.06 * h3), fp * 1.1);
        v = max(v, (1.0 - smoothstep(rr * 0.35, rr, length(q - p))) * jas);
      }
    }
  }
  return v;
}
// jedna vrstva: výška hRel × výška kamery (strop pod mraky), měřítko buněk mer (bližší vrstva větší kapky)
float padVrstva(vec3 B, vec3 r, float hRel, float mer, float hustota, float seed, bool snih) {
  float h = min(uKamera.z * hRel, 1300.0 * hRel / 0.72);
  if (r.z > -1e-6) return 0.0;
  float t = (h - B.z) / r.z;
  if (t <= 0.0) return 0.0;
  vec2 P = (B + r * t).xy * uKmNaM * 1000.0;             // pevné měřítko světa (jako mraky) – nekloužou
  float fp = stopa(r, t) * uKmNaM * 1000.0;
  float kk = log2(max(fp * 22.0 * mer, 1.0));
  float k0 = clamp(floor(kk), 0.0, 12.0), w = clamp(kk - k0, 0.0, 1.0);
  int i0 = int(k0);
  float sb = exp2(k0);
  vec2 C = uKamera.xy * uKmNaM * 1000.0;
  float v = padOktava(P + uOffPad[i0], sb, C + uOffPad[i0], fp, hustota, seed, snih) * (1.0 - w);
  if (w > 0.02) v += padOktava(P + uOffPad[i0 + 1], sb * 2.0, C + uOffPad[i0 + 1], fp, hustota, seed + 5.0, snih) * w;
  return v;
}
float vyskaT(sampler2D t, vec4 m, vec2 xy) { return textureLod(t, xy * m.xy + m.zw, 0.0).r; }
float uvnitr(vec4 m, vec2 xy) {                       // 1 uvnitř mozaiky, k okraji plynule 0
  vec2 uv = xy * m.xy + m.zw;
  vec2 d = min(uv, 1.0 - uv);
  return smoothstep(0.0, 0.06, min(d.x, d.y));
}
// tloušťka údolní mlhy nad terénem (m); paprsek dotažený na terén (2 kroky pevného bodu od roviny středu)
float tloustkaUdoli(sampler2D tH, sampler2D tD, vec4 m, vec3 B, vec3 r, float t0, float F, out vec2 g, out float vn) {
  float t = t0;
  g = (B + r * t).xy;
  for (int i = 0; i < 2; i++) {
    float zl = vyskaT(tH, m, g) * uTer.w - uMlha.x;
    t = clamp((zl - B.z) / r.z, t0 * 0.3, t0 * 3.0);
    g = (B + r * t).xy;
  }
  vn = uvnitr(m, g);
  return (vyskaT(tD, m, g) + 35.0 + 115.0 * F - vyskaT(tH, m, g)) * vn;
}
float chuchvalce(vec2 xy) {                           // 0,55..1,2: mlžné lavice unášené větrem (díry vzácné)
  vec2 p = xy * uKmNaM;
  float a = textureLod(uSum, rot(0.9) * p / 9.6 + uOktMlha[0], log2(max(gStopa * 256.0 / 9.6, 1.0))).r;
  float b = textureLod(uSum, rot(2.6) * p / 4.0 + uOktMlha[1], log2(max(gStopa * 256.0 / 4.0, 1.0))).r;
  return 0.55 + 0.65 * smoothstep(0.30, 0.62, 0.62 * a + 0.38 * b);
}
vec4 mlha(vec3 B, vec3 r, float t0) {
  vec2 g0 = (B + r * t0).xy;
  float F = pocasi2(g0).r;
  if (F < 0.012) return vec4(0.0);
  float s = abs(r.z) / length(r);
  vec2 g = g0;
  float tl = 0.0, vn = 0.0;
  if (uTer.y > 0.5) {
    tl = tloustkaUdoli(uTerH, uTerDno, uTerMap, B, r, t0, F, g, vn);
    if (uTer.z > 0.5) {
      vec2 g2; float vn2;
      float tl2 = tloustkaUdoli(uTerH2, uTerDno2, uTerMap2, B, r, t0, F, g2, vn2);
      tl = mix(tl2, tl, uTer.x); vn = mix(vn2, vn, uTer.x); g = mix(g2, g, uTer.x);
    }
  }
  float w = chuchvalce(g);
  float prizemni = (10.0 + 30.0 * F) * (0.55 + 0.45 * w) * (1.0 - 0.8 * vn);    // všude; na kopcích jen opar
  float tau = F * (0.6 + 0.4 * w) * max(tl, prizemni) / (38.0 * max(s, 0.22));
  float a = (1.0 - exp(-tau)) * uMlha.y;
  // hladina: jemné vlny nasvícené ze strany slunce (šum 4 km o 120 m ke slunci) a tlustá mlha nahoře jasnější
  vec3 sl = normalize(uSlunce);
  vec2 kS = sl.xy / max(length(sl.xy), 1e-3);
  vec2 p = g * uKmNaM;
  float l1 = log2(max(gStopa * 256.0 / 4.0, 1.0));
  float v0 = textureLod(uSum, rot(2.6) * p / 4.0 + uOktMlha[1], l1).r;
  float v1 = textureLod(uSum, rot(2.6) * (p + kS * 0.12) / 4.0 + uOktMlha[1], l1).r;
  // ⚠️ TT 24. 9.: jas 0,86–1,02 podle hustoty + vlny ±7 % dělaly v bílé mlze šedé skvrny → jen ±4 %
  float vlny = clamp(1.0 + (v0 - v1) * 0.8 * smoothstep(0.4, 2.0, tau), 0.965, 1.035);
  vec3 c = uMlhaBarva * (0.95 + 0.05 * smoothstep(0.3, 2.5, tau)) * vlny;
  return vec4(c * a, a);
}

void main() {
  vec3 r = vD - vB;
  vec4 c = vec4(0.0);
  // --- vrstvy mraků (kamera nad nimi): od nejvyšší (nejblíž kameře) po nejnižší
  for (int i = 2; i >= 0; i--) {
    float h = uVyska[i];
    float vid = uViditelnost[i];
    if (vid <= 0.0 || abs(r.z) < 1e-6) continue;
    float t = (h - vB.z) / r.z;
    if (t <= 0.0) continue;
    vec2 xy = (vB + r * t).xy;
    gStopa = stopa(r, t) * uKmNaM;
    vec4 poc = pocasi(xy);
    vec4 m = i == 0 ? nizka(xy, poc, vid) : (i == 1 ? stredni(xy, poc, vid) : vysoka(xy, poc, vid));
    if (uBlesk.z > 0.0 && m.a > 0.0)                                  // engine 371: blesk rozsvítí mraky kolem úderu
      m.rgb += vec3(0.9, 0.93, 1.0) * uBlesk.z * 1.1 * m.a * (1.0 - smoothstep(0.0, uBlesk.w * 2.2, length(xy - uBlesk.xy)));
    c = nad(c, m);
    if (c.a > 0.985) break;
  }
  // --- země: stín mraků (posun ke slunci) a pošmourno
  if (c.a < 0.985 && r.z < -1e-6) {
    float t = -vB.z / r.z;
    vec2 g = (vB + r * t).xy;
    gStopa = stopa(r, t) * uKmNaM;
    vec4 pocG = pocasi(g);
    float s = 0.0;
    if (uStin > 0.0) {
      vec3 sl = normalize(uSlunce);
      float hor = max(length(sl.xy), 1e-3);
      vec2 k = sl.xy / hor;
      float tanEl = max(sl.z / hor, 0.09);
      vec2 q = g + k * min(uVyska.x / tanEl, 16000.0);
      vec4 pq = pocasi(q);
      if (pq.r < 0.99) {
        float f = 0.5 + (fbm(q * uKmNaM, 5) - 0.5) * uOktNorm;       // týž šum jako mrak → stín sedí pod ním
        float d = smoothstep(pq.r - 0.03, pq.r + 0.15, f);
        s = d * smoothstep(uPrahZ.x, uPrahZ.y, pq.r);                  // souvislá vrstva = bez ostrých stínů
      }
      s *= uStin;
    }
    float pon = uPonuro * pocG.g * (pocG.r < 0.99 ? 1.0 : 0.0);
    vec4 zem = vec4(vec3(0.05, 0.07, 0.11) * s, s);                 // stín (tmavě modrošedý)
    zem = nad(zem, vec4(vec3(0.30, 0.33, 0.38) * pon, pon));        // pošmourno (šedý závoj)
    if (uMlha.z > 0.5) zem = nad(mlha(vB, r, t), zem);             // engine 370: mlha nad stíny mraků
    if (uNeobPar.x > 0.5) {                                         // engine 372: mlha neobjeveného
      float tg = t;
      if (uTer.y > 0.5) {                                           // dotáhnout na terén jako údolní mlha
        float tt = t;
        for (int i = 0; i < 2; i++) {
          float zl = vyskaT(uTerH, uTerMap, (vB + r * tt).xy) * uTer.w - uMlha.x;
          tt = clamp((zl - vB.z) / r.z, t * 0.3, t * 3.0);
        }
        tg = mix(t, tt, uvnitr(uTerMap, (vB + r * tt).xy));
      }
      zem = nad(mlhaNeob(vB, r, tg), zem);
    }
    if (uBlesk.z > 0.0) {                                           // engine 371: krajina ozářená bleskem
      float sb = uBlesk.z * 0.5 * (1.0 - smoothstep(0.0, uBlesk.w, length(g - uBlesk.xy)));
      zem = nad(vec4(vec3(0.8, 0.86, 1.0) * sb, sb * 0.35), zem);
    }
    c = nad(c, zem);
  }
  // --- průlet mrakem
  if (uZavoj > 0.0) c = nad(vec4(vec3(0.93, 0.95, 0.97) * uZavoj, uZavoj), c);
  // --- engine 371: srážky mezi kamerou a zemí (3 vrstvy – blízké větší a rychlejší)
  if (uSrazky.w > 0.0) {
    if (uSrazky.x > 0.0) {
      float I = uSrazky.x, hI = sqrt(I);
      float d = 0.5 * padVrstva(vB, r, 0.25, 0.8, 0.6 * hI, 1.0, false)
              + 0.6 * padVrstva(vB, r, 0.5, 1.0, 0.55 * hI, 7.0, false)
              + 0.72 * padVrstva(vB, r, 0.72, 1.35, 0.5 * hI, 13.0, false);
      d = min(d, 0.85) * (0.6 + 0.4 * I) * uSrazky.w;
      c = nad(vec4(uBarvaDeste * d, d), c);
    }
    if (uSrazky.y > 0.0) {
      float S = uSrazky.y, hS = sqrt(S);
      float v = 0.75 * padVrstva(vB, r, 0.25, 0.8, 0.8 * hS, 3.0, true)
              + 0.9 * padVrstva(vB, r, 0.5, 1.0, 0.75 * hS, 5.0, true)
              + 1.0 * padVrstva(vB, r, 0.72, 1.4, 0.7 * hS, 9.0, true);
      v = min(v, 1.0) * uSrazky.w;
      c = nad(vec4(min(uBarvaDeste * 1.12, vec3(1.0)) * v, v), c);
    }
  }
  // --- engine 371: blesk – klikatý kanál (jádro + záře) a záblesk celé scény
  if (uBleskKanal > 0.0) {
    vec2 p = gl_FragCoord.xy;
    float dmin = 1e9;
    for (int i = 0; i < 8; i++) {
      vec2 a = uBleskBody[i], b = uBleskBody[i + 1];
      vec2 pa = p - a, ba = b - a;
      float hh = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-3), 0.0, 1.0);
      dmin = min(dmin, length(pa - ba * hh));
    }
    float k = ((1.0 - smoothstep(0.35, 1.2, dmin)) + exp(-dmin * 0.32) * 0.5) * uBleskKanal;
    c = nad(vec4(vec3(0.93, 0.95, 1.0) * k, min(1.0, k * 0.8)), c);
  }
  if (uBlesk.z > 0.0) c = nad(vec4(vec3(0.86, 0.9, 1.0) * 0.3 * uBlesk.z, 0.1 * uBlesk.z), c);
  // --- engine 371c: kapky na displeji (nad vším): sklo, tmavý lem dole, světlo čočky u spodku, okraj a odlesk nahoře
  for (int i = 0; i < 8; i++) {
    if (i >= uKapekN) break;
    vec4 k = uKapky[i];
    vec2 d = (gl_FragCoord.xy - k.xy) / max(k.z, 1.0);
    d.y *= d.y < 0.0 ? 0.86 : 1.08;                                 // spodek baculatější (kapka táhne dolů)
    float rr = length(d);
    if (rr > 1.2) continue;
    float telo = 1.0 - smoothstep(0.86, 1.0, rr);
    float dole = smoothstep(0.62, 0.95, rr) * (1.0 - smoothstep(0.95, 1.08, rr)) * (1.0 - smoothstep(-0.7, 0.1, d.y));
    float nahore = smoothstep(0.78, 0.96, rr) * (1.0 - smoothstep(0.96, 1.03, rr)) * smoothstep(-0.1, 0.7, d.y);
    float lesk = 1.0 - smoothstep(0.06, 0.22, length(d - vec2(-0.34, 0.4)));
    float zar = smoothstep(0.15, 0.85, -d.y) * telo;
    vec4 kk = vec4(vec3(0.92, 0.96, 1.0) * 0.08 * telo, 0.08 * telo);
    kk = nad(vec4(0.0, 0.0, 0.0, 0.28 * dole), kk);
    kk = nad(vec4(vec3(0.22 * zar), 0.12 * zar), kk);
    kk = nad(vec4(vec3(0.35 * nahore), 0.3 * nahore), kk);
    kk = nad(vec4(vec3(0.85 * lesk), 0.8 * lesk), kk);
    c = nad(kk * k.w, c);
  }
  o = c;
}`;

  // ---------------------------------------------------------------- kresliče: vlastní plátno (klid) a kontext MapLibre (pohyb)
  // ⭐ engine 368 (měřeno na TT 24. 9.: při tahu +3 p. b. snímků nad 33 ms, grafické vlákno WebView 7 % místo 2–3 %):
  // druhý kontext WebGL a další skládaná vrstva zatěžují grafické vlákno. PŘI POHYBU se proto mraky kreslí přímo do
  // snímku MapLibre (vlastní vrstva nahoře, týž kontext, žádná vrstva navíc); V KLIDU na vlastní plátno ~5× za s
  // (mapa se kvůli plujícím mrakům nepřekresluje). Přepnutí ve stejném snímku: při rozjezdu se plátno schová v prvním
  // snímku s mraky v mapě, po zastavení se mapa jednou překreslí bez mraků a v jejím `render` se plátno nakreslí a ukáže.
  // Plátno leží hned nad plátnem mapy (pod odlesky, zvířaty, hráčem) – pořadí je v obou režimech stejné.
  const UNIFORMY = ['uSum', 'uPoc', 'uKmNaM', 'uPocMap', 'uSlunce', 'uSvetlo', 'uOkoli', 'uStin', 'uVyska', 'uViditelnost',
                    'uKryti', 'uZavoj', 'uPonuro', 'uPrahZ', 'uOktUtlum', 'uOktNorm', 'uOkt', 'uBlizko', 'uDaleko', 'uPixUhel',
                    'uPoc2', 'uTerH', 'uTerDno', 'uTerMap', 'uTerH2', 'uTerDno2', 'uTerMap2', 'uTer', 'uMlha', 'uOktMlha',
                    'uMlhaBarva', 'uSrazky', 'uKamera', 'uOffPad', 'uVitrPad', 'uBarvaDeste', 'uBlesk', 'uBleskBody', 'uBleskKanal',
                    'uKapky', 'uKapekN', 'uNeob', 'uNeobMap', 'uNeobPar', 'uNeobBarva'];
  let pocPx = null, poc2Px = null;        // data mřížky počasí (pro oba kontexty); 2 = mlha, srážky, bouřka, sníh
  function vytvorKreslic(g) {
    const sh = (typ, zdroj) => {
      const s = g.createShader(typ);
      g.shaderSource(s, zdroj);
      g.compileShader(s);
      if (!g.getShaderParameter(s, g.COMPILE_STATUS)) { const e = g.getShaderInfoLog(s); g.deleteShader(s); throw new Error('shader: ' + e); }
      return s;
    };
    const k = { g, u: {}, pocVerze: -1, texPoc: null, texPoc2: null, fbo: null, fboTex: null, fw: 0, fh: 0, kopie: null,
                ter: null, ter2: null, texNic: null };
    k.prog = g.createProgram();
    g.attachShader(k.prog, sh(g.VERTEX_SHADER, VS));
    g.attachShader(k.prog, sh(g.FRAGMENT_SHADER, FS));
    g.linkProgram(k.prog);
    if (!g.getProgramParameter(k.prog, g.LINK_STATUS)) throw new Error('link: ' + g.getProgramInfoLog(k.prog));
    for (const n of UNIFORMY) k.u[n] = g.getUniformLocation(k.prog, n);
    k.vao = g.createVertexArray();                        // prázdné VAO – vrcholy z gl_VertexID
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
    k.texSum = g.createTexture();
    g.bindTexture(g.TEXTURE_2D, k.texSum);
    g.texImage2D(g.TEXTURE_2D, 0, g.R8, 256, 256, 0, g.RED, g.UNSIGNED_BYTE, sumData);
    g.generateMipmap(g.TEXTURE_2D);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR_MIPMAP_LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.REPEAT);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.REPEAT);
    k.texNic = texR16F(g, 1, 1, new Uint16Array(1));      // prázdné místo výškopisu (vzorkovač musí mít texturu)
    return k;
  }
  function texR16F(g, w, h, data) {
    const t = g.createTexture();
    g.bindTexture(g.TEXTURE_2D, t);
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
    g.texImage2D(g.TEXTURE_2D, 0, g.R16F, w, h, 0, g.RED, g.HALF_FLOAT, data);   // půlfloaty z workeru
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    return t;
  }
  /// engine 372: plátno rytiny (fog.js) → textura masky neobjeveného (jen alfa se čte); nové jen při změně plátna,
  /// během růstu čerstvých děr nejvýš ~5× za s
  function nahrajNeob(k, MK) {
    if (k.texNeob && k.neobVerze === MK.verze) return;
    const ted = performance.now();
    if (k.texNeob && ted - (k.neobCas || 0) < 180) return;
    const g = k.g;
    if (!k.texNeob) k.texNeob = g.createTexture();
    g.bindTexture(g.TEXTURE_2D, k.texNeob);
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, MK.platno);
    g.generateMipmap(g.TEXTURE_2D);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR_MIPMAP_LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    k.neobVerze = MK.verze; k.neobCas = ted;
    stat.neobNahrano = (stat.neobNahrano || 0) + 1;
  }
  function maskaNeob() {
    // ⚠️ `Mlha` je globální const (fog.js), ne vlastnost window
    if (window.__neobVyp || typeof Mlha === 'undefined' || !Mlha.maskaPlatno) return null;
    try { return Mlha.maskaPlatno(); } catch (e) { return null; }
  }
  /// nová mozaika do kontextu; předchozí zůstane jako „stará“ pro prolnutí
  function nahrajTeren(k) {
    if (!TER || (k.ter && k.ter.verze === TER.verze)) return;
    const g = k.g;
    if (k.ter2) { g.deleteTexture(k.ter2.tH); g.deleteTexture(k.ter2.tD); }
    k.ter2 = k.ter;
    k.ter = { verze: TER.verze, zD: TER.zD, x0: TER.x0, y0: TER.y0,
              tH: texR16F(g, TER.S, TER.S, TER.h), tD: texR16F(g, TER.G, TER.G, TER.dno) };
  }
  // ⭐ engine 368 (měřeno na TT: za pohybu v plném rozlišení snímku mapy ~720×1600 px = 25× víc pixelů než plátno
  // v klidu, +1,8 p. b. snímků nad 33 ms): v mapě se mraky kreslí do MALÉ textury (jako plátno, 0,5 CSS px) a ta se
  // jen roztáhne přes snímek (jedno čtení na pixel)
  const VS_KOPIE = `#version 300 es
out vec2 vUV;
void main() {
  int i = gl_VertexID;
  vec2 p = vec2((i & 1) == 1 ? 1.0 : -1.0, i >= 2 ? 1.0 : -1.0);
  vUV = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;
  const FS_KOPIE = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
in vec2 vUV;
out vec4 o;
void main() { o = texture(uTex, vUV); }`;
  function zajistiFbo(k, w, h) {
    const g = k.g;
    if (!k.kopie) {
      const sh = (typ, zdroj) => { const s = g.createShader(typ); g.shaderSource(s, zdroj); g.compileShader(s);
        if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error('kopie: ' + g.getShaderInfoLog(s)); return s; };
      const pr = g.createProgram();
      g.attachShader(pr, sh(g.VERTEX_SHADER, VS_KOPIE));
      g.attachShader(pr, sh(g.FRAGMENT_SHADER, FS_KOPIE));
      g.linkProgram(pr);
      if (!g.getProgramParameter(pr, g.LINK_STATUS)) throw new Error('kopie link');
      k.kopie = { prog: pr, uTex: g.getUniformLocation(pr, 'uTex') };
    }
    if (k.fbo && k.fw === w && k.fh === h) return;
    if (!k.fboTex) k.fboTex = g.createTexture();
    g.bindTexture(g.TEXTURE_2D, k.fboTex);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, null);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    if (!k.fbo) k.fbo = g.createFramebuffer();
    g.bindFramebuffer(g.FRAMEBUFFER, k.fbo);
    g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, k.fboTex, 0);
    k.fw = w; k.fh = h;
  }
  function nahrajPocasi(k) {
    if (k.pocVerze === pocVerze && k.texPoc) return;
    const g = k.g;
    if (!k.texPoc) k.texPoc = g.createTexture();
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
    g.bindTexture(g.TEXTURE_2D, k.texPoc);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, POC.N, POC.N, 0, g.RGBA, g.UNSIGNED_BYTE, pocPx);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    if (!k.texPoc2) k.texPoc2 = g.createTexture();
    g.bindTexture(g.TEXTURE_2D, k.texPoc2);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, POC.N, POC.N, 0, g.RGBA, g.UNSIGNED_BYTE, poc2Px);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    k.pocVerze = pocVerze;
  }
  let kPlatno = null, kMapa = null, kMapaGl = null;
  function zalozGL() {
    if (gl) return true;
    try {
      platno = document.createElement('canvas');
      platno.id = 'okolnik-atmosfera';
      platno.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
      gl = platno.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false,
                                         stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' });
      if (!gl) throw new Error('bez WebGL2');
      if (!sumData) { sumData = vyrobSum(); kalibruj(); }
      kPlatno = vytvorKreslic(gl);
      platno.addEventListener('webglcontextlost', (e) => { e.preventDefault(); chyba = 'kontext ztracen'; kPlatno = null; });
      platno.addEventListener('webglcontextrestored', () => {
        try { kPlatno = vytvorKreslic(gl); chyba = ''; } catch (e) { chyba = String(e && e.message || e); }
      });
      return true;
    } catch (e) {
      chyba = String(e && e.message || e);
      console.warn('[atmosfera]', chyba);
      gl = null;
      return false;
    }
  }

  // ---------------------------------------------------------------- kamera z matice snímku
  function inverze(m) {
    const a = m, inv = new Float64Array(16);
    inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
    inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
    inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
    inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
    inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
    inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
    inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
    inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
    inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
    inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
    inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
    inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
    inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
    inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
    inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
    inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
    let det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
    if (!det) return null;
    det = 1 / det;
    for (let i = 0; i < 16; i++) inv[i] *= det;
    return inv;
  }
  const blizko = new Float32Array(12), daleko = new Float32Array(12);
  const mercX = (lng) => (lng + 180) / 360;
  const mercY = (lat) => { const s = Math.sin(lat * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
  /// rohy obrazovky (blízká/vzdálená rovina) v lokálních metrech kolem středu na zemi + výška kamery
  function kamera() {
    if (!M) return null;
    const inv = inverze(M);
    if (!inv) return null;
    const c = mapa.getCenter();
    const Ox = mercX(c.lng), Oy = mercY(c.lat);
    // výška země u středu (jednotky Mercatoru): z, pro které se střed promítne na střed obrazovky (ndc.y = 0)
    const A1 = M[1] * Ox + M[5] * Oy + M[13], B1 = M[9];
    const z0 = Math.abs(B1) > 1e-12 ? -A1 / B1 : 0;
    const Cm = OBVOD * Math.cos(c.lat * Math.PI / 180);
    const bod = (nx, ny, nz) => {
      const x = inv[0] * nx + inv[4] * ny + inv[8] * nz + inv[12];
      const y = inv[1] * nx + inv[5] * ny + inv[9] * nz + inv[13];
      const z = inv[2] * nx + inv[6] * ny + inv[10] * nz + inv[14];
      const w = inv[3] * nx + inv[7] * ny + inv[11] * nz + inv[15];
      return [(x / w - Ox) * Cm, (y / w - Oy) * Cm, (z / w - z0) * Cm];
    };
    let kx = 0, ky = 0, kz = 0;
    const R = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (let i = 0; i < 4; i++) {
      const b = bod(R[i][0], R[i][1], -1), d = bod(R[i][0], R[i][1], 1);
      blizko[3 * i] = b[0]; blizko[3 * i + 1] = b[1]; blizko[3 * i + 2] = b[2];
      daleko[3 * i] = d[0]; daleko[3 * i + 1] = d[1]; daleko[3 * i + 2] = d[2];
      kx += b[0] / 4; ky += b[1] / 4; kz += b[2] / 4;
    }
    return { Ox, Oy, Cm, lat: c.lat, lng: c.lng, kamera: [kx, ky, kz], z0m: z0 * Cm };
  }

  // ---------------------------------------------------------------- světlo (slunce / měsíc) a vítr
  function mix3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function hex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
  function svetlo() {
    let st = null;
    try { st = Pocasi.stavSvetla(); } catch (e) { st = null; }
    const smer = (az, el) => { const a = az * Math.PI / 180, e = el * Math.PI / 180; return [Math.sin(a) * Math.cos(e), -Math.cos(a) * Math.cos(e), Math.sin(e)]; };
    if (!st) return { S: smer(200, 40), svetlo: [1, 0.98, 0.94], okoli: [0.62, 0.68, 0.76], stin: 0.3, noc: false };
    const el = st.slunceEl;
    if (el > -3) {
      const t = Math.max(0, Math.min(1, el / 30));
      const zlate = hex('#FFB27A'), den = hex('#FFF7EA');
      let sv = mix3(zlate, den, t);
      let ok = mix3(hex('#9A8CA8'), hex('#AFC3D6'), t);
      const sila = el < 2 ? Math.max(0.25, (el + 3) / 5) : 1;
      sv = sv.map((x) => x * (0.55 + 0.5 * Math.min(1, (el + 3) / 12)) * sila);
      ok = ok.map((x) => x * (0.62 + 0.25 * t));
      return { S: smer(st.slunceAz, Math.max(el, 2)), svetlo: sv, okoli: ok, stin: 0.34 * Math.max(0, Math.min(1, (el - 2) / 10)), noc: false };
    }
    const mesic = st.mesicEl > 3 ? Math.max(0, st.mesicOsvit || 0) : 0;
    return { S: smer(st.mesicAz || 180, Math.max(st.mesicEl || 20, 10)),
             svetlo: hex('#9FB4DA').map((x) => x * (0.12 + 0.3 * mesic)),
             okoli: hex('#26324C').map((x) => x * 0.9),
             stin: 0.09 * mesic, noc: true };
  }
  /// engine 371: srážky a bouřka u středu mapy (z téhož stavu jako světlo): déšť / sníh 0–1, bouřka 0–1
  function srazkyStredu() {
    let st = null;
    try { st = Pocasi.stavSvetla(); } catch (e) { return { dest: 0, snih: 0, bourka: 0 }; }
    const druh = String(st.druh || ''), mm = Math.max(0, +st.srazky || 0);
    let dest = 0, snih = 0;
    const padaSnih = druh === 'snih' || (isFinite(st.teplota) && st.teplota < 0.8);
    if (druh === 'dest' || druh === 'bourka' || druh === 'snih' || mm > 0.05) {
      const I = Math.max(druh === 'bourka' ? 0.65 : (druh === 'dest' || druh === 'snih' ? 0.3 : 0.12), Math.min(1, mm / 4));
      if (padaSnih) snih = I; else dest = I;
    }
    return { dest, snih, bourka: Math.max(+st.bourka || 0, druh === 'bourka' ? 0.6 : 0) };
  }
  /// engine 371b: vítr v rovině srážek (x východ, y jih) × síla 0..1
  function vitrPadu() {
    let v = null;
    try { v = Pocasi.vitr(); } catch (e) { v = null; }
    const kmh = v ? (+v.kmh || 0) : 0;
    const kam = (((v && v.smerOdkud) || 270) + 180) * Math.PI / 180;
    const k = Math.min(1, kmh / 35);
    return [Math.sin(kam) * k, -Math.cos(kam) * k];
  }
  /// posuny buněk srážek po oktávách: poloha středu v pevném měřítku světa (m) mod 64 buněk – v double, ať kapky
  /// drží ve světě (float v shaderu by na milionech metrů ztratil přesnost)
  const offPad = new Float32Array(28);
  function offsetyPadu(K) {
    const wx = K.Ox * C_REF, wy = K.Oy * C_REF;
    for (let k = 0; k < 14; k++) {
      const per = 64 * Math.pow(2, k);
      offPad[2 * k] = wx - Math.floor(wx / per) * per;
      offPad[2 * k + 1] = wy - Math.floor(wy / per) * per;
    }
    return offPad;
  }
  // ---- blesky: záblesky v sériích (hlavní výboj + 2–3 dozvuky), místo úderu náhodně v záběru, kanál od mraku k zemi
  let blesk = null, dalsiBleskMs = 0, bleskRaf = 0, posledniBlesk = null;
  const PULZY = [[0, 1.0], [95, 0.55], [150, 0.85], [330, 0.35]];
  function jasBlesku(dt, p) {
    let j = 0;
    for (const [t, a] of p) if (dt >= t) j = Math.max(j, a * Math.exp(-(dt - t) / 45));
    return j;
  }
  function krokBlesku(t0, bourka, K, zoom) {
    if (!(bourka > 0.2) || window.__bleskyVyp) { blesk = null; return null; }
    if ((!blesk && t0 > dalsiBleskMs) || window.__bleskHned) {
      const prvni = !dalsiBleskMs && !window.__bleskHned;
      window.__bleskHned = false;
      dalsiBleskMs = t0 + 3000 + Math.random() * (16000 - 11000 * Math.min(1, bourka));
      if (prvni) return null;
      // místo úderu = náhodný bod obrazovky (střední 80 % šířky, 15–85 % výšky) promítnutý na zem → vždy v záběru
      let x = 0, y = 0;
      try {
        const el = mapa.getContainer();
        const ll = mapa.unproject([el.clientWidth * (0.1 + 0.8 * Math.random()), el.clientHeight * (0.15 + 0.7 * Math.random())]);
        x = (mercX(ll.lng) - K.Ox) * K.Cm; y = (mercY(ll.lat) - K.Oy) * K.Cm;
      } catch (e) { x = 0; y = 0; }
      const top = Math.min(1400, 0.75 * K.kamera[2]);
      const body = [];
      let ox = 0, oy = 0;
      for (let i = 0; i <= 8; i++) {
        if (i > 0 && i < 8) { ox += (Math.random() - 0.5) * 0.12 * top; oy += (Math.random() - 0.5) * 0.12 * top; }
        body.push([x + ox * (i === 8 ? 0.6 : 1), y + oy * (i === 8 ? 0.6 : 1), top * (1 - i / 8)]);
      }
      blesk = { t0, x, y, body, p: PULZY.map(([t, a]) => [t + Math.random() * 30, a * (0.8 + Math.random() * 0.4)]),
                kanal: zoom >= 11 && Math.random() < 0.8 };
    }
    if (!blesk) return null;
    const dt = typeof window.__bleskT === 'number' ? window.__bleskT : t0 - blesk.t0;   // test: __bleskT = pevný čas záblesku
    if (dt > 800) { blesk = null; return null; }
    const B = { x: blesk.x, y: blesk.y, sila: jasBlesku(dt, blesk.p), r: Math.max(900, 0.45 * K.kamera[2]), kanal: 0, kanalPx: null };
    if (blesk.kanal && dt < 260) {
      const px = new Float32Array(18);
      let ok = true;
      for (let i = 0; i < 9 && ok; i++) {
        const q = promitni(blesk.body[i][0], blesk.body[i][1], blesk.body[i][2], K);
        if (!q) ok = false; else { px[2 * i] = q[0]; px[2 * i + 1] = q[1]; }
      }
      if (ok) { B.kanal = Math.min(1, jasBlesku(dt, blesk.p.slice(0, 3))); B.kanalPx = px; }
    }
    posledniBlesk = B;
    return B;
  }
  /// lokální metry (z nad zemí u středu) → px plátna (y nahoru, jako gl_FragCoord), null = za kamerou
  function promitni(x, y, z, K) {
    const X = K.Ox + x / K.Cm, Y = K.Oy + y / K.Cm, Z = (K.z0m + z) / K.Cm;
    const cx = M[0] * X + M[4] * Y + M[8] * Z + M[12];
    const cy = M[1] * X + M[5] * Y + M[9] * Z + M[13];
    const cw = M[3] * X + M[7] * Y + M[11] * Z + M[15];
    if (!(cw > 1e-9)) return null;
    const el = mapa.getContainer();
    const w = Math.max(1, Math.round(el.clientWidth * MERITKO)), h = Math.max(1, Math.round(el.clientHeight * MERITKO));
    return [(cx / cw * 0.5 + 0.5) * w, (cy / cw * 0.5 + 0.5) * h];
  }
  let vitrPosun = [0, 0], vitrCas = 0;     // km, integrál větru (plynule i při změně větru)
  const vitrMlha = [0, 0];                 // km, integrál přízemního větru (mlha)
  function vitrKrok(tMs) {
    let v = null;
    try { v = Pocasi.vitr(); } catch (e) { v = null; }
    const dt = vitrCas ? Math.min(2, (tMs - vitrCas) / 1000) : 0;
    vitrCas = tMs;
    if (!v || !dt) return;
    // mraky táhnou rychleji než přízemní vítr (výška ~1,5 km ≈ 1,6×, min 8 km/h)
    const kmh = Math.max(8, (v.kmh || 0) * 1.6);
    const kam = ((v.smerOdkud || 270) + 180) * Math.PI / 180;
    const ds = kmh / 3600 * dt * (window.__atmosferaZrychli || 1);
    vitrPosun[0] += Math.sin(kam) * ds;
    vitrPosun[1] += -Math.cos(kam) * ds;     // y pole roste k jihu
    // engine 370: mlha táhne s přízemním větrem (bez násobku výšky), aspoň 2,5 km/h – lavice se pomalu sunou
    const dsM = Math.max(2.5, v.kmh || 0) / 3600 * dt * (window.__atmosferaZrychli || 1);
    vitrMlha[0] += Math.sin(kam) * dsM;
    vitrMlha[1] += -Math.cos(kam) * dsM;
  }
  const oktMOut = new Float32Array(6);
  function oktavyMlhy(K) {
    const gx = K.Ox * C_REF / 1000, gy = K.Oy * C_REF / 1000;
    for (let k = 0; k < 3; k++) {
      const px = gx - vitrMlha[0] * OKT_MLHA_VITR[k], py = gy - vitrMlha[1] * OKT_MLHA_VITR[k];
      const c = Math.cos(OKT_MLHA_UHEL[k]), s = Math.sin(OKT_MLHA_UHEL[k]);
      const ux = (c * px - s * py) / OKT_MLHA_P[k], uy = (s * px + c * py) / OKT_MLHA_P[k];
      oktMOut[2 * k] = ux - Math.floor(ux);
      oktMOut[2 * k + 1] = uy - Math.floor(uy);
    }
    return oktMOut;
  }
  /// posuny oktáv (0..1): R_k · (poloha středu v km v pevném měřítku − vítr·rychlost_k) / P_k, zlomek
  const oktOut = new Float32Array(10);
  function oktavy(K) {
    const gx = K.Ox * C_REF / 1000, gy = K.Oy * C_REF / 1000;
    for (let k = 0; k < 5; k++) {
      const px = gx - vitrPosun[0] * OKT_VITR[k], py = gy - vitrPosun[1] * OKT_VITR[k];
      const c = Math.cos(OKT_UHEL[k]), s = Math.sin(OKT_UHEL[k]);
      const ux = (c * px - s * py) / OKT_P[k], uy = (s * px + c * py) / OKT_P[k];
      oktOut[2 * k] = ux - Math.floor(ux);
      oktOut[2 * k + 1] = uy - Math.floor(uy);
    }
    return oktOut;
  }

  // ---------------------------------------------------------------- snímek: společné hodnoty pro oba kresliče
  let svKes = null, svKesMs = 0, svKesVynut = null;
  function smi() {
    if (!pripojeno || !gl || vypnutoUrl || window.__atmosferaVyp) return false;
    if (document.hidden) return false;
    if (window.__nastaveniMapy && window.__nastaveniMapy.pocasi === false) return false;
    if (platno.style.display === 'none') return false;
    return true;
  }
  /// úhel jednoho pixelu plátna (rad): úhel mezi paprsky horních a dolních rohů / výška plátna
  function pixUhel() {
    const r0 = [daleko[0] - blizko[0], daleko[1] - blizko[1], daleko[2] - blizko[2]];
    const r1 = [daleko[6] - blizko[6], daleko[7] - blizko[7], daleko[8] - blizko[8]];
    const l0 = Math.hypot(r0[0], r0[1], r0[2]), l1 = Math.hypot(r1[0], r1[1], r1[2]);
    const c = Math.max(-1, Math.min(1, (r0[0] * r1[0] + r0[1] * r1[1] + r0[2] * r1[2]) / (l0 * l1 || 1)));
    const h = Math.max(1, Math.round(mapa.getContainer().clientHeight * MERITKO));
    return Math.acos(c) / h;
  }
  /// null = nic nekreslit
  function pripravSnimek(t0, bezSrazek) {
    if (!smi()) { srazkyZive = false; return null; }
    const MK = maskaNeob();                              // engine 372: mlha neobjeveného
    if (!postavPocasi() || !(maMraky || maMlhu || maSrazky || MK)) { srazkyZive = false; return null; }   // nic k vidění
    const K = kamera();
    if (!K) return null;
    vitrKrok(t0);
    if (!svKes || t0 - svKesMs > 1000 || svKesVynut !== window.__vynutSvetlo) {
      svKes = svetlo(); svKesMs = t0; svKesVynut = window.__vynutSvetlo;
      svKes.sr = srazkyStredu();                          // engine 371
    }
    const sv = svKes;
    // výšky vrstev nad zemí u středu (m) a náběh podle výšky kamery (nad vrstvou = viditelná shora)
    const vys = [1400, 3600, 8200];
    const kz = K.kamera[2];
    const vid = vys.map((h, i) => {
      const nad = kz - (h + (i === 0 ? 450 : 200));
      return Math.max(0, Math.min(1, nad / (i === 0 ? 1500 : 3000)));
    });
    // průlet: kamera v nízké vrstvě (1,1–1,9 km) a pod ní mrak
    let zavoj = 0;
    const kd = Math.max(0, 1 - Math.abs(kz - 1500) / 450);
    if (kd > 0) {
      const off = oktavy(K);
      const pk = [K.kamera[0] * C_REF / K.Cm / 1000, K.kamera[1] * C_REF / K.Cm / 1000];
      const f = fbmJs(pk[0], pk[1], off, 3);
      const b = Pocasi.body ? Pocasi.body() : [];
      let n = 0;
      if (b.length) {
        let best = null, bd = 1e9;
        for (const p of b) { const d = (p.lng - K.lng) ** 2 + (p.lat - K.lat) ** 2; if (d < bd) { bd = d; best = p; } }
        n = best ? vrstvyBodu(best).n : 0;
      }
      if (n > 0.02) zavoj = Math.max(0, Math.min(1, (f - prah(n)) / 0.08)) * kd * 0.3;
    }
    // nic k vidění (kamera pod vrstvami, v noci bez stínů) → nekreslit
    const zoom = mapa.getZoom();
    // engine 370: mlha – jen když je v mřížce poblíž (jinak ani výškopis)
    let mlha = null;
    if (maMlhu && !window.__mlhaVyp && mlhaVOkoli(K.lng, K.lat, zoom < 10 ? 48 : 4) > 0.01) {
      zajistiTeren(K, zoom);
      // strop krytí podle ZOOMU (ne výšky kamery – ta závisí na výšce obrazovky): do z14,5 plná 0,85, při přiblížení
      // k z17,2 klesá na 0,38 – „sestupujeme do mlhy a vidíme pod sebe“, mapa zůstane čitelná
      const bl = Math.max(0, Math.min(1, (zoom - 14.5) / 2.7));
      const strop = 0.85 * (1 - 0.55 * bl * bl * (3 - 2 * bl));
      // den: bílá nasvícená sluncem (za soumraku do zlatova); noc: stříbřitě modrá – mlha odráží měsíc a záři sídel,
      // je SVĚTLEJŠÍ než tmavá krajina (jinak by v noci vypadala jako stín)
      const barva = [0, 1, 2].map((i) => sv.noc ? sv.okoli[i] * 0.8 + sv.svetlo[i] * 0.9 + 0.04
                                                : sv.okoli[i] * 0.45 + sv.svetlo[i] * 0.72);
      mlha = { strop, barva, okt: oktavyMlhy(K), z0: K.z0m, ex: terenEx() };
      if (window.__mlhaLadeni) Object.assign(mlha, window.__mlhaLadeni);   // test: {barva: [1, 0, 0], strop: 1}
    }
    // engine 372: mlha neobjeveného – z přehledu slabší (rytina celé ČR zůstane čitelná), z12–15 plná, zblízka slabší
    let neob = null;
    if (MK) {
      zajistiTeren(K, zoom);
      oktavyMlhy(K);
      const mw = MK.meta;
      const x0 = mercX(mw.west), x1 = mercX(mw.east), y0 = mercY(mw.north), y1 = mercY(mw.south);
      const hl = (a, b, x) => { const q = Math.max(0, Math.min(1, (x - a) / (b - a))); return q * q * (3 - 2 * q); };
      const strop = 0.4 + 0.22 * hl(9, 12, zoom) - 0.14 * hl(15, 17.5, zoom);   // rytina má prosvítat
      const zakl = [0, 1, 2].map((i) => sv.noc ? sv.okoli[i] * 0.8 + sv.svetlo[i] * 0.9 + 0.04
                                                : sv.okoli[i] * 0.45 + sv.svetlo[i] * 0.72);
      const perg = [0.93, 0.9, 0.83];
      neob = { MK, strop, H: 200, texM: (x1 - x0) * K.Cm / MK.platno.width,
               map: [1 / (K.Cm * (x1 - x0)), 1 / (K.Cm * (y1 - y0)), (K.Ox - x0) / (x1 - x0), (K.Oy - y0) / (y1 - y0)],
               barva: zakl.map((x, i) => x * 0.7 + perg[i] * (sv.noc ? 0.1 : 0.3)) };
      if (window.__neobLadeni) Object.assign(neob, window.__neobLadeni);   // test: {barva: [1, 0, 0], strop: 1}
    }
    // engine 371: déšť a sníh (pod mraky – od z10,5 nabíhá), blesky
    let srazky = null;
    const nabehS = Math.max(0, Math.min(1, (zoom - 10.5) / 1.3));
    if (!window.__srazkyVyp && !bezSrazek && nabehS > 0 && (sv.sr.dest > 0.01 || sv.sr.snih > 0.01)) {
      srazky = { dest: sv.sr.dest, snih: sv.sr.snih, w: nabehS, vitr: vitrPadu(), off: offsetyPadu(K), t: (t0 / 1000) % 600,
                 barva: sv.noc ? [0.42, 0.48, 0.58] : [0.86, 0.89, 0.93] };
    }
    srazkyZive = !!srazky;
    const blesk = bezSrazek ? null : krokBlesku(t0, sv.sr.bourka, K, zoom);
    // engine 371c: kapky na displeji (model v kapky.js, kresba tady)
    let kapky = null;
    kapkyZive = false;
    if (window.Kapky && !bezSrazek) {
      try { kapkyZive = Kapky.krok(t0); if (Kapky.pocet()) kapky = Kapky.data(MERITKO); } catch (e) { kapky = null; }
    }
    if (vid[0] <= 0 && vid[1] <= 0 && vid[2] <= 0 && zavoj <= 0 && sv.stin <= 0.005 && sv.noc && !mlha && !srazky && !blesk && !kapky && !neob) return null;
    const kryti = 0.9 - 0.2 * Math.max(0, Math.min(1, (zoom - 9) / 4));
    // uv mřížky počasí: lon/lat → uv (lineárně v Mercatoru)
    const x0 = mercX(POC.w), x1 = mercX(POC.e), y0 = mercY(POC.n), y1 = mercY(POC.s);
    // oktávy 0,8 / 0,4 / 0,2 km se z dálky plynule vyhladí (pod ~4 px buňky jen šumí), rozptyl se vyrovná
    const utl = (z1, z2) => Math.max(0, Math.min(1, (z2 - zoom) / (z2 - z1)));
    const ut = [0, 0, utl(8.5, 10.5), utl(9.5, 11.5), utl(10.5, 12.5)];
    let vPlna = 0, vUtl = 0;
    for (let k = 0; k < 5; k++) { vPlna += OKT_VAHA[k] ** 2; vUtl += (OKT_VAHA[k] * (1 - ut[k])) ** 2; }
    return {
      okt: oktavy(K), kmNaM: C_REF / K.Cm / 1000,
      pocMap: [1 / (K.Cm * (x1 - x0)), 1 / (K.Cm * (y1 - y0)), (K.Ox - x0) / (x1 - x0), (K.Oy - y0) / (y1 - y0)],
      sv, vys, vid, kryti: sv.noc ? kryti * 0.7 : kryti, zavoj, ponuro: sv.noc ? 0.1 : 0.2,
      prahZ: [prah(0.97), prah(0.85)], utlum: [ut[2], ut[3], ut[4]], norm: Math.sqrt(vPlna / Math.max(1e-6, vUtl)),
      pixUhel: pixUhel(),
      K, mlha, srazky, blesk, kapky, neob, ex: (mlha || neob) ? terenEx() : 1,
    };
  }
  function kresliDo(k, S, doMapy) {
    const g = k.g, u = k.u;
    nahrajPocasi(k);
    let predFb = null, predVp = null;
    if (doMapy) {
      predFb = g.getParameter(g.FRAMEBUFFER_BINDING);
      predVp = g.getParameter(g.VIEWPORT);
      const el = mapa.getContainer();
      const w = Math.max(1, Math.round(el.clientWidth * MERITKO)), h = Math.max(1, Math.round(el.clientHeight * MERITKO));
      zajistiFbo(k, w, h);
      g.bindFramebuffer(g.FRAMEBUFFER, k.fbo);
      g.viewport(0, 0, w, h);
      g.disable(g.DEPTH_TEST); g.disable(g.STENCIL_TEST); g.disable(g.CULL_FACE); g.disable(g.SCISSOR_TEST);
      g.depthMask(false);
      g.colorMask(true, true, true, true);
    } else {
      g.viewport(0, 0, platno.width, platno.height);
    }
    g.clearColor(0, 0, 0, 0);
    g.clear(g.COLOR_BUFFER_BIT);
    g.disable(g.BLEND);
    g.useProgram(k.prog);
    g.uniform3fv(u.uBlizko, blizko);
    g.uniform3fv(u.uDaleko, daleko);
    g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, k.texSum); g.uniform1i(u.uSum, 0);
    g.activeTexture(g.TEXTURE1); g.bindTexture(g.TEXTURE_2D, k.texPoc); g.uniform1i(u.uPoc, 1);
    g.uniform2fv(u.uOkt, S.okt);
    g.uniform1f(u.uKmNaM, S.kmNaM);
    g.uniform4f(u.uPocMap, S.pocMap[0], S.pocMap[1], S.pocMap[2], S.pocMap[3]);
    g.uniform3fv(u.uSlunce, S.sv.S);
    g.uniform3fv(u.uSvetlo, S.sv.svetlo);
    g.uniform3fv(u.uOkoli, S.sv.okoli);
    g.uniform1f(u.uStin, S.sv.stin);
    g.uniform3fv(u.uVyska, S.vys);
    g.uniform3fv(u.uViditelnost, S.vid);
    g.uniform1f(u.uKryti, S.kryti);
    g.uniform1f(u.uZavoj, S.zavoj);
    g.uniform1f(u.uPonuro, S.ponuro);
    g.uniform2f(u.uPrahZ, S.prahZ[0], S.prahZ[1]);
    g.uniform3f(u.uOktUtlum, S.utlum[0], S.utlum[1], S.utlum[2]);
    g.uniform1f(u.uOktNorm, S.norm);
    g.uniform1f(u.uPixUhel, S.pixUhel);
    // engine 370: mlha
    const terOn = !!(S.mlha || S.neob);                 // engine 372: výškopis i pro mlhu neobjeveného
    if (terOn) nahrajTeren(k);
    const T1 = terOn && k.ter ? k.ter : null, T2 = terOn && k.ter2 ? k.ter2 : null;
    let vaha = T2 ? Math.min(1, (performance.now() - terPrechodMs) / 900) : 1;
    vaha = vaha * vaha * (3 - 2 * vaha);
    g.activeTexture(g.TEXTURE2); g.bindTexture(g.TEXTURE_2D, k.texPoc2); g.uniform1i(u.uPoc2, 2);
    g.activeTexture(g.TEXTURE3); g.bindTexture(g.TEXTURE_2D, T1 ? T1.tH : k.texNic); g.uniform1i(u.uTerH, 3);
    g.activeTexture(g.TEXTURE4); g.bindTexture(g.TEXTURE_2D, T1 ? T1.tD : k.texNic); g.uniform1i(u.uTerDno, 4);
    g.activeTexture(g.TEXTURE5); g.bindTexture(g.TEXTURE_2D, T2 ? T2.tH : k.texNic); g.uniform1i(u.uTerH2, 5);
    g.activeTexture(g.TEXTURE6); g.bindTexture(g.TEXTURE_2D, T2 ? T2.tD : k.texNic); g.uniform1i(u.uTerDno2, 6);
    g.uniform4fv(u.uTerMap, T1 ? mapaTer(T1, S.K) : [0, 0, 0, 0]);
    g.uniform4fv(u.uTerMap2, T2 ? mapaTer(T2, S.K) : [0, 0, 0, 0]);
    g.uniform4f(u.uTer, vaha, T1 ? 1 : 0, T2 && vaha < 1 ? 1 : 0, S.ex);
    g.uniform4f(u.uMlha, S.K.z0m, S.mlha ? S.mlha.strop : 0, S.mlha ? 1 : 0, 0);
    g.uniform2fv(u.uOktMlha, oktMOut);
    // engine 372: mlha neobjeveného
    if (S.neob) nahrajNeob(k, S.neob.MK);
    const neobOk = !!(S.neob && k.texNeob);
    g.activeTexture(g.TEXTURE7); g.bindTexture(g.TEXTURE_2D, neobOk ? k.texNeob : k.texNic); g.uniform1i(u.uNeob, 7);
    g.uniform4fv(u.uNeobMap, neobOk ? S.neob.map : [0, 0, 0, 0]);
    g.uniform4f(u.uNeobPar, neobOk ? 1 : 0, neobOk ? S.neob.strop : 0, neobOk ? S.neob.H : 1, neobOk ? S.neob.texM : 1);
    g.uniform3fv(u.uNeobBarva, neobOk ? S.neob.barva : [1, 1, 1]);
    g.uniform3fv(u.uMlhaBarva, S.mlha ? S.mlha.barva : [1, 1, 1]);
    // engine 371: srážky a blesk
    const sr = S.srazky, bl = S.blesk;
    g.uniform4f(u.uSrazky, sr ? sr.dest : 0, sr ? sr.snih : 0, sr ? sr.t : 0, sr ? sr.w : 0);
    g.uniform3f(u.uKamera, S.K.kamera[0], S.K.kamera[1], S.K.kamera[2]);
    if (sr) { g.uniform2fv(u.uOffPad, sr.off); g.uniform2f(u.uVitrPad, sr.vitr[0], sr.vitr[1]); }
    g.uniform3fv(u.uBarvaDeste, sr ? sr.barva : [1, 1, 1]);
    g.uniform4f(u.uBlesk, bl ? bl.x : 0, bl ? bl.y : 0, bl ? bl.sila : 0, bl ? bl.r : 1);
    g.uniform1f(u.uBleskKanal, bl && bl.kanalPx ? bl.kanal : 0);
    if (bl && bl.kanalPx) g.uniform2fv(u.uBleskBody, bl.kanalPx);
    g.uniform1i(u.uKapekN, S.kapky ? S.kapky.n : 0);
    if (S.kapky && S.kapky.n) g.uniform4fv(u.uKapky, S.kapky.px);
    g.bindVertexArray(k.vao);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    if (doMapy) {                                         // malá textura → přes celý snímek mapy
      g.bindFramebuffer(g.FRAMEBUFFER, predFb);
      g.viewport(predVp[0], predVp[1], predVp[2], predVp[3]);
      g.enable(g.BLEND);
      g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);         // výstup je premultiplikovaný
      g.useProgram(k.kopie.prog);
      g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, k.fboTex); g.uniform1i(k.kopie.uTex, 0);
      g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    }
    g.bindVertexArray(null);
    g.activeTexture(g.TEXTURE0);
  }

  // ---------------------------------------------------------------- režimy: pohyb (do snímku mapy) / klid (plátno)
  let rezim = 'klid';                     // 'pohyb' | 'dojezd' | 'klid'
  let platnoVidet = true, prazdne = true;
  function ukazPlatno(ano) {
    if (ano === platnoVidet) return;
    platnoVidet = ano;
    platno.style.visibility = ano ? '' : 'hidden';
  }
  function vycistiPlatno() {
    if (!gl || prazdne) return;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    prazdne = true;
  }
  /// klid: plátno (KlidovyTakt ~5 Hz a po dojezdu)
  function kresliPlatno(duvod, bezSrazek) {
    const t0 = performance.now();
    if (!kPlatno) return;
    const el = mapa.getContainer();
    const w = Math.max(1, Math.round(el.clientWidth * MERITKO)), h = Math.max(1, Math.round(el.clientHeight * MERITKO));
    if (platno.width !== w) platno.width = w;
    if (platno.height !== h) platno.height = h;
    const S = pripravSnimek(t0, bezSrazek);
    if (!S) { vycistiPlatno(); return; }
    kresliDo(kPlatno, S, false);
    prazdne = false;
    if (srazkyZive || kapkyZive) spustZivou();
    // engine 371: záblesk chce plynulé snímky (~0,8 s) – v klidu po rAF, dokud svítí
    if (S.blesk && !bleskRaf) {
      bleskRaf = requestAnimationFrame(() => { bleskRaf = 0; if (rezim === 'klid' && pripojeno) kresliPlatno('blesk'); });
    }
    const ms = performance.now() - t0;
    stat.snimku++; stat.msSum += ms; stat.msMax = Math.max(stat.msMax, ms);
    if (duvod === 'klid') stat.klid++; else stat.dojezd++;
  }
  // ⭐ engine 371c (T: „Působí to dost sekaně. Není to náročné?“): padající srážky a stékající kapky v klidu ~30 Hz
  // vlastní rAF smyčkou – takt 15 Hz trhal. Měřeno TT: 30 Hz proti 15 Hz +3 % CPU a jen když prší; jinak 5 Hz.
  let zivyRaf = 0, zivyPosl = 0;
  function zivaSmycka(t) {
    if (!(srazkyZive || kapkyZive) || rezim !== 'klid' || !pripojeno || zmrazeno) { zivyRaf = 0; return; }
    zivyRaf = requestAnimationFrame(zivaSmycka);      // ⚠️ naplánovat PŘED kresbou – kresliPlatno volá spustZivou
    if (t - zivyPosl >= 29) { zivyPosl = t; kresliPlatno('srazky'); }
  }
  function spustZivou() {
    if (!zivyRaf && (srazkyZive || kapkyZive) && rezim === 'klid' && pripojeno && !zmrazeno) zivyRaf = requestAnimationFrame(zivaSmycka);
  }
  /// pohyb: přímo do snímku MapLibre (vrstva-špeh nahoře)
  function kresliDoMapy(g) {
    const t0 = performance.now();
    const S = pripravSnimek(t0);
    ukazPlatno(false);                                    // ve stejném snímku jako první mraky v mapě
    if (!S) return;
    if (!kMapa || kMapaGl !== g) {
      try { kMapa = vytvorKreslic(g); kMapaGl = g; } catch (e) { chyba = 'mapa: ' + String(e && e.message || e); kMapa = null; return; }
    }
    kresliDo(kMapa, S, true);
    const ms = performance.now() - t0;
    stat.snimku++; stat.msSum += ms; stat.msMax = Math.max(stat.msMax, ms); stat.pohyb++;
  }

  // ---------------------------------------------------------------- vrstva-špeh (matice snímku, kresba za pohybu)
  const spion = {
    id: ID_KAMERA, type: 'custom', renderingMode: '3d',
    onAdd() {}, onRemove() { kMapa = null; kMapaGl = null; },
    render(g, args) {
      const m = args && args.defaultProjectionData && args.defaultProjectionData.mainMatrix;
      if (m) { if (!M) M = new Float64Array(16); for (let i = 0; i < 16; i++) M[i] = m[i]; mCas = performance.now(); }
      if (rezim === 'pohyb' && pripojeno) { try { kresliDoMapy(g); } catch (e) { chyba = 'pohyb: ' + String(e && e.message || e); } }
    },
  };
  function zajistiSpiona() {
    if (!mapa) return;
    try {
      if (!mapa.getLayer(ID_KAMERA)) { mapa.addLayer(spion); return; }
      // ⛔ musí být ÚPLNĚ NAHOŘE (nad popisky) jako plátno v klidu – jinak by popisky při rozjezdu a zastavení
      // přeskakovaly nad/pod mraky; vrstvy přidané později (popisky, dekorace) ji jinak předběhnou
      const por = mapa.style && mapa.style._order;
      if (por && por.length && por[por.length - 1] !== ID_KAMERA) mapa.moveLayer(ID_KAMERA);
    } catch (e) { /* styl se mění */ }
  }
  function nasadTakt() {
    if (taktNasazen || !window.KlidovyTakt) return;
    taktNasazen = true;
    let tik = 0;
    KlidovyTakt.pridej('atmosfera', (t, klid) => {
      if (!klid || rezim !== 'klid' || !pripojeno) return;
      if (Date.now() - posledniInterakceMs > 5 * 60 * 1000) {                  // 5 min nečinnosti
        if (!zmrazeno) { zmrazeno = true; kresliPlatno('klid', true); }       // engine 371: srážky nezamrznou ve vzduchu
        stat.vynechano++;
        return;
      }
      zmrazeno = false;
      if (srazkyZive || kapkyZive) { spustZivou(); return; }   // engine 371c: srážky a kapky kreslí smyčka ~30 Hz
      tik++;
      if (!blesk && tik % 3 !== 0) return;                // 66 ms × 3 ≈ 5 Hz (mraky se sunou pár px/s)
      kresliPlatno('klid');
    }, 1);
  }
  function pripoj(m) {
    if (vypnutoUrl) return;
    if (!zalozGL()) return;
    if (mapa !== m) {
      mapa = m;
      // hned nad plátnem mapy: pod odlesky, zvířaty, hráčem (stejně jako mraky kreslené do snímku mapy za pohybu)
      const kont = m.getCanvasContainer();
      const mc = m.getCanvas();
      if (mc && mc.parentNode === kont) kont.insertBefore(platno, mc.nextSibling);
      else kont.appendChild(platno);
      m.on('styledata', zajistiSpiona);
      m.on('movestart', () => { posledniInterakceMs = Date.now(); if (pripojeno) rezim = 'pohyb'; });
      m.on('move', () => { posledniPohybMs = Date.now(); posledniInterakceMs = posledniPohybMs; if (pripojeno) rezim = 'pohyb'; });
      m.on('moveend', () => {
        if (!pripojeno) return;
        rezim = 'dojezd';                                 // jeden snímek mapy bez mraků…
        try { mapa.triggerRepaint(); } catch (e) { /* nic */ }
      });
      m.on('render', () => {
        if (!pripojeno || rezim !== 'dojezd') return;
        kresliPlatno('dojezd');                           // …a v témže okamžiku plátno s nimi
        ukazPlatno(true);
        rezim = 'klid';
      });
      m.on('resize', () => { if (pripojeno && rezim === 'klid') kresliPlatno('klid'); });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) posledniInterakceMs = Date.now(); });
      window.addEventListener('touchstart', () => { posledniInterakceMs = Date.now(); }, { passive: true });
    }
    pripojeno = true;
    platno.style.display = '';
    zajistiSpiona();
    nasadTakt();
    rezim = 'dojezd';
    try { mapa.triggerRepaint(); } catch (e) { /* nic */ }
  }
  function zavri() {
    pripojeno = false;
    rezim = 'klid';
    if (platno) platno.style.display = 'none';
    vycistiPlatno();
    try { if (mapa) mapa.triggerRepaint(); } catch (e) { /* nic */ }
  }
  function aktivni() { return pripojeno && !!gl && !vypnutoUrl && !window.__atmosferaVyp; }
  return {
    pripoj, zavri, aktivni,
    kresli: () => { if (rezim === 'klid') kresliPlatno('klid'); else try { mapa.triggerRepaint(); } catch (e) { /* nic */ } },
    stav: () => ({ aktivni: aktivni(), chyba, rezim, matice: !!M, maticeStari: M ? Math.round(performance.now() - mCas) : null,
                   platno: platno ? [platno.width, platno.height] : null, vitrPosun: vitrPosun.map((x) => +x.toFixed(3)),
                   snimku: stat.snimku, msPrumer: stat.snimku ? +(stat.msSum / stat.snimku).toFixed(2) : 0,
                   msMax: +stat.msMax.toFixed(2), klid: stat.klid, pohyb: stat.pohyb, dojezd: stat.dojezd, vynechano: stat.vynechano,
                   lut: lut ? [lut[4], lut[10], lut[16]].map((x) => +x.toFixed(3)) : null,
                   neob: { maska: !!maskaNeob(), nahrano: stat.neobNahrano || 0 },
                   srazky: { maSrazky, zive: srazkyZive, sr: svKes && svKes.sr ? svKes.sr : null, blesk: !!blesk,
                             posledni: posledniBlesk ? { sila: +posledniBlesk.sila.toFixed(2), kanal: +posledniBlesk.kanal.toFixed(2),
                                                         px: posledniBlesk.kanalPx ? Array.from(posledniBlesk.kanalPx).map(Math.round) : null } : null },
                   mlha: { maMlhu, ter: TER ? TER.klic + ' (' + TER.ms + ' ms, v' + TER.verze + ')' : null, ceka: terCeka,
                           chyba: terChyba, vitr: vitrMlha.map((x) => +x.toFixed(3)) } }),
    _kamera: () => kamera(),
    _ter: () => TER && { zD: TER.zD, x0: TER.x0, y0: TER.y0, G: TER.G, h: TER.hStred, dno: TER.dnoStred, ms: TER.ms },
  };
})();
window.Atmosfera = Atmosfera;
