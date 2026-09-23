// Worker KRESBY STÍNŮ DOMŮ A STROMŮ (engine 334). Kreslí do OffscreenCanvas
// kódem ze `stiny-kresba.js` (týž kód je na hlavním vlákně jako záloha)
// a řeže z výsledku rastrové dlaždice pro protokol stiny://.
//
// Zprávy z hlavního vlákna:
//   {typ:'umis'}                                   → {typ:'umis', ok}
//   {typ:'silueta', ik, w, h, px: ArrayBuffer RGBA}  (jednou na obrázek)
//   {typ:'teren', id, G, px: ArrayBuffer RGBA}       (maska kopců G×G)
//   {typ:'kresli', id, zad, rozsah}                → {typ:'nakresleno', id, ms, w, h}
//   {typ:'dlazdice', id, z, x, y, Dmax}            → {typ:'dlazdice', id, bmp: ImageBitmap | null}
//   {typ:'pixely', id}                             → {typ:'pixely', id, w, h, px}   (jen ladění)
// Chyba při zpracování → {typ:'chyba', id, co, msg} (hlavní vlákno přejde na zálohu).
'use strict';
importScripts('stiny-kresba.js' + (self.location.search || ''));

let tmp = null, platno = null, rozsah = null;
const siluety = new Map();          // jméno obrázku → { platno, w, h }
let teren = null;                   // { id, platno }

function nove(D) { return new OffscreenCanvas(D, D); }
function zRgba(px, w, h) {
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
  return c;
}

self.onmessage = (ev) => {
  const m = ev.data || {};
  try {
    if (m.typ === 'kresli') {
      const t0 = performance.now();
      if (!tmp) { tmp = new OffscreenCanvas(64, 64); platno = new OffscreenCanvas(64, 64); }
      const zad = m.zad;
      self.StinyKresba.kresli(tmp, platno, zad, {
        silueta: (ik) => siluety.get(ik) || null,
        teren: (t) => (teren && t && teren.id === t.id) ? teren.platno : null,
      });
      rozsah = m.rozsah;
      self.postMessage({ typ: 'nakresleno', id: m.id, ms: performance.now() - t0, w: platno.width, h: platno.height });
      return;
    }
    if (m.typ === 'dlazdice') {
      const c = self.StinyKresba.vyrez(platno, rozsah, m.z, m.x, m.y, m.Dmax, nove);
      if (!c) { self.postMessage({ typ: 'dlazdice', id: m.id, bmp: null }); return; }
      const bmp = c.transferToImageBitmap();
      self.postMessage({ typ: 'dlazdice', id: m.id, bmp }, [bmp]);
      return;
    }
    if (m.typ === 'silueta') { siluety.set(m.ik, { platno: zRgba(m.px, m.w, m.h), w: m.w, h: m.h }); return; }
    if (m.typ === 'teren') { teren = { id: m.id, platno: zRgba(m.px, m.G, m.G) }; return; }
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
    if (m.typ === 'pixely') {
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
      self.postMessage({ typ: 'pixely', id: m.id, w, h, px }, [px]);
      return;
    }
  } catch (e) {
    self.postMessage({ typ: 'chyba', id: m.id, co: m.typ, msg: String((e && e.message) || e) });
  }
};
