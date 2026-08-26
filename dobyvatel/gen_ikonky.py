# -*- coding: utf-8 -*-
u"""Decentní značky druhů vlajek pro webovou mapu (přání 27. 8.:
„jednodušší, tvoje"). Jednobarevné glyfy s bílým lemem, 28 px.

Použití:  python gen_ikonky.py   (z tohoto adresáře)
"""
import os

from PIL import Image, ImageDraw

BARVA = (95, 87, 74, 255)       # tmavá zemitá
LEM = (255, 255, 255, 230)
N = 4                            # nadvzorek
S = 28 * N                       # plátno

VEN = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   'data', 'ikonky')


def platno():
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)


def uloz(im, jmeno):
    im = im.resize((28, 28), Image.LANCZOS)
    im.save(os.path.join(VEN, jmeno + '.webp'), 'WEBP', quality=95)


def obrys_a_vypln(dr, body):
    dr.polygon(body, fill=BARVA, outline=LEM, width=2 * N)


def vrchol():
    im, dr = platno()
    obrys_a_vypln(dr, [(4*N, 24*N), (14*N, 5*N), (24*N, 24*N)])
    uloz(im, 'peaks')


def hrad():
    im, dr = platno()
    # hradba s třemi zuby
    b = [(5*N, 24*N), (5*N, 9*N), (8*N, 9*N), (8*N, 12*N),
         (11*N, 12*N), (11*N, 9*N), (17*N, 9*N), (17*N, 12*N),
         (20*N, 12*N), (20*N, 9*N), (23*N, 9*N), (23*N, 24*N)]
    obrys_a_vypln(dr, b)
    uloz(im, 'castles')


def rozhledna():
    im, dr = platno()
    obrys_a_vypln(dr, [(11*N, 24*N), (13*N, 6*N), (15*N, 6*N),
                       (17*N, 24*N)])
    dr.line([(9*N, 10*N), (19*N, 10*N)], fill=BARVA, width=2*N)
    uloz(im, 'towers')


def jeskyne():
    im, dr = platno()
    dr.pieslice([5*N, 8*N, 23*N, 30*N], 180, 360, fill=BARVA,
                outline=LEM, width=2*N)
    dr.pieslice([10*N, 15*N, 18*N, 27*N], 180, 360,
                fill=(0, 0, 0, 0))
    uloz(im, 'caves')


def vodopad():
    im, dr = platno()
    for x in (10, 14, 18):
        dr.line([(x*N, 7*N), (x*N, 20*N)], fill=BARVA, width=2*N)
    dr.ellipse([7*N, 19*N, 21*N, 25*N], outline=BARVA, width=2*N)
    uloz(im, 'waterfalls')


def skala():
    im, dr = platno()
    obrys_a_vypln(dr, [(4*N, 24*N), (10*N, 10*N), (13*N, 16*N),
                       (18*N, 6*N), (24*N, 24*N)])
    uloz(im, 'rocks')


def vyhlidka():
    im, dr = platno()
    dr.ellipse([6*N, 10*N, 22*N, 20*N], outline=BARVA, width=2*N)
    dr.ellipse([11*N, 12*N, 17*N, 18*N], fill=BARVA)
    uloz(im, 'viewpoints')


def hradiste():
    im, dr = platno()
    dr.ellipse([6*N, 8*N, 22*N, 22*N], outline=BARVA, width=2*N)
    dr.ellipse([10*N, 11*N, 18*N, 19*N], outline=BARVA, width=N)
    uloz(im, 'archaeology')


def stola():
    im, dr = platno()
    dr.pieslice([6*N, 8*N, 22*N, 30*N], 180, 360, outline=BARVA,
                width=2*N)
    dr.line([(9*N, 24*N), (19*N, 24*N)], fill=BARVA, width=2*N)
    dr.line([(11*N, 21*N), (17*N, 21*N)], fill=BARVA, width=N)
    uloz(im, 'mines')


def bunkr():
    im, dr = platno()
    dr.pieslice([5*N, 10*N, 23*N, 30*N], 180, 360, fill=BARVA,
                outline=LEM, width=2*N)
    dr.rectangle([11*N, 18*N, 17*N, 20*N], fill=(255, 255, 255, 200))
    uloz(im, 'fortifications')


def strom():
    im, dr = platno()
    dr.ellipse([7*N, 5*N, 21*N, 18*N], fill=BARVA, outline=LEM,
               width=2*N)
    dr.rectangle([12*N + N, 17*N, 15*N, 24*N], fill=BARVA)
    uloz(im, 'memorial_trees')


def jezero():
    im, dr = platno()
    dr.ellipse([5*N, 11*N, 23*N, 21*N], fill=BARVA, outline=LEM,
               width=2*N)
    uloz(im, 'jezera')


def pramen():
    im, dr = platno()
    # kapka
    dr.pieslice([8*N, 10*N, 20*N, 24*N], 0, 360, fill=BARVA)
    dr.polygon([(14*N, 4*N), (9*N, 15*N), (19*N, 15*N)], fill=BARVA)
    uloz(im, 'prameny')


def propast():
    im, dr = platno()
    obrys_a_vypln(dr, [(6*N, 8*N), (22*N, 8*N), (14*N, 24*N)])
    uloz(im, 'propasti')


if __name__ == '__main__':
    os.makedirs(VEN, exist_ok=True)
    for fn in (vrchol, hrad, rozhledna, jeskyne, vodopad, skala,
               vyhlidka, hradiste, stola, bunkr, strom, jezero,
               pramen, propast):
        fn()
    print('ikonek:', len(os.listdir(VEN)))
