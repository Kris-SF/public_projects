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
 */

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

  // §3 — the fixed-expiry tables that sit alongside the current round's table.
  fixedExpiries: [3, 5],

  // §8 — settlement. Cash is options-only; see the note on `startingCash` below.
  startingCash: 1000,
  negativeCashRate: 0.05,

  // §10.1 — resolved: a market order with no quotes on the required side dies.
  unfilledMarketOrder: 'drop',

  // §10.3 — resolved to the §5 tiebreak ladder. 'equal-split' matches the stock
  // leg instead, and is the alternative the spec names.
  tieBreak: 'size-cash-random',

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
 * Cash value of one contract at expiry.
 *
 * Settlement arithmetic, not a valuation — this is only ever called once the
 * round's dice have resolved and the price has stopped moving. Nothing calls it
 * to suggest what an option is worth mid-game, and nothing may.
 */
export function intrinsic(kind, strike, price) {
  return kind === 'call' ? Math.max(0, price - strike) : Math.max(0, strike - price);
}

/**
 * Settle everything expiring at `round` against the settled price.
 *
 * Longs receive, shorts pay, which the signed quantity handles on its own.
 * Returns the cash delta and the rows that should drop off the blotter.
 */
export function settleExpiring(positions, round, price) {
  const expiring = positions.filter((p) => p.expiry === round);
  const remaining = positions.filter((p) => p.expiry !== round);
  let cash = 0;
  const settled = [];
  for (const r of rollupPositions(expiring)) {
    const value = intrinsic(r.kind, r.strike, price) * r.qty;
    cash += value;
    settled.push({ ...r, price, value });
  }
  return { cash, settled, remaining };
}

/**
 * Interest owed on a negative balance, as a positive number to subtract.
 *
 * Rounded down, per the spec's own worked example: −$340 at 5% owes $17.
 * A non-negative balance earns nothing — this is a leverage cost, not a
 * savings account.
 */
export function interestOn(cash, cfg = OPTION_DEFAULTS) {
  if (cash >= 0) return 0;
  const rate = cfg.negativeCashRate ?? OPTION_DEFAULTS.negativeCashRate;
  return Math.floor(Math.abs(cash) * rate);
}

/**
 * Net worth.
 *
 * The prototype omitted option value entirely and the spec calls that a gap, so
 * marked option positions are included here. `marks` maps contractKey to a mark
 * per contract; contracts with no mark contribute nothing, because the only
 * honest mark is one the auction produced. An unpriced position is carried at
 * zero rather than at a number the game invented.
 */
export function netWorth({ cash, shares, mark, positions = [], marks = new Map() }) {
  const options = rollupPositions(positions)
    .reduce((a, r) => a + (marks.get(contractKey(r)) ?? 0) * r.qty, 0);
  return cash + shares * mark + options;
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

/** The per-player fields the options layer adds. */
export function createPlayerOptions(cfg = OPTION_DEFAULTS) {
  return {
    cash: cfg.startingCash ?? OPTION_DEFAULTS.startingCash,
    optionPositions: [],
    optionLog: [],
  };
}
