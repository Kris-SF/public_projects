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
};

const ui = {
  side: 'BUY',
  qty: '',
  orderType: 'MARKET',
  cards: { up: 0, down: 0, multiply: 0, add: 0 },
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

const px = (n, d = 2) => (n === null || n === undefined ? '—' : Number(n).toFixed(d));

const store = {
  playerToken: (code) => localStorage.getItem(`mooncoin:player:${code}`),
  setPlayerToken: (code, t) => localStorage.setItem(`mooncoin:player:${code}`, t),
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

// --- Socket ----------------------------------------------------------------

const net = {
  ws: null,
  retry: 0,
  hello: null,

  connect(hello) {
    this.hello = { type: 'hello', ...hello };
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      S.connected = true;
      S.error = null;
      ws.send(JSON.stringify(this.hello));
    };

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state') {
        const prev = S.state?.mark;
        S.state = msg.state;
        if (msg.me) S.me = msg.me;
        if (prev !== undefined && msg.state.mark !== prev) {
          ui.markFlash = msg.state.mark > prev ? 'flash-up' : 'flash-down';
          setTimeout(() => { ui.markFlash = null; render(); }, 750);
        }
        // Clear the ticket when the round turns over, and only then — every
        // player action broadcasts, and wiping on each one would erase a
        // quantity somebody is halfway through typing.
        const turned = ui.lastRound !== null && ui.lastRound !== msg.state.round;
        if (turned) {
          ui.qty = '';
          ui.cards = { up: 0, down: 0, multiply: 0, add: 0 };
        }
        ui.lastRound = msg.state.round;
        render();
      } else if (msg.type === 'seated') {
        store.setPlayerToken(S.code, msg.playerToken);
      } else if (msg.type === 'die') {
        ui.rolling = false;
        render();
      } else if (msg.type === 'error') {
        S.error = msg.message;
        ui.busy = false;
        ui.rolling = false;
        render();
      }
    };

    ws.onclose = () => {
      S.connected = false;
      render();
      // Back off, but keep trying — a phone that slept should rejoin on its own.
      this.retry = Math.min(this.retry + 1, 6);
      setTimeout(() => this.connect(this.hello), 400 * 2 ** (this.retry - 1));
    };

    ws.onerror = () => ws.close();
  },

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      S.error = null;
      this.ws.send(JSON.stringify(msg));
    }
  },
};

// --- Actions ---------------------------------------------------------------

const act = {
  setSide(side) { ui.side = side; render(); },
  setType(t) { ui.orderType = t; render(); },
  setQty(v) { ui.qty = v.replace(/[^0-9]/g, ''); },

  submitOrder() {
    const mag = parseInt(ui.qty || '0', 10);
    if (!Number.isFinite(mag) || mag < 0) { S.error = 'Enter a quantity'; return render(); }
    const qty = ui.side === 'SELL' ? -mag : mag;
    net.send({ type: 'order', qty, orderType: ui.orderType });
    net.send({ type: 'confirmOrder' });
  },

  passOrder() {
    net.send({ type: 'order', qty: 0, orderType: 'LIMIT' });
    net.send({ type: 'confirmOrder' });
  },

  unconfirmOrder() { net.send({ type: 'unconfirmOrder' }); },

  bumpCard(kind, delta) {
    const held = S.me?.hand?.[kind] ?? 0;
    ui.cards[kind] = Math.max(0, Math.min(held, (ui.cards[kind] ?? 0) + delta));
    render();
  },

  submitCards() {
    net.send({ type: 'cards', cards: ui.cards });
    net.send({ type: 'confirmCards' });
  },

  unconfirmCards() { net.send({ type: 'unconfirmCards' }); },

  roll() {
    ui.rolling = true;
    render();
    setTimeout(() => net.send({ type: 'roll' }), 420);   // let the tumble register
  },

  start() { net.send({ type: 'start' }); },
  force() { net.send({ type: 'force' }); },
  reset() {
    if (confirm('Reset the game? Every position and hand is wiped. Seats stay.')) {
      net.send({ type: 'reset' });
    }
  },
  kick(playerId, name) {
    if (confirm(`Remove ${name} from the table?`)) net.send({ type: 'kick', playerId });
  },
  config(patch) { net.send({ type: 'config', config: patch }); },

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
  const conn = S.connected
    ? '<span class="chip live">LIVE</span>'
    : '<span class="chip off">RECONNECTING</span>';
  const round = st && st.round > 0 ? `R${st.round}/${st.maxRounds}` : '—';
  return `
    <div class="topbar">
      <span>MOONCOIN</span>
      <span class="chip">${esc(S.code ?? '')}</span>
      <span>${esc(round)}</span>
      <span>${esc(st ? PHASE_LABEL[st.phase] : '')}</span>
      ${extra}
      <span class="spacer"></span>
      ${conn}
    </div>`;
}

function alerts() {
  return `
    ${S.error ? `<div class="err">${esc(S.error)}</div>` : ''}
    ${S.notice ? `<div class="ok">${esc(S.notice)}</div>` : ''}`;
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

function diceRow(st, dice = st.dice, live = true) {
  const labels = ['Trend Die', 'Multiply/Add', 'D6 (A)', 'D6 (B)'];
  const next = live ? st.rollStep : -1;
  return `
    <div class="dice">
      ${dice.map((d, i) => {
        const locked = d !== null;
        const isNext = live && !locked && i === next && st.phase === 'rolling';
        const tumbling = isNext && ui.rolling;
        const klass = ['die', locked ? 'locked' : 'empty', isNext ? 'next' : '', tumbling ? 'rolling' : '']
          .filter(Boolean).join(' ');
        return `
          <div class="${klass}">
            <div class="cap">${labels[i]}</div>
            <div class="pip">${locked ? d : tumbling ? '?' : '·'}</div>
            <div class="cap">${locked ? 'LOCKED' : isNext ? 'NEXT' : ''}</div>
          </div>`;
      }).join('')}
    </div>`;
}

function waitingPills(st, list) {
  if (!st.standings.length) return '<span class="dim">No players seated</span>';
  return `<div class="waiting">${st.standings.map((p) => {
    const late = list.includes(p.name);
    const k = !p.connected ? 'gone' : late ? 'late' : 'ready';
    const mark = !p.connected ? '∅' : late ? '·' : '✓';
    return `<span class="pill ${k}">${mark} ${esc(p.name)}</span>`;
  }).join('')}</div>`;
}

function standingsTable(st, opts = {}) {
  const rows = st.standings.map((p, i) => `
    <tr class="${opts.meId === p.id ? 'me' : ''}">
      <td class="num dim">${i + 1}</td>
      <td class="strong">${esc(p.name)}${p.connected ? '' : ' <span class="grey tiny">OFF</span>'}</td>
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
      <td>${h.type === 'MULTIPLY' ? '×' : '+'}</td>
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
          <th class="num">Trend</th><th class="num">Mag</th><th>Type</th>
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

function markPanel(st) {
  const last = st.history[st.history.length - 1];
  const chg = last?.chg ?? 0;
  return `
    <div class="panel">
      <header>Mooncoin <span class="spacer"></span><span class="note">Opened ${st.openingPrice}</span></header>
      <div class="tiles">
        <div class="readout ${ui.markFlash ?? ''}">
          <div class="label">Mark</div>
          <div class="value">${st.mark}</div>
        </div>
        <div class="readout">
          <div class="label">Last Change</div>
          <div class="value ${cls(chg)}">${st.history.length ? signed(chg) : '—'}</div>
        </div>
        <div class="readout">
          <div class="label">Last Print</div>
          <div class="value">${last?.print ?? '—'}</div>
        </div>
        <div class="readout">
          <div class="label">Round</div>
          <div class="value">${st.round || '—'}<span class="dim" style="font-size:14px">/${st.maxRounds}</span></div>
        </div>
      </div>
    </div>`;
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
      const res = await fetch('/api/games', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!res.ok) throw new Error('Could not open a table');
      const { code: newCode, hostToken } = await res.json();
      store.setHostToken(newCode, hostToken);
      location.href = `/${newCode}#host`;
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

  const sit = () => {
    if (!ui.name.trim()) { S.error = 'Name required'; return render(); }
    net.connect({ role: 'player', code: S.code, name: ui.name.trim() });
    S.role = 'player';
    render();
  };
  document.getElementById('sit').onclick = sit;
}

// --- Player terminal -------------------------------------------------------

function orderTicket(st, me) {
  if (me.ordersReady) {
    const o = me.pendingOrder;
    const side = o.qty > 0 ? 'BUY' : o.qty < 0 ? 'SELL' : 'PASS';
    return `
      <div class="body">
        <div class="banner">Order confirmed</div>
        <div class="tiles" style="border:1px solid var(--rule);border-top:none">
          <div class="readout"><div class="label">Side</div><div class="value ${o.qty > 0 ? 'up' : o.qty < 0 ? 'down' : 'dim'}">${side}</div></div>
          <div class="readout"><div class="label">Qty</div><div class="value">${Math.abs(o.qty)}</div></div>
          <div class="readout"><div class="label">Type</div><div class="value">${o.type}</div></div>
        </div>
        <div class="row" style="margin-top:8px">
          <button id="unconfirmOrder">Pull it back</button>
          <span class="dim">Waiting on ${st.awaitingOrders.length ? esc(st.awaitingOrders.join(', ')) : 'nobody — opening now'}</span>
        </div>
      </div>`;
  }

  const mag = parseInt(ui.qty || '0', 10) || 0;
  const signedQty = ui.side === 'SELL' ? -mag : mag;
  const slip = ui.orderType === 'MARKET' ? impactOf(signedQty) : 0;
  const est = st.mark + slip;

  return `
    <div class="body">
      <div class="split" style="margin-bottom:6px">
        <button class="buy ${ui.side === 'BUY' ? 'on' : ''}" data-side="BUY">Buy</button>
        <button class="sell ${ui.side === 'SELL' ? 'on' : ''}" data-side="SELL">Sell</button>
      </div>
      <label class="field">
        <span>Quantity</span>
        <input id="qty" class="num" inputmode="numeric" autocomplete="off" placeholder="0" value="${esc(ui.qty)}">
      </label>
      <div class="split" style="margin-bottom:8px">
        <button class="${ui.orderType === 'MARKET' ? 'on' : ''}" data-otype="MARKET">Market</button>
        <button class="${ui.orderType === 'LIMIT' ? 'on' : ''}" data-otype="LIMIT">Limit</button>
      </div>
      <div class="tiles" style="border:1px solid var(--rule);margin-bottom:8px">
        <div class="readout">
          <div class="label">${ui.orderType === 'MARKET' ? 'Est. Print' : 'Fills At'}</div>
          <div class="value">${ui.orderType === 'MARKET' ? est : st.mark}<span class="dim" style="font-size:12px"> ${ui.orderType === 'MARKET' ? 'if alone' : 'or better'}</span></div>
        </div>
        <div class="readout">
          <div class="label">Your Slippage</div>
          <div class="value ${slip === 0 ? 'dim' : 'down'}">${ui.orderType === 'MARKET' ? signed(slip) : '0'}</div>
        </div>
      </div>
      <p class="dim tiny" style="margin:0 0 8px">
        ${ui.orderType === 'MARKET'
          ? 'Market fills for certain and pays √imbalance in impact — less whatever the resting book absorbs.'
          : 'Limit rests at last sale. It soaks up pressure coming the other way and fills at the clearing price, or does not fill at all.'}
      </p>
      <div class="split">
        <button id="pass">Pass</button>
        <button class="primary" id="submitOrder">Confirm</button>
      </div>
    </div>`;
}

function cardTicket(st, me) {
  if (me.cardsReady) {
    const c = me.pendingCards ?? { up: 0, down: 0, multiply: 0, add: 0 };
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    return `
      <div class="body">
        <div class="banner">Cards confirmed</div>
        <div class="body center dim" style="padding:10px 0">
          ${total === 0 ? 'Holding everything back this round.'
            : Object.entries(c).filter(([, n]) => n > 0)
                .map(([k, n]) => `${n}× ${CARD_META[k].glyph}`).join('  ')}
        </div>
        <div class="row">
          <button id="unconfirmCards">Take them back</button>
          <span class="dim">Waiting on ${st.awaitingCards.length ? esc(st.awaitingCards.join(', ')) : 'nobody'}</span>
        </div>
      </div>`;
  }

  return `
    <div class="body">
      <div class="cardgrid">
        ${Object.keys(CARD_META).map((k) => {
          const held = me.hand[k];
          const picked = ui.cards[k] ?? 0;
          return `
            <div class="card ${k} ${held === 0 ? 'spent' : ''}">
              <div class="glyph">${CARD_META[k].glyph}</div>
              <div class="name">${CARD_META[k].name}</div>
              <div class="held">${held - picked} left</div>
              <div class="picked">${picked}</div>
              <div class="stepper">
                <button data-card="${k}" data-delta="-1" ${picked === 0 ? 'disabled' : ''}>−</button>
                <button data-card="${k}" data-delta="1" ${picked >= held ? 'disabled' : ''}>+</button>
              </div>
            </div>`;
        }).join('')}
      </div>
      <p class="dim tiny" style="margin:8px 0">
        ↑/↓ push the trend die. ×/+ push the magnitude die. Everything is spent whether it lands or not.
      </p>
      <button class="primary wide" id="submitCards">Confirm cards</button>
    </div>`;
}

function blotter(me) {
  if (!me.fills.length) return '<div class="body dim">No fills yet.</div>';
  return `
    <div class="scroll-x">
      <table>
        <thead><tr>
          <th class="num">R</th><th class="num">Qty</th><th class="num">Price</th><th class="num">P/L</th>
        </tr></thead>
        <tbody>${me.fills.slice().reverse().map((f) => {
          const pl = (S.state.mark - f.price) * f.qty;
          return `<tr>
            <td class="num dim">${f.round}</td>
            <td class="num ${cls(f.qty)}">${signed(f.qty)}</td>
            <td class="num">${f.price}</td>
            <td class="num ${cls(pl)}">${money(pl)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
}

function renderPlayer() {
  const st = S.state;
  const me = S.me;
  if (!st || !me) {
    app.innerHTML = `${topbar()}<div class="wrap"><div class="banner wait blink">Connecting</div>${alerts()}</div>`;
    return;
  }

  const rank = st.standings.findIndex((p) => p.id === me.id) + 1;
  const lastRound = st.history[st.history.length - 1];

  let ticket;
  if (st.phase === 'lobby') {
    ticket = `<div class="body"><div class="banner wait blink">Waiting for the host to open</div>
      <p class="dim center" style="margin:10px 0 0">${st.seated} seated</p></div>`;
  } else if (st.phase === 'orders') {
    ticket = orderTicket(st, me);
  } else if (st.phase === 'cards') {
    ticket = cardTicket(st, me);
  } else if (st.phase === 'rolling') {
    ticket = `<div class="body">${diceRow(st)}
      <p class="center dim" style="margin:8px 0 0">${st.rollStep}/4 locked — host is rolling</p></div>`;
  } else {
    const winner = st.standings[0];
    ticket = `<div class="body">
      <div class="banner">Market closed</div>
      <div class="readout center" style="margin-top:10px">
        <div class="label">Winner</div>
        <div class="value">${esc(winner?.name ?? '—')}</div>
        <div class="dim">${winner ? money(winner.pl) : ''}</div>
      </div></div>`;
  }

  app.innerHTML = `
    ${topbar(`<span class="chip">${esc(me.name)}</span>`)}
    <div class="wrap">
      ${alerts()}
      <div class="tiles panel">
        <div class="readout ${ui.markFlash ?? ''}">
          <div class="label">Mark</div><div class="value">${st.mark}</div>
        </div>
        <div class="readout">
          <div class="label">Position</div><div class="value ${cls(me.shares)}">${signed(me.shares)}</div>
        </div>
        <div class="readout">
          <div class="label">Avg Price</div><div class="value">${me.avgPrice === null ? '—' : px(me.avgPrice)}</div>
        </div>
        <div class="readout">
          <div class="label">P/L</div><div class="value ${cls(me.pl)}">${money(me.pl)}</div>
        </div>
        <div class="readout">
          <div class="label">Rank</div><div class="value">${rank || '—'}<span class="dim" style="font-size:13px">/${st.seated}</span></div>
        </div>
      </div>

      <div class="cols">
        <div class="panel">
          <header>
            ${st.phase === 'cards' ? 'Cards' : 'Order Ticket'}
            <span class="spacer"></span>
            <span class="note">${PHASE_LABEL[st.phase]}</span>
          </header>
          ${ticket}
        </div>

        <div class="stack">
          ${st.reveal ? `
            <div class="panel">
              <header>Round ${st.round} Book <span class="spacer"></span>
                <span class="note">printed ${st.reveal.price}</span></header>
              ${ladder(st.reveal)}
              ${st.reveal.houseResidual > 0 ? `<div class="body dim tiny">House absorbed ${st.reveal.houseResidual}</div>` : ''}
            </div>` : ''}
          <div class="panel">
            <header>Blotter <span class="spacer"></span><span class="note">${me.fills.length} fills</span></header>
            ${blotter(me)}
          </div>
          <div class="panel">
            <header>Hand</header>
            <div class="body">
              <div class="cardgrid">
                ${Object.keys(CARD_META).map((k) => `
                  <div class="card ${k} ${me.hand[k] === 0 ? 'spent' : ''}">
                    <div class="glyph">${CARD_META[k].glyph}</div>
                    <div class="held">${me.hand[k]}</div>
                  </div>`).join('')}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="cols">
        <div class="panel">
          <header>Standings</header>
          ${standingsTable(st, { meId: me.id })}
        </div>
        <div class="panel">
          <header>Tape</header>
          ${tape(st)}
        </div>
      </div>

      ${lastRound ? `
        <div class="panel">
          <header>Round History</header>
          ${historyTable(st)}
        </div>` : ''}
    </div>`;

  wirePlayer();
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

  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('submitOrder', act.submitOrder);
  on('pass', act.passOrder);
  on('unconfirmOrder', act.unconfirmOrder);
  on('submitCards', act.submitCards);
  on('unconfirmCards', act.unconfirmCards);
}

// --- Dashboard -------------------------------------------------------------

function renderDashboard(hostMode = false) {
  const st = S.state;
  if (!st) {
    app.innerHTML = `${topbar()}<div class="wrap"><div class="banner wait blink">Connecting</div>${alerts()}</div>`;
    return;
  }

  const joinUrl = `${location.origin}/${st.code}`;
  const gateList = st.phase === 'orders' ? st.awaitingOrders
    : st.phase === 'cards' ? st.awaitingCards : [];

  // Between rounds the live slots are empty. Rather than blank three panels,
  // fall back to the last settled round — a terminal shows the last print, it
  // does not go dark.
  const last = st.history[st.history.length - 1];
  const liveBook = !!st.reveal;
  const book = st.reveal ?? (last ? {
    limitBid: last.limitBid, marketBid: last.marketBid, imbalance: last.imbalance,
    marketOffer: last.marketOffer, limitOffer: last.limitOffer,
    pressure: last.pressure, absorbed: last.absorbed,
    price: last.print, houseResidual: last.houseResidual,
  } : null);
  const bookRound = liveBook ? st.round : last?.round;

  const liveDice = st.dice.some((d) => d !== null);
  const dice = liveDice ? st.dice : (last?.dice ?? null);
  const diceRound = liveDice ? st.round : last?.round;

  const liveNet = !!st.net;
  const net = st.net ?? (last ? { cards: last.cards, regime: last.regime, plays: last.plays } : null);
  const netRound = liveNet ? st.round : last?.round;

  const controls = hostMode ? `
    <div class="panel">
      <header>Host Console <span class="spacer"></span>
        <span class="note">${PHASE_LABEL[st.phase]}</span></header>
      <div class="body stack">
        ${st.phase === 'lobby' ? `
          <div class="split">
            <label class="field">
              <span>Rounds</span>
              <input id="cfgRounds" class="num" value="${st.maxRounds}" inputmode="numeric">
            </label>
            <label class="field">
              <span>Cards each</span>
              <input id="cfgCards" class="num" value="${st.cardQty}" inputmode="numeric">
            </label>
          </div>
          <button class="primary wide lg" id="start" ${st.seated < 1 ? 'disabled' : ''}>
            ${st.seated < 1 ? 'Waiting for players' : `Open the market (${st.seated} seated)`}
          </button>` : ''}

        ${st.phase === 'orders' || st.phase === 'cards' ? `
          <button class="wide" id="force">
            Force the ${st.phase === 'orders' ? 'orders' : 'cards'} gate
            ${gateList.length ? `— skips ${esc(gateList.join(', '))}` : ''}
          </button>` : ''}

        ${st.phase === 'rolling' ? `
          <button class="primary wide lg" id="roll" ${ui.rolling ? 'disabled' : ''}>
            ${ui.rolling ? 'Rolling…' : `Roll ${st.dieLabel ?? ''} (${st.rollStep + 1}/4)`}
          </button>` : ''}

        ${st.phase === 'complete' ? '<div class="banner">Market closed</div>' : ''}

        <div class="row">
          <button id="copyJoin">Copy join link</button>
          <button id="openDash">Open dashboard</button>
          <button class="danger" id="reset">Reset</button>
        </div>
      </div>
    </div>` : '';

  app.innerHTML = `
    ${topbar()}
    <div class="wrap ${hostMode ? '' : 'dashboard'}">
      ${alerts()}
      ${st.phase === 'lobby' ? `
        <div class="panel">
          <header>Table open — join at ${esc(location.host)}</header>
          <div class="body center">
            <div class="huge" style="letter-spacing:0.28em">${esc(st.code)}</div>
            <div class="dim">${esc(joinUrl)}</div>
            <div style="margin-top:14px">${waitingPills(st, st.standings.map((p) => p.name))}</div>
          </div>
        </div>` : ''}

      ${markPanel(st)}

      <div class="${hostMode ? 'cols-2-1' : 'cols'}">
        <div class="stack">
          <div class="panel">
            <header>
              ${book ? `Round ${bookRound} Book` : 'Order Book'}
              <span class="spacer"></span>
              <span class="note">${book
                ? `printed ${book.price}${liveBook ? '' : ' · last settled'}`
                : 'sealed until the gate trips'}</span>
            </header>
            ${ladder(book)}
            ${book ? `<div class="body dim tiny">
              Pressure ${signed(book.pressure ?? 0)} · book absorbed ${book.absorbed ?? 0} ·
              imbalance ${signed(book.imbalance)} · slippage ${signed(impactOf(book.imbalance))}
              ${book.houseResidual > 0 ? `· house left holding ${book.houseResidual}` : '· fully matched'}
            </div>` : ''}
          </div>

          ${dice ? `
            <div class="panel">
              <header>Round ${diceRound} Dice <span class="spacer"></span>
                <span class="note">${st.net
                  ? `net trend ${signed(st.net.trend)} · net magnitude ${signed(st.net.mag)}`
                  : last ? `${last.type === 'MULTIPLY' ? '×' : '+'} ${signed(last.chg)} to ${last.mark}` : ''}</span></header>
              <div class="body">${diceRow(st, dice, liveDice)}</div>
            </div>` : ''}

          ${net ? `
            <div class="panel">
              <header>Round ${netRound} Cards <span class="spacer"></span>
                <span class="note">${liveNet ? '' : 'last settled'}</span></header>
              <div class="scroll-x">
                <table>
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
                </table>
              </div>
            </div>` : ''}
        </div>

        <div class="stack">
          ${controls}
          ${st.phase === 'orders' || st.phase === 'cards' ? `
            <div class="panel">
              <header>Waiting On <span class="spacer"></span>
                <span class="note">${gateList.length} of ${st.seated}</span></header>
              <div class="body">${waitingPills(st, gateList)}</div>
            </div>` : ''}
          <div class="panel">
            <header>Standings</header>
            ${/* Seats can only be removed in the lobby, so the control is only offered there. */ ''}
            ${standingsTable(st, { host: hostMode && st.phase === 'lobby' })}
          </div>
          <div class="panel">
            <header>Tape</header>
            ${tape(st)}
          </div>
        </div>
      </div>

      <div class="panel">
        <header>Round History</header>
        ${historyTable(st)}
      </div>
    </div>`;

  if (hostMode) wireHost(st, joinUrl);
}

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
  on('force', act.force);
  on('roll', act.roll);
  on('reset', act.reset);
  on('copyJoin', () => act.copy(joinUrl, 'Join link'));
  on('openDash', () => window.open(`/${st.code}#dashboard`, '_blank'));

  document.querySelectorAll('[data-kick]').forEach((b) => {
    b.onclick = () => act.kick(b.dataset.kick, b.dataset.name);
  });
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

  if (hash === 'host') {
    const t = store.hostToken(path);
    if (!t) {
      S.error = 'No host credentials for this table on this device. Open it from the machine that created it, or run the dashboard instead.';
      S.role = 'dashboard';
      net.connect({ role: 'dashboard', code: path });
      return render();
    }
    S.role = 'host';
    net.connect({ role: 'host', code: path, hostToken: t });
    return render();
  }

  if (hash === 'dashboard') {
    S.role = 'dashboard';
    net.connect({ role: 'dashboard', code: path });
    return render();
  }

  // Player: reconnect silently if this device already has a seat.
  const token = store.playerToken(path);
  if (token) {
    S.role = 'player';
    net.connect({ role: 'player', code: path, playerToken: token });
    return render();
  }

  S.role = null;   // prompt for a name
  render();
}

window.addEventListener('hashchange', () => location.reload());
route();
