# Demo script

> Timings are estimates; the whole walkthrough is designed to fit under 10 minutes of *finished*
> footage, though — see Part 3 below — one segment can only be recorded at a specific time of day.

Goal: show create → mint → trade → settle → redeem, on devnet, using the exact scripts in
`docs/deployment.md`.

Two tracks, recorded separately and edited together:

- **Terminal track** (Parts 1 and 3): drives the full lifecycle at CLI speed, using a *synthetic*
  trading day so settlement doesn't have to wait for the real 4:00 PM ET close. Fast, but because
  the day is synthetic, none of these markets ever appear in the browser (see "Why two tracks"
  below) — this track is narrated entirely over the terminal.
- **Browser track** (Parts 2 and 4): the same five actions as experienced by a trader in the web
  app, which means it has to run against the *real* current trading day — the one the Markets and
  Trade pages actually query. That constrains timing: see Part 3.

## How the video is produced (2026-10-10)

The deliverable is a captioned screen recording with no voice track, produced by
`web/e2e/record-demo.mts` (Playwright, one WebM per scene, HTML title cards between scenes)
and stitched by `web/e2e/stitch-demo.sh` into `design/demo/meridian-demo.mp4`. It runs against
devnet through the dev server with the test wallet enabled, driving two fresh wallets. Because
the deadline falls on a weekend, the market shown is BTC, whose Pyth feed publishes around the
clock, so the close and the settlement in the recording are real (`DECISIONS.md` §30).

Scenes, in order:

1. Title card.
2. Landing page (hero cycles the assets with a live chart), then Markets with a card expanded.
3. Card: "Making a market".
4. Maker wallet on Portfolio: mints 5 pairs, queues two quotes (sell 5 Yes at $0.55, buy 5 Yes
   at $0.45), submits, confirmation toast.
5. Card: "Taking a side".
6. Taker wallet on Trade: buys 3 Yes at the quoted price, confirmation toast, Portfolio shows
   the position.
7. Card: "The close". Off screen, the market closes and the operator runs the settle job
   (`pnpm --filter automation run job settle`), which posts the Pyth price and settles.
8. Taker wallet: Markets shows the settled card, Trade shows the outcome, Portfolio shows
   "Collect $X" and Redeem winning, toast, then History.
9. End card.

Run (inside the dev container; secrets come from the two demo keypairs, exported to base58):

```bash
docker exec -e MAKER="$(cat /tmp/demomaker.b58)" -e TAKER="$(cat /tmp/demotaker.b58)" \
  -e TICKER=BTC -e STRIKE=100000 -e PHASE=pre -e PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
  -w /work/web meridian-web-devnet-e2e /work/scripts/node_modules/.bin/tsx e2e/record-demo.mts
# ... market closes; run the settle job; then:
docker exec ... -e PHASE=post ... e2e/record-demo.mts
# Devnet confirmation waits are recorded in full; the recorder logs each wait's interval to
# design/demo/cuts.json and this removes them (hard cut from click to confirmation), on the host:
bash web/e2e/cut-waits.sh design/demo
bash web/e2e/mux-narration.sh design/demo <narration wav dir>   # narrated cut
docker exec -w /work/web meridian-web-devnet-e2e bash e2e/stitch-demo.sh /work/design/demo   # silent cut
```

`SCENES=04-maker,06-taker` (prefix match) re-records only those scenes. The recording web
server needs the trade-history index reachable from its own origin: `web/.env.local` with
`EVENTS_INDEX_UPSTREAM=<worker url>` and `NEXT_PUBLIC_EVENTS_INDEX_URL=/api` routes it through
`web/src/app/api/events/route.ts`, otherwise Portfolio shows "Cost basis updating…" for minutes
while the browser pages the chain itself.

## Narration for the recorded cut (2 min 44 s)

| Time | Scene | Say |
| --- | --- | --- |
| 0:00–0:03 | Title | This is Meridian: binary markets on the daily close, built on Solana. |
| 0:03–0:21 | Landing, Markets | Every market asks one question: will a stock close at or above a price today? Each contract has a Yes side and a No side, and together they always pay exactly one dollar. You buy the side you believe for less than a dollar; if you're right, it's worth a dollar at the close. Here's today's board, with one strike per card and the rest a click away. |
| 0:21–0:24 | Card | First, where liquidity comes from. |
| 0:24–1:20 | Maker | A market maker deposits one dollar per pair and mints a Yes and a No token. Those dollars sit in the market's vault on chain, not with us. The maker then quotes both sides: offering to sell Yes at fifty-five cents, and to buy Yes at forty-five. Every quote is an on-chain order on a single book, so the No side is just one minus the Yes price. Each action is one wallet signature, and the app confirms it as soon as the transaction lands. |
| 1:20–1:23 | Card | Now a trader takes a side. |
| 1:23–1:46 | Taker | A second wallet opens the market, sees a fifty-five percent chance to buy Yes, and buys three contracts at the quoted price. The trade fills against the maker's order, the confirmation shows exactly what executed, and the position appears in the portfolio. |
| 1:46–1:47 | Card | Then the close. |
| 1:47–2:41 | Settlement, redemption | At the close, trading stops on chain. The settlement service fetches the closing price from the Pyth oracle, posts it to Solana, and the program settles every market against it. This one closed below the strike, so No wins. Winners redeem at a dollar per token: the maker collects ten dollars with one signature, and the balance updates. Losers' tokens are simply worth zero. No custody, no margin, no counterparty: the vault pays the winning side and nothing else. |
| 2:41–2:45 | End | Program, order book, oracle settlement and redemption, all on Solana devnet. Meridian. |

The sections below are the original narrated walkthrough and remain valid for a live demo.

## Why two tracks, not one

The web app's Markets and Trade pages call `todayTradingDay()` (`web/src/lib/markets.ts`) and pass
that real calendar day — not a URL param, not the day a script happens to pass — into
`useMarkets`/`useBook`. A market created for a synthetic `--day` (any day other than the real
current trading day) is real on chain and redeemable by its owner from the Portfolio/History
pages (which reconstruct a wallet's view from its own on-chain events, not from a day filter), but
it will never show up in the Markets list or be reachable from the Trade page's strike ladder.
That is why the fast, synthetic-close demo has to stay in the terminal, and why the part of the
walkthrough that uses the actual browser UI has to use the real trading day and therefore the
real 4:00 PM ET close.

## Before recording

- Program already deployed to devnet (`make deploy CLUSTER=devnet`), `Config` already initialized
  (`make init-config CLUSTER=devnet`) — see `docs/deployment.md`. Don't do first-time setup on
  camera; it's slow and it isn't the point of this video.
- Two funded devnet wallets, connected in the browser ahead of time for Part 2: the **taker**
  wallet (the one narrating the trade) and a **maker** wallet that will mint and quote before the
  taker trades. Both need devnet SOL and devnet USDC (`faucet.circle.com`).
- `NEXT_PUBLIC_PROGRAM_ID` in `.env` pointed at the deployed program; `make web` running. The same
  UI (pointed at devnet) is also live at `https://web-production-385a5.up.railway.app`, if you'd
  rather record against that instead of a local `make web`.
- Run every terminal command below inside the dev container (`make shell`, or prefix with
  `docker compose run --rm dev bash -c '...'`) — see `docs/deployment.md` §1.1.

## Part 1 — terminal: the full lifecycle, fast (≈2 minutes)

**Say:** "Meridian creates its markets every morning and settles them a few minutes after the
close. This is the full create, mint, trade, settle, redeem sequence run by one script, using a
synthetic trading day that closes in ninety seconds so we don't have to wait for 4 PM. Because
this script uses a synthetic day, you won't see these specific markets in the browser later —
that's a deliberate separation covered in the second half of this demo."

```
make lifecycle CLUSTER=devnet DEMO_SCALE=1 LIFECYCLE_ARGS="--close-in 90"
```

**Say, while it runs:** "This one command creates the strike ladder for every listed ticker, funds
two demo users, has one mint and quote and the other take both sides of a trade, waits for the
synthetic close, posts a signed price, settles every market, and has both users redeem — printing
a report of the rent spent, the USDC that moved, and both users' final profit and loss." Let it
run to completion on screen; the printed report is the proof this half of the demo needs, so there
is no requirement to also show it in the browser.

## Part 2 — browser: mint, trade, portfolio, on today's real markets (≈4 minutes)

Separately from Part 1 — these are different markets, created for the real current trading day so
the browser can actually see them:

```
pnpm --filter automation run job morning --force
pnpm --filter automation run job publisher --once
```

**Say:** "This is the same market-creation step the schedule runs automatically every morning at
8 AM, and the same price-publishing step that runs every minute through the trading day — run by
hand here so we don't have to wait." (`--force` is a no-op if today already is a trading day; it
only matters if the demo happens to be recorded on a weekend or holiday.)

A freshly created book has no resting orders, so before the taker can trade, a second wallet
mints and quotes:

1. **Connect the maker wallet.** On the Portfolio page, open **Your quotes** and pick a strike.
   **Mint pair** a few times ("depositing USDC, receiving an equal number of Yes and No tokens —
   this is the only way new tokens enter the system"), then submit a bid quote and an ask quote on
   the Yes book ("two-sided liquidity — anyone can now buy or sell Yes against these open quotes").
2. **Switch to the taker wallet.** "Here are the listed tickers, each showing live prices and how
   many active contracts exist right now." Click into the same ticker, same strike. "The order
   book shows both perspectives — Yes against USDC on one side, and the equivalent No price
   derived from it on the other, because Yes plus No always equals exactly one dollar."
   - Click **Buy Yes** against the maker's resting ask, confirm the wallet approval. "One click,
     one approval — I'm now holding Yes tokens, bought from the resting order we just posted."
   - Click **Buy No**, confirm the wallet approval. "This looks like a second trade, but it's
     still one wallet approval — under the hood this mints a new pair and sells the Yes half into
     the book automatically, so I end up holding only No, at a net cost of one dollar minus
     whatever that Yes just sold for."
3. **Portfolio page.** "Here are both positions, with my cost basis for each." Point out the
   countdown to the real 4:00 PM ET settlement if visible.

## Part 3 — terminal: settle today's real markets (≈1 minute, recorded at or after 16:00 ET)

Unlike Part 1's synthetic day, these markets close at the real 4:00 PM ET bell — this step cannot
be sped up, and is the one segment of this script that has to be recorded at the right time of
day rather than back-to-back with the rest:

```
pnpm --filter automation run job settle --once
```

(`--once` settles the real current trading day by default; pass `--day <YYYYMMDD>` explicitly if
you need to settle a specific day instead — the flag exists and is supported, it's just not needed
here since today already is the default.)

**Say, while it runs:** "This reads the price we posted earlier, checks it for staleness,
confidence, and that it came from an allowed publisher, and only then writes the outcome for every
market whose close has passed. If any of those checks fail, settlement refuses rather than
guessing — a wrong settlement can't be undone, so the system would rather be late than wrong."

## Part 4 — browser: redeem and history (≈1–2 minutes)

1. **Portfolio page** (refresh or wait for the live update). "Settlement is in — this position
   paid out, this one didn't, and the total resolves to exactly one dollar per pair either way."
   Click **Redeem winning** on the winning position, confirm the wallet approval. "The payout
   comes straight from the program's on-chain vault back into my wallet — I held my own keys the
   whole time, but the program itself was holding this USDC while the position was open."
2. **History page.** "Every trade and every redemption is right here, grouped by day, read
   straight from the on-chain event log — there's no separate database behind this view." (This
   page reads a wallet's own event history regardless of which trading day a market belongs to,
   so it would show Part 1's synthetic-day redemptions too, for the wallets that ran that script.)

## Closing line

"That's the full lifecycle — create, mint, trade, settle, redeem — reproducible by anyone with
Docker and a devnet wallet, using the exact scripts in `docs/deployment.md`. The app's own Docs
tab, at `/docs`, walks a trader through all of this in plain language if you want the detail
without the terminal."

## Reference: exact commands used in this script

```
make deploy CLUSTER=devnet
make init-config CLUSTER=devnet
make lifecycle CLUSTER=devnet DEMO_SCALE=1 LIFECYCLE_ARGS="--close-in 90"

pnpm --filter automation run job morning --force
pnpm --filter automation run job publisher --once
pnpm --filter automation run job settle --once
```

`scripts/lifecycle.ts` (driven by `make lifecycle`) is implemented today — it is not future work —
and is what Part 1 actually runs. `--close-in` is mandatory on `CLUSTER=devnet` and only valid
together with an explicit synthetic `--day`; the `job morning` calls in Part 2 intentionally omit
both so they target the real current trading day instead, which is what makes those markets
visible in the browser. See `docs/deployment.md` §1.4 for the preflight funding checks `make
lifecycle` runs before creating anything, and §1.1 for how much devnet SOL to have on hand before
any of this.
