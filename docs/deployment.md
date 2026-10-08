# Deployment guide

> **Draft status.** This is a Wave 6 draft, to be finalized in Wave 8 after the Wave 7 devnet
> deployment run. The "Recorded addresses" table below is left empty on purpose — fill it in once
> that run happens, and do not predict its contents here.

Everything in this guide runs inside the pinned dev container (`make dev`, `make shell`, or any
`make` target that shells out to `docker compose run`). Nothing needs to be installed on the host
except Docker, Compose ≥ 2.24, Make, and Bash. See `README.md` for the one-command `make dev` path
this guide expands on.

## 1. Devnet deploy, step by step

All commands below assume `CLUSTER=devnet` (the Makefile default) and run from the repo root.

### 1.1 Get SOL — budget for deploy plus the lifecycle, not just two airdrops

Run every command below inside the dev container — either open an interactive shell with
`make shell` and run them there, or prefix each one with `docker compose run --rm dev bash -c
'<command>'`. None of these need, or should use, host-installed `pnpm`/Node/Solana tooling.

**Deploy needs much more than one or two airdrops.** The compiled program binary is about
**615 KB**. Deploying a program that size needs rent for its program-data account — roughly
**3.1 SOL** at exactly that size, or up to **~4.3 SOL** once the deploy tool's own buffer-sizing
overhead is included — **plus** a temporary *buffer* account of similar size that briefly holds
the binary during the upload (its rent is refunded to the deployer once the buffer closes, but it
has to exist, funded, during the deploy). Budget **~7–9 SOL for the deployer wallet** to get
through a single `make deploy` comfortably; the devnet faucet caps a single request at roughly
2 SOL, so that is **three to five separate airdrop requests**, or request manually from
`https://faucet.solana.com`'s web form (which is not subject to the CLI's per-request cap in the
same way). Query the current exact figure yourself rather than trusting a stale number here:

```
pnpm --filter @meridian/scripts run rent-estimate
```

prints `getMinimumBalanceForRentExemption` results for every account this system creates,
including the program-data account at the binary's actual current size.

On top of the deploy budget, a full day's demo lifecycle (seven tickers, full strike ladder,
16-order-per-side books) separately costs on the order of **1.25 SOL** in market/book/vault rent
at demo scale (DECISIONS.md §6, research.md R7) — most of which comes back via `close_book`/
`close_market` once markets settle, except for the two SPL mints every market permanently retains
(see `docs/architecture.md` §7). Fund the deployer first, finish `make deploy` and
`make init-config`, confirm the buffer rent came back, *then* airdrop again for the lifecycle run
— trying to cover both in one up-front guess is how reviewers end up short mid-deploy.

```
pnpm --filter @meridian/scripts run airdrop
```

repeat as needed, checking the balance after each request (`solana balance -u devnet <pubkey>`).
If a request is rate-limited, wait and retry, or use `https://faucet.solana.com` manually (see
Troubleshooting).

**Generating devnet signers.** `scripts/airdrop.ts --create-keys` only works on `CLUSTER=localnet`
— it refuses to run on devnet by design, since silently generating a brand-new admin/publisher
keypair on a real cluster is rarely what you want. On devnet, generate each signer yourself inside
the container:

```
make shell
solana-keygen new --no-bip39-passphrase -o keys/admin.json
solana-keygen new --no-bip39-passphrase -o keys/publisher.json
```

`keys/` is repo-relative and gitignored. Point `ADMIN_KEYPAIR_PATH`/`PUBLISHER_KEYPAIR_PATH` in
`.env` at these files (or the mounted `/run/keys/` path if you're supplying keys from outside the
repo), then airdrop to each public key printed by `solana-keygen new` as above.

### 1.2 Deploy the program

```
make deploy CLUSTER=devnet
```

This builds the program (`scripts/anchor-build.sh`, `--arch v1` — see `README.md` Toolchain and
`DECISIONS.md` §7 for why), `anchor deploy`s it to devnet, and verifies the deployed program ID
matches `@meridian/sdk`'s `PROGRAM_ID` and that the resulting account is executable.

**Size cap note:** the compiled program binary is roughly **615 KB** (measured via
`scripts/anchor-build.sh`; it will drift slightly as the program changes, hence "roughly"). This
is the reason §1.1 above budgets several airdrops rather than one or two — see that section for
the actual rent figures and why a temporary buffer account, not just the final program-data
account, needs to be funded during the deploy. `make deploy` refuses to proceed if the configured
RPC endpoint's genesis hash looks like mainnet-beta, or disagrees with `CLUSTER=devnet`
(`scripts/lib/client.ts`).

### 1.3 Initialize the on-chain config, with Circle USDC

```
make init-config CLUSTER=devnet
```

Idempotent: if `Config` already exists, this prints it and exits 0 rather than erroring. On a
fresh deploy it creates `Config` with:

- the oracle provider from `ORACLE_PROVIDER` (`mock` by default — see §3 below for switching to
  Pyth),
- the publisher key from `PUBLISHER_KEYPAIR_PATH`,
- staleness/confidence/publish-offset/override-delay thresholds (300 s / 25 bps / 60 s / 3600 s),
- the listed tickers with their `Equity.US` feed IDs (default `TSLA,QQQ,VOO`, the feeds the
  project's Pyth key is entitled to; override with `-- --tickers A,B,C`, and change later with
  `init-config -- --update --tickers ...` as more feeds are granted),
- book capacity 16 (`DEMO_SCALE=1`, the default) or 128 (`DEMO_SCALE=0`),
- the USDC mint from `USDC_MINT` — **Circle's devnet USDC**, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`,
  by default. Get test USDC into your own wallet from `https://faucet.circle.com` to follow along
  in the browser.

### 1.4 Run the lifecycle, at demo scale

`scripts/lifecycle.ts` is implemented and is the one command that drives the full create → mint →
trade → settle → redeem sequence end to end (tasks.md T086):

```
make lifecycle CLUSTER=devnet LIFECYCLE_ARGS="--close-in <seconds>"
```

`LIFECYCLE_ARGS` passes flags through to the script; `CLUSTER` and `DEMO_SCALE` are Make
variables, not part of `LIFECYCLE_ARGS`. **`--close-in <seconds>` is mandatory on
`CLUSTER=devnet`** — the script throws immediately if it's missing, rather than picking a
default close time on a real cluster. (On `CLUSTER=localnet` it defaults to 90 seconds if
omitted.) A full run example:

```
make lifecycle CLUSTER=devnet DEMO_SCALE=1 LIFECYCLE_ARGS="--close-in 120"
```

On devnet the two demo wallets must already be funded: **A (`keys/user-a.json`) at least 25 USDC,
B (`keys/user-b.json`) at least 10 USDC, and 0.1 SOL each**; the script prints their addresses
and stops if they aren't. Get the USDC from `https://faucet.circle.com` (Solana devnet, 20 USDC per
request, one request per address every two hours, no login) and the
SOL by a small transfer from the admin wallet. On localnet the script mints 1,000 test USDC each.

The public devnet RPC (`api.devnet.solana.com`) rate-limits bursts of the same call. The script
probes a day's planned markets with one batched `getMultipleAccounts` call and, on devnet, pauses
750 ms between on-chain steps. Even so, a full seven-ticker run is roughly 150 transactions (the
default three-ticker set is about 60); if
the run dies with `429 Too Many Requests`, rerun with `--tickers` for a subset or point
`SOLANA_RPC_URL` at a private devnet endpoint. Choose `--close-in` so trading finishes before the
close: at about 3 s per transaction on devnet, allow at least 300 s for one ticker and 600 s for
the full ladder.

Runs the ladder for every listed ticker (5–7 strikes each; ~21 markets for the default three,
~45 for seven) at book capacity 16 (see
§1.1 for the rent this costs). `DEMO_SCALE=0` uses the production default (capacity 128, ~5.8
SOL/day) and is not expected to fit a reviewer's faucet allowance in one sitting.

**Funding is preflighted, not discovered mid-run.** Before creating a single market, the script
checks the admin keypair's SOL balance, the publisher keypair's SOL balance, and both demo users'
(A and B) SOL and USDC balances against what the run actually needs; on devnet, if anything is
short, it prints the exact public keys and exact amounts still needed and exits before spending
anything, rather than paying to create part of the ladder and failing partway through on an
underfunded wallet. Fund whatever it reports, then rerun the same command.

The same create → mint → trade → settle → redeem sequence can also be driven step by step through
the automation service's CLI, which is useful for rehearsing one stage at a time instead of the
full scripted run:

```
pnpm --filter automation run job morning --day <YYYYMMDD> --close-in <seconds> --force
pnpm --filter automation run job publisher --once
pnpm --filter automation run job settle --once --day <YYYYMMDD>
```

Run these inside `make shell` or via `docker compose run --rm dev bash -c '...'` — see §1.1.
`--close-in <seconds>` sets a synthetic `close_ts = now + seconds` instead of the real 16:00 ET
close, and `--force` allows a non-trading-day to be used for the demo. `--close-in` is only
accepted together with an explicit `--day`, and never on the real current trading day — the
`morning` job rejects both cases outright. `--day` on the `settle` job tells it which trading
day's markets to settle; omit it to settle the real current trading day instead. See
`docs/demo-script.md` for the full walkthrough that uses both paths.

### 1.5 Start the jobs

```
make jobs
```

Starts the automation service's cron schedule: morning markets at 08:00 ET, settlement starting
16:00:30 ET, the mock publisher ticking every 60 s from 09:25–16:10 ET, and rent reclamation at
20:00 ET. The service refuses to start if `ORACLE_PROVIDER` disagrees with the on-chain
`Config.oracle_provider`.

## 2. Recorded addresses (devnet, 2026-10-07)

| Item | Value |
| --- | --- |
| Program ID | `3XQgqYNXPeZr5o2NUmnuPm9hk5mPrZpiEsFE62pjVkBn` ([explorer](https://explorer.solana.com/address/3XQgqYNXPeZr5o2NUmnuPm9hk5mPrZpiEsFE62pjVkBn?cluster=devnet)) |
| Program-data account / deploy slot | `BUuEp86cxiEjMEtEGtHgnv6P7KPqXLgmAjVxnYebRmUj`; first deploy slot 508626847; upgraded 2026-10-08 twice (close-time and crossing guards; one-to-seven listed tickers), 623,328 bytes, 3.167 SOL rent |
| Upgrade authority (admin) | `3i2UN14eCEzLG7HvhgyWUFcN19zdbURj8s78QF6RBZPH` |
| Config PDA | `74KKVVK4kx3xcGng91ULZKzcwqX6mo1EDw7J1KmSMnQR` (provider `pythReceiver` since 2026-10-08, tickers TSLA/QQQ/VOO, capacity 16, override delay 3600 s) |
| Publisher | `HDBdqW1XzfCNZXdexLKiVw95B5HUDd3sYp8tX9ijnKRa` |
| USDC mint used | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (Circle devnet USDC) |
| First full lifecycle | trading day 20261011 (synthetic), AAPL ladder of 7 markets, settled at $335.00, maker +1.00 / taker −1.00 USDC, vault 0 |
| Sample market (AAPL $330, traded) | `FxinHA2BdBaxZj5Pq6rtXvW23jnXQTxp5FJYMNJScrpM` |
| Mock price account (AAPL) | `8xC1riDPLd1kDyVSjs8DLBZHY9VSLzncLmTW3mvgSfwP` |
| First Pyth-settled day | 2026-10-08: the `settle` job (run at 16:00:40 ET) posted each ticker's Hermes closing update to the devnet receiver and settled all 46 listed markets by 16:00:52 ET, no override. Closes: AAPL 340.62, MSFT 523.00, GOOGL 348.42, AMZN 254.25, NVDA 230.65, META 721.17, TSLA 374.56. Sample settled market: `3M8tE45eg8RJJeTMm3vwVBYTcK7ADXdydtVErLWs1kes` (AAPL $330, Yes). The delisted QQQ/VOO ladders were override-settled at their Pyth closes after the one-hour delay. |
| Public web app | `https://web-production-385a5.up.railway.app` (Railway; automation worker on the same project) |
| Deploy date / cluster genesis hash | 2026-10-07 / `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |

Anchor's optional on-chain IDL upload (`Writing metadata account…`) failed after the program
itself deployed; nothing reads it, since the web app and scripts bundle the IDL from
`packages/sdk/src/idl.ts`. Two earlier lifecycle attempts on the public devnet RPC were cut short
by rate limiting after creating 19 and 21 markets respectively (trading days 20261009 and
20261010). Those 40 markets were settled by `admin_settle_override` once their delay elapsed and,
with the day's 7 settled lifecycle markets, closed by the automation `reclaim` job
(`automation job reclaim --all-settled`), returning about 0.8 SOL of rent. The pacing and batched
probe described in §1.4 came out of those runs. The browser RPC is a Helius free-tier devnet
endpoint (see §5).

**Why this table, and not `declare_id!` in `programs/meridian/src/lib.rs`, is the source of
truth.** The program's keypair (`target/deploy/meridian-keypair.json`) is generated locally by
`anchor build`/`scripts/anchor-build.sh` and is gitignored — it is never committed. The program ID
committed in source (`declare_id!`, mirrored into `@meridian/sdk`'s `PROGRAM_ID`) is whatever
address that locally generated keypair happened to produce the last time someone ran a build and
hand-synced the constant; a different machine, or a regenerated keypair, deploys to a different
address unless that keypair file is deliberately kept and reused. `make deploy` verifies the
address it actually deployed to matches the SDK's compiled-in `PROGRAM_ID` and fails loudly on a
mismatch, so a successful deploy means the two agree *for that run* — but a reviewer checking this
document against a live devnet program should always take the address from the row above, filled
in after the actual Wave 7 run, rather than reading `declare_id!` out of source and assuming it is
still current.

## 3. Switching the oracle provider to Pyth

Once the Pyth Pro equity entitlement grant lands (see `docs/risks-and-limitations.md` — the API
key is active today but the equity feeds return `403 Not entitled` until the grant is approved),
switch the live config without redeploying the program:

```
pnpm --filter @meridian/scripts run init-config -- --update --provider pyth
```

This sends `update_config` with the provider field changed; it does not touch the program binary
or any market already created. Verify the switch took effect by reading `Config.oracle_provider`
back (`init-config` without `--update` prints the current config). The automation service checks
`ORACLE_PROVIDER` against the on-chain value at startup and refuses to run on a mismatch, so update
`.env`'s `ORACLE_PROVIDER=pyth` alongside the on-chain switch.

This wave's actual proof of the real Pyth path is narrower than full equities, and narrower than
an on-chain post: it fetches the real BTC/USD crypto feed from Hermes (no equity entitlement
needed), but the one attempt to post that update to the devnet receiver program failed on a
devnet faucet `429` for the publisher key, so nothing was actually posted or verified on chain
this wave. What did get exercised is the account layout and guard chain against a fixture built
locally from that real Hermes observation — see `docs/risks-and-limitations.md` §2 for exactly
what that does and does not prove, and why the on-chain post itself is tracked for Wave 7.

## 4. Localnet equivalent

Everything above has a `localnet` counterpart that needs no faucet and no Circle USDC:

```
make deploy CLUSTER=localnet
make init-config CLUSTER=localnet
make lifecycle CLUSTER=localnet
```

`scripts/airdrop.ts --create-keys` generates admin/publisher keypairs on disk automatically on
localnet, and `init-config` creates a fresh 6-decimal test USDC mint with unlimited supply when
`USDC_MINT` is unset, rather than requiring Circle's devnet mint. `make dev` runs this path
end-to-end against a freshly started `solana-test-validator` as its gate.

## 5. Troubleshooting

**A port is already bound on the host.** `WEB_PORT`, `RPC_PORT`, `WS_PORT`, and `STATUS_PORT` in
`.env` are the host-side bindings for the web app, the validator RPC, its websocket, and the
automation status endpoint, respectively. If `make web` or `make dev` fails to bind a port, set
the corresponding variable to a free one and rerun — nothing else needs to change.

**Devnet faucet rate limit.** `scripts/airdrop.ts` catches and reports a devnet rate-limit error
rather than retrying silently; wait a few minutes, or request SOL manually from
`https://faucet.solana.com`. This is why §1.1 above asks for several separate requests rather than
one larger one — a single request above roughly 2 SOL is rejected outright, and the deploy budget
in §1.1 needs several requests regardless.

**`solana-test-validator` aborts on startup inside the container.** The validator calls
`io_uring_supported()` and aborts under Docker's default seccomp profile on some hosts. `compose.yml`
already sets `security_opt: [seccomp:unconfined]` on the `dev` service for this reason — if you're
running outside the provided `compose.yml` (e.g. a custom CI runner), the same flag is needed there.

**`anchor build` fails to load under the test harness.** Builds must use `--arch v1`
(`scripts/anchor-build.sh` already does this); the default `--arch v3` output is not accepted by
the `litesvm` 0.12.0 loader the program tests run against. See `DECISIONS.md` §7 if you hit this
while building manually outside the provided scripts.

**A browser wallet will not connect to the local stack, or sends fail with "Unexpected error".**
Phantom's Localnet mode is hard-wired to `localhost:8899` and only connects on `localhost` or HTTPS
origins, so a stack reached via a LAN hostname (`http://my-box:3000`) shows "connecting" forever.
Tunnel the three ports to the laptop (`ssh -N -L 3000:localhost:3000 -L 8899:localhost:8899
-L 8900:localhost:8900 <host>`) and open `http://localhost:3000`. Phantom also cannot simulate or
broadcast transactions on Localnet; the web app therefore simulates through its own RPC connection,
asks the wallet only to sign, and broadcasts itself, so a program refusal surfaces as the program's
message rather than a wallet error. Solflare with a custom RPC of `http://127.0.0.1:8899` avoids the
tunnel when the stack runs on the same machine. Fund the wallet with
`pnpm --filter @meridian/scripts run fund-wallet -- <pubkey>` from `make shell` (localnet only).

**Portfolio shows a $0.00 cost basis after a few minutes on localnet.** `solana-test-validator`
prunes transaction history after 10,000 shreds by default, and cost basis is derived from
history. Every validator start in the `Makefile` passes `--limit-ledger-size 100000000`; if you
start one by hand, pass the same flag.

**Pages show "Retrying…" or the browser console fills with `429`.** The public devnet RPC
(`api.devnet.solana.com`) allows 40 calls per method per 10 s per IP, and a wallet with history
exceeds that on first load. Put a free private endpoint (Alchemy, QuickNode and Helius all have
free tiers that cover Solana devnet) in `.env` as `NEXT_PUBLIC_RPC_URL`/`NEXT_PUBLIC_WS_URL` for
the browser and `SOLANA_RPC_URL`/`SOLANA_WS_URL` for scripts and the service, then rebuild the web
app. The browser key is visible to anyone using the site, so restrict it to your origin in the
provider's dashboard and keep it devnet-only.

**The automation service refuses to start with "ALERT_WEBHOOK_URL must use the http: or https:
scheme" (or a similar complaint about a variable you left blank).** Docker Compose keeps an
inline `# comment` as the value when the value before it is empty, so `KEY=   # note` arrives as
`KEY="# note"`. `.env.example` now puts comments for blank-by-default keys on their own line; if
you copied an older version, delete the trailing comment on any blank line in your `.env`.

**Admin page shows "Status unavailable".** That column reads the automation service's status
endpoint (`NEXT_PUBLIC_AUTOMATION_STATUS_URL`). `make dev` does not start the service; run
`make jobs` in a second terminal, or ignore the column when only the web app is under test.

**First-caller-becomes-admin on `initialize_config`.** There is no check restricting who may call
`initialize_config` first. `make deploy` only deploys and verifies the program — it does **not**
call `initialize_config` for you. Run `make init-config` immediately afterward (§1.3); the window
between the deploy transaction landing and that second command actually running is exactly the
window a racing caller could exploit. See `docs/risks-and-limitations.md` §5 for the full
discussion of this risk and why it is accepted rather than fixed in code this wave.

## 6. Hosting on Railway (public URL and unattended automation)

Project `meridian-binary-markets` on Railway, one environment (`production`), two services built
from this repo with `railway up` (the upload honours `.gitignore` and `.railwayignore`, so `keys/`
and `.env` never leave the machine):

| Service | Image | Start | Public |
| --- | --- | --- | --- |
| `web` | `deploy/web.Dockerfile` (`RAILWAY_DOCKERFILE_PATH`) | `next start` on `$PORT` | `https://web-production-385a5.up.railway.app` |
| `automation` | `deploy/automation.Dockerfile` | `automation start` (cron: morning 08:00, settle 16:00:30, publisher, reclaim 20:00 ET) | status endpoint on `$PORT` at `/status` |

Variables, set with `railway variable set --service <name>`:

- **web:** `NEXT_PUBLIC_CLUSTER=devnet`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_WS_URL` (a private
  devnet RPC; the public one rate-limits the browser), `NEXT_PUBLIC_PROGRAM_ID`,
  `NEXT_PUBLIC_USDC_MINT`, `NEXT_PUBLIC_RPC_TX_FETCH_SPACING_MS=200`,
  `NEXT_PUBLIC_AUTOMATION_STATUS_URL=https://<automation domain>/status`, `PYTH_HERMES_URL`,
  `PYTH_API_KEY` (server side only; it feeds `/api/prices`). The `NEXT_PUBLIC_*` values are baked
  in at image build time, so changing one needs a redeploy.
- **automation:** `SOLANA_CLUSTER=devnet`, `SOLANA_RPC_URL`, `SOLANA_WS_URL`,
  `ADMIN_KEYPAIR_JSON`, `PUBLISHER_KEYPAIR_JSON` (the keypair files' JSON byte arrays; see
  `services/automation/src/keys.ts`), `USDC_MINT`, `ORACLE_PROVIDER=pyth`, `PYTH_HERMES_URL`,
  `PYTH_API_KEY`, `PYTH_RECEIVER_PROGRAM`, `DEMO_SCALE=1`, `PORT=8787` and
  `AUTOMATION_STATUS_PORT=8787` (Railway does not define `PORT` for a Dockerfile service on its
  own; a `${{PORT}}` reference resolves to an empty string), `WEB_ORIGIN=https://<web domain>`,
  `ALERT_WEBHOOK_URL` (Slack).

The worker signs with the admin and publisher keys, so those live as Railway variables. That is
acceptable for a devnet demo and is called out in `risks-and-limitations.md`; for anything with
real funds the signer would move to a KMS-backed or hardware-held key.

Railway's log viewer did not surface the worker's one-line JSON startup error on first deploy
(a missing `DEMO_SCALE`); building the image locally and running it with the same variables showed
it immediately. Keep that as the first debugging step for a worker that restarts in a loop.
