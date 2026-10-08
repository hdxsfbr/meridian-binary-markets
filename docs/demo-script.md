# Demo script

> **Draft status.** This is a Wave 6 draft, to be finalized in Wave 8 after a rehearsal run.
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
- `NEXT_PUBLIC_PROGRAM_ID` in `.env` pointed at the deployed program; `make web` running.
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

1. **Connect the maker wallet.** On the Trade page for one ticker, pick a strike. **Mint** a few
   pairs ("depositing USDC, receiving an equal number of Yes and No tokens — this is the only way
   new tokens enter the system"), then post a resting **bid** and a resting **ask** on the Yes
   book from the Maker panel ("two-sided liquidity — anyone can now buy or sell Yes against these
   resting orders").
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
   Click **Redeem** on the winning position, confirm the wallet approval. "The payout comes
   straight from the program's on-chain vault back into my wallet — I held my own keys the whole
   time, but the program itself was holding this USDC while the position was open."
2. **History page.** "Every fill and every redemption is right here, read straight from the
   on-chain event log — there's no separate database behind this view." (This page reads a
   wallet's own event history regardless of which trading day a market belongs to, so it would
   show Part 1's synthetic-day redemptions too, for the wallets that ran that script.)

## Closing line

"That's the full lifecycle — create, mint, trade, settle, redeem — reproducible by anyone with
Docker and a devnet wallet, using the exact scripts in `docs/deployment.md`."

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
