"""
Flatten the game's variable fonts into static weights.

Chromium cannot embed a variable font into a PDF — it falls back to Type3
outline fonts, which render correctly but leave the exported deck with no
selectable or searchable text. Static instances embed as real TrueType subsets,
and the export drops from ~1.4 MB to ~790 KB.

Weights match what theme.css actually asks for; an unused face is 20 KB of
base64 in a file whose whole point is that it carries everything it needs.
"""
import os
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', '..', 'public', 'fonts')
OUT = os.path.join(HERE, 'fonts')
PLAN = {
    'inter':          [400, 500, 600, 700],
    'jetbrains-mono': [400, 600, 700],
    'lexend':         [400, 500, 600, 700],
}

os.makedirs(OUT, exist_ok=True)
total = 0
for stem, weights in PLAN.items():
    for w in weights:
        f = TTFont(os.path.join(SRC, f'{stem}.woff2'))
        instantiateVariableFont(f, {'wght': w}, inplace=True, updateFontNames=False)
        f.flavor = 'woff2'
        out = os.path.join(OUT, f'{stem}-{w}.woff2')
        f.save(out)
        n = os.path.getsize(out)
        total += n
        print(f'{stem}-{w}.woff2'.ljust(28), f'{n / 1024:6.1f} KB')
print('total'.ljust(28), f'{total / 1024:6.1f} KB')
