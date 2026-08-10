# Mooncoin Terminal

A web port of the Mooncoin spreadsheet game. Every player gets a private screen
on their own phone; the shared dashboard goes on the big screen; the host drives
the round from a third.

Ported from `mooncoin base game_master` — the Google Sheet plus its Apps Script.
Where the sheet and the design disagreed, the design won; those cases are listed
under [Changes from the spreadsheet](#changes-from-the-spreadsheet).

## Running it

```bash
npm install
npm start            # http://localhost:3000
npm test             # 53 tests: engine, state machine, and a live socket game
```

Set `PORT` to move it, `MOONCOIN_DATA` to point the snapshot file somewhere else.

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

- **MARKET** — guaranteed fill, pays the impact
- **LIMIT** — rests, moves nothing, and only trades if market flow comes the
  other way

Only market flow enters the imbalance, so resting liquidity never moves the price
on its own.

```
imbalance = market bid - market offer
print     = last mark + sign(imbalance) * ceil(sqrt(|imbalance|))
```

Square-root impact is the whole governor on size. There is no position limit and
none is needed: a 100-lot market order moves the print ten points against itself.

Market orders always fill in full — that certainty is what the slippage buys.
Limit orders fill pro-rata against opposing market flow, and the house absorbs
whatever the resting book could not cover.

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
server/
  engine.js      pricing and position math, no state, no I/O
  game.js        state machine: phases, gates, dealing, settlement
  store.js       JSON snapshot persistence
  index.js       HTTP + WebSocket, room fan-out
public/
  index.html     shell
  app.js         all three surfaces
  style.css      amber-on-black terminal styling
```

`engine.js` is pure and has no dependencies — it can be lifted out and reused.

## Deploying

One long-lived Node process holding WebSockets, so it wants a container host —
Render, Railway, Fly, or any box with Node 20+. It is not a fit for the static
Vercel deploy at the root of this repo.

```bash
PORT=8080 npm start
```

State lives in memory and is mirrored to `.data/games.json` on a short debounce,
so a restart or redeploy mid-game is survivable. Tables idle for twelve hours are
swept.
