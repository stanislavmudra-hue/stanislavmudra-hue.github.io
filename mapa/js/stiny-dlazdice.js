// Okolník 3D — STÍNY PO DLAŽDICÍCH (engine 357).
//
// ⭐ T 24. 9. 2026: „udělej stíny jako dlaždice“. Dřív byly stíny JEDEN obraz výřezu (plátno s okrajem 70 %),
// ze kterého se dlaždice jen vyřezávaly: po přiblížení rozmazané, dokud se plátno nepřekreslilo, po oddálení
// za okrajem chyběly, po každém gestu se měnily všechny dlaždice naráz. Teď se KAŽDÁ dlaždice stínů z/x/y kreslí
// sama za sebe ze svého kusu světa (+ okraj, ze kterého do ní stíny sahají) a platí, dokud se nezmění světlo
// nebo odkrytí – jako kterákoli jiná dlaždice mapy (posun = jen nové dlaždice na kraji, návrat z keše MapLibre,
// předkreslení v klidu).
//
// Běží ve WORKERU DEKORACÍ (importScripts na konci js/dekorace-worker.js), protože ten už má vlastní přístup
// ke všemu, co stín vrhá:
//   · domy – vrstva `building` zdroje budov (OMT) přímo z PMTiles (stejná data jako 3D domy),
//   · stavby a svislice ZABAGED – vrstvy `stavby` a `vertikaly` zdroje `krajina`,
//   · stromy a keře – výstup generátoru dekorací (týž hash = tytéž stromy jako na mapě, i s maskou mlhy),
//   · stíny kopců – výškopis (DEM) přes hlavní vlákno, paprsky ke slunci po BLOCÍCH z13 (maska 256×256).
// Kresba týmž kódem jako dřív: StinyGL (WebGL2 v OffscreenCanvas) se zálohou StinyKresba (2D). Liší se jen
// v tom, že dlaždice nemá měkký okraj (`bezOkraje`) – navazuje na sousedy.
//
// Odkrytí domů = totéž pravidlo jako prepoctiBudovyHerni v main.js (id je odkryté, když je odkrytý kterýkoli
// jeho kus – průměr vrcholů kusu v Mlha.jeObjeveno); odkrytá id jdou s dlaždicí na hlavní vlákno, které je
// hned označí (feature-state), takže 3D dům a jeho stín naskočí SPOLU.
//
// Zprávy (obsluhuje dekorace-worker.js):
//   {typ:'svetlo', verze, az, el, kryti, ex, jen3D, stavby, dz}   světlo a volby (verze = verze URL dlaždic)
//   {typ:'stin', id, z, x, y, verze}                               → {typ:'stin', id, bmp, odkryte}
//   {typ:'predstin', verze, dlazdice:[{z,x,y}]}                    předkreslit do keše (nic neposílá)
// Worker se ptá hlavního vlákna: {typ:'silueta', id, ik} → {typ:'silueta', id, w, h, px} (silueta spritu stromu).
'use strict';
(function (G) {
  const STROM_VYSKA_M = 22.9;         // = main.js (sprite 98 CSS px × icon-size 19,7 na z22)
  const OKRAJ_M = 170;                // dosah stínů ze sousedství (svislice ZABAGED až 120 m + půdorys)
  const MAX_PRSTENCU = 6000, MAX_STROMU = 9000;
  // engine 357: kresbičky vedení se stínem (výška plátna @2 → metry = 0,1167 × H × k); jen silueta, bez elipsy
  const VEDENI_STIN = { 'deko-sloup-nn': 128, 'deko-stozar-vn': 160, 'deko-stozar-vvn': 256, 'deko-stozar-zvn': 256,
                        'deko-stozar-lan': 160, 'deko-vetrnik': 512 };
  const MAX_STIN_M = 160;
  // engine 358: výšky plotů se stínem podle kódu úseku (ploty3d.js); 0 = bez stínu (pletivo, pruty, zábradlí, svodidlo)
  const PLOT_STIN_H = [0, 1.3, 0, 1.8, 1.6, 1.8, 0, 0, 3.5];
  const MAX_PLOT_STINU = 5000;
  const PRED_MAX = 64;                // předkreslených dlaždic v keši
  let SV = null;                      // světlo z hlavního vlákna
  let mlhaVerze = 0;                  // odkrytí → znovu se ptát na domy
  // --- kresba (GL / 2D) --------------------------------------------------------------------------
  let sgl = null, glStav = 0, glZtrat = 0, glChyba = '';
  let tmp2d = null, cil2d = null;
  const siluety = new Map();          // ik → { px, w, h, platno }
  const siluetyCekaji = new Map();    // ik → Promise
  // --- keše ---------------------------------------------------------------------------------------
  const domyKes = new Map();          // 'zdroj|z/x/y' → { prstence:[…], odkryto: Map id→bool, mlha }
  const terenKes = new Map();         // 'blok|světlo' → Promise<{ id, G, px, r } | null>
  const pred = new Map();             // 'verze|z/x/y' → ImageBitmap
  let terenId = 0;
  const stat = { dlazdic: 0, ms: 0, predkresleno: 0, zPred: 0, gl: false };

  function zajistiGL() {
    if (glStav === 1 && sgl && !sgl.ztracen()) return sgl;
    if (glStav === 1) {
      sgl = null; glZtrat++;
      if (glZtrat > 3) { glStav = -1; glChyba = 'kontext ztracen ' + glZtrat + '×'; return null; }
      glStav = 0;
    }
    if (glStav === -1) return null;
    glStav = -1;
    try {
      if (!G.StinyGL || typeof OffscreenCanvas === 'undefined') return null;
      sgl = G.StinyGL.vytvor(new OffscreenCanvas(64, 64));
    } catch (e) { sgl = null; glChyba = 'vytvor: ' + String((e && e.message) || e); }
    if (!sgl) return null;
    glStav = 1;
    for (const [ik, s] of siluety) { try { sgl.silueta(ik, s.px, s.w, s.h, s.dno); } catch (e) { /* nic */ } }
    return sgl;
  }

  function nastavSvetlo(m) {
    const stara = SV && SV.verze;
    SV = m;
    if (stara !== m.verze) {
      for (const b of pred.values()) { try { b.close(); } catch (e) { /* nic */ } }
      pred.clear();
    }
  }
  function zmenaMlhy() { mlhaVerze++; }

  /// silueta spritu stromu (alfa obrázku v barvě stínu) z hlavního vlákna; null = obrázek ještě není
  function silueta(ik) {
    if (siluety.has(ik)) return Promise.resolve(siluety.get(ik));
    let p = siluetyCekaji.get(ik);
    if (!p) {
      p = dotaz({ typ: 'silueta', ik }).then((m) => {
        siluetyCekaji.delete(ik);
        if (!m || !m.px || !m.w || !m.h) return null;
        const s = { px: new Uint8Array(m.px), w: m.w, h: m.h, dno: m.dno || m.h, platno: null };   // engine 359: dno
        siluety.set(ik, s);
        if (sgl) { try { sgl.silueta(ik, s.px, s.w, s.h, s.dno); } catch (e) { /* nic */ } }
        return s;
      }).catch(() => { siluetyCekaji.delete(ik); return null; });
      siluetyCekaji.set(ik, p);
    }
    return p;
  }
  function platnoSiluety(ik) {
    const s = siluety.get(ik);
    if (!s) return null;
    if (!s.platno) {
      const c = new OffscreenCanvas(s.w, s.h);
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(s.px), s.w, s.h), 0, 0);
      s.platno = c;
    }
    return { platno: s.platno, w: s.w, h: s.h, dno: s.dno || s.h };
  }

  // --- domy a stavby -------------------------------------------------------------------------------
  /// Všechny vnější prstence zdrojové dlaždice v Mercatoru (jednou na dlaždici), s odkrytím podle mlhy.
  async function prstenceZdroje(zdroj, vrstva, sz, sx, sy, filtr, vyska, pravidlo) {
    const klic = zdroj + '|' + vrstva + '|' + sz + '/' + sx + '/' + sy;
    let e = domyKes.get(klic);
    if (e) { domyKes.delete(klic); domyKes.set(klic, e); }
    else {
      const zd = await zdrojovaDlazdice(zdroj, sz, sx, sy, null);
      const v = zd && zd.vrstvy && zd.vrstvy[vrstva];
      const ns = Math.pow(2, sz);
      const prst = [];
      if (v) {
        const k = 1 / (v.extent * ns), ox = sx / ns, oy = sy / ns;
        for (const f of v.prvky) {
          if (f.typ !== 3 || (filtr && !filtr(f.vl, f.typ))) continue;
          const H = vyska(f.vl);
          for (const r of geomPrvku(v, f)) {
            const n = r.length >> 1;
            if (n < 4) continue;
            let a = 0;
            for (let i = 0; i < n; i++) {
              const j = i + 1 < n ? i + 1 : 0;
              a += r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1];
            }
            if (a <= 1e-6) continue;               // díra (MVT v2: vnější prstenec má kladnou plochu)
            const m = r[2 * (n - 1)] === r[0] && r[2 * (n - 1) + 1] === r[1] ? n - 1 : n;   // bez zavíracího bodu
            const X = new Float64Array(m), Y = new Float64Array(m);
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, sxx = 0, syy = 0;
            for (let i = 0; i < m; i++) {
              const px = ox + r[2 * i] * k, py = oy + r[2 * i + 1] * k;
              X[i] = px; Y[i] = py;
              if (px < x0) x0 = px; if (px > x1) x1 = px;
              if (py < y0) y0 = py; if (py > y1) y1 = py;
            }
            // těžiště pro mlhu = průměr vrcholů VČETNĚ zavíracího (jako GeoJSON prstenec v prepoctiBudovyHerni)
            for (let i = 0; i < n; i++) { sxx += ox + r[2 * i] * k; syy += oy + r[2 * i + 1] * k; }
            prst.push({ id: pravidlo === 'id' ? f.id : (vrstva + ':' + (f.vl.fid != null ? f.vl.fid : f.id)), H, X, Y,
                        bb: [x0, y0, x1, y1], cLon: lonZ(sxx / n), cLat: latZ(syy / n) });
          }
        }
      }
      e = { prstence: prst, odkryto: null, mlha: -1 };
      domyKes.set(klic, e);
      while (domyKes.size > 24) domyKes.delete(domyKes.keys().next().value);
    }
    if (e.mlha !== mlhaVerze) {
      // odkryté = kterýkoli kus téhož id (engine 274) – kusy celé zdrojové dlaždice, po 400 bodech
      const odk = new Map();
      const P = e.prstence;
      for (let a0 = 0; a0 < P.length; a0 += 400) {
        const cast = P.slice(a0, a0 + 400);
        const body = new Float64Array(cast.length * 2);
        for (let j = 0; j < cast.length; j++) { body[2 * j] = cast[j].cLon; body[2 * j + 1] = cast[j].cLat; }
        const m = await dotaz({ typ: 'mlha', body }, [body.buffer]);
        const maska = m && m.maska ? new Uint8Array(m.maska) : null;
        for (let j = 0; j < cast.length; j++) {
          const id = cast[j].id;
          const o = maska ? !!maska[j] : true;
          if (o || !odk.has(id)) odk.set(id, o || !!odk.get(id));
        }
      }
      e.odkryto = odk; e.mlha = mlhaVerze;
    }
    return e;
  }
  function filtrBudov(def) { return def && def.fn ? def.fn : null; }

  // --- stíny kopců: bloky z13, paprsky ke slunci (= stiny-worker.js) ------------------------------
  function terenBloku(bx, by, sv) {
    const klic = bx + '/' + by + '|' + sv.az + '|' + sv.el + '|' + sv.ex;
    let p = terenKes.get(klic);
    if (p) { terenKes.delete(klic); terenKes.set(klic, p); return p; }
    p = spocitejTeren(bx, by, sv).catch(() => null);
    terenKes.set(klic, p);
    while (terenKes.size > 8) terenKes.delete(terenKes.keys().next().value);
    return p;
  }
  async function spocitejTeren(bx, by, sv) {
    if (sv.el > 55 || sv.el < 2) return null;
    const nB = 8192;                                       // z13
    const r = { x0: bx / nB, x1: (bx + 1) / nB, y0: by / nB, y1: (by + 1) / nB };
    const lat = latZ((by + 0.5) / nB);
    const mpu = 1 / (40075016.686 * Math.cos(lat * Math.PI / 180));     // Mercator na metr
    const tg = Math.tan(sv.el * Math.PI / 180);
    const Gm = 256;
    const bunkaM = (r.x1 - r.x0) / mpu / Gm;
    const krokM = Math.max(bunkaM, 12);
    const KB = 30, KD = 40, HR = 4;
    const dosahM = Math.min(4000, 700 / tg, krokM * (KB + KD * HR));
    const okraj = dosahM * mpu;
    const celkemM = ((r.x1 - r.x0) + 2 * okraj) / mpu;
    const zD = celkemM > 12000 ? 12 : (celkemM > 6000 ? 13 : 14);
    const n = Math.pow(2, zD);
    const x0 = Math.floor((r.x0 - okraj) * n), x1 = Math.floor((r.x1 + okraj) * n);
    const y0 = Math.floor((r.y0 - okraj) * n), y1 = Math.floor((r.y1 + okraj) * n);
    const nx = x1 - x0 + 1, ny = y1 - y0 + 1;
    if (nx * ny > 36) return null;
    const dl = [];
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) dl.push(demDlazdice(zD, tx, ty));
    const data0 = await Promise.all(dl);
    const S = nx * 256, V = ny * 256;
    const data = new Float32Array(S * V);
    data.fill(-10000);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const d = data0[j * nx + i];
        if (!d || d.length < 65536) continue;
        for (let row = 0; row < 256; row++) data.set(d.subarray(row * 256, row * 256 + 256), (j * 256 + row) * S + i * 256);
      }
    }
    const kPx = n * 256, oX = x0 * 256, oY = y0 * 256;
    const az = sv.az * Math.PI / 180;
    const dpx0 = Math.sin(az) * krokM * mpu * kPx, dpy0 = -Math.cos(az) * krokM * mpu * kPx;   // ke slunci
    const st0 = krokM * tg;
    const cx0 = r.x0 * kPx - oX, cy0 = r.y0 * kPx - oY;
    const cdx = (r.x1 - r.x0) * kPx / Gm, cdy = (r.y1 - r.y0) * kPx / Gm;
    const ex = sv.ex || 1;
    const px = new Uint8Array(Gm * Gm * 4);
    let veStinu = 0;
    // ⭐ engine 359 (T 24. 9.: „Některé přechody působí zvláštně“): stín kopce byl ANO/NE po buňkách 12 m a výška
    // z nejbližšího pixelu DEM – po roztažení na z17–18 (buňka = 30–60 px) hranaté kostky s rovnými okraji a světlé
    // pruhy mezi nimi. Teď výška BILINEÁRNĚ (pixel i na poloze i, jako terén MapLibre) a stín MĚKKÝ: podle toho, o kolik
    // terén paprsek převýší (±půl výšky paprsku na krok = hrana přes zhruba jednu buňku) → hladké obrysy i po zvětšení.
    const vyska = (x, y) => {
      const ix = x | 0, iy = y | 0;
      if (x < 0 || y < 0 || ix + 1 >= S || iy + 1 >= V) return -10000;
      const i = iy * S + ix, a = data[i], b = data[i + 1], c = data[i + S], d = data[i + S + 1];
      if (a < -9000 || b < -9000 || c < -9000 || d < -9000) return -10000;
      const tx = x - ix, ty = y - iy;
      return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    };
    const mez = Math.max(0.6, 0.5 * st0);
    const ALFA_KOPCE = 165;                                // engine 359: 140 → 165 (kreslí se MAX, neskládá se se stromy)
    for (let gy = 0; gy < Gm; gy++) {
      const fy0 = cy0 + (gy + 0.5) * cdy;
      for (let gx = 0; gx < Gm; gx++) {
        const fx0 = cx0 + (gx + 0.5) * cdx;
        const h0 = vyska(fx0, fy0);
        if (h0 < -9000) continue;
        let fx = fx0, fy = fy0, ray = h0 * ex + 0.8;
        let maxE = -1e9, sx = dpx0, sy = dpy0, st = st0;
        for (let k = 1; k <= KB + KD; k++) {
          if (k === KB + 1) { sx *= HR; sy *= HR; st *= HR; }
          fx += sx; fy += sy; ray += st;
          const h = vyska(fx, fy);
          if (h < -9000) break;
          const e = h * ex - ray;
          if (e > maxE) { maxE = e; if (maxE >= mez) break; }
        }
        if (maxE <= -mez) continue;
        let s = maxE >= mez ? 1 : (maxE + mez) / (2 * mez);
        s = s * s * (3 - 2 * s);
        const a = Math.round(ALFA_KOPCE * s);
        if (a < 3) continue;
        const i = (gy * Gm + gx) * 4;
        px[i] = 42; px[i + 1] = 29; px[i + 2] = 16; px[i + 3] = a;        // barva stálá (2D záloha bere RGBA nepremultipl.)
        veStinu++;
      }
    }
    if (!veStinu) return null;
    return { id: 'blok' + (++terenId), G: Gm, px, r, platno: null };
  }
  function platnoTerenu(t) {
    if (!t.platno) {
      const c = new OffscreenCanvas(t.G, t.G);
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(t.px), t.G, t.G), 0, 0);
      t.platno = c;
    }
    return t.platno;
  }

  // --- jedna dlaždice ------------------------------------------------------------------------------
  function prazdna() {
    const c = new OffscreenCanvas(1, 1);
    c.getContext('2d');
    return c.transferToImageBitmap();
  }

  /// Dlaždice stínů z/x/y → { bmp: ImageBitmap, odkryte: [id domů], prazdna } (bmp null = chyba)
  async function dlazdice(z, x, y, verze) {
    const sv = SV;
    if (!sv || !N || !N.herni || !(sv.kryti > 0)) return { bmp: prazdna(), odkryte: null, prazdna: true };
    const klicPred = verze + '|' + z + '/' + x + '/' + y;
    const hotova = pred.get(klicPred);
    if (hotova) { pred.delete(klicPred); stat.zPred++; return { bmp: hotova.bmp, odkryte: hotova.odkryte, prazdna: hotova.prazdna }; }
    return nakresli(z, x, y, sv);
  }

  async function nakresli(z, x, y, sv) {
    const t0 = performance.now();
    const n = Math.pow(2, z);
    const T = { x0: x / n, y0: y / n, x1: (x + 1) / n, y1: (y + 1) / n };
    // ⭐ engine 359 (T 24. 9.: „jako by se ty stíny vykreslily až z blízkosti“): z16 a z17 měly jen 256 px (1,5 m/px na z16)
    // – mezi z15,5 a z16,5 (dlaždice z16) se stín domu roztáhl 3–6× a rozplizl do šedé skvrny, ostřejší byl až od z17.
    // Teď 512 px až do z17 (zvětšení všude 1,4–2,8×), z18+ zůstává 256 (stín je na obrazovce velký).
    const D = z >= 18 ? 256 : 512;
    const tw = 1 / n;
    const latS = latZ((y + 0.5) / n);
    const mNaMerc = 40075016.686 * Math.cos(latS * Math.PI / 180);
    const pxNaMerc = D / tw, pxNaMetr = pxNaMerc / mNaMerc;
    const elR = Math.max(8, sv.el) * Math.PI / 180;
    const tg = 1 / Math.tan(elR);
    const smer = (sv.az + 180) * Math.PI / 180;
    const sxM = Math.sin(smer) * pxNaMetr, syM = -Math.cos(smer) * pxNaMetr;
    const marg = OKRAJ_M / mNaMerc;
    const OB = { x0: T.x0 - marg, y0: T.y0 - marg, x1: T.x1 + marg, y1: T.y1 + marg };
    const okrPx = OKRAJ_M * pxNaMetr;
    // --- domy (OMT) a stavby ZABAGED
    const prstence = [];
    const odkryte = [];
    const zdrojBudov = [];
    const defB = (N.plochy || []).find((d) => d.id === 'budovy-vypln');
    if (defB && N.zdroje && N.zdroje[defB.zdroj]) {
      zdrojBudov.push({ zdroj: defB.zdroj, vrstva: defB.vrstva, filtr: filtrBudov(defB), Lmax: 80,
                        vyska: (vl) => Math.max(2.5, +(vl && vl.render_height) || 6), pravidlo: 'id', jenOdkryte: !!sv.jen3D,
                        hlasit: !!sv.jen3D });
    }
    if (sv.stavby && N.zdroje && N.zdroje.krajina) {
      zdrojBudov.push({ zdroj: 'krajina', vrstva: 'stavby', filtr: null, Lmax: 40,
                        vyska: (vl) => Math.max(2.5, +(vl && vl.h) || 3), pravidlo: 'fid', jenOdkryte: true });
      zdrojBudov.push({ zdroj: 'krajina', vrstva: 'vertikaly', filtr: (vl) => !vl || vl.t !== 'vetrnik', Lmax: 120,
                        vyska: (vl) => Math.max(2.5, +(vl && vl.h) || 20), pravidlo: 'fid', jenOdkryte: true });
    }
    for (const zb of zdrojBudov) {
      const a = archiv(zb.zdroj);
      if (!a) continue;
      let h;
      try { h = await a.hlavicka; } catch (e) { continue; }
      if (!h) continue;
      const sz = Math.max(h.minZoom, Math.min(z, h.maxZoom));
      const ns = Math.pow(2, sz);
      const sx0 = Math.floor(OB.x0 * ns), sx1 = Math.floor(OB.x1 * ns);
      const sy0 = Math.floor(OB.y0 * ns), sy1 = Math.floor(OB.y1 * ns);
      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          let e;
          try { e = await prstenceZdroje(zb.zdroj, zb.vrstva, sz, sx, sy, zb.filtr, zb.vyska, zb.pravidlo); }
          catch (er) { e = null; }
          if (!e) continue;
          const odk = e.odkryto;
          for (const q of e.prstence) {
            const bb = q.bb;
            if (bb[2] < OB.x0 || bb[0] > OB.x1 || bb[3] < OB.y0 || bb[1] > OB.y1) continue;
            const o = odk ? !!odk.get(q.id) : true;
            if (zb.jenOdkryte && !o) continue;
            if (zb.hlasit && o && q.id != null && (typeof q.id === 'number')) odkryte.push(q.id);
            const L = Math.min(zb.Lmax, q.H * tg);
            prstence.push({ q, L });
            if (prstence.length >= MAX_PRSTENCU) break;
          }
        }
      }
    }
    // --- ⭐ engine 358: plné ploty a zdi (dřevěné, zděné, živé, zdi, protihlukové stěny) vrhají stín jako úzká stěna;
    // úseky z výstupu dekorací z15 (ploty3d.js kreslí tytéž, jen odkryté buňky mlhy). Pletivo, pruty, zábradlí
    // a svodidla stín skoro nevrhají – vynechány. Prstenec [A, B, A] = stín obou stran úsečky, bez půdorysu.
    if (z >= 15) {
      const nL = 32768;
      const tx0 = Math.floor(OB.x0 * nL), tx1 = Math.floor(OB.x1 * nL);
      const ty0 = Math.floor(OB.y0 * nL), ty1 = Math.floor(OB.y1 * nL);
      let nP = 0;
      for (let ty = ty0; ty <= ty1 && nP < MAX_PLOT_STINU; ty++) {
        for (let tx = tx0; tx <= tx1 && nP < MAX_PLOT_STINU; tx++) {
          let v;
          try { v = await ziskejVystup(15, tx, ty); } catch (e) { v = null; }
          const P = v && v.ploty;
          if (!P || !P.obj) continue;
          const S = P.seg;
          for (let i = 0; i < P.n && nP < MAX_PLOT_STINU; i++) {
            if (!P.obj[P.bunka[i]]) continue;
            const Hp = PLOT_STIN_H[S[i * 8 + 7]];
            if (!Hp) continue;
            const X0 = (tx + S[i * 8]) / nL, Y0 = (ty + S[i * 8 + 1]) / nL;
            const X1 = (tx + S[i * 8 + 3]) / nL, Y1 = (ty + S[i * 8 + 4]) / nL;
            const bb = [Math.min(X0, X1), Math.min(Y0, Y1), Math.max(X0, X1), Math.max(Y0, Y1)];
            if (bb[2] < OB.x0 || bb[0] > OB.x1 || bb[3] < OB.y0 || bb[1] > OB.y1) continue;
            prstence.push({ q: { id: null, H: Hp, X: Float64Array.of(X0, X1, X0), Y: Float64Array.of(Y0, Y1, Y0), bb },
                            L: Math.min(40, Hp * tg) });
            nP++;
          }
        }
      }
    }
    // --- stromy a keře z generátoru dekorací (tytéž jako na mapě)
    const stromy = [];
    const ikony = [], poradi = new Map();
    const zt = z;
    if (zt >= 14) {
      const Lz = Math.min(15, zt);
      const nL = Math.pow(2, Lz);
      const dz = N.dz || 0, pul = (N.sirkaNastupu || 0.35) * 0.5;
      const tx0 = Math.floor(OB.x0 * nL), tx1 = Math.floor(OB.x1 * nL);
      const ty0 = Math.floor(OB.y0 * nL), ty1 = Math.floor(OB.y1 * nL);
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          let v;
          try { v = await ziskejVystup(Lz, tx, ty); } catch (e) { v = null; }
          if (!v || !v.n || !v.maska) continue;
          for (let i = 0; i < v.n; i++) {
            if (!v.maska[i] || v.sv[i]) continue;
            const ik = retezce[v.ik[i]];
            if (!ik) continue;
            const hPodpery = VEDENI_STIN[ik];                     // engine 357: stožáry, větrníky (siluetou, z15+)
            const jeKamen = ik.startsWith('deko-kamen');          // engine 359: i balvany (siluetou, z15+)
            if (!(ik.startsWith('deko-strom') || ik.startsWith('deko-ker') || (hPodpery && zt >= 15) || (jeKamen && zt >= 15))) continue;
            const k = v.k[i];
            if (!hPodpery && k < (jeKamen ? 0.15 : 0.3)) continue;
            if (v.z0[i] - dz + pul > zt + 1e-6) continue;         // strom na tomhle zoomu ještě není vidět
            if (v.lic && v.lic[i] && zt < 15) continue;           // lichá buňka jemné mřížky (engine 343)
            const X = mercX(v.lon[i]), Y = mercY(v.lat[i]);
            if (X < OB.x0 || X > OB.x1 || Y < OB.y0 || Y > OB.y1) continue;
            const Hm = hPodpery ? 0.1167 * hPodpery * k : STROM_VYSKA_M * k;
            let j = poradi.get(ik);
            if (j === undefined) { j = ikony.length; ikony.push(ik); poradi.set(ik, j); }
            stromy.push((X - T.x0) * pxNaMerc, (Y - T.y0) * pxNaMerc, Hm, (hPodpery || jeKamen) ? -1 : 0.36 * Hm * pxNaMetr, j);
            if (stromy.length >= MAX_STROMU * 5) break;
          }
        }
      }
    }
    const siluetyZap = zt >= 15;
    if (siluetyZap && ikony.length) await Promise.all(ikony.map((ik) => silueta(ik)));
    // --- stíny kopců (blok z13)
    let teren = null;
    if (z >= 13 && sv.el >= 2 && sv.el <= 55) {
      const sh = z - 13;
      const bx = x >> sh, by = y >> sh;
      try { teren = await terenBloku(bx, by, sv); } catch (e) { teren = null; }
    }
    // --- nic? prázdná dlaždice
    if (!prstence.length && !stromy.length && !teren) {
      stat.dlazdic++; stat.ms += performance.now() - t0;
      return { bmp: prazdna(), odkryte, prazdna: true };
    }
    // --- zadání pro StinyKresba / StinyGL (px dlaždice D×D)
    let nb = 0;
    for (const p of prstence) nb += p.q.X.length;
    const xy = new Float32Array(nb * 2);
    const zac = new Uint32Array(prstence.length + 1);
    const Ls = new Float32Array(prstence.length);
    let o = 0;
    for (let i = 0; i < prstence.length; i++) {
      const q = prstence[i].q;
      zac[i] = o;
      for (let j = 0; j < q.X.length; j++) {
        xy[2 * o] = (q.X[j] - T.x0) * pxNaMerc; xy[2 * o + 1] = (q.Y[j] - T.y0) * pxNaMerc; o++;
      }
      Ls[i] = prstence[i].L;
    }
    zac[prstence.length] = o;
    const nT0 = stromy.length / 5;
    const d0 = new Float32Array(nT0 * 4), ikS0 = new Int32Array(nT0);
    let nT = 0;
    for (let i = 0; i < nT0; i++) {
      const ik = ikony[stromy[5 * i + 4]];
      const sil = siluetyZap && siluety.get(ik);
      if (stromy[5 * i + 3] < 0 && !sil) continue;         // engine 357: podpěra bez siluety – bez stínu (ne elipsa)
      d0[4 * nT] = stromy[5 * i]; d0[4 * nT + 1] = stromy[5 * i + 1]; d0[4 * nT + 2] = stromy[5 * i + 2];
      d0[4 * nT + 3] = Math.max(0, stromy[5 * i + 3]);
      ikS0[nT] = sil ? stromy[5 * i + 4] : -1;
      nT++;
    }
    const d = d0.subarray(0, nT * 4), ikS = ikS0.subarray(0, nT);
    const tz = teren ? { id: teren.id, dx: (teren.r.x0 - T.x0) * pxNaMerc, dy: (teren.r.y0 - T.y0) * pxNaMerc,
                         dw: (teren.r.x1 - teren.r.x0) * pxNaMerc, dh: (teren.r.y1 - teren.r.y0) * pxNaMerc } : null;
    const zad = { W: D, H: D, F: 1, w2: D, h2: D, kryti: sv.kryti, sxM, syM, tg, smer, pxNaMetr,
                  siluety: siluetyZap, teren: tz, bezOkraje: true, maxStinPx: MAX_STIN_M * pxNaMetr,
                  prstence: { xy, zac, L: Ls }, stromy: { d, ik: ikS, ikony } };
    void okrPx;
    let bmp = null;
    const g = zajistiGL();
    if (g) {
      try {
        if (g.ztracen()) throw new Error('kontext ztracen');
        if (teren) g.teren(teren.id, teren.px, teren.G);
        g.kresli(zad);
        bmp = g.dlazdice(T, z, x, y, D, sv.kryti);
        stat.gl = true;
      } catch (e) {
        bmp = null;
        glChyba = String((e && e.message) || e);
        if (!(sgl && sgl.ztracen())) { glStav = -1; sgl = null; }
      }
    }
    if (!bmp) {
      if (!tmp2d) { tmp2d = new OffscreenCanvas(64, 64); cil2d = new OffscreenCanvas(64, 64); }
      G.StinyKresba.kresli(tmp2d, cil2d, zad, {
        silueta: (ik) => platnoSiluety(ik),
        teren: (t) => (teren && t && t.id === teren.id) ? platnoTerenu(teren) : null,
      });
      bmp = cil2d.transferToImageBitmap();
      stat.gl = false;
    }
    stat.dlazdic++; stat.ms += performance.now() - t0;
    return { bmp, odkryte, prazdna: false };
  }

  // --- předkreslení v klidu --------------------------------------------------------------------------
  let predFrontaS = [], predBeziS = false;
  function predstin(m) {
    predFrontaS = Array.isArray(m.dlazdice) ? m.dlazdice.slice(0, 48).map((t) => ({ z: t.z, x: t.x, y: t.y, verze: m.verze })) : [];
    if (predFrontaS.length) pumpujS();
  }
  async function pumpujS() {
    if (predBeziS) return;
    predBeziS = true;
    try {
      while (predFrontaS.length) {
        // skutečné požadavky (dlaždice mapy, dekorací) mají přednost; předgenerování dekorací napřed
        if (performance.now() - posledniSkutecny < 150 || (typeof predFronta !== 'undefined' && predFronta.length)) {
          await new Promise((res) => setTimeout(res, 120));
          continue;
        }
        const t = predFrontaS.shift();
        const sv = SV;
        if (!sv || sv.verze !== t.verze || !(sv.kryti > 0)) continue;
        const k = t.verze + '|' + t.z + '/' + t.x + '/' + t.y;
        if (pred.has(k)) continue;
        const o = await nakresli(t.z, t.x, t.y, sv);
        if (!SV || SV.verze !== t.verze || !o || !o.bmp) { if (o && o.bmp) try { o.bmp.close(); } catch (e) { /* nic */ } continue; }
        pred.set(k, o);
        stat.predkresleno++;
        while (pred.size > PRED_MAX) {
          const k0 = pred.keys().next().value;
          const o0 = pred.get(k0);
          pred.delete(k0);
          try { o0.bmp.close(); } catch (e) { /* nic */ }
        }
      }
    } catch (e) { /* předkreslení je jen pohodlí navíc */ }
    finally { predBeziS = false; }
  }

  G.StinyDlazdice = { nastavSvetlo, dlazdice, predstin, zmenaMlhy,
                      stav: () => Object.assign({}, stat, { pred: pred.size, teren: terenKes.size, domy: domyKes.size,
                                                             siluety: siluety.size, glChyba, verze: SV && SV.verze }) };
})(self);
