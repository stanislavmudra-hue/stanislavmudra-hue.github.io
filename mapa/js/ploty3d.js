// Okolník 3D — PLOTY A ZDI VE 3D (engine 358).
//
// ⭐ T 24. 9. 2026: „Ty ploty jsem myslel, že budou ve 3D.“ Čáry DTM ČR (ploty podle druhu, zdi, zábradlí, svodidla,
// protihlukové stěny) stojí jako skutečné svislé pásy ve 3D – jako domy, NE jako billboardy kresbiček (plot je
// dlouhý vodorovný objekt, musí sedět s 3D domy a zahradami). Úseky vyrábí worker dekorací (dlaždice z15, ořez na
// dlaždici, ≤ 8 m, výška vrcholů z DEM z13 – z téhož, ze kterého MapLibre staví terén; jen odkryté buňky mlhy).
// Tady: každá dlaždice = vlastní buffer instancí (surová data z workeru, žádný přepočet na CPU) + vlastní matice
// (posun na roh dlaždice v double přesnosti) → přidání dlaždice nic dalšího nepřestavuje.
// Vzhled ve fragment shaderu podle druhu: sloupky, pletivo, prkna, pruty, zeď s římsou, živý plot, zábradlí,
// svodidlo (vlnovka), protihluková stěna; vyhlazené hrany (fwidth), pod pixelem průměr. Dva průchody: neprůhledné
// části zapisují hloubku, pletivo a mezery jen průhledně (stromy za pletivem jsou vidět). Pás začíná 0,6 m POD
// terénem (drobné rozdíly DEM × síť terénu nejsou vidět jako mezera), zeslábne pod ~1–3 px výšky a s náběhem zoomu.
'use strict';
const Ploty3D = (() => {
  const ID = 'okolnik-ploty';
  const PRED = 'akvarel-dekorace';
  const DOSAH_M = 3000;
  const OBVOD = 2 * Math.PI * 6371008.8;                            // jako MercatorCoordinate MapLibre
  const C_REF = 40075016.686 * Math.cos(50 * Math.PI / 180);        // = PLOT_C_REF ve workeru (vzor sloupků)
  const NZ = 32768;                                                   // dlaždice z15
  let mapa = null, gl = null, prog = null, vboRoh = null, loc = null, chyba = '';
  const dlazdice = new Map();                                          // 'x/y' → { x, y, d, n, vbo, vao }
  let verzeDat = -1, planCas = null, posledni = 0;
  const stat = { dlazdic: 0, useku: 0, nahrani: 0, kresleno: 0 };

  const VS = `#version 300 es
precision highp float;
uniform mat4 u_matrix;
uniform float u_zNaM;
uniform float u_ex;
uniform float u_cRef;
uniform vec2 u_vyrez;
uniform float u_pr;
uniform vec2 u_kamera;
uniform vec2 u_slunce;
uniform float u_nastup;
in vec2 a_roh;
in vec3 a_a;
in vec3 a_b;
in vec2 a_sk;
out vec2 v_sh;
out float v_kod;
out float v_svetlo;
out float v_alfa;
out float v_H;
float vyskaTypu(float k) {
  if (k < 0.5) return 1.5;      // drátěný
  if (k < 1.5) return 1.3;      // dřevěný
  if (k < 2.5) return 1.6;      // kovový
  if (k < 3.5) return 1.8;      // zděný
  if (k < 4.5) return 1.6;      // živý
  if (k < 5.5) return 1.8;      // zeď
  if (k < 6.5) return 1.0;      // zábradlí
  if (k < 7.5) return 0.75;     // svodidlo
  return 3.5;                   // protihluková stěna
}
void main() {
  float kod = a_sk.y;
  float H = vyskaTypu(kod);
  vec2 xy = mix(a_a.xy, a_b.xy, a_roh.x);
  float e = mix(a_a.z, a_b.z, a_roh.x) * u_ex;
  float dole = u_ex > 0.0 ? -0.6 : 0.0;
  float hm = mix(dole, H, a_roh.y);
  gl_Position = u_matrix * vec4(xy, (e + hm) * u_zNaM, 1.0);
  vec2 d = a_b.xy - a_a.xy;
  float dl = length(d);
  v_sh = vec2(a_sk.x + a_roh.x * dl * u_cRef, hm);
  vec2 n = dl > 0.0 ? vec2(-d.y, d.x) / dl : vec2(0.0, 1.0);
  if (dot(n, u_kamera - xy) < 0.0) n = -n;                  // světlo na straně ke kameře
  v_svetlo = 0.66 + 0.34 * max(0.0, dot(n, u_slunce));
  vec4 ct = u_matrix * vec4(xy, (e + H) * u_zNaM, 1.0);
  vec4 cb = u_matrix * vec4(xy, e * u_zNaM, 1.0);
  float pxH = 0.0;
  if (ct.w > 1e-6 && cb.w > 1e-6) pxH = length((ct.xy / ct.w - cb.xy / cb.w) * 0.5 * u_vyrez) / u_pr;
  v_alfa = u_nastup * clamp((pxH - 1.2) / 2.0, 0.0, 1.0);
  v_kod = kod;
  v_H = H;
}`;
  const FS = `#version 300 es
precision highp float;
in vec2 v_sh;
in float v_kod;
in float v_svetlo;
in float v_alfa;
in float v_H;
uniform float u_noc;
uniform int u_pruchod;
out vec4 barva;
// pruhy šířky w se středy po per (metry) – vyhlazené; pod pixelem průměrné krytí
float pruh(float x, float per, float w) {
  float aa = max(fwidth(x), 1e-5);
  float f = abs(fract(x / per + 0.5) - 0.5) * per;
  float ostre = clamp((w * 0.5 - f) / aa + 0.5, 0.0, 1.0);
  return mix(ostre, w / per, smoothstep(per * 0.2, per * 0.5, aa));
}
float pas(float h, float h0, float h1) {
  float aa = max(fwidth(h), 1e-5);
  float w = h1 - h0;
  float ostre = clamp((h - h0) / aa + 0.5, 0.0, 1.0) * clamp((h1 - h) / aa + 0.5, 0.0, 1.0);
  return mix(ostre, clamp(w / aa, 0.0, 1.0), smoothstep(w, w * 3.0, aa));
}
float sum(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  float s = v_sh.x, h = v_sh.y, H = v_H, k = v_kod;
  vec3 c = vec3(0.0);
  float a = 0.0;
  if (k < 0.5) {                                   // drátěný: sloupky, horní drát, řídké pletivo
    float sl = pruh(s, 2.5, 0.07), dr = pas(h, H - 0.035, H);
    float pev = max(sl, dr);
    float pl = 0.2 * step(0.0, H - 0.04 - h);
    a = pev + (1.0 - pev) * pl;
    c = (pev * vec3(0.30, 0.33, 0.30) + (1.0 - pev) * pl * vec3(0.55, 0.60, 0.53)) / max(a, 1e-4);
  } else if (k < 1.5) {                            // dřevěný: laťky, dvě příčky, sloupky
    float lt = pruh(s + 0.03, 0.125, 0.085) * step(0.05, h), pr = max(pas(h, 0.25, 0.32), pas(h, H - 0.3, H - 0.23));
    float sl = pruh(s, 2.0, 0.1);
    float t = max(sl, pr);
    a = max(lt, t);
    c = mix(vec3(0.63, 0.47, 0.30), vec3(0.45, 0.32, 0.20), t / max(a, 1e-4));
  } else if (k < 2.5) {                            // kovový: pruty, dvě příčky, sloupky
    float pt = pruh(s, 0.125, 0.022), pr = max(pas(h, 0.12, 0.17), pas(h, H - 0.06, H)), sl = pruh(s, 2.5, 0.07);
    a = max(max(pt, pr), sl);
    c = vec3(0.19, 0.20, 0.22);
  } else if (k < 3.5) {                            // zděný: omítka, pilíře, stříška
    float pil = pruh(s, 4.0, 0.35), st = pas(h, H - 0.07, H + 0.01);
    a = 1.0;
    c = mix(mix(vec3(0.74, 0.64, 0.52), vec3(0.66, 0.56, 0.45), pil), vec3(0.52, 0.44, 0.38), st);
  } else if (k < 4.5) {                            // živý plot: listí, nerovný vršek
    vec2 b = floor(vec2(s * 6.0, h * 6.0));
    float kmit = 0.84 + 0.3 * sum(b);
    float vrch = H - 0.14 * sum(vec2(floor(s * 4.0), 7.0));
    a = clamp((vrch - h) / max(fwidth(h), 1e-5) + 0.5, 0.0, 1.0);
    c = vec3(0.29, 0.46, 0.23) * kmit;
  } else if (k < 5.5) {                            // zeď: kámen, spáry řad, římsa
    float sp = pruh(h, 0.28, 0.02), ri = pas(h, H - 0.06, H + 0.01);
    a = 1.0;
    c = mix(vec3(0.62, 0.59, 0.54) * (1.0 - 0.1 * sp), vec3(0.50, 0.47, 0.43), ri);
  } else if (k < 6.5) {                            // zábradlí: madlo, příčka, sloupky
    a = max(max(pas(h, H - 0.05, H), pas(h, 0.45, 0.48)), pruh(s, 1.25, 0.05));
    c = vec3(0.25, 0.24, 0.23);
  } else if (k < 7.5) {                            // svodidlo: vlnovka a sloupky
    float vl = pas(h, 0.45, 0.75), sl = pruh(s, 2.0, 0.1) * step(h, 0.6);
    a = max(vl, sl);
    c = mix(vec3(0.50, 0.52, 0.54), mix(vec3(0.72, 0.74, 0.75), vec3(0.86, 0.87, 0.88), pas(h, 0.57, 0.63)), vl / max(a, 1e-4));
  } else {                                         // protihluková stěna: panely a ocelové sloupy
    float sl = pruh(s, 4.0, 0.14);
    a = 1.0;
    c = mix(vec3(0.44, 0.55, 0.42) * (0.9 + 0.1 * clamp(h / H, 0.0, 1.0)), vec3(0.30, 0.33, 0.35), sl);
  }
  c *= (0.8 + 0.2 * clamp(h / 0.6, 0.0, 1.0)) * v_svetlo * u_noc;
  a *= v_alfa;
  if (u_pruchod == 0) { if (a < 0.6) discard; }
  else if (a >= 0.6 || a < 0.004) discard;
  barva = vec4(c * a, a);
}`;

  function shader(typ, zdroj) {
    const s = gl.createShader(typ);
    gl.shaderSource(s, zdroj);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
    return s;
  }
  function uvolniDlazdici(t) {
    try { if (t.vao) gl.deleteVertexArray(t.vao); if (t.vbo) gl.deleteBuffer(t.vbo); } catch (e) { /* kontext pryč */ }
    t.vao = null; t.vbo = null;
  }
  function nahrajDlazdici(t) {
    if (!t.vbo) t.vbo = gl.createBuffer();
    if (!t.vao) {
      t.vao = gl.createVertexArray();
      gl.bindVertexArray(t.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vboRoh);
      gl.enableVertexAttribArray(loc.a_roh);
      gl.vertexAttribPointer(loc.a_roh, 2, gl.FLOAT, false, 8, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, t.vbo);
      for (const [l, n, o] of [[loc.a_a, 3, 0], [loc.a_b, 3, 12], [loc.a_sk, 2, 24]]) {
        if (l < 0) continue;
        gl.enableVertexAttribArray(l);
        gl.vertexAttribPointer(l, n, gl.FLOAT, false, 32, o);
        gl.vertexAttribDivisor(l, 1);
      }
      gl.bindVertexArray(null);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, t.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, t.d, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    t.n = t.d.length / 8;
    stat.nahrani++;
  }

  const vrstva = {
    id: ID, type: 'custom', renderingMode: '3d',
    onAdd(m, g) {
      gl = g;
      prog = null; verzeDat = -1;
      for (const t of dlazdice.values()) { t.vbo = null; t.vao = null; }
      dlazdice.clear();
      if (typeof WebGL2RenderingContext === 'undefined' || !(g instanceof WebGL2RenderingContext)) { chyba = 'webgl1'; return; }
      try {
        const p = gl.createProgram();
        gl.attachShader(p, shader(gl.VERTEX_SHADER, VS));
        gl.attachShader(p, shader(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
        const U = (n) => gl.getUniformLocation(p, n), A = (n) => gl.getAttribLocation(p, n);
        loc = {
          a_roh: A('a_roh'), a_a: A('a_a'), a_b: A('a_b'), a_sk: A('a_sk'),
          u_matrix: U('u_matrix'), u_zNaM: U('u_zNaM'), u_ex: U('u_ex'), u_cRef: U('u_cRef'), u_vyrez: U('u_vyrez'),
          u_pr: U('u_pr'), u_kamera: U('u_kamera'), u_slunce: U('u_slunce'), u_nastup: U('u_nastup'),
          u_noc: U('u_noc'), u_pruchod: U('u_pruchod'),
        };
        vboRoh = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vboRoh);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        prog = p; chyba = '';
        naplanuj();
      } catch (e) { chyba = String(e && e.message || e); console.warn('[ploty 3D]', e); prog = null; }
    },
    onRemove() {
      for (const t of dlazdice.values()) uvolniDlazdici(t);
      dlazdice.clear();
      try { if (vboRoh) gl.deleteBuffer(vboRoh); if (prog) gl.deleteProgram(prog); } catch (e) { /* kontext pryč */ }
      vboRoh = null; prog = null; verzeDat = -1;
    },
    render(g, args) {
      if (!prog || !dlazdice.size || !mapa) return;
      try { if (window.__nastaveniMapy && window.__nastaveniMapy.objekty3d === false) return; } catch (e) { /* nic */ }
      try { if (mapa.getLayoutProperty(PRED, 'visibility') === 'none') return; } catch (e) { return; }
      const z = mapa.getZoom();
      const dz = typeof window.dohledDz === 'function' ? (+window.dohledDz() || 0) : 0;
      const nastup = Math.max(0, Math.min(1, (z + dz - 15.4) / 0.5));
      if (nastup <= 0) return;
      const M = (args && args.defaultProjectionData && args.defaultProjectionData.mainMatrix) || null;
      if (!M || M.length !== 16) return;
      const c = mapa.getCenter();
      const cx = (c.lng + 180) / 360, sn = Math.sin(c.lat * Math.PI / 180);
      const cy = 0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI);
      let kx = cx, ky = cy;
      try {
        const cl = mapa._camera.transform.getCameraLngLat();
        kx = (cl.lng + 180) / 360;
        const s2 = Math.sin(cl.lat * Math.PI / 180);
        ky = 0.5 - Math.log((1 + s2) / (1 - s2)) / (4 * Math.PI);
      } catch (e) { /* střed */ }
      let ex = 0;
      try { const t = mapa.getTerrain && mapa.getTerrain(); ex = t ? (+t.exaggeration || 1) : 0; } catch (e) { ex = 0; }
      // slunce (azimut stínů) – směr KE slunci v Mercatoru (x východ, y jih)
      let az = 200;
      try { if (typeof stinyDParametry === 'function') az = +stinyDParametry().az || az; } catch (e) { /* výchozí */ }
      const azR = az * Math.PI / 180;
      const noc = typeof krokNoci === 'number' ? krokNoci : 0;
      const W = g.drawingBufferWidth, Hh = g.drawingBufferHeight;
      let pr = 2;
      try { const cw = mapa.getCanvas().clientWidth; if (cw > 0) pr = W / cw; } catch (e) { /* 2 */ }
      const dosahM = DOSAH_M / (OBVOD * Math.cos(c.lat * Math.PI / 180));
      g.useProgram(prog);
      g.disable(g.CULL_FACE);                      // oboustranné pásy (stav po fill-extrusion bývá backCCW)
      g.uniform1f(loc.u_zNaM, 1 / (OBVOD * Math.cos(c.lat * Math.PI / 180)));
      g.uniform1f(loc.u_ex, ex);
      g.uniform1f(loc.u_cRef, C_REF / NZ);
      g.uniform2f(loc.u_vyrez, W, Hh);
      g.uniform1f(loc.u_pr, pr);
      g.uniform2f(loc.u_slunce, Math.sin(azR), -Math.cos(azR));
      g.uniform1f(loc.u_nastup, nastup);
      g.uniform1f(loc.u_noc, noc >= 2 ? 0.45 : (noc === 1 ? 0.75 : 1));
      const Mt = new Float32Array(16);
      const kreslit = [];
      for (const t of dlazdice.values()) {
        if (!t.vao || !t.n) continue;
        const tcx = (t.x + 0.5) / NZ, tcy = (t.y + 0.5) / NZ;
        if (Math.abs(tcx - cx) > dosahM || Math.abs(tcy - cy) > dosahM) continue;
        kreslit.push(t);
      }
      stat.kresleno = kreslit.length;
      for (let pruchod = 0; pruchod < 2; pruchod++) {
        g.uniform1i(loc.u_pruchod, pruchod);
        g.depthMask(pruchod === 0);
        for (const t of kreslit) {
          const ox = t.x / NZ, oy = t.y / NZ;
          for (let i = 0; i < 4; i++) {
            Mt[i] = M[i] / NZ; Mt[4 + i] = M[4 + i] / NZ; Mt[8 + i] = M[8 + i];
            Mt[12 + i] = M[i] * ox + M[4 + i] * oy + M[12 + i];
          }
          g.uniformMatrix4fv(loc.u_matrix, false, Mt);
          g.uniform2f(loc.u_kamera, (kx - ox) * NZ, (ky - oy) * NZ);
          g.bindVertexArray(t.vao);
          g.drawArraysInstanced(g.TRIANGLES, 0, 6, t.n);
        }
      }
      g.bindVertexArray(null);
      g.depthMask(true);
    },
  };

  /// dlaždice z evidence dekorací ↔ buffery na GPU (nové/změněné nahrát, zmizelé uvolnit)
  function sync() {
    if (!mapa || !prog || !gl || typeof Dekorace === 'undefined' || !Dekorace.ploty) return;
    const ev = Dekorace.ploty();
    if (!ev) {
      if (dlazdice.size) { for (const t of dlazdice.values()) uvolniDlazdici(t); dlazdice.clear(); mapa.triggerRepaint(); }
      verzeDat = -1;
      return;
    }
    if (ev.verze === verzeDat) return;
    verzeDat = ev.verze;
    const ted = new Set();
    for (const q of ev.dlazdice) {
      const k = q.x + '/' + q.y;
      ted.add(k);
      let t = dlazdice.get(k);
      if (t && t.d === q.d) continue;
      if (!t) { t = { x: q.x, y: q.y, d: null, n: 0, vbo: null, vao: null }; dlazdice.set(k, t); }
      t.d = q.d;
      try { nahrajDlazdici(t); } catch (e) { console.warn('[ploty 3D] nahrání', e); }
    }
    for (const [k, t] of dlazdice) if (!ted.has(k)) { uvolniDlazdici(t); dlazdice.delete(k); }
    let n = 0;
    for (const t of dlazdice.values()) n += t.n;
    stat.dlazdic = dlazdice.size; stat.useku = n;
    mapa.triggerRepaint();
  }
  function naplanuj() {
    if (planCas) return;
    const za = Math.max(0, 250 - (performance.now() - posledni));
    planCas = setTimeout(() => {
      planCas = null;
      posledni = performance.now();
      try { sync(); } catch (e) { console.warn('[ploty 3D] sync', e); }
    }, za);
  }
  function zajisti() {
    if (!mapa || mapa.getLayer(ID) || !mapa.getLayer(PRED)) return;   // jen herní styl s dekoracemi
    try { mapa.addLayer(vrstva, PRED); } catch (e) { console.warn('[ploty 3D] vrstva', e); }
  }
  function pripoj(m) {
    if (mapa === m) { zajisti(); return; }
    mapa = m;
    m.on('styledata', zajisti);
    m.on('idle', () => { zajisti(); naplanuj(); });
    m.on('sourcedata', (e) => { if (e && e.tile && e.sourceId === 'dekorace') naplanuj(); });
    zajisti();
  }
  return {
    pripoj, sync,
    stav: () => Object.assign({}, stat, { vrstva: !!(mapa && mapa.getLayer(ID)), chyba, verzeDat }),
  };
})();
window.Ploty3D = Ploty3D;
