Operational scripts (deploy, init-config, lifecycle, airdrop, rent-estimate) run inside the dev
container via `make` targets; none are installed on the host. Each reads its configuration from
`CLUSTER` (`localnet` | `devnet`) plus the rest of `.env.example`'s script-facing variables
(`SOLANA_RPC_URL`, `ADMIN_KEYPAIR_PATH`, `PUBLISHER_KEYPAIR_PATH`, `USDC_MINT`, `ORACLE_PROVIDER`,
`DEMO_SCALE`, `PYTH_RECEIVER_PROGRAM`); see `scripts/lib/env.ts`.

**`rent-estimate.ts`** — `pnpm --filter @meridian/scripts run rent-estimate [-- --json]`. Prints
`getMinimumBalanceForRentExemption` for a Market account, a Book at both the
demo-scale (16) and default (128) per-side capacities, one SPL mint, and one token account, then
per-market and per-day totals (45 markets/day, research.md R4) at both book capacities. `--json`
prints the same numbers as JSON instead of a table.

**`airdrop.ts`** — `pnpm --filter @meridian/scripts run airdrop [-- --to <pubkey>] [-- --create-keys]`.
Requests 2 SOL for the admin keypair (or `--to <pubkey>`). On `localnet` this always succeeds;
on `devnet` a faucet rate-limit is caught and reported with a pointer to `https://faucet.solana.com`
as the manual fallback. `--create-keys` (localnet only) generates the admin/publisher keypairs on
disk first if they don't exist yet -- always under the writable, gitignored repo-relative `keys/`
directory (`keys/admin.json`, `keys/publisher.json`), never at `/run/keys` (`compose.yml` mounts
that read-only). Every script's read path still falls back through `/run/keys/<name>.json` ->
(admin only) the Solana CLI's default wallet -> `keys/<name>.json`, so a key created by
`--create-keys` is picked up automatically on the next run without any env change. Created key
files are written mode `0600`, inside a `keys/` directory mode `0700`.

All scripts also refuse to proceed if the configured `SOLANA_RPC_URL`'s genesis hash indicates
mainnet-beta (unconditionally refused), or disagrees with `CLUSTER=devnet` (`lib/client.ts`'s
`assertGenesisHash`), checked once before any transaction.

**`deploy.ts`** — `make deploy CLUSTER=<localnet|devnet>` / `pnpm --filter @meridian/scripts run
deploy [-- --skip-build]`. Runs `scripts/anchor-build.sh` (builds the program and regenerates the
SDK's IDL/program id), then `anchor deploy`s to `CLUSTER`, and verifies the deployed program id
matches `@meridian/sdk`'s `PROGRAM_ID` and that the resulting on-chain account is executable.
`--skip-build` deploys the existing `target/deploy` build without rebuilding.

**`init-config.ts`** — `make init-config` / `pnpm --filter @meridian/scripts run init-config [--
--update [--provider mock|pyth] [--capacity N] [--paused|--no-paused]]`. Idempotent: if `Config`
already exists and `--update` was not given, prints it and exits 0. Otherwise creates `Config` via
`initialize_config` with the oracle provider/program from `ORACLE_PROVIDER`, the publisher from
`PUBLISHER_KEYPAIR_PATH`, thresholds 300s staleness / 25 bps confidence / 60s publish offset / 3600s
override delay, the seven tickers with their `Equity.US` feed ids, book capacity 16 (`DEMO_SCALE=1`)
or 128, and the USDC mint from `USDC_MINT` (devnet: required, must be 6 decimals) or a freshly
created 6-decimal test mint (localnet, when `USDC_MINT` is unset). `--update` instead sends
`update_config` with only the fields implied by `--provider`/`--capacity`, plus `pause`/`unpause`
for `--paused`/`--no-paused`.

**`lifecycle.ts`** — see `make lifecycle`; owned by a separate task (tasks.md Phase 9).

**`lib/env.ts`**, **`lib/keys.ts`**, **`lib/client.ts`** — shared helpers (env parsing, keypair
loading/creation, `Connection`/Anchor `Program`/SPL-token plumbing) used by every script above.
