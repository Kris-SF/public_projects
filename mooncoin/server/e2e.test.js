/**
 * End-to-end: a real HTTP + WebSocket server, real sockets, a full game played
 * through the same message protocol the browser uses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { rmSync } from 'node:fs';
import WebSocket from 'ws';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = join(HERE, '..', '.data', 'e2e-test.json');

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

/** A test client that records every state push. */
function client(hello) {
  const c = {
    ws: new WebSocket(`ws://127.0.0.1:${PORT}/ws`),
    state: null, me: null, errors: [], seated: null,
    send(m) { c.ws.send(JSON.stringify(m)); },
    close() { c.ws.close(); },
  };
  c.ws.on('open', () => c.send({ type: 'hello', ...hello }));
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'state') { c.state = m.state; if (m.me) c.me = m.me; }
    else if (m.type === 'seated') c.seated = m;
    else if (m.type === 'error') c.errors.push(m.message);
  });
  return c;
}

test.before(async () => {
  rmSync(DATA, { force: true });
  proc = spawn(process.execPath, [join(HERE, 'index.js')], {
    env: { ...process.env, PORT: String(PORT), MOONCOIN_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  await waitFor(async () => {
    try { return (await fetch(`${BASE}/api/games/ZZZZ`)).status === 404; }
    catch { return false; }
  }, 'server to boot');
});

test.after(() => {
  proc?.kill('SIGKILL');
  rmSync(DATA, { force: true });
});

// ---------------------------------------------------------------------------

test('serves the app shell on a room path', async () => {
  const res = await fetch(`${BASE}/ABCD`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /MOONCOIN TERMINAL/);
});

test('static assets are served', async () => {
  assert.equal((await fetch(`${BASE}/style.css`)).status, 200);
  assert.equal((await fetch(`${BASE}/app.js`)).status, 200);
});

test('directory traversal is refused', async () => {
  const res = await fetch(`${BASE}/../package.json`);
  const body = await res.text();
  assert.ok(!body.includes('"dependencies"'), 'must not serve files above public/');
});

test('a full game runs over websockets', async () => {
  const created = await fetch(`${BASE}/api/games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxRounds: 2, cardQty: 6 }),
  });
  assert.equal(created.status, 201);
  const { code, hostToken } = await created.json();
  assert.match(code, /^[A-Z0-9]{4}$/);

  const host = client({ role: 'host', code, hostToken });
  const dash = client({ role: 'dashboard', code });
  const alice = client({ role: 'player', code, name: 'alice' });
  const bob = client({ role: 'player', code, name: 'bob' });

  await waitFor(() => host.state?.seated === 2 && alice.me && bob.me, 'both players seated');
  assert.equal(alice.me.name, 'ALICE');
  assert.ok(alice.seated.playerToken, 'player gets a reconnect token');

  // Dashboards never receive a hand.
  assert.equal(dash.me, null);

  host.send({ type: 'start' });
  await waitFor(() => alice.state?.phase === 'orders', 'market to open');
  assert.equal(alice.me.hand.up + alice.me.hand.down + alice.me.hand.multiply + alice.me.hand.add, 6);

  // Round 1 — alice lifts 4 at market, bob rests 4 offered.
  alice.send({ type: 'order', qty: 4, orderType: 'MARKET' });
  alice.send({ type: 'confirmOrder' });
  await waitFor(() => alice.me?.ordersReady, 'alice confirmed');
  assert.equal(alice.state.phase, 'orders', 'gate holds for bob');
  assert.deepEqual(alice.state.awaitingOrders, ['BOB']);

  // Nothing about alice's size may be visible to bob before the gate trips.
  assert.equal(bob.state.reveal, null);
  assert.ok(!JSON.stringify(bob.state).includes('"qty":4'));

  bob.send({ type: 'order', qty: -4, orderType: 'LIMIT' });
  bob.send({ type: 'confirmOrder' });
  await waitFor(() => alice.state?.phase === 'cards', 'orders gate to trip');

  // Bob's resting offer covers Alice's demand exactly, so the print is flat.
  assert.equal(alice.state.reveal.absorbed, 4);
  assert.equal(alice.state.reveal.imbalance, 0);
  assert.equal(alice.state.reveal.price, 100);
  assert.equal(alice.state.reveal.houseResidual, 0);
  await waitFor(() => alice.me?.fills.length === 1, 'blotter written by the engine');
  assert.equal(alice.me.fills[0].price, 100);
  assert.equal(alice.me.fills[0].qty, 4);

  // Cards
  alice.send({ type: 'confirmCards' });
  bob.send({ type: 'confirmCards' });
  await waitFor(() => alice.state?.phase === 'rolling', 'cards gate to trip');
  assert.ok(dash.state.net, 'dashboard sees the reveal');

  for (let i = 0; i < 4; i++) {
    const before = host.state.rollStep;
    host.send({ type: 'roll' });
    await waitFor(() => host.state.rollStep !== before || host.state.round === 2, `die ${i + 1}`);
  }

  await waitFor(() => alice.state?.round === 2, 'round to advance');
  assert.equal(alice.state.history.length, 1);
  assert.equal(alice.state.mark, alice.state.history[0].mark);

  // Round 2 — both pass, then roll it out.
  for (const c of [alice, bob]) {
    c.send({ type: 'order', qty: 0, orderType: 'LIMIT' });
    c.send({ type: 'confirmOrder' });
  }
  await waitFor(() => alice.state?.phase === 'cards', 'second orders gate');
  alice.send({ type: 'confirmCards' });
  bob.send({ type: 'confirmCards' });
  await waitFor(() => alice.state?.phase === 'rolling', 'second cards gate');

  for (let i = 0; i < 4; i++) {
    const before = host.state.rollStep;
    host.send({ type: 'roll' });
    await waitFor(() => host.state.rollStep !== before || host.state.phase === 'complete', `r2 die ${i + 1}`);
  }

  await waitFor(() => alice.state?.phase === 'complete', 'game to close');

  // P/L is zero-sum between the two of them: same fill, opposite sides.
  const s = alice.state.standings;
  assert.equal(s.reduce((a, p) => a + p.pl, 0), 0);

  [host, dash, alice, bob].forEach((c) => c.close());
});

test('a player reconnects to the same seat and blotter', async () => {
  const { code, hostToken } = await (await fetch(`${BASE}/api/games`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxRounds: 1, cardQty: 4 }),
  })).json();

  const host = client({ role: 'host', code, hostToken });
  let carol = client({ role: 'player', code, name: 'carol' });
  const dave = client({ role: 'player', code, name: 'dave' });

  await waitFor(() => host.state?.seated === 2 && carol.seated, 'seated');
  const token = carol.seated.playerToken;

  host.send({ type: 'start' });
  await waitFor(() => carol.state?.phase === 'orders', 'open');

  carol.send({ type: 'order', qty: 9, orderType: 'MARKET' });
  carol.send({ type: 'confirmOrder' });
  dave.send({ type: 'order', qty: 0, orderType: 'LIMIT' });
  dave.send({ type: 'confirmOrder' });
  await waitFor(() => carol.me?.fills.length === 1, 'filled');
  const fills = JSON.stringify(carol.me.fills);

  // Phone sleeps.
  carol.close();
  await waitFor(() => host.state.standings.find((p) => p.name === 'CAROL')?.connected === false,
    'server to notice the drop');

  carol = client({ role: 'player', code, playerToken: token });
  await waitFor(() => carol.me, 'reconnect');

  assert.equal(carol.me.name, 'CAROL');
  assert.equal(carol.me.seat, 1);
  assert.equal(JSON.stringify(carol.me.fills), fills, 'blotter survived the drop');

  [host, carol, dave].forEach((c) => c.close());
});

test('host controls are refused without the token', async () => {
  const { code } = await (await fetch(`${BASE}/api/games`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })).json();

  const imposter = client({ role: 'host', code, hostToken: 'not-the-token' });
  await waitFor(() => imposter.errors.length, 'rejection');
  assert.match(imposter.errors[0], /Bad host token/);

  // A dashboard cannot drive the game either.
  const dash = client({ role: 'dashboard', code });
  await waitFor(() => dash.state, 'dashboard connected');
  dash.send({ type: 'start' });
  await waitFor(() => dash.errors.length, 'refusal');
  assert.match(dash.errors[0], /Host controls only/);

  [imposter, dash].forEach((c) => c.close());
});

test('joining an unknown table fails cleanly', async () => {
  const c = client({ role: 'player', code: 'ZZZZ', name: 'nobody' });
  await waitFor(() => c.errors.length, 'error');
  assert.match(c.errors[0], /No table with code/);
  c.close();
});

test('games survive a server restart', async () => {
  const { code, hostToken } = await (await fetch(`${BASE}/api/games`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxRounds: 3, cardQty: 5 }),
  })).json();

  let host = client({ role: 'host', code, hostToken });
  const erin = client({ role: 'player', code, name: 'erin' });
  await waitFor(() => host.state?.seated === 1, 'seated');
  host.send({ type: 'start' });
  await waitFor(() => erin.state?.phase === 'orders', 'open');
  const token = erin.seated.playerToken;
  host.close(); erin.close();

  // Let the debounced snapshot land, then bounce the process.
  await new Promise((r) => setTimeout(r, 400));
  proc.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 150));

  proc = spawn(process.execPath, [join(HERE, 'index.js')], {
    env: { ...process.env, PORT: String(PORT), MOONCOIN_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor(async () => {
    try { return (await fetch(`${BASE}/api/games/${code}`)).status === 200; }
    catch { return false; }
  }, 'server to come back with the game');

  const back = client({ role: 'player', code, playerToken: token });
  await waitFor(() => back.me, 'rejoin after restart');
  assert.equal(back.me.name, 'ERIN');
  assert.equal(back.state.phase, 'orders', 'mid-round state preserved');
  back.close();
});
