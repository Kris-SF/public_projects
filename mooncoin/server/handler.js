/**
 * The API, as one function.
 *
 * Deliberately transport-agnostic: takes a plain request description and returns
 * a plain response, so the Vercel serverless entry and the local dev server run
 * identical code.
 *
 *   GET  /api/game?code=ABCD&token=…   poll for state
 *   POST /api/game   { action, code, token, … }
 *
 * Every mutating action returns the fresh state, so whoever acted sees the
 * result immediately instead of waiting for the next poll tick.
 */

import { randomBytes } from 'node:crypto';
import * as G from './game.js';
import * as store from './store.js';

const token = () => randomBytes(16).toString('hex');

const ok = (body) => ({ status: 200, body });
const bad = (status, message) => ({ status, body: { error: message } });

/** Who is asking, derived from the token alone. */
function identify(game, tok) {
  if (tok && tok === game.hostToken) return { role: 'host', player: null };
  const player = tok ? game.players.find((p) => p.token === tok) : null;
  if (player) return { role: 'player', player };
  return { role: 'dashboard', player: null };
}

function view(game, tok) {
  const { role, player } = identify(game, tok);
  const body = {
    role,
    state: G.publicState(game),
    // Surfaced so the client can warn rather than misbehave: without Redis,
    // serverless requests can land on different instances holding different games.
    ephemeral: !store.configured,
  };
  if (player) Object.assign(body, G.privateState(game, player.id));
  return body;
}

/** Actions a seated player may take, and the host may not. */
const PLAYER_ACTIONS = {
  order: (game, p, msg) => G.submitOrder(game, p.id, { qty: msg.qty, type: msg.orderType }),
  confirmOrder: (game, p) => G.confirmOrder(game, p.id),
  unconfirmOrder: (game, p) => G.unconfirmOrder(game, p.id),
  cards: (game, p, msg) => G.submitCards(game, p.id, msg.cards),
  confirmCards: (game, p) => G.confirmCards(game, p.id),
  unconfirmCards: (game, p) => G.unconfirmCards(game, p.id),
  leave: (game, p) => G.removePlayer(game, p.id),
};

/** Actions only the host token unlocks. */
const HOST_ACTIONS = {
  start: (game) => G.startGame(game),
  force: (game) => G.forceGate(game),
  reset: (game) => G.resetGame(game),
  roll: (game) => G.lockRoll(game),
  config: (game, msg) => G.updateConfig(game, msg.config ?? {}),
  kick: (game, msg) => G.removePlayer(game, msg.playerId),
};

export async function handle({ method, query = {}, body = {} }) {
  try {
    if (method === 'GET') return await handleGet(query);
    if (method === 'POST') return await handlePost(body);
    return bad(405, 'Method not allowed');
  } catch (err) {
    // Game-rule violations are the caller's problem, not a server fault.
    return bad(400, err.message);
  }
}

async function handleGet(query) {
  // Store diagnostics. Reports which environment variable names are visible so
  // a datastore that will not connect can be diagnosed from outside; it never
  // reveals their values.
  if (query.diag === '1') return ok(store.describe());

  const code = String(query.code || '').toUpperCase();
  if (!code) return bad(400, 'Room code required');

  const game = await store.load(code);
  if (!game) return bad(404, `No table with code ${code}`);

  return ok(view(game, query.token));
}

async function handlePost(body) {
  const action = body.action;
  if (action === 'create') return createTable(body);
  if (action === 'join') return joinTable(body);

  const code = String(body.code || '').toUpperCase();
  if (!code) return bad(400, 'Room code required');

  const result = await store.mutate(code, (game) => {
    const { role, player } = identify(game, body.token);
    game.lastActivity = Date.now();

    if (PLAYER_ACTIONS[action]) {
      if (!player) throw new Error('Not seated at this table');
      PLAYER_ACTIONS[action](game, player, body);
    } else if (HOST_ACTIONS[action]) {
      if (role !== 'host') throw new Error('Host controls only');
      HOST_ACTIONS[action](game, body);
    } else {
      throw new Error(`Unknown action: ${action}`);
    }

    return view(game, body.token);
  });

  return ok(result);
}

async function createTable(body) {
  let code;
  do { code = G.makeRoomCode(); } while (await store.exists(code));

  const game = G.createGame(code, body.config ?? {});
  game.hostToken = token();
  game.lastActivity = Date.now();
  await store.save(game);

  return ok({ code, hostToken: game.hostToken, ephemeral: !store.configured });
}

async function joinTable(body) {
  const code = String(body.code || '').toUpperCase();
  if (!code) return bad(400, 'Room code required');

  const result = await store.mutate(code, (game) => {
    game.lastActivity = Date.now();

    // A known token is a reconnect, not a new seat.
    const existing = body.token
      ? game.players.find((p) => p.token === body.token)
      : null;

    const player = existing ?? Object.assign(G.addPlayer(game, body.name), { token: token() });
    player.connected = true;

    return {
      playerId: player.id,
      playerToken: player.token,
      ...view(game, player.token),
    };
  });

  return ok(result);
}
