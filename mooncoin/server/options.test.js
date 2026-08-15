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
  rollupPositions, grossOptionInventory, intrinsic, settleExpiring,
  interestOn, netWorth, contractKey,
} from './options.js';
import { createGame, addPlayer, startGame, privateState, publicState } from './game.js';

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
  const { cash } = settleExpiring([pos], 5, 116);
  assert.equal(cash, 16, 'settles against its own locked strike, not the board');
});

test('a locked strike survives the grid moving away and back', () => {
  const pos = makePosition({
    playerId: 'p1', kind: 'put', strike: 95, expiry: 5, qty: -2, premium: 4, round: 1,
  });
  for (const anchor of [100, 107, 120, 95]) {
    assert.equal(pos.strike, 95, `unchanged with the board at ${anchor}`);
  }
  // Short 2 puts struck 95, settling at 90: pays 5 each.
  assert.equal(settleExpiring([pos], 5, 90).cash, -10);
});

// --- §3 expiry tables -------------------------------------------------------

test('three tables early, and the set shrinks as expiries pass', () => {
  const rounds = (r) => expiryTables(r, 5).map((t) => t.expiry);
  assert.deepEqual(rounds(1), [1, 3, 5]);
  assert.deepEqual(rounds(2), [2, 3, 5]);
  assert.deepEqual(rounds(3), [3, 5], 'R3 is the current-round table, not listed twice');
  assert.deepEqual(rounds(4), [4, 5]);
  assert.deepEqual(rounds(5), [5], 'the last round is a single front-month table');
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
  const { cash, settled, remaining } = settleExpiring(pos, 3, 130);

  // Long 2 @ 100 → +60. Short 1 @ 120 → −10.
  assert.equal(cash, 50);
  assert.equal(settled.length, 2);
  assert.equal(remaining.length, 1, 'the R5 position is untouched');
  assert.equal(remaining[0].expiry, 5);
});

test('interest is charged on negative cash only, rounded down', () => {
  assert.equal(interestOn(-340), 17, "the spec's worked example");
  assert.equal(interestOn(-1), 0, 'rounds down to nothing');
  assert.equal(interestOn(0), 0);
  assert.equal(interestOn(1000), 0, 'a positive balance earns nothing');
  assert.equal(interestOn(-1000, { ...OPTION_DEFAULTS, negativeCashRate: 0.1 }), 100);
});

test('net worth includes marked options, and carries unmarked ones at zero', () => {
  const positions = [
    makePosition({ playerId: 'p1', kind: 'call', strike: 100, expiry: 5, qty: 2, premium: 10, round: 1 }),
    makePosition({ playerId: 'p1', kind: 'put', strike: 90, expiry: 5, qty: 1, premium: 4, round: 1 }),
  ];
  const marks = new Map([[contractKey({ expiry: 5, kind: 'call', strike: 100 }), 15]]);

  assert.equal(
    netWorth({ cash: 500, shares: 3, mark: 110, positions, marks }),
    500 + 330 + 30,
    'the unmarked put contributes nothing rather than an invented value',
  );
  assert.equal(netWorth({ cash: 1000, shares: 0, mark: 100 }), 1000, 'no options, no change');
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
  assert.equal(p.cash, undefined, 'no cash in the stock-only game');
  assert.equal(p.optionPositions, undefined);

  const me = privateState(g, p.id).me;
  for (const key of ['cash', 'optionPositions', 'optionLog', 'quotes']) {
    assert.ok(!(key in me), `${key} must not appear in the stock-only payload`);
  }
  assert.equal(publicState(g).options, false);
});

test('options on adds cash and a private book, and nothing to the public state', () => {
  const g = seatedGame({ options: true });
  const [p] = g.players;

  assert.equal(p.cash, 1000, 'the spec\'s starting balance');
  assert.deepEqual(p.optionPositions, []);
  assert.ok(g.options, 'the options container exists');

  const me = privateState(g, p.id).me;
  assert.equal(me.cash, 1000);
  assert.deepEqual(me.quotes, []);

  // Nothing about anyone's book, cash or quotes leaks into the shared payload.
  const pub = JSON.stringify(publicState(g));
  assert.equal(pub.includes('cash'), false);
  assert.equal(pub.includes('quote'), false);
  assert.equal(pub.includes('optionPosition'), false);
});

test('the starting balance is configurable', () => {
  const g = seatedGame({ options: true, optionRules: { startingCash: 2500 } });
  assert.equal(g.players[0].cash, 2500);
  assert.equal(g.config.optionRules.strikeIncrement, 5, 'unspecified rules keep their defaults');
});
