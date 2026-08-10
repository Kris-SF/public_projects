# Mooncoin Terminal

A web port of the Mooncoin spreadsheet game. Every player gets a private screen
on their own phone; the shared dashboard goes on the big screen; the host drives
the round from a third.

Ported from `mooncoin base game_master` — the Google Sheet plus its Apps Script.
Where the sheet and the design disagreed, the design won; those cases are listed
under [Changes from the spreadsheet](#changes-from-the-spreadsheet).

## Running it

```bash
npm start            # http://localhost:3000 — no dependencies to install
npm test             # 66 tests: engine, state machine, and a full game over HTTP
```

Set `PORT` to move it. Locally, games live in the server process; see
[Deploying](#deploying) for what production needs.

Three surfaces, one room code:

| Screen | URL | Who |
|---|---|---|
| Player | `/ABCD` | each player, on their own device |
| Dashboard | `/ABCD#dashboard` | the projector or TV |
| Host | `/ABCD#host` | whoever runs the table |

Open `/`, hit **New table**, and you get the code plus the host console. The host
token lives in that browser's `localStorage`, so run the console from the machine
that created the room. Players who reload — or whose phone sleeps — land back in
the same seat with the same hand and blotter.

## How a round works

Two gates per round, matching the two ready-columns the sheet tracked. Each trips
automatically when every seated player has confirmed; the host can force either
one when somebody wanders off.

1. **Orders** — everyone submits a signed quantity and an order type, then
   confirms. The gate reveals the book, prints the round, and writes every
   blotter.
2. **Cards** — everyone plays cards and confirms. The gate reveals them and
   computes the pressure on the dice.
3. **Rolling** — four dice, locked one at a time. The fourth settles the round
   and moves the mark.

Orders and cards stay sealed until their gate trips. Who has confirmed is public;
what they confirmed is not.

## The market

Orders carry no limit price — only a signed quantity and a type:

- **MARKET** — demands immediacy, always fills, pays the impact
- **LIMIT** — rests at the last sale, absorbs pressure coming the other way, and
  fills at the clearing price or not at all

Market orders net against each other first. Whatever pressure survives is met by
the resting orders facing it, and only what the book cannot absorb moves the
price:

```
pressure  = market buys - market sells
resting   = limit orders facing that pressure (offers if buying, bids if selling)
absorbed  = min(|pressure|, resting)
imbalance = sign(pressure) * (|pressure| - absorbed)

print = last mark + sign(imbalance) * ceil(sqrt(|imbalance|))
```

Everyone who trades that round trades at that one price — a single-price call
auction, not a ladder.

A resting order on the *same* side as the pressure is not marketable: nobody
sells at last sale into a bid. It absorbs nothing and does not trade. So ten to
buy at market plus ten more resting to buy is still an imbalance of ten.

Square-root impact is the whole governor on size. There is no position limit and
none is needed: a 100-lot market order into an empty book moves the print ten
points against itself.

Resting orders fill pro-rata when more is offered than the round needed. The
house takes the other side of the imbalance, which is by construction whatever
the players did not net out among themselves.

## The dice

Cards and regime bias the dice; they do not replace them.

```
cards.trend  = sum(up) - sum(down)          cards.mag = sum(multiply) - sum(add)
regime.trend = +/-1 if the last two rounds agreed on direction
regime.mag   = +/-1 if the last two rounds agreed on type

net.trend = regime.trend + cards.trend
net.mag   = regime.mag   + cards.mag

trend = (trendDie + net.trend > 3) ?  +1 : -1
type  = (typeDie  + net.mag   > 3) ? MULTIPLY : ADD
chg   = type is MULTIPLY ? A*B*trend : (A+B)*trend

newMark = mark + chg
```

Regime is trend persistence — momentum begets momentum. It needs two rounds of
history, so it is inert until round 3.

So there are two prices per round, and they are not the same number. You trade at
the **print**, struck off the old mark by order flow. You are marked at the
**mark**, which the dice set afterwards.

## Position

Pure mark-to-market, exactly as the sheet did it:

```
P/L per fill = (mark - fillPrice) * qty
shares       = sum(qty)
avg price    = mark - totalP/L / shares      (back-solved)
```

## Changes from the spreadsheet

Four things in the sheet were broken or unbuilt rather than intended:

1. **The magnitude side of NET was dead.** `Terminal!T7:T16` was hardcoded to `0`
   instead of `=P+R`, so every multiply and add card, and the entire type-regime,
   silently did nothing. Wired here as the mirror of the trend side.
2. **Card inventory only decremented for `↑`.** The other three counters were
   hardcoded, so those cards could be spent forever. All four decrement now.
3. **The trade blotter was typed by hand.** The engine writes fills, so the
   sheet's "Players Record Trades" step is gone.
4. **Dealing ignored the player count.** The Apps Script always dealt ten hands
   and silently short-handed later players once the hundred-card deck ran dry.
   Only seated players are dealt now, and an oversubscribed deck is a hard error.

Options were scaffolded in the sheet — `CALL`/`PUT` dropdowns, an `option_tickets`
range, named ranges for ATM and expiry — but never built. They are out of scope
here. Positions are keyed per fill rather than assuming a single instrument, so
adding them later is an extension, not a rewrite.

## Layout

```
api/
  game.js        Vercel serverless entry — thin adapter over the handler
server/
  engine.js      pricing and position math, no state, no I/O
  game.js        state machine: phases, gates, dealing, settlement
  handler.js     the API, transport-agnostic
  store.js       Redis over the Upstash REST API, memory when unconfigured
  index.js       local dev server: static files + the same handler
public/
  index.html     shell
  app.js         all three surfaces, polling transport
  style.css      amber-on-black terminal styling
```

Zero runtime dependencies. `engine.js` is pure — no state, no I/O — so it can be
lifted out and reused as-is.

## Transport

Polling, not sockets. Serverless functions cannot hold a WebSocket open, and the
game is turn-based, so a poll tick is indistinguishable from a push. Every action
posts and gets the resulting state straight back — whoever acted never waits for
a tick, and the polling only exists to show you what other people did.

The interval adapts: ~1.5s while you owe the table an action, ~3s once you have
confirmed, ~0.9s during the dice, and 10s on a hidden tab. That keeps a ten-player
table well inside a free Redis tier.

## Deploying

Built for Vercel. Create a **new project** pointed at this repo with the root
directory set to `mooncoin` — same arrangement as `trading-sim`, so it deploys
independently of the static site at the repo root. Every branch then gets its own
preview URL.

**Add a Redis store, or the game will not work properly.** Serverless functions
share no memory, so game state has to live somewhere both requests can reach:

1. Vercel dashboard → **Storage** → **Upstash for Redis** → create and connect it
   to the Mooncoin project
2. Redeploy

That injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`, which the store picks up
automatically. `UPSTASH_REDIS_REST_URL` / `_TOKEN` work too, if you bring your own
database.

Without it the app still boots, but every screen shows a warning: consecutive
requests can land on different instances holding different games, and tables will
appear to vanish. State carries a twelve-hour TTL, so abandoned tables clean
themselves up.

It also runs anywhere with Node 20+ — `PORT=8080 npm start` — where the in-process
fallback is perfectly correct, because there is only ever one process.
