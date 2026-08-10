/**
 * Mooncoin pricing engine.
 *
 * Ported from the "mooncoin base game_master" spreadsheet. Cell references in
 * comments point at the original Terminal / Player sheets so the provenance of
 * each rule stays traceable.
 *
 * Two prices exist per round, and they are not the same number:
 *   - the PRINT: what players trade at, derived from order-flow imbalance
 *   - the MARK:  where the coin settles after the dice, used for mark-to-market
 */

export const CARD_TYPES = ['up', 'down', 'multiply', 'add'];

export const DEFAULTS = {
  maxRounds: 5,
  cardQty: 10,
  openingPrice: 100,
  deckPerType: 25,
};

// ---------------------------------------------------------------------------
// Deck
// ---------------------------------------------------------------------------

export function buildDeck(perType = DEFAULTS.deckPerType) {
  const deck = [];
  for (const type of CARD_TYPES) {
    for (let i = 0; i < perType; i++) deck.push(type);
  }
  return deck;
}

/** Fisher-Yates, matching the Apps Script shuffleArray. */
export function shuffle(deck, rng = Math.random) {
  const out = deck.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function emptyHand() {
  return { up: 0, down: 0, multiply: 0, add: 0 };
}

/**
 * Deal `cardQty` cards to each of `numPlayers` seated players.
 *
 * The Apps Script always dealt ten hands regardless of how many people were
 * playing, and silently short-handed later players once the hundred-card deck
 * ran dry. Here the deal is limited to seated players and an over-subscribed
 * deck is a hard error rather than a quiet shortfall.
 */
export function deal(numPlayers, cardQty, rng = Math.random, perType = DEFAULTS.deckPerType) {
  const deck = shuffle(buildDeck(perType), rng);
  if (numPlayers * cardQty > deck.length) {
    throw new Error(
      `Deck too small: ${numPlayers} players x ${cardQty} cards exceeds ${deck.length}`
    );
  }
  const hands = [];
  let i = 0;
  for (let p = 0; p < numPlayers; p++) {
    const hand = emptyHand();
    for (let c = 0; c < cardQty; c++) hand[deck[i++]]++;
    hands.push(hand);
  }
  return hands;
}

// ---------------------------------------------------------------------------
// Order book
// ---------------------------------------------------------------------------

/**
 * Aggregate the round's orders into the book display.  Terminal!B20:E20.
 *
 * Orders carry no limit price — only a signed quantity and a type. LIMIT means
 * "passive: rest, don't move the print". MARKET means "aggressive: guaranteed
 * fill, pay the impact". Only market flow enters the imbalance (Terminal!E7),
 * so resting liquidity never moves the price on its own.
 */
export function aggregateOrders(orders) {
  let limitBid = 0, limitOffer = 0, marketBid = 0, marketOffer = 0;
  for (const o of orders) {
    const qty = Number(o.qty) || 0;
    if (qty === 0) continue;
    if (o.type === 'LIMIT') {
      if (qty > 0) limitBid += qty; else limitOffer += -qty;
    } else if (o.type === 'MARKET') {
      if (qty > 0) marketBid += qty; else marketOffer += -qty;
    }
  }
  return { limitBid, limitOffer, marketBid, marketOffer, imbalance: marketBid - marketOffer };
}

/**
 * Square-root market impact.  Terminal!H7:
 *   trunc(sqrt(ABS(imb)) + 0.99, 0) * sign(imb) + lastMark
 * The +0.99/trunc pair is a spreadsheet ceiling; ceil(sqrt(|imb|)) is the same
 * number for any imbalance a table can generate.
 */
export function printPrice(lastMark, imbalance) {
  if (imbalance === 0) return lastMark;
  return lastMark + Math.sign(imbalance) * Math.ceil(Math.sqrt(Math.abs(imbalance)));
}

/**
 * Largest-remainder apportionment. Guarantees the allocations sum to exactly
 * `available` so no share is conjured or lost to rounding.
 */
function proRata(wants, available) {
  const total = wants.reduce((a, b) => a + b, 0);
  if (total === 0) return wants.map(() => 0);
  if (available >= total) return wants.slice();

  const exact = wants.map((w) => (w * available) / total);
  const alloc = exact.map(Math.floor);
  let left = available - alloc.reduce((a, b) => a + b, 0);

  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e), want: wants[i] }))
    .sort((a, b) => b.frac - a.frac || b.want - a.want || a.i - b.i);

  for (let k = 0; left > 0; k++, left--) alloc[order[k % order.length].i]++;
  return alloc;
}

/**
 * Match the round and produce a fill per player, all at the single print price.
 *
 * Market orders always fill in full — that certainty is what the square-root
 * slippage buys. Limit orders only trade against opposing market flow, pro-rata
 * when the market side is too small to satisfy everyone, and the house absorbs
 * whatever market volume the resting side could not cover.
 */
export function matchOrders(orders, lastMark) {
  const book = aggregateOrders(orders);
  const price = printPrice(lastMark, book.imbalance);

  const limitBuys = orders.filter((o) => o.type === 'LIMIT' && o.qty > 0);
  const limitSells = orders.filter((o) => o.type === 'LIMIT' && o.qty < 0);

  // Limit sellers are hit by market buyers; limit buyers are lifted by market sellers.
  const sellAlloc = proRata(limitSells.map((o) => -o.qty), book.marketBid);
  const buyAlloc = proRata(limitBuys.map((o) => o.qty), book.marketOffer);

  const fills = [];
  for (const o of orders) {
    const qty = Number(o.qty) || 0;
    if (qty === 0) continue;
    let filled;
    if (o.type === 'MARKET') {
      filled = qty;
    } else if (qty > 0) {
      filled = buyAlloc[limitBuys.indexOf(o)];
    } else {
      filled = -sellAlloc[limitSells.indexOf(o)];
    }
    if (filled !== 0) fills.push({ playerId: o.playerId, qty: filled, price });
  }

  // Whatever the players do not net out among themselves, the house is on the
  // other side of. Counting unmatched market volume directly would double-count
  // opposing market orders, which satisfy each other before the house is needed.
  const net = fills.reduce((a, f) => a + f.qty, 0);

  return {
    ...book,
    price,
    fills,
    houseResidual: Math.abs(net),
  };
}

// ---------------------------------------------------------------------------
// Cards, regime, dice
// ---------------------------------------------------------------------------

/** Net direction and magnitude pressure from cards played.  Terminal!G20/H20. */
export function cardEffects(plays) {
  let trend = 0, mag = 0;
  for (const p of plays) {
    trend += (Number(p.up) || 0) - (Number(p.down) || 0);
    mag += (Number(p.multiply) || 0) - (Number(p.add) || 0);
  }
  return { trend, mag };
}

/**
 * Trend persistence.  Terminal!O9/P9.
 *
 * When the previous two rounds agreed on direction, the regime leans further
 * that way; likewise when they agreed on magnitude type. Needs two rounds of
 * history, so it is inert until round 3.
 */
export function regimeEffects(history) {
  const n = history.length;
  if (n < 2) return { trend: 0, mag: 0 };
  const a = history[n - 1];
  const b = history[n - 2];
  return {
    trend: a.trend === b.trend ? a.trend : 0,
    mag: a.type === b.type ? (a.type === 'MULTIPLY' ? 1 : -1) : 0,
  };
}

/**
 * Resolve four dice into a price change.  Terminal!Z7/AA7/AB7.
 *
 * dice = [trendDie, typeDie, A, B], each 1-6.
 *
 * The spreadsheet hardcoded the magnitude modifier to zero (Terminal!T7:T16),
 * which silently made every multiply/add card and the whole type-regime inert.
 * Wired here as the mirror of the trend side, per the intended design.
 */
export function resolveDice(dice, net) {
  const [trendDie, typeDie, a, b] = dice;
  const trend = trendDie + net.trend > 3 ? 1 : -1;
  const type = typeDie + net.mag > 3 ? 'MULTIPLY' : 'ADD';
  const chg = type === 'MULTIPLY' ? a * b * trend : (a + b) * trend;
  return { trend, type, chg };
}

// ---------------------------------------------------------------------------
// Position accounting
// ---------------------------------------------------------------------------

/**
 * Mark-to-market position.  Player!B10/C10/D10.
 *
 * P/L on each fill is (mark - fillPrice) * qty, which signs correctly for longs
 * and shorts alike. Average price is back-solved from the mark and the P/L,
 * exactly as the sheet did.
 */
export function position(fills, mark) {
  let shares = 0, pl = 0;
  for (const f of fills) {
    shares += f.qty;
    pl += (mark - f.price) * f.qty;
  }
  return {
    shares,
    pl,
    avgPrice: shares === 0 ? null : mark - pl / shares,
  };
}

export function rollDie(rng = Math.random) {
  return Math.floor(rng() * 6) + 1;
}
