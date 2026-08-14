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

// Hosting integrations have shipped these under several names over time, and
// some prefix them per-store. Rather than chase the list, detect anything
// Upstash-shaped: a REST URL and a matching write token.
const URL_ENV = ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL', 'REDIS_REST_URL'];
const TOKEN_ENV = ['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN', 'REDIS_REST_TOKEN'];

const named = (names) => names.find((n) => process.env[n]);

function sniffUrl() {
  return Object.keys(process.env).find((n) =>
    /(KV|REDIS|UPSTASH).*REST.*URL/i.test(n) && /^https:\/\//.test(process.env[n] ?? ''));
}

function sniffToken() {
  return Object.keys(process.env).find((n) =>
    /(KV|REDIS|UPSTASH).*REST.*TOKEN/i.test(n)
    && !/READ_ONLY/i.test(n)          // read-only tokens cannot write a game
    && (process.env[n] ?? '').length > 8);
}

const URL_VAR = named(URL_ENV) ?? sniffUrl();
const TOKEN_VAR = named(TOKEN_ENV) ?? sniffToken();

const REST_URL = URL_VAR ? process.env[URL_VAR].replace(/\/$/, '') : undefined;
const REST_TOKEN = TOKEN_VAR ? process.env[TOKEN_VAR] : undefined;

export const configured = Boolean(REST_URL && REST_TOKEN);

/**
 * What the process can see, for diagnosing a store that will not connect.
 * Variable NAMES only — values are never read out of here.
 */
export function describe() {
  return {
    configured,
    urlVar: URL_VAR ?? null,
    tokenVar: TOKEN_VAR ?? null,
    visibleNames: Object.keys(process.env)
      .filter((n) => /REDIS|KV_|UPSTASH/i.test(n))
      .sort(),
  };
}

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
