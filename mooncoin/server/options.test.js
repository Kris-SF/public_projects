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
  confirmCards, lockRoll,
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

  // ...and still settles against $100: in the money by 16, so it is exercised
  // into one share at 100, and the 12 paid for it is booked.
  assert.equal(intrinsic(pos.kind, pos.strike, 116), 16);
  const { realized, settled } = settleExpiring([pos], 5, 116);
  assert.equal(settled[0].shares, 1, 'delivered against its own locked strike');
  assert.equal(settled[0].strike, 100, 'at 100, not at wherever the board is');
  assert.equal(realized, -12, 'the premium, and only the premium, is cash');
});

test('a locked strike survives the grid moving away and back', () => {
  const pos = makePosition({
    playerId: 'p1', kind: 'put', strike: 95, expiry: 5, qty: -2, premium: 4, round: 1,
  });
  for (const anchor of [100, 107, 120, 95]) {
    assert.equal(pos.strike, 95, `unchanged with the board at ${anchor}`);
  }
  // Short 2 puts struck 95 at $4, settling at 90: the puts are exercised against
  // the writer, who takes two shares at 95, and keeps the $8 of premium.
  const r = settleExpiring([pos], 5, 90);
  assert.equal(r.settled[0].shares, 2, 'a short put that finishes in means buying the stock');
  assert.equal(r.realized, 8);
});

// --- §3 expiry tables -------------------------------------------------------

/** Three expiries — the spec's R1/mid/final. Default is two. */
const T3 = { ...OPTION_DEFAULTS, expiryCount: 3 };

test('expiryCount sets how many rounds carry an expiry', () => {
  const at = (count) => expiryTables(1, 5, { ...OPTION_DEFAULTS, expiryCount: count })
    .map((t) => t.expiry);
  assert.deepEqual(at(1), [5], 'full-game exposure only');
  assert.deepEqual(at(2), [3, 5], 'plus the midpoint');
  assert.deepEqual(at(3), [1, 3, 5], 'plus the opening round');
  assert.deepEqual(expiryTables(1, 5).map((t) => t.expiry), [3, 5], 'two by default');
});

test('nothing expires that the host did not pick', () => {
  const rounds = (r) => expiryTables(r, 5, T3).map((t) => t.expiry);
  assert.deepEqual(rounds(1), [1, 3, 5]);
  assert.deepEqual(rounds(2), [3, 5], 'R2 was not picked, so R2 has no table of its own');
  assert.deepEqual(rounds(3), [3, 5], 'R3 is this round and still ahead');
  assert.deepEqual(rounds(4), [5]);
  assert.deepEqual(rounds(5), [5]);

  const picked = (r) => expiryTables(r, 5, { ...OPTION_DEFAULTS, fixedExpiries: [5] });
  assert.deepEqual(picked(1).map((t) => t.expiry), [5], 'one table, every round');
  assert.equal(picked(1)[0].current, false);
  assert.equal(picked(5)[0].current, true, 'until it is the round in play');
  assert.deepEqual(expiryTables(2, 5, { ...OPTION_DEFAULTS, fixedExpiries: [1] }), [],
    'the only expiry has passed — no auction this round');
  assert.deepEqual(expiryTables(1, 5, { ...OPTION_DEFAULTS, fixedExpiries: [] }), [],
    'options on, nothing picked: nothing to auction');
});

test('the derived expiries scale with the game length', () => {
  assert.deepEqual(expiryTables(1, 10, T3).map((t) => t.expiry), [1, 5, 10]);
  assert.deepEqual(expiryTables(1, 3, T3).map((t) => t.expiry), [1, 2, 3]);
  assert.deepEqual(expiryTables(1, 1, T3).map((t) => t.expiry), [1], 'a one-round game');
});

test('fixed expiries beyond the game length are dropped', () => {
  assert.deepEqual(expiryTables(1, 3).map((t) => t.expiry), [2, 3]);
  assert.deepEqual(expiryTables(1, 10, { ...OPTION_DEFAULTS, fixedExpiries: [4, 8, 12] })
    .map((t) => t.expiry), [4, 8]);
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

test('some orders telegraph their side, the rest stay a question mark', () => {
  const cfg = { ...T3, telegraphedShare: 0.5 };
  let told = 0, hidden = 0;
  for (let seed = 1; seed <= 40; seed++) {
    for (const o of indicateOrders(1, 5, 100, cfg, seeded(seed))) {
      assert.equal(o.qty, null, 'size is withheld either way');
      if (o.side === null) { hidden++; assert.equal(o.telegraphed, false); }
      else { told++; assert.ok(['BUY', 'SELL'].includes(o.side)); assert.equal(o.telegraphed, true); }
      assert.ok(isIndicated(o), 'telegraphed or not, the gate has not run');
    }
  }
  assert.ok(told > 0 && hidden > 0, `saw ${told} telegraphed and ${hidden} hidden`);
});

test('the share of telegraphed orders is a setting, and can be turned off', () => {
  const none = indicateOrders(1, 5, 100, { ...T3, telegraphedShare: 0 }, seeded(3));
  assert.ok(none.every((o) => o.side === null), 'every order a question mark');
  const all = indicateOrders(1, 5, 100, { ...T3, telegraphedShare: 1 }, seeded(3));
  assert.ok(all.every((o) => o.side !== null && o.qty === null),
    'every side shown, every size still hidden');
});

test('reveal keeps a telegraphed side and only fills the size', () => {
  const orders = indicateOrders(1, 5, 100, { ...T3, telegraphedShare: 1 }, seeded(8));
  const sides = orders.map((o) => o.side);
  revealOrders(orders, OPTION_DEFAULTS, seeded(2));
  assert.deepEqual(orders.map((o) => o.side), sides, 'the promise made at indicate is kept');
  assert.ok(orders.every((o) => o.qty >= 1 && o.qty <= 10));
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

test('several players crossing each other all match, best prices first', () => {
  // House takes 1 from the cheapest offer; the rest of the book then crosses
  // among the players, and every one of those trades prints at the clearing $8.
  const r = clear(mkt('BUY', 1), [
    ask('alice', 1, 8),
    ask('bob', 2, 10),
    ask('carol', 2, 14),
    bid('dave', 3, 20),
    bid('erin', 1, 12),
  ]);

  assert.equal(r.price, 8);
  assert.deepEqual(r.trades.map(trade), [
    ['alice', 'HOUSE', 1, 8],
    ['bob', 'dave', 2, 8],     // best bid takes the best remaining offer
    ['carol', 'dave', 1, 8],   // and walks up into the next one
  ]);
  // Erin bid 12 and Carol's remaining offer is 14, so they never trade — being
  // last in the queue is not the reason, the price is.
  assert.equal(r.trades.some((t) => t.buyer === 'erin'), false);
});

test("passing over a player's own offer does not retire it", () => {
  // Alice is both the best bid and the only cheap offer. She cannot trade with
  // herself, but Bob is entitled to that offer — an earlier version advanced the
  // offer pointer permanently on a self-cross and lost it.
  const r = clear(mkt('SELL', 1), [
    bid('alice', 1, 30),
    bid('bob', 5, 25),
    ask('alice', 5, 9),
  ]);

  assert.equal(r.price, 30, 'the house sold into the best bid');
  assert.deepEqual(r.trades.map(trade), [
    ['HOUSE', 'alice', 1, 30],
    ['alice', 'bob', 5, 30],   // Bob gets Alice's offer; Alice does not self-trade
  ]);
});

test('a bid only matches offers it actually crosses', () => {
  const r = clear(mkt('BUY', 1), [
    ask('alice', 1, 8),
    ask('bob', 5, 40),
    bid('carol', 5, 12),
  ]);
  assert.equal(r.price, 8);
  assert.deepEqual(r.trades.map(trade), [['alice', 'HOUSE', 1, 8]],
    "carol's 12 bid never reaches bob's 40 offer");
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

test('settlement is physical: in the money means stock at the strike', () => {
  const pos = [
    makePosition({ playerId: 'p1', kind: 'call', strike: 100, expiry: 3, qty: 2, premium: 10, round: 1 }),
    makePosition({ playerId: 'p1', kind: 'call', strike: 120, expiry: 3, qty: -1, premium: 3, round: 2 }),
    makePosition({ playerId: 'p1', kind: 'put', strike: 140, expiry: 3, qty: 1, premium: 6, round: 2 }),
    makePosition({ playerId: 'p1', kind: 'call', strike: 100, expiry: 5, qty: 1, premium: 20, round: 2 }),
  ];
  const { realized, settled, remaining } = settleExpiring(pos, 3, 130);

  // Only the premium is booked here: paid 20 and 6, received 3.
  assert.equal(realized, -20 + 3 - 6);
  assert.equal(remaining.length, 1, 'the R5 position is untouched');
  assert.equal(remaining[0].expiry, 5);

  const row = (kind, strike) => settled.find((r) => r.kind === kind && r.strike === strike);
  assert.equal(row('call', 100).shares, 2, 'long two calls, in the money: take two shares at 100');
  assert.equal(row('call', 120).shares, -1, 'short a call that finished in: deliver one at 120');
  assert.equal(row('put', 140).shares, -1, 'long a put that finished in: deliver one at 140');
  assert.equal(row('call', 100).intrinsic, 30);
});

test('delivery is on the net position per contract, premium per position', () => {
  const pos = [
    makePosition({ playerId: 'p1', kind: 'call', strike: 100, expiry: 3, qty: 3, premium: 10, round: 1 }),
    makePosition({ playerId: 'p1', kind: 'call', strike: 100, expiry: 3, qty: -1, premium: 14, round: 2 }),
  ];
  const { realized, settled } = settleExpiring(pos, 3, 130);
  assert.equal(settled.length, 1, 'one contract');
  assert.equal(settled[0].shares, 2, 'three bought less one sold is two to take');
  assert.equal(realized, -30 + 14, 'each premium booked as it was paid or received');
});

test('out of the money delivers nothing and costs the buyer exactly the premium', () => {
  const long = makePosition({ playerId: 'p1', kind: 'call', strike: 100, expiry: 3, qty: 2, premium: 10, round: 1 });
  const r = settleExpiring([long], 3, 80);
  assert.equal(r.realized, -20);
  assert.equal(r.settled[0].shares, 0, 'nothing to exercise');

  // And the seller of that same call keeps exactly what the buyer lost.
  const short = makePosition({ playerId: 'p2', kind: 'call', strike: 100, expiry: 3, qty: -2, premium: 10, round: 1 });
  assert.equal(settleExpiring([short], 3, 80).realized, 20);
  assert.equal(settleExpiring([short], 3, 80).settled[0].shares, 0);
});

test('at the instant of expiry, delivery and cash settlement score the same', () => {
  // Long one 100 call at 12, settling 124: cash would book (24 − 12) = +12.
  const long = makePosition({ playerId: 'p1', kind: 'call', strike: 100, expiry: 1, qty: 1, premium: 12, round: 1 });
  const r = settleExpiring([long], 1, 124);
  const stockPl = (124 - 100) * r.settled[0].shares;   // the delivered share, marked
  assert.equal(r.realized + stockPl, 12);

  // The writer: cash would book −12. Short one share at 100, marked 124: −24, plus 12 kept.
  const short = makePosition({ playerId: 'p2', kind: 'call', strike: 100, expiry: 1, qty: -1, premium: 12, round: 1 });
  const w = settleExpiring([short], 1, 124);
  assert.equal(w.realized + (124 - 100) * w.settled[0].shares, -12);
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
  assert.deepEqual(board.tables.map((t) => t.expiry), [3, 5], 'two tables by default — the midpoint and the end');
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

/** Two seats, sitting on the round's first gate — which is the auction. */
const twoSeats = (rules = {}) => {
  const g = createGame('AUCT', { options: true, optionRules: rules });
  addPlayer(g, 'alice');
  addPlayer(g, 'bob');
  startGame(g, () => 0.5);
  return g;
};

/** Clear the stock gate flat and pass on cards, so only the dice are left. */
const clearStock = (g) => {
  for (const p of g.players) {
    submitOrder(g, p.id, { qty: 0, type: 'LIMIT' });
    confirmOrder(g, p.id);
  }
};

test('the round opens on the auction, nearest expiry first', () => {
  const g = twoSeats({ fixedExpiries: [1, 5] });
  assert.equal(g.phase, 'auction', 'options trade before stock');
  assert.equal(g.options.activeExpiry, 1, 'round order — the nearest expiry leads');
  assert.deepEqual(publicState(g).auction.awaiting, ['ALICE', 'BOB']);
  assert.throws(() => submitOrder(g, g.players[0].id, { qty: 1, type: 'MARKET' }),
    /Not accepting orders/, 'the stock is shut until the auction is done');
});

test('a round with no expiry ahead runs no auction', () => {
  const g = twoSeats({ fixedExpiries: [1] });
  assert.equal(g.phase, 'auction', 'R1 was picked, so R1 auctions');
  for (const p of g.players) confirmQuotes(g, p.id);
  clearStock(g);
  for (const p of g.players) confirmCards(g, p.id);
  for (const d of [5, 1, 6, 6]) lockRoll(g, Math.random, d);
  assert.equal(g.round, 2);
  assert.equal(g.phase, 'orders', 'nothing left to expire — straight to the stock');
  assert.equal(publicState(g).auction, null);
  assert.deepEqual(publicState(g).optionBoard.tables, [], 'and no board to show');
});

test('a stock-only table opens straight on the stock', () => {
  const g = createGame('PLAIN', {});
  addPlayer(g, 'alice');
  startGame(g, () => 0.5);
  assert.equal(g.phase, 'orders', 'no auction to run');
  assert.equal(publicState(g).auction, null);
  submitOrder(g, g.players[0].id, { qty: 0, type: 'LIMIT' });
  confirmOrder(g, g.players[0].id);
  assert.equal(g.phase, 'cards');
});

test('the house order stays a question mark while players quote', () => {
  const g = twoSeats({ fixedExpiries: [1, 5] });
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
  const g = twoSeats({ fixedExpiries: [1, 5] });
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
  const g = twoSeats({ fixedExpiries: [1] });
  const [alice, bob] = g.players;
  confirmQuotes(g, alice.id);
  confirmQuotes(g, bob.id);

  assert.equal(g.phase, 'orders', 'one expiry, one gate, then the stock opens');
  const results = g.options.cleared[0].results;
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.price === null), 'nobody quoted, so nothing traded');
  assert.deepEqual(g.players.flatMap((p) => p.optionPositions), []);
});

test('a fill writes both sides of the trade to the right blotters', () => {
  const g = twoSeats({ fixedExpiries: [1], orderCoverage: 'all' });
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

test('every option fill is on the tape, by name, and survives the round', () => {
  const g = twoSeats({ fixedExpiries: [1], orderCoverage: 'all' });
  const [alice, bob] = g.players;
  const c = { expiry: 1, kind: 'call', strike: 100 };
  submitQuotes(g, alice.id, [{ ...c, askPx: 5, askQty: 10 }]);
  submitQuotes(g, bob.id, [{ ...c, bidPx: 25, bidQty: 10 }]);
  confirmQuotes(g, alice.id);
  confirmQuotes(g, bob.id);

  const tape = publicState(g).optionTrades;
  assert.ok(tape.length > 0, 'something crossed');
  for (const t of tape) {
    assert.ok(['ALICE', 'BOB', 'HOUSE'].includes(t.buyer), `buyer is a name: ${t.buyer}`);
    assert.ok(['ALICE', 'BOB', 'HOUSE'].includes(t.seller), `seller is a name: ${t.seller}`);
    assert.notEqual(t.buyer, t.seller);
    assert.equal(t.round, 1);
    assert.equal(typeof t.price, 'number');
    assert.ok(t.qty >= 1);
  }
  // Alice only offered and Bob only bid, so Alice never buys and Bob never sells.
  assert.ok(tape.every((t) => t.buyer !== 'ALICE' && t.seller !== 'BOB'));
  // Public, with no player ids in it to leak.
  assert.equal(JSON.stringify(tape).includes(alice.id), false);

  // Still readable after the auction has closed and the stock is open...
  assert.equal(g.phase, 'orders');
  assert.deepEqual(publicState(g).optionTrades, tape);
  // ...and filed with the round once it settles, cleared for the next.
  clearStock(g);
  for (const p of g.players) confirmCards(g, p.id);
  for (const d of [5, 1, 6, 6]) lockRoll(g, Math.random, d);
  assert.deepEqual(g.history[0].optionTrades, tape);
  assert.deepEqual(publicState(g).optionTrades, [], 'a new round, a blank tape');
});

test('the wall shows open interest, not anyone\'s book', () => {
  const g = twoSeats({ fixedExpiries: [1], orderCoverage: 'all' });
  const [alice, bob] = g.players;
  const c = { expiry: 1, kind: 'call', strike: 100 };
  submitQuotes(g, alice.id, [{ ...c, askPx: 5, askQty: 10 }]);
  submitQuotes(g, bob.id, [{ ...c, bidPx: 25, bidQty: 10 }]);
  confirmQuotes(g, alice.id);
  confirmQuotes(g, bob.id);

  const pub = publicState(g);
  assert.ok(pub.standings.every((r) => !('optionBook' in r)), 'no positions on the wall');
  assert.ok(pub.openInterest.length > 0);

  // Outstanding contracts = half of everyone's absolute position, house included.
  for (const oi of pub.openInterest) {
    const nets = g.players.map((p) => p.optionPositions
      .filter((x) => x.expiry === oi.expiry && x.kind === oi.kind && x.strike === oi.strike)
      .reduce((a, x) => a + x.qty, 0));
    const abs = nets.reduce((a, n) => a + Math.abs(n), 0);
    const net = nets.reduce((a, n) => a + n, 0);
    assert.equal(oi.qty, (abs + Math.abs(net)) / 2, `${oi.strike} ${oi.kind}`);
    assert.ok(Number.isInteger(oi.qty) && oi.qty > 0, 'a whole, positive count');
  }
});

test('open interest counts the house as the other side', () => {
  // Only Alice trades, and only with the house: two contracts are open.
  const g = twoSeats({ fixedExpiries: [1], orderCoverage: 'all' });
  const [alice, bob] = g.players;
  const order = g.options.orders.find((o) => o.expiry === 1);
  order.side = 'BUY';   // make the house a buyer here, whatever the dice said
  submitQuotes(g, alice.id, [{ expiry: 1, kind: order.kind, strike: order.strike, askPx: 1, askQty: 2 }]);
  confirmQuotes(g, alice.id);
  confirmQuotes(g, bob.id);
  const oi = publicState(g).openInterest.find((r) => r.kind === order.kind && r.strike === order.strike);
  const sold = -alice.optionPositions.reduce((a, x) => a + x.qty, 0);
  assert.ok(sold > 0, 'the house lifted her');
  assert.equal(oi.qty, sold, 'what she sold is what is open, even with no player on the other side');
});

test('quotes are refused for the wrong expiry or a strike off the board', () => {
  const g = twoSeats({ fixedExpiries: [1, 5] });
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
  const g = twoSeats({ fixedExpiries: [1], orderCoverage: 'all' });
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
  const g = twoSeats({ fixedExpiries: [1] });
  confirmQuotes(g, g.players[0].id);
  assert.equal(g.phase, 'auction', 'bob has not confirmed');
  forceGate(g);
  assert.equal(g.phase, 'orders', 'forced through to the stock');
});

test('a forced gate does not clear quotes nobody confirmed', () => {
  const g = twoSeats({ fixedExpiries: [1], orderCoverage: 'all' });
  const [alice, bob] = g.players;
  const c = { expiry: 1, kind: 'call', strike: 100 };

  // Both type a market. Only Alice commits to hers.
  submitQuotes(g, alice.id, [{ ...c, askPx: 5, askQty: 10 }]);
  submitQuotes(g, bob.id, [{ ...c, bidPx: 25, bidQty: 10 }]);
  confirmQuotes(g, alice.id);

  forceGate(g);

  // Bob typed a 25 bid and never stood behind it, so it cannot have traded —
  // and Alice cannot have been filled at a price only Bob's uncommitted quote
  // could have set.
  assert.deepEqual(bob.optionPositions, [], 'an unconfirmed quote does not trade');
  for (const pos of alice.optionPositions) {
    assert.equal(pos.premium === 25, false, "Bob's uncommitted bid never set a price");
  }
});

// --- settlement at expiry ---------------------------------------------------

/** Drive a round to its end with forced dice, so the mark is known exactly. */
const finishRound = (g, dice) => {
  if (g.phase === 'orders') clearStock(g);
  for (const p of g.players) confirmCards(g, p.id);
  for (const d of dice) lockRoll(g, Math.random, d);
};

/** Two seats, an R1 call traded between them, ready for the dice. */
const withAnRoundOneCall = () => {
  const g = twoSeats({ fixedExpiries: [1], orderCoverage: 'all' });
  const [alice, bob] = g.players;
  const c = { expiry: 1, kind: 'call', strike: 100 };
  submitQuotes(g, alice.id, [{ ...c, askPx: 5, askQty: 10 }]);
  submitQuotes(g, bob.id, [{ ...c, bidPx: 25, bidQty: 10 }]);
  confirmQuotes(g, alice.id);
  confirmQuotes(g, bob.id);
  return g;
};

test('an option settles at the end of its expiry round, against the mark', () => {
  const g = withAnRoundOneCall();
  const held = g.players.flatMap((p) => p.optionPositions);
  assert.ok(held.length > 0, 'somebody is holding an R1 call');

  // Trend die 5 -> up, vol die 1 -> ADD, sizes 6 and 6 -> +12 to the mark.
  finishRound(g, [5, 1, 6, 6]);
  assert.equal(g.mark, 112, 'the dice, not the print, set where the round ends');
  // The print and the mark are different numbers, which is what makes this test
  // mean anything: settled against the print a $100 call is worth nothing.
  assert.equal(g.history[0].print, 100, 'flat orders, so the round printed at 100');

  for (const p of g.players) {
    assert.deepEqual(p.optionPositions, [], 'expired rows drop off the blotter');
    if (!p.settledOptions.length) continue;
    for (const s of p.settledOptions) {
      assert.equal(s.expiry, 1);
      assert.equal(s.mark, 12, 'a $100 call settles at 112 - 100, not against the 103 print');
      assert.equal(s.shares, s.qty, 'in the money: every call became a share');
    }
  }
});

test('exercise writes a stock fill at the strike onto the blotter', () => {
  const g = withAnRoundOneCall();
  const before = new Map(g.players.map((p) => [p.id, {
    calls: p.optionPositions.reduce((a, x) => a + x.qty, 0),
    fills: p.fills.length,
  }]));

  finishRound(g, [5, 1, 6, 6]);   // mark 112, the 100 call is in

  for (const p of g.players) {
    const { calls, fills } = before.get(p.id);
    const delivered = p.fills.slice(fills).filter((f) => f.exercise);
    if (calls === 0) { assert.equal(delivered.length, 0); continue; }
    assert.equal(delivered.length, 1, `${p.name}: one delivery per contract`);
    assert.equal(delivered[0].qty, calls, 'long calls take stock, short calls give it');
    assert.equal(delivered[0].price, 100, 'at the strike, never at the mark');
    assert.equal(delivered[0].round, 1);
    assert.deepEqual(delivered[0].exercise, { kind: 'call', strike: 100, expiry: 1, contracts: calls });
    // And it is a real position now: the standings carry it as shares.
    const row = publicState(g).standings.find((s) => s.id === p.id);
    assert.equal(row.shares, calls);
  }
});

test('delivery scores exactly what cash settlement would have, then keeps moving', () => {
  const g = withAnRoundOneCall();

  // Worked out before the dice, because the round resets its auction state.
  // The mark will be 112, so cash settlement would book (12 − premium) × qty.
  const expected = g.players.map((p) => ({
    id: p.id,
    pl: p.optionPositions.reduce((a, x) => a + (12 - x.premium) * x.qty, 0),
  }));

  finishRound(g, [5, 1, 6, 6]);

  for (const { id, pl } of expected) {
    const row = publicState(g).standings.find((s) => s.id === id);
    assert.equal(row.pl, pl, `${row.name}: same score at the instant of expiry`);
    assert.equal(row.optionPl + row.stockPl, row.pl);
    // Premium is the only option P/L; the intrinsic lives on the stock side.
    const p = g.players.find((x) => x.id === id);
    assert.equal(row.optionPl, p.realizedOptionPl);
  }

  // Next round the stock keeps moving and so does the delivered position —
  // which cash settlement would have frozen. Flat orders, then up 12 again.
  clearStock(g);
  for (const p of g.players) confirmCards(g, p.id);
  for (const d of [5, 1, 6, 6]) lockRoll(g, Math.random, d);
  assert.equal(g.mark, 124);
  for (const { id, pl } of expected) {
    const p = g.players.find((x) => x.id === id);
    const shares = p.fills.reduce((a, f) => a + f.qty, 0);
    const row = publicState(g).standings.find((s) => s.id === id);
    assert.equal(row.pl, pl + 12 * shares, `${row.name}: the delivered stock rode the next move`);
  }
});

test('realised premium outlives the position that produced it', () => {
  const g = withAnRoundOneCall();
  finishRound(g, [5, 1, 6, 6]);

  const seller = g.players.find((p) => p.settledOptions.some((s) => s.qty < 0));
  if (!seller) return;   // the house took the whole offer this run

  assert.deepEqual(seller.optionPositions, [], 'nothing open');
  assert.ok(seller.realizedOptionPl > 0, 'the writer kept the premium');

  const row = publicState(g).standings.find((s) => s.id === seller.id);
  assert.equal(row.optionPl, seller.realizedOptionPl,
    'the score keeps it after the row is gone');
  assert.equal(row.pl, row.stockPl + row.optionPl);
});

test('a later expiry is untouched by an earlier settlement', () => {
  const g = twoSeats({ fixedExpiries: [1, 5], orderCoverage: 'all' });
  const [alice, bob] = g.players;

  for (const expiry of [1, 5]) {
    const c = { expiry, kind: 'call', strike: 100 };
    submitQuotes(g, alice.id, [{ ...c, askPx: 5, askQty: 10 }]);
    submitQuotes(g, bob.id, [{ ...c, bidPx: 25, bidQty: 10 }]);
    confirmQuotes(g, alice.id);
    confirmQuotes(g, bob.id);
  }
  const before = g.players.flatMap((p) => p.optionPositions);
  assert.ok(before.some((x) => x.expiry === 5), 'an R5 position exists');

  finishRound(g, [5, 1, 6, 6]);

  const after = g.players.flatMap((p) => p.optionPositions);
  assert.ok(after.length > 0 && after.every((x) => x.expiry === 5),
    'R1 settled, R5 still open');
  assert.equal(g.round, 2, 'and the game moved on');
});

test('an expiry reports its P/L against the mark it was carried at', () => {
  const g = twoSeats({ fixedExpiries: [1], orderCoverage: 'all' });
  const [alice, bob] = g.players;
  const c = { expiry: 1, kind: 'call', strike: 105 };
  // Pin the house: a buyer of one, so it lifts Alice and she is the short.
  Object.assign(g.options.orders.find((o) => o.expiry === 1 && o.kind === 'call' && o.strike === 105),
    { side: 'BUY', qty: 1 });
  submitQuotes(g, alice.id, [{ ...c, askPx: 6, askQty: 1 }]);
  submitQuotes(g, bob.id, [{ ...c, bidPx: 6, bidQty: 1 }]);
  confirmQuotes(g, alice.id);
  confirmQuotes(g, bob.id);
  const key = contractKey(c);
  const mark = g.options.marks[key];
  assert.equal(mark, 6, 'carried at the clearing price');
  const short = g.players.find((p) => p.optionPositions.some((x) => x.strike === 105 && x.qty < 0));
  const qty = short.optionPositions.filter((x) => x.strike === 105).reduce((a, x) => a + x.qty, 0);

  // Trend 5 → up, ADD, 3 and 3: the mark goes to 106, the call is in by 1.
  finishRound(g, [5, 1, 3, 3]);
  assert.equal(g.mark, 106);
  const row = short.settledOptions.find((x) => x.strike === 105);
  assert.equal(row.priorMark, 6);
  assert.equal(row.plFromMark, (1 - 6) * qty, 'short from a mark of 6, expiring worth 1: +5 a contract');
  assert.equal(row.plAllIn, (1 - 6) * qty, 'sold at 6 as well, so the same here');
  const hist = g.history[0].expired.find((x) => x.name === short.name && x.strike === 105);
  assert.equal(hist.plFromMark, row.plFromMark, 'and the round records it');
});

test('every holder of a contract sees the same prior mark, not the first settler\'s intrinsic', () => {
  const g = twoSeats({ fixedExpiries: [1], orderCoverage: 'all' });
  const [alice, bob] = g.players;
  const c = { expiry: 1, kind: 'call', strike: 95 };
  // Pin the house to buying one: it takes one of Alice's two, and Bob crosses
  // the other, so both players end up holding the contract.
  Object.assign(g.options.orders.find((o) => o.expiry === 1 && o.kind === 'call' && o.strike === 95),
    { side: 'BUY', qty: 1 });
  submitQuotes(g, alice.id, [{ ...c, askPx: 8, askQty: 2 }]);
  submitQuotes(g, bob.id, [{ ...c, bidPx: 8, bidQty: 2 }]);
  confirmQuotes(g, alice.id);
  confirmQuotes(g, bob.id);
  const mark = g.options.marks[contractKey(c)];
  assert.equal(mark, 8);
  finishRound(g, [5, 1, 3, 3]);   // 106: the 95 call is in by 11
  const rows = g.players.flatMap((p) => p.settledOptions.filter((x) => x.strike === 95));
  assert.ok(rows.length >= 2, 'both sides held it');
  for (const r of rows) assert.equal(r.priorMark, 8, 'carried at 8 for everyone');
});

test('the settled round records what expired and what was delivered', () => {
  const g = withAnRoundOneCall();
  finishRound(g, [5, 1, 6, 6]);
  const h = g.history[0];
  assert.ok(Array.isArray(h.expired) && h.expired.length > 0);
  for (const row of h.expired) {
    assert.equal(row.strike, 100);
    assert.equal(row.mark, 12);
    assert.equal(row.shares, row.qty, 'in the money, so delivered in full');
  }
});

test('an option that expires worthless delivers nothing and costs exactly its premium', () => {
  const g = withAnRoundOneCall();
  const buyer = g.players.find((p) => p.optionPositions.some((x) => x.qty > 0));
  if (!buyer) return;
  const paid = buyer.optionPositions.reduce((a, x) => a + x.premium * x.qty, 0);
  const fills = buyer.fills.length;

  // Trend die 1 -> down: the call ends miles out of the money.
  finishRound(g, [1, 1, 6, 6]);
  assert.equal(g.mark, 88);
  assert.equal(buyer.realizedOptionPl, -paid, 'the whole premium, and not a penny more');
  assert.equal(buyer.fills.length, fills, 'no stock changed hands');
});

test('a stock-only table settles nothing and gains no fields', () => {
  const g = createGame('PLAIN', {});
  addPlayer(g, 'alice');
  startGame(g, () => 0.5);
  finishRound(g, [5, 1, 6, 6]);
  assert.equal(g.players[0].realizedOptionPl, undefined);
  assert.equal('expired' in g.history[0], false);
});

test('rules are configurable, and unspecified ones keep their defaults', () => {
  const g = seatedGame({ options: true, optionRules: { strikeIncrement: 10 } });
  assert.equal(g.config.optionRules.strikeIncrement, 10);
  assert.equal(g.config.optionRules.strikeDepth, OPTION_DEFAULTS.strikeDepth);
});
