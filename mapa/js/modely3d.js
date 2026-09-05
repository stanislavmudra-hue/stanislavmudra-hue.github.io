'use strict';
/* ── 3D MODELY NA MAPĚ (28. 8. 2026) ─────────────────────────────
   Splaty z ComfyUI (TripoSplat) převedené na mesh + texturu
   (tools/spz_do_enginu.py) a usazené na terén jako custom vrstva.
   Konfigurace: assets/modely/modely.json — `modely` (geometrie)
   a `umisteni` [{model, lat, lon, vyskaM, otoceni}].

   ⚠️ Žádné mapa.project() zaběhu (s terénem 170× dráž — viz memory);
   výřez se hlídá přes getBounds(). Výška terénu se čte jen na `idle`
   a keší per umístění. */
(function () {
  var konfigurace = null;      // modely.json (fetch jednou)
  var bufery = {};             // jmeno -> {pozice, uv, indexy, obrazek}
  var GL = null;               // zdroje aktuálního kontextu
  var beziNacitani = false;

  function vyskaTerenu(lon, lat) {
    // ⚠️ getElevationForLngLatZoom vrací výšku VČETNĚ exaggeration
    // (změřeno u Karlštejna: 410,8 = 293×1,4) — NENÁSOBIT znovu,
    // model by levitoval.
    try {
      var t = mapa.terrain;
      if (t && t.getElevationForLngLatZoom) {
        var v = t.getElevationForLngLatZoom(
          new maplibregl.LngLat(lon, lat),
          Math.min(14, Math.max(8, Math.floor(mapa.getZoom()))));
        if (v !== null && v !== undefined && isFinite(v)) return v;
      }
    } catch (e) { }
    return 0;
  }

  function nactiKonfiguraci() {
    if (beziNacitani || konfigurace) return;
    beziNacitani = true;
    fetch('assets/modely/modely.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        beziNacitani = false;
        if (!d || !d.umisteni || !d.umisteni.length) return;
        konfigurace = d;
        var jmena = {};
        d.umisteni.forEach(function (u) { jmena[u.model] = 1; });
        Object.keys(jmena).forEach(function (jm) {
          var m = d.modely[jm];
          if (!m) return;
          var otisk = '?v=' + (m.v
            || (m.vrcholu + 'x' + m.trojuhelniku));
          Promise.all([
            fetch('assets/modely/' + m.bin + otisk)
              .then(function (r) { return r.arrayBuffer(); }),
            fetch('assets/modely/' + m.textura + otisk)
              .then(function (r) { return r.blob(); })
              .then(function (b) { return createImageBitmap(b); }),
          ]).then(function (vys) {
            var ab = vys[0];
            var nv = m.vrcholu;
            // ⛔ rozjetá keš: nesedí-li velikost, nekreslit
            if (ab.byteLength !== nv * 20 + m.trojuhelniku * 12) {
              console.warn('[modely3d]', jm, 'velikost nesedi');
              return;
            }
            bufery[jm] = {
              pozice: new Float32Array(ab, 0, nv * 3),
              uv: new Float32Array(ab, nv * 12, nv * 2),
              indexy: new Uint32Array(ab, nv * 20),
              obrazek: vys[1],
            };
            try { mapa.triggerRepaint(); } catch (e) { }
          }).catch(function (e) {
            console.warn('[modely3d] model se nenačetl:', jm, e);
          });
        });
        try { mapa.triggerRepaint(); } catch (e) { }
      })
      .catch(function () { beziNacitani = false; });
  }

  var VS = 'attribute vec3 aPoz;attribute vec2 aUV;'
    + 'uniform mat4 uMatice;varying vec2 vUV;'
    + 'void main(){vUV=aUV;gl_Position=uMatice*vec4(aPoz,1.0);}';
  var FS = 'precision mediump float;varying vec2 vUV;'
    + 'uniform sampler2D uTex;'
    + 'void main(){gl_FragColor=vec4(texture2D(uTex,vUV).rgb,1.0);}';

  function program(gl) {
    function shader(typ, zdroj) {
      var s = gl.createShader(typ);
      gl.shaderSource(s, zdroj);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn('[modely3d] shader:', gl.getShaderInfoLog(s));
      }
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    return p;
  }

  function zajistiZdroje(gl) {
    if (GL && GL.gl === gl) return GL;
    GL = { gl: gl, prg: program(gl), modely: {} };
    GL.aPoz = gl.getAttribLocation(GL.prg, 'aPoz');
    GL.aUV = gl.getAttribLocation(GL.prg, 'aUV');
    GL.uMatice = gl.getUniformLocation(GL.prg, 'uMatice');
    GL.uTex = gl.getUniformLocation(GL.prg, 'uTex');
    return GL;
  }

  function modelGl(gl, jm) {
    var z = zajistiZdroje(gl);
    if (z.modely[jm]) return z.modely[jm];
    var b = bufery[jm];
    if (!b) return null;
    var vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER,
      b.pozice.byteLength + b.uv.byteLength, gl.STATIC_DRAW);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.pozice);
    gl.bufferSubData(gl.ARRAY_BUFFER, b.pozice.byteLength, b.uv);
    var ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, b.indexy, gl.STATIC_DRAW);
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA,
      gl.UNSIGNED_BYTE, b.obrazek);
    // ⛔ BEZ MIPMAP se jemna textura na dalku vzorkuje ridce =
    // konfety (změřeno 28. 8. na hradu s okny)
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
      gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,
      gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,
      gl.CLAMP_TO_EDGE);
    z.modely[jm] = { vbo: vbo, ibo: ibo, tex: tex,
      n: b.indexy.length, uvPosun: b.pozice.byteLength };
    return z.modely[jm];
  }

  function krat(a, b) {   // c = a × b (column-major mat4)
    var c = new Float32Array(16);
    for (var i = 0; i < 4; i++) {
      for (var j = 0; j < 4; j++) {
        c[j * 4 + i] = a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1]
          + a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
      }
    }
    return c;
  }

  function maticeUmisteni(u) {
    // překlad model (x, y=nahoru, z) → mercator (x=vých., y=jih,
    // z=výška); otočení kolem svislé osy
    if (u._elev === undefined) u._elev = vyskaTerenu(u.lon, u.lat);
    var kotva = maplibregl.MercatorCoordinate.fromLngLat(
      { lng: u.lon, lat: u.lat }, u._elev);
    var s = kotva.meterInMercatorCoordinateUnits()
      * (u.vyskaM || 30);
    var a = (u.otoceni || 0) * Math.PI / 180;
    var ca = Math.cos(a), sa = Math.sin(a);
    var m = new Float32Array(16);
    m[0] = s * ca; m[1] = -s * sa; m[2] = 0; m[3] = 0;
    m[4] = 0; m[5] = 0; m[6] = s; m[7] = 0;
    m[8] = s * sa; m[9] = s * ca; m[10] = 0; m[11] = 0;
    m[12] = kotva.x; m[13] = kotva.y; m[14] = kotva.z; m[15] = 1;
    return m;
  }

  function vrstva() {
    return {
      id: 'modely3d', type: 'custom', renderingMode: '3d',
      onAdd: function (m, gl) {
        GL = null;              // nový kontext/styl → nové GL zdroje
        nactiKonfiguraci();
      },
      render: function (gl, args) {
        if (!konfigurace) return;
        var matice = (args && args.defaultProjectionData)
          ? args.defaultProjectionData.mainMatrix : args;
        if (!matice || matice.length !== 16) return;
        if (mapa.getZoom() < 9.5) return;
        var meze = null;
        try { meze = mapa.getBounds(); } catch (e) { }
        var z = zajistiZdroje(gl);
        gl.useProgram(z.prg);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.disable(gl.CULL_FACE);
        for (var i = 0; i < konfigurace.umisteni.length; i++) {
          var u = konfigurace.umisteni[i];
          if (meze && !meze.contains([u.lon, u.lat])) continue;
          var mg = modelGl(gl, u.model);
          if (!mg) continue;
          gl.uniformMatrix4fv(z.uMatice, false,
            krat(matice, maticeUmisteni(u)));
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, mg.tex);
          gl.uniform1i(z.uTex, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, mg.vbo);
          gl.enableVertexAttribArray(z.aPoz);
          gl.vertexAttribPointer(z.aPoz, 3, gl.FLOAT, false, 0, 0);
          gl.enableVertexAttribArray(z.aUV);
          gl.vertexAttribPointer(z.aUV, 2, gl.FLOAT, false, 0,
            mg.uvPosun);
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mg.ibo);
          gl.drawElements(gl.TRIANGLES, mg.n, gl.UNSIGNED_INT, 0);
        }
      },
    };
  }

  window.nasadModely3d = function () {
    if (!window.mapa) return;
    try {
      if (mapa.getLayer('modely3d')) return;
      mapa.addLayer(vrstva());
    } catch (e) {
      console.warn('[modely3d] vrstvu se nepovedlo přidat:', e);
    }
  };

  // výška terénu doteče později než první render — na idle přeměřit
  var pripojenoIdle = false;
  window.nasadModely3dIdle = function () {
    if (pripojenoIdle || !window.mapa) return;
    pripojenoIdle = true;
    mapa.on('idle', function () {
      if (!konfigurace) return;
      var zmena = false;
      konfigurace.umisteni.forEach(function (u) {
        var nova = vyskaTerenu(u.lon, u.lat);
        if (u._elev === undefined || Math.abs(nova - u._elev) > 0.5) {
          u._elev = nova;
          zmena = true;
        }
      });
      if (zmena) { try { mapa.triggerRepaint(); } catch (e) { } }
    });
  };
})();
