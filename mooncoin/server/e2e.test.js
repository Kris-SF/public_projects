/**
 * End-to-end: a real HTTP server, a full game played through the same requests
 * the browser makes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;

let proc;

function waitFor(predicate, what, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      // Must await: an async predicate returns a Promise, which is always
      // truthy, and would otherwise resolve the wait on the first tick.
      let v;
      try { v = await predicate(); } catch { v = false; }
      if (v) return resolve(v);
      if (Date.now() - started > timeout) return reject(new Error(`Timed out waiting for ${what}`));
      setTimeout(tick, 15);
    };
    tick();
  });
}

async function post(body) {
  const res = await fetch(`${BASE}/api/game`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(code, token) {
  const qs = new URLSearchParams({ code });
  if (token) qs.set('token', token);
  const res = await fetch(`${BASE}/api/game?${qs}`);
  return { status: res.status, body: await res.json() };
}

const newTable = async (config) => (await post({ action: 'create', config })).body;
const sit = async (code, name) => (await post({ action: 'join', code, name })).body;
const act = (code, token, action, extra = {}) => post({ action, code, token, ...extra });

test.before(async () => {
  proc = spawn(process.execPath, [join(HERE, 'index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await waitFor(async () => {
    try { return (await fetch(`${BASE}/api/game?code=ZZZZ`)).status === 404; }
    catch { return false; }
  }, 'server to boot');
});

test.after(() => proc?.kill('SIGKILL'));

// --- Static ---------------------------------------------------------------

test('serves the app shell on a room path', async () => {
  const res = await fetch(`${BASE}/ABCD`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Mooncoin<\/title>/);
});

test('static assets are served', async () => {
  assert.equal((await fetch(`${BASE}/style.css`)).status, 200);
  assert.equal((await fetch(`${BASE}/app.js`)).status, 200);

  const font = await fetch(`${BASE}/fonts/inter.woff2`);
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
});

test('directory traversal is refused', async () => {
  const body = await (await fetch(`${BASE}/../package.json`)).text();
  assert.ok(!body.includes('"scripts"'), 'must not serve files above public/');
});

test('polled state is never cached', async () => {
  const { code } = await newTable();
  const res = await fetch(`${BASE}/api/game?code=${code}`);
  assert.match(res.headers.get('cache-control'), /no-store/);
});

// --- A whole game ---------------------------------------------------------

test('a full game runs over HTTP', async () => {
  const { code, hostToken } = await newTable({ maxRounds: 2, cardQty: 6 });
  assert.match(code, /^[A-Z0-9]{4}$/);

  const alice = await sit(code, 'alice');
  const bob = await sit(code, 'bob');
  assert.equal(alice.me.name, 'ALICE');
  assert.ok(alice.playerToken);
  assert.equal(bob.state.seated, 2);

  // A tokenless poll is a dashboard, and gets no hand.
  const dash = await get(code);
  assert.equal(dash.body.role, 'dashboard');
  assert.equal(dash.body.me, undefined);

  // Roles come from the token, not from asking nicely.
  assert.equal((await get(code, hostToken)).body.role, 'host');
  assert.equal((await get(code, alice.playerToken)).body.role, 'player');

  await act(code, hostToken, 'start');
  const opened = await get(code, alice.playerToken);
  assert.equal(opened.body.state.phase, 'orders');
  const hand = opened.body.me.hand;
  assert.equal(hand.up + hand.down + hand.multiply + hand.add, 6);

  // Round 1 — alice takes 4 at market, bob rests 4 offered.
  await act(code, alice.playerToken, 'order', { qty: 4, orderType: 'MARKET' });
  const afterAlice = await act(code, alice.playerToken, 'confirmOrder');
  assert.equal(afterAlice.body.state.phase, 'orders', 'gate holds for bob');
  assert.deepEqual(afterAlice.body.state.awaitingOrders, ['BOB']);

  // Alice's size must not be visible to bob before the gate trips.
  const bobSees = await get(code, bob.playerToken);
  assert.equal(bobSees.body.state.reveal, null);
  assert.ok(!JSON.stringify(bobSees.body.state).includes('"qty":4'));

  await act(code, bob.playerToken, 'order', { qty: -4, orderType: 'LIMIT' });
  const tripped = await act(code, bob.playerToken, 'confirmOrder');

  assert.equal(tripped.body.state.phase, 'cards');
  // Bob's resting offer covers alice exactly, so the print is flat.
  assert.equal(tripped.body.state.reveal.absorbed, 4);
  assert.equal(tripped.body.state.reveal.imbalance, 0);
  assert.equal(tripped.body.state.reveal.price, 100);

  const filled = await get(code, alice.playerToken);
  assert.equal(filled.body.me.fills.length, 1, 'blotter written by the engine');
  assert.equal(filled.body.me.fills[0].price, 100);
  assert.equal(filled.body.me.fills[0].qty, 4);

  await act(code, alice.playerToken, 'confirmCards');
  const rolling = await act(code, bob.playerToken, 'confirmCards');
  assert.equal(rolling.body.state.phase, 'rolling');

  for (let i = 0; i < 4; i++) await act(code, hostToken, 'roll');

  const settled = await get(code, alice.playerToken);
  assert.equal(settled.body.state.round, 2);
  assert.equal(settled.body.state.history.length, 1);
  assert.equal(settled.body.state.mark, settled.body.state.history[0].mark);

  // Round 2 to the buzzer.
  for (const p of [alice, bob]) {
    await act(code, p.playerToken, 'order', { qty: 0, orderType: 'LIMIT' });
    await act(code, p.playerToken, 'confirmOrder');
  }
  for (const p of [alice, bob]) await act(code, p.playerToken, 'confirmCards');
  for (let i = 0; i < 4; i++) await act(code, hostToken, 'roll');

  const done = await get(code, alice.playerToken);
  assert.equal(done.body.state.phase, 'complete');
  // Same fill, opposite sides, nothing left with the house.
  assert.equal(done.body.state.standings.reduce((a, p) => a + p.pl, 0), 0);
});

// --- Identity and access --------------------------------------------------

test('a player rejoins the same seat with their token', async () => {
  const { code, hostToken } = await newTable({ maxRounds: 1, cardQty: 4 });
  const carol = await sit(code, 'carol');
  const dave = await sit(code, 'dave');

  await act(code, hostToken, 'start');
  await act(code, carol.playerToken, 'order', { qty: 9, orderType: 'MARKET' });
  await act(code, carol.playerToken, 'confirmOrder');
  await act(code, dave.playerToken, 'order', { qty: 0, orderType: 'LIMIT' });
  await act(code, dave.playerToken, 'confirmOrder');

  const before = await get(code, carol.playerToken);
  assert.equal(before.body.me.fills.length, 1);

  // Same token after a reload is the same seat, not a new one.
  const again = await post({ action: 'join', code, token: carol.playerToken, name: 'carol' });
  assert.equal(again.body.me.seat, 1);
  assert.equal(again.body.state.seated, 2, 'no duplicate seat created');
  assert.deepEqual(again.body.me.fills, before.body.me.fills);
});

test('host controls are refused without the token', async () => {
  const { code } = await newTable();
  const player = await sit(code, 'eve');

  const asNobody = await act(code, null, 'start');
  assert.equal(asNobody.status, 400);
  assert.match(asNobody.body.error, /Host controls only/);

  const asPlayer = await act(code, player.playerToken, 'start');
  assert.equal(asPlayer.status, 400);
  assert.match(asPlayer.body.error, /Host controls only/);

  const asWrongToken = await act(code, 'not-the-token', 'start');
  assert.equal(asWrongToken.status, 400);
});

test('player actions are refused without a seat', async () => {
  const { code, hostToken } = await newTable();
  await sit(code, 'frank');
  await act(code, hostToken, 'start');

  const res = await act(code, hostToken, 'order', { qty: 5, orderType: 'MARKET' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Not seated/);
});

test('an unknown table is a clean 404', async () => {
  assert.equal((await get('ZZZZ')).status, 404);
  const joined = await post({ action: 'join', code: 'ZZZZ', name: 'nobody' });
  assert.equal(joined.status, 400);
  assert.match(joined.body.error, /No table with code/);
});

test('game-rule violations come back as errors, not crashes', async () => {
  const { code, hostToken } = await newTable();
  const p = await sit(code, 'gina');

  const early = await act(code, p.playerToken, 'order', { qty: 5, orderType: 'MARKET' });
  assert.equal(early.status, 400);
  assert.match(early.body.error, /Not accepting orders/);

  await act(code, hostToken, 'start');
  const bogus = await act(code, p.playerToken, 'order', { qty: 5, orderType: 'STOP' });
  assert.equal(bogus.status, 400);
  assert.match(bogus.body.error, /LIMIT or MARKET/);

  const unknown = await act(code, p.playerToken, 'levitate');
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /Unknown action/);
});

test('simultaneous confirms both land', async () => {
  const { code, hostToken } = await newTable({ maxRounds: 1, cardQty: 4 });
  const a = await sit(code, 'ann');
  const b = await sit(code, 'ben');
  await act(code, hostToken, 'start');

  await act(code, a.playerToken, 'order', { qty: 2, orderType: 'MARKET' });
  await act(code, b.playerToken, 'order', { qty: -2, orderType: 'LIMIT' });

  // Both confirm at the same instant. Under a lost update one would be dropped
  // and the gate would never trip.
  await Promise.all([
    act(code, a.playerToken, 'confirmOrder'),
    act(code, b.playerToken, 'confirmOrder'),
  ]);

  const after = await get(code, a.playerToken);
  assert.equal(after.body.state.phase, 'cards', 'gate tripped, so both confirms survived');
});
