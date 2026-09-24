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

  let mapa = null, platno = null, gl = null;
  let sumData = null, lut = null;
  let M = null, mCas = 0;               // mainMatrix posledního snímku mapy
  let pocVerze = -1, maMraky = false;
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
    return { n, s: s >= 0 ? s : 0, v: v >= 0 ? v : 0, t: TMAVOST[b.druh] || 0 };
  }
  function postavPocasi() {
    if (typeof Pocasi === 'undefined' || !Pocasi.body) return false;
    const body = Pocasi.body();
    const ver = Pocasi.verze ? Pocasi.verze() : 0;
    if (ver === pocVerze && pocPx) return true;
    pocVerze = ver;
    const N = POC.N, px = new Uint8Array(N * N * 4);
    maMraky = false;
    const vr = body.map((b) => ({ lng: b.lng, lat: b.lat, v: vrstvyBodu(b) }));
    const kosLat = Math.cos(50 * Math.PI / 180);
    for (let j = 0; j < N; j++) {
      const lat = POC.n - (j + 0.5) / N * (POC.n - POC.s);
      for (let i = 0; i < N; i++) {
        const lng = POC.w + (i + 0.5) / N * (POC.e - POC.w);
        let sw = 0, n = 0, s = 0, v = 0, t = 0;
        for (const b of vr) {
          const dx = (b.lng - lng) * kosLat, dy = b.lat - lat;
          const w = 1 / (dx * dx + dy * dy + 0.004);
          sw += w; n += w * b.v.n; s += w * b.v.s; v += w * b.v.v; t += w * b.v.t;
        }
        const k = (j * N + i) * 4;
        if (!sw) { px[k] = 255; px[k + 1] = 0; px[k + 2] = 255; px[k + 3] = 255; continue; }
        n /= sw; s /= sw; v /= sw; t /= sw;
        px[k] = n < 0.02 ? 255 : Math.round(prah(n) * 255);
        px[k + 1] = Math.round(Math.max(0, Math.min(1, t)) * 255);
        px[k + 2] = s < 0.05 ? 255 : Math.round(prah(s * 0.9) * 255);
        px[k + 3] = v < 0.08 ? 255 : Math.round(prah(v * 0.7) * 255);
        if (px[k] < 250 || px[k + 2] < 250 || px[k + 3] < 250) maMraky = true;
      }
    }
    pocPx = px;                                          // do textury ji nahraje každý kreslič (plátno i mapa)
    return true;
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
    c = nad(c, zem);
  }
  // --- průlet mrakem
  if (uZavoj > 0.0) c = nad(vec4(vec3(0.93, 0.95, 0.97) * uZavoj, uZavoj), c);
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
                    'uKryti', 'uZavoj', 'uPonuro', 'uPrahZ', 'uOktUtlum', 'uOktNorm', 'uOkt', 'uBlizko', 'uDaleko', 'uPixUhel'];
  let pocPx = null;                       // data mřížky počasí (pro oba kontexty)
  function vytvorKreslic(g) {
    const sh = (typ, zdroj) => {
      const s = g.createShader(typ);
      g.shaderSource(s, zdroj);
      g.compileShader(s);
      if (!g.getShaderParameter(s, g.COMPILE_STATUS)) { const e = g.getShaderInfoLog(s); g.deleteShader(s); throw new Error('shader: ' + e); }
      return s;
    };
    const k = { g, u: {}, pocVerze: -1, texPoc: null, fbo: null, fboTex: null, fw: 0, fh: 0, kopie: null };
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
    return k;
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
    return { Ox, Oy, Cm, lat: c.lat, lng: c.lng, kamera: [kx, ky, kz] };
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
  let vitrPosun = [0, 0], vitrCas = 0;     // km, integrál větru (plynule i při změně větru)
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
  function pripravSnimek(t0) {
    if (!smi()) return null;
    if (!postavPocasi() || !maMraky) return null;          // nikde mrak = nic nekreslit (ani v klidu)
    const K = kamera();
    if (!K) return null;
    vitrKrok(t0);
    if (!svKes || t0 - svKesMs > 1000 || svKesVynut !== window.__vynutSvetlo) {
      svKes = svetlo(); svKesMs = t0; svKesVynut = window.__vynutSvetlo;
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
    if (vid[0] <= 0 && vid[1] <= 0 && vid[2] <= 0 && zavoj <= 0 && sv.stin <= 0.005 && sv.noc) return null;
    const zoom = mapa.getZoom();
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
  function kresliPlatno(duvod) {
    const t0 = performance.now();
    if (!kPlatno) return;
    const el = mapa.getContainer();
    const w = Math.max(1, Math.round(el.clientWidth * MERITKO)), h = Math.max(1, Math.round(el.clientHeight * MERITKO));
    if (platno.width !== w) platno.width = w;
    if (platno.height !== h) platno.height = h;
    const S = pripravSnimek(t0);
    if (!S) { vycistiPlatno(); return; }
    kresliDo(kPlatno, S, false);
    prazdne = false;
    const ms = performance.now() - t0;
    stat.snimku++; stat.msSum += ms; stat.msMax = Math.max(stat.msMax, ms);
    if (duvod === 'klid') stat.klid++; else stat.dojezd++;
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
    KlidovyTakt.pridej('atmosfera', (t, klid) => {
      if (!klid || rezim !== 'klid' || !pripojeno) return;
      if (Date.now() - posledniInterakceMs > 5 * 60 * 1000) { stat.vynechano++; return; }   // 5 min nečinnosti
      kresliPlatno('klid');
    }, 3);                                                // 66 ms × 3 ≈ 5 Hz (mraky se sunou pár px/s)
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
                   lut: lut ? [lut[4], lut[10], lut[16]].map((x) => +x.toFixed(3)) : null }),
    _kamera: () => kamera(),
  };
})();
window.Atmosfera = Atmosfera;
