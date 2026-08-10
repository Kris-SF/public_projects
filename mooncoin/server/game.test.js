import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, addPlayer, removePlayer, startGame, submitOrder, confirmOrder,
  submitCards, confirmCards, lockRoll, forceGate, standings, publicState,
  privateState, updateConfig, resetGame, rollStep,
} from './game.js';

// Deterministic dice so a "random" game is reproducible.
const fixedRng = (seq) => { let i = 0; return () => seq[i++ % seq.length]; };

function tableOf(names, config) {
  const g = createGame('TEST', config);
  const players = names.map((n) => addPlayer(g, n));
  startGame(g, fixedRng([0.5]));
  return { g, players };
}

function roll(g, values) {
  for (const v of values) lockRoll(g, Math.random, v);
}

// --- Seating ---------------------------------------------------------------

test('players take sequential seats', () => {
  const g = createGame('TEST');
  const a = addPlayer(g, 'kris');
  const b = addPlayer(g, 'sam');
  assert.equal(a.seat, 1);
  assert.equal(b.seat, 2);
  assert.equal(a.name, 'KRIS');   // names normalise to the terminal's caps
});

test('duplicate names are refused', () => {
  const g = createGame('TEST');
  addPlayer(g, 'kris');
  assert.throws(() => addPlayer(g, 'KRIS'), /already seated/);
});

test('table caps at ten seats', () => {
  const g = createGame('TEST');
  for (let i = 0; i < 10; i++) addPlayer(g, `p${i}`);
  assert.throws(() => addPlayer(g, 'eleven'), /full/);
});

test('leaving the lobby renumbers the seats', () => {
  const g = createGame('TEST');
  const a = addPlayer(g, 'a');
  addPlayer(g, 'b');
  const c = addPlayer(g, 'c');
  removePlayer(g, a.id);
  assert.equal(g.players[0].name, 'B');
  assert.equal(g.players[0].seat, 1);
  assert.equal(c.seat, 2);
});

test('nobody joins mid-game', () => {
  const { g } = tableOf(['a', 'b']);
  assert.throws(() => addPlayer(g, 'latecomer'), /under way/);
});

// --- Dealing ---------------------------------------------------------------

test('starting deals a full hand to every seat', () => {
  const { g, players } = tableOf(['a', 'b', 'c']);
  for (const p of players) {
    const h = g.players.find((x) => x.id === p.id).hand;
    assert.equal(h.up + h.down + h.multiply + h.add, g.config.cardQty);
  }
  assert.equal(g.phase, 'orders');
  assert.equal(g.round, 1);
  assert.equal(g.mark, 100);
});

test('config that oversubscribes the deck is refused', () => {
  const g = createGame('TEST');
  for (let i = 0; i < 10; i++) addPlayer(g, `p${i}`);
  assert.throws(() => updateConfig(g, { cardQty: 11 }), /exceeds the 100-card deck/);
  assert.doesNotThrow(() => updateConfig(g, { cardQty: 10 }));
});

// --- Order gate ------------------------------------------------------------

test('the gate trips only when the last player confirms', () => {
  const { g, players } = tableOf(['a', 'b']);
  const [a, b] = players;

  submitOrder(g, a.id, { qty: 5, type: 'MARKET' });
  confirmOrder(g, a.id);
  assert.equal(g.phase, 'orders', 'still waiting on b');

  submitOrder(g, b.id, { qty: -5, type: 'LIMIT' });
  confirmOrder(g, b.id);
  assert.equal(g.phase, 'cards', 'gate tripped');
});

test('submitting is not committing', () => {
  const { g, players } = tableOf(['a', 'b']);
  const [a, b] = players;

  submitOrder(g, a.id, { qty: 50, type: 'MARKET' });   // typed, never confirmed
  submitOrder(g, b.id, { qty: 5, type: 'MARKET' });
  confirmOrder(g, b.id);

  forceGate(g);   // host gives up waiting on a

  assert.equal(g.phase, 'cards');
  assert.equal(g.reveal.imbalance, 5, 'only b traded');
  assert.equal(g.players.find((p) => p.id === a.id).fills.length, 0);
});

test('a confirmed order cannot be rewritten', () => {
  const { g, players } = tableOf(['a', 'b']);
  submitOrder(g, players[0].id, { qty: 1, type: 'MARKET' });
  confirmOrder(g, players[0].id);
  assert.throws(() => submitOrder(g, players[0].id, { qty: 99, type: 'MARKET' }), /already confirmed/);
});

test('bad orders are rejected', () => {
  const { g, players } = tableOf(['a', 'b']);
  const id = players[0].id;
  assert.throws(() => submitOrder(g, id, { qty: 'lots', type: 'MARKET' }), /must be a number/);
  assert.throws(() => submitOrder(g, id, { qty: 5, type: 'STOP' }), /LIMIT or MARKET/);
});

// --- Cards gate ------------------------------------------------------------

test('cards cannot exceed the hand', () => {
  const { g, players } = tableOf(['a', 'b']);
  for (const p of players) {
    submitOrder(g, p.id, { qty: 0, type: 'LIMIT' });
    confirmOrder(g, p.id);
  }
  const me = g.players[0];
  assert.throws(
    () => submitCards(g, me.id, { up: me.hand.up + 1 }),
    /card\(s\) in hand/
  );
});

test('confirming spends cards; declining keeps them', () => {
  const { g, players } = tableOf(['a', 'b']);
  for (const p of players) {
    submitOrder(g, p.id, { qty: 0, type: 'LIMIT' });
    confirmOrder(g, p.id);
  }

  const a = g.players[0];
  const b = g.players[1];
  const aUpBefore = a.hand.up;
  const bUpBefore = b.hand.up;

  if (aUpBefore > 0) submitCards(g, a.id, { up: 1 });
  confirmCards(g, a.id);

  if (bUpBefore > 0) submitCards(g, b.id, { up: 1 });   // submitted but never confirmed
  forceGate(g);

  assert.equal(a.hand.up, Math.max(0, aUpBefore - (aUpBefore > 0 ? 1 : 0)));
  assert.equal(b.hand.up, bUpBefore, 'unconfirmed cards stay in hand');
});

// --- Dice and settlement ---------------------------------------------------

test('four dice settle the round', () => {
  const { g, players } = tableOf(['a', 'b']);
  for (const p of players) {
    submitOrder(g, p.id, { qty: 0, type: 'LIMIT' });
    confirmOrder(g, p.id);
  }
  for (const p of players) confirmCards(g, p.id);

  assert.equal(g.phase, 'rolling');
  assert.equal(rollStep(g), 0);

  lockRoll(g, Math.random, 4);
  assert.equal(rollStep(g), 1);
  lockRoll(g, Math.random, 5);
  lockRoll(g, Math.random, 5);
  assert.equal(g.phase, 'rolling', 'not settled until the fourth');
  lockRoll(g, Math.random, 3);

  // The spreadsheet's own round 1: dice 4/5/5/3 -> +15, mark 115.
  assert.equal(g.mark, 115);
  assert.equal(g.history[0].chg, 15);
  assert.equal(g.history[0].type, 'MULTIPLY');
  assert.equal(g.round, 2);
  assert.equal(g.phase, 'orders');
});

test('a fifth die is refused', () => {
  const { g, players } = tableOf(['a', 'b'], { maxRounds: 1 });
  for (const p of players) {
    submitOrder(g, p.id, { qty: 0, type: 'LIMIT' });
    confirmOrder(g, p.id);
  }
  for (const p of players) confirmCards(g, p.id);
  roll(g, [4, 5, 5, 3]);
  assert.equal(g.phase, 'complete');
  assert.throws(() => lockRoll(g, Math.random, 6), /Not rolling/);
});

// --- A whole game end to end ----------------------------------------------

test('a full game settles P/L consistently', () => {
  const { g, players } = tableOf(['buyer', 'seller'], { maxRounds: 2 });
  const [buyer, seller] = players;

  // Round 1: buyer lifts 4 at market, seller rests 4.
  submitOrder(g, buyer.id, { qty: 4, type: 'MARKET' });
  confirmOrder(g, buyer.id);
  submitOrder(g, seller.id, { qty: -4, type: 'LIMIT' });
  confirmOrder(g, seller.id);

  assert.equal(g.reveal.price, 102);     // 100 + ceil(sqrt(4))
  for (const p of players) confirmCards(g, p.id);
  roll(g, [4, 5, 5, 3]);                 // +15 -> mark 115

  assert.equal(g.mark, 115);
  const s = standings(g);
  const b = s.find((x) => x.name === 'BUYER');
  const l = s.find((x) => x.name === 'SELLER');
  assert.equal(b.shares, 4);
  assert.equal(b.pl, (115 - 102) * 4);   // 52
  assert.equal(l.shares, -4);
  assert.equal(l.pl, -52);
  assert.equal(b.pl + l.pl, 0, 'zero sum against the house at a flat print');

  // Round 2 to the buzzer.
  for (const p of players) {
    submitOrder(g, p.id, { qty: 0, type: 'LIMIT' });
    confirmOrder(g, p.id);
  }
  for (const p of players) confirmCards(g, p.id);
  roll(g, [1, 1, 2, 2]);                 // trend down, ADD -> -4

  assert.equal(g.phase, 'complete');
  assert.equal(g.mark, 111);
  assert.equal(g.history.length, 2);
});

// --- Information hiding ----------------------------------------------------

test('orders stay hidden until the gate trips', () => {
  const { g, players } = tableOf(['a', 'b']);
  submitOrder(g, players[0].id, { qty: 999, type: 'MARKET' });
  confirmOrder(g, players[0].id);

  const pub = publicState(g);
  assert.equal(pub.reveal, null, 'no book leaks mid-collection');
  assert.deepEqual(pub.awaitingOrders, ['B'], 'who is holding things up is fair game');
  assert.ok(!JSON.stringify(pub).includes('999'), 'the quantity itself must not leak');
});

test('cards stay hidden until the cards gate trips', () => {
  const { g, players } = tableOf(['a', 'b']);
  for (const p of players) {
    submitOrder(g, p.id, { qty: 0, type: 'LIMIT' });
    confirmOrder(g, p.id);
  }
  submitCards(g, players[0].id, { up: 1 });
  confirmCards(g, players[0].id);

  assert.equal(publicState(g).net, null);
  for (const p of players) confirmCards(g, p.id);
  assert.ok(publicState(g).net, 'revealed once everyone is in');
});

test('a player sees their own hand and nobody else\'s', () => {
  const { g, players } = tableOf(['a', 'b']);
  const view = privateState(g, players[0].id);
  assert.equal(view.me.name, 'A');
  assert.equal(view.me.hand.up + view.me.hand.down + view.me.hand.multiply + view.me.hand.add, 10);
  assert.equal(privateState(g, 'nobody'), null);
});

// --- Reset -----------------------------------------------------------------

test('reset returns the table to the lobby with seats intact', () => {
  const { g, players } = tableOf(['a', 'b']);
  submitOrder(g, players[0].id, { qty: 5, type: 'MARKET' });
  confirmOrder(g, players[0].id);
  resetGame(g);

  assert.equal(g.phase, 'lobby');
  assert.equal(g.round, 0);
  assert.equal(g.mark, 100);
  assert.equal(g.players.length, 2, 'players keep their seats');
  assert.equal(g.players[0].fills.length, 0);
});
