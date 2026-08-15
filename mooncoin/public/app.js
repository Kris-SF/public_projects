/* ===========================================================================
   MOONCOIN TERMINAL — client
   Three surfaces off one socket: player, dashboard, host.
   No framework, no build. State arrives, the screen is redrawn.
   =========================================================================== */

const app = document.getElementById('app');

const S = {
  role: null,        // 'player' | 'dashboard' | 'host'
  code: null,
  state: null,       // shared game state
  me: null,          // private slice, players only
  connected: false,
  error: null,
  notice: null,
  ephemeral: false,   // server has no Redis — state may not survive between requests
  lastSignature: null,   // last payload rendered, so identical polls are no-ops
};

const ui = {
  side: 'BUY',
  qty: '',
  orderType: 'MARKET',
  cards: { up: 0, down: 0, multiply: 0, add: 0 },
  quotes: {},          // contractKey -> { bidPx, bidQty, askPx, askQty }, being typed
  rolling: false,
  name: '',
  joinCode: '',
  busy: false,
  lastMark: null,
  lastRound: null,
  markFlash: null,
};

// --- Utilities -------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'dim');

const money = (n) => {
  const v = Math.round(n);
  const s = Math.abs(v).toLocaleString('en-US');
  return v < 0 ? `-$${s}` : `$${s}`;
};

/**
 * The same amount with the currency symbol set smaller and dimmer, so $112
 * reads as money rather than as a four-character string.
 *
 * Display figures only. In a table the symbol is doing column work, and
 * shrinking it just makes the column ragged.
 */
const moneyHTML = (n) => money(n).replace('$', '<span class="cur">$</span>');

const px = (n, d = 2) => (n === null || n === undefined ? '—' : Number(n).toFixed(d));

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

const seatKey = (code) => `mooncoin:player:${code}`;

const store = {
  /**
   * Seat lookup checks this tab first, then the browser.
   *
   * sessionStorage is per-tab, so two tabs in one browser can hold two
   * different seats — which is what makes testing a table single-handed
   * possible. localStorage is the fallback, and is what puts you back in your
   * own seat after a closed tab, a reload, or a phone that went to sleep.
   */
  playerToken: (code) =>
    sessionStorage.getItem(seatKey(code)) ?? localStorage.getItem(seatKey(code)),
  setPlayerToken: (code, t) => {
    sessionStorage.setItem(seatKey(code), t);
    localStorage.setItem(seatKey(code), t);
  },
  /** Forget this tab's seat only, leaving other tabs undisturbed. */
  forgetSeatInThisTab: (code) => sessionStorage.removeItem(seatKey(code)),

  hostToken: (code) => localStorage.getItem(`mooncoin:host:${code}`),
  setHostToken: (code, t) => localStorage.setItem(`mooncoin:host:${code}`, t),
};

const CARD_META = {
  up: { glyph: '↑', name: 'UP' },
  down: { glyph: '↓', name: 'DOWN' },
  multiply: { glyph: '×', name: 'MULTIPLY' },
  add: { glyph: '+', name: 'ADD' },
};

const PHASE_LABEL = {
  lobby: 'LOBBY',
  orders: 'ORDER ENTRY',
  cards: 'CARD PLAY',
  rolling: 'ROLLING',
  complete: 'CLOSED',
};

/** Impact preview, mirroring the server's printPrice. */
const impactOf = (qty) => (qty === 0 ? 0 : Math.sign(qty) * Math.ceil(Math.sqrt(Math.abs(qty))));

/**
 * What the ticket costs, or earns.
 *
 * Everyone fills at the same print, so the number a market order pays away is
 * the number a resting order collects. Same magnitude, opposite sign — which is
 * why calling it slippage on a limit order is not just the wrong word but the
 * wrong direction.
 *
 * The market side can be previewed exactly; the resting side cannot, because
 * the edge depends on how much flow arrives. Shown symbolically rather than
 * invented.
 */
function orderEconomics(st) {
  const mag = parseInt(ui.qty || '0', 10) || 0;
  const qty = ui.side === 'SELL' ? -mag : mag;

  if (ui.orderType === 'MARKET') {
    const slip = impactOf(qty);
    return {
      fillsLabel: 'Est. print', fillsValue: `${st.mark + slip}`, fillsNote: 'if alone',
      costLabel: 'Your slippage', costValue: signed(slip),
      costClass: slip === 0 ? 'dim' : 'down',
      note: 'Fills for certain, and pays ceil(√imbalance) to do it. More flow the same way makes it worse, resting size on the other side makes it better.',
    };
  }
  return {
    fillsLabel: 'Fills at', fillsValue: `${st.mark}+`, fillsNote: 'or better',
    costLabel: 'Your edge', costValue: '+√imb', costClass: 'up',
    note: 'Rests at last sale and collects exactly what the takers pay — but your own size shrinks the imbalance you are collecting on. Rest less, earn more per share, fill less of it.',
  };
}

// --- Socket ----------------------------------------------------------------

/**
 * Transport: polling.
 *
 * The game is turn-based, so a poll tick is indistinguishable from a push, and
 * it runs on serverless where a socket cannot. Every action posts and gets the
 * resulting state straight back, so whoever acted never waits for a tick — the
 * polling only exists to show you what other people did.
 */
const net = {
  timer: null,
  token: null,
  failures: 0,

  /** Faster while you owe the table an action, slower once you have acted. */
  interval() {
    const st = S.state;
    if (document.hidden) return 10000;
    if (!st) return 1200;
    if (st.phase === 'rolling') return 900;
    const me = S.me;
    const owes = st.phase === 'orders' ? !me?.ordersReady
      : st.phase === 'cards' ? !me?.cardsReady : false;
    if (S.role !== 'player') return 1200;
    return owes ? 1500 : 3000;
  },

  start(tok) {
    this.token = tok ?? this.token;
    this.stop();
    this.tick();
  },

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  },

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), this.interval());
  },

  async tick() {
    try {
      const qs = new URLSearchParams({ code: S.code });
      if (this.token) qs.set('token', this.token);
      const res = await fetch(`/api/game?${qs}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      // Connected before the fold, not after: apply() renders, and an unchanged
      // payload will not redraw again — so setting the flag afterwards leaves
      // the status pill reading Reconnecting over a screen that is plainly live.
      this.failures = 0;
      S.connected = true;
      apply(body);
    } catch (err) {
      this.failures++;
      // One dropped poll is noise; a run of them is worth showing.
      if (this.failures >= 3) {
        S.connected = false;
        render();
      }
    }
    this.schedule();
  },

  /** Post an action and adopt the state it returns. */
  async send(action, extra = {}) {
    try {
      S.error = null;
      const res = await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, code: S.code, token: this.token, ...extra }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      apply(body);
      S.connected = true;
      this.schedule();
      return body;
    } catch (err) {
      S.error = err.message;
      ui.busy = false;
      ui.rolling = false;
      render();
      return null;
    }
  },
};

/**
 * Fold a server payload into local state and redraw.
 *
 * Most poll ticks return exactly what the last one did. Redrawing anyway would
 * tear down and rebuild every node a couple of times a second — which restarts
 * animations, drops hover, and can pull a button out from under a tap that is
 * already on its way down. So an unchanged payload leaves the DOM alone.
 */
function apply(body) {
  const signature = JSON.stringify(body);
  if (signature === S.lastSignature) return;
  S.lastSignature = signature;

  if (body.role) S.role = body.role;
  if (body.ephemeral !== undefined) S.ephemeral = body.ephemeral;

  const prev = S.state?.mark;
  S.state = body.state;
  S.me = body.me ?? null;

  if (prev !== undefined && body.state.mark !== prev) {
    ui.markFlash = body.state.mark > prev ? 'flash-up' : 'flash-down';
    setTimeout(() => { ui.markFlash = null; render(); }, 750);
  }

  // Clear the ticket when the round turns over, and only then — polling redraws
  // constantly, and wiping on each tick would erase a quantity being typed.
  if (ui.lastRound !== null && ui.lastRound !== body.state.round) {
    ui.qty = '';
    ui.cards = { up: 0, down: 0, multiply: 0, add: 0 };
    ui.quotes = {};
  }
  ui.lastRound = body.state.round;

  ui.rolling = false;
  render();
}

// --- Actions ---------------------------------------------------------------

const act = {
  setSide(side) { ui.side = side; render(); },
  setType(t) { ui.orderType = t; render(); },
  setQty(v) { ui.qty = v.replace(/[^0-9]/g, ''); },

  async submitOrder() {
    const mag = parseInt(ui.qty || '0', 10);
    if (!Number.isFinite(mag) || mag < 0) { S.error = 'Enter a quantity'; return render(); }
    const qty = ui.side === 'SELL' ? -mag : mag;
    if (await net.send('order', { qty, orderType: ui.orderType })) {
      await net.send('confirmOrder');
    }
  },

  async passOrder() {
    if (await net.send('order', { qty: 0, orderType: 'LIMIT' })) {
      await net.send('confirmOrder');
    }
  },

  unconfirmOrder() { net.send('unconfirmOrder'); },

  bumpCard(kind, delta) {
    const held = S.me?.hand?.[kind] ?? 0;
    ui.cards[kind] = Math.max(0, Math.min(held, (ui.cards[kind] ?? 0) + delta));
    render();
  },

  async submitCards() {
    if (await net.send('cards', { cards: ui.cards })) {
      await net.send('confirmCards');
    }
  },

  unconfirmCards() { net.send('unconfirmCards'); },

  setQuote(key, field, value) {
    const q = ui.quotes[key] ?? (ui.quotes[key] = {});
    q[field] = value.replace(/[^0-9.]/g, '');
  },

  /** Only send contracts with something on them; blank rows are not orders. */
  async submitQuotes() {
    const st = S.state;
    const quotes = [];
    for (const [key, q] of Object.entries(ui.quotes)) {
      const [expiry, kind, strike] = key.split('|');
      if (Number(expiry) !== st.auction?.expiry) continue;
      const num = (v) => (v === '' || v === undefined ? null : Number(v));
      const row = {
        expiry: Number(expiry), kind, strike: Number(strike),
        bidPx: num(q.bidPx), bidQty: num(q.bidQty) ?? 0,
        askPx: num(q.askPx), askQty: num(q.askQty) ?? 0,
      };
      if (row.bidPx === null && row.askPx === null) continue;
      quotes.push(row);
    }
    if (await net.send('quotes', { quotes })) await net.send('confirmQuotes');
  },

  async passQuotes() {
    if (await net.send('quotes', { quotes: [] })) await net.send('confirmQuotes');
  },

  unconfirmQuotes() { net.send('unconfirmQuotes'); },

  roll() {
    ui.rolling = true;
    render();
    setTimeout(() => net.send('roll'), 420);   // let the tumble register
  },

  start() { net.send('start'); },
  force() { net.send('force'); },
  reset() {
    if (confirm('Reset the game? Every position and hand is wiped. Seats stay.')) {
      net.send('reset');
    }
  },
  kick(playerId, name) {
    if (confirm(`Remove ${name} from the table?`)) net.send('kick', { playerId });
  },
  config(patch) { return net.send('config', { config: patch }); },

  copy(text, label) {
    navigator.clipboard?.writeText(text).then(() => {
      S.notice = `${label} copied`;
      render();
      setTimeout(() => { S.notice = null; render(); }, 1600);
    });
  },
};

// --- Shared chrome ---------------------------------------------------------

function topbar(extra = '') {
  const st = S.state;
  // Off a table there is nothing to be connected to, so the status says nothing
  // rather than crying reconnecting at the front door.
  const conn = !S.code ? ''
    : S.connected ? '<span class="chip live">Live</span>'
    : '<span class="chip off">Reconnecting</span>';
  const round = st && st.round > 0 ? `R${st.round}/${st.maxRounds}` : '';
  return `
    <div class="topbar">
      <span class="brand">Mooncoin</span>
      ${S.code ? `<span class="chip">${esc(S.code)}</span>` : ''}
      ${round ? `<span>${esc(round)}</span>` : ''}
      <span class="phase">${esc(st ? PHASE_LABEL[st.phase] : '')}</span>
      ${extra}
      <span class="spacer"></span>
      ${conn}
    </div>`;
}

function alerts() {
  // On serverless with no Redis, consecutive requests can hit different
  // instances holding different games. Say so rather than let the table behave
  // like it is haunted.
  const local = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  const ephemeral = S.ephemeral && !local
    ? `<div class="err">No datastore connected — tables will not survive between
       requests here. Add a Redis integration in the Vercel project settings.</div>`
    : '';
  return `
    ${ephemeral}
    ${S.error ? `<div class="err">${esc(S.error)}</div>` : ''}
    ${S.notice ? `<div class="ok">${esc(S.notice)}</div>` : ''}`;
}

/** The mark's path so far — the opening print, then every settled round. */
const markPath = (st) => [st.openingPrice, ...st.history.map((h) => h.mark)];

/**
 * A price path beside the price.
 *
 * The single most useful thing you can put next to a number is where it has
 * been, and at this size it costs nothing. It also teaches the regime rule
 * quietly, because a streak is visible as a shape before anyone works out the
 * arithmetic behind it.
 */
function sparkline(values, w = 52, h = 20) {
  const pts = values.slice(-6);
  if (pts.length < 2) return '';

  const lo = Math.min(...pts);
  const span = Math.max(...pts) - lo || 1;
  const xy = pts.map((v, i) => [
    (i / (pts.length - 1)) * w,
    h - 2 - ((v - lo) / span) * (h - 4),
  ]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const [ex, ey] = xy[xy.length - 1];

  return `
    <svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <path d="${line} L${w} ${h} L0 ${h} Z" fill="rgba(131,140,255,.13)"/>
      <path d="${line}" fill="none" stroke="#838CFF" stroke-width="1.5"
            stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="${(h / 9).toFixed(1)}" fill="#838CFF"/>
    </svg>`;
}

function ladder(book) {
  const b = book ?? { limitBid: 0, marketBid: 0, imbalance: 0, marketOffer: 0, limitOffer: 0 };
  const cell = (label, qty, kind) => `
    <div class="${kind}">
      <div class="label">${label}</div>
      <div class="qty">${qty}</div>
    </div>`;
  return `
    <div class="ladder">
      ${cell('Limit Bid', b.limitBid, 'bid')}
      ${cell('Market Bid', b.marketBid, 'bid')}
      <div class="imb">
        <div class="label">Imbalance</div>
        <div class="qty ${cls(b.imbalance)}">${signed(b.imbalance)}</div>
      </div>
      ${cell('Market Offer', b.marketOffer, 'offer')}
      ${cell('Limit Offer', b.limitOffer, 'offer')}
    </div>`;
}

/**
 * The dice, decomposed.
 *
 * A die on its own tells you nothing — what matters is the roll plus whatever
 * the cards and the regime added, measured against the threshold. And since
 * that modifier is settled before anything is thrown, the requirement can be
 * stated up front: knowing you need a 2 or better is worth far more than being
 * told afterwards what happened.
 */

const DICE = [
  {
    cap: 'Trend die', mod: 'trend',
    hit: 'UP', miss: 'DOWN',
    hitMeans: 'price rises', missMeans: 'price falls',
    hitClass: 'up', missClass: 'down',
  },
  {
    cap: 'Volatility die', mod: 'mag',
    hit: 'BIG MOVE', miss: 'SMALL MOVE',
    hitMeans: 'size is A × B', missMeans: 'size is A + B',
    hitClass: 'cyan', missClass: 'dim',
  },
  { cap: 'Size A', mod: null, means: 'feeds the size of the move' },
  { cap: 'Size B', mod: null, means: 'feeds the size of the move' },
];

/** What this die must roll to land on the upside outcome. */
function threshold(net) {
  const need = 4 - net;              // engine: die + net > 3
  if (need <= 1) return { certain: 'hit', need: 1 };
  if (need > 6) return { certain: 'miss', need: 7 };
  return { certain: null, need, chance: Math.round(((7 - need) / 6) * 100) };
}

/** One die: the roll, the arithmetic, and the plain-English consequence. */
function dieCard(spec, value, net, state) {
  const t = spec.mod ? threshold(net) : null;
  const locked = value !== null && value !== undefined;
  const hit = locked && t ? value >= t.need : null;

  const klass = ['n-die', locked ? 'locked' : 'empty', state].filter(Boolean).join(' ');

  // Not yet thrown: say what it needs, so the roll has stakes.
  if (!locked) {
    const ask = !t ? '<span class="dim">sets the size</span>'
      : t.certain === 'hit' ? `<span class="${spec.hitClass}">locked in — any roll is ${spec.hit}</span>`
      : t.certain === 'miss' ? `<span class="${spec.missClass}">locked in — any roll is ${spec.miss}</span>`
      : `needs <b>${t.need}+</b> for <span class="${spec.hitClass}">${spec.hit}</span>`;
    return `
      <div class="${klass}">
        <div class="n-die-cap">${spec.cap}</div>
        <div class="n-pip">${state === 'rolling' ? '?' : '·'}</div>
        <div class="n-die-ask">${ask}</div>
        ${t && !t.certain && net !== 0 ? `<div class="n-die-mod">cards ${signed(net)}</div>` : ''}
      </div>`;
  }

  // Thrown: show roll + modifier against the bar, then what it means.
  if (!spec.mod) {
    return `
      <div class="${klass}">
        <div class="n-die-cap">${spec.cap}</div>
        <div class="n-pip">${value}</div>
        <div class="n-die-ask dim">${spec.means}</div>
      </div>`;
  }

  const total = value + net;
  return `
    <div class="${klass} ${hit ? spec.hitClass : spec.missClass}">
      <div class="n-die-cap">${spec.cap}</div>
      <div class="n-pip">${value}</div>
      ${/* Two consistent framings exist and mixing them is nonsense: either the
           raw die against an adjusted bar, or the adjusted total against the
           fixed bar of 3. Pre-roll uses the first ("needs 3+ to roll"), because
           that is the question you are asking. Here we use the second. */ ''}
      <div class="n-die-sum">
        ${value}${net === 0 ? '' : ` <span class="${cls(net)}">${signed(net)}</span> = <b>${total}</b>`}
        <i>vs 3</i>
      </div>
      <div class="n-die-verdict ${hit ? spec.hitClass : spec.missClass}">
        ${hit ? spec.hit : spec.miss}
      </div>
      <div class="n-die-ask dim">${hit ? spec.hitMeans : spec.missMeans}</div>
    </div>`;
}

/**
 * The full board. `view` carries the dice, the modifiers that were in force,
 * and — once the round has settled — the outcome, so the same component serves
 * the live roll and the post-mortem.
 */
function diceBoard(view) {
  const { dice, net, live, rollStep, resolved, priorMark, yours } = view;

  const cards = DICE.map((spec, i) => {
    const value = dice[i];
    const isNext = live && value === null && i === rollStep;
    const state = isNext ? (ui.rolling ? 'rolling' : 'next') : '';
    const mod = spec.mod ? (net?.[spec.mod] ?? 0) : 0;
    return dieCard(spec, value, mod, state);
  }).join('');

  let summary = '';
  if (resolved) {
    const { trend, type, chg } = resolved;
    const [, , a, b] = dice;
    const sum = type === 'MULTIPLY' ? `${a} × ${b} = ${a * b}` : `${a} + ${b} = ${a + b}`;
    summary = `
      <div class="n-outcome ${cls(chg)}">
        <span class="${trend > 0 ? 'up' : 'down'}">${trend > 0 ? 'UP' : 'DOWN'}</span>
        <span class="dim">·</span>
        <span>${type === 'MULTIPLY' ? 'BIG MOVE' : 'SMALL MOVE'}</span>
        <span class="dim">${sum}</span>
        <span class="spacer"></span>
        <b>${signed(chg)}</b>
        <span class="dim">${priorMark} →</span>
        <b>${priorMark + chg}</b>
        ${yours !== null && yours !== undefined && yours !== 0
          ? `<span class="n-yours ${cls(yours)}">${yours > 0 ? '+' : ''}${moneyHTML(yours)} to you</span>` : ''}
      </div>`;
  }

  return `<div class="n-dice">${cards}</div>${summary}`;
}

function waitingPills(st, list) {
  if (!st.standings.length) return '<span class="dim">No players seated</span>';
  return `<div class="waiting">${st.standings.map((p) => {
    const late = list.includes(p.name);
    return `<span class="pill ${late ? 'late' : 'ready'}">${late ? '·' : '✓'} ${esc(p.name)}</span>`;
  }).join('')}</div>`;
}

function standingsTable(st, opts = {}) {
  const rows = st.standings.map((p, i) => `
    <tr class="${opts.meId === p.id ? 'me' : ''}">
      <td class="num dim">${i + 1}</td>
      <td class="strong">${esc(p.name)}</td>
      <td class="num ${cls(p.shares)}">${signed(p.shares)}</td>
      <td class="num dim">${p.avgPrice === null ? '—' : px(p.avgPrice)}</td>
      <td class="num strong ${cls(p.pl)}">${money(p.pl)}</td>
      <td class="num dim">${p.cardsLeft}</td>
      ${opts.host ? `<td class="num"><button class="danger" data-kick="${p.id}" data-name="${esc(p.name)}">×</button></td>` : ''}
    </tr>`).join('');

  return `
    <div class="scroll-x">
      <table>
        <thead><tr>
          <th class="num">#</th><th>Player</th><th class="num">Pos</th>
          <th class="num">Avg</th><th class="num">P/L</th><th class="num">Cards</th>
          ${opts.host ? '<th></th>' : ''}
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="dim">No players seated</td></tr>'}</tbody>
      </table>
    </div>`;
}

function historyTable(st) {
  if (!st.history.length) {
    return '<div class="body dim">No rounds settled yet.</div>';
  }
  const rows = st.history.slice().reverse().map((h) => `
    <tr>
      <td class="num strong">${h.round}</td>
      <td class="num dim">${h.limitBid}</td>
      <td class="num up">${h.marketBid}</td>
      <td class="num strong ${cls(h.imbalance)}">${signed(h.imbalance)}</td>
      <td class="num down">${h.marketOffer}</td>
      <td class="num dim">${h.limitOffer}</td>
      <td class="num strong">${h.print}</td>
      <td class="num dim">${h.dice.join(' ')}</td>
      <td class="num ${cls(h.net.trend)}">${signed(h.net.trend)}</td>
      <td class="num ${cls(h.net.mag)}">${signed(h.net.mag)}</td>
      <td class="${h.type === 'MULTIPLY' ? 'cyan' : 'dim'}">${h.type === 'MULTIPLY' ? 'BIG' : 'SMALL'}</td>
      <td class="num strong ${cls(h.chg)}">${signed(h.chg)}</td>
      <td class="num strong">${h.mark}</td>
    </tr>`).join('');

  return `
    <div class="scroll-x">
      <table>
        <thead><tr>
          <th class="num">R</th><th class="num">LB</th><th class="num">MB</th>
          <th class="num">IMB</th><th class="num">MO</th><th class="num">LO</th>
          <th class="num">Print</th><th class="num">Dice</th>
          ${/* These two are the card-and-regime modifiers fed to each die, not
               outcomes — named for the dice they push so the link is obvious. */ ''}
          <th class="num">Trend&plusmn;</th><th class="num">Vol&plusmn;</th><th>Move</th>
          <th class="num">Chg</th><th class="num">Mark</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function tape(st) {
  return `<div class="tape">${st.log.slice().reverse().map((l) => `
    <div><span class="t">R${l.round}</span>${esc(l.text)}</div>`).join('')}</div>`;
}

// --- Home ------------------------------------------------------------------

function renderHome() {
  app.innerHTML = `
    ${topbar()}
    <div class="home">
      <div class="brand">
        <div class="logo">MOONCOIN</div>
        <div class="sub">TERMINAL</div>
        <div class="rule"></div>
      </div>
      ${alerts()}
      <div class="stack">
        <div class="panel">
          <header>Join a table</header>
          <div class="body">
            <label class="field">
              <span>Room code</span>
              <input id="joinCode" class="code-in" maxlength="4" autocomplete="off"
                     autocapitalize="characters" placeholder="————"
                     value="${esc(ui.joinCode)}">
            </label>
            <button class="primary wide lg" id="joinBtn">Enter</button>
          </div>
        </div>
        <div class="panel ghost">
          <header>Run a table</header>
          <div class="body">
            <p class="dim" style="margin-top:0">
              Opens a new room. You get the host console, the dashboard for the big
              screen, and a code for the players.
            </p>
            <button class="wide lg" id="createBtn" ${ui.busy ? 'disabled' : ''}>
              ${ui.busy ? 'Opening…' : 'New table'}
            </button>
          </div>
        </div>
      </div>
    </div>`;

  const code = document.getElementById('joinCode');
  code.oninput = (e) => { ui.joinCode = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); e.target.value = ui.joinCode; };
  code.onkeydown = (e) => { if (e.key === 'Enter') go(); };

  const go = () => {
    if (ui.joinCode.length !== 4) { S.error = 'Room codes are four characters'; return render(); }
    location.href = `/${ui.joinCode}`;
  };
  document.getElementById('joinBtn').onclick = go;

  document.getElementById('createBtn').onclick = async () => {
    ui.busy = true; render();
    try {
      const res = await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create' }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not open a table');
      store.setHostToken(body.code, body.hostToken);
      location.href = `/${body.code}#host`;
    } catch (err) {
      S.error = err.message;
      ui.busy = false;
      render();
    }
  };
}

// --- Player: name prompt ---------------------------------------------------

function renderJoin() {
  app.innerHTML = `
    ${topbar()}
    <div class="home">
      <div class="brand">
        <div class="logo">MOONCOIN</div>
        <div class="sub">TABLE ${esc(S.code)}</div>
        <div class="rule"></div>
      </div>
      ${alerts()}
      <div class="panel">
        <header>Take a seat</header>
        <div class="body">
          <label class="field">
            <span>Trader name</span>
            <input id="name" maxlength="20" autocomplete="off" placeholder="KRIS" value="${esc(ui.name)}">
          </label>
          <button class="primary wide lg" id="sit">Sit down</button>
        </div>
      </div>
      <div class="row" style="margin-top:8px;justify-content:center">
        <a href="/${esc(S.code)}#dashboard" class="dim">Open the dashboard instead</a>
      </div>
    </div>`;

  const input = document.getElementById('name');
  input.oninput = (e) => { ui.name = e.target.value; };
  input.onkeydown = (e) => { if (e.key === 'Enter') sit(); };
  input.focus();

  const sit = async () => {
    if (!ui.name.trim()) { S.error = 'Name required'; return render(); }
    const res = await net.send('join', { name: ui.name.trim() });
    if (!res) return;
    store.setPlayerToken(S.code, res.playerToken);
    net.start(res.playerToken);
  };
  document.getElementById('sit').onclick = sit;
}

// --- Player terminal -------------------------------------------------------

/**
 * Did this fill pay the print, or collect it?
 *
 * Measured against the mark the round opened on — the number the print was
 * struck from. Buying above it is slippage paid; selling above it is edge
 * collected. Positive is always good for the holder of the fill, whichever
 * side they were on.
 *
 * A fill in the round currently being played has not settled yet, so there is
 * no history row for it; the live mark is still the pre-dice mark, which is
 * exactly the right reference.
 */
function fillEdge(fill) {
  const opened = S.state.history.find((h) => h.round === fill.round)?.priorMark ?? S.state.mark;
  const perShare = (opened - fill.price) * Math.sign(fill.qty);
  return { perShare, dollars: perShare * Math.abs(fill.qty) };
}

function blotter(me) {
  if (!me.fills.length) return '<div class="body dim">No fills yet.</div>';
  return `
    <div class="scroll-x">
      <table>
        <thead><tr>
          <th class="num">R</th><th class="num">Qty</th><th class="num">Price</th>
          <th class="num">Edge/Slip</th><th class="num">P/L</th>
        </tr></thead>
        <tbody>${me.fills.slice().reverse().map((f) => {
          const pl = (S.state.mark - f.price) * f.qty;
          const e = fillEdge(f);
          return `<tr>
            <td class="num dim">${f.round}</td>
            <td class="num ${cls(f.qty)}">${signed(f.qty)}</td>
            <td class="num">${f.price}</td>
            <td class="num ${cls(e.perShare)}">${
              e.perShare === 0 ? 'flat'
                : `${signed(e.perShare)}<span class="dim"> · ${e.dollars > 0 ? '+' : ''}${money(e.dollars)}</span>`
            }</td>
            <td class="num ${cls(pl)}">${money(pl)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <div class="n-legend">
      <span class="up">Positive</span> is edge — you rested and the print came to you.
      <span class="down">Negative</span> is slippage — you crossed and paid for it.
      Measured against the mark the round opened on.
    </div>`;
}

function wirePlayer() {
  const qty = document.getElementById('qty');
  if (qty) {
    // Redraw on every keystroke so the slippage preview tracks the size. The
    // caret survives because render() restores it.
    qty.oninput = (e) => {
      act.setQty(e.target.value);
      e.target.value = ui.qty;
      render();
    };
    qty.onkeydown = (e) => { if (e.key === 'Enter') act.submitOrder(); };
  }

  document.querySelectorAll('[data-side]').forEach((b) => {
    b.onclick = () => act.setSide(b.dataset.side);
  });
  document.querySelectorAll('[data-otype]').forEach((b) => {
    b.onclick = () => act.setType(b.dataset.otype);
  });
  document.querySelectorAll('[data-card]').forEach((b) => {
    b.onclick = () => act.bumpCard(b.dataset.card, Number(b.dataset.delta));
  });

  document.querySelectorAll('[data-q]').forEach((el) => {
    el.oninput = (e) => act.setQuote(el.dataset.q, el.dataset.f, e.target.value);
  });

  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('submitQuotes', act.submitQuotes);
  on('passQuotes', act.passQuotes);
  on('unconfirmQuotes', act.unconfirmQuotes);
  on('submitOrder', act.submitOrder);
  on('pass', act.passOrder);
  on('unconfirmOrder', act.unconfirmOrder);
  on('submitCards', act.submitCards);
  on('unconfirmCards', act.unconfirmCards);
}

// --- Dashboard -------------------------------------------------------------

function wireHost(st, joinUrl) {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('start', () => {
    const rounds = document.getElementById('cfgRounds');
    const cards = document.getElementById('cfgCards');
    if (rounds && cards) {
      act.config({ maxRounds: Number(rounds.value), cardQty: Number(cards.value) });
    }
    setTimeout(act.start, 60);   // let the config land before the deal
  });
  on('cfgOptionsOn', () => act.config({ options: true }));
  on('cfgOptionsOff', () => act.config({ options: false }));

  document.querySelectorAll('[data-expiry]').forEach((b) => {
    b.onclick = () => {
      const r = Number(b.dataset.expiry);
      const now = new Set(st.expiries ?? []);
      now.has(r) ? now.delete(r) : now.add(r);
      act.config({ optionRules: { fixedExpiries: [...now] } });
    };
  });

  // The chips are drawn from the game length, so it has to commit as it is
  // typed rather than waiting for the market to open.
  const rounds = document.getElementById('cfgRounds');
  if (rounds) rounds.onchange = () => act.config({ maxRounds: Number(rounds.value) });
  on('force', act.force);
  on('roll', act.roll);
  on('reset', act.reset);
  on('copyJoin', () => act.copy(joinUrl, 'Join link'));
  on('openDash', () => window.open(`/${st.code}#dashboard`, '_blank'));
  on('addSeat', () => window.open(`/${st.code}?new=1`, '_blank'));

  document.querySelectorAll('[data-kick]').forEach((b) => {
    b.onclick = () => act.kick(b.dataset.kick, b.dataset.name);
  });
}

// ===========================================================================
// NEXT SKIN
//
// Player: density over decoration. No inverse header bars — hierarchy comes
// from thin rules and dim caps labels, the way a terminal actually does it,
// which frees the one bright fill on screen to mean "this is what we are all
// waiting for". Everything fits without scrolling.
//
// Dashboard: built to be read across a room. The mark and the imbalance carry
// the size; the flow line under the ladder shows the arithmetic that produced
// the print, so the table learns the mechanic while playing.
// ===========================================================================

/** Section divider: a rule, a dim label, and an optional right-hand status. */
function rule(label, right = '') {
  return `<div class="n-rule"><span>${label}</span><span>${right}</span></div>`;
}

/**
 * The standing readout, with a second line under every figure.
 *
 * Nothing here is newly computed — long/short, the fill count and the rank are
 * all on screen already, further down. Bringing them up means the strip answers
 * "how am I doing" without a scroll.
 */
function positionStrip(st, me) {
  const rank = st.standings.findIndex((p) => p.id === me.id) + 1;
  const chg = st.history.length ? st.history[st.history.length - 1].chg : null;
  const fills = me.fills.length;

  return `
    <div class="n-strip">
      <div>
        <div class="n-lab">Mark</div>
        <div class="markcell">
          <div class="n-v ${ui.markFlash ?? ''}">${st.mark}</div>
          ${sparkline(markPath(st))}
        </div>
        <div class="n-sub ${chg === null ? '' : cls(chg)}">
          ${chg === null ? 'opening' : `${signed(chg)} last round`}</div>
      </div>
      <div>
        <div class="n-lab">Position</div>
        <div class="n-v ${cls(me.shares)}">${signed(me.shares)}</div>
        <div class="n-sub">${me.shares > 0 ? 'long' : me.shares < 0 ? 'short' : 'flat'}</div>
      </div>
      <div>
        <div class="n-lab">Avg</div>
        <div class="n-v">${me.avgPrice === null ? '—' : px(me.avgPrice)}</div>
        <div class="n-sub">${fills} fill${fills === 1 ? '' : 's'}</div>
      </div>
      <div>
        <div class="n-lab">P/L</div>
        <div class="n-v ${cls(me.pl)}">${moneyHTML(me.pl)}</div>
        <div class="n-sub">${rank ? `${ordinal(rank)} of ${st.seated}` : '—'}</div>
      </div>
    </div>`;
}

function orderTicket(st, me) {
  if (me.ordersReady) {
    const o = me.pendingOrder;
    const side = o.qty > 0 ? 'BUY' : o.qty < 0 ? 'SELL' : 'PASS';
    return `
      <div class="n-act done">
        <div class="n-done">
          <span class="${o.qty > 0 ? 'up' : o.qty < 0 ? 'down' : 'dim'}">${side}</span>
          ${o.qty === 0 ? '' : `<span class="strong">${Math.abs(o.qty)}</span><span class="dim">${o.type}</span>`}
          <span class="spacer"></span>
          <span class="dim tiny">In</span>
        </div>
        <button id="unconfirmOrder" class="wide">Pull it back</button>
      </div>`;
  }

  const e = orderEconomics(st);
  return `
    <div class="n-act">
      ${/* One decision, one control: a two-state choice belongs in a single
            track, and the secondary choice is set smaller so it does not
            compete with the primary one. */ ''}
      <div class="n-seg">
        <button class="buy ${ui.side === 'BUY' ? 'on' : ''}" data-side="BUY">Buy</button>
        <button class="sell ${ui.side === 'SELL' ? 'on' : ''}" data-side="SELL">Sell</button>
      </div>
      <input id="qty" class="n-qty" inputmode="numeric" autocomplete="off"
             placeholder="0" value="${esc(ui.qty)}" aria-label="Quantity">
      <div class="n-seg mode">
        <button class="${ui.orderType === 'MARKET' ? 'on' : ''}" data-otype="MARKET">Market</button>
        <button class="${ui.orderType === 'LIMIT' ? 'on' : ''}" data-otype="LIMIT">Limit</button>
      </div>
      ${/* A ledger, not a sentence: labels left, figures right-aligned in a
            column you can read down. */ ''}
      <div class="n-econ">
        <span class="k">${e.fillsLabel} <i>${e.fillsNote}</i></span>
        <span class="val">${e.fillsValue}</span>
        <span class="k">${e.costLabel}</span>
        <span class="val ${e.costClass}">${e.costValue}</span>
      </div>
      <button class="primary n-go" id="submitOrder">Confirm</button>
      <button id="pass" class="wide n-pass">Pass this round</button>
      <p class="n-note">${e.note}</p>
    </div>`;
}

function cardTicket(st, me) {
  if (me.cardsReady) {
    const c = me.pendingCards ?? { up: 0, down: 0, multiply: 0, add: 0 };
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    return `
      <div class="n-act done">
        <div class="n-done">
          <span class="strong">${total === 0
            ? 'Holding everything'
            : Object.entries(c).filter(([, n]) => n > 0).map(([k, n]) => `${n}${CARD_META[k].glyph}`).join('  ')}</span>
          <span class="spacer"></span><span class="dim tiny">In</span>
        </div>
        <button id="unconfirmCards" class="wide">Take them back</button>
      </div>`;
  }

  return `
    <div class="n-act">
      <div class="n-cards">
        ${Object.keys(CARD_META).map((k) => {
          const held = me.hand[k], picked = ui.cards[k] ?? 0;
          return `
            <div class="n-card ${k} ${held === 0 ? 'spent' : ''}">
              <div class="g">${CARD_META[k].glyph}</div>
              <div class="picked">${picked}</div>
              <div class="held">${held - picked} left</div>
              <div class="split">
                <button data-card="${k}" data-delta="-1" ${picked === 0 ? 'disabled' : ''}>−</button>
                <button data-card="${k}" data-delta="1" ${picked >= held ? 'disabled' : ''}>+</button>
              </div>
            </div>`;
        }).join('')}
      </div>
      <button class="primary n-go" id="submitCards">Confirm cards</button>
      <p class="n-note">↑↓ push the trend die, ×/+ the magnitude die. Three net cards
        decides the direction outright; a fourth buys nothing. Spent either way.</p>
    </div>`;
}

/**
 * The instruction bar.
 *
 * A player should never have to work out whose turn it is. When the table is
 * waiting on you this is a lit block giving an order; when it is not, it drops
 * to a quiet rule that names who is holding things up.
 */
function callToAction(label, right, mine) {
  return mine
    ? `<div class="n-cta">
         <span class="who"><i class="dot"></i>${label}</span>
         <span class="s">${right}</span>
       </div>`
    : `<div class="n-rule wait"><span>${label}</span><span>${right}</span></div>`;
}

/**
 * What the round that just ended did.
 *
 * The server advances the round the instant the fourth die locks, which wipes
 * the dice before anyone can read them — the moment the whole round builds
 * towards vanishes. So the settled round is replayed here, in full, through the
 * next round's order entry. It also happens to be exactly what you want in
 * front of you while deciding the next order, since the regime turns on it.
 */
function lastRoundReplay(st, me) {
  const h = st.history[st.history.length - 1];
  if (!h) return '';
  const yours = me ? me.shares * h.chg : null;
  return `
    ${rule(`Round ${h.round} settled`, `${h.priorMark} → ${h.mark}`)}
    <div class="n-replay">
      ${diceBoard({
        dice: h.dice, net: h.net, live: false, rollStep: -1,
        resolved: { trend: h.trend, type: h.type, chg: h.chg },
        priorMark: h.priorMark, yours,
      })}
    </div>`;
}

// ===========================================================================
// OPTIONS
//
// The board never shows what a contract is worth. Every price on screen was
// discovered by the auction; a contract the auction has not priced shows a dash.
// ===========================================================================

const optKey = (o) => `${o.expiry}|${o.kind}|${o.strike}`;
const optLabel = (o) => `${o.kind === 'call' ? 'Call' : 'Put'} $${o.strike} exp R${o.expiry}`;

/**
 * A contract's name, and the house's side, in deliberately different registers.
 *
 * They were both plain green-or-red text on one line, which meant green said
 * "this is a call" on the left and "the house is buying" on the right — the same
 * colour carrying two unrelated meanings a few inches apart, so the row read as
 * one undifferentiated smear. The name is a quiet tinted badge; the side is a
 * loud filled chip. Same palette, opposite weight, no confusion.
 */
const contractTag = (o) => `
  <span class="o-kind ${o.kind}">${o.kind}</span>
  <span class="o-name"><span class="o-cur">$</span>${o.strike}</span>
  <span class="o-exp">R${o.expiry}</span>`;

const houseFlag = (o) => (o.side
  ? `<span class="o-flag ${o.side === 'BUY' ? 'buy' : 'sell'}">House ${o.side === 'BUY' ? 'buys' : 'sells'}</span>`
  : '<span class="o-flag unknown">Side hidden</span>');

/**
 * Order-flow heat.
 *
 * One heatmap meaning one thing: which way the house is going and how hard.
 * Green for a buyer, red for a seller, intensity by size against the biggest
 * order it can write. An unrevealed order has no size to weigh yet, so it gets
 * the faintest wash — enough to say "something is here" without implying scale.
 */
function heat(order, max) {
  if (!order) return '';
  if (order.side === null) return ' style="background:rgba(88,99,248,.10)"';
  const share = order.qty === null ? 0.18 : 0.10 + 0.42 * Math.min(1, order.qty / max);
  const rgb = order.side === 'BUY' ? '53,208,127' : '255,94,91';
  return ` style="background:rgba(${rgb},${share.toFixed(2)})"`;
}

/** The house's order on a contract: a question mark until its gate closes. */
function houseCell(order) {
  if (!order) return '<span class="o-none">·</span>';
  // Unrevealed: either a plain question mark, or a side the house told you up
  // front with the size still to come.
  if (order.qty === null) {
    return order.side === null
      ? '<span class="o-ask">?</span>'
      : `<span class="${order.side === 'BUY' ? 'up' : 'down'}">${order.side === 'BUY' ? 'B' : 'S'}?</span>`;
  }
  return `<span class="${order.side === 'BUY' ? 'up' : 'down'}">${order.side === 'BUY' ? 'B' : 'S'}${order.qty}</span>`;
}

/**
 * One expiry's montage: calls left, strike spine centre, puts right, strikes
 * increasing downward — the layout a real board uses.
 */
function montage(table, board) {
  const orderAt = (kind, strike) => board.orders.find(
    (o) => o.expiry === table.expiry && o.kind === kind && o.strike === strike);
  const markAt = (kind, strike) => board.marks[`${table.expiry}|${kind}|${strike}`];
  const maxQty = Math.max(10, ...board.orders.map((o) => o.qty ?? 0));

  const rows = table.strikes.map((strike) => {
    const atm = strike === board.anchor;
    const pxCell = (kind) => {
      const v = markAt(kind, strike);
      return `<td class="num o-px">${v === undefined
        ? '<span class="o-none">—</span>'
        : `<span class="o-cur">$</span>${v}`}</td>`;
    };
    const ordCell = (kind) => {
      const o = orderAt(kind, strike);
      return `<td class="o-side"${heat(o, maxQty)}>${houseCell(o)}</td>`;
    };
    // Mirrored around the spine: the order column outermost, the price against
    // the strike, so the two sides read outward from the middle.
    return `
      <tr class="${atm ? 'o-atm' : ''}">
        ${ordCell('call')}${pxCell('call')}
        <td class="o-strike num">${strike}</td>
        ${pxCell('put')}${ordCell('put')}
      </tr>`;
  }).join('');

  return `
    <table class="o-montage">
      <thead>
        <tr>
          <th class="o-side">Ord</th><th class="num">Px</th>
          <th class="num o-strike">Strike</th>
          <th class="num">Px</th><th class="o-side">Ord</th>
        </tr>
        <tr class="o-kinds"><th colspan="2">Calls</th><th></th><th colspan="2">Puts</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/** Every live expiry, stacked. */
function optionBoard(st) {
  const b = st.optionBoard;
  if (!b) return '';
  return `
    ${rule('Option board', `anchored ${b.anchor}`)}
    <div class="o-tables">
      ${b.tables.map((t) => `
        <div class="o-table ${st.auction?.expiry === t.expiry ? 'live' : ''}">
          <div class="o-cap">${esc(t.label)} <span class="dim">expires R${t.expiry}</span>
            ${st.auction?.expiry === t.expiry ? '<span class="o-live">on the block</span>' : ''}</div>
          ${montage(t, b)}
        </div>`).join('')}
    </div>`;
}

/**
 * Quote entry for the expiry on the block.
 *
 * Only contracts carrying a house order are listed, because only those clear —
 * the auction runs one house order at a time, so a quote anywhere else could
 * never trade. Leave a side blank to quote one-way; leave everything blank and
 * confirm to pass.
 */
function quoteTicket(st, me) {
  const b = st.optionBoard;
  const live = b?.quotable ?? [];

  if (me.quotesReady) {
    const n = (me.quotes ?? []).length;
    return `
      <div class="n-act done">
        <div class="n-done">
          <span class="strong">${n ? `${n} market${n === 1 ? '' : 's'} in` : 'Passed'}</span>
          <span class="spacer"></span><span class="dim tiny">In</span>
        </div>
        <button id="unconfirmQuotes" class="wide">Pull them back</button>
      </div>`;
  }

  const saved = new Map((me.quotes ?? []).map((q) => [optKey(q), q]));
  const val = (o, f) => {
    const q = saved.get(optKey(o)) ?? ui.quotes[optKey(o)];
    const v = q?.[f];
    return v === null || v === undefined ? '' : v;
  };

  // Sizes outermost, prices against the middle — the same mirror the montage
  // uses, so a two-sided market reads outward from its own spread.
  const size = (o, f, label) => `
    <input class="o-size" inputmode="numeric" placeholder="size" aria-label="${label}"
           data-q="${optKey(o)}" data-f="${f}" value="${esc(val(o, f))}">`;
  const price = (o, f, label, side) => `
    <div class="o-money ${side}">
      <span class="o-cur">$</span>
      <input class="o-price" inputmode="decimal" placeholder="0" aria-label="${label}"
             data-q="${optKey(o)}" data-f="${f}" value="${esc(val(o, f))}">
    </div>`;

  const rows = live.map((o) => `
    <div class="o-quote">
      <div class="o-quote-cap">
        ${contractTag(o)}
        <span class="spacer"></span>
        ${houseFlag(o)}
      </div>
      <div class="o-quote-grid">
        ${size(o, 'bidQty', `${optLabel(o)} bid size`)}
        ${price(o, 'bidPx', `${optLabel(o)} bid`, 'bid')}
        ${price(o, 'askPx', `${optLabel(o)} ask`, 'ask')}
        ${size(o, 'askQty', `${optLabel(o)} ask size`)}
      </div>
    </div>`).join('');

  return `
    <div class="n-act">
      ${live.length ? `
        <div class="o-quote-legend">
          <span>bid size</span><span class="up">your bid</span>
          <span class="down">your ask</span><span>ask size</span>
        </div>
        ${rows}` : '<p class="n-note">No orders on this expiry.</p>'}
      <button class="primary n-go" id="submitQuotes">Confirm markets</button>
      <button id="passQuotes" class="wide n-pass">Pass this expiry</button>
      <p class="n-note">Where the side is hidden you are making a market, not filling
        an order — which way the house is going is settled when the gate closes. Size is
        always hidden. Leave a side blank to quote one-way.</p>
    </div>`;
}

/**
 * Pick which rounds carry an expiry.
 *
 * The current round always expires — the front month is a pure bet on one dice
 * roll and it is what the layer is built to teach — so these chips are the
 * longer-dated ones stacked on top of it. Underneath, what that actually costs:
 * each live table is a gate the whole table has to clear, and the count tapers
 * on its own as expiries pass.
 */
function expiryPicker(st) {
  const picked = new Set(st.expiries ?? []);
  const chips = [];
  for (let r = 2; r <= st.maxRounds; r++) {
    chips.push(`<button class="o-chip ${picked.has(r) ? 'on' : ''}" data-expiry="${r}">R${r}</button>`);
  }

  // How many auction gates each round will actually carry. That is the cost of
  // a pick, and it is the thing that decides whether a round drags.
  const gates = [];
  let worst = 1;
  for (let r = 1; r <= st.maxRounds; r++) {
    const n = 1 + [...picked].filter((e) => e > r).length;
    worst = Math.max(worst, n);
    gates.push(`<span class="o-gate"><i>R${r}</i>${n}</span>`);
  }

  return `
    <div>
      <span class="n-lab">Expiries — the current round always expires</span>
      <div class="o-chips">${chips.join('') || '<span class="dim">a one-round game</span>'}</div>
      <div class="o-plan">
        <span class="n-lab">Auction gates per round</span>
        <div class="o-gates">${gates.join('')}</div>
      </div>
      <p class="n-note">Options trade first each round, and every live expiry is
        its own gate — so your longest round runs ${worst} auction gate${worst === 1 ? '' : 's'}
        before the stock even opens.</p>
    </div>`;
}

/** The player's own option book: open contracts, then what has expired. */
function optionBlotter(me, st) {
  const open = me.optionPositions ?? [];
  const settled = me.settledOptions ?? [];
  const marks = st.optionBoard?.marks ?? {};

  const net = new Map();
  for (const p of open) {
    const k = optKey(p);
    const r = net.get(k) ?? { ...p, qty: 0, cost: 0 };
    r.qty += p.qty; r.cost += p.premium * p.qty;
    net.set(k, r);
  }
  const rows = [...net.values()].filter((r) => r.qty !== 0);

  return `
    ${rule('Your options', `${rows.length} open · ${settled.length} settled`)}
    ${rows.length ? `<div class="scroll-x"><table>
      <thead><tr><th>Contract</th><th class="num">Qty</th><th class="num">Avg</th>
        <th class="num">Mark</th><th class="num">P/L</th></tr></thead>
      <tbody>${rows.map((r) => {
        const avg = r.cost / r.qty;
        const mk = marks[optKey(r)];
        const pl = mk === undefined ? 0 : (mk - avg) * r.qty;
        return `<tr>
          <td class="o-contract">${contractTag(r)}</td>
          <td class="num ${cls(r.qty)}">${signed(r.qty)}</td>
          <td class="num dim"><span class="o-cur">$</span>${px(avg)}</td>
          <td class="num">${mk === undefined ? '<span class="o-none">—</span>' : `<span class="o-cur">$</span>${mk}`}</td>
          <td class="num strong ${cls(pl)}">${mk === undefined ? '<span class="o-none">—</span>' : moneyHTML(pl)}</td>
        </tr>`;
      }).join('')}</tbody></table></div>`
      : '<div class="n-waiting">Nothing open.</div>'}
    ${settled.length ? `<div class="scroll-x"><table>
      <thead><tr><th>Expired</th><th class="num">Qty</th><th class="num">Final</th><th class="num">Value</th></tr></thead>
      <tbody>${settled.slice().reverse().map((s) => `<tr>
        <td class="o-contract spent">${contractTag(s)}</td>
        <td class="num ${cls(s.qty)}">${signed(s.qty)}</td>
        <td class="num"><span class="o-cur">$</span>${s.mark}</td>
        <td class="num ${cls(s.value)}">${moneyHTML(s.value)}</td>
      </tr>`).join('')}</tbody></table></div>` : ''}`;
}

function renderPlayer() {
  const st = S.state, me = S.me;
  if (!st || !me) {
    app.innerHTML = `${topbar()}<div class="n-wrap"><div class="banner wait blink">Connecting</div>${alerts()}</div>`;
    return;
  }

  const rank = st.standings.findIndex((p) => p.id === me.id) + 1;
  const waiting = st.phase === 'orders' ? st.awaitingOrders
    : st.phase === 'cards' ? st.awaitingCards : [];

  // Does the table need something from this player right now? Everything else
  // on screen steps back while it does.
  const owes = (st.phase === 'orders' && !me.ordersReady)
    || (st.phase === 'auction' && !me.quotesReady)
    || (st.phase === 'cards' && !me.cardsReady);

  let action, cta;
  if (st.phase === 'lobby') {
    action = `<div class="n-act plain"><div class="banner wait blink">Waiting for the host to open</div></div>`;
    cta = callToAction('Lobby', `${st.seated} seated`, false);
  } else if (st.phase === 'orders') {
    action = orderTicket(st, me);
    cta = owes
      ? callToAction('Your move — place an order',
                     `R${st.round} · ${st.seated - waiting.length}/${st.seated}`, true)
      : callToAction(`Order in — waiting on ${waiting.join(', ')}`,
                     `${st.seated - waiting.length}/${st.seated}`, false);
  } else if (st.phase === 'auction') {
    action = quoteTicket(st, me);
    const waiting = st.auction.awaiting;
    cta = me.quotesReady
      ? callToAction(`Markets in — waiting on ${waiting.join(', ')}`,
                     `${st.seated - waiting.length}/${st.seated}`, false)
      : callToAction(`Your move — quote R${st.auction.expiry}`,
                     `R${st.round} · ${st.seated - waiting.length}/${st.seated}`, true);
  } else if (st.phase === 'cards') {
    action = cardTicket(st, me);
    cta = owes
      ? callToAction('Your move — play your cards',
                     `R${st.round} · ${st.seated - waiting.length}/${st.seated}`, true)
      : callToAction(`Cards in — waiting on ${waiting.join(', ')}`,
                     `${st.seated - waiting.length}/${st.seated}`, false);
  } else if (st.phase === 'rolling') {
    action = `<div class="n-act plain">${diceBoard({
      dice: st.dice, net: st.net, live: true, rollStep: st.rollStep,
    })}</div>`;
    cta = callToAction(`Rolling · round ${st.round}`, `${st.rollStep}/4 locked`, false);
  } else {
    const w = st.standings[0];
    const won = w && w.id === me.id;
    action = `<div class="n-act plain">
      <div class="n-winner ${won ? 'up' : ''}">${won ? 'You win' : esc(w?.name ?? '—')}
        <span class="${cls(w?.pl ?? 0)}">${w ? moneyHTML(w.pl) : ''}</span></div></div>`;
    cta = callToAction('Market closed', `${st.maxRounds} rounds played`, false);
  }

  const secondary = `
    <div class="n-secondary ${owes ? '' : 'lit'}">
      ${st.reveal ? `
        ${rule(`Round ${st.round} book`, `printed ${st.reveal.price}`)}
        ${ladder(st.reveal)}
        <div class="n-flow">
          Pressure ${signed(st.reveal.pressure ?? 0)} · book absorbed ${st.reveal.absorbed ?? 0} ·
          imbalance ${signed(st.reveal.imbalance)} · print ${signed(impactOf(st.reveal.imbalance))}
          <i>paid by takers, collected by resters</i>
        </div>` : ''}

      ${st.options ? optionBlotter(me, st) : ''}

      ${rule('Your hand', `${me.hand.up + me.hand.down + me.hand.multiply + me.hand.add} left`)}
      <div class="n-hand">
        ${Object.keys(CARD_META).map((k) => `
          <div class="n-card ${k} ${me.hand[k] === 0 ? 'spent' : ''}">
            <div class="g">${CARD_META[k].glyph}</div><div class="held">${me.hand[k]}</div>
          </div>`).join('')}
      </div>

      ${rule('Standings', `you are ${rank || '—'} of ${st.seated}`)}
      ${standingsTable(st, { meId: me.id })}

      ${rule('Your blotter', `${me.fills.length} fills`)}
      ${blotter(me)}

      ${st.history.length ? `${rule('History', `${st.history.length} settled`)}${historyTable(st)}` : ''}
    </div>`;

  app.innerHTML = `
    ${topbar(`<span class="chip">${esc(me.name)}</span>`)}
    <div class="n-wrap">
      ${alerts()}
      ${positionStrip(st, me)}
      ${st.phase === 'orders' ? lastRoundReplay(st, me) : ''}
      ${cta}
      ${action}
      ${/* Outside the dimmed block on purpose: this is what you are reading
            while you quote, so it stays lit even when you owe the table. */ ''}
      ${st.options ? optionBoard(st) : ''}
      ${secondary}
      <div class="n-foot">
        <span class="dim tiny">Seated as ${esc(me.name)}</span>
        <a class="dim tiny" href="/${esc(st.code)}?new=1">Join as someone else</a>
      </div>
    </div>`;

  wirePlayer();
}

function renderDashboard(hostMode = false) {
  const st = S.state;
  if (!st) {
    app.innerHTML = `${topbar()}<div class="n-wrap"><div class="banner wait blink">Connecting</div>${alerts()}</div>`;
    return;
  }

  const joinUrl = `${location.origin}/${st.code}`;
  const gate = st.phase === 'orders' ? st.awaitingOrders : st.phase === 'cards' ? st.awaitingCards : [];
  const last = st.history[st.history.length - 1];

  const liveBook = !!st.reveal;
  const book = st.reveal ?? (last ? {
    limitBid: last.limitBid, marketBid: last.marketBid, imbalance: last.imbalance,
    marketOffer: last.marketOffer, limitOffer: last.limitOffer,
    pressure: last.pressure, absorbed: last.absorbed, price: last.print,
  } : null);
  /**
   * The dice panel shows exactly one round, and says which.
   *
   * While rolling it is always the round being rolled, even before the first
   * die lands — an empty board stating what each die needs is the point, and
   * falling back to the previous round here put last round's faces under this
   * round's modifiers, which is nonsense dressed up as information.
   *
   * Between rounds it replays the round that just settled, which is the beat
   * the game builds to. During card play it shows nothing: that round has no
   * dice yet and the previous one has had its moment.
   */
  const rolling = st.phase === 'rolling';
  const replaying = st.phase === 'orders' && !!last;
  const diceRound = rolling ? { dice: st.dice, net: st.net, round: st.round, live: true }
    : replaying ? {
        dice: last.dice, net: last.net, round: last.round, live: false,
        resolved: { trend: last.trend, type: last.type, chg: last.chg },
        priorMark: last.priorMark,
      }
    : null;

  const net = st.net ?? (last ? { cards: last.cards, regime: last.regime, plays: last.plays } : null);
  const chg = last?.chg ?? 0;

  app.innerHTML = `
    ${topbar()}
    <div class="n-board">
      ${alerts()}

      ${st.phase === 'lobby' ? `
        <div class="n-lobby">
          <div class="n-code">${esc(st.code)}</div>
          <div class="dim">${esc(joinUrl)}</div>
          <div class="n-seats">${waitingPills(st, st.standings.map((p) => p.name))}</div>
        </div>` : ''}

      <div class="n-top">
        <div class="n-mark">
          <div class="n-lab">Mark</div>
          <div class="markcell">
            <div class="m ${ui.markFlash ?? ''}">${st.mark}</div>
            ${sparkline(markPath(st), 132, 46)}
          </div>
          <div class="d ${cls(chg)}">${st.history.length ? signed(chg) : 'opening'}</div>
        </div>
        ${ladder(book)}
        <div class="n-print">
          <div class="n-lab">${liveBook ? 'Printed' : 'Last print'}</div>
          <div class="p">${book?.price ?? '—'}</div>
          <div class="dim">round ${st.round || '—'} of ${st.maxRounds}</div>
        </div>
      </div>

      ${book ? `
        <div class="n-flow big">
          Pressure <b>${signed(book.pressure ?? 0)}</b> · book absorbed <b>${book.absorbed ?? 0}</b> ·
          imbalance <b>${signed(book.imbalance)}</b> · print <b>${signed(impactOf(book.imbalance))}</b>
          <i>paid by takers, collected by resters</i>
        </div>` : ''}

      <div class="n-cols">
        <div>
          ${diceRound ? `
            ${rule(
              diceRound.live ? `Round ${diceRound.round} dice` : `Round ${diceRound.round} settled`,
              diceRound.live
                ? `${st.rollStep} of 4 locked · net trend ${signed(diceRound.net.trend)} · net magnitude ${signed(diceRound.net.mag)}`
                : `${signed(diceRound.resolved.chg)} to ${last.mark}`)}
            <div class="n-pad">${diceBoard({
              dice: diceRound.dice,
              net: diceRound.net,
              live: diceRound.live,
              rollStep: st.rollStep,
              resolved: diceRound.resolved ?? null,
              priorMark: diceRound.priorMark,
            })}</div>` : ''}

          ${net ? `
            ${rule('Cards played')}
            <div class="scroll-x"><table>
              <thead><tr><th>Player</th><th class="num">↑</th><th class="num">↓</th>
                <th class="num">×</th><th class="num">+</th></tr></thead>
              <tbody>
                ${(net.plays ?? []).map((p) => `
                  <tr><td>${esc(p.name)}</td>
                    <td class="num ${p.up ? 'up' : 'dim'}">${p.up}</td>
                    <td class="num ${p.down ? 'down' : 'dim'}">${p.down}</td>
                    <td class="num ${p.multiply ? 'cyan' : 'dim'}">${p.multiply}</td>
                    <td class="num ${p.add ? 'cyan' : 'dim'}">${p.add}</td></tr>`).join('')}
                <tr><td class="strong">CARDS</td>
                  <td class="num strong" colspan="2">trend ${signed(net.cards.trend)}</td>
                  <td class="num strong" colspan="2">mag ${signed(net.cards.mag)}</td></tr>
                <tr><td class="dim">REGIME</td>
                  <td class="num dim" colspan="2">trend ${signed(net.regime.trend)}</td>
                  <td class="num dim" colspan="2">mag ${signed(net.regime.mag)}</td></tr>
              </tbody>
            </table></div>` : ''}

          ${st.options ? optionBoard(st) : ''}

          ${st.history.length ? `${rule('Price path')}${historyTable(st)}` : ''}
        </div>

        <div>
          ${hostMode ? `
            ${rule('Host', PHASE_LABEL[st.phase])}
            <div class="n-pad n-host">
              ${st.phase === 'lobby' ? `
                <div class="split">
                  <label class="field"><span>Rounds</span>
                    <input id="cfgRounds" class="num" value="${st.maxRounds}" inputmode="numeric"></label>
                  <label class="field"><span>Cards each</span>
                    <input id="cfgCards" class="num" value="${st.cardQty}" inputmode="numeric"></label>
                </div>
                ${/* A segmented control, not a button: which state you are in
                      has to be readable without pressing anything. */ ''}
                ${/* A segmented control, not a button: which state you are in
                      has to be readable without pressing anything. */ ''}
                <div>
                  <span class="n-lab">Options</span>
                  <div class="n-seg mode o-toggle">
                    <button id="cfgOptionsOff" class="${st.options ? '' : 'on'}">Stock only</button>
                    <button id="cfgOptionsOn" class="${st.options ? 'on' : ''}">Options</button>
                  </div>
                </div>
                ${st.options ? expiryPicker(st) : `
                  <p class="n-note">The stock game, exactly as it plays today.</p>`}
                <button class="primary n-go" id="start" ${st.seated < 1 ? 'disabled' : ''}>
                  ${st.seated < 1 ? 'Waiting for players' : `Open the market (${st.seated} seated)`}
                </button>` : ''}
              ${st.phase === 'orders' || st.phase === 'cards' ? `
                <button class="wide" id="force">Force the ${st.phase} gate${gate.length ? ` — skips ${esc(gate.join(', '))}` : ''}</button>` : ''}
              ${st.phase === 'rolling' ? `
                <button class="primary n-go" id="roll" ${ui.rolling ? 'disabled' : ''}>
                  ${ui.rolling ? 'Rolling…' : `Roll ${st.dieLabel ?? ''} (${st.rollStep + 1}/4)`}
                </button>` : ''}
              ${st.phase === 'complete' ? '<div class="banner">Market closed</div>' : ''}
              <div class="row">
                <button id="copyJoin">Copy join link</button>
                <button id="addSeat">Extra seat</button>
                <button id="openDash">Dashboard</button>
                <button class="danger" id="reset">Reset</button>
              </div>
            </div>` : ''}

          ${st.phase === 'auction' ? `
            ${rule(`Auction R${st.auction.expiry}`, `${st.auction.awaiting.length} of ${st.seated} still to quote`)}
            <div class="n-pad">${waitingPills(st, st.auction.awaiting)}</div>` : ''}

          ${st.phase === 'orders' || st.phase === 'cards' ? `
            ${rule('Waiting on', `${gate.length} of ${st.seated}`)}
            <div class="n-pad">${waitingPills(st, gate)}</div>` : ''}

          ${rule('Standings', `${st.seated} seated`)}
          ${standingsTable(st, { host: hostMode && st.phase === 'lobby' })}

          ${rule('Tape')}
          ${tape(st)}
        </div>
      </div>

      <div class="n-foot">
        <span class="spacer"></span>
      </div>
    </div>`;

  if (hostMode) wireHost(st, joinUrl);
}

// --- Render / route --------------------------------------------------------

/** Preserve focus and caret across a full redraw. */
function render() {
  const active = document.activeElement;
  const id = active?.id;
  const start = active?.selectionStart;
  const end = active?.selectionEnd;

  if (!S.code) renderHome();
  else if (S.role === 'player') renderPlayer();
  else if (S.role === 'host') renderDashboard(true);
  else if (S.role === 'dashboard') renderDashboard(false);
  else renderJoin();

  if (id) {
    const el = document.getElementById(id);
    if (el) {
      el.focus();
      if (start !== undefined && start !== null && el.setSelectionRange) {
        try { el.setSelectionRange(start, end); } catch { /* not a text input */ }
      }
    }
  }
}

function route() {
  const path = location.pathname.replace(/^\/+|\/+$/g, '').toUpperCase();
  const hash = location.hash.replace('#', '');

  if (!/^[A-Z0-9]{4}$/.test(path)) {
    S.code = null;
    S.role = null;
    return render();
  }

  S.code = path;

  // The token alone tells the server who you are; the hash only decides which
  // screen this device wants when it holds no seat.
  if (hash === 'host') {
    const t = store.hostToken(path);
    if (!t) {
      S.error = 'No host credentials for this table on this device. Open it from the machine that created it, or use the dashboard instead.';
      S.role = 'dashboard';
      net.start(null);
      return render();
    }
    S.role = 'host';
    net.start(t);
    return render();
  }

  if (hash === 'dashboard') {
    S.role = 'dashboard';
    net.start(null);
    return render();
  }

  // ?new forces a fresh seat: this tab forgets whatever it held and asks for a
  // name. Lets one browser hold several players, and covers handing a phone to
  // somebody else mid-game.
  if (new URLSearchParams(location.search).has('new')) {
    store.forgetSeatInThisTab(path);
    history.replaceState(null, '', `/${path}`);   // so a reload does not re-prompt
    S.role = null;
    return render();
  }

  // Player: rejoin silently if this tab or browser already holds a seat.
  const seat = store.playerToken(path);
  if (seat) {
    S.role = 'player';
    net.start(seat);
    return render();
  }

  S.role = null;   // prompt for a name
  render();
}

// Polling pauses on a hidden tab; catch up the moment it comes back.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.code && net.timer) net.start();
});

window.addEventListener('hashchange', () => location.reload());
route();
