/**
 * Game state machine.
 *
 * A round runs through two gates, mirroring the two ready-columns the
 * spreadsheet tracked:
 *
 *   orders  -> everyone submits qty + LIMIT/MARKET and confirms
 *              (gate) reveal the book, print the fill, write every blotter
 *   auction -> options only: one gate per expiry, in round order. Everyone
 *              quotes the strikes they want or passes
 *              (gate) reveal that expiry's house orders, clear every contract
 *   cards   -> everyone plays cards and confirms
 *              (gate) reveal cards, compute the net, hand off to the dice
 *   rolling -> four dice, locked one at a time for the theatre of it
 *              (gate) apply the change, set the new mark, advance
 *
 * Gates trip automatically once every seated player has confirmed. The host can
 * force any gate to unstick a table when somebody wanders off.
 */

import {
  DEFAULTS, deal, emptyHand, matchOrders, cardEffects, regimeEffects,
  resolveDice, position, rollDie,
} from './engine.js';
import {
  OPTION_DEFAULTS, createOptionsState, createPlayerOptions, indicateOrders,
  expiryTables, strikeGrid, revealOrders, clearContract, makeQuote, makePosition,
  contractKey, optionPL, settleExpiring, intrinsic,
} from './options.js';

export const PHASES = ['lobby', 'orders', 'auction', 'cards', 'rolling', 'complete'];

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

export function makeRoomCode(rng = Math.random) {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  return s;
}

export function createGame(code, config = {}) {
  return {
    code,
    createdAt: Date.now(),
    config: {
      maxRounds: config.maxRounds ?? DEFAULTS.maxRounds,
      cardQty: config.cardQty ?? DEFAULTS.cardQty,
      openingPrice: config.openingPrice ?? DEFAULTS.openingPrice,
      // The options layer is opt-in at setup, so the stock-only game stays
      // exactly the game it is today — same flow, same payloads, no cash.
      options: config.options ?? false,
      optionRules: { ...OPTION_DEFAULTS, ...(config.optionRules ?? {}) },
    },
    phase: 'lobby',
    round: 0,
    mark: config.openingPrice ?? DEFAULTS.openingPrice,
    players: [],
    dice: [null, null, null, null],
    pendingOrders: {},   // playerId -> { qty, type }
    pendingCards: {},    // playerId -> { up, down, multiply, add }
    ready: { orders: {}, cards: {} },
    reveal: null,        // this round's matched book, once the orders gate trips
    net: null,           // this round's trend/magnitude pressure, once cards trip
    options: null,       // the options layer, when the toggle is on
    history: [],         // one entry per completed round
    log: [],
  };
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

export function addPlayer(game, name) {
  if (game.phase !== 'lobby') throw new Error('Game already under way');
  if (game.players.length >= 10) throw new Error('Table is full (10 seats)');

  const clean = String(name || '').trim().slice(0, 20).toUpperCase();
  if (!clean) throw new Error('Name required');
  if (game.players.some((p) => p.name === clean)) throw new Error(`${clean} is already seated`);

  const player = {
    id: `p${game.players.length + 1}_${Math.random().toString(36).slice(2, 8)}`,
    seat: game.players.length + 1,
    name: clean,
    connected: true,
    hand: emptyHand(),
    initialHand: emptyHand(),
    fills: [],
  };
  game.players.push(player);
  logLine(game, `${clean} took seat ${player.seat}`);
  return player;
}

export function removePlayer(game, playerId) {
  if (game.phase !== 'lobby') return false;
  const i = game.players.findIndex((p) => p.id === playerId);
  if (i === -1) return false;
  const [gone] = game.players.splice(i, 1);
  game.players.forEach((p, idx) => { p.seat = idx + 1; });
  logLine(game, `${gone.name} left the table`);
  return true;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function startGame(game, rng = Math.random) {
  if (game.phase !== 'lobby') throw new Error('Game already started');
  if (game.players.length < 1) throw new Error('Need at least one player');

  const hands = deal(game.players.length, game.config.cardQty, rng);
  game.players.forEach((p, i) => {
    p.hand = { ...hands[i] };
    p.initialHand = { ...hands[i] };
    p.fills = [];
    if (game.config.options) Object.assign(p, createPlayerOptions());
  });

  game.options = game.config.options ? createOptionsState() : null;
  game.round = 1;
  game.mark = game.config.openingPrice;
  game.phase = 'orders';
  game.history = [];
  clearRound(game, rng);
  logLine(game, `Game opened at ${game.config.openingPrice} — ${game.config.maxRounds} rounds, ${game.config.cardQty} cards each`);
  return game;
}

function clearRound(game, rng = Math.random) {
  game.pendingOrders = {};
  game.pendingCards = {};
  game.ready = { orders: {}, cards: {} };
  game.reveal = null;
  game.net = null;
  game.dice = [null, null, null, null];

  // Indicate the new round's house orders. Side and size are not decided here —
  // they are generated at reveal, which is stage 3's job.
  if (game.options) {
    game.options.orders = indicateOrders(
      game.round, game.config.maxRounds, game.mark, game.config.optionRules, rng,
    );
    game.options.quotes = {};
    game.options.ready = {};
    game.options.cleared = [];
    game.options.activeExpiry = null;
    game.options.tableIndex = 0;
  }
}

function logLine(game, text) {
  game.log.push({ t: Date.now(), round: game.round, text });
  if (game.log.length > 200) game.log.shift();
}

// ---------------------------------------------------------------------------
// Orders phase
// ---------------------------------------------------------------------------

export function submitOrder(game, playerId, { qty, type }) {
  if (game.phase !== 'orders') throw new Error('Not accepting orders');
  if (game.ready.orders[playerId]) throw new Error('Order already confirmed');

  const n = Math.trunc(Number(qty));
  if (!Number.isFinite(n)) throw new Error('Quantity must be a number');
  if (type !== 'LIMIT' && type !== 'MARKET') throw new Error('Order type must be LIMIT or MARKET');

  game.pendingOrders[playerId] = { qty: n, type };
  return game.pendingOrders[playerId];
}

export function confirmOrder(game, playerId) {
  if (game.phase !== 'orders') throw new Error('Not accepting orders');
  if (!game.pendingOrders[playerId]) throw new Error('Nothing submitted yet');
  game.ready.orders[playerId] = true;
  const p = playerById(game, playerId);
  logLine(game, `${p.name} confirmed order`);
  return maybeTripOrdersGate(game);
}

export function unconfirmOrder(game, playerId) {
  if (game.phase !== 'orders') return false;
  delete game.ready.orders[playerId];
  return true;
}

export function allOrdersReady(game) {
  return game.players.length > 0 && game.players.every((p) => game.ready.orders[p.id]);
}

function maybeTripOrdersGate(game, force = false) {
  if (!force && !allOrdersReady(game)) return false;
  return tripOrdersGate(game);
}

/** Reveal the book, print the round, and write every blotter. */
export function tripOrdersGate(game) {
  if (game.phase !== 'orders') throw new Error('Orders gate is not open');

  // Only confirmed orders trade. Typing a quantity is not committing to it, so
  // a forced gate leaves the undecided flat rather than filling them by default.
  const orders = game.players
    .filter((p) => game.ready.orders[p.id] && game.pendingOrders[p.id])
    .map((p) => ({ playerId: p.id, ...game.pendingOrders[p.id] }));

  const result = matchOrders(orders, game.mark);

  for (const fill of result.fills) {
    playerById(game, fill.playerId).fills.push({
      round: game.round, qty: fill.qty, price: fill.price,
    });
  }

  game.reveal = {
    ...result,
    orders: orders.map((o) => ({
      playerId: o.playerId,
      name: playerById(game, o.playerId).name,
      qty: o.qty,
      type: o.type,
      filled: result.fills.find((f) => f.playerId === o.playerId)?.qty ?? 0,
    })),
  };
  logLine(game, `Round ${game.round} printed ${result.price} on imbalance ${result.imbalance >= 0 ? '+' : ''}${result.imbalance}`);
  game.phase = game.options ? 'auction' : 'cards';
  if (game.options) openAuction(game, 0);
  return true;
}

// ---------------------------------------------------------------------------
// Auction phase — one gate per expiry
// ---------------------------------------------------------------------------

/**
 * Open the nth expiry for quoting, in round order — front month first.
 *
 * The board already shows which strikes carry a house order; what it does not
 * show is which way or how big, because those have not been generated yet. So
 * players quote into a `?` and are making a market rather than filling a known
 * order, which is the whole point of the exercise.
 */
function openAuction(game, index) {
  const tables = expiryTables(game.round, game.config.maxRounds, game.config.optionRules);
  if (index >= tables.length) {
    game.options.activeExpiry = null;
    game.phase = 'cards';
    logLine(game, 'Auction closed');
    return;
  }
  game.options.tableIndex = index;
  game.options.activeExpiry = tables[index].expiry;
  game.options.quotes = {};
  game.options.ready = {};
  logLine(game, `Auction open — expiry R${tables[index].expiry}`);
}

/** Replace this player's quotes for the expiry on the block. Empty means pass. */
export function submitQuotes(game, playerId, quotes = []) {
  if (game.phase !== 'auction') throw new Error('No auction is open');
  if (game.options.ready[playerId]) throw new Error('Quotes already confirmed');

  const expiry = game.options.activeExpiry;
  const strikes = strikeGrid(game.mark, game.config.optionRules);

  const clean = (Array.isArray(quotes) ? quotes : []).map((q) => {
    if (q.expiry !== expiry) throw new Error(`Quote is for R${q.expiry}, not R${expiry}`);
    if (!strikes.includes(q.strike)) throw new Error(`$${q.strike} is not on the board`);
    const num = (v, what) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${what} must be a number, or blank`);
      return n;
    };
    const q2 = makeQuote({
      playerId, expiry, kind: q.kind, strike: q.strike, round: game.round,
      bidPx: num(q.bidPx, 'Bid'), bidQty: Math.trunc(Number(q.bidQty) || 0),
      askPx: num(q.askPx, 'Ask'), askQty: Math.trunc(Number(q.askQty) || 0),
    });
    // A quote with a price but no size is an intention, not an order.
    if (q2.bidPx !== null && q2.bidQty < 1) throw new Error('A bid needs a size');
    if (q2.askPx !== null && q2.askQty < 1) throw new Error('An offer needs a size');
    if (q2.bidPx !== null && q2.askPx !== null && q2.bidPx > q2.askPx) {
      throw new Error('Your bid is above your offer');
    }
    return q2;
  });

  game.options.quotes[playerId] = clean;
  return clean;
}

export function confirmQuotes(game, playerId) {
  if (game.phase !== 'auction') throw new Error('No auction is open');
  if (!game.options.quotes[playerId]) game.options.quotes[playerId] = [];
  game.options.ready[playerId] = true;
  const p = playerById(game, playerId);
  const n = game.options.quotes[playerId].length;
  logLine(game, `${p.name} ${n ? `quoted ${n} contract${n === 1 ? '' : 's'}` : 'passed'}`);
  return maybeTripAuctionGate(game);
}

export function unconfirmQuotes(game, playerId) {
  if (game.phase !== 'auction') return false;
  delete game.options.ready[playerId];
  return true;
}

export function allQuotesReady(game) {
  return game.players.length > 0 && game.players.every((p) => game.options.ready[p.id]);
}

function maybeTripAuctionGate(game, force = false) {
  if (!force && !allQuotesReady(game)) return false;
  return tripAuctionGate(game);
}

/**
 * Close the gate: reveal this expiry's house orders, then clear every contract.
 *
 * Reveal happens here and not a moment earlier, so nobody quotes against a known
 * side or size. It scans the board for orders still carrying no side and no
 * size, which keeps the stateless property §4 asks for.
 */
export function tripAuctionGate(game) {
  if (game.phase !== 'auction') throw new Error('No auction is open');

  const cfg = game.config.optionRules;
  const expiry = game.options.activeExpiry;
  const live = game.options.orders.filter((o) => o.expiry === expiry);
  revealOrders(live, cfg);

  const quotes = Object.values(game.options.quotes).flat();
  const rank = new Map(game.players.map((p) => [p.id, position(p.fills, game.mark).pl]));

  const results = [];
  for (const order of live) {
    const result = clearContract(order, quotes, { cfg, rank });
    results.push(result);
    if (result.price === null) continue;

    game.options.marks[contractKey(result)] = result.price;
    for (const t of result.trades) {
      if (t.buyer) writeOption(game, t.buyer, result, t.qty, t.price);
      if (t.seller) writeOption(game, t.seller, result, -t.qty, t.price);
    }
  }

  const traded = results.filter((r) => r.price !== null);
  game.options.cleared = [...(game.options.cleared ?? []), { expiry, results }];
  logLine(game, `R${expiry} auction cleared — ${traded.length} of ${results.length} contracts traded`);

  openAuction(game, game.options.tableIndex + 1);
  return true;
}

/**
 * Expire everything struck for this round, against the mark the dice just set.
 *
 * The mark, not the print. The print is where the stock traded during the round;
 * the mark is where it ends up once the dice have resolved, and that is the
 * number an option struck for this round is a bet on.
 *
 * Expired rows come off the blotter, so the P/L they realised has to be kept
 * somewhere that outlives them — otherwise a player's score would quietly
 * unwind every time a contract expired.
 */
function settleOptions(game) {
  if (!game.options) return [];

  const settledRows = [];
  for (const p of game.players) {
    const { realized, settled, remaining } =
      settleExpiring(p.optionPositions, game.round, game.mark);
    if (!settled.length) continue;

    p.realizedOptionPl = (p.realizedOptionPl ?? 0) + realized;
    p.optionPositions = remaining;

    for (const s of settled) {
      const mark = intrinsic(s.kind, s.strike, game.mark);
      game.options.marks[contractKey(s)] = mark;   // the blotter's final mark
      p.settledOptions.push({
        round: game.round, kind: s.kind, strike: s.strike, expiry: s.expiry,
        qty: s.qty, mark, value: s.value,
      });
      settledRows.push({ name: p.name, qty: s.qty, kind: s.kind, strike: s.strike, mark });
    }
    logLine(game, `${p.name} settled ${settled.length} contract${settled.length === 1 ? '' : 's'} for ${realized >= 0 ? '+' : ''}${realized}`);
  }
  return settledRows;
}

function writeOption(game, playerId, contract, qty, premium) {
  const p = playerById(game, playerId);
  p.optionPositions.push(makePosition({
    playerId, kind: contract.kind, strike: contract.strike, expiry: contract.expiry,
    qty, premium, round: game.round,
  }));
  p.optionLog.push({
    round: game.round, kind: contract.kind, strike: contract.strike,
    expiry: contract.expiry, qty, premium,
  });
}

// ---------------------------------------------------------------------------
// Cards phase
// ---------------------------------------------------------------------------

export function submitCards(game, playerId, play) {
  if (game.phase !== 'cards') throw new Error('Not accepting cards');
  if (game.ready.cards[playerId]) throw new Error('Cards already confirmed');

  const p = playerById(game, playerId);
  const clean = emptyHand();
  for (const k of Object.keys(clean)) {
    const n = Math.trunc(Number(play?.[k]) || 0);
    if (n < 0) throw new Error('Cannot play a negative number of cards');
    if (n > p.hand[k]) throw new Error(`Only ${p.hand[k]} ${k} card(s) in hand`);
    clean[k] = n;
  }
  game.pendingCards[playerId] = clean;
  return clean;
}

export function confirmCards(game, playerId) {
  if (game.phase !== 'cards') throw new Error('Not accepting cards');
  if (!game.pendingCards[playerId]) game.pendingCards[playerId] = emptyHand();
  game.ready.cards[playerId] = true;
  const p = playerById(game, playerId);
  logLine(game, `${p.name} confirmed cards`);
  return maybeTripCardsGate(game);
}

export function unconfirmCards(game, playerId) {
  if (game.phase !== 'cards') return false;
  delete game.ready.cards[playerId];
  return true;
}

export function allCardsReady(game) {
  return game.players.length > 0 && game.players.every((p) => game.ready.cards[p.id]);
}

function maybeTripCardsGate(game, force = false) {
  if (!force && !allCardsReady(game)) return false;
  return tripCardsGate(game);
}

/** Reveal cards, spend them, and compute the pressure the dice will feel. */
export function tripCardsGate(game) {
  if (game.phase !== 'cards') throw new Error('Cards gate is not open');

  // Same rule as orders: unconfirmed cards stay in hand and cost nothing.
  const plays = [];
  for (const p of game.players) {
    const play = (game.ready.cards[p.id] && game.pendingCards[p.id]) || emptyHand();
    for (const k of Object.keys(play)) p.hand[k] -= play[k];
    plays.push({ ...play, playerId: p.id, name: p.name });
  }

  const cards = cardEffects(plays);
  const regime = regimeEffects(game.history);

  game.net = {
    cards,
    regime,
    trend: regime.trend + cards.trend,
    mag: regime.mag + cards.mag,
    plays,
  };
  game.phase = 'rolling';
  logLine(game, `Cards revealed — net trend ${fmtSigned(game.net.trend)}, net magnitude ${fmtSigned(game.net.mag)}`);
  return true;
}

// ---------------------------------------------------------------------------
// Rolling phase
// ---------------------------------------------------------------------------

/**
 * Named for what they decide, not for the arithmetic they feed. A player needs
 * to know the second die sets how violent the move is, not that it picks
 * between two operators.
 */
export const DIE_LABELS = ['Trend die', 'Volatility die', 'Size A', 'Size B'];

export function rollStep(game) {
  return game.dice.filter((d) => d !== null).length;
}

/** Roll and lock the next die. The fourth one closes the round. */
export function lockRoll(game, rng = Math.random, forced = null) {
  if (game.phase !== 'rolling') throw new Error('Not rolling');
  const step = rollStep(game);
  if (step >= 4) throw new Error('All four dice are locked');

  const value = forced ?? rollDie(rng);
  game.dice[step] = value;
  logLine(game, `${DIE_LABELS[step]}: ${value}`);

  if (rollStep(game) === 4) return settleRound(game);
  return { settled: false };
}

function settleRound(game) {
  const { trend, type, chg } = resolveDice(game.dice, game.net);
  const priorMark = game.mark;
  game.mark = priorMark + chg;

  game.history.push({
    round: game.round,
    limitBid: game.reveal.limitBid,
    marketBid: game.reveal.marketBid,
    imbalance: game.reveal.imbalance,
    marketOffer: game.reveal.marketOffer,
    limitOffer: game.reveal.limitOffer,
    pressure: game.reveal.pressure,
    absorbed: game.reveal.absorbed,
    print: game.reveal.price,
    houseResidual: game.reveal.houseResidual,
    regime: game.net.regime,
    cards: game.net.cards,
    plays: game.net.plays,
    net: { trend: game.net.trend, mag: game.net.mag },
    dice: game.dice.slice(),
    trend,
    type,
    chg,
    priorMark,
    mark: game.mark,
  });

  logLine(game, `Round ${game.round} settled ${fmtSigned(chg)} to ${game.mark} (${type})`);

  // Options struck for this round expire against the mark the dice just set.
  const expired = settleOptions(game);
  if (expired.length) game.history[game.history.length - 1].expired = expired;

  if (game.round >= game.config.maxRounds) {
    game.phase = 'complete';
    logLine(game, `Game over — final mark ${game.mark}`);
  } else {
    game.round += 1;
    game.phase = 'orders';
    clearRound(game);
  }
  return { settled: true, trend, type, chg, mark: game.mark };
}

// ---------------------------------------------------------------------------
// Host overrides
// ---------------------------------------------------------------------------

export function forceGate(game) {
  if (game.phase === 'orders') {
    // Anyone who never submitted sits the round out flat.
    logLine(game, 'Host forced the orders gate');
    return maybeTripOrdersGate(game, true);
  }
  if (game.phase === 'auction') {
    logLine(game, 'Host forced the auction gate');
    return maybeTripAuctionGate(game, true);
  }
  if (game.phase === 'cards') {
    logLine(game, 'Host forced the cards gate');
    return maybeTripCardsGate(game, true);
  }
  throw new Error('No gate to force in this phase');
}

export function resetGame(game) {
  game.phase = 'lobby';
  game.round = 0;
  game.mark = game.config.openingPrice;
  game.history = [];
  game.log = [];
  game.options = null;
  clearRound(game);
  for (const p of game.players) {
    p.hand = emptyHand();
    p.initialHand = emptyHand();
    p.fills = [];
    delete p.optionPositions;
    delete p.optionLog;
    delete p.settledOptions;
    delete p.realizedOptionPl;
  }
  logLine(game, 'Game reset to lobby');
}

export function updateConfig(game, patch) {
  if (game.phase !== 'lobby') throw new Error('Config is locked once the game starts');
  const next = { ...game.config, ...patch };
  next.maxRounds = clampInt(next.maxRounds, 1, 10);
  next.cardQty = clampInt(next.cardQty, 0, 25);
  next.openingPrice = clampInt(next.openingPrice, 1, 10000);
  next.options = !!next.options;
  next.optionRules = {
    ...OPTION_DEFAULTS, ...(game.config.optionRules ?? {}), ...(patch.optionRules ?? {}),
  };
  next.optionRules.expiryCount = clampInt(next.optionRules.expiryCount, 1, 3);
  if (game.players.length * next.cardQty > 100) {
    throw new Error(`${game.players.length} players x ${next.cardQty} cards exceeds the 100-card deck`);
  }
  game.config = next;
  game.mark = next.openingPrice;
  return next;
}

function clampInt(v, lo, hi) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) throw new Error('Expected a number');
  return Math.min(hi, Math.max(lo, n));
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function playerById(game, id) {
  const p = game.players.find((x) => x.id === id);
  if (!p) throw new Error('Unknown player');
  return p;
}

/**
 * A player's P/L, stock and options together.
 *
 * Options mark against the last price the auction discovered; a contract the
 * auction has not priced is carried flat rather than at an invented value.
 */
function withOptions(game, p) {
  const stock = position(p.fills, game.mark);
  if (!game.options) return stock;
  const marks = new Map(Object.entries(game.options.marks));
  const open = optionPL(p.optionPositions ?? [], marks);
  const options = open + (p.realizedOptionPl ?? 0);
  return { ...stock, stockPl: stock.pl, optionPl: options, pl: stock.pl + options };
}

export function standings(game) {
  return game.players
    .map((p) => ({
      id: p.id,
      seat: p.seat,
      name: p.name,
      ...withOptions(game, p),
      cardsLeft: p.hand.up + p.hand.down + p.hand.multiply + p.hand.add,
      ordersReady: !!game.ready.orders[p.id],
      cardsReady: !!game.ready.cards[p.id],
      submittedOrder: !!game.pendingOrders[p.id],
      submittedCards: !!game.pendingCards[p.id],
    }))
    .sort((a, b) => b.pl - a.pl || a.seat - b.seat);
}

/**
 * What everyone can see. Orders and cards stay hidden until their gate trips —
 * the reveal is the whole drama, so this is the one thing worth being strict about.
 */
export function publicState(game) {
  return {
    code: game.code,
    phase: game.phase,
    round: game.round,
    maxRounds: game.config.maxRounds,
    cardQty: game.config.cardQty,
    expiryCount: game.config.optionRules.expiryCount,
    mark: game.mark,
    openingPrice: game.config.openingPrice,
    // The options board is public in full. Between indicate and reveal a house
    // order has no side and no size to leak — those values are not withheld,
    // they have not been generated yet.
    options: game.config.options,
    optionBoard: game.options ? {
      anchor: game.mark,
      tables: expiryTables(game.round, game.config.maxRounds, game.config.optionRules)
        .map((t) => ({ ...t, strikes: strikeGrid(game.mark, game.config.optionRules) })),
      orders: game.options.orders,
      marks: game.options.marks,
      // Only contracts carrying a house order can clear — the auction runs one
      // order at a time — so this is exactly the set worth quoting.
      quotable: game.options.activeExpiry === null ? [] :
        game.options.orders.filter((o) => o.expiry === game.options.activeExpiry),
    } : null,
    standings: standings(game),
    history: game.history,
    reveal: game.phase === 'orders' ? null : game.reveal,
    net: game.phase === 'orders' || game.phase === 'cards' ? null : game.net,
    dice: game.dice,
    rollStep: rollStep(game),
    dieLabel: DIE_LABELS[rollStep(game)] ?? null,
    log: game.log.slice(-40),
    seated: game.players.length,
    // Counts only — knowing three people have committed is fair game, knowing
    // what they committed is not.
    auction: game.options?.activeExpiry != null ? {
      expiry: game.options.activeExpiry,
      cleared: game.options.cleared ?? [],
      awaiting: game.players.filter((p) => !game.options.ready?.[p.id]).map((p) => p.name),
    } : null,
    awaitingOrders: game.players.filter((p) => !game.ready.orders[p.id]).map((p) => p.name),
    awaitingCards: game.players.filter((p) => !game.ready.cards[p.id]).map((p) => p.name),
  };
}

/** Everything above, plus this player's own private hand, order and blotter. */
export function privateState(game, playerId) {
  const p = game.players.find((x) => x.id === playerId);
  if (!p) return null;
  return {
    me: {
      id: p.id,
      seat: p.seat,
      name: p.name,
      hand: p.hand,
      initialHand: p.initialHand,
      fills: p.fills,
      ...withOptions(game, p),
      pendingOrder: game.pendingOrders[p.id] ?? null,
      pendingCards: game.pendingCards[p.id] ?? null,
      ordersReady: !!game.ready.orders[p.id],
      cardsReady: !!game.ready.cards[p.id],
      // Options are private by construction: a player's book and quotes are
      // theirs alone, and none of it appears in publicState.
      ...(game.config.options ? {
        optionPositions: p.optionPositions ?? [],
        optionLog: p.optionLog ?? [],
        settledOptions: p.settledOptions ?? [],
        realizedOptionPl: p.realizedOptionPl ?? 0,
        quotes: game.options?.quotes?.[p.id] ?? [],
        quotesReady: !!game.options?.ready?.[p.id],
      } : {}),
    },
  };
}

function fmtSigned(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}
