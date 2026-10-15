/**
 * Bot players.
 *
 * A bot is a seat that fills itself in. It places a stock order, plays cards
 * and quotes options the moment a phase opens, so a gate only ever waits on the
 * humans, and a table of one can still be a table.
 *
 * Everything in here is a player's rule of thumb, deliberately crude and
 * deliberately noisy, and it has to stay that way. The game's one hard rule is
 * that it never quotes an option price, and a bot that priced from a model
 * would be the game quoting one by the back door. So the bot's idea of what an
 * option is worth is a sum and a square root with dice thrown at it — the
 * kind of thing a player would scribble on a napkin — and it is never shown
 * anywhere. The only thing that leaves this file is a quote, which clears or
 * does not like anyone else's.
 *
 * Three habits, because a bot with no habits is just a random number:
 *   - it hedges. A bot that has been hung with short calls buys stock against
 *     them, which is the behaviour the whole options layer exists to teach;
 *   - it leans its cards the way its stock position wants the coin to go;
 *   - it quotes wider when it is already carrying the contract, and it reads a
 *     telegraphed house order the way a person would: only quoting the side
 *     the house is going to hit.
 */

import { intrinsic } from './options.js';
import { position } from './engine.js';

/** Robots, mostly. Uppercased to match how seats are named. */
export const BOT_NAMES = ['KAREL', 'TARS', 'GERTY', 'MARVIN', 'ROBBY', 'BISHOP', 'DATA', 'HAL', 'BENDER', 'KRYTEN'];

const pick = (rng, n) => Math.floor(rng() * n);
const roll = (rng, lo, hi) => lo + pick(rng, hi - lo + 1);

/** Signed option exposure, in shares-ish: a call is +1, a put is −1, each halved. */
function optionLean(bot) {
  return (bot.optionPositions ?? []).reduce(
    (a, x) => a + (x.kind === 'call' ? x.qty : -x.qty) / 2, 0);
}

/**
 * The stock order.
 *
 * If the option book has left the bot leaning one way it trades against the
 * lean — that is the hedge. Otherwise it takes a small punt, sized one to five,
 * and sits out one round in three.
 */
export function botOrder(game, bot, rng) {
  const lean = optionLean(bot);
  const hedge = -Math.round(lean);
  if (hedge !== 0) {
    return { qty: Math.max(-10, Math.min(10, hedge)), type: 'MARKET' };
  }
  if (rng() < 0.33) return { qty: 0, type: 'LIMIT' };
  const size = roll(rng, 1, 5);
  const sign = rng() < 0.5 ? 1 : -1;
  return { qty: sign * size, type: rng() < 0.7 ? 'MARKET' : 'LIMIT' };
}

/**
 * The cards.
 *
 * Long stock wants the coin up, short wants it down, so the bot plays one
 * trend card its way if it has one. A third of the time it adds a random
 * second card; a quarter of the time it holds everything.
 */
export function botCards(game, bot, rng) {
  const play = { up: 0, down: 0, multiply: 0, add: 0 };
  if (rng() < 0.25) return play;

  const shares = position(bot.fills, game.mark).shares;
  const want = shares > 0 ? 'up' : shares < 0 ? 'down' : null;
  if (want && bot.hand[want] > 0) play[want] = 1;

  if (rng() < 0.33) {
    const held = Object.keys(play).filter((k) => bot.hand[k] - play[k] > 0);
    if (held.length) play[held[pick(rng, held.length)]] += 1;
  }
  return play;
}

/**
 * The quotes, for every contract on the block.
 *
 * Worth, on the napkin: what it is in the money by, plus a time value that
 * grows with the square root of the rounds left and shrinks the further the
 * strike sits from the coin. Then a width of two to four around it, a jitter of
 * a dollar either side, a nudge away from any position already held, and the
 * side the house has already announced it will hit — if it has — is the only
 * side quoted. Three contracts in ten it leaves alone.
 */
export function botQuotes(game, bot, rng) {
  const board = game.options;
  const expiry = board.activeExpiry;
  const live = board.orders.filter((o) => o.expiry === expiry);
  const held = new Map();
  for (const x of bot.optionPositions ?? []) {
    const k = `${x.expiry}|${x.kind}|${x.strike}`;
    held.set(k, (held.get(k) ?? 0) + x.qty);
  }

  const quotes = [];
  for (const o of live) {
    if (rng() < 0.3) continue;

    const roundsLeft = Math.max(1, o.expiry - game.round + 1);
    const inThe = intrinsic(o.kind, o.strike, game.mark);
    const away = Math.abs(game.mark - o.strike);
    const time = Math.max(1, Math.round(5 * Math.sqrt(roundsLeft) - away / 4));
    const worth = inThe + time;

    const width = roll(rng, 2, 4);
    const nudge = Math.sign(held.get(`${o.expiry}|${o.kind}|${o.strike}`) ?? 0);
    const jitter = () => roll(rng, -1, 1);
    const bid = Math.max(0, worth - width + jitter() - nudge);
    const ask = Math.max(bid + 1, worth + width + jitter() - nudge);
    const size = roll(rng, 1, 3);

    const q = { expiry: o.expiry, kind: o.kind, strike: o.strike };
    // A house buyer only ever lifts offers, so a bid against it is dead weight;
    // and quoting into a known seller with an offer just adds to the pile.
    if (o.side !== 'BUY') { q.bidPx = bid; q.bidQty = size; }
    if (o.side !== 'SELL') { q.askPx = ask; q.askQty = size; }
    quotes.push(q);
  }
  return quotes;
}
