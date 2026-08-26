# -*- coding: utf-8 -*-
u"""Značky druhů vlajek pro webovou mapu, verze 2 (přání 27. 8.:
„hezčí a detailnější, ale decentní"). Dvoubarevné siluety s bílým
lemem, 32 px, kreslené 4× a zmenšené.

Použití:  python gen_ikonky.py   (z tohoto adresáře)
"""
import os

from PIL import Image, ImageDraw, ImageFilter

TMAVA = (85, 80, 63, 255)
SVETLA = (138, 129, 112, 255)
AKCENT = (163, 154, 135, 255)
N = 4
S = 32 * N

VEN = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   'data', 'ikonky')


def platno():
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)


def uloz(im, jmeno):
    u"""Bílý lem: silueta se rozšíří a podloží bílou, pak obsah."""
    alfa = im.split()[3].filter(ImageFilter.MaxFilter(2 * N + 1))
    lem = Image.new('RGBA', im.size, (255, 255, 255, 0))
    lem.putalpha(alfa.point(lambda a: 235 if a > 40 else 0))
    ven = Image.new('RGBA', im.size, (0, 0, 0, 0))
    ven = Image.alpha_composite(ven, lem)
    ven = Image.alpha_composite(ven, im)
    ven = ven.resize((32, 32), Image.LANCZOS)
    ven.save(os.path.join(VEN, jmeno + '.webp'), 'WEBP', quality=95)


def peaks():
    im, dr = platno()
    dr.polygon([(2*N, 27*N), (11*N, 9*N), (17*N, 20*N)], fill=SVETLA)
    dr.polygon([(12*N, 27*N), (21*N, 6*N), (30*N, 27*N)], fill=TMAVA)
    dr.polygon([(18*N, 13*N), (21*N, 6*N), (24*N, 13*N),
                (22*N, 11*N), (21*N, 13*N), (20*N, 11*N)],
               fill=(255, 255, 255, 255))
    uloz(im, 'peaks')


def castles():
    im, dr = platno()
    dr.rectangle([4*N, 10*N, 9*N, 27*N], fill=TMAVA)      # levá věž
    dr.rectangle([23*N, 10*N, 28*N, 27*N], fill=TMAVA)    # pravá věž
    dr.rectangle([9*N, 15*N, 23*N, 27*N], fill=SVETLA)    # hradba
    for x in (3, 6, 22, 25):                              # zuby věží
        dr.rectangle([(x+1)*N, 7*N, (x+3)*N, 10*N], fill=TMAVA)
    for x in (10, 14, 18):                                # zuby hradby
        dr.rectangle([x*N, 12*N, (x+2)*N, 15*N], fill=SVETLA)
    dr.pieslice([13*N, 19*N, 19*N, 30*N], 180, 360,
                fill=(255, 255, 255, 255))                # brána
    uloz(im, 'castles')


def towers():
    im, dr = platno()
    dr.polygon([(12*N, 27*N), (14*N, 8*N), (18*N, 8*N), (20*N, 27*N)],
               fill=SVETLA)
    dr.line([(13*N, 22*N), (19*N, 14*N)], fill=TMAVA, width=N)
    dr.line([(19*N, 22*N), (13*N, 14*N)], fill=TMAVA, width=N)
    dr.rectangle([11*N, 8*N, 21*N, 11*N], fill=TMAVA)     # ochoz
    dr.polygon([(12*N, 8*N), (16*N, 3*N), (20*N, 8*N)], fill=TMAVA)
    dr.rectangle([11*N, 26*N, 21*N, 28*N], fill=TMAVA)
    uloz(im, 'towers')


def caves():
    im, dr = platno()
    dr.pieslice([3*N, 8*N, 29*N, 40*N], 180, 360, fill=SVETLA)
    dr.pieslice([9*N, 14*N, 23*N, 36*N], 180, 360, fill=TMAVA)
    dr.rectangle([3*N, 26*N, 29*N, 28*N], fill=TMAVA)
    uloz(im, 'caves')


def waterfalls():
    im, dr = platno()
    dr.polygon([(4*N, 6*N), (13*N, 6*N), (13*N, 10*N), (10*N, 10*N),
                (10*N, 27*N), (4*N, 27*N)], fill=SVETLA)   # skála
    for x, w in ((15, 2), (19, 2), (23, 2)):
        dr.rectangle([x*N, 8*N, (x+w)*N, 24*N], fill=TMAVA)
    dr.ellipse([12*N, 22*N, 29*N, 28*N], fill=AKCENT)
    dr.ellipse([15*N, 23*N, 26*N, 27*N], fill=TMAVA)
    uloz(im, 'waterfalls')


def rocks():
    im, dr = platno()
    dr.polygon([(3*N, 27*N), (7*N, 12*N), (11*N, 27*N)], fill=SVETLA)
    dr.polygon([(10*N, 27*N), (16*N, 5*N), (22*N, 27*N)], fill=TMAVA)
    dr.polygon([(21*N, 27*N), (26*N, 10*N), (30*N, 27*N)], fill=AKCENT)
    uloz(im, 'rocks')


def viewpoints():
    im, dr = platno()
    # dalekohled na stojanu
    dr.ellipse([5*N, 8*N, 15*N, 18*N], fill=TMAVA)
    dr.ellipse([17*N, 8*N, 27*N, 18*N], fill=TMAVA)
    dr.rectangle([14*N, 11*N, 18*N, 15*N], fill=TMAVA)
    dr.ellipse([7*N, 10*N, 13*N, 16*N], fill=AKCENT)
    dr.ellipse([19*N, 10*N, 25*N, 16*N], fill=AKCENT)
    dr.rectangle([15*N, 18*N, 17*N, 27*N], fill=SVETLA)
    dr.rectangle([11*N, 26*N, 21*N, 28*N], fill=SVETLA)
    uloz(im, 'viewpoints')


def archaeology():
    im, dr = platno()
    dr.ellipse([4*N, 7*N, 28*N, 25*N], outline=SVETLA, width=3*N)
    dr.ellipse([9*N, 11*N, 23*N, 21*N], outline=TMAVA, width=2*N)
    dr.rectangle([14*N, 5*N, 18*N, 10*N], fill=(0, 0, 0, 0))  # vstup
    uloz(im, 'archaeology')


def mines():
    im, dr = platno()
    dr.pieslice([5*N, 8*N, 27*N, 38*N], 180, 360, fill=TMAVA)
    dr.pieslice([9*N, 12*N, 23*N, 36*N], 180, 360,
                fill=(255, 255, 255, 255))
    dr.rectangle([7*N, 8*N, 10*N, 27*N], fill=SVETLA)   # trám
    dr.rectangle([22*N, 8*N, 25*N, 27*N], fill=SVETLA)  # trám
    dr.rectangle([5*N, 6*N, 27*N, 9*N], fill=SVETLA)    # překlad
    dr.rectangle([4*N, 26*N, 28*N, 28*N], fill=TMAVA)
    uloz(im, 'mines')


def fortifications():
    im, dr = platno()
    dr.pieslice([4*N, 10*N, 28*N, 40*N], 180, 360, fill=SVETLA)
    dr.pieslice([7*N, 13*N, 25*N, 39*N], 180, 360, fill=TMAVA)
    dr.rectangle([11*N, 19*N, 21*N, 21*N], fill=(255, 255, 255, 255))
    dr.rectangle([3*N, 26*N, 29*N, 28*N], fill=TMAVA)
    uloz(im, 'fortifications')


def memorial_trees():
    im, dr = platno()
    dr.ellipse([7*N, 4*N, 25*N, 19*N], fill=SVETLA)
    dr.ellipse([4*N, 9*N, 17*N, 21*N], fill=TMAVA)
    dr.ellipse([15*N, 9*N, 28*N, 21*N], fill=TMAVA)
    dr.polygon([(14*N, 19*N), (18*N, 19*N), (19*N, 28*N),
                (13*N, 28*N)], fill=SVETLA)
    uloz(im, 'memorial_trees')


def jezera():
    im, dr = platno()
    dr.ellipse([3*N, 9*N, 29*N, 24*N], fill=TMAVA)
    dr.arc([6*N, 13*N, 20*N, 19*N], 0, 180, fill=AKCENT, width=N)
    dr.arc([14*N, 16*N, 26*N, 22*N], 0, 180, fill=AKCENT, width=N)
    uloz(im, 'jezera')


def prameny():
    im, dr = platno()
    dr.polygon([(16*N, 3*N), (9*N, 16*N), (23*N, 16*N)], fill=TMAVA)
    dr.ellipse([9*N, 10*N, 23*N, 24*N], fill=TMAVA)
    dr.ellipse([12*N, 14*N, 17*N, 19*N], fill=AKCENT)
    dr.arc([6*N, 22*N, 26*N, 30*N], 0, 180, fill=SVETLA, width=2*N)
    uloz(im, 'prameny')


def propasti():
    im, dr = platno()
    dr.polygon([(5*N, 6*N), (27*N, 6*N), (20*N, 16*N), (16*N, 28*N),
                (12*N, 16*N)], fill=TMAVA)
    dr.polygon([(10*N, 8*N), (14*N, 8*N), (15*N, 14*N)], fill=SVETLA)
    uloz(im, 'propasti')


if __name__ == '__main__':
    os.makedirs(VEN, exist_ok=True)
    for fn in (peaks, castles, towers, caves, waterfalls, rocks,
               viewpoints, archaeology, mines, fortifications,
               memorial_trees, jezera, prameny, propasti):
        fn()
    print('ikonek:', len(os.listdir(VEN)))
