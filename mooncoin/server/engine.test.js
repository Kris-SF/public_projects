import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateOrders, printPrice, matchOrders, cardEffects, regimeEffects,
  resolveDice, position, deal, buildDeck, shuffle,
} from './engine.js';

// --- Position math, checked against the live spreadsheet -------------------
// Player1 held 40 @ 99 and -30 @ 109 against a mark of 115 and showed
// 10 shares / avg 69.00 / P/L $460.

test('position reproduces the spreadsheet', () => {
  const p = position([{ qty: 40, price: 99 }, { qty: -30, price: 109 }], 115);
  assert.equal(p.shares, 10);
  assert.equal(p.pl, 460);
  assert.equal(p.avgPrice, 69);
});

test('position marks a short correctly', () => {
  const p = position([{ qty: -10, price: 100 }], 90);
  assert.equal(p.shares, -10);
  assert.equal(p.pl, 100);
});

test('flat position has no average price', () => {
  const p = position([{ qty: 5, price: 100 }, { qty: -5, price: 110 }], 120);
  assert.equal(p.shares, 0);
  assert.equal(p.avgPrice, null);
});

// --- Slippage --------------------------------------------------------------

test('zero imbalance prints flat', () => {
  assert.equal(printPrice(100, 0), 100);
});

test('square-root impact, signed', () => {
  assert.equal(printPrice(100, 1), 101);   // ceil(sqrt(1)) = 1
  assert.equal(printPrice(100, 4), 102);   // ceil(sqrt(4)) = 2
  assert.equal(printPrice(100, 5), 103);   // ceil(sqrt(5)) = 3
  assert.equal(printPrice(100, 9), 103);
  assert.equal(printPrice(100, 100), 110);
  assert.equal(printPrice(100, -100), 90);
});

test('impact matches the sheet ceiling trick', () => {
  for (let imb = 1; imb <= 500; imb++) {
    const sheet = Math.trunc(Math.sqrt(imb) + 0.99);
    assert.equal(printPrice(100, imb) - 100, sheet, `imbalance ${imb}`);
  }
});

test('size is self-limiting', () => {
  // A 100-lot market order moves the print 10 points against itself.
  assert.equal(printPrice(100, 100) - 100, 10);
});

// --- Book aggregation ------------------------------------------------------

test('limit orders stay out of the imbalance', () => {
  const book = aggregateOrders([
    { playerId: 'a', qty: 10, type: 'LIMIT' },
    { playerId: 'b', qty: -10, type: 'LIMIT' },
  ]);
  assert.equal(book.limitBid, 10);
  assert.equal(book.limitOffer, 10);
  assert.equal(book.imbalance, 0);
});

test('imbalance is market flow only', () => {
  const book = aggregateOrders([
    { playerId: 'a', qty: 7, type: 'MARKET' },
    { playerId: 'b', qty: -2, type: 'MARKET' },
    { playerId: 'c', qty: 50, type: 'LIMIT' },
  ]);
  assert.equal(book.marketBid, 7);
  assert.equal(book.marketOffer, 2);
  assert.equal(book.imbalance, 5);
});

// --- Matching --------------------------------------------------------------

test('market orders always fill; house absorbs the residual', () => {
  const r = matchOrders([
    { playerId: 'buyer', qty: 5, type: 'MARKET' },
    { playerId: 'seller', qty: -3, type: 'LIMIT' },
  ], 100);

  assert.equal(r.price, 103);                       // ceil(sqrt(5)) = 3
  const buyer = r.fills.find((f) => f.playerId === 'buyer');
  const seller = r.fills.find((f) => f.playerId === 'seller');
  assert.equal(buyer.qty, 5);                       // full fill, certainty bought with slippage
  assert.equal(seller.qty, -3);                     // resting size was all it had
  assert.equal(r.houseResidual, 2);
  for (const f of r.fills) assert.equal(f.price, 103);
});

test('limit orders fill pro-rata against opposing market flow', () => {
  const r = matchOrders([
    { playerId: 'mkt', qty: 6, type: 'MARKET' },
    { playerId: 'l1', qty: -6, type: 'LIMIT' },
    { playerId: 'l2', qty: -6, type: 'LIMIT' },
  ], 100);

  const l1 = r.fills.find((f) => f.playerId === 'l1');
  const l2 = r.fills.find((f) => f.playerId === 'l2');
  assert.equal(l1.qty, -3);
  assert.equal(l2.qty, -3);
  assert.equal(r.houseResidual, 0);
});

test('pro-rata allocation never conjures or loses shares', () => {
  const r = matchOrders([
    { playerId: 'mkt', qty: 10, type: 'MARKET' },
    { playerId: 'l1', qty: -3, type: 'LIMIT' },
    { playerId: 'l2', qty: -5, type: 'LIMIT' },
    { playerId: 'l3', qty: -7, type: 'LIMIT' },
  ], 100);

  const limitTotal = r.fills
    .filter((f) => f.playerId.startsWith('l'))
    .reduce((a, f) => a + f.qty, 0);
  assert.equal(limitTotal, -10);   // exactly the market buy volume
  assert.equal(r.houseResidual, 0);
});

test('unopposed limit orders do not trade', () => {
  const r = matchOrders([
    { playerId: 'a', qty: 10, type: 'LIMIT' },
    { playerId: 'b', qty: -10, type: 'LIMIT' },
  ], 100);
  assert.equal(r.fills.length, 0);
  assert.equal(r.price, 100);
});

// --- Cards, regime, dice ---------------------------------------------------

test('card effects net out', () => {
  const e = cardEffects([
    { up: 2, down: 0, multiply: 1, add: 0 },
    { up: 0, down: 3, multiply: 0, add: 2 },
  ]);
  assert.deepEqual(e, { trend: -1, mag: -1 });
});

test('regime is inert before round 3', () => {
  assert.deepEqual(regimeEffects([]), { trend: 0, mag: 0 });
  assert.deepEqual(regimeEffects([{ trend: 1, type: 'ADD' }]), { trend: 0, mag: 0 });
});

test('regime leans with a two-round streak', () => {
  assert.deepEqual(
    regimeEffects([{ trend: 1, type: 'MULTIPLY' }, { trend: 1, type: 'MULTIPLY' }]),
    { trend: 1, mag: 1 }
  );
  assert.deepEqual(
    regimeEffects([{ trend: -1, type: 'ADD' }, { trend: -1, type: 'ADD' }]),
    { trend: -1, mag: -1 }
  );
});

test('regime stays neutral when the streak breaks', () => {
  assert.deepEqual(
    regimeEffects([{ trend: 1, type: 'ADD' }, { trend: -1, type: 'MULTIPLY' }]),
    { trend: 0, mag: 0 }
  );
});

test('dice reproduce the spreadsheet round 1', () => {
  // Terminal V7:Y7 = 4,5,5,3 produced Chg 15, Trend 1, Type MULTIPLY.
  const r = resolveDice([4, 5, 5, 3], { trend: 0, mag: 0 });
  assert.equal(r.trend, 1);
  assert.equal(r.type, 'MULTIPLY');
  assert.equal(r.chg, 15);
});

test('trend die threshold sits above 3', () => {
  assert.equal(resolveDice([3, 5, 2, 2], { trend: 0, mag: 0 }).trend, -1);
  assert.equal(resolveDice([4, 5, 2, 2], { trend: 0, mag: 0 }).trend, 1);
});

test('cards can flip the dice', () => {
  // A 3 on the trend die falls short alone, but one net up-card carries it.
  assert.equal(resolveDice([3, 5, 2, 2], { trend: 0, mag: 0 }).trend, -1);
  assert.equal(resolveDice([3, 5, 2, 2], { trend: 1, mag: 0 }).trend, 1);
});

test('magnitude cards are live, unlike the sheet', () => {
  // The spreadsheet hardcoded this modifier to zero; here it bites.
  assert.equal(resolveDice([5, 3, 4, 4], { trend: 0, mag: 0 }).type, 'ADD');
  assert.equal(resolveDice([5, 3, 4, 4], { trend: 0, mag: 1 }).type, 'MULTIPLY');
  assert.equal(resolveDice([5, 3, 4, 4], { trend: 0, mag: 0 }).chg, 8);   // 4+4
  assert.equal(resolveDice([5, 3, 4, 4], { trend: 0, mag: 1 }).chg, 16);  // 4*4
});

// --- Dealing ---------------------------------------------------------------

test('deck is 100 cards, 25 of each type', () => {
  const deck = buildDeck();
  assert.equal(deck.length, 100);
  for (const t of ['up', 'down', 'multiply', 'add']) {
    assert.equal(deck.filter((c) => c === t).length, 25);
  }
});

test('every player gets a full hand', () => {
  const hands = deal(4, 10);
  assert.equal(hands.length, 4);
  for (const h of hands) {
    assert.equal(h.up + h.down + h.multiply + h.add, 10);
  }
});

test('an oversubscribed deck is an error, not a short hand', () => {
  assert.throws(() => deal(10, 11), /Deck too small/);
  assert.doesNotThrow(() => deal(10, 10));
});

test('shuffle preserves deck composition', () => {
  const deck = buildDeck();
  const shuffled = shuffle(deck);
  assert.equal(shuffled.length, 100);
  assert.deepEqual(shuffled.slice().sort(), deck.slice().sort());
});
