import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, addPlayer, addBot, startGame, publicState, privateState,
  submitOrder, confirmOrder, submitQuotes, confirmQuotes, confirmCards, lockRoll,
  updateConfig,
} from './game.js';
import { botOrder, botCards, botQuotes, BOT_NAMES } from './bots.js';
import { makePosition } from './options.js';

/** A deterministic rng: cycles through the given fractions. */
const cycle = (xs) => { let i = 0; return () => xs[i++ % xs.length]; };

test('a bot takes a seat like anyone else, and is marked as one', () => {
  const g = createGame('BOTS', {});
  addPlayer(g, 'alice');
  const b = addBot(g);
  assert.equal(b.bot, true);
  assert.equal(b.seat, 2);
  assert.ok(BOT_NAMES.includes(b.name));
  assert.equal(publicState(g).standings.find((s) => s.name === b.name).bot, true);
  assert.equal(publicState(g).standings.find((s) => s.name === 'ALICE').bot, false);

  // Names never collide, and the table cap still holds.
  for (let i = 0; i < 8; i++) addBot(g);
  assert.equal(new Set(g.players.map((p) => p.name)).size, 10);
  assert.throws(() => addBot(g), /full/);
});

test('bots act the moment a stock phase opens, and the gate waits on the human', () => {
  const g = createGame('BOTS', {});
  addPlayer(g, 'alice');
  const bot = addBot(g);
  startGame(g, () => 0.5);

  assert.equal(g.phase, 'orders');
  assert.equal(g.ready.orders[bot.id], true, 'the bot has confirmed');
  assert.ok(g.pendingOrders[bot.id], 'with an actual order');
  assert.deepEqual(publicState(g).awaitingOrders, ['ALICE'], 'only the human is owed');

  submitOrder(g, g.players[0].id, { qty: 0, type: 'LIMIT' });
  confirmOrder(g, g.players[0].id);
  assert.equal(g.phase, 'cards', 'alice tripped the gate');
  assert.equal(g.ready.cards[bot.id], true, 'and the bot has already played its cards');
  assert.deepEqual(publicState(g).awaitingCards, ['ALICE']);
});

test('a table of bots runs itself up to the dice', () => {
  const g = createGame('BOTS', { options: true, optionRules: { fixedExpiries: [1, 3] } });
  addBot(g); addBot(g); addBot(g);
  startGame(g, () => 0.5);
  assert.equal(g.phase, 'rolling', 'every gate tripped on its own');
  assert.equal(g.options.cleared.length, 2, 'both expiry tables were auctioned');
  for (const d of [5, 1, 6, 6]) lockRoll(g, Math.random, d);
  assert.equal(g.round, 2);
  assert.equal(g.phase, 'rolling', 'and the next round ran itself too');
});

test('a bot quotes every contract it does not skip, validly, both sides into a question mark', () => {
  const g = createGame('BOTS', { options: true, optionRules: { fixedExpiries: [1], telegraphedShare: 0 } });
  addPlayer(g, 'alice');
  const bot = addBot(g);
  startGame(g, () => 0.5);   // 0.5 never skips (needs < 0.3) and never telegraphs

  assert.equal(g.phase, 'auction');
  assert.equal(g.options.ready[bot.id], true);
  const quotes = g.options.quotes[bot.id];
  const live = g.options.orders.filter((o) => o.expiry === 1);
  assert.equal(quotes.length, live.length, 'one quote per house order');
  for (const q of quotes) {
    assert.ok(q.bidPx !== null && q.askPx !== null, 'two-sided into a hidden side');
    assert.ok(q.bidPx < q.askPx, 'never crossed');
    assert.ok(q.bidQty >= 1 && q.askQty >= 1);
    assert.ok(q.bidPx >= 0);
  }
  // Nothing of the bot's idea of value reaches the shared payload.
  assert.equal(JSON.stringify(publicState(g)).includes('worth'), false);
});

test('a bot only quotes the side a telegraphed house order will hit', () => {
  const g = createGame('BOTS', { options: true, optionRules: { fixedExpiries: [1] } });
  addPlayer(g, 'alice');
  const bot = addBot(g);
  startGame(g, () => 0.5);
  // Hand-set the sides, then ask the bot again with a fresh rng.
  const live = g.options.orders.filter((o) => o.expiry === 1);
  live[0].side = 'BUY';
  live[1].side = 'SELL';
  const qs = botQuotes(g, bot, () => 0.5);
  const forBuyer = qs.find((q) => q.strike === live[0].strike && q.kind === live[0].kind);
  const forSeller = qs.find((q) => q.strike === live[1].strike && q.kind === live[1].kind);
  assert.equal(forBuyer.bidPx, undefined, 'the house is buying: an offer only');
  assert.ok(forBuyer.askPx > 0);
  assert.equal(forSeller.askPx, undefined, 'the house is selling: a bid only');
  assert.ok(forSeller.bidPx >= 0);
});

test('a bot hedges a short-call book by buying stock', () => {
  const g = createGame('BOTS', { options: true });
  const bot = addBot(g);
  startGame(g, () => 0.5);
  bot.optionPositions = [
    makePosition({ playerId: bot.id, kind: 'call', strike: 100, expiry: 5, qty: -4, premium: 5, round: 1 }),
  ];
  const o = botOrder(g, bot, () => 0.5);
  assert.equal(o.qty, 2, 'short four calls, half-delta: buy two');
  assert.equal(o.type, 'MARKET', 'a hedge does not rest');

  bot.optionPositions = [
    makePosition({ playerId: bot.id, kind: 'put', strike: 100, expiry: 5, qty: -4, premium: 5, round: 1 }),
  ];
  assert.equal(botOrder(g, bot, () => 0.5).qty, -2, 'short puts: sell against them');
});

test('a bot never plays a card it does not hold', () => {
  const g = createGame('BOTS', {});
  const bot = addBot(g);
  startGame(g, () => 0.5);
  bot.hand = { up: 0, down: 1, multiply: 0, add: 0 };
  bot.fills = [{ round: 1, qty: 5, price: 100 }];   // long, so it wants an up card it lacks
  for (let i = 0; i < 50; i++) {
    const play = botCards(g, bot, cycle([0.9, 0.1, 0.5, 0.3, i / 50]));
    for (const k of Object.keys(play)) assert.ok(play[k] <= bot.hand[k], `${k}: ${play[k]}`);
  }
});

test('bots are ordinary players to the deck and the reset', () => {
  const g = createGame('BOTS', {});
  addPlayer(g, 'alice');
  addBot(g);
  updateConfig(g, { cardQty: 10 });
  startGame(g, () => 0.5);
  for (const p of g.players) {
    const h = p.hand;
    assert.equal(h.up + h.down + h.multiply + h.add, 10, `${p.name} was dealt a full hand`);
  }
  assert.ok(privateState(g, g.players[1].id).me.hand, 'a bot has a private hand like anyone');
});
