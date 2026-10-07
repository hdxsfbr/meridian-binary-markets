SHELL := /bin/bash

HOST_UID := $(shell id -u)
HOST_GID := $(shell id -g)
export HOST_UID
export HOST_GID

CLUSTER ?= devnet
DEMO_SCALE ?= 1
export CLUSTER
export DEMO_SCALE

# Extra CLI flags passed through to `scripts/lifecycle.ts`, e.g.
# `make lifecycle LIFECYCLE_ARGS="--close-in 60 --tickers AAPL"`.
LIFECYCLE_ARGS ?=

COMPOSE := docker compose
RUN := $(COMPOSE) run --rm dev
RUN_PORTS := $(COMPOSE) run --rm --service-ports dev

.PHONY: dev build test-program lifecycle deploy init-config jobs web test-web test-integration shell clean deps

## deps: install the pnpm workspace with a frozen lockfile.
deps:
	mkdir -p keys
	$(RUN) bash -c 'pnpm install --frozen-lockfile'

## dev: the Wave 0 gate. Build the image, install deps, build the program,
## run program tests on litesvm (Rust), start a local validator, deploy to
## it, and serve the web placeholder on :3000.
dev:
	mkdir -p keys
	$(COMPOSE) build dev
	$(RUN_PORTS) bash -c '\
		set -euo pipefail; \
		pnpm install --frozen-lockfile; \
		bash scripts/anchor-build.sh; \
		cargo test -p meridian --tests -- --test-threads=1; \
		(solana-test-validator --quiet --reset --limit-ledger-size 100000000 --ledger /tmp/test-ledger > /tmp/validator.log 2>&1 &) ; \
		validator_ready=0; \
		for i in $$(seq 1 30); do solana cluster-version -u http://127.0.0.1:8899 >/dev/null 2>&1 && { validator_ready=1; break; }; sleep 1; done; \
		if [ "$$validator_ready" -ne 1 ]; then echo "validator did not come up, see /tmp/validator.log"; cat /tmp/validator.log; exit 1; fi; \
		solana config set --url http://127.0.0.1:8899 >/dev/null; \
		export CLUSTER=localnet SOLANA_RPC_URL=http://127.0.0.1:8899 ORACLE_PROVIDER=mock DEMO_SCALE=1; unset USDC_MINT PYTH_RECEIVER_PROGRAM; \
		pnpm --filter @meridian/scripts run airdrop -- --create-keys; \
		pnpm --filter @meridian/scripts run deploy -- --skip-build; \
		pnpm --filter @meridian/scripts run init-config; \
		pnpm --filter @meridian/scripts run lifecycle -- --close-in 60; \
		pnpm exec tsx web/e2e/today-market.ts; \
		export NEXT_PUBLIC_E2E='"$(E2E)"' NEXT_ALLOWED_DEV_ORIGINS='"$${PUBLIC_HOST:-127.0.0.1}"' NEXT_PUBLIC_CLUSTER=localnet NEXT_PUBLIC_RPC_URL=http://'"$${PUBLIC_HOST:-127.0.0.1}"':'"$${RPC_PORT:-8899}"' NEXT_PUBLIC_WS_URL=ws://'"$${PUBLIC_HOST:-127.0.0.1}"':'"$${WS_PORT:-8900}"' NEXT_PUBLIC_PROGRAM_ID=$$(solana-keygen pubkey keys/program-keypair.json); \
		pnpm --filter web run dev -p 3000 > /tmp/web.log 2>&1 & \
		WEB_PID=$$!; \
		web_ready=0; \
		for i in $$(seq 1 30); do curl -sf http://127.0.0.1:3000 >/dev/null 2>&1 && { web_ready=1; break; }; sleep 1; done; \
		if [ "$$web_ready" -ne 1 ]; then echo "web app did not come up, see /tmp/web.log"; cat /tmp/web.log; exit 1; fi; \
		echo "web app serving on :3000"; \
		echo "rustc: $$(rustc --version)"; \
		echo "anchor: $$(anchor --version)"; \
		echo "solana: $$(solana --version)"; \
		echo "node: $$(node --version)"; \
		echo "pnpm: $$(pnpm --version)"; \
		wait $$WEB_PID \
	'

## build: install deps and compile the Anchor program only.
build:
	mkdir -p keys
	$(RUN) bash -c 'set -euo pipefail; pnpm install --frozen-lockfile; bash scripts/anchor-build.sh'

## test-program: build then run the Rust/litesvm program test suite
## (programs/meridian/tests/*.rs). Reuses the `target` named volume.
test-program:
	$(RUN) bash -c 'set -euo pipefail; bash scripts/anchor-build.sh && cargo test -p meridian --tests -- --test-threads=1'

## lifecycle: run the create -> mint -> trade -> settle -> redeem demo
## (tasks.md T086) against CLUSTER (default devnet; use CLUSTER=localnet for
## a local-validator run). Pass extra flags via LIFECYCLE_ARGS, e.g.
## `make lifecycle CLUSTER=localnet LIFECYCLE_ARGS="--close-in 60"`.
lifecycle: deps
	$(RUN) bash -c 'CLUSTER=$(CLUSTER) DEMO_SCALE=$(DEMO_SCALE) pnpm --filter @meridian/scripts run lifecycle -- $(LIFECYCLE_ARGS)'

## deploy: build and deploy the program to CLUSTER (default devnet; use
## CLUSTER=localnet for a local-validator deploy). Delegates to
## scripts/deploy.ts (scripts/package.json "deploy"), which runs
## scripts/anchor-build.sh, anchor-deploys, and verifies the deployed
## program id and executable flag. Uses /run/keys/admin.json if present,
## else the default Solana CLI wallet, else the repo-relative keys/admin.json
## written by `airdrop --create-keys` (scripts/lib/keys.ts). Refuses to
## proceed if the RPC endpoint's genesis hash looks like mainnet-beta, or
## disagrees with CLUSTER=devnet (scripts/lib/client.ts).
deploy: deps
	$(RUN) bash -c 'CLUSTER=$(CLUSTER) DEMO_SCALE=$(DEMO_SCALE) pnpm --filter @meridian/scripts run deploy'

## init-config: idempotently create (or print) the on-chain Config
## singleton. Delegates to scripts/init-config.ts.
init-config: deps
	$(RUN) bash -c 'CLUSTER=$(CLUSTER) DEMO_SCALE=$(DEMO_SCALE) pnpm --filter @meridian/scripts run init-config'

## test-integration: starts a fresh local validator, deploys the program,
## initializes Config, and runs the lifecycle integration test
## (tests/integration/lifecycle.test.ts, tasks.md T087) against it end to
## end. Always localnet -- never takes a CLUSTER override. Unsets
## USDC_MINT/PYTH_RECEIVER_PROGRAM (which `.env`'s devnet defaults would
## otherwise leak into this container's environment) so `init-config`
## creates a fresh admin-controlled test mint instead of trying to
## initialize Config against a devnet mint that doesn't exist on this
## validator. Self-contained: the validator is always stopped on exit
## (success or failure) via a trap that kills its captured PID directly --
## not `pkill -f solana-test-validator`, which matches by substring against
## every process's full command line, including this very script's own
## `bash -c '...'` invocation (its argv literally contains the string
## "solana-test-validator" several times over), killing the script itself
## with SIGTERM right as it was about to exit 0.
test-integration: deps
	$(RUN) bash -c '\
		set -euo pipefail; \
		bash scripts/anchor-build.sh; \
		solana-test-validator --quiet --reset --limit-ledger-size 100000000 --ledger /tmp/test-ledger > /tmp/validator.log 2>&1 & \
		VALIDATOR_PID=$$!; \
		trap "kill $$VALIDATOR_PID >/dev/null 2>&1 || true" EXIT; \
		validator_ready=0; \
		for i in $$(seq 1 40); do solana cluster-version -u http://127.0.0.1:8899 >/dev/null 2>&1 && { validator_ready=1; break; }; sleep 1; done; \
		if [ "$$validator_ready" -ne 1 ]; then echo "validator did not come up, see /tmp/validator.log"; cat /tmp/validator.log; exit 1; fi; \
		unset USDC_MINT PYTH_RECEIVER_PROGRAM; \
		export CLUSTER=localnet SOLANA_RPC_URL=http://127.0.0.1:8899 ORACLE_PROVIDER=mock DEMO_SCALE=1; \
		pnpm --filter @meridian/scripts run airdrop -- --create-keys; \
		pnpm --filter @meridian/scripts run deploy; \
		pnpm --filter @meridian/scripts run init-config; \
		pnpm --filter @meridian/tests run integration \
	'

## jobs: start the automation service (cron-driven morning/settle/publisher jobs).
jobs: deps
	$(RUN) bash -c 'pnpm --filter automation run start'

## web: run the Next.js dev server against the cluster configured in .env.
web: deps
	$(COMPOSE) run --rm -p "127.0.0.1:$${WEB_PORT:-3000}:3000" dev bash -c 'pnpm --filter web run dev'

## test-web: Vitest translation-layer tests + Playwright smoke flows
## (tasks.md T066/T075/T080). Self-contained like `test-integration`: builds
## the current image (so a stale image predating the Chromium layer can
## never be reused), installs deps, starts a fresh local validator, deploys
## the program, initializes Config, starts `next dev` directly (not through
## a `pnpm run`/`pnpm --filter` launcher, whose own wrapper process would
## otherwise be the one captured below, leaving the real `next dev` server
## an orphan no trap can reach) against it with the Playwright test wallet
## enabled (`NEXT_PUBLIC_E2E=1`), waits for it to come up (same polling
## pattern `make dev` uses for its own web server), runs Vitest then
## Playwright (whose `globalSetup` seeds the two markets the specs need
## directly against the chain -- see `web/e2e/seed.ts`/`global-setup.ts`),
## and always stops both the validator and `next dev` on exit via a
## `cleanup` function (not a double-quoted `trap "..."` string, which would
## freeze `$WEB_PID` at its empty value from the moment the trap is
## installed -- long before the server is even started -- into the
## registered command; a function reads the live variable at EXIT time
## instead). `next dev` runs under `setsid` so its captured PID is also its
## process group id; cleanup kills that whole group (`kill -- -$WEB_PID`),
## not just the one process, which on its own could still leave child
## processes (e.g. Next's own workers) running. Never `pkill -f
## solana-test-validator`, which would also match this script's own
## `bash -c '...'` argv (see `test-integration`'s comment above for the
## full story).
test-web:
	mkdir -p keys
	$(COMPOSE) build dev
	$(RUN) bash -c '\
		set -euo pipefail; \
		pnpm install --frozen-lockfile; \
		bash scripts/anchor-build.sh; \
		solana-test-validator --quiet --reset --limit-ledger-size 100000000 --ledger /tmp/test-ledger > /tmp/validator.log 2>&1 & \
		VALIDATOR_PID=$$!; \
		WEB_PID=""; \
		cleanup() { [ -n "$$WEB_PID" ] && kill -- "-$$WEB_PID" >/dev/null 2>&1; kill "$$VALIDATOR_PID" >/dev/null 2>&1 || true; }; \
		trap cleanup EXIT; \
		validator_ready=0; \
		for i in $$(seq 1 40); do solana cluster-version -u http://127.0.0.1:8899 >/dev/null 2>&1 && { validator_ready=1; break; }; sleep 1; done; \
		if [ "$$validator_ready" -ne 1 ]; then echo "validator did not come up, see /tmp/validator.log"; cat /tmp/validator.log; exit 1; fi; \
		unset USDC_MINT PYTH_RECEIVER_PROGRAM; \
		export CLUSTER=localnet SOLANA_RPC_URL=http://127.0.0.1:8899 ORACLE_PROVIDER=mock DEMO_SCALE=1; \
		pnpm --filter @meridian/scripts run airdrop -- --create-keys; \
		pnpm --filter @meridian/scripts run deploy; \
		pnpm --filter @meridian/scripts run init-config; \
		MERIDIAN_PROGRAM_ID=$$(sed -n "s/.*PROGRAM_ID_BASE58 = \"\\(.*\\)\";/\\1/p" packages/sdk/src/program-id.ts); \
		NEXT_PUBLIC_E2E=1 NEXT_PUBLIC_CLUSTER=localnet NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8899 NEXT_PUBLIC_WS_URL=ws://127.0.0.1:8900 NEXT_PUBLIC_PROGRAM_ID=$$MERIDIAN_PROGRAM_ID \
			setsid pnpm --filter @meridian/web exec next dev -p 3000 > /tmp/web.log 2>&1 & \
		WEB_PID=$$!; \
		web_ready=0; \
		for i in $$(seq 1 60); do curl -sf http://127.0.0.1:3000 >/dev/null 2>&1 && { web_ready=1; break; }; sleep 1; done; \
		if [ "$$web_ready" -ne 1 ]; then echo "web server did not come up, see /tmp/web.log"; cat /tmp/web.log; exit 1; fi; \
		pnpm --filter @meridian/web run test; \
		pnpm --filter @meridian/web run test:e2e \
	'

## shell: open an interactive shell in the dev container.
shell:
	$(RUN) bash

## clean: remove containers, named volumes and local node_modules/.next output.
clean:
	-$(COMPOSE) down -v
	rm -rf node_modules
	rm -rf packages/sdk/node_modules services/automation/node_modules web/node_modules tests/node_modules
	rm -rf web/.next
