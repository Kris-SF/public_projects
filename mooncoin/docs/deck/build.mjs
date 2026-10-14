/**
 * Assemble the deck into one self-contained file.
 *
 * Every {{expr}} in slides.html is evaluated against numbers.json — the output
 * of running the game's own engine — so no figure on a slide is typed by hand.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, ...p), 'utf8');
const b64 = (...p) => readFileSync(join(...p)).toString('base64');

const n = JSON.parse(read('numbers.json'));

// --- numbers in, by expression -------------------------------------------
let missing = [];
const slides = read('slides.html').replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
  let v;
  try {
    v = Function('n', `with (n) { return (${expr}); }`)(n);
  } catch (e) {
    missing.push(`${expr} — ${e.message}`);
    return '‼';
  }
  if (v === undefined || v === null || Number.isNaN(v)) { missing.push(`${expr} — ${v}`); return '‼'; }
  return String(v);
});
if (missing.length) {
  console.error('Unresolved placeholders:\n  ' + missing.join('\n  '));
  process.exit(1);
}

// --- fonts, inlined so nothing reaches the network -----------------------
// Static instances, not the game's variable files: Chromium cannot embed a
// variable font in a PDF and silently falls back to Type3 outlines, which look
// right but leave the exported deck with no selectable or searchable text.
// `instance.py` flattens the same three families to these weights.
// Only the weights the stylesheet actually asks for — an unused face is 21 KB
// of base64 in a file whose whole point is that it carries everything it needs.
const WEIGHTS = { Inter: [400, 500, 600, 700], 'JetBrains Mono': [400, 600, 700], Lexend: [400, 500, 600, 700] };
const face = (family, weight, file) => `@font-face{font-family:"${family}";font-style:normal;`
  + `font-weight:${weight};font-display:block;`
  + `src:url(data:font/woff2;base64,${b64(here, 'fonts', file)}) format("woff2")}`;

const fonts = [
  ['Inter', 'inter'],
  ['JetBrains Mono', 'jetbrains-mono'],
  ['Lexend', 'lexend'],
].flatMap(([family, stem]) => WEIGHTS[family].map((w) => face(family, w, `${stem}-${w}.woff2`))).join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Market Maker — how to play</title>
<meta name="description" content="How to play Market Maker, by Moontower: the round, the print, the dice, and the option auction.">
<style>
${fonts}
</style>
<style>
${read('vendor', 'reset.css')}
</style>
<style>
${read('vendor', 'reveal.css')}
</style>
<style>
${read('theme.css')}
</style>
</head>
<body>
<div class="reveal">
  <div class="slides">
${slides}
  </div>
</div>
<script>
${read('vendor', 'reveal.js')}
</script>
<script>
${read('vendor', 'notes.js')}
</script>
<script>
Reveal.initialize({
  width: 1280,
  height: 720,
  margin: 0,
  minScale: 0.2,
  maxScale: 1.6,
  hash: true,
  slideNumber: 'c/t',
  controls: true,
  progress: true,
  center: false,
  transition: 'fade',
  transitionSpeed: 'fast',
  backgroundTransition: 'none',
  pdfSeparateFragments: false,
  display: 'flex',
  plugins: [RevealNotes],
});
</script>
<script>
${read('deck.js')}
</script>
</body>
</html>
`;

const out = process.argv[2] ?? join(here, '..', '..', 'public', 'how-to-play.html');
writeFileSync(out, html);
console.log(`${out}  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB  ${(slides.match(/<section/g) || []).length} slides`);
