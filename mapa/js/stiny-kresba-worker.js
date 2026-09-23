// Worker KRESBY STÍNŮ DOMŮ A STROMŮ (engine 334/335). Kreslí na GRAFICKÉ
// KARTĚ (`stiny-gl.js`, WebGL2 v OffscreenCanvas, engine 335); když WebGL2
// nejde nebo selže, do 2D OffscreenCanvas kódem ze `stiny-kresba.js` (týž
// kód je na hlavním vlákně jako poslední záloha). Z výsledku řeže rastrové
// dlaždice pro protokol stiny://.
//
// Zprávy z hlavního vlákna:
//   {typ:'umis'}                                   → {typ:'umis', ok}
//   {typ:'silueta', ik, w, h, px: ArrayBuffer RGBA}  (jednou na obrázek)
//   {typ:'teren', id, G, px: ArrayBuffer RGBA}       (maska kopců G×G)
//   {typ:'kresli', id, zad, rozsah, gl}            → {typ:'nakresleno', id, ms, w, h, gl, glChyba}
//   {typ:'dlazdice', id, z, x, y, Dmax}            → {typ:'dlazdice', id, bmp: ImageBitmap | null}
//   {typ:'pixely', id}                             → {typ:'pixely', id, w, h, px, gl}   (jen ladění)
// Worker sám posílá {typ:'znovu'}, když obsah na grafické kartě zmizel
// (ztracený kontext) – hlavní vlákno nechá stíny nakreslit znovu.
// Chyba při zpracování → {typ:'chyba', id, co, msg} (hlavní vlákno přejde na zálohu).
'use strict';
const Q = self.location.search || '';
importScripts('stiny-kresba.js' + Q, 'stiny-gl.js' + Q);

let tmp = null, platno = null, rozsah = null;
const siluety = new Map();          // jméno obrázku → { platno, w, h, px }
let teren = null;                   // { id, platno, G, px }
let kryti = 0;                      // krytí poslední kresby (GL ho násobí až v dlaždici)
let obsahGL = false;                // poslední kresba šla přes grafickou kartu
let sgl = null, glStav = 0;         // 0 nezkoušeno, 1 funguje, −1 nejde
let glChyba = '';
let glZtrat = 0;                    // ztracené kontexty (po 3 → natrvalo 2D)

function nove(D) { return new OffscreenCanvas(D, D); }
function zRgba(px, w, h) {
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
  return c;
}
function zajistiGL() {
  if (glStav === 1 && sgl && !sgl.ztracen()) return sgl;
  if (glStav === 1) {
    // kontext ztracen (Android ho může vzít třeba po uspání) → nový; po
    // třetí ztrátě už jen 2D
    sgl = null; glZtrat++;
    if (glZtrat > 3) { glStav = -1; glChyba = 'kontext ztracen ' + glZtrat + '×'; return null; }
    glStav = 0;
  }
  if (glStav === -1) return null;
  glStav = -1;
  try {
    if (!self.StinyGL) return null;
    sgl = self.StinyGL.vytvor(new OffscreenCanvas(64, 64));
  } catch (e) { sgl = null; glChyba = 'vytvor: ' + String((e && e.message) || e); }
  if (!sgl) { if (!glChyba) glChyba = 'webgl2 nejde'; return null; }
  glStav = 1;
  for (const [ik, s] of siluety) sgl.silueta(ik, s.px, s.w, s.h);
  return sgl;
}
/// Grafická karta selhala. Ztracený kontext → příští kresba zkusí nový
/// (zajistiGL); jiná chyba → dál natrvalo 2D. Obsah na ní je každopádně pryč.
function glPryc(proc) {
  glChyba = proc;
  const ztracen = !!(sgl && sgl.ztracen());
  if (!ztracen) { glStav = -1; sgl = null; }
  if (obsahGL) { obsahGL = false; self.postMessage({ typ: 'znovu' }); }
}

self.onmessage = (ev) => {
  const m = ev.data || {};
  try {
    if (m.typ === 'kresli') {
      const t0 = performance.now();
      const zad = m.zad;
      let pouzitoGL = false;
      const g = m.gl ? zajistiGL() : null;
      if (g) {
        try {
          if (g.ztracen()) throw new Error('kontext ztracen');
          if (zad.teren && teren && teren.id === zad.teren.id) g.teren(teren.id, teren.px, teren.G);
          g.kresli(zad);
          pouzitoGL = true;
        } catch (e) { obsahGL = false; glPryc('kresli: ' + String((e && e.message) || e)); }
      }
      if (!pouzitoGL) {
        if (!tmp) { tmp = new OffscreenCanvas(64, 64); platno = new OffscreenCanvas(64, 64); }
        self.StinyKresba.kresli(tmp, platno, zad, {
          silueta: (ik) => siluety.get(ik) || null,
          teren: (t) => (teren && t && teren.id === t.id) ? teren.platno : null,
        });
      }
      obsahGL = pouzitoGL;
      kryti = zad.kryti;
      rozsah = m.rozsah;
      self.postMessage({ typ: 'nakresleno', id: m.id, ms: performance.now() - t0, w: zad.w2, h: zad.h2,
                         gl: pouzitoGL, glChyba: glChyba || null, glZtrat });
      return;
    }
    if (m.typ === 'dlazdice') {
      let bmp = null;
      if (obsahGL) {
        try { bmp = sgl ? sgl.dlazdice(rozsah, m.z, m.x, m.y, m.Dmax, kryti) : null; }
        catch (e) { bmp = null; glPryc('dlaždice: ' + String((e && e.message) || e)); }
      } else {
        const c = self.StinyKresba.vyrez(platno, rozsah, m.z, m.x, m.y, m.Dmax, nove);
        bmp = c ? c.transferToImageBitmap() : null;
      }
      if (bmp) self.postMessage({ typ: 'dlazdice', id: m.id, bmp }, [bmp]);
      else self.postMessage({ typ: 'dlazdice', id: m.id, bmp: null });
      return;
    }
    if (m.typ === 'silueta') {
      siluety.set(m.ik, { platno: zRgba(m.px, m.w, m.h), w: m.w, h: m.h, px: m.px });
      if (sgl) { try { sgl.silueta(m.ik, m.px, m.w, m.h); } catch (e) { glPryc('silueta: ' + String((e && e.message) || e)); } }
      return;
    }
    if (m.typ === 'teren') { teren = { id: m.id, platno: zRgba(m.px, m.G, m.G), G: m.G, px: m.px }; return; }
    if (m.typ === 'umis') {
      let ok = false;
      try {
        const c = new OffscreenCanvas(4, 4);
        const x = c.getContext('2d');
        const p = new Path2D();
        p.moveTo(0, 0); p.lineTo(3, 0); p.lineTo(0, 3); p.closePath();
        x.fill(p, 'nonzero');
        x.ellipse(2, 2, 1, 1, 0, 0, Math.PI * 2);
        const b = c.transferToImageBitmap();
        ok = !!(b && b.width === 4 && self.StinyKresba);
        if (b && b.close) b.close();
      } catch (e) { ok = false; }
      self.postMessage({ typ: 'umis', ok });
      return;
    }
    if (m.typ === 'ladeni-ztrat-gl') {
      self.postMessage({ typ: 'ladeni', id: m.id, ok: sgl ? sgl.ladeniZtrat() : false });
      return;
    }
    if (m.typ === 'pixely') {
      if (obsahGL && sgl) {
        const r = sgl.pixely(kryti);
        const px = r ? r.px : new ArrayBuffer(0);
        self.postMessage({ typ: 'pixely', id: m.id, w: r ? r.w : 0, h: r ? r.h : 0, px, gl: true }, [px]);
        return;
      }
      // čte se z KOPIE – getImageData přímo z `platno` by ho Chrome mohl
      // přepnout do režimu „čte se často“ (pomalejší kresba)
      const w = platno ? platno.width : 0, h = platno ? platno.height : 0;
      let px = new ArrayBuffer(0);
      if (w) {
        const c = new OffscreenCanvas(w, h);
        const x = c.getContext('2d');
        x.drawImage(platno, 0, 0);
        px = x.getImageData(0, 0, w, h).data.buffer;
      }
      self.postMessage({ typ: 'pixely', id: m.id, w, h, px, gl: false }, [px]);
      return;
    }
  } catch (e) {
    self.postMessage({ typ: 'chyba', id: m.id, co: m.typ, msg: String((e && e.message) || e) });
  }
};
