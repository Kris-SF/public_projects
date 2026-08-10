/**
 * Mooncoin server: static files, a small JSON API for creating tables, and a
 * WebSocket per connected screen.
 *
 * Three kinds of screen connect to the same room:
 *   player    — private hand, order ticket, blotter
 *   dashboard — the shared read-only display
 *   host      — the dashboard plus the controls that drive the round
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

import * as G from './game.js';
import { Store } from './store.js';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.MOONCOIN_DATA ?? join(ROOT, '.data', 'games.json');

const store = new Store(DATA_FILE);

/** code -> Set<ws>.  Sockets carry their own role/identity on ws.ctx. */
const rooms = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const token = () => randomBytes(16).toString('hex');

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/games' && req.method === 'POST') {
    return createTable(req, res);
  }
  if (url.pathname.startsWith('/api/games/') && req.method === 'GET') {
    const game = store.get(url.pathname.split('/')[3]?.toUpperCase());
    return json(res, game ? 200 : 404, game
      ? { exists: true, phase: game.phase, seated: game.players.length, round: game.round }
      : { exists: false });
  }
  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

  return serveStatic(url.pathname, res);
});

async function createTable(req, res) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4096) return json(res, 413, { error: 'Payload too large' });
  }

  let config = {};
  try {
    config = body ? JSON.parse(body) : {};
  } catch {
    return json(res, 400, { error: 'Invalid JSON' });
  }

  let code;
  do { code = G.makeRoomCode(); } while (store.get(code));

  const game = G.createGame(code, config);
  game.hostToken = token();
  game.lastActivity = Date.now();
  store.set(game);

  console.log(`[room ${code}] created`);
  return json(res, 201, { code, hostToken: game.hostToken });
}

async function serveStatic(pathname, res) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(PUBLIC_DIR, rel);

  // Everything that is not a real asset renders the app shell, so /ABCD works
  // as a shareable join link.
  if (!extname(file)) file = join(PUBLIC_DIR, 'index.html');
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });

  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'max-age=300',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// WebSockets
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.ctx = { role: null, code: null, playerId: null };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { type: 'error', message: 'Malformed message' });
    }
    try {
      handle(ws, msg);
    } catch (err) {
      send(ws, { type: 'error', message: err.message });
    }
  });

  ws.on('close', () => {
    const { code, playerId } = ws.ctx;
    rooms.get(code)?.delete(ws);
    if (!playerId) return;
    const game = store.get(code);
    const player = game?.players.find((p) => p.id === playerId);
    if (player) {
      player.connected = false;
      store.touch();
      broadcast(code);
    }
  });
});

// Drop sockets that stopped answering rather than leaving them in the room set.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
heartbeat.unref();

function handle(ws, msg) {
  if (msg.type === 'hello') return hello(ws, msg);

  const game = requireGame(ws);
  game.lastActivity = Date.now();
  const { role, playerId } = ws.ctx;

  const playerActions = {
    order: () => G.submitOrder(game, playerId, { qty: msg.qty, type: msg.orderType }),
    confirmOrder: () => G.confirmOrder(game, playerId),
    unconfirmOrder: () => G.unconfirmOrder(game, playerId),
    cards: () => G.submitCards(game, playerId, msg.cards),
    confirmCards: () => G.confirmCards(game, playerId),
    unconfirmCards: () => G.unconfirmCards(game, playerId),
    leave: () => G.removePlayer(game, playerId),
  };

  const hostActions = {
    start: () => G.startGame(game),
    force: () => G.forceGate(game),
    reset: () => G.resetGame(game),
    config: () => G.updateConfig(game, msg.config ?? {}),
    kick: () => G.removePlayer(game, msg.playerId),
    roll: () => {
      const result = G.lockRoll(game);
      const step = G.rollStep(game);
      broadcastRaw(game.code, {
        type: 'die',
        index: step - 1,
        value: game.dice[step - 1],
        settled: result.settled,
      });
    },
  };

  if (playerActions[msg.type]) {
    if (role !== 'player') throw new Error('Not seated at this table');
    playerActions[msg.type]();
  } else if (hostActions[msg.type]) {
    if (role !== 'host') throw new Error('Host controls only');
    hostActions[msg.type]();
  } else {
    throw new Error(`Unknown action: ${msg.type}`);
  }

  store.touch();
  broadcast(game.code);
}

function hello(ws, msg) {
  const code = String(msg.code || '').toUpperCase();
  const game = store.get(code);
  if (!game) throw new Error(`No table with code ${code}`);

  game.lastActivity = Date.now();
  ws.ctx.code = code;

  if (msg.role === 'host') {
    if (msg.hostToken !== game.hostToken) throw new Error('Bad host token');
    ws.ctx.role = 'host';
  } else if (msg.role === 'dashboard') {
    ws.ctx.role = 'dashboard';
  } else if (msg.role === 'player') {
    const player = msg.playerToken
      ? game.players.find((p) => p.token === msg.playerToken)
      : null;

    if (player) {
      // Reconnect — same seat, same hand, same blotter.
      player.connected = true;
      ws.ctx.playerId = player.id;
      console.log(`[room ${code}] ${player.name} reconnected`);
    } else {
      const seated = G.addPlayer(game, msg.name);
      seated.token = token();
      seated.connected = true;
      ws.ctx.playerId = seated.id;
      console.log(`[room ${code}] ${seated.name} joined seat ${seated.seat}`);
    }

    ws.ctx.role = 'player';
    const me = game.players.find((p) => p.id === ws.ctx.playerId);
    send(ws, { type: 'seated', playerId: me.id, playerToken: me.token, name: me.name, seat: me.seat });
  } else {
    throw new Error('Unknown role');
  }

  if (!rooms.has(code)) rooms.set(code, new Set());
  rooms.get(code).add(ws);

  store.touch();
  broadcast(code);
}

function requireGame(ws) {
  if (!ws.ctx.code) throw new Error('Say hello first');
  const game = store.get(ws.ctx.code);
  if (!game) throw new Error('Table is gone');
  return game;
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastRaw(code, payload) {
  for (const ws of rooms.get(code) ?? []) send(ws, payload);
}

/**
 * Push state to every screen in the room. Each player's socket gets the shared
 * view plus its own private slice; dashboards and the host get the shared view
 * only, so a hand can never arrive at a screen not entitled to it.
 */
function broadcast(code) {
  const game = store.get(code);
  if (!game) return;
  const shared = G.publicState(game);

  for (const ws of rooms.get(code) ?? []) {
    const payload = { type: 'state', role: ws.ctx.role, state: shared };
    if (ws.ctx.role === 'player') {
      const priv = G.privateState(game, ws.ctx.playerId);
      if (priv) Object.assign(payload, priv);
    }
    send(ws, payload);
  }
}

// ---------------------------------------------------------------------------

setInterval(() => store.sweep(), 60 * 60 * 1000).unref();

process.on('SIGTERM', () => { store.flush(); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { store.flush(); server.close(() => process.exit(0)); });

server.listen(PORT, () => {
  console.log(`Mooncoin terminal listening on http://localhost:${PORT}`);
});

export { server, store };
