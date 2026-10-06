# Quickstart: validate the feature end to end

Everything runs inside the container. Nothing is installed on the host except Docker.

## Prerequisites

- Docker with Compose. Host Node and Rust are not used.
- A devnet wallet with ~2 SOL (one airdrop) and some Circle devnet USDC from `faucet.circle.com`
  for the browser flows. Program tests and the local lifecycle need neither.

## One command

```
make dev
```

Builds the pinned image (Rust 1.89, Anchor 1.2.1, Agave 3.1.14, Node 22), starts the container with
`target/` and the cargo registry in named volumes, builds the program, runs the program test suite
against LiteSVM, starts a local validator, deploys, runs the full lifecycle script, and starts the web
app on `http://localhost:3000` against the local validator. Expected: green test summary, lifecycle
log ending in `redeem ok`, web app showing the demo markets.

## Scenario 1 — program tests (PRD §7 program row)

```
make test-program
```

Expected: tests pass for mint/redeem conservation at every price including `close == strike`; stale,
too-old, wide-confidence and valid oracle quotes; publisher allowlist; settle before close refused;
override refused at `close + 3599 s` and accepted at `close + 3600 s`; second settle is a no-op; pause
blocks mint and orders but not redeem; price-time priority and the 8-fill cap; Buy No market leaves
only No; `BookFull` on the 65th resting order at demo capacity. Clock is warped with LiteSVM.

## Scenario 2 — local lifecycle (PRD §7 integration row)

```
make lifecycle CLUSTER=localnet
```

Runs `scripts/lifecycle.ts`: initialize config (mock provider, local USDC mint), create a synthetic
trading day with `close_ts = now + 90 s`, two users mint, one quotes and one takes all four paths,
publisher writes a price, settle, both redeem. Expected final assertion: vault balance equals zero and
each user's USDC change equals their hand-computed P&L printed alongside.

## Scenario 3 — devnet lifecycle (graded deliverable)

```
make deploy CLUSTER=devnet
make lifecycle CLUSTER=devnet DEMO_SCALE=1
```

Same script against devnet with Circle USDC, 2 tickers × 3 strikes, book capacity 64. Expected: fits
in one airdrop (rent printed before creation, ~0.45 SOL), program ID and all market addresses printed
for the README. Rerunning `make lifecycle` on a new day creates a new set.

## Scenario 4 — scheduled jobs

```
make jobs
```

Starts the automation service with cron enabled. On a trading day: markets exist by 08:30 ET; at
16:00:30 settlement starts; by 16:05 all markets show an outcome. To rehearse without waiting, run
`pnpm --filter automation run job morning --day <today>` then `... job settle --once`.

## Scenario 5 — browser flows (PRD §7 frontend row)

```
make web      # dev server against the cluster in .env
make test-web # Vitest translation-layer tests + Playwright smoke flows
```

Manual check: connect Phantom on devnet, open a strike, place a Buy Yes limit, open the same page in a
second browser and watch the book update without reload, Buy No at market and confirm only No is held.

## Scenario 6 — Pyth token day (R5)

```
PYTH_API_KEY=... pnpm --filter automation run probe pyth
```

Prints the AAPL `Equity.US` update, posts it to the devnet receiver, reads it back through the SDK in
a LiteSVM test, and compares with Nasdaq. Then `update_config --provider pyth` and rerun Scenario 3.
Expected: same lifecycle output with the settlement price sourced from the posted update.

## Things that must be true before "done"

- `make dev` on a clean machine with only Docker completes without manual steps (SC-006).
- No page under `/`, `/markets`, `/trade`, `/portfolio`, `/history` mentions the provider, the mock,
  or any implementation detail.
- `.env.example` is complete and no keypair is in the image or the repo.
- `DECISIONS.md` and `AI_USAGE.md` record any decision made during implementation, once, when made.
