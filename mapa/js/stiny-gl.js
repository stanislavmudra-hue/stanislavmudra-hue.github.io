// Okolník 3D — STÍNY NA GRAFICKÉ KARTĚ (engine 335).
//
// Běží jen ve workeru kresby (`js/stiny-kresba-worker.js`). Vstupem je totéž
// zadání jako pro StinyKresba (`js/stiny-kresba.js` – 2D plátno, které
// zůstává zálohou), výsledkem týž obraz; liší se jen vyhlazení hran
// (MSAA 4× místo analytického pokrytí 2D plátna).
//
// Proč to jde jednoduše: všechny stíny mají TUTÉŽ barvu, takže skládání
// „source-over“ nezávisí na pořadí (alfa = 1 − Π(1 − aᵢ)) → stromy se kreslí
// po texturách naráz, ne strom po stromu.
// Domy (nekonvexní půdorysy + posunutý půdorys + boční čtyřúhelníky) se
// plní přes STENCIL: vějíře trojúhelníků s INCR/DECR podle orientace
// (nenulové pravidlo; všechny tvary jsou kladně orientované, takže se
// překryvy sčítají a nikdy neruší), pak jeden obdélník přes celé plátno
// se stencil ≠ 0. Půdorysy ven stejně, jen s blendem ZERO / 1 − src.
// Výsledek = textura w2×h2 BEZ krytí; krytí se násobí až při řezání
// dlaždic (2D ho zapéká do plátna – vychází totéž).
'use strict';
(function (G) {
  const C = [42 / 255, 29 / 255, 16 / 255];

  const VS_POS = `#version 300 es
in vec2 aPos;
uniform vec2 uM;
void main() { vec2 p = aPos * uM; gl_Position = vec4(p.x - 1.0, 1.0 - p.y, 0.0, 1.0); }`;
  const FS_BARVA = `#version 300 es
precision highp float;
uniform vec4 uBarva;
out vec4 o;
void main() { o = uBarva; }`;
  const VS_TEX = `#version 300 es
in vec2 aPos;
in vec2 aUV;
uniform vec2 uM;
out vec2 vUV;
void main() { vUV = aUV; vec2 p = aPos * uM; gl_Position = vec4(p.x - 1.0, 1.0 - p.y, 0.0, 1.0); }`;
  // siluety stromů a maska kopců: důležitá je jen alfa textury
  const FS_ALFA = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec3 uC;
in vec2 vUV;
out vec4 o;
void main() { float a = texture(uTex, vUV).a; o = vec4(uC * a, a); }`;
  // řezání dlaždice: textura je premultiplikovaná → × krytí
  const FS_KOPIE = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uK;
in vec2 vUV;
out vec4 o;
void main() { o = texture(uTex, vUV) * uK; }`;

  /// Rostoucí pole float32 (trojúhelníky / vrcholy s UV)
  class Pole {
    constructor(n) { this.a = new Float32Array(n); this.n = 0; }
    misto(k) {
      if (this.n + k <= this.a.length) return;
      const b = new Float32Array(Math.max(this.a.length * 2, this.n + k));
      b.set(this.a.subarray(0, this.n));
      this.a = b;
    }
    tri(x0, y0, x1, y1, x2, y2) {
      this.misto(6);
      const a = this.a; let n = this.n;
      a[n++] = x0; a[n++] = y0; a[n++] = x1; a[n++] = y1; a[n++] = x2; a[n++] = y2;
      this.n = n;
    }
    v(x, y, s, t) {
      this.misto(4);
      const a = this.a; let n = this.n;
      a[n++] = x; a[n++] = y; a[n++] = s; a[n++] = t;
      this.n = n;
    }
  }

  function shader(gl, typ, zdroj) {
    const s = gl.createShader(typ);
    gl.shaderSource(s, zdroj);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
    return s;
  }
  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.bindAttribLocation(p, 1, 'aUV');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(p));
    return p;
  }

  /// Renderer nad OffscreenCanvas (webgl2) nebo null, když WebGL2 nejde.
  function vytvor(canvas) {
    let gl = null;
    try {
      gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false,
                                         stencil: false, preserveDrawingBuffer: false,
                                         powerPreference: 'low-power' });
    } catch (e) { gl = null; }
    if (!gl) return null;
    let ztracen = false;
    if (canvas.addEventListener) {
      canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); ztracen = true; });
    }
    const pBarva = program(gl, VS_POS, FS_BARVA);
    const pAlfa = program(gl, VS_TEX, FS_ALFA);
    const pKopie = program(gl, VS_TEX, FS_KOPIE);
    const u = {
      barvaM: gl.getUniformLocation(pBarva, 'uM'), barva: gl.getUniformLocation(pBarva, 'uBarva'),
      alfaM: gl.getUniformLocation(pAlfa, 'uM'), alfaTex: gl.getUniformLocation(pAlfa, 'uTex'),
      alfaC: gl.getUniformLocation(pAlfa, 'uC'),
      kopieM: gl.getUniformLocation(pKopie, 'uM'), kopieTex: gl.getUniformLocation(pKopie, 'uTex'),
      kopieK: gl.getUniformLocation(pKopie, 'uK'),
    };
    const vboPos = gl.createBuffer(), vboTex = gl.createBuffer();
    const vaoPos = gl.createVertexArray();
    gl.bindVertexArray(vaoPos);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboPos);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    const vaoTex = gl.createVertexArray();
    gl.bindVertexArray(vaoTex);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboTex);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);
    const vzorky = Math.max(1, Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 1));

    let fb = null;                  // { w, h, msaa, res, rbC, rbS, tex }
    const siluety = new Map();      // jméno obrázku → { tex, w, h }
    let teren = null;               // { id, tex }
    let obsah = null;               // { w, h } poslední kresby
    const stin = new Pole(1 << 16), pudorys = new Pole(1 << 15), stromy = new Pole(1 << 14);
    const tex = new Pole(1 << 14), kvadr = new Pole(64), kryt = new Pole(16);
    const rozsahyTex = [];          // { tex, od, n } – siluety po texturách
    let bx = new Float64Array(256), by = new Float64Array(256);

    function textura(px, w, h) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(px));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    function zajistiFb(w, h) {
      if (fb && fb.w === w && fb.h === h) return;
      if (fb) {
        gl.deleteFramebuffer(fb.msaa); gl.deleteFramebuffer(fb.res);
        gl.deleteRenderbuffer(fb.rbC); gl.deleteRenderbuffer(fb.rbS); gl.deleteTexture(fb.tex);
        fb = null;
      }
      const rbC = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rbC);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, vzorky, gl.RGBA8, w, h);
      const rbS = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rbS);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, vzorky, gl.DEPTH24_STENCIL8, w, h);
      const msaa = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, msaa);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rbC);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, rbS);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('fbo msaa');
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const res = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, res);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('fbo res');
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      fb = { w, h, msaa, res, rbC, rbS, tex: t };
    }

    // --- geometrie ------------------------------------------------------------
    function elipsa(p, cx, cy, rx, ry, cu, su, S) {
      const N = Math.max(16, Math.min(64, Math.ceil(Math.max(rx, ry) * S * 2)));
      // ⛔ vepsaný N-úhelník má MENŠÍ plochu než elipsa (10 úhlů = −6,5 %:
      // stíny stromů při oddálení vycházely o 3–5 % světlejší než ve 2D,
      // TT 23. 9.) → poloměry × k, aby plocha seděla
      const k = Math.sqrt((2 * Math.PI) / (N * Math.sin(2 * Math.PI / N)));
      rx *= k; ry *= k;
      let x0 = cx + rx * cu, y0 = cy + rx * su;               // t = 0
      for (let k = 1; k <= N; k++) {
        const t = (k / N) * Math.PI * 2, ct = Math.cos(t), st = Math.sin(t);
        const x = cx + rx * ct * cu - ry * st * su;
        const y = cy + rx * ct * su + ry * st * cu;
        p.tri(cx, cy, x0, y0, x, y);
        x0 = x; y0 = y;
      }
    }
    function pulkruh(p, cx, cy, ax, ay, bx2, by2, M) {    // c + a·cos t + b·sin t, t ∈ ⟨0, π⟩
      let x0 = cx + ax, y0 = cy + ay;
      for (let k = 1; k <= M; k++) {
        const t = (k / M) * Math.PI, ct = Math.cos(t), st = Math.sin(t);
        const x = cx + ax * ct + bx2 * st, y = cy + ay * ct + by2 * st;
        p.tri(cx, cy, x0, y0, x, y);
        x0 = x; y0 = y;
      }
    }
    /// kmen = tah s kulatými konci (obdélník + dva půlkruhy, bez překryvu)
    function kmen(p, x0, y0, x1, y1, hw, S) {
      const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
      if (L < 1e-6) return;
      const ux = dx / L, uy = dy / L, nx = -uy * hw, ny = ux * hw;
      p.tri(x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny);
      p.tri(x0 + nx, y0 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny);
      const M = Math.max(8, Math.min(16, Math.ceil(hw * S * 3)));
      pulkruh(p, x1, y1, nx, ny, ux * hw, uy * hw, M);
      pulkruh(p, x0, y0, -nx, -ny, -ux * hw, -uy * hw, M);
    }
    /// Zadání → trojúhelníky (px plné velikosti): stíny domů, půdorysy,
    /// elipsy + kmeny stromů a siluety (po texturách).
    function sestav(zad, S) {
      stin.n = 0; pudorys.n = 0; stromy.n = 0; tex.n = 0; rozsahyTex.length = 0;
      const sxM = zad.sxM, syM = zad.syM;
      const P = zad.prstence, xy = P.xy, zac = P.zac, Ls = P.L;
      for (let q = 0; q < Ls.length; q++) {
        const a0 = zac[q], n = zac[q + 1] - a0;
        if (n < 3) continue;
        let plocha = 0;
        for (let i = 0; i < n; i++) {
          const j = i + 1 < n ? i + 1 : 0;
          plocha += xy[2 * (a0 + i)] * xy[2 * (a0 + j) + 1] - xy[2 * (a0 + j)] * xy[2 * (a0 + i) + 1];
        }
        if (Math.abs(plocha) < 0.05) continue;
        if (n > bx.length) { bx = new Float64Array(n * 2); by = new Float64Array(n * 2); }
        const obr = plocha < 0;                  // = pts.reverse() v 2D
        for (let i = 0; i < n; i++) {
          const k = a0 + (obr ? n - 1 - i : i);
          bx[i] = xy[2 * k]; by[i] = xy[2 * k + 1];
        }
        const sx = Ls[q] * sxM, sy = Ls[q] * syM;
        for (let i = 1; i < n - 1; i++) {
          stin.tri(bx[0], by[0], bx[i], by[i], bx[i + 1], by[i + 1]);
          stin.tri(bx[0] + sx, by[0] + sy, bx[i] + sx, by[i] + sy, bx[i + 1] + sx, by[i + 1] + sy);
          pudorys.tri(bx[0], by[0], bx[i], by[i], bx[i + 1], by[i + 1]);
        }
        for (let i = 0; i < n; i++) {
          const j = i + 1 < n ? i + 1 : 0;
          const ax = bx[i], ay = by[i], cx = bx[j], cy = by[j];
          const kriz = (cx - ax) * sy - (cy - ay) * sx;   // orientace jako půdorys
          if (Math.abs(kriz) < 0.05) continue;
          if (kriz > 0) {                                 // a, c, c+s, a+s
            stin.tri(ax, ay, cx, cy, cx + sx, cy + sy);
            stin.tri(ax, ay, cx + sx, cy + sy, ax + sx, ay + sy);
          } else {                                        // a, a+s, c+s, c
            stin.tri(ax, ay, ax + sx, ay + sy, cx + sx, cy + sy);
            stin.tri(ax, ay, cx + sx, cy + sy, cx, cy);
          }
        }
      }
      const T = zad.stromy, d = T.d, ikS = T.ik, ikony = T.ikony, nT = ikS.length;
      if (!nT) return;
      const tg = zad.tg, smer = zad.smer, pxNaMetr = zad.pxNaMetr;
      const uhel = Math.atan2(syM, sxM), cu = Math.cos(uhel), su = Math.sin(uhel);
      const protazeni = Math.sqrt(1 + tg * tg);
      const dX = Math.sin(smer), dY = -Math.cos(smer), pX = Math.cos(smer), pY = Math.sin(smer);
      const skupiny = new Map();                          // index obrázku → stromy se siluetou
      for (let i = 0; i < nT; i++) {
        const sil = (ikS[i] >= 0 && zad.siluety) ? siluety.get(ikony[ikS[i]]) : null;
        if (sil) {
          let g = skupiny.get(ikS[i]);
          if (!g) { g = []; skupiny.set(ikS[i], g); }
          g.push(i);
          continue;
        }
        const tbx = d[4 * i], tby = d[4 * i + 1], Hm = d[4 * i + 2], rp = d[4 * i + 3];
        const hc = 0.5 * Hm * tg;
        elipsa(stromy, tbx + hc * sxM, tby + hc * syM, rp * protazeni, rp, cu, su, S);
        const konec = hc - 0.36 * Hm * protazeni;
        if (konec > 0.3) {
          kmen(stromy, tbx, tby, tbx + konec * sxM, tby + konec * syM, Math.max(1.5, 0.06 * Hm * pxNaMetr) / 2, S);
        }
      }
      for (const [ki, idx] of skupiny) {
        const sil = siluety.get(ikony[ki]);
        const od = tex.n / 4;
        for (const i of idx) {
          const tbx = d[4 * i], tby = d[4 * i + 1], Hm = d[4 * i + 2];
          const A = (Hm / sil.h) * pxNaMetr;                  // jako setTransform ve 2D (bez S)
          const B = Math.min(A * tg, (zad.maxStinPx || Infinity) / sil.h);   // engine 357: strop délky (dlaždice)
          const ex = tbx - (sil.w / 2) * A * pX + sil.h * B * dX;
          const ey = tby - (sil.w / 2) * A * pY + sil.h * B * dY;
          const ux = A * pX * sil.w, uy = A * pY * sil.w;      // roh (w, 0) − (0, 0)
          const vx = -B * dX * sil.h, vy = -B * dY * sil.h;    // roh (0, h) − (0, 0)
          tex.v(ex, ey, 0, 0); tex.v(ex + ux, ey + uy, 1, 0); tex.v(ex + vx, ey + vy, 0, 1);
          tex.v(ex + ux, ey + uy, 1, 0); tex.v(ex + ux + vx, ey + uy + vy, 1, 1); tex.v(ex + vx, ey + vy, 0, 1);
        }
        rozsahyTex.push({ tex: sil.tex, od, n: idx.length * 6 });
      }
    }

    // --- kreslení ---------------------------------------------------------------
    function nahraj(vbo, p) {
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, p.a.subarray(0, p.n), gl.DYNAMIC_DRAW);
    }
    function barvou(p, M, r, g, b, a) {
      if (!p.n) return;
      gl.useProgram(pBarva);
      gl.uniform2f(u.barvaM, M[0], M[1]);
      gl.uniform4f(u.barva, r, g, b, a);
      nahraj(vboPos, p);
      gl.bindVertexArray(vaoPos);
      gl.drawArrays(gl.TRIANGLES, 0, p.n / 2);
    }
    function texturou(t, od, n, M) {
      gl.useProgram(pAlfa);
      gl.uniform2f(u.alfaM, M[0], M[1]);
      gl.uniform3f(u.alfaC, C[0], C[1], C[2]);
      gl.uniform1i(u.alfaTex, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.bindVertexArray(vaoTex);
      gl.drawArrays(gl.TRIANGLES, od, n);
    }
    /// Nenulové plnění přes stencil: tvary do stencilu (INCR vpředu, DECR
    /// vzadu), pak obdélník přes vše, kde stencil ≠ 0 (a stencil zpět na 0).
    function stencilem(p, M, r, g, b, a) {
      if (!p.n) return;
      gl.enable(gl.STENCIL_TEST);
      gl.stencilMask(0xff);
      gl.colorMask(false, false, false, false);
      gl.stencilFunc(gl.ALWAYS, 0, 0xff);
      gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
      gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP);
      barvou(p, M, 0, 0, 0, 0);
      gl.colorMask(true, true, true, true);
      gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
      gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
      barvou(kryt, M, r, g, b, a);
      gl.disable(gl.STENCIL_TEST);
    }

    // ⭐ engine 341: maska měkkého okraje plátna (vnějších 12 %, smoothstep) – totéž
    // jako StinyKresba (2D); násobí se výsledek (blend ZERO, SRC_ALPHA)
    let texOkraj = null;
    function zajistiOkraj() {
      if (texOkraj) return texOkraj;
      const N = 64, px = new Uint8Array(N * N * 4);
      const f = (q) => { const d = Math.min(q, 1 - q) / 0.12; return d >= 1 ? 1 : (d <= 0 ? 0 : d * d * (3 - 2 * d)); };
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) px[(j * N + i) * 4 + 3] = Math.round(255 * f((i + 0.5) / N) * f((j + 0.5) / N));
      texOkraj = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texOkraj);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return texOkraj;
    }

    function kresli(zad) {
      if (ztracen || gl.isContextLost()) throw new Error('kontext ztracen');
      const F = zad.F, S = 1 / F, w2 = zad.w2, h2 = zad.h2;
      zajistiFb(w2, h2);
      sestav(zad, S);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb.msaa);
      gl.viewport(0, 0, w2, h2);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.STENCIL_TEST);
      gl.colorMask(true, true, true, true);
      gl.stencilMask(0xff);
      gl.clearColor(0, 0, 0, 0); gl.clearStencil(0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);                 // source-over (premultipl.)
      const M = [2 * S / w2, 2 * S / h2];
      const Wp = w2 * F, Hp = h2 * F;
      kryt.n = 0;
      kryt.tri(-4, -4, Wp + 4, -4, -4, Hp + 4);
      kryt.tri(Wp + 4, -4, Wp + 4, Hp + 4, -4, Hp + 4);
      // 1) stíny kopců (maska G×G) pod vším
      const t = zad.teren;
      if (t && teren && teren.id === t.id) {
        kvadr.n = 0;
        kvadr.v(t.dx, t.dy, 0, 0); kvadr.v(t.dx + t.dw, t.dy, 1, 0); kvadr.v(t.dx, t.dy + t.dh, 0, 1);
        kvadr.v(t.dx + t.dw, t.dy, 1, 0); kvadr.v(t.dx + t.dw, t.dy + t.dh, 1, 1); kvadr.v(t.dx, t.dy + t.dh, 0, 1);
        nahraj(vboTex, kvadr);
        texturou(teren.tex, 0, 6, M);
      }
      // 2) domy (neprůhledně)
      stencilem(stin, M, C[0], C[1], C[2], 1);
      // 3) stromy: siluety po texturách, elipsy a kmeny naráz (alfa 0,8)
      if (tex.n) {
        nahraj(vboTex, tex);
        for (const r of rozsahyTex) texturou(r.tex, r.od, r.n, M);
      }
      barvou(stromy, M, C[0] * 0.8, C[1] * 0.8, C[2] * 0.8, 0.8);
      // 4) půdorysy ven (stín neleží na střeše)
      gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
      stencilem(pudorys, M, 0, 0, 0, 1);
      // 4b) engine 341: měkký okraj plátna (výsledek × maska); engine 357: dlaždice stínů ho nemají
      if (!zad.bezOkraje) {
        gl.blendFunc(gl.ZERO, gl.SRC_ALPHA);
        kvadr.n = 0;
        kvadr.v(0, 0, 0, 0); kvadr.v(Wp, 0, 1, 0); kvadr.v(0, Hp, 0, 1);
        kvadr.v(Wp, 0, 1, 0); kvadr.v(Wp, Hp, 1, 1); kvadr.v(0, Hp, 0, 1);
        nahraj(vboTex, kvadr);
        texturou(zajistiOkraj(), 0, 6, M);
      }
      // 5) MSAA → textura
      gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb.msaa);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb.res);
      gl.blitFramebuffer(0, 0, w2, h2, 0, 0, w2, h2, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      obsah = { w: w2, h: h2 };
      return { trojuhelniku: (stin.n + pudorys.n + stromy.n) / 6 + tex.n / 12, vzorky };
    }

    /// Dlaždice z/x/y (ImageBitmap) nebo null; stejný výřez jako StinyKresba.
    function dlazdice(r, z, x, y, Dmax, kryti) {
      if (!obsah || !fb) return null;
      if (ztracen || gl.isContextLost()) throw new Error('kontext ztracen');
      const o = G.StinyKresba.obdelnik(obsah.w, obsah.h, r, z, x, y, Dmax);
      if (!o) return null;
      const D = o.D;
      if (canvas.width !== D || canvas.height !== D) { canvas.width = D; canvas.height = D; }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, D, D);
      gl.disable(gl.BLEND); gl.disable(gl.STENCIL_TEST);
      gl.colorMask(true, true, true, true);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      // textura má řádek 0 plátna NAHOŘE (kresba s převráceným y)
      const u0 = o.sx / obsah.w, u1 = (o.sx + o.sw) / obsah.w;
      const v0 = 1 - o.sy / obsah.h, v1 = 1 - (o.sy + o.sh) / obsah.h;
      kvadr.n = 0;
      kvadr.v(o.dx, o.dy, u0, v0); kvadr.v(o.dx + o.dw, o.dy, u1, v0); kvadr.v(o.dx, o.dy + o.dh, u0, v1);
      kvadr.v(o.dx + o.dw, o.dy, u1, v0); kvadr.v(o.dx + o.dw, o.dy + o.dh, u1, v1); kvadr.v(o.dx, o.dy + o.dh, u0, v1);
      nahraj(vboTex, kvadr);
      gl.useProgram(pKopie);
      gl.uniform2f(u.kopieM, 2 / D, 2 / D);
      gl.uniform1f(u.kopieK, kryti);
      gl.uniform1i(u.kopieTex, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fb.tex);
      gl.bindVertexArray(vaoTex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return canvas.transferToImageBitmap();
    }

    /// Ladění: pixely výsledku jako getImageData 2D plátna (krytí zapečené).
    function pixely(kryti) {
      if (!obsah || !fb) return null;
      const w = obsah.w, h = obsah.h;
      const buf = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb.res);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const out = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        const src = (h - 1 - y) * w * 4, dst = y * w * 4;
        for (let i = 0; i < w * 4; i += 4) {
          const a = Math.round(buf[src + i + 3] * kryti);
          if (!a) continue;
          out[dst + i] = 42; out[dst + i + 1] = 29; out[dst + i + 2] = 16; out[dst + i + 3] = a;
        }
      }
      return { w, h, px: out.buffer };
    }

    function silueta(ik, px, w, h) {
      if (siluety.has(ik)) return;
      siluety.set(ik, { tex: textura(px, w, h), w, h });
    }
    function nastavTeren(id, px, Gs) {
      if (teren && teren.id === id) return;
      if (teren) gl.deleteTexture(teren.tex);
      teren = { id, tex: textura(px, Gs, Gs) };
    }
    /// Ladění: simulace ztráty kontextu (WEBGL_lose_context)
    function ladeniZtrat() {
      const e = gl.getExtension('WEBGL_lose_context');
      if (e) e.loseContext();
      return !!e;
    }
    return { kresli, dlazdice, pixely, silueta, teren: nastavTeren, vzorky, ladeniZtrat,
             ztracen: () => ztracen || gl.isContextLost() };
  }

  G.StinyGL = { vytvor };
})(typeof self !== 'undefined' ? self : this);
