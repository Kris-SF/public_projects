/**
 * Game storage.
 *
 * Serverless functions share no memory, so game state lives in Redis. Talks the
 * Upstash REST API directly over fetch — no SDK, no dependency — which is what
 * both the Vercel KV integration and a plain Upstash database expose.
 *
 * With no Redis configured it falls back to an in-process Map. That is correct
 * for local development and for the tests; on serverless it is NOT, because
 * consecutive requests can land on different instances. `configured` is exported
 * so the UI can say so out loud rather than behaving strangely.
 */

const URL_ENV = ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'REDIS_REST_URL'];
const TOKEN_ENV = ['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN', 'REDIS_REST_TOKEN'];

const pick = (names) => names.map((n) => process.env[n]).find(Boolean);

const REST_URL = pick(URL_ENV)?.replace(/\/$/, '');
const REST_TOKEN = pick(TOKEN_ENV);

export const configured = Boolean(REST_URL && REST_TOKEN);

const TTL_SECONDS = 12 * 60 * 60;   // a table abandoned for half a day is done
const LOCK_MS = 4000;
const LOCK_TRIES = 25;
const LOCK_WAIT_MS = 60;

const memory = new Map();

async function command(...args) {
  const res = await fetch(REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args.map(String)),
  });
  if (!res.ok) throw new Error(`Redis ${args[0]} failed: ${res.status} ${await res.text()}`);
  const { result, error } = await res.json();
  if (error) throw new Error(`Redis ${args[0]}: ${error}`);
  return result;
}

const key = (code) => `mooncoin:game:${code}`;
const lockKey = (code) => `mooncoin:lock:${code}`;

export async function load(code) {
  if (!configured) return memory.get(code) ?? null;
  const raw = await command('GET', key(code));
  return raw ? JSON.parse(raw) : null;
}

export async function save(game) {
  if (!configured) {
    memory.set(game.code, game);
    return game;
  }
  await command('SET', key(game.code), JSON.stringify(game), 'EX', TTL_SECONDS);
  return game;
}

export async function exists(code) {
  if (!configured) return memory.has(code);
  return (await command('EXISTS', key(code))) === 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` against the game under an exclusive lock, then persist whatever it
 * returns. Without this, two players confirming at the same instant would both
 * read the pre-confirm state and one write would erase the other — which on a
 * ready-gate means a round that never trips.
 */
export async function mutate(code, fn) {
  if (!configured) {
    const game = memory.get(code);
    if (!game) throw new Error(`No table with code ${code}`);
    const result = await fn(game);
    memory.set(code, game);
    return result;
  }

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let held = false;
  for (let i = 0; i < LOCK_TRIES && !held; i++) {
    held = (await command('SET', lockKey(code), stamp, 'NX', 'PX', LOCK_MS)) !== null;
    if (!held) await sleep(LOCK_WAIT_MS);
  }
  if (!held) throw new Error('Table is busy, try again');

  try {
    const raw = await command('GET', key(code));
    if (!raw) throw new Error(`No table with code ${code}`);
    const game = JSON.parse(raw);
    const result = await fn(game);
    await command('SET', key(code), JSON.stringify(game), 'EX', TTL_SECONDS);
    return result;
  } finally {
    // Only release a lock we still own — a slow request whose lock already
    // expired must not free the next holder's.
    if ((await command('GET', lockKey(code))) === stamp) {
      await command('DEL', lockKey(code)).catch(() => {});
    }
  }
}

/** Test seam. */
export function _reset() {
  memory.clear();
}
