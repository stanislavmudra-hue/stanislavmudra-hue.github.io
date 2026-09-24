// Okolník 3D — DRÁTY ELEKTRICKÉHO VEDENÍ (engine 357).
//
// ⭐ T 24. 9. 2026: „šlo by dodělat i elektrické dráty, stožáry a podobně?“ → „udělej … i to vedení a stožáry“.
// Podpěry (stožáry, sloupy, podpěry lanovek) kreslí worker dekorací jako kresbičky ve skutečné výšce; vodiče mezi
// nimi kreslí tahle vlastní vrstva MapLibre (custom, WebGL2, instance = úsek drátu):
//   · rozpětí z evidence dlaždic dekorací (Dekorace.vedeni(): [a,b,c,d,ha,hb,t]…, jen odkrytá mlhou),
//   · úchyty podle kresbiček podpěr (window.__vedeniVodice: [výška nad kotvou, posun vpravo] v podílech výšky),
//   · ⭐ GEOMETRIE BILLBOARDU: kresbičky stojí na obrazovce vzpřímeně (výška = metry × měřítko kresby v místě,
//     bez zkrácení náklonem) – skutečné 3D úchyty by visely o 1 − sin(náklon) níž než konzoly na kresbě. Každý bod
//     drátu je proto „vrchol neviditelné kresbičky“: pata na spojnici pat podpěr, posun na obrazovce vzhůru
//     (výška − průvěs) a vpravo (posun napříč) × měřítko kresby v tom místě (jako icon-size s plnou perspektivou,
//     záplata OKOLNIK_PERSPEKTIVA) → dráty sedí na izolátorech při každém náklonu, otočení i zoomu,
//   · hloubka ze skutečného 3D bodu (dráty schová kopec i dům), tloušťka v CSS px (stejná při 1,5× i 2× rozlišení
//     – žádná změna po puštění prstu), vyhlazené okraje,
//   · zeslábnutí podle ZDÁNLIVÉ velikosti podpěry (pod ~8 → 4 px zmizí, jako drobnosti) a náběhu zoomu třídy.
// Souřadnice RELATIVNĚ k počátku (střed při sestavení) – Mercator ve float32 má u z18 krok ~1 m.
'use strict';
const Vedeni3D = (() => {
  const ID = 'okolnik-draty';
  const PRED = 'akvarel-dekorace';          // pod kresbičkami: stromy před drátem ho zakryjí, za ním ne (hloubka)
  // třídy t: 0 NN, 1 VN, 2 110 kV, 3 220 kV, 4 400 kV, 5 lanovka/vlek
  const PRUVES = [0.015, 0.02, 0.025, 0.027, 0.03, 0.008];     // průvěs jako podíl rozpětí
  // TT 24. 9. (z16,3, náklon 42°): 110 kV + VN přes celý výřez s šířkou 1,1 px a krytím 0,7 byly „dálnice“ drátů –
  // skutečné vodiče jsou z výšky sotva vidět → tenčí a světlejší
  const SIRKA = [0.6, 0.65, 0.75, 0.8, 0.85, 0.9];            // CSS px
  const ALFA = [0.45, 0.5, 0.55, 0.58, 0.6, 0.65];
  const H_TYP = [8.5, 11, 28, 38, 45, 9];                      // typická výška podpěry (m) – zeslábnutí
  const DOSAH = [3000, 4000, 10000, 13000, 15000, 4000];       // m od středu (víc evidence stejně nebývá)
  const MAX_USEKU = 60000;
  const DELTA = 1e-7;                                          // krok Mercatoru pro měřítko (~2,6 m)
  // px kresby na metr = px Mercatoru × 0,19686·2^(−13,25)/512 (icon-size dekorací: k·0,046·2^(z−13,25), @2)
  const K_KRESBY = 0.19686 / Math.pow(2, 13.25) / 512;
  // ⛔ výška v Mercatoru jako MapLibre (MercatorCoordinate): obvod ze STŘEDNÍHO poloměru 6 371 008,8 m, ne rovníkový
  // 40 075 016,686 – s rovníkovým byla výška o 0,11 % jiná (v 1 060 m n. m. o 1,2 m = dráty 7 px pod izolátory)
  const OBVOD = 2 * Math.PI * 6371008.8;
  let mapa = null, gl = null, prog = null, vao = null, vboRoh = null, vboInst = null, nInst = 0;
  let loc = null, chyba = '';
  let origin = [0.5, 0.5], sestavenoSig = '', sestavenoStred = null, terenZmena = 0;
  // ⭐ keš výšek podpěr: queryTerrainElevation stojí ~50 µs (desktop), na TT násobky – nová data při posunu
  // se dotazují jen na NOVÉ podpěry; po dojetí dlaždic DEM se keš obnoví až v klidu (idle), ne při každé dlaždici
  const vyskyKes = new Map();
  let vyskyTeren = -1, vyskyEx = null;
  let planCas = null, posledni = 0;
  const stat = { rozpeti: 0, useku: 0, ms: 0, sestaveni: 0 };

  const VS = `
precision highp float;
uniform mat4 u_matrix;
uniform vec2 u_vyrez;
uniform vec2 u_prava;
uniform float u_zNaM;
uniform float u_kMer;
uniform float u_pr;
uniform float u_sirka[6];
uniform float u_alfa[6];
uniform float u_hTyp[6];
attribute vec2 a_roh;
attribute vec3 a_gp;
attribute vec2 a_np;
attribute vec3 a_gq;
attribute vec2 a_nq;
attribute float a_t;
varying float v_alfa;
varying float v_d;
varying float v_pol;
vec3 obr(vec3 g, vec2 nad, out float m, out float ok) {
  vec4 c0 = u_matrix * vec4(g, 1.0);
  vec4 c1 = u_matrix * vec4(g.xy + u_prava, g.z, 1.0);
  vec4 c2 = u_matrix * vec4(g.xy, g.z + nad.y * u_zNaM, 1.0);
  ok = (c0.w > 1e-6 && c1.w > 1e-6 && c2.w > 1e-6) ? 1.0 : 0.0;
  vec2 s0 = c0.xy / c0.w * 0.5 * u_vyrez;
  vec2 s1 = c1.xy / c1.w * 0.5 * u_vyrez;
  m = length(s1 - s0) * u_kMer;
  return vec3(s0 + nad * m, c2.z / c2.w);
}
void main() {
  int ti = int(a_t + 0.5);
  float mP; float okP; float mQ; float okQ;
  vec3 P = obr(a_gp, a_np, mP, okP);
  vec3 Q = obr(a_gq, a_nq, mQ, okQ);
  if (okP * okQ < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); v_alfa = 0.0; v_d = 0.0; v_pol = 1.0; return; }
  vec2 dir = Q.xy - P.xy;
  float dl = length(dir);
  vec2 n = dl > 1e-3 ? vec2(-dir.y, dir.x) / dl : vec2(0.0, 1.0);
  bool konec = a_roh.x > 0.5;
  vec3 X = konec ? Q : P;
  float m = konec ? mQ : mP;
  float sirka = u_sirka[ti] * u_pr;
  float w = max(sirka, 1.0);
  float pxVysky = u_hTyp[ti] * m / u_pr;
  float al = u_alfa[ti] * clamp((pxVysky - 4.0) / 4.0, 0.0, 1.0) * (sirka / w);
  float pol = 0.5 * w + 1.0;
  vec2 s = X.xy + n * a_roh.y * pol;
  gl_Position = vec4(s / (0.5 * u_vyrez), X.z, 1.0);
  v_alfa = al;
  v_d = a_roh.y * pol;
  v_pol = 0.5 * w;
}`;
  const FS = `
precision mediump float;
uniform vec3 u_barva;
varying float v_alfa;
varying float v_d;
varying float v_pol;
void main() {
  float a = v_alfa * clamp(v_pol + 0.5 - abs(v_d), 0.0, 1.0);
  if (a < 0.004) discard;
  gl_FragColor = vec4(u_barva * a, a);
}`;

  function shader(typ, zdroj) {
    const s = gl.createShader(typ);
    gl.shaderSource(s, zdroj);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
    return s;
  }

  const vrstva = {
    id: ID, type: 'custom', renderingMode: '3d',
    onAdd(m, g) {
      gl = g;
      prog = null; nInst = 0; sestavenoSig = '';
      if (typeof WebGL2RenderingContext === 'undefined' || !(g instanceof WebGL2RenderingContext)) { chyba = 'webgl1'; return; }
      try {
        const p = gl.createProgram();
        gl.attachShader(p, shader(gl.VERTEX_SHADER, VS));
        gl.attachShader(p, shader(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
        const U = (n) => gl.getUniformLocation(p, n), A = (n) => gl.getAttribLocation(p, n);
        loc = {
          a_roh: A('a_roh'), a_gp: A('a_gp'), a_np: A('a_np'), a_gq: A('a_gq'), a_nq: A('a_nq'), a_t: A('a_t'),
          u_matrix: U('u_matrix'), u_vyrez: U('u_vyrez'), u_prava: U('u_prava'), u_zNaM: U('u_zNaM'),
          u_kMer: U('u_kMer'), u_pr: U('u_pr'), u_sirka: U('u_sirka[0]'), u_alfa: U('u_alfa[0]'),
          u_hTyp: U('u_hTyp[0]'), u_barva: U('u_barva'),
        };
        vboRoh = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vboRoh);
        // (konec 0/1, strana ∓1) – dva trojúhelníky úseku
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
        vboInst = gl.createBuffer();
        // vlastní VAO – atributy (a dělitele instancí) nesmí sáhnout na VAO MapLibre
        vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vboRoh);
        gl.enableVertexAttribArray(loc.a_roh);
        gl.vertexAttribPointer(loc.a_roh, 2, gl.FLOAT, false, 8, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, vboInst);
        const atr = [[loc.a_gp, 3, 0], [loc.a_np, 2, 12], [loc.a_gq, 3, 20], [loc.a_nq, 2, 32], [loc.a_t, 1, 40]];
        for (const [l, n, o] of atr) {
          if (l < 0) continue;
          gl.enableVertexAttribArray(l);
          gl.vertexAttribPointer(l, n, gl.FLOAT, false, 44, o);
          gl.vertexAttribDivisor(l, 1);
        }
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        prog = p; chyba = '';
      } catch (e) { chyba = String(e && e.message || e); console.warn('[vedení 3D]', e); prog = null; }
    },
    onRemove() {
      try {
        if (vao) gl.deleteVertexArray(vao);
        if (vboRoh) gl.deleteBuffer(vboRoh);
        if (vboInst) gl.deleteBuffer(vboInst);
        if (prog) gl.deleteProgram(prog);
      } catch (e) { /* kontext pryč */ }
      vao = null; vboRoh = null; vboInst = null; prog = null; nInst = 0; sestavenoSig = '';
    },
    render(g, args) {
      if (!prog || !nInst || !mapa) return;
      const z = mapa.getZoom();
      if (z < 12) return;
      try { if (mapa.getLayoutProperty(PRED, 'visibility') === 'none') return; } catch (e) { return; }
      const M = (args && args.defaultProjectionData && args.defaultProjectionData.mainMatrix) || null;
      if (!M || M.length !== 16) return;
      // náběh zoomu třídy jako rampa kresbiček (z0 − dohled, šířka 0,35) × krytí třídy
      const cfg = window.__vedeniCfg && window.__vedeniCfg.tridy;
      const dz = typeof window.dohledDz === 'function' ? (+window.dohledDz() || 0) : 0;
      const alfa = new Float32Array(6);
      let nic = true;
      for (let t = 0; t < 6; t++) {
        const z0 = cfg && cfg[t] ? cfg[t].z0 : 14;
        alfa[t] = ALFA[t] * Math.max(0, Math.min(1, (z + dz - z0) / 0.35));
        if (alfa[t] > 0) nic = false;
      }
      if (nic) return;
      const ox = origin[0], oy = origin[1];
      const Mt = new Float32Array(16);
      for (let i = 0; i < 12; i++) Mt[i] = M[i];
      Mt[12] = M[0] * ox + M[4] * oy + M[12];
      Mt[13] = M[1] * ox + M[5] * oy + M[13];
      Mt[14] = M[2] * ox + M[6] * oy + M[14];
      Mt[15] = M[3] * ox + M[7] * oy + M[15];
      const W = g.drawingBufferWidth, H = g.drawingBufferHeight;
      let pr = 2;
      try { const cw = mapa.getCanvas().clientWidth; if (cw > 0) pr = W / cw; } catch (e) { /* 2 */ }
      const c = mapa.getCenter();
      const br = mapa.getBearing() * Math.PI / 180;
      const noc = typeof krokNoci === 'number' ? krokNoci : 0;
      const b = noc >= 2 ? [0.09, 0.1, 0.14] : (noc === 1 ? [0.16, 0.16, 0.18] : [0.19, 0.19, 0.2]);
      g.useProgram(prog);
      g.uniformMatrix4fv(loc.u_matrix, false, Mt);
      g.uniform2f(loc.u_vyrez, W, H);
      g.uniform2f(loc.u_prava, Math.cos(br) * DELTA, Math.sin(br) * DELTA);   // „vpravo“ obrazovky v Mercatoru (x v., y j.)
      g.uniform1f(loc.u_zNaM, 1 / (OBVOD * Math.cos(c.lat * Math.PI / 180)));
      g.uniform1f(loc.u_kMer, K_KRESBY / DELTA);
      g.uniform1f(loc.u_pr, pr);
      g.uniform1fv(loc.u_sirka, SIRKA);
      g.uniform1fv(loc.u_alfa, alfa);
      g.uniform1fv(loc.u_hTyp, H_TYP);
      g.uniform3f(loc.u_barva, b[0], b[1], b[2]);
      g.bindVertexArray(vao);
      g.drawArraysInstanced(g.TRIANGLES, 0, 6, nInst);
      g.bindVertexArray(null);
    },
  };

  function mercX(lon) { return (lon + 180) / 360; }
  function mercY(lat) { const s = Math.sin(lat * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); }
  function prevyseni() {
    try { const t = mapa.getTerrain && mapa.getTerrain(); return t ? (+t.exaggeration || 1) : 0; } catch (e) { return 0; }
  }
  /// podpis pro přestavbu: převýšení hned, dojeté dlaždice DEM jen v klidu (viz obnovTeren)
  function podpisTerenu() { return prevyseni() + ':' + vyskyTeren; }

  /// Sestaví instance (úseky drátů) z evidence – rozpětí seřazená podle vzdálenosti od středu, strop MAX_USEKU
  function sestav() {
    if (!mapa || !prog || !vboInst || typeof Dekorace === 'undefined' || !Dekorace.vedeni) return;
    const V = window.__vedeniVodice;
    const ev = Dekorace.vedeni();
    const c = mapa.getCenter();
    const sig = (ev ? ev.verze : 'x') + '|' + podpisTerenu();
    if (!ev || !V) {
      nInst = 0; sestavenoSig = sig; sestavenoStred = [c.lng, c.lat];
      return;
    }
    const t0 = performance.now();
    const D = ev.draty;
    const ox = mercX(c.lng), oy = mercY(c.lat);
    const kx = 111320 * Math.cos(c.lat * Math.PI / 180), ky = 110574;
    const kandidati = [];
    for (let i = 0; i + 6 < D.length; i += 7) {
      const t = D[i + 6] | 0;
      if (!V[t]) continue;
      const dx = ((D[i] + D[i + 2]) / 2 - c.lng) * kx, dy = ((D[i + 1] + D[i + 3]) / 2 - c.lat) * ky;
      const d2 = dx * dx + dy * dy;
      if (d2 > DOSAH[t] * DOSAH[t]) continue;
      kandidati.push([d2, i]);
    }
    kandidati.sort((p, q) => p[0] - q[0]);
    const maTeren = !!(mapa.getTerrain && mapa.getTerrain());
    const ex = prevyseni();
    if (ex !== vyskyEx || vyskyKes.size > 30000) { vyskyKes.clear(); vyskyEx = ex; }
    const teren = (lon, lat) => {
      if (!maTeren) return 0;
      const k = Math.round(lon * 1e6) + ',' + Math.round(lat * 1e6);
      let h = vyskyKes.get(k);
      if (h === undefined) {
        h = 0;
        try { const v = mapa.queryTerrainElevation([lon, lat]); h = (typeof v === 'number' && isFinite(v)) ? v : 0; }
        catch (e) { h = 0; }
        vyskyKes.set(k, h);
      }
      return h;
    };
    const out = new Float32Array(MAX_USEKU * 11);
    let o = 0, nU = 0, nR = 0;
    for (const [, i] of kandidati) {
      const a = D[i], b = D[i + 1], cc = D[i + 2], d = D[i + 3], t = D[i + 6] | 0;
      const ha = Math.max(4, Math.min(90, D[i + 4])), hb = Math.max(4, Math.min(90, D[i + 5]));
      const L = Math.hypot((cc - a) * kx, (d - b) * ky);
      if (L < 2 || L > 2500) continue;
      const vod = V[t];
      const nSeg = Math.max(2, Math.min(14, Math.ceil(L / 25)));
      if (nU + vod.length * nSeg > MAX_USEKU) break;
      const eA = teren(a, b), eB = teren(cc, d);
      const xA = mercX(a) - ox, yA = mercY(b) - oy, zA = eA / (OBVOD * Math.cos(b * Math.PI / 180));
      const xB = mercX(cc) - ox, yB = mercY(d) - oy, zB = eB / (OBVOD * Math.cos(d * Math.PI / 180));
      const s = PRUVES[t] * L;
      for (const [hr, lr] of vod) {
        const latA = lr * ha, latB = lr * hb, vA = hr * ha, vB = hr * hb;
        let pX = xA, pY = yA, pZ = zA, pL = latA, pV = vA;
        for (let k = 1; k <= nSeg; k++) {
          const u = k / nSeg;
          const X = xA + (xB - xA) * u, Y = yA + (yB - yA) * u, Z = zA + (zB - zA) * u;
          const Ln = latA + (latB - latA) * u, Vn = vA + (vB - vA) * u - 4 * s * u * (1 - u);
          out[o++] = pX; out[o++] = pY; out[o++] = pZ; out[o++] = pL; out[o++] = pV;
          out[o++] = X; out[o++] = Y; out[o++] = Z; out[o++] = Ln; out[o++] = Vn;
          out[o++] = t;
          pX = X; pY = Y; pZ = Z; pL = Ln; pV = Vn;
          nU++;
        }
      }
      nR++;
    }
    try {
      gl.bindBuffer(gl.ARRAY_BUFFER, vboInst);
      gl.bufferData(gl.ARRAY_BUFFER, out.subarray(0, o), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    } catch (e) { return; }
    origin = [ox, oy];
    nInst = nU;
    sestavenoSig = sig;
    sestavenoStred = [c.lng, c.lat];
    stat.rozpeti = nR; stat.useku = nU; stat.ms = Math.round(performance.now() - t0); stat.sestaveni++;
    mapa.triggerRepaint();
  }
  function potreba() {
    if (!mapa || !prog || typeof Dekorace === 'undefined' || !Dekorace.vedeni) return false;
    const ev = Dekorace.vedeni();
    const sig = (ev ? ev.verze : 'x') + '|' + podpisTerenu();
    if (sig !== sestavenoSig || !sestavenoStred) return true;
    const c = mapa.getCenter();
    const dx = (c.lng - sestavenoStred[0]) * 111320 * Math.cos(c.lat * Math.PI / 180), dy = (c.lat - sestavenoStred[1]) * 110574;
    return dx * dx + dy * dy > 1000 * 1000;
  }
  /// nejvýš jednou za 300 ms – i během pohybu (dráty nových dlaždic nečekají na puštění prstu)
  function naplanuj() {
    if (planCas) return;
    const za = Math.max(0, 300 - (performance.now() - posledni));
    planCas = setTimeout(() => {
      planCas = null;
      posledni = performance.now();
      try { if (potreba()) sestav(); } catch (e) { console.warn('[vedení 3D] sestavení', e); }
    }, za);
  }
  /// v klidu: dojely-li mezitím dlaždice DEM, výšky podpěr znovu (keš pryč) a přestavba
  function obnovTeren() {
    if (vyskyTeren === terenZmena) return;
    vyskyTeren = terenZmena;
    vyskyKes.clear();
    naplanuj();
  }
  function zajisti() {
    if (!mapa || mapa.getLayer(ID) || !mapa.getLayer(PRED)) return;   // jen herní styl s dekoracemi
    try { mapa.addLayer(vrstva, PRED); naplanuj(); } catch (e) { console.warn('[vedení 3D] vrstva', e); }
  }
  function pripoj(m) {
    if (mapa === m) { zajisti(); return; }
    mapa = m;
    m.on('styledata', zajisti);
    m.on('idle', () => { zajisti(); obnovTeren(); naplanuj(); });
    m.on('moveend', naplanuj);
    m.on('sourcedata', (e) => {
      if (!e || !e.tile) return;
      if (e.sourceId === 'dekorace') naplanuj();
      else if (e.source && e.source.type === 'raster-dem') terenZmena++;     // přestavba až v klidu
    });
    zajisti();
  }
  return {
    pripoj, sestav,
    stav: () => Object.assign({}, stat, { vrstva: !!(mapa && mapa.getLayer(ID)), instanci: nInst, chyba,
                                          evidence: (typeof Dekorace !== 'undefined' && Dekorace.vedeni && Dekorace.vedeni())
                                            ? Dekorace.vedeni().draty.length / 7 : null }),
  };
})();
window.Vedeni3D = Vedeni3D;
