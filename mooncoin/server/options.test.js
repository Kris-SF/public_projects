/**
 * Options layer — data model tests (stage 1).
 *
 * The headline is TEST 6 from the build brief: strikes float, positions lock.
 * The spec calls that the mechanic most likely to be implemented wrong, so it
 * gets tested before anything is built on top of it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPTION_DEFAULTS, strikeGrid, isTradeable, expiryTables,
  makePosition, makeMarketOrder, makeQuote, isIndicated,
  indicateOrders, revealOrders, clearContract,
  rollupPositions, grossOptionInventory, intrinsic, settleExpiring,
  optionPL, contractKey,
} from './options.js';
import {
  createGame, addPlayer, startGame, privateState, publicState,
  submitOrder, confirmOrder, submitQuotes, confirmQuotes, forceGate,
} from './game.js';

// --- §2 the floating grid ---------------------------------------------------

test('nine strikes, ATM in the middle, ascending', () => {
  const g = strikeGrid(100);
  assert.equal(g.length, 9);
  assert.deepEqual(g, [80, 85, 90, 95, 100, 105, 110, 115, 120]);
  assert.equal(g[4], 100, 'ATM sits in the middle row');
});

test('the anchor is not rounded to the increment', () => {
  // The spec's own example: an anchor of $107 gives $87 through $127.
  assert.deepEqual(strikeGrid(107), [87, 92, 97, 102, 107, 112, 117, 122, 127]);
});

test('increment and depth are configurable', () => {
  const g = strikeGrid(100, { ...OPTION_DEFAULTS, strikeIncrement: 10, strikeDepth: 2 });
  assert.deepEqual(g, [80, 90, 100, 110, 120]);
});

// --- TEST 6 from the brief --------------------------------------------------

test('TEST 6 — strikes float, positions lock', () => {
  // R1 last sale $100 → auctionable strikes $80–$120
  const r1 = strikeGrid(100);
  assert.equal(r1[0], 80);
  assert.equal(r1[8], 120);

  // R4 last sale $107 → auctionable strikes $87–$127
  const r4 = strikeGrid(107);
  assert.equal(r4[0], 87);
  assert.equal(r4[8], 127);

  // A $100 call bought in R1...
  const pos = makePosition({
    playerId: 'p1', kind: 'call', strike: 100, expiry: 5, qty: 1, premium: 12, round: 1,
  });
  assert.ok(isTradeable(pos.strike, 100), '$100 is on the R1 board');

  // ...is still a $100 call in R4, even though $100 is no longer auctionable.
  assert.equal(pos.strike, 100);
  assert.equal(isTradeable(pos.strike, 107), false, '$100 has fallen off the R4 board');

  // ...and still settles against $100.
  assert.equal(intrinsic(pos.kind, pos.strike, 116), 16);
  const { realized } = settleExpiring([pos], 5, 116);
  assert.equal(realized, 16 - 12, 'settles against its own locked strike, less premium');
});

test('a locked strike survives the grid moving away and back', () => {
  const pos = makePosition({
    playerId: 'p1', kind: 'put', strike: 95, expiry: 5, qty: -2, premium: 4, round: 1,
  });
  for (const anchor of [100, 107, 120, 95]) {
    assert.equal(pos.strike, 95, `unchanged with the board at ${anchor}`);
  }
  // Short 2 puts struck 95 at $4, settling at 90: pays 5 each, keeps the premium.
  assert.equal(settleExpiring([pos], 5, 90).realized, (5 - 4) * -2);
});

// --- §3 expiry tables -------------------------------------------------------

/** Three live tables — the spec's current/mid/final. Default is two. */
const T3 = { ...OPTION_DEFAULTS, expiryCount: 3 };

test('expiryCount sets how many tables are live at once', () => {
  const at = (count) => expiryTables(1, 5, { ...OPTION_DEFAULTS, expiryCount: count })
    .map((t) => t.expiry);
  assert.deepEqual(at(1), [1], 'front month only');
  assert.deepEqual(at(2), [1, 5], 'plus full-game exposure');
  assert.deepEqual(at(3), [1, 3, 5], 'plus the midpoint');
  assert.deepEqual(expiryTables(1, 5).map((t) => t.expiry), [1, 5], 'two by default');
});

test('three tables early, and the set shrinks as expiries pass', () => {
  const rounds = (r) => expiryTables(r, 5, T3).map((t) => t.expiry);
  assert.deepEqual(rounds(1), [1, 3, 5]);
  assert.deepEqual(rounds(2), [2, 3, 5]);
  assert.deepEqual(rounds(3), [3, 5], 'R3 is the current-round table, not listed twice');
  assert.deepEqual(rounds(4), [4, 5]);
  assert.deepEqual(rounds(5), [5], 'the last round is a single front-month table');
});

test('the derived expiries scale with the game length', () => {
  assert.deepEqual(expiryTables(1, 10, T3).map((t) => t.expiry), [1, 5, 10]);
  assert.deepEqual(expiryTables(1, 3, T3).map((t) => t.expiry), [1, 2, 3]);
  assert.deepEqual(expiryTables(1, 1, T3).map((t) => t.expiry), [1], 'a one-round game');
});

test('fixed expiries beyond the game length are dropped', () => {
  assert.deepEqual(expiryTables(1, 3).map((t) => t.expiry), [1, 3]);
  assert.deepEqual(expiryTables(1, 10, { ...OPTION_DEFAULTS, fixedExpiries: [4, 8] })
    .map((t) => t.expiry), [1, 4, 8]);
});

// --- §4 order shapes --------------------------------------------------------

test('a generated order carries no side or size until reveal', () => {
  const o = makeMarketOrder({ expiry: 3, kind: 'call', strike: 100 });
  assert.equal(o.side, null);
  assert.equal(o.qty, null);
  assert.ok(isIndicated(o), 'null side and size is the ? placeholder');
  assert.equal(isIndicated({ ...o, qty: 4, side: 'BUY' }), false);
});

test('a quote may be one-sided, and a blank side carries no size', () => {
  const q = makeQuote({
    playerId: 'p1', expiry: 3, kind: 'call', strike: 100,
    bidPx: 10, bidQty: 2, askPx: null, askQty: 5, round: 1,
  });
  assert.equal(q.bidPx, 10);
  assert.equal(q.bidQty, 2);
  assert.equal(q.askPx, null);
  assert.equal(q.askQty, 0, 'no price means no size on that side');
});

test('an unknown option kind is refused at every entry point', () => {
  for (const fn of [makePosition, makeMarketOrder, makeQuote]) {
    assert.throws(() => fn({ kind: 'straddle', strike: 100, expiry: 3 }), /Unknown option kind/);
  }
});

// --- §4 order generation ----------------------------------------------------

/** Deterministic rng so a sampled board can be asserted exactly. */
const seeded = (seed) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const countFor = (orders, expiry) => orders.filter((o) => o.expiry === expiry).length;

test('a table gets 2 + 2X orders, so four at the default X=1', () => {
  const orders = indicateOrders(1, 5, 100, T3, seeded(7));
  assert.equal(orders.length, 12, 'three tables');
  for (const expiry of [1, 3, 5]) assert.equal(countFor(orders, expiry), 4);
});

test("X=2 reproduces the spec's stated six per table and eighteen per round", () => {
  // The spec claims 6 and 18 at X=1, but its own formula (ATM pair + X each
  // side) only reaches six at X=2. Pinned here so the discrepancy stays visible.
  const cfg = { ...T3, otmOrdersPerSide: 2 };
  const orders = indicateOrders(1, 5, 100, cfg, seeded(7));
  assert.equal(orders.length, 18);
  for (const expiry of [1, 3, 5]) assert.equal(countFor(orders, expiry), 6);
});

test('the ATM call and put always get an order', () => {
  for (let s = 1; s <= 25; s++) {
    const orders = indicateOrders(1, 5, 100, T3, seeded(s));
    const atm = orders.filter((o) => o.expiry === 3 && o.strike === 100);
    assert.deepEqual(atm.map((o) => o.kind).sort(), ['call', 'put'], `seed ${s}`);
  }
});

test('OTM means OTM — calls above the money, puts below', () => {
  for (let s = 1; s <= 25; s++) {
    for (const o of indicateOrders(1, 5, 100, OPTION_DEFAULTS, seeded(s))) {
      if (o.strike === 100) continue;
      if (o.kind === 'call') assert.ok(o.strike > 100, `call struck ${o.strike} is not OTM`);
      else assert.ok(o.strike < 100, `put struck ${o.strike} is not OTM`);
    }
  }
});

test('OTM strikes are sampled without replacement', () => {
  const cfg = { ...T3, otmOrdersPerSide: 4 };
  const orders = indicateOrders(1, 5, 100, cfg, seeded(11));
  assert.equal(countFor(orders, 3), 10, 'ATM pair plus four each side');

  const calls = orders.filter((o) => o.expiry === 3 && o.kind === 'call').map((o) => o.strike);
  assert.equal(new Set(calls).size, calls.length, 'no strike drawn twice');
  assert.deepEqual(calls.slice().sort((a, b) => a - b), [100, 105, 110, 115, 120]);
});

test('X can never exceed the number of OTM strikes that exist', () => {
  const cfg = { ...T3, otmOrdersPerSide: 99 };
  const orders = indicateOrders(1, 5, 100, cfg, seeded(3));
  assert.equal(countFor(orders, 3), 10, 'clamped to the four strikes per side');
});

test('indicate withholds side and size by not generating them', () => {
  const orders = indicateOrders(1, 5, 100, OPTION_DEFAULTS, seeded(5));
  assert.ok(orders.every(isIndicated));
  // The strongest form of hiding: there is nothing in the payload to redact.
  const wire = JSON.stringify(orders);
  assert.equal(wire.includes('"side":null'), true);
  assert.equal(/"qty":\s*[0-9]/.test(wire), false, 'no size exists yet');
  assert.equal(wire.includes('price'), false, 'and no price, ever');
});

test('reveal fills every placeholder with a side and a legal size', () => {
  const orders = indicateOrders(1, 5, 100, T3, seeded(9));
  const n = revealOrders(orders, OPTION_DEFAULTS, seeded(21));

  assert.equal(n, 12);
  assert.equal(orders.some(isIndicated), false);
  for (const o of orders) {
    assert.ok(['BUY', 'SELL'].includes(o.side));
    assert.ok(Number.isInteger(o.qty) && o.qty >= 1 && o.qty <= 10, `qty ${o.qty} out of range`);
    assert.equal('price' in o, false, 'reveal never generates a price');
  }
});

test('reveal is stateless — it reads the board, not the indicate step', () => {
  const orders = indicateOrders(1, 5, 100, T3, seeded(4));
  revealOrders(orders, OPTION_DEFAULTS, seeded(2));

  const before = orders.map((o) => `${o.side}${o.qty}`);

  // A game master hand-adds a row after the reveal, and hand-edits another.
  orders.push(makeMarketOrder({ expiry: 5, kind: 'put', strike: 85 }));
  orders[0].qty = 7;
  orders[0].side = 'SELL';

  const n = revealOrders(orders, OPTION_DEFAULTS, seeded(31));
  assert.equal(n, 1, 'only the new placeholder is filled');
  assert.equal(orders[0].qty, 7, 'a hand-filled row is left alone');
  assert.equal(orders[0].side, 'SELL');
  // Index 0 is the row we just hand-edited, so compare from 1.
  assert.deepEqual(orders.slice(1, 12).map((o) => `${o.side}${o.qty}`), before.slice(1),
    'already-revealed orders are never re-rolled');
  assert.equal(isIndicated(orders[12]), false, 'the added row got revealed');
});

test('the table set shrinks with the expiries, and so does the order count', () => {
  const at = (round) => indicateOrders(round, 5, 100, T3, seeded(13)).length;
  assert.equal(at(1), 12, 'three tables');
  assert.equal(at(3), 8, 'two tables');
  assert.equal(at(5), 4, 'one table');
});

test('full coverage puts a house order on every listed contract', () => {
  const cfg = { ...T3, orderCoverage: 'all' };
  const orders = indicateOrders(1, 5, 100, cfg, seeded(6));
  assert.equal(countFor(orders, 3), 18, 'nine strikes, calls and puts');
  assert.equal(orders.length, 54);
  assert.ok(orders.every(isIndicated), 'still nothing generated until reveal');
});

// --- §5 the clearing engine: the six acceptance tests -----------------------

const CALL = { expiry: 3, kind: 'call', strike: 100 };
const mkt = (side, qty, c = CALL) => ({ ...c, side, qty });
const bid = (playerId, qty, px, c = CALL) =>
  makeQuote({ playerId, ...c, bidPx: px, bidQty: qty, round: 1 });
const ask = (playerId, qty, px, c = CALL) =>
  makeQuote({ playerId, ...c, askPx: px, askQty: qty, round: 1 });
const clear = (order, quotes) => clearContract(order, quotes, { rng: () => 0.5 });
const trade = (t) => [t.seller ?? 'HOUSE', t.buyer ?? 'HOUSE', t.qty, t.price];

test('TEST 1 — secondary fill occurs', () => {
  const r = clear(mkt('BUY', 1), [
    ask('alice', 1, 12),
    ask('bob', 1, 18),
    bid('charlie', 1, 20),
  ]);

  assert.equal(r.price, 12, 'clearing price $12');
  assert.deepEqual(r.trades.map(trade), [
    ['alice', 'HOUSE', 1, 12],     // Alice sells 1 to market @ $12
    ['bob', 'charlie', 1, 12],     // Charlie buys 1 from Bob at the CLEARING price
  ]);
});

test('TEST 2 — no secondary fill', () => {
  const PUT = { expiry: 4, kind: 'put', strike: 100 };
  const r = clear(mkt('SELL', 2, PUT), [
    bid('alice', 2, 15, PUT),
    bid('bob', 1, 10, PUT),
    ask('charlie', 1, 14, PUT),
  ]);

  assert.equal(r.price, 15);
  assert.deepEqual(r.trades.map(trade), [['HOUSE', 'alice', 2, 15]]);
  // $10 bid does not cross the $14 offer.
  assert.equal(r.trades.filter((t) => !t.house).length, 0);
});

test('TEST 3 — spillover from a partially filled resting order', () => {
  const C = { expiry: 5, kind: 'call', strike: 105 };
  const r = clear(mkt('BUY', 1, C), [
    ask('alice', 2, 10, C),
    bid('bob', 1, 16, C),
  ]);

  assert.equal(r.price, 10);
  assert.deepEqual(r.trades.map(trade), [
    ['alice', 'HOUSE', 1, 10],
    ['alice', 'bob', 1, 10],   // Bob takes Alice's remaining size
  ]);
});

test('TEST 4 — walking the book', () => {
  const r = clear(mkt('BUY', 5), [
    ask('alice', 2, 10),
    ask('bob', 4, 14),
  ]);

  assert.deepEqual(r.trades.map(trade), [
    ['alice', 'HOUSE', 2, 10],
    ['bob', 'HOUSE', 3, 14],   // own limit price, NOT $10
  ]);
  assert.equal(r.price, 10, 'clearing price for secondary purposes is $10');
  assert.equal(r.filled, 5);
});

test('TEST 5 — no liquidity', () => {
  const r = clear(mkt('BUY', 1), [bid('alice', 1, 8)]);

  assert.equal(r.price, null, 'no price printed');
  assert.equal(r.filled, 0);
  assert.deepEqual(r.trades, [], 'no bot fill');
});

// TEST 6 lives with the strike-grid tests above.

// --- clearing: the cases the six tests do not cover --------------------------

test('a market order larger than the whole book fills what it can', () => {
  const r = clear(mkt('BUY', 10), [ask('alice', 2, 10), ask('bob', 1, 14)]);
  assert.equal(r.filled, 3, 'and the rest simply does not trade');
  assert.equal(r.price, 10);
});

test('quotes for other contracts are ignored', () => {
  const other = { expiry: 5, kind: 'put', strike: 80 };
  const r = clear(mkt('BUY', 1), [ask('alice', 1, 3, other), ask('bob', 1, 12)]);
  assert.equal(r.price, 12, "the other contract's cheap offer is not on this book");
});

test('a two-sided quote never trades with itself', () => {
  const r = clear(mkt('BUY', 1), [
    ask('alice', 2, 10),
    makeQuote({ playerId: 'alice', ...CALL, bidPx: 20, bidQty: 5, round: 1 }),
  ]);
  assert.deepEqual(r.trades.map(trade), [['alice', 'HOUSE', 1, 10]]);
});

test('size wins a price tie, then P/L', () => {
  const quotes = [ask('alice', 1, 10), ask('bob', 3, 10), ask('carol', 3, 10)];
  const rank = new Map([['carol', 500], ['bob', 100]]);
  const r = clearContract(mkt('BUY', 3), quotes, { rank, rng: () => 0.5 });

  assert.equal(r.trades[0].seller, 'carol', 'bigger size, and better P/L than bob');
  assert.equal(r.trades[0].qty, 3);
});

// --- §9 rollup --------------------------------------------------------------

test('positions roll up by expiry, strike and type', () => {
  const pos = [
    makePosition({ playerId: 'p1', kind: 'call', strike: 100, expiry: 3, qty: 2, premium: 10, round: 1 }),
    makePosition({ playerId: 'p1', kind: 'call', strike: 100, expiry: 3, qty: -1, premium: 14, round: 2 }),
    makePosition({ playerId: 'p1', kind: 'put', strike: 100, expiry: 3, qty: 3, premium: 5, round: 2 }),
    makePosition({ playerId: 'p1', kind: 'call', strike: 100, expiry: 5, qty: 1, premium: 20, round: 2 }),
  ];
  const rows = rollupPositions(pos);
  assert.equal(rows.length, 3, 'same strike, different expiry stays separate');
  assert.deepEqual(rows.map((r) => [r.expiry, r.kind, r.strike, r.qty]), [
    [3, 'call', 100, 1],
    [3, 'put', 100, 3],
    [5, 'call', 100, 1],
  ]);
});

test('a contract closed back to flat drops out of the rollup', () => {
  const pos = [
    makePosition({ playerId: 'p1', kind: 'call', strike: 100, expiry: 3, qty: 2, premium: 10, round: 1 }),
    makePosition({ playerId: 'p1', kind: 'call', strike: 100, expiry: 3, qty: -2, premium: 13, round: 2 }),
  ];
  assert.deepEqual(rollupPositions(pos), []);
  assert.equal(grossOptionInventory(pos), 0);
});

test('gross inventory counts both sides, and stock only when told to', () => {
  const pos = [
    makePosition({ playerId: 'p1', kind: 'call', strike: 100, expiry: 3, qty: 2, premium: 10, round: 1 }),
    makePosition({ playerId: 'p1', kind: 'put', strike: 95, expiry: 5, qty: -3, premium: 4, round: 1 }),
  ];
  assert.equal(grossOptionInventory(pos), 5, 'short size counts as inventory');
  assert.equal(grossOptionInventory(pos, -7), 5, 'stock excluded by default');
  assert.equal(
    grossOptionInventory(pos, -7, { ...OPTION_DEFAULTS, grossInventoryIncludesStock: true }),
    12,
  );
});

// --- §8 settlement ----------------------------------------------------------

test('intrinsic value, both kinds, both sides of the strike', () => {
  assert.equal(intrinsic('call', 100, 116), 16);
  assert.equal(intrinsic('call', 100, 84), 0, 'worthless, never negative');
  assert.equal(intrinsic('put', 100, 84), 16);
  assert.equal(intrinsic('put', 100, 116), 0);
});

test('settlement pays longs, charges shorts, and clears the expiry', () => {
  const pos = [
    makePosition({ playerId: 'p1', kind: 'call', strike: 100, expiry: 3, qty: 2, premium: 10, round: 1 }),
    makePosition({ playerId: 'p1', kind: 'call', strike: 120, expiry: 3, qty: -1, premium: 3, round: 2 }),
    makePosition({ playerId: 'p1', kind: 'call', strike: 100, expiry: 5, qty: 1, premium: 20, round: 2 }),
  ];
  const { realized, settled, remaining } = settleExpiring(pos, 3, 130);

  // Long 2 @ 100 paid 10 → (30−10)×2 = +40. Short 1 @ 120 sold at 3 → (10−3)×−1 = −7.
  assert.equal(realized, 33);
  assert.equal(settled.length, 2);
  assert.equal(remaining.length, 1, 'the R5 position is untouched');
  assert.equal(remaining[0].expiry, 5);
});

test('a long option expiring worthless loses its premium and no more', () => {
  const long = makePosition({ playerId: 'p1', kind: 'call', strike: 100, expiry: 3, qty: 2, premium: 10, round: 1 });
  assert.equal(settleExpiring([long], 3, 80).realized, -20);

  // And the seller of that same call keeps exactly what the buyer lost.
  const short = makePosition({ playerId: 'p2', kind: 'call', strike: 100, expiry: 3, qty: -2, premium: 10, round: 1 });
  assert.equal(settleExpiring([short], 3, 80).realized, 20);
});

test('open P/L marks against the auction, and unmarked positions are flat', () => {
  const positions = [
    makePosition({ playerId: 'p1', kind: 'call', strike: 100, expiry: 5, qty: 2, premium: 10, round: 1 }),
    makePosition({ playerId: 'p1', kind: 'put', strike: 90, expiry: 5, qty: 1, premium: 4, round: 1 }),
  ];
  const marks = new Map([[contractKey({ expiry: 5, kind: 'call', strike: 100 }), 15]]);

  assert.equal(
    optionPL(positions, marks),
    (15 - 10) * 2,
    'the unmarked put is flat, not a total loss',
  );
  assert.equal(optionPL(positions), 0, 'no marks at all means no P/L yet');
  assert.equal(optionPL([]), 0);
});

// --- the toggle -------------------------------------------------------------

const seatedGame = (config) => {
  const g = createGame('TEST', config);
  addPlayer(g, 'alice');
  startGame(g, () => 0.5);
  return g;
};

test('options off leaves the stock game exactly as it was', () => {
  const g = seatedGame({});
  const [p] = g.players;

  assert.equal(g.options, null, 'no options container');
  assert.equal(p.optionPositions, undefined);

  const me = privateState(g, p.id).me;
  for (const key of ['optionPositions', 'optionLog', 'quotes']) {
    assert.ok(!(key in me), `${key} must not appear in the stock-only payload`);
  }
  assert.equal(publicState(g).options, false);
});

test('there is no cash anywhere, in either mode', () => {
  for (const options of [false, true]) {
    const g = seatedGame({ options });
    assert.equal(g.players[0].cash, undefined);
    assert.equal('cash' in privateState(g, g.players[0].id).me, false);
    assert.equal(JSON.stringify(publicState(g)).includes('cash'), false);
  }
});

test('options on adds a private book, and nothing to the public state', () => {
  const g = seatedGame({ options: true });
  const [p] = g.players;

  assert.deepEqual(p.optionPositions, []);
  assert.ok(g.options, 'the options container exists');

  const me = privateState(g, p.id).me;
  assert.deepEqual(me.optionPositions, []);
  assert.deepEqual(me.quotes, []);

  // Nothing about anyone's book or quotes leaks into the shared payload.
  const pub = JSON.stringify(publicState(g));
  assert.equal(pub.includes('quote'), false);
  assert.equal(pub.includes('optionPosition'), false);
});

test('the board is indicated at round start and published in full', () => {
  const g = seatedGame({ options: true });
  const board = publicState(g).optionBoard;

  assert.equal(board.anchor, 100, 'anchored on the opening mark');
  assert.deepEqual(board.tables.map((t) => t.expiry), [1, 5], 'two tables by default');
  assert.deepEqual(board.tables[0].strikes, strikeGrid(100));
  assert.equal(board.orders.length, 8);

  // Publishing the board in full is safe precisely because nothing is decided.
  assert.ok(board.orders.every(isIndicated));
  assert.equal(JSON.stringify(board).includes('"qty":null'), true);
  assert.equal(/"qty":\s*[0-9]/.test(JSON.stringify(board)), false);
});

test('a stock-only table publishes no board at all', () => {
  assert.equal(publicState(seatedGame({})).optionBoard, null);
});

// --- the auction phase: one gate per expiry ---------------------------------

const twoSeats = (rules = {}) => {
  const g = createGame('AUCT', { options: true, optionRules: rules });
  addPlayer(g, 'alice');
  addPlayer(g, 'bob');
  startGame(g, () => 0.5);
  for (const p of g.players) {
    submitOrder(g, p.id, { qty: 0, type: 'LIMIT' });
    confirmOrder(g, p.id);
  }
  return g;
};

test('the stock gate opens the auction, front month first', () => {
  const g = twoSeats();
  assert.equal(g.phase, 'auction');
  assert.equal(g.options.activeExpiry, 1, 'round order — the current round leads');
  assert.deepEqual(publicState(g).auction.awaiting, ['ALICE', 'BOB']);
});

test('a stock-only table skips the auction entirely', () => {
  const g = createGame('PLAIN', {});
  addPlayer(g, 'alice');
  startGame(g, () => 0.5);
  submitOrder(g, g.players[0].id, { qty: 0, type: 'LIMIT' });
  confirmOrder(g, g.players[0].id);
  assert.equal(g.phase, 'cards', 'straight from orders to cards');
  assert.equal(publicState(g).auction, null);
});

test('the house order stays a question mark while players quote', () => {
  const g = twoSeats();
  const live = publicState(g).optionBoard.orders.filter((o) => o.expiry === 1);
  assert.ok(live.every(isIndicated), 'no side and no size to quote against');

  const [alice] = g.players;
  submitQuotes(g, alice.id, [{
    expiry: 1, kind: 'call', strike: 100, bidPx: 8, bidQty: 2, askPx: 12, askQty: 2,
  }]);
  assert.ok(publicState(g).optionBoard.orders.filter((o) => o.expiry === 1).every(isIndicated),
    'still hidden after a quote lands');
});

test('the gate reveals, clears, and moves to the next expiry in round order', () => {
  const g = twoSeats();
  const [alice, bob] = g.players;
  const atm = { expiry: 1, kind: 'call', strike: 100 };

  submitQuotes(g, alice.id, [{ ...atm, bidPx: 8, bidQty: 5, askPx: 12, askQty: 5 }]);
  submitQuotes(g, bob.id, [{ ...atm, bidPx: 9, bidQty: 5, askPx: 14, askQty: 5 }]);
  confirmQuotes(g, alice.id);
  assert.equal(g.options.activeExpiry, 1, 'gate holds for bob');

  confirmQuotes(g, bob.id);

  // R1 revealed and cleared; the board has moved on to R5.
  assert.equal(g.phase, 'auction');
  assert.equal(g.options.activeExpiry, 5, 'next expiry, in round order');
  assert.ok(g.options.orders.filter((o) => o.expiry === 1).every((o) => !isIndicated(o)));
  assert.ok(g.options.orders.filter((o) => o.expiry === 5).every(isIndicated),
    'the later expiry is still sealed');

  // Somebody traded the ATM call, and it is marked at what it printed.
  const traded = g.options.cleared[0].results.filter((r) => r.price !== null);
  assert.ok(traded.length >= 1);
  const key = contractKey(traded[0]);
  assert.equal(g.options.marks[key], traded[0].price);
});

test('passing is a confirm with no quotes, and the round still completes', () => {
  const g = twoSeats({ expiryCount: 1 });
  const [alice, bob] = g.players;
  confirmQuotes(g, alice.id);
  confirmQuotes(g, bob.id);

  assert.equal(g.phase, 'cards', 'one expiry, one gate, then on to cards');
  const results = g.options.cleared[0].results;
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.price === null), 'nobody quoted, so nothing traded');
  assert.deepEqual(g.players.flatMap((p) => p.optionPositions), []);
});

test('a fill writes both sides of the trade to the right blotters', () => {
  const g = twoSeats({ expiryCount: 1, orderCoverage: 'all' });
  const [alice, bob] = g.players;
  const c = { expiry: 1, kind: 'call', strike: 100 };

  // Alice offers cheap, Bob bids through her — one of them trades the house too.
  submitQuotes(g, alice.id, [{ ...c, askPx: 5, askQty: 10 }]);
  submitQuotes(g, bob.id, [{ ...c, bidPx: 25, bidQty: 10 }]);
  confirmQuotes(g, alice.id);
  confirmQuotes(g, bob.id);

  // Assert against what actually cleared rather than guessing the house's side,
  // which is a coin flip per contract: every trade must appear on both blotters.
  const byId = new Map(g.players.map((p) => [p.id, p]));
  const trades = g.options.cleared[0].results
    .flatMap((r) => r.trades.map((t) => ({ ...t, contract: r })));
  assert.ok(trades.length > 0, 'crossing quotes must produce something');

  for (const t of trades) {
    for (const [id, sign] of [[t.buyer, 1], [t.seller, -1]]) {
      if (!id) continue;   // the house keeps no blotter
      const p = byId.get(id);
      assert.ok(
        p.optionPositions.some((x) =>
          x.qty === sign * t.qty && x.premium === t.price && x.round === 1
          && x.strike === t.contract.strike && x.kind === t.contract.kind
          && x.expiry === t.contract.expiry),
        `${p.name} is missing their side of ${t.qty} @ ${t.price}`,
      );
      assert.equal(p.optionLog.length, p.optionPositions.length, 'log tracks the book');
    }
  }

  assert.ok(alice.optionPositions.every((x) => x.qty < 0), 'alice only ever offered');
  assert.ok(bob.optionPositions.every((x) => x.qty > 0), 'bob only ever bid');
});

test('quotes are refused for the wrong expiry or a strike off the board', () => {
  const g = twoSeats();
  const [alice] = g.players;
  assert.throws(() => submitQuotes(g, alice.id, [
    { expiry: 5, kind: 'call', strike: 100, bidPx: 1, bidQty: 1 },
  ]), /not R1/);
  assert.throws(() => submitQuotes(g, alice.id, [
    { expiry: 1, kind: 'call', strike: 103, bidPx: 1, bidQty: 1 },
  ]), /not on the board/);
  assert.throws(() => submitQuotes(g, alice.id, [
    { expiry: 1, kind: 'call', strike: 100, bidPx: 12, bidQty: 1, askPx: 8, askQty: 1 },
  ]), /bid is above your offer/);
  assert.throws(() => submitQuotes(g, alice.id, [
    { expiry: 1, kind: 'call', strike: 100, bidPx: 8, bidQty: 0 },
  ]), /bid needs a size/);
});

test('option P/L joins stock P/L in the score', () => {
  const g = twoSeats({ expiryCount: 1, orderCoverage: 'all' });
  const [alice, bob] = g.players;
  const c = { expiry: 1, kind: 'call', strike: 100 };
  submitQuotes(g, alice.id, [{ ...c, askPx: 5, askQty: 10 }]);
  submitQuotes(g, bob.id, [{ ...c, bidPx: 25, bidQty: 10 }]);
  confirmQuotes(g, alice.id);
  confirmQuotes(g, bob.id);

  const row = publicState(g).standings.find((s) => s.id === bob.id);
  assert.equal('optionPl' in row, true);
  assert.equal(row.pl, row.stockPl + row.optionPl);
});

test('the host can force an auction gate', () => {
  const g = twoSeats({ expiryCount: 1 });
  confirmQuotes(g, g.players[0].id);
  assert.equal(g.phase, 'auction', 'bob has not confirmed');
  forceGate(g);
  assert.equal(g.phase, 'cards', 'forced through');
});

test('rules are configurable, and unspecified ones keep their defaults', () => {
  const g = seatedGame({ options: true, optionRules: { strikeIncrement: 10 } });
  assert.equal(g.config.optionRules.strikeIncrement, 10);
  assert.equal(g.config.optionRules.strikeDepth, OPTION_DEFAULTS.strikeDepth);
});
