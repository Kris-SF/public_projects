import { aggregateOrders, printPrice, matchOrders, resolveDice, cardEffects, regimeEffects, position, DEFAULTS }
  from '../../server/engine.js';
import { clearContract, makeQuote, strikeGrid, intrinsic, settleExpiring, optionPL, contractKey }
  from '../../server/options.js';

const out = {};

// --- 1. A stock round, round numbers -------------------------------------
const orders = [
  { playerId: 'you',  qty:  6, type: 'MARKET' },
  { playerId: 'ana',  qty:  4, type: 'MARKET' },
  { playerId: 'ben',  qty: -3, type: 'MARKET' },
  { playerId: 'cara', qty: -2, type: 'LIMIT'  },
];
const OPENING = DEFAULTS.openingPrice;   // 100, the game's own default
out.opening = OPENING;
out.round = matchOrders(orders, OPENING);
out.round.lastMark = OPENING;

// --- 2. Impact curve ------------------------------------------------------
out.impact = [1,2,3,4,5,6,8,9,10,12,16,20,25,30,40,50].map((i) => ({ imb: i, slip: printPrice(100, i) - 100 }));

// --- 3. The dice ----------------------------------------------------------
const cards = cardEffects([{ up: 1, down: 0, multiply: 0, add: 0 }]);
const regime = regimeEffects([]);
const net = { trend: cards.trend + regime.trend, mag: cards.mag + regime.mag };
out.dice = { cards, regime, net, roll: [3, 5, 4, 6], ...resolveDice([3, 5, 4, 6], net) };
out.dice.mark = OPENING + out.dice.chg;
out.dice.bar = 4 - net.trend;
out.diceNoCards = { net: { trend: 0, mag: 0 }, roll: [3, 5, 4, 6], ...resolveDice([3, 5, 4, 6], { trend: 0, mag: 0 }) };
out.diceNoCards.mark = OPENING + out.diceNoCards.chg;

// --- 4. P/L ---------------------------------------------------------------
out.pl = position([{ qty: 6, price: out.round.price }], out.dice.mark);
out.pl.mark = out.dice.mark;

// --- 5. Option auction: the spec's own worked example ---------------------
const C = { expiry: 3, kind: 'call', strike: 100 };
const q = (id, b, bq, a, aq) => makeQuote({ playerId: id, ...C, bidPx: b, bidQty: bq, askPx: a, askQty: aq, round: 1 });
out.auctionIn = { ana: { ask: 12, sz: 1 }, ben: { ask: 18, sz: 1 }, you: { bid: 20, sz: 1 }, want: 1 };
out.auction = clearContract({ ...C, side: 'BUY', qty: out.auctionIn.want },
  [q('ana', null, 0, out.auctionIn.ana.ask, out.auctionIn.ana.sz),
   q('ben', null, 0, out.auctionIn.ben.ask, out.auctionIn.ben.sz),
   q('you', out.auctionIn.you.bid, out.auctionIn.you.sz, null, 0)],
  { rng: () => 0.5 });
out.walkIn = { ana: { ask: 10, sz: 2 }, ben: { ask: 14, sz: 4 }, want: 5 };
out.walk = clearContract({ ...C, side: 'BUY', qty: out.walkIn.want },
  [q('ana', null, 0, out.walkIn.ana.ask, out.walkIn.ana.sz),
   q('ben', null, 0, out.walkIn.ben.ask, out.walkIn.ben.sz)], { rng: () => 0.5 });
out.dry = clearContract({ ...C, side: 'BUY', qty: 1 }, [q('ana', 8, 1, null, 0)], { rng: () => 0.5 });

// --- 6. Settlement --------------------------------------------------------
out.grid100 = strikeGrid(100);
out.grid112 = strikeGrid(112);
out.settleWin  = settleExpiring([{ playerId:'you', kind:'call', strike:100, expiry:1, qty:1, premium:12, round:1 }], 1, 112);
out.settleZero = settleExpiring([{ playerId:'you', kind:'call', strike:100, expiry:1, qty:1, premium:12, round:1 }], 1, 94);
out.settleShort= settleExpiring([{ playerId:'ana', kind:'call', strike:100, expiry:1, qty:-1, premium:12, round:1 }], 1, 112);
out.intrinsics = { c100at112: intrinsic('call',100,112), c100at94: intrinsic('call',100,94), p100at94: intrinsic('put',100,94) };


// --- 7. Settlement, teaching set: one premium, three outcomes -------------
const long100c = (q = 1) => [{ playerId: 'you', kind: 'call', strike: 100, expiry: 1, qty: q, premium: 12, round: 1 }];
out.teach = {
  premium: 12, strike: 100,
  win:   settleExpiring(long100c(), 1, 124),
  even:  settleExpiring(long100c(), 1, 112),
  dust:  settleExpiring(long100c(), 1, 94),
  short: settleExpiring(long100c(-1), 1, 124),
};
out.teach.putWin = settleExpiring(
  [{ playerId: 'you', kind: 'put', strike: 100, expiry: 1, qty: 1, premium: 6, round: 1 }], 1, 94);

// --- 8. A crowded contract: the house takes the best, players cross behind it
const D = { expiry: 5, kind: 'call', strike: 105 };
const d = (id, b, bq, a, aq) => makeQuote({ playerId: id, ...D, bidPx: b, bidQty: bq, askPx: a, askQty: aq, round: 1 });
out.crowdIn = { ana: { ask: 9, sz: 2 }, ben: { ask: 11, sz: 3 },
                you: { bid: 14, sz: 2 }, cara: { bid: 10, bsz: 1, ask: 12, asz: 1 }, want: 2 };
out.crowd = clearContract({ ...D, side: 'BUY', qty: out.crowdIn.want }, [
  d('ana',  null, 0, out.crowdIn.ana.ask, out.crowdIn.ana.sz),
  d('ben',  null, 0, out.crowdIn.ben.ask, out.crowdIn.ben.sz),
  d('you',  out.crowdIn.you.bid, out.crowdIn.you.sz, null, 0),
  d('cara', out.crowdIn.cara.bid, out.crowdIn.cara.bsz, out.crowdIn.cara.ask, out.crowdIn.cara.asz),
], { rng: () => 0.5 });

// --- 9. Marking an open position off the auction --------------------------
out.marking = {
  flat: optionPL(long100c(), new Map()),
  up:   optionPL(long100c(), new Map([[contractKey(long100c()[0]), 17]])),
  down: optionPL(long100c(), new Map([[contractKey(long100c()[0]), 9]])),
};

// --- 10. Thresholds the dice panel states up front -----------------------
out.thresholds = [-3,-2,-1,0,1,2,3].map((net) => {
  const need = 4 - net;
  return { net, need: Math.max(1, Math.min(7, need)), certain: need <= 1 ? 'up' : need > 6 ? 'down' : null,
           chance: need <= 1 ? 100 : need > 6 ? 0 : Math.round(((7 - need) / 6) * 100) };
});
console.log(JSON.stringify(out, null, 1));
