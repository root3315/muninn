"""Static instances of the deck's variable fonts, for tools/talk-pdf.mjs.

Chrome writes a variable font into a PDF as Type 3 glyph drawings, whose
text layer reads back scrambled (a title's lines interleave letter by
letter). A static instance at each weight the deck uses goes in as an
ordinary embedded font, and its text reads back as set.

    pip install fonttools brotli
    python tools/print-fonts.py
"""
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'public' / 'fonts'
OUT = ROOT / 'tools' / 'print-fonts'

# Every family and weight the deck draws with, in the two subsets it reads.
WEIGHTS = {'unbounded': (500, 600), 'onest': (400, 500, 600), 'jetbrains-mono': (400, 500)}
SUBSETS = ('latin', 'cyrillic')


def main():
    OUT.mkdir(exist_ok=True)
    for family, weights in WEIGHTS.items():
        for subset in SUBSETS:
            for weight in weights:
                font = instantiateVariableFont(TTFont(SOURCE / f'{family}-{subset}.woff2'), {'wght': weight})
                font.flavor = 'woff2'
                font.save(OUT / f'{family}-{subset}-{weight}.woff2')


if __name__ == '__main__':
    main()
