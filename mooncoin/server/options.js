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

  // §3 — the fixed-expiry tables that sit alongside the current round's table.
  fixedExpiries: [3, 5],

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
  const fixed = cfg.fixedExpiries ?? OPTION_DEFAULTS.fixedExpiries;
  const tables = [{ key: `r${round}`, expiry: round, label: 'Current round', current: true }];
  for (const e of fixed) {
    if (e <= round || e > maxRounds) continue;
    tables.push({ key: `r${e}`, expiry: e, label: `Round ${e}`, current: false });
  }
  return tables;
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
