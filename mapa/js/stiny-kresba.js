// Okolník 3D — KRESBA STÍNŮ DOMŮ A STROMŮ (engine 334).
//
// Sdílený kód pro worker (`js/stiny-kresba-worker.js`) i pro hlavní vlákno
// (záloha, když worker nebo OffscreenCanvas chybí). Dřív se tohle kreslilo
// přímo v `prepoctiStinyDomu` v main.js – na telefonu plátno 2D rastruje
// PROCESOR, takže přepočet stínů a řezání dlaždic stály hlavní vlákno
// 30–150 ms (zásek gesta). Hlavní vlákno teď jen posbírá domy a stromy do
// typových polí („zadání“), kreslí worker.
//
// Zadání (souřadnice v px plátna PLNÉ velikosti W×H, kreslí se do 1/F):
//   { W, H, F, w2, h2, kryti, sxM, syM, tg, smer, pxNaMetr, siluety,
//     prstence: { xy: Float32Array [x,y,…], zac: Uint32Array (n+1), L: Float32Array },
//     stromy: { d: Float32Array [bx,by,Hm,rp,…], ik: Int32Array, ikony: [jméno…] },
//     teren: null | { id, dx, dy, dw, dh } }
// Zdroje: { silueta(jméno) → { platno, w, h } | null, teren(teren) → plátno G×G | null }
//
// ⚠️ Kresba je 1:1 převzatá z main.js (engine 333) – vzhled se nesmí změnit.
// Bez DOM: plátna dodá volající (HTMLCanvasElement nebo OffscreenCanvas).
'use strict';
(function (G) {
  const BARVA = '#2A1D10';
  const BARVA_STROMU = 'rgba(42,29,16,0.8)';
  let bx = new Float64Array(256), by = new Float64Array(256);

  // ⭐ engine 341 (výtka T 23. 9.: „po oddálení bliknou stíny“): MĚKKÝ OKRAJ plátna –
  // vnějších 12 % každé strany plynule dozní (smoothstep). Plátno sahá 30 % za pohled,
  // takže je okraj normálně mimo obrazovku; po oddálení nebo rychlém posunu za plátno
  // (než doběhne přepočet) už není vidět ostrá hrana hustých stínů. Týž tvar má maska
  // v stiny-gl.js.
  const OKRAJ = 0.12;
  function okrajF(u) { const d = Math.min(u, 1 - u) / OKRAJ; return d >= 1 ? 1 : (d <= 0 ? 0 : d * d * (3 - 2 * d)); }
  let maskaOkraje = null;
  function maska() {
    if (maskaOkraje) return maskaOkraje;
    const N = 64;
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(N, N) : document.createElement('canvas');
    c.width = N; c.height = N;
    const x = c.getContext('2d'), img = x.createImageData(N, N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) img.data[(j * N + i) * 4 + 3] = Math.round(255 * okrajF((i + 0.5) / N) * okrajF((j + 0.5) / N));
    x.putImageData(img, 0, 0);
    maskaOkraje = c;
    return c;
  }

  function kresli(tmp, cil, zad, zdroje) {
    const F = zad.F, S = 1 / F, w2 = zad.w2, h2 = zad.h2;
    if (tmp.width !== w2 || tmp.height !== h2) { tmp.width = w2; tmp.height = h2; }
    const ctx = tmp.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w2, h2);
    ctx.imageSmoothingEnabled = true;
    ctx.setTransform(S, 0, 0, S, 0, 0);          // kreslí se v px plné velikosti
    // stíny kopců pod vším (maska G×G z workeru stínů terénu)
    const t = zad.teren;
    if (t) {
      const tp = zdroje.teren ? zdroje.teren(t) : null;
      if (tp) { ctx.imageSmoothingEnabled = true; ctx.drawImage(tp, t.dx, t.dy, t.dw, t.dh); }
    }
    // --- domy: půdorys + posunutý půdorys + boční čtyřúhelníky, PO DOMECH
    // (⛔ jedna Path2D s tisíci podcestami je kvadratická, viz main.js)
    ctx.fillStyle = BARVA;
    const sxM = zad.sxM, syM = zad.syM;
    const P = zad.prstence, xy = P.xy, zac = P.zac, Ls = P.L;
    const nP = Ls.length;
    const pudorysy = [];
    for (let q = 0; q < nP; q++) {
      const a0 = zac[q], n = zac[q + 1] - a0;
      if (n < 3) continue;
      let plocha = 0;
      for (let i = 0; i < n; i++) {
        const j = i + 1 < n ? i + 1 : 0;
        plocha += xy[2 * (a0 + i)] * xy[2 * (a0 + j) + 1] - xy[2 * (a0 + j)] * xy[2 * (a0 + i) + 1];
      }
      if (Math.abs(plocha) < 0.05) continue;
      if (n > bx.length) { bx = new Float64Array(n * 2); by = new Float64Array(n * 2); }
      const obr = plocha < 0;                  // = dřívější pts.reverse()
      for (let i = 0; i < n; i++) {
        const k = a0 + (obr ? n - 1 - i : i);
        bx[i] = xy[2 * k]; by[i] = xy[2 * k + 1];
      }
      const sx = Ls[q] * sxM, sy = Ls[q] * syM;
      const cesta = new Path2D();
      const pudorys = new Path2D();
      cesta.moveTo(bx[0], by[0]);
      pudorys.moveTo(bx[0], by[0]);
      for (let i = 1; i < n; i++) {
        cesta.lineTo(bx[i], by[i]);
        pudorys.lineTo(bx[i], by[i]);
      }
      cesta.closePath(); pudorys.closePath();
      cesta.moveTo(bx[0] + sx, by[0] + sy);
      for (let i = 1; i < n; i++) cesta.lineTo(bx[i] + sx, by[i] + sy);
      cesta.closePath();
      for (let i = 0; i < n; i++) {
        const j = i + 1 < n ? i + 1 : 0;
        const ax = bx[i], ay = by[i], cx = bx[j], cy = by[j];
        const kriz = (cx - ax) * sy - (cy - ay) * sx;   // orientace jako půdorys
        if (Math.abs(kriz) < 0.05) continue;
        if (kriz > 0) {
          cesta.moveTo(ax, ay); cesta.lineTo(cx, cy);
          cesta.lineTo(cx + sx, cy + sy); cesta.lineTo(ax + sx, ay + sy);
        } else {
          cesta.moveTo(ax, ay); cesta.lineTo(ax + sx, ay + sy);
          cesta.lineTo(cx + sx, cy + sy); cesta.lineTo(cx, cy);
        }
        cesta.closePath();
      }
      ctx.fill(cesta, 'nonzero');
      pudorysy.push(pudorys);
    }
    // --- stromy a keře: silueta spritu položená na zem (vodorovná osa kolmo
    // na slunce, výška ve směru stínu × 1/tan(el)); bez spritu elipsa + kmen
    const T = zad.stromy, d = T.d, ikS = T.ik, ikony = T.ikony;
    const nT = ikS.length;
    if (nT) {
      const tg = zad.tg, smer = zad.smer, pxNaMetr = zad.pxNaMetr;
      const uhel = Math.atan2(syM, sxM);                      // směr stínu v px plátna
      const protazeni = Math.sqrt(1 + tg * tg);               // r / sin(el)
      const dX = Math.sin(smer), dY = -Math.cos(smer);        // směr stínu (y dolů)
      const pX = Math.cos(smer), pY = Math.sin(smer);         // kolmo na něj
      ctx.fillStyle = BARVA_STROMU;
      ctx.strokeStyle = BARVA_STROMU;
      ctx.lineCap = 'round';
      for (let i = 0; i < nT; i++) {
        const tbx = d[4 * i], tby = d[4 * i + 1], Hm = d[4 * i + 2], rp = d[4 * i + 3];
        const sil = (ikS[i] >= 0 && zad.siluety && zdroje.silueta) ? zdroje.silueta(ikony[ikS[i]]) : null;
        if (sil) {
          const A = (Hm / sil.h) * pxNaMetr;                  // px plátna na px spritu (do stran)
          const B = A * tg;                                    // … na px výšky (po směru stínu)
          ctx.setTransform(S * A * pX, S * A * pY, -S * B * dX, -S * B * dY,
                           S * (tbx - (sil.w / 2) * A * pX + sil.h * B * dX),
                           S * (tby - (sil.w / 2) * A * pY + sil.h * B * dY));
          ctx.drawImage(sil.platno, 0, 0);
          ctx.setTransform(S, 0, 0, S, 0, 0);
          continue;
        }
        const hc = 0.5 * Hm * tg;
        const cx2 = tbx + hc * sxM, cy2 = tby + hc * syM;
        ctx.beginPath();
        ctx.ellipse(cx2, cy2, rp * protazeni, rp, uhel, 0, Math.PI * 2);
        ctx.fill();
        const konec = hc - 0.36 * Hm * protazeni;
        if (konec > 0.3) {
          ctx.lineWidth = Math.max(1.5, 0.06 * Hm * pxNaMetr);
          ctx.beginPath();
          ctx.moveTo(tbx, tby);
          ctx.lineTo(tbx + konec * sxM, tby + konec * syM);
          ctx.stroke();
        }
      }
      ctx.fillStyle = BARVA;
    }
    // půdorysy domů ven (stín neleží na střeše)
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < pudorysy.length; i++) ctx.fill(pudorysy[i], 'nonzero');
    ctx.globalCompositeOperation = 'source-over';
    // --- výsledek: kopie se zapečeným krytím (engine 222: krytí v plátně,
    // ne ve vrstvě), stejná velikost jako pomocné plátno
    if (cil.width !== w2 || cil.height !== h2) { cil.width = w2; cil.height = h2; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const vctx = cil.getContext('2d');
    vctx.setTransform(1, 0, 0, 1, 0, 0);
    vctx.globalCompositeOperation = 'source-over';
    vctx.clearRect(0, 0, w2, h2);
    vctx.globalAlpha = zad.kryti;
    vctx.drawImage(tmp, 0, 0);
    vctx.globalAlpha = 1;
    // engine 341: měkký okraj (viz maska)
    vctx.globalCompositeOperation = 'destination-in';
    vctx.imageSmoothingEnabled = true;
    vctx.drawImage(maska(), 0, 0, w2, h2);
    vctx.globalCompositeOperation = 'source-over';
  }

  /// Rastrová dlaždice z/x/y vyříznutá z výsledného plátna (rozsah r
  /// v Mercatoru 0..1). null = dlaždice leží mimo plátno. Dlaždice má jen
  /// tolik pixelů, kolik na ni připadá ze zdroje (mocnina 2, 64 až Dmax) –
  /// víc detailu mít nemůže, MapLibre ji roztáhne sám (engine 333).
  function vyrez(platno, r, z, x, y, Dmax, nove) {
    if (!platno) return null;
    const o = obdelnik(platno.width, platno.height, r, z, x, y, Dmax);
    if (!o) return null;
    const c = nove(o.D);
    c.getContext('2d').drawImage(platno, o.sx, o.sy, o.sw, o.sh, o.dx, o.dy, o.dw, o.dh);
    return c;
  }
  /// Zdrojový obdélník (px plátna w×h) a cílový v dlaždici D×D; null = mimo
  /// (engine 335: sdílí i kresba na grafické kartě, stiny-gl.js)
  function obdelnik(w, h, r, z, x, y, Dmax) {
    if (!r || !w || !h) return null;
    const n = Math.pow(2, z);
    const tx0 = x / n, tx1 = (x + 1) / n, ty0 = y / n, ty1 = (y + 1) / n;
    if (tx1 <= r.x0 || tx0 >= r.x1 || ty1 <= r.y0 || ty0 >= r.y1) return null;
    const kx = w / (r.x1 - r.x0), ky = h / (r.y1 - r.y0);
    let sx = (tx0 - r.x0) * kx, sy = (ty0 - r.y0) * ky;
    let sw = (tx1 - tx0) * kx, sh = (ty1 - ty0) * ky;
    let D = 64;
    while (D < Dmax && D < Math.max(sw, sh) * 1.15) D *= 2;
    let dx = 0, dy = 0, dw = D, dh = D;
    if (sx < 0) { dx = -sx / sw * dw; dw -= dx; sw += sx; sx = 0; }
    if (sy < 0) { dy = -sy / sh * dh; dh -= dy; sh += sy; sy = 0; }
    if (sx + sw > w) { const o = sx + sw - w; dw -= o / sw * dw; sw -= o; }
    if (sy + sh > h) { const o = sy + sh - h; dh -= o / sh * dh; sh -= o; }
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return null;
    return { D, sx, sy, sw, sh, dx, dy, dw, dh };
  }

  G.StinyKresba = { kresli, vyrez, obdelnik };
})(typeof self !== 'undefined' ? self : this);
