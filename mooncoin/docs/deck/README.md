# How to play — the deck

`public/how-to-play.html` is one self-contained file: reveal.js, the stylesheet,
the fonts and every slide are inlined, nothing is fetched at runtime, and it
opens from a file:// path with no server. `public/how-to-play.pdf` is the same
twenty slides exported one page each. Both are built from the sources here.

The point of the build step is that **no figure on a slide is typed by hand.**
`compute.mjs` imports the game's own `server/engine.js` and `server/options.js`,
runs the worked examples through them, and writes `numbers.json`; every `{{…}}`
in `slides.html` is an expression evaluated against that file, and an expression
that does not resolve fails the build rather than printing a blank. The inputs to
each example are recorded alongside its output (`auctionIn`, `walkIn`, `crowdIn`)
so the prose quotes the same numbers the engine was handed.

The four interactive slides re-implement four functions in `deck.js` —
`aggregateOrders`, `printPrice`, `resolveDice` and `intrinsic` — copied verbatim
from the game, because the deck cannot import ES modules from a `file://` page
without a server. **If one of those changes in the game it has to change here
too**; the copies are commented with where they came from.

## Building

```sh
# once: reveal.js 5.x, unpacked into vendor/
npm pack reveal.js@5.2.1 && tar xzf reveal.js-5.2.1.tgz
mkdir -p vendor && cp package/dist/{reset.css,reveal.css,reveal.js} vendor/ \
  && cp package/plugin/notes/notes.js vendor/ && rm -rf package reveal.js-5.2.1.tgz

# once: static font weights (Chromium cannot embed a variable font in a PDF —
# it silently falls back to Type3 outlines and the export loses selectable text)
pip install fonttools brotli && python3 instance.py

node compute.mjs > numbers.json
node build.mjs                       # → public/how-to-play.html
```

The PDF is `public/how-to-play.html?print-pdf` printed at 1280×720 with
backgrounds on and zero margins.

## Files

| | |
|---|---|
| `slides.html` | the twenty slides, with `{{…}}` where a number goes |
| `theme.css`   | the game's palette and type, carried over token for token |
| `deck.js`     | the four interactive slides |
| `compute.mjs` | runs the game's engine to produce `numbers.json` |
| `build.mjs`   | substitutes the numbers and inlines everything |
| `instance.py` | flattens the variable fonts to static weights |

`numbers.json`, `fonts/` and `vendor/` are generated and not committed.
