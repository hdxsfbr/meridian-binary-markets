# Meridian

Binary stock outcome markets on Solana. Gauntlet AI partner project for Peak6.

> **Status: Wave 6 draft.** This README, and the docs it links to under `docs/`, are being
> finalized in Wave 8 after the Wave 7 devnet deployment run. Anything that depends on that run
> (program ID, market addresses, live screenshots) is marked "to be filled after deployment."

## What Meridian is

Every stock market day, Meridian lets anyone trade a simple yes/no question for each of seven
tech stocks: *"Will AAPL close at or above $230 today?"* You buy a Yes or a No token for less
than a dollar, and at 4:00 PM ET it resolves to exactly $1.00 or exactly $0.00, depending on
where the stock actually closed. There are no margin calls, no assignment risk, and no surprise
losses beyond what you paid — the most you can lose is your entry price, and the most you can
make is known the moment you place the trade. You always keep your own wallet keys — nothing is
ever deposited with a company or a custodian — but the program itself does hold your USDC and
tokens while a position is open: minting locks USDC in the market's on-chain vault until you
redeem or the market settles, and a resting limit order locks its USDC or tokens in an on-chain
escrow until it fills or you cancel it. Redeeming or cancelling returns funds to your wallet
immediately; nothing is held by anyone other than the program itself at any point.

Under the hood, Meridian is a non-custodial application built on Solana. A Rust/Anchor program
holds every rule that must never be broken — minting, redemption, order matching, and settlement
— so that no client, including ours, can cheat the outcome. A Node.js automation service runs the
daily schedule (create markets before the open, settle shortly after the close) and a Next.js
frontend lets a trader connect a wallet and trade. The one architectural idea worth understanding
before touching the code is the **"one book, two perspectives"** model: each strike has a single
order book (Yes vs USDC), and "Buy No" / "Sell No" are just the Yes book read from the other side.
See `docs/architecture.md` for the full explanation, and `docs/ONBOARDING.md` if you are new to
either trading systems or Solana.

## Scope

- Automated daily market creation for all 7 tickers (±3/6/9% strikes from the previous close,
  rounded to the nearest $10, deduplicated)
- Minting and redemption of Yes/No token pairs, preserving the $1.00 payout invariant
- One central limit order book per strike (Yes vs USDC) with real-time updates
- Four first-class trade paths — Buy Yes, Buy No, Sell Yes, Sell No — on that single book
- Wallet integration, position management, realized P&L, market-maker dashboard
- Automated settlement via a guarded price oracle, with redemption open indefinitely

### One book, two perspectives

The central architectural idea: each strike has **exactly one order book** — the Yes token traded
against USDC. Because Yes + No = $1.00, selling a Yes is economically identical to buying a No, so
no separate No book is needed. Buy Yes and Sell No are the same side of the book; Buy No and Sell
Yes are the other. The frontend presents four plain actions and translates intent into the correct
book operation. Details and worked examples: `docs/architecture.md`.

## Daily lifecycle (ET)

| Step | Time |
| --- | --- |
| Strikes calculated from previous close | 8:00 AM |
| Contracts and order books created | 8:30 AM |
| Markets visible, minting enabled | 9:00 AM |
| Trading open | 9:30 AM to 4:00 PM |
| Settlement | 16:00–16:05 PM (see `docs/architecture.md` for why the window is exactly that) |
| Redemption | from settlement, indefinitely |

## Targets

- 100% settlement accuracy; the $1.00 invariant never violated
- Sub-second transaction finality
- Oracle price staleness under 5 minutes, plus confidence and publisher-attestation checks — guards
  fail closed
- Full lifecycle demo reproducible on devnet: create → mint → trade → settle → redeem

## One-command setup

```
make dev
```

is the one command a reviewer needs. It builds the pinned Docker image, installs the pnpm
workspace, builds the Anchor program, runs the Rust/litesvm program test suite, starts a local
`solana-test-validator`, deploys the program to it, creates the on-chain config, runs the full
create → mint → trade → settle → redeem lifecycle once as a smoke test, seeds today's strike
ladder for one ticker with a resting ask, and serves the web app on `http://localhost:3000`.

### Trading in the browser against the local stack

The local validator is a private chain, so a browser wallet needs to be pointed at it and funded:

- **Fund a wallet.** `make shell`, then
  `pnpm --filter @meridian/scripts run fund-wallet -- <your-pubkey> --sol 2 --usdc 100`
  (localnet only; mints from the local test USDC mint).
- **Phantom.** Settings → Developer Settings → enable Testnet Mode and pick **Localnet**. Phantom
  only talks to `localhost:8899`, and only connects to pages served from `localhost` or HTTPS, so
  open the app at `http://localhost:3000`. If the stack runs on another machine, tunnel both ports
  first: `ssh -N -L 3000:localhost:3000 -L 8899:localhost:8899 -L 8900:localhost:8900 <host>`.
  Phantom cannot simulate or broadcast on Localnet itself; the app simulates and broadcasts through
  its own RPC connection and only asks the wallet to sign.
- **Solflare.** Add a custom network with RPC `http://127.0.0.1:8899` instead; it needs no tunnel
  when the stack runs locally.
- **Without a wallet extension.** `E2E=1 make dev` enables an in-page test wallet (never built in
  production). Paste a base58 secret key into `sessionStorage.__MERIDIAN_E2E_SECRET__` in the
  browser console, reload, and pick **Test Wallet** from the connect menu.
- **Serving to another machine.** `BIND_HOST=0.0.0.0 PUBLIC_HOST=<hostname> make dev` binds the
  ports on all interfaces and tells the web app which RPC host the browser should use.

**Prerequisites** — the only things that need to exist on the host:

- Docker, with Compose **2.24 or later** (`docker compose version`)
- `make`
- Bash

Nothing else is installed on the host — not Rust, not Node, not the Solana CLI, not Anchor. The
toolchain lives entirely inside the container (see "Toolchain" below and `DECISIONS.md` §7 for
why). On **Apple Silicon** the image runs under x86_64 emulation, because Agave (Solana's
validator/CLI) publishes no `linux/arm64` installer — builds and the validator are noticeably
slower than on an x86_64 host, but the same `make dev` works.

### What `make dev` actually does

In order: builds the `dev` image from the pinned `Dockerfile`; runs `pnpm install
--frozen-lockfile` inside the container; builds the Anchor program with `scripts/anchor-build.sh`
(`--arch v1`, see Toolchain); runs `cargo test -p meridian --tests` against the Rust/litesvm
program suite; starts `solana-test-validator` and waits for it to come up; airdrops the local
wallet and `anchor deploy`s the program to it; starts the Next.js dev server on `:3000` and waits
for it to answer; then prints the resolved `rustc`/`anchor`/`solana`/`node`/`pnpm` versions and
blocks, serving the web app until you stop it.

## Makefile targets

| Target | What it does |
| --- | --- |
| `make dev` | build, test, deploy to a local validator, run the lifecycle smoke test, seed today's markets, serve the web app |
| `make deps` | install the pnpm workspace with a frozen lockfile only |
| `make build` | install deps and compile the Anchor program only |
| `make test-program` | build then run the Rust/litesvm program test suite (`programs/meridian/tests/*.rs`) |
| `make lifecycle` | run the create → mint → trade → settle → redeem script (`CLUSTER` and `DEMO_SCALE` env vars select the target cluster and book capacity) |
| `make deploy` | build and deploy the program to `CLUSTER` (default `devnet`; use `CLUSTER=localnet` for a local-validator deploy) |
| `make init-config` | idempotently create (or print) the on-chain `Config` singleton |
| `make jobs` | start the automation service's cron schedule (morning/settle/publisher/reclaim jobs) |
| `make web` | run the Next.js dev server against the cluster configured in `.env` |
| `make test-web` | Playwright browser flows against a fresh local validator (trade, portfolio, admin) |
| `make shell` | open an interactive shell in the dev container |
| `make clean` | remove containers, named volumes, and local `node_modules`/`.next` output |

`CLUSTER` (`devnet` by default, or `localnet`) and `DEMO_SCALE` (`1` = book capacity 16, fits one
faucet airdrop; `0` = capacity 128, the production default) are environment variables most targets
respect — see `docs/deployment.md` for devnet-specific walkthroughs.

## `.env.example` walkthrough

Copy `.env.example` to `.env` and fill in secrets; `.env` is gitignored and never committed.

- **Cluster and RPC** — `SOLANA_CLUSTER`, `SOLANA_RPC_URL`, `SOLANA_WS_URL` select devnet or
  localnet and the endpoints the service, scripts, and web app read/write through.
- **Keys** — `ADMIN_KEYPAIR_PATH` and `PUBLISHER_KEYPAIR_PATH` point at keypairs mounted read-only
  into the container at `/run/keys/`. They are never baked into the image. `scripts/airdrop.ts
  --create-keys` can generate development keys under the repo-relative, gitignored `keys/`
  directory as a fallback.
- **Collateral** — `USDC_MINT` is Circle's devnet USDC mint by default; get test USDC from
  `faucet.circle.com` (see below).
- **Oracle** — `ORACLE_PROVIDER` (`mock` | `pyth`) must agree with the on-chain `Config`; the
  service refuses to start on a mismatch. `PYTH_HERMES_URL`, `PYTH_API_KEY`, and
  `PYTH_RECEIVER_PROGRAM` configure the real Pyth path; `FINNHUB_API_KEY` feeds the mock provider's
  two-source price check. See `docs/architecture.md` and `docs/risks-and-limitations.md` for what
  "mock" means here and why it is not a shortcut around the guards.
- **Alerting and status** — `ALERT_WEBHOOK_URL` (settlement-retry alerts),
  `AUTOMATION_STATUS_PORT`/`WEB_ORIGIN` (the automation service's status endpoint).
- **Ports** — `WEB_PORT`, `RPC_PORT`, `WS_PORT`, `STATUS_PORT` are host-side port bindings; change
  any of them if the default is already taken on your machine (see `docs/deployment.md`
  troubleshooting).
- **Demo scale** — `DEMO_SCALE` (`1` or `0`) as above.
- **Browser-facing (`NEXT_PUBLIC_*`)** — cluster, RPC/WS endpoints, the deployed program ID (filled
  in after `make deploy`), the USDC mint, and the automation status URL, all read by the web app at
  build/runtime.

## Getting devnet SOL and devnet USDC

- **SOL**: `pnpm --filter @meridian/scripts run airdrop` requests 2 SOL for the admin keypair on
  the configured cluster. On devnet this is rate-limited; if it fails, use
  `https://faucet.solana.com` manually. `localnet` airdrops always succeed. A devnet deploy needs
  several of these requests, not one or two — the program-data account plus its temporary deploy
  buffer need on the order of 7–9 SOL total. See `docs/deployment.md` §1.1 for the exact figures
  and the full funding sequence a fresh devnet deploy needs.
- **USDC**: devnet Circle USDC (mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) is available
  from `faucet.circle.com` — connect the same wallet you'll use in the browser.

## Running tests

| Package | Command | What it covers |
| --- | --- | --- |
| Program (Rust/litesvm) | `make test-program` | mint/redeem invariant, oracle guards, settlement, override delay, pause, order book matching, trade paths |
| SDK | `pnpm --filter @meridian/sdk run test` | PDA derivation, Book decoding, strike ladder, intent-to-instruction translation |
| Web | `make test-web` | Vitest translation-layer tests (no browser/Playwright suite exists yet — planned for Wave 7) |
| Automation | `pnpm --filter automation run test` | job logic, CLI flag parsing, calendar/holiday handling, providers |
| Scripts | `pnpm --filter @meridian/scripts run test` | deploy/init-config/airdrop/lifecycle helpers |

As of this wave: 261 Rust program tests, 108 SDK tests, 107 web tests, 108 automation tests (107
passing, 1 skipped), and 60 scripts tests — all passing, verified by running each package's test
command directly.

## Project layout

```
programs/meridian/     Rust/Anchor program: accounts, instructions, oracle guards, order book
packages/sdk/           Shared TypeScript: IDL client, PDAs, Book decoder, strike ladder, intent translation
services/automation/    Node.js scheduler: morning/settle/publisher/reclaim jobs, CLI, oracle providers
web/                    Next.js app: Landing, Markets, Trade, Portfolio, History, Admin
scripts/                Operational scripts: deploy, init-config, lifecycle, airdrop, rent-estimate
tests/                  Integration test suite (local validator, tests/integration/lifecycle.test.ts) — no browser/Playwright suite yet (Wave 7)
specs/001-binary-outcome-markets/  spec-kit artifacts: plan, research, data-model, quickstart, contracts, tasks
docs/                   This documentation set
```

## Documentation

| Document | Purpose |
| --- | --- |
| [`docs/ONBOARDING.md`](docs/ONBOARDING.md) | **New to trading systems or Solana? Start here.** Explains the domain from scratch |
| [`docs/architecture.md`](docs/architecture.md) | Accounts, instructions, the one-book mechanic, oracle guards, rent lifecycle, automation schedule, frontend data flow |
| [`docs/deployment.md`](docs/deployment.md) | Devnet deploy, step by step, with troubleshooting |
| [`docs/risks-and-limitations.md`](docs/risks-and-limitations.md) | Honest limitations of the current build; no regulatory or compliance claims |
| [`docs/demo-script.md`](docs/demo-script.md) | The demo video walkthrough: create → mint → trade → settle → redeem |
| [`docs/PRD.md`](docs/PRD.md) | Requirements FR-1…FR-12, merged from the portal brief and the partner PDF |
| [`docs/Gauntlet-Project-Meridian.pdf`](docs/Gauntlet-Project-Meridian.pdf) | The partner's original brief |
| [`docs/spikes/`](docs/spikes/) | Investigations behind specific decisions |
| [`.specify/memory/constitution.md`](.specify/memory/constitution.md) | Engineering principles governing the project |
| [`specs/001-binary-outcome-markets/`](specs/001-binary-outcome-markets/) | Feature spec, plan, research, data model, quickstart, contracts, tasks |
| [`DECISIONS.md`](DECISIONS.md) | Running decision log with trade-offs |
| [`AI_USAGE.md`](AI_USAGE.md) | AI usage log (required deliverable) |

## Development

Spec-driven, using [GitHub spec-kit](https://github.com/github/spec-kit) with the Claude Code
integration:

```
/speckit-constitution  →  /speckit-specify  →  /speckit-plan  →  /speckit-tasks  →  /speckit-implement
```

Commits reference the requirement they advance, e.g. `FR-5: oracle settlement with staleness check`.

## Deliverables

- Source code
- Technical documentation (including a risks/limitations note, with no regulatory or compliance
  claims)
- Deployment guide with reproducible devnet scripts and one-command setup
- Test results (unit, integration, frontend and invariant tests)
- Demo video
- AI usage log

## Partner

Peak6 — PEAK6 Labs, the internal innovation and applied AI team, building Apex's Non-Traditional
Assets Platform (prediction markets, crypto trading, tokenization).
Technical contact: Myles Lewis (mlewis@peak6.com).

## Toolchain

Verified by running `make dev` from a clean checkout (image rebuilt from scratch, no cached
volumes) on 2026-10-06:

| Tool | Version | Notes |
|---|---|---|
| Rust | `rustc 1.89.0 (29483883e 2025-08-04)` | pinned, unchanged from plan |
| Anchor CLI | `anchor-cli 1.2.1` | installed from the prebuilt release binary, matching the plan's first choice and the `anchor-lang`/`anchor-spl` crates the program depends on — see `DECISIONS.md` §7 |
| Agave (Solana) CLI | `solana-cli 3.1.14 (src:3134055b; feat:534737035, client:Agave)` | pinned, unchanged from plan |
| Node.js | `v22.23.3` | Node 22 LTS, installed as an exact version pin |
| pnpm | `10.0.0` | via Corepack, baked into the image so no network call is needed at container start |

The base image moved from `rust:1.89-bookworm` to `rust:1.89-trixie` (newer glibc), the program
builds with `anchor build --arch v1` instead of the default `v3`, and `compose.yml` runs the `dev`
service with `security_opt: [seccomp:unconfined]` so `solana-test-validator` can start. None of these
change the Rust/Anchor/Agave/Node/pnpm pins above — see `DECISIONS.md` §7, 2026-10-06, for why each
was needed.
