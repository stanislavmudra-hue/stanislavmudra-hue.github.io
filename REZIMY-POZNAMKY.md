# Web ve třech režimech – Cestovatel, Objevitel, Dobyvatel

Přání uživatele (2. 9. 2026): *„Web bych rozdělil na Cestovatel, Objevitel,
Dobyvatel. Přihlášený uživatel by viděl své statistiky, bez přihlášení popis
módu aplikace a žebříček uživatelů."* Etapa **bez mapy navštívených míst**
(ta žije jen v telefonu; poslat ji na server by znamenalo doplnit zásady
soukromí a Data Safety – rozhodnutí je na uživateli).

## Stránky

| stránka | co ukazuje | zdroj dat |
|---|---|---|
| `/cestovatel/` | popis režimu, karty, snímek; **Moje čísla** (km, obce, aktivní dny; měsíc + kroky a odznak „podloženo kroky"); výřez žebříčku **Ušlé kilometry** | `hraci/{uid}` (s tokenem), `zebricek` (veřejné) |
| `/objevitel/` | popis, karty, dva snímky; **Moje čísla** (úroveň, doložené návštěvy, fotovýpravy, obce; měsíc); výřezy **Nové obce** a **Fotovýpravy** | totéž |
| `/dobyvatel/` | beze změny rozvržení (mapa, Žebříčky, Moje soutěže); nově sbalený `<details>` **„Co je Dobyvatel a jak se hraje"** pod titulkem a v Moje soutěže řádek **„Moje zásluhy – Česko 2026"** (dobytí · obrany · body · pořadí) ze `stav/hraci` | `souteze/cesko-2026/stav/hraci` (veřejné, pole `json`) |
| `/` | nová sekce **„Tři režimy, jedna mapa"** se třemi kartami-odkazy hned pod hero | – |

Sdílený kód stránek režimů: `rezimy/rezim.js` + `rezimy/rezim.css`.
Režim určuje `<body data-rezim="cestovatel|objevitel">`; tabulka `REZIMY`
v JS říká, které kategorie žebříčku a které dlaždice profilu se ukážou.

## Přihlášení

Žádné nové přihlašování. Relace je **sdílená** s Můj Okolník
(`localStorage` klíč `okolnikUcet1`, obnova tokenu přes
`securetoken.googleapis.com` stejně jako v `ucet.js`). Stránky režimů
na tlačítko Googlu jen odkazují (`/ucet/`) – jeden přihlašovací kód na
jednom místě. Neplatná relace (odvolaný účet) se při startu smaže.

## Žebříček na stránkách režimů

Jedno stažení kolekce `zebricek` (`documents.list`, maska polí včetně
`hrac` = uid, ať jde zvýraznit vlastní řádek třídou `tr.ja`), období
a řazení v prohlížeči – stejné důvody jako v `ZEBRICEK-POZNAMKY.md`
(runQuery by chtěl složené indexy). TOP 10, pod tabulkou odkaz na celý
žebříček s předvolenou kategorií. Vlastní řádek mimo TOP 10 se vypíše
větou „Vy: 14. místo z 27".

`?ukazka=1` = smyšlená data (žebříček i „Moje čísla"), oranžový pruh
UKÁZKA. Hodí se na kontrolu vzhledu bez účtu.

## Menu

Lišta má s režimy 9 položek. Na mobilu (≤ 640 px) se **Pro firmy**
a **Soukromí** v hlavičce skrývají (třída `mimo-mobil`), zůstávají
v patičce každé stránky – lišta se tak láme do dvou řádků (121 px)
místo tří (159 px). Patička všech stránek má nově i Cestovatel,
Objevitel a Pro firmy.

Stránka Soukromí se GENERUJE (`Sarcher/tools/gen_privacy_html.py`),
menu je v její šabloně – ruční úprava `soukromi/index.html` by se
při dalším generování ztratila.

## Pasti při ladění (2. 9. 2026)

* `styl.css` nemá verzi v adrese → prohlížeč (i náhledový panel) drží
  starou kopii; při ověřování změn CSS vyměnit `href` za
  `/styl.css?v=<čas>` nebo fetch s `cache: 'no-store'`. Na GitHub Pages
  se nová verze rozšíří do ~10 minut (max-age 600).
* Náhledový panel občas hlásí `innerWidth 0` a rozvržení 0 px široké –
  je to artefakt panelu, ne stránky (živý web měřil 360 px); věřit
  screenshotu nebo měřit po nové navigaci.
* Python heredoc přes shell rozbíjí zpětná lomítka (`\x00` → NUL
  bajt): regulární výraz v `rezim.js` se stavěl z kódů znaků
  (`chr(92)`), ne z literálů.
