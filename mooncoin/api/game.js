/**
 * Vercel serverless entry. All API surface goes through one function; the work
 * happens in server/handler.js, which the local dev server runs unchanged.
 */

import { handle } from '../server/handler.js';

export default async function game(req, res) {
  let body = req.body ?? {};

  // Vercel parses JSON bodies when the content type says so, but not always —
  // read the stream ourselves when it hasn't.
  if (req.method === 'POST' && typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch { body = {}; }
  }

  const { status, body: payload } = await handle({
    method: req.method,
    query: req.query ?? {},
    body,
  });

  // Polled state must never be cached — it is the whole point of polling.
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(status).json(payload);
}
