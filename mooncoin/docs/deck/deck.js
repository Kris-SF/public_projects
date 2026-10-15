/* ===========================================================================
   The interactive slides.

   Every formula below is copied verbatim out of the game's own source so the
   deck cannot drift from the thing it is teaching:

     imbalance / print     mooncoin/server/engine.js  aggregateOrders, printPrice
     the dice              mooncoin/server/engine.js  resolveDice
     the trend bar         mooncoin/public/app.js     threshold
     option settlement     mooncoin/server/options.js intrinsic, optionPL

   If one of those changes in the game, it has to change here too.
   =========================================================================== */

/* --- the game's arithmetic, lifted ------------------------------------- */

// engine.js aggregateOrders
function aggregate(marketBid, marketOffer, limitBid, limitOffer) {
  const pressure = marketBid - marketOffer;
  const resting = pressure > 0 ? limitOffer : pressure < 0 ? limitBid : 0;
  const absorbed = Math.min(Math.abs(pressure), resting);
  const imbalance = Math.sign(pressure) * (Math.abs(pressure) - absorbed);
  return { pressure, resting, absorbed, imbalance };
}

// engine.js printPrice
function printPrice(lastMark, imbalance) {
  if (imbalance === 0) return lastMark;
  return lastMark + Math.sign(imbalance) * Math.ceil(Math.sqrt(Math.abs(imbalance)));
}

// engine.js resolveDice
function resolveDice(dice, net) {
  const [trendDie, typeDie, a, b] = dice;
  const trend = trendDie + net.trend > 3 ? 1 : -1;
  const type = typeDie + net.mag > 3 ? 'MULTIPLY' : 'ADD';
  return { trend, type, chg: type === 'MULTIPLY' ? a * b * trend : (a + b) * trend };
}

// app.js threshold
function threshold(net) {
  const need = 4 - net;
  if (need <= 1) return { certain: 'hit', need: 1 };
  if (need > 6) return { certain: 'miss', need: 7 };
  return { certain: null, need, chance: Math.round(((7 - need) / 6) * 100) };
}

// options.js intrinsic
const intrinsic = (kind, strike, price) =>
  kind === 'call' ? Math.max(0, price - strike) : Math.max(0, strike - price);

/* --- small helpers ----------------------------------------------------- */

const $ = (id) => document.getElementById(id);
const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'dim');

function paint(el, text, klass) {
  if (!el) return;
  el.textContent = text;
  if (klass !== undefined) el.className = el.className.replace(/\b(up|down|dim|cyan|ind)\b/g, '').trim() + (klass ? ` ${klass}` : '');
}

const OPENING = 100;   // engine.js DEFAULTS.openingPrice

/* --- lab 1: build a round ---------------------------------------------- */

function labRound() {
  const ids = ['r-mb', 'r-ms', 'r-lo', 'r-lb'];
  if (!$('r-mb')) return;

  const draw = () => {
    const [mb, ms, lo, lb] = ids.map((id) => Number($(id).value));
    ids.forEach((id) => paint($(`${id}-v`), String(Number($(id).value))));

    const { pressure, absorbed, imbalance } = aggregate(mb, ms, lb, lo);
    const print = printPrice(OPENING, imbalance);

    paint($('r-imb'), signed(imbalance), cls(imbalance));
    paint($('r-print'), String(print), imbalance === 0 ? 'dim' : 'cyan');

    const says = $('r-says');
    if (pressure === 0) {
      says.innerHTML = mb === 0
        ? 'Nobody demanded anything. Nothing trades and the coin stays put.'
        : `<b>${mb}</b> bought and <b>${ms}</b> sold at market — they cancelled each other out exactly. `
          + 'The coin does not move, however large those numbers get.';
    } else if (imbalance === 0) {
      says.innerHTML = `Pressure of <b>${signed(pressure)}</b>, and the resting book absorbed `
        + `<b>all ${absorbed}</b> of it. A liquid market: the volume went through at the old price.`;
    } else {
      const dir = imbalance > 0 ? 'buy' : 'sell';
      says.innerHTML = `Pressure of <b>${signed(pressure)}</b>, of which the resting book `
        + `absorbed <b>${absorbed}</b>. The leftover <b>${Math.abs(imbalance)}</b> ${dir} orders `
        + `had nobody to trade with, so the price had to move <b>$${Math.abs(print - OPENING)}</b> `
        + 'to find the other side. The house is left holding it.';
    }
  };

  ids.forEach((id) => $(id).addEventListener('input', draw));
  draw();
}

/* --- lab 2: the cost of size ------------------------------------------- */

function labImpact() {
  const svg = $('imp-plot');
  if (!svg) return;

  const W = 640, H = 260, L = 46, R = 14, T = 14, B = 34;
  const MAXI = 50, MAXS = 8;
  const x = (i) => L + (i / MAXI) * (W - L - R);
  const y = (s) => H - B - (s / MAXS) * (H - T - B);

  const grid = [0, 2, 4, 6, 8].map((s) =>
    `<line class="gl" x1="${L}" y1="${y(s)}" x2="${W - R}" y2="${y(s)}"/>`
    + `<text x="${L - 8}" y="${y(s) + 4}" text-anchor="end">$${s}</text>`).join('');
  const ticks = [0, 10, 20, 30, 40, 50].map((i) =>
    `<text x="${x(i)}" y="${H - B + 18}" text-anchor="middle">${i}</text>`).join('');

  let d = '';
  for (let i = 0; i <= MAXI; i++) d += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(printPrice(0, i)).toFixed(1)} `;

  svg.innerHTML = `
    ${grid}${ticks}
    <line class="ax" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"/>
    <line class="ax" x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}"/>
    <text class="al x" x="${(L + W - R) / 2}" y="${H - 3}" text-anchor="middle">IMBALANCE</text>
    <text class="al" x="${L}" y="${T - 2}">THE COIN MOVES</text>
    <path class="curve" d="${d}"/>
    <line id="imp-rule" class="zero" x1="0" y1="${T}" x2="0" y2="${H - B}"/>
    <circle id="imp-dot" class="dot" r="6" cx="0" cy="0"/>`;

  const draw = () => {
    const i = Number($('i-imb').value);
    const slip = printPrice(0, i);
    paint($('i-imb-v'), String(i));
    paint($('i-slip'), `$${slip}`, i === 0 ? 'dim' : 'cyan');
    $('imp-dot').setAttribute('cx', x(i).toFixed(1));
    $('imp-dot').setAttribute('cy', y(slip).toFixed(1));
    $('imp-rule').setAttribute('x1', x(i).toFixed(1));
    $('imp-rule').setAttribute('x2', x(i).toFixed(1));

    const says = $('i-says');
    if (i === 0) {
      says.innerHTML = 'Perfectly matched. The coin prints exactly where it closed yesterday.';
    } else {
      // Cents per coin, not dollars — getting this factor wrong is an easy way
      // to overstate the cost of size by a hundred.
      const cents = Math.round((slip / i) * 100);
      says.innerHTML = `<b>${i}</b> coin${i === 1 ? '' : 's'} of unmatched demand move${i === 1 ? 's' : ''} `
        + `the price <b>$${slip}</b> — about <b>${cents}&cent;</b> per coin.`
        + (i >= 16 ? ' Barely anything. Size is close to free out here.' : '');
    }
  };

  $('i-imb').addEventListener('input', draw);
  draw();
}

/* --- lab 3: the dice --------------------------------------------------- */

function labDice() {
  if (!$('d-trend')) return;

  const draw = () => {
    const netTrend = Number($('d-trend').value);
    const d1 = Number($('d-d1').value);
    const d2 = Number($('d-d2').value);
    const a = Number($('d-a').value);
    const b = Number($('d-b').value);

    paint($('d-trend-v'), signed(netTrend), cls(netTrend));
    paint($('d-d1-v'), String(d1));
    paint($('d-d2-v'), String(d2));
    paint($('d-a-v'), String(a));
    paint($('d-b-v'), String(b));

    const t = threshold(netTrend);
    const { trend, type, chg } = resolveDice([d1, d2, a, b], { trend: netTrend, mag: 0 });

    if (t.certain === 'hit') { paint($('d-need'), 'nothing', 'up'); $('d-odds').innerHTML = '<b>Three net ↑ cards buys the direction outright.</b> Any roll is up.'; }
    else if (t.certain === 'miss') { paint($('d-need'), 'nothing', 'down'); $('d-odds').innerHTML = '<b>Three net ↓ cards buys the direction outright.</b> Any roll is down.'; }
    else {
      paint($('d-need'), `${t.need}+`, netTrend > 0 ? 'up' : netTrend < 0 ? 'down' : 'ind');
      $('d-odds').innerHTML = `A <b>${t.need}</b> or better on one die — <b>${t.chance}%</b> of rolls. `
        + (netTrend === 0 ? 'No cards played: a coin flip.' : `The cards moved that bar from 4 to <b>${t.need}</b>.`);
    }

    paint($('d-chg'), signed(chg), cls(chg));
    $('d-says').innerHTML = `Rolled <b>${d1}</b>${netTrend === 0 ? '' : ` ${signed(netTrend)} = <b>${d1 + netTrend}</b>`} against a bar of 3 → `
      + `<b class="${trend > 0 ? 'up' : 'down'}">${trend > 0 ? 'UP' : 'DOWN'}</b>. `
      + `Size is <b>${a} ${type === 'MULTIPLY' ? '×' : '+'} ${b} = ${type === 'MULTIPLY' ? a * b : a + b}</b>, `
      + `because the volatility die said <b class="${type === 'MULTIPLY' ? 'cyan' : 'dim'}">${type === 'MULTIPLY' ? 'big move' : 'small move'}</b>. `
      + `The coin closes at <b>${OPENING + chg}</b>.`;
  };

  ['d-trend', 'd-d1', 'd-d2', 'd-a', 'd-b'].forEach((id) => $(id).addEventListener('input', draw));
  draw();
}

/* --- lab 4: at expiry -------------------------------------------------- */

function labExpiry() {
  const svg = $('exp-plot');
  if (!svg) return;

  const STRIKE = 100, PREMIUM = 12;
  const W = 640, H = 250, L = 52, R = 14, T = 16, B = 34;
  const MINP = 80, MAXP = 140, SPAN = 40;
  const x = (p) => L + ((p - MINP) / (MAXP - MINP)) * (W - L - R);
  const y = (v) => H - B - ((v + SPAN) / (2 * SPAN)) * (H - T - B);

  let side = 1;

  const grid = [-40, -20, 0, 20, 40].map((v) =>
    `<line class="gl" x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}"/>`
    + `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${signed(v)}</text>`).join('');
  const ticks = [80, 90, 100, 110, 120, 130, 140].map((p) =>
    `<text x="${x(p)}" y="${H - B + 18}" text-anchor="middle">${p}</text>`).join('');

  const draw = () => {
    const px = Number($('e-px').value);
    const pl = (intrinsic('call', STRIKE, px) - PREMIUM) * side;   // options.js optionPL

    const pts = [];
    for (let p = MINP; p <= MAXP; p++) {
      pts.push([x(p), y(Math.max(-SPAN, Math.min(SPAN, (intrinsic('call', STRIKE, p) - PREMIUM) * side)))]);
    }
    const line = pts.map(([a, b], i) => `${i ? 'L' : 'M'}${a.toFixed(1)},${b.toFixed(1)}`).join('');
    // Shade the winning region above the flat line and the losing region below.
    const be = STRIKE + PREMIUM;
    const winFrom = side > 0 ? be : MINP, winTo = side > 0 ? MAXP : be;
    const shade = (from, to, k) => {
      const seg = pts.filter(([a]) => a >= x(from) - 0.01 && a <= x(to) + 0.01);
      if (seg.length < 2) return '';
      return `<path class="${k}" d="M${seg[0][0].toFixed(1)},${y(0).toFixed(1)}`
        + seg.map(([a, b]) => `L${a.toFixed(1)},${b.toFixed(1)}`).join('')
        + `L${seg[seg.length - 1][0].toFixed(1)},${y(0).toFixed(1)}Z"/>`;
    };

    svg.innerHTML = `
      ${grid}${ticks}
      ${shade(winFrom, winTo, 'fillup')}
      ${shade(side > 0 ? MINP : be, side > 0 ? be : MAXP, 'filldown')}
      <line class="ax" x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"/>
      <line class="zero" x1="${L}" y1="${y(0)}" x2="${W - R}" y2="${y(0)}"/>
      <line class="gl" x1="${x(STRIKE)}" y1="${T}" x2="${x(STRIKE)}" y2="${H - B}"/>
      <text class="al" x="${x(STRIKE) + 6}" y="${T + 9}">STRIKE</text>
      <text class="al x" x="${(L + W - R) / 2}" y="${H - 3}" text-anchor="middle">WHERE THE COIN CLOSED</text>
      <text class="al" x="${L}" y="${T - 4}">YOUR P/L</text>
      <path class="payoff" d="${line}"/>
      <line class="zero" x1="${x(px).toFixed(1)}" y1="${T}" x2="${x(px).toFixed(1)}" y2="${H - B}"/>
      <circle class="dot" r="6" cx="${x(px).toFixed(1)}" cy="${y(Math.max(-SPAN, Math.min(SPAN, pl))).toFixed(1)}"/>`;

    paint($('e-px-v'), `$${px}`);
    paint($('e-pl'), signed(pl), cls(pl));

    const worth = intrinsic('call', STRIKE, px);
    const says = $('e-says');
    if (side > 0) {
      says.innerHTML = worth === 0
        ? `Closed <b>below ${STRIKE}</b>, so the call expires. You lose the `
          + `<b>${PREMIUM}</b> you paid — <b>and that is the floor</b>, however far it falls.`
        : `You take <b>one coin at ${STRIKE}</b>, now worth ${px}: <b>${worth}</b> to the good, `
          + `less the <b>${PREMIUM}</b> you paid. `
          + (pl === 0 ? '<b>Exactly break-even</b> — this is the line.' : pl > 0
            ? 'Past break-even, and from here <b>there is no ceiling</b>.'
            : 'It paid out, but not enough to cover the premium.');
    } else {
      says.innerHTML = worth === 0
        ? `Expired worthless. You <b>keep the whole ${PREMIUM}</b> — and that is the most you `
          + 'can ever make on this trade.'
        : `You deliver <b>one coin at ${STRIKE}</b> that is worth ${px} — <b>${worth}</b> `
          + `against you — having collected <b>${PREMIUM}</b>. `
          + (pl >= 0 ? 'Still ahead, just.' : '<b>And this loss has no floor.</b> Every dollar higher costs you another.');
    }
    $('e-pl').previousElementSibling.textContent = side > 0
      ? `Bought the $${STRIKE} call for $${PREMIUM}`
      : `Sold the $${STRIKE} call for $${PREMIUM}`;
  };

  $('e-px').addEventListener('input', draw);
  $('e-side').querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      side = Number(b.dataset.side);
      $('e-side').querySelectorAll('button').forEach((o) => o.classList.toggle('on', o === b));
      draw();
    });
  });
  draw();
}

/* --- go ---------------------------------------------------------------- */

function boot() {
  labRound();
  labImpact();
  labDice();
  labExpiry();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
