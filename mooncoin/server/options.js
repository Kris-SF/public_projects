/**
 * Options layer — data model.
 *
 * Stage 1 of the options build: the shapes, the floating strike grid, and the
 * pure accounting helpers. Nothing here generates orders, clears an auction or
 * draws anything; those are stages 2–5.
 *
 * The one hard rule this layer inherits: the game never quotes an option price.
 * Nothing in this file computes, models or estimates what an option is worth.
 * `intrinsic()` is settlement arithmetic at expiry, not a valuation — it is the
 * cash that changes hands once the underlying has stopped moving.
 *
 * The layer is additive and inert unless `config.options` is on, so the
 * stock-only game keeps its exact behaviour and its exact payloads.
 *
 * Hidden information is handled by not generating it. A house order carries
 * `side: null, qty: null` between indicate and reveal — the null is the
 * prototype's `?`. Nothing needs filtering out of the payload, the DOM or a log,
 * because until the auction runs those values do not exist.
 *
 * There is no cash ledger. The spec carries one — a $1,000 opening balance, a
 * 5% charge on negative balances, net worth as the score — but this game has
 * never had a balance and scores on mark-to-market P/L, so options score the
 * same way: an option position's P/L is (mark − premium) × qty, exactly as a
 * stock fill's is (mark − price) × qty. The spec's leverage-and-interest
 * mechanic goes with the cash it was built on.
 */

// Fisher-Yates, borrowed from the stock engine rather than reimplemented — the
// sampling in §4 is the same shuffle-then-take the deal already uses.
import { shuffle } from './engine.js';

/**
 * Everything the spec leaves open, named and defaulted rather than decided in
 * silence. §-numbers refer to mooncoin_options_auction_spec.md.
 */
export const OPTION_DEFAULTS = {
  // §2 — the grid. Nine rows at $5 spacing, ATM in the middle.
  strikeIncrement: 5,
  strikeDepth: 4,

  // §4 — order generation. X OTM orders per side per table, on top of the ATM pair.
  otmOrdersPerSide: 1,
  marketOrderMin: 1,
  marketOrderMax: 10,

  // Whether the house auctions a sample of the board or all of it. 'sampled' is
  // §4: two ATM orders plus X OTM per side, so where the orders land is itself
  // information. 'all' puts a house order on every listed contract — closer to a
  // round-robin where the house stands ready in everything — at the cost of that
  // signal and of 18 orders per table instead of 6.
  orderCoverage: 'sampled',

  // §3 — how many expiry tables are live at once, counting the current round's.
  // Each one is a separate gate the whole table has to clear, so this is the
  // main lever on how long a round takes: 1 is a front-month-only game, 3 is the
  // spec's current/mid/final. Defaults to 2 because three gates plus stock plus
  // cards is a lot of beats for one Zoom round.
  expiryCount: 2,

  // Exact control, if the derived set is not what you want. When null the
  // expiries are derived from expiryCount and the game length: the final round
  // for full-game exposure, then the midpoint.
  fixedExpiries: null,

  // §10.1 — resolved: a market order with no quotes on the required side dies.
  unfilledMarketOrder: 'drop',

  // §10.3 — the spec's ladder is size, then cash, then random. There is no cash
  // here, so the middle rung uses P/L, which is the resource this game actually
  // keeps score in. 'size-random' drops the rung instead; 'equal-split' matches
  // the stock leg's pro-rata, which is the alternative the spec names.
  tieBreak: 'size-pl-random',

  // §10.4, §10.6, §10.7, §10.8 — genuinely open. Named, defaulted, unbuilt.
  priorityFee: false,
  playerProposedStrikes: false,
  grossInventoryIncludesStock: false,
  expiryRotation: 'all',
};

export const OPTION_KINDS = ['call', 'put'];

/**
 * The nine tradeable strikes for a table, ascending.
 *
 * Ascending is also top-to-bottom display order: the spec's grid puts the
 * lowest strike in row 1 and increases downward, with ATM in the middle row.
 *
 * The anchor is NOT rounded to the increment. The spec's own example has an
 * anchor of $107 producing $87…$127, so a table's strikes are only ever round
 * numbers if the price happens to be one. That is deliberate — it keeps the ATM
 * row exactly at the money instead of near it.
 */
export function strikeGrid(anchor, cfg = OPTION_DEFAULTS) {
  const step = cfg.strikeIncrement ?? OPTION_DEFAULTS.strikeIncrement;
  const depth = cfg.strikeDepth ?? OPTION_DEFAULTS.strikeDepth;
  const out = [];
  for (let i = -depth; i <= depth; i++) out.push(anchor + i * step);
  return out;
}

/** Is this strike on the board right now? A locked-in position often is not. */
export function isTradeable(strike, anchor, cfg = OPTION_DEFAULTS) {
  return strikeGrid(anchor, cfg).includes(strike);
}

/**
 * Which expiry tables are live this round.
 *
 * The spec names three — the current round, R3 and R5 — which works for the
 * five-round default and breaks for every other length the host can set. So the
 * fixed expiries are config, and two rules keep the set sane as the game runs
 * out of road:
 *
 *   - an expiry in the past is not tradeable, so it drops off
 *   - an expiry equal to the current round is already the current-round table,
 *     so it is not listed twice
 *
 * Consequence worth knowing before you see it at the table: with the defaults, a
 * five-round game auctions three tables in rounds 1–2, two in rounds 3–4, and
 * one in round 5. The spec does not say what should happen here (§10.8 raises
 * the adjacent question of whether three tables is too many for a Zoom round).
 */
export function expiryTables(round, maxRounds, cfg = OPTION_DEFAULTS) {
  const count = cfg.expiryCount ?? OPTION_DEFAULTS.expiryCount;

  // Derived in priority order — the current round always, then full-game
  // exposure, then the midpoint — so trimming the count drops the least
  // interesting table rather than an arbitrary one. Display order is by expiry.
  const fixed = cfg.fixedExpiries
    ?? [maxRounds, Math.ceil(maxRounds / 2)].slice(0, Math.max(0, count - 1));

  const live = fixed.filter((e) => e > round && e <= maxRounds);
  const wanted = cfg.fixedExpiries ? live : live.slice(0, Math.max(0, count - 1));

  return [
    { key: `r${round}`, expiry: round, label: 'Current round', current: true },
    ...[...new Set(wanted)]
      .sort((a, b) => a - b)
      .map((e) => ({ key: `r${e}`, expiry: e, label: `Round ${e}`, current: false })),
  ];
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * A traded option position.
 *
 * `strike` is copied in at trade time and never recomputed. This is the whole
 * point of the floating grid: the board re-anchors every round, but a position
 * keeps the strike it traded at forever, and settles against that strike even
 * after it has drifted off the board entirely.
 *
 * `qty` is signed — positive long, negative short — matching the stock blotter.
 */
export function makePosition({ playerId, kind, strike, expiry, qty, premium, round }) {
  if (!OPTION_KINDS.includes(kind)) throw new Error(`Unknown option kind: ${kind}`);
  return { playerId, kind, strike, expiry, qty, premium, round };
}

/**
 * A game-generated market order.
 *
 * `side` and `qty` are null between indicate and reveal — the null IS the `?`
 * placeholder from the prototype, and the reveal step finds its work by looking
 * for nulls on the current board rather than by consulting anything stored
 * during indicate. That statelessness is deliberate (spec §4) and stage 2 has
 * to preserve it.
 */
export function makeMarketOrder({ expiry, kind, strike }) {
  if (!OPTION_KINDS.includes(kind)) throw new Error(`Unknown option kind: ${kind}`);
  return { expiry, kind, strike, side: null, qty: null };
}

export const isIndicated = (order) => order.qty === null && order.side === null;

/**
 * A player's two-sided quote on one contract.
 *
 * Per DECISION 3 every quote carries size, and a player may quote one side only
 * by leaving the other blank — a null price means "not quoting that side".
 */
export function makeQuote({ playerId, expiry, kind, strike, bidPx, bidQty, askPx, askQty, round }) {
  if (!OPTION_KINDS.includes(kind)) throw new Error(`Unknown option kind: ${kind}`);
  return {
    playerId, expiry, kind, strike, round,
    bidPx: bidPx ?? null,
    bidQty: bidPx == null ? 0 : (bidQty ?? 0),
    askPx: askPx ?? null,
    askQty: askPx == null ? 0 : (askQty ?? 0),
  };
}

/** The identity of a contract, for grouping and display. `Call $110 exp R5`. */
export const contractKey = (o) => `${o.expiry}|${o.kind}|${o.strike}`;
export const contractLabel = (o) =>
  `${o.kind === 'call' ? 'Call' : 'Put'} $${o.strike} exp R${o.expiry}`;

// ---------------------------------------------------------------------------
// Order generation — §4
// ---------------------------------------------------------------------------

/**
 * INDICATE — place this round's house orders, side and size withheld.
 *
 * Per table: the ATM call and ATM put always get an order, plus X out-of-the-
 * money strikes each side, sampled without replacement by Fisher-Yates. So a
 * table gets 2 + 2X orders.
 *
 * The spec says "with X=1 there are 6 orders per expiry table, 18 per round",
 * but 2 + 2X is 4 at X=1, not 6 — six needs X=2. The formula is the structural
 * claim and the count is a derived aside, so the formula wins: X=1 gives 4 per
 * table and 12 per round across three tables. Setting otmOrdersPerSide to 2
 * reproduces the spec's stated 6 and 18 exactly.
 *
 * OTM means what it means: calls above the money, puts below. The spec words
 * this as "the 4 rows above ATM" for calls, but its own grid puts the lowest
 * strike in row 1 and increases downward, so the rows above ATM hold the strikes
 * below it — which would make those calls in-the-money. Taking the financial
 * label over the row geometry; flagged rather than silently reconciled.
 *
 * Nothing here decides side or size. That is the point: at indicate time those
 * values do not exist yet, so there is nothing to conceal and nothing that can
 * leak. Players see where the orders landed, which is information in itself.
 */
export function indicateOrders(round, maxRounds, anchor, cfg = OPTION_DEFAULTS, rng = Math.random) {
  const depth = cfg.strikeDepth ?? OPTION_DEFAULTS.strikeDepth;
  const grid = strikeGrid(anchor, cfg);
  const atm = grid[depth];
  const above = grid.slice(depth + 1);   // OTM calls
  const below = grid.slice(0, depth);    // OTM puts
  const x = Math.min(cfg.otmOrdersPerSide ?? OPTION_DEFAULTS.otmOrdersPerSide, depth);
  const all = (cfg.orderCoverage ?? OPTION_DEFAULTS.orderCoverage) === 'all';

  const orders = [];
  for (const { expiry } of expiryTables(round, maxRounds, cfg)) {
    const at = (kind, strike) => orders.push(makeMarketOrder({ expiry, kind, strike }));
    if (all) {
      for (const strike of grid) { at('call', strike); at('put', strike); }
      continue;
    }
    at('call', atm);
    at('put', atm);
    for (const strike of shuffle(above, rng).slice(0, x)) at('call', strike);
    for (const strike of shuffle(below, rng).slice(0, x)) at('put', strike);
  }
  return orders;
}

/**
 * REVEAL — fill in side and size for every order still showing a placeholder.
 *
 * Deliberately stateless: this scans the board it is handed for orders with no
 * side or size, exactly as the prototype scanned for `?`, rather than replaying
 * anything recorded during indicate. A game master who hand-adds a row gets it
 * revealed; one who hand-fills a row keeps what they typed. Do not "improve"
 * this into something that reads stored indicate state.
 *
 * Side is a coin flip, size is uniform over the configured range, and no price
 * is generated here or anywhere else.
 */
export function revealOrders(orders, cfg = OPTION_DEFAULTS, rng = Math.random) {
  const min = cfg.marketOrderMin ?? OPTION_DEFAULTS.marketOrderMin;
  const max = cfg.marketOrderMax ?? OPTION_DEFAULTS.marketOrderMax;
  let revealed = 0;
  for (const o of orders) {
    if (!isIndicated(o)) continue;
    o.side = rng() < 0.5 ? 'BUY' : 'SELL';
    o.qty = min + Math.floor(rng() * (max - min + 1));
    revealed++;
  }
  return revealed;
}

// ---------------------------------------------------------------------------
// The auction — §5
// ---------------------------------------------------------------------------

/**
 * Order the quotes on one side into a book.
 *
 * Best price first, then the §5 tiebreak ladder: larger size wins, because
 * showing size is the conviction the rule means to reward; then P/L, standing in
 * for the spec's cash; then a stable coin flip so a three-way tie at the same
 * size does not depend on submission order.
 */
function bookSide(quotes, side, cfg, rank, rng) {
  const px = side === 'ask' ? 'askPx' : 'bidPx';
  const qty = side === 'ask' ? 'askQty' : 'bidQty';
  const dir = side === 'ask' ? 1 : -1;   // asks ascend, bids descend

  return quotes
    .filter((q) => q[px] !== null && q[px] !== undefined && q[qty] > 0)
    .map((q) => ({ playerId: q.playerId, price: q[px], qty: q[qty], coin: rng() }))
    .sort((a, b) =>
      (a.price - b.price) * dir
      || b.qty - a.qty
      || (rank.get(b.playerId) ?? 0) - (rank.get(a.playerId) ?? 0)
      || a.coin - b.coin);
}

/**
 * Clear one contract: a house market order against the players' quotes.
 *
 * Step 1 — the market order takes the best price on the side it needs, and the
 * price it first trades at is the clearing price. If it wants more than is shown
 * there it walks the book, and each further level fills at ITS OWN limit, not at
 * the clearing price. That is what makes showing size at a bad price expensive.
 *
 * Step 2 — whatever crossing interest is left over then trades among the
 * players, and all of it prints at the clearing price. Note this is the worked
 * examples' behaviour, not the prose's: §5 says secondary fills happen "only if
 * quantity remains unfilled at the clearing price", but its own Example 1 has
 * the market order consume every share at the clearing price and then still
 * matches Charlie against Bob. The examples are the acceptance tests, so they
 * win — a resting order behind the best price gets taken at the clearing price
 * it never offered, which is the lesson the example is built to teach.
 *
 * No quotes on the side the order needs and nothing happens: no fill, no print,
 * no bot (DECISION 1). A contract that nobody quoted simply does not trade.
 */
export function clearContract(order, quotes, opts = {}) {
  const { cfg = OPTION_DEFAULTS, rank = new Map(), rng = Math.random } = opts;
  const mine = quotes.filter((q) =>
    q.expiry === order.expiry && q.kind === order.kind && q.strike === order.strike);

  const wanted = order.side === 'BUY' ? 'ask' : 'bid';
  const taking = bookSide(mine, wanted, cfg, rank, rng);
  const result = {
    expiry: order.expiry, kind: order.kind, strike: order.strike,
    side: order.side, qty: order.qty,
    price: null, filled: 0, trades: [],
  };
  if (!taking.length) return result;

  // Step 1 — the house takes what it needs, level by level.
  const price = taking[0].price;
  result.price = price;
  let left = order.qty;
  for (const level of taking) {
    if (left <= 0) break;
    const take = Math.min(level.qty, left);
    level.qty -= take;
    left -= take;
    result.filled += take;
    result.trades.push(order.side === 'BUY'
      ? { buyer: null, seller: level.playerId, qty: take, price: level.price, house: true }
      : { buyer: level.playerId, seller: null, qty: take, price: level.price, house: true });
  }

  // Step 2 — leftover crossing interest trades among the players, at the
  // clearing price. The side the house just ate carries its remaining size
  // forward; the other side is untouched.
  const rest = (side) => {
    if (side === wanted) return taking.filter((l) => l.qty > 0);
    return bookSide(mine, side, cfg, rank, rng);
  };
  const bids = rest('bid');
  const asks = rest('ask');

  let i = 0, j = 0;
  while (i < bids.length && j < asks.length && bids[i].price >= asks[j].price) {
    // A player quoting both sides must not trade with themselves.
    if (bids[i].playerId === asks[j].playerId) { j++; continue; }
    const take = Math.min(bids[i].qty, asks[j].qty);
    bids[i].qty -= take;
    asks[j].qty -= take;
    result.trades.push({
      buyer: bids[i].playerId, seller: asks[j].playerId, qty: take, price, house: false,
    });
    if (bids[i].qty === 0) i++;
    if (asks[j].qty === 0) j++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

/**
 * Net position per contract, computed directly.
 *
 * The prototype used pivot tables for this; the spec is explicit that a coded
 * build should not reproduce them. Contracts that net to flat are dropped —
 * they are closed, not held.
 */
export function rollupPositions(positions) {
  const by = new Map();
  for (const p of positions) {
    const key = contractKey(p);
    const row = by.get(key) ?? { expiry: p.expiry, kind: p.kind, strike: p.strike, qty: 0, cost: 0 };
    row.qty += p.qty;
    row.cost += p.premium * p.qty;
    by.set(key, row);
  }
  return [...by.values()]
    .filter((r) => r.qty !== 0)
    .sort((a, b) => a.expiry - b.expiry || a.strike - b.strike || a.kind.localeCompare(b.kind));
}

/**
 * Gross option inventory — absolute size across every open contract.
 *
 * Used as a tiebreak and for turn order in the player-proposed-strike variant.
 * Whether stock counts too is open (§10.7); it does not, by default.
 */
export function grossOptionInventory(positions, shares = 0, cfg = OPTION_DEFAULTS) {
  const gross = rollupPositions(positions).reduce((a, r) => a + Math.abs(r.qty), 0);
  return cfg.grossInventoryIncludesStock ? gross + Math.abs(shares) : gross;
}

/**
 * Value of one contract at expiry.
 *
 * Settlement arithmetic, not a valuation — this is only ever called once the
 * round's dice have resolved and the price has stopped moving. Nothing calls it
 * to suggest what an option is worth mid-game, and nothing may.
 */
export function intrinsic(kind, strike, price) {
  return kind === 'call' ? Math.max(0, price - strike) : Math.max(0, strike - price);
}

/**
 * Open P/L on option positions, the mirror of the stock leg's position().
 *
 * A position is worth its premium until the auction says otherwise, so an
 * unmarked contract contributes zero P/L rather than a total loss. That matters:
 * marking an unpriced long to zero would book the whole premium as a loss the
 * moment the auction skipped its strike, which is an artefact of the auction
 * schedule rather than anything that happened in the market.
 */
export function optionPL(positions, marks = new Map()) {
  return positions.reduce((a, p) => {
    const mark = marks.get(contractKey(p)) ?? p.premium;
    return a + (mark - p.premium) * p.qty;
  }, 0);
}

/**
 * Settle everything expiring at `round` against the settled price.
 *
 * Longs collect, shorts pay, which the signed quantity handles on its own. The
 * P/L booked is intrinsic less what was paid, so a long call that expires
 * worthless loses exactly its premium and no more.
 */
export function settleExpiring(positions, round, price) {
  const expiring = positions.filter((p) => p.expiry === round);
  const remaining = positions.filter((p) => p.expiry !== round);

  const marks = new Map();
  for (const p of expiring) marks.set(contractKey(p), intrinsic(p.kind, p.strike, price));

  const settled = rollupPositions(expiring).map((r) => ({
    ...r,
    price,
    value: intrinsic(r.kind, r.strike, price) * r.qty,
  }));

  return { realized: optionPL(expiring, marks), settled, remaining };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The options container hung off the game when the toggle is on. */
export function createOptionsState() {
  return {
    orders: [],     // this round's generated market orders, across all tables
    quotes: {},     // playerId -> quote[]
    cleared: null,  // this round's auction result, once stage 3 exists
    marks: {},      // contractKey -> last discovered price
  };
}

/** The per-player fields the options layer adds. No balance — see the header. */
export function createPlayerOptions() {
  return { optionPositions: [], optionLog: [] };
}
