/**
 * Game state machine.
 *
 * A round runs through two gates, mirroring the two ready-columns the
 * spreadsheet tracked:
 *
 *   auction -> options only: one gate per expiry, in round order. Everyone
 *              quotes the strikes they want or passes
 *              (gate) reveal that expiry's house orders, clear every contract
 *   orders  -> everyone submits qty + LIMIT/MARKET and confirms
 *              (gate) reveal the book, print the fill, write every blotter
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
  contractKey, optionPL, settleExpiring, intrinsic, fixedExpiriesFor, rollupPositions,
} from './options.js';

import { BOT_NAMES, botOrder, botCards, botQuotes } from './bots.js';

export const PHASES = ['lobby', 'auction', 'orders', 'cards', 'rolling', 'complete'];

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

/**
 * Seat a bot. Same seat as anyone else, same cap, same deal of cards; the only
 * difference is the flag, which is what makes it act when a phase opens.
 */
export function addBot(game) {
  const taken = new Set(game.players.map((p) => p.name));
  const name = BOT_NAMES.find((n) => !taken.has(n));
  if (!name) throw new Error('Out of bot names');
  const bot = addPlayer(game, name);
  bot.bot = true;
  return bot;
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
  game.history = [];
  clearRound(game, rng);
  beginRound(game, rng);
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
    game.options.tape = [];
    game.options.activeExpiry = null;
    game.options.tableIndex = 0;
  }
}

/**
 * Open a round on its first gate.
 *
 * Options trade before stock, deliberately. It means somebody who has just been
 * hung with a short call can go and buy the underlying against it in the same
 * round — the delta hedge is the whole reason the two legs sit in one game, and
 * running stock first would push every hedge a round late, after the dice have
 * already settled the thing you were hedging.
 *
 * It also puts the harder decision first, while attention is fresh, and leaves
 * the stock order knowing who got filled with what — which is a read worth
 * having rather than a leak.
 */
function beginRound(game, rng = Math.random) {
  if (game.options) {
    game.phase = 'auction';
    openAuction(game, 0, rng);
  } else {
    game.phase = 'orders';
    runBots(game, rng);
  }
}

/**
 * Let every bot owing the current phase act, then confirm.
 *
 * Called whenever a gated phase opens. Bots confirm immediately, so a gate only
 * ever waits on the humans — and if every seat is a bot the gate trips here and
 * the next phase opens, which calls this again, until the dice, which are the
 * host's to throw. A bot's action can throw like anyone's would (a card it does
 * not hold, say); that is a bug in the bot, not something to hide, so it is not
 * caught.
 */
function runBots(game, rng = Math.random) {
  for (const bot of game.players.filter((p) => p.bot)) {
    if (game.phase === 'auction' && !game.options.ready[bot.id]) {
      submitQuotes(game, bot.id, botQuotes(game, bot, rng));
      confirmQuotes(game, bot.id);
    } else if (game.phase === 'orders' && !game.ready.orders[bot.id]) {
      submitOrder(game, bot.id, botOrder(game, bot, rng));
      confirmOrder(game, bot.id);
    } else if (game.phase === 'cards' && !game.ready.cards[bot.id]) {
      submitCards(game, bot.id, botCards(game, bot, rng));
      confirmCards(game, bot.id);
    }
    // Confirming may have tripped the gate and moved the phase on; the loop
    // simply carries on into whatever opened, which is what we want.
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
  game.phase = 'cards';
  runBots(game);
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
function openAuction(game, index, rng = Math.random) {
  const tables = expiryTables(game.round, game.config.maxRounds, game.config.optionRules);
  if (index >= tables.length) {
    game.options.activeExpiry = null;
    game.phase = 'orders';
    // A round with nothing left to expire has no auction to close.
    logLine(game, tables.length
      ? 'Auction closed — the future is open'
      : 'No expiries ahead — straight to the future');
    runBots(game, rng);
    return;
  }
  game.options.tableIndex = index;
  game.options.activeExpiry = tables[index].expiry;
  game.options.quotes = {};
  game.options.ready = {};
  logLine(game, `Auction open — expiry R${tables[index].expiry}`);
  runBots(game, rng);
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

  // Only confirmed quotes clear, the same rule the orders gate uses. Typing a
  // market is not committing to it, so a forced gate leaves the undecided out
  // rather than trading prices they never stood behind.
  const quotes = game.players
    .filter((p) => game.options.ready[p.id])
    .flatMap((p) => game.options.quotes[p.id] ?? []);
  const rank = new Map(game.players.map((p) => [p.id, position(p.fills, game.mark).pl]));

  const results = [];
  for (const order of live) {
    const result = clearContract(order, quotes, { cfg, rank });
    results.push(result);
    if (result.price === null) continue;

    game.options.marks[contractKey(result)] = result.last;
    for (const t of result.trades) {
      if (t.buyer) writeOption(game, t.buyer, result, t.qty, t.price);
      if (t.seller) writeOption(game, t.seller, result, -t.qty, t.price);
    }
  }

  const traded = results.filter((r) => r.price !== null);
  game.options.cleared = [...(game.options.cleared ?? []), { expiry, results }];

  // The tape: every fill, by name, in one flat list. The clearing results above
  // are keyed by player id and nested by contract, which is the right shape for
  // settlement and the wrong shape for a table trying to work out what just
  // happened to them. "Who bought what from whom at what price" is a row.
  const name = (id) => (id ? playerById(game, id).name : 'HOUSE');
  for (const r of results) {
    for (const t of r.trades) {
      game.options.tape.push({
        round: game.round, expiry: r.expiry, kind: r.kind, strike: r.strike,
        buyer: name(t.buyer), seller: name(t.seller), qty: t.qty, price: t.price,
      });
      logLine(game, `${name(t.buyer)} bought ${t.qty} ${r.strike} ${r.kind}${t.qty === 1 ? '' : 's'} R${r.expiry} from ${name(t.seller)} at ${t.price}`);
    }
  }
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
 * Settlement is physical. A contract that finishes in the money is exercised
 * into a stock fill at the strike — written onto the player's blotter like any
 * other fill, flagged so the blotter can say where it came from — and from then
 * on it is stock, carried into the next round and hedged or not like any other
 * position. The premium is the only thing booked as option P/L. Expired rows
 * come off the option book, so that premium has to be kept somewhere that
 * outlives them, or a score would quietly unwind every time a contract expired.
 */
function settleOptions(game, priorCoinMark) {
  if (!game.options) return [];

  // Snapshot the marks before anyone settles: the first player through sets a
  // contract's mark to intrinsic, and the second holder of the same contract
  // would otherwise read that back as the mark they were carrying. Floored at
  // intrinsic against the coin's mark going into the dice, which is what the
  // table was looking at.
  const priorMarks = effectiveMarks(game, priorCoinMark);

  const settledRows = [];
  for (const p of game.players) {
    const { realized, settled, remaining } =
      settleExpiring(p.optionPositions, game.round, game.mark);
    if (!settled.length) continue;

    p.realizedOptionPl = (p.realizedOptionPl ?? 0) + realized;
    p.optionPositions = remaining;

    for (const s of settled) {
      // The mark the position was carried at going into the dice — the last
      // auction price, or the premium when nothing has cleared since. The
      // expiry's P/L against that is what the round did to you; against the
      // premium is what the whole trade did.
      const priorMark = priorMarks[contractKey(s)]
        ?? Math.max(s.cost / s.qty, intrinsic(s.kind, s.strike, priorCoinMark));
      s.priorMark = priorMark;
      s.plFromMark = (s.intrinsic - priorMark) * s.qty;
      s.plAllIn = s.intrinsic * s.qty - s.cost;
      game.options.marks[contractKey(s)] = s.intrinsic;   // the blotter's final mark
      if (s.shares !== 0) {
        p.fills.push({
          round: game.round, qty: s.shares, price: s.strike,
          exercise: { kind: s.kind, strike: s.strike, expiry: s.expiry, contracts: s.qty },
        });
      }
      p.settledOptions.push({
        round: game.round, kind: s.kind, strike: s.strike, expiry: s.expiry,
        qty: s.qty, mark: s.intrinsic, value: s.value, shares: s.shares,
        priorMark: s.priorMark, plFromMark: s.plFromMark, plAllIn: s.plAllIn,
      });
      settledRows.push({
        name: p.name, qty: s.qty, kind: s.kind, strike: s.strike,
        mark: s.intrinsic, shares: s.shares, priorMark: s.priorMark, plFromMark: s.plFromMark,
      });
      const what = `${s.qty > 0 ? '+' : ''}${s.qty} ${s.strike} ${s.kind}${Math.abs(s.qty) === 1 ? '' : 's'}`;
      logLine(game, s.shares === 0
        ? `${p.name}: ${what} expired worthless`
        : `${p.name}: ${what} exercised → ${fmtSigned(s.shares)} shares at ${s.strike}`);
    }
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
  const expired = settleOptions(game, priorMark);
  const h = game.history[game.history.length - 1];
  if (expired.length) h.expired = expired;
  // This round's option fills go into the record with it, so the tape reads
  // back round by round after the auction state has been wiped for the next.
  if (game.options?.tape?.length) h.optionTrades = game.options.tape;

  if (game.round >= game.config.maxRounds) {
    game.phase = 'complete';
    logLine(game, `Game over — final mark ${game.mark}`);
  } else {
    game.round += 1;
    clearRound(game);
    beginRound(game);
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
  // The picker sends an empty list when the host unticks the last round. That
  // is a real choice — options on, nothing expiring — not a request for the
  // derived default, so it has to survive as an empty array rather than null.
  // An explicit pick survives as an explicit pick, pruned to the game length —
  // shortening the game must not leave an expiry hanging past the last round.
  const rounds = (xs) => [...new Set(xs)]
    .map((e) => Math.trunc(Number(e)))
    .filter((e) => Number.isInteger(e) && e >= 1 && e <= next.maxRounds)
    .sort((a, b) => a - b);
  if (Array.isArray(next.optionRules.fixedExpiries)) {
    next.optionRules.fixedExpiries = rounds(next.optionRules.fixedExpiries);
  }
  next.optionRules.zeroDay = rounds(next.optionRules.zeroDay ?? []);
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
/**
 * The marks as the table sees them: each contract's last sale, floored at what
 * it is in the money by against the coin's current mark. Only for contracts
 * still alive — an expired one was marked at its final intrinsic when it
 * settled, and the coin moving afterwards has nothing to do with it.
 */
function effectiveMarks(game, coinMark = game.mark) {
  const out = {};
  for (const [key, last] of Object.entries(game.options.marks)) {
    const [expiry, kind, strike] = key.split('|');
    out[key] = Number(expiry) >= game.round
      ? Math.max(last, intrinsic(kind, Number(strike), coinMark))
      : last;
  }
  return out;
}

function withOptions(game, p) {
  const stock = position(p.fills, game.mark);
  if (!game.options) return stock;
  const marks = new Map(Object.entries(game.options.marks));
  const open = optionPL(p.optionPositions ?? [], marks, game.mark);
  const options = open + (p.realizedOptionPl ?? 0);
  return { ...stock, stockPl: stock.pl, optionPl: options, pl: stock.pl + options };
}

/**
 * Open interest, contract by contract: how many contracts are outstanding.
 *
 * Every contract has a long and a short, and the house is one of the parties,
 * so counting only the players' books under-counts whenever the house is net
 * anything. With the house's position being minus the players' total, the
 * outstanding count per contract is half the sum of everyone's absolute
 * position, house included — which is (Σ|player net| + |Σ player net|) / 2.
 *
 * This is what the wall shows instead of anyone's book: how much is open where,
 * which is a market fact, rather than who is long it, which is theirs.
 */
function openInterest(game) {
  const by = new Map();
  for (const p of game.players) {
    for (const r of rollupPositions(p.optionPositions ?? [])) {
      const k = contractKey(r);
      const row = by.get(k) ?? { expiry: r.expiry, kind: r.kind, strike: r.strike, abs: 0, net: 0 };
      row.abs += Math.abs(r.qty);
      row.net += r.qty;
      by.set(k, row);
    }
  }
  return [...by.values()]
    .map(({ expiry, kind, strike, abs, net }) => ({ expiry, kind, strike, qty: (abs + Math.abs(net)) / 2 }))
    .filter((r) => r.qty > 0)
    .sort((a, b) => a.expiry - b.expiry || a.strike - b.strike || a.kind.localeCompare(b.kind));
}

/**
 * The scoreboard. Rank and P/L are public; what anyone is holding in the
 * stock is not — position, average price, and the stock/option split that
 * would let a position be backed out of it all stay on the player's own mat.
 */
export function standings(game) {
  return game.players
    .map((p) => ({
      id: p.id,
      seat: p.seat,
      name: p.name,
      bot: !!p.bot,
      pl: withOptions(game, p).pl,
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
    // The effective set, so the lobby shows what is actually selected rather
    // than what was typed.
    expiries: fixedExpiriesFor(game.config.maxRounds, game.config.optionRules),
    zeroDay: (game.config.optionRules.zeroDay ?? [])
      .filter((e) => fixedExpiriesFor(game.config.maxRounds, game.config.optionRules).includes(e)),
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
      marks: effectiveMarks(game),
      // Only contracts carrying a house order can clear — the auction runs one
      // order at a time — so this is exactly the set worth quoting.
      quotable: game.options.activeExpiry === null ? [] :
        game.options.orders.filter((o) => o.expiry === game.options.activeExpiry),
    } : null,
    standings: standings(game),
    // Every option fill this round so far, by name. Public on purpose: a trade
    // has two sides and both of them, and the rest of the table, should be able
    // to read it off the wall rather than reconstruct it from their blotters.
    optionTrades: game.options?.tape ?? [],
    openInterest: game.options ? openInterest(game) : [],
    history: game.history,
    // The book in aggregate only. The per-player orders and fills behind it
    // stay out of the shared payload: a player's own are on their mat, and
    // everyone else's are nobody's business.
    reveal: game.phase === 'orders' || !game.reveal ? null : (({ orders, fills, ...book }) => book)(game.reveal),
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
