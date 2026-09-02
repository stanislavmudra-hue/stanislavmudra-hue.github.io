/* =====================================================================
   Okolník – drobná oživení webu (v2, 3. 9. 2026)

   1) Jemné odhalení karet a nadpisů při rolování (IntersectionObserver).
      Bez JavaScriptu je všechno vidět rovnou – třídu `odhal` přidává
      až tenhle skript, takže nic nezmizí, když skript neběží nebo
      prohlížeč IntersectionObserver nemá. Ctí „omezit pohyb" v systému.
   2) Zkopírování e-mailu na úvodní stránce (tlačítko #kopirovat).

   Žádné knihovny, žádné sledování.
   ===================================================================== */
(function () {
  'use strict';

  /* ── 1) odhalení při rolování ─────────────────────────────────── */
  var omezitPohyb = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!omezitPohyb && 'IntersectionObserver' in window) {
    var prvky = document.querySelectorAll(
      '.sekce .karta, .sekce .snimek, .sekce h2, .sekce > .podtitul, ' +
      '.sekce .nadtitul, .uzky .karta, .uzky .snimek, .blok');
    var pozorovatel = new IntersectionObserver(function (zaznamy) {
      zaznamy.forEach(function (z) {
        if (!z.isIntersecting) return;
        z.target.classList.add('videt');
        pozorovatel.unobserve(z.target);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });
    Array.prototype.forEach.call(prvky, function (e, i) {
      // prvky už ve výřezu při načtení se neschovávají – žádné blikání
      var r = e.getBoundingClientRect();
      if (r.top < window.innerHeight * 0.9) return;
      e.classList.add('odhal');
      e.style.transitionDelay = ((i % 5) * 55) + 'ms';
      pozorovatel.observe(e);
    });
  }

  /* ── 2) kopírování adresy ─────────────────────────────────────── */
  // Adresa se hlavně UKAZUJE (na počítači málokdo používá poštovního
  // klienta, takže `mailto:` často jen otevře nastavení Outlooku).
  var t = document.getElementById('kopirovat');
  var m = document.getElementById('mail');
  if (t && m) {
    if (!navigator.clipboard) { t.hidden = true; return; }
    t.addEventListener('click', function () {
      navigator.clipboard.writeText(m.textContent.trim()).then(function () {
        t.textContent = 'Zkopírováno ✓';
        setTimeout(function () { t.textContent = 'Zkopírovat adresu'; }, 2500);
      }, function () { t.hidden = true; });
    });
  }
})();
