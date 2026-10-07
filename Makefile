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
		(solana-test-validator --quiet --reset --ledger /tmp/test-ledger > /tmp/validator.log 2>&1 &) ; \
		validator_ready=0; \
		for i in $$(seq 1 30); do solana cluster-version -u http://127.0.0.1:8899 >/dev/null 2>&1 && { validator_ready=1; break; }; sleep 1; done; \
		if [ "$$validator_ready" -ne 1 ]; then echo "validator did not come up, see /tmp/validator.log"; cat /tmp/validator.log; exit 1; fi; \
		solana config set --url http://127.0.0.1:8899 >/dev/null; \
		[ -f ~/.config/solana/id.json ] || solana-keygen new --no-bip39-passphrase --silent -o ~/.config/solana/id.json; \
		if ! solana airdrop 2 $$(solana-keygen pubkey ~/.config/solana/id.json) -u http://127.0.0.1:8899 >/dev/null; then echo "airdrop failed, see /tmp/validator.log"; cat /tmp/validator.log; exit 1; fi; \
		if ! anchor deploy --provider.cluster http://127.0.0.1:8899 --provider.wallet ~/.config/solana/id.json; then echo "anchor deploy failed, see /tmp/validator.log"; cat /tmp/validator.log; exit 1; fi; \
		pnpm --filter web run dev -p 3000 > /tmp/web.log 2>&1 & \
		WEB_PID=$$!; \
		web_ready=0; \
		for i in $$(seq 1 30); do curl -sf http://127.0.0.1:3000 >/dev/null 2>&1 && { web_ready=1; break; }; sleep 1; done; \
		if [ "$$web_ready" -ne 1 ]; then echo "web placeholder did not come up, see /tmp/web.log"; cat /tmp/web.log; exit 1; fi; \
		echo "web placeholder serving on :3000"; \
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
		solana-test-validator --quiet --reset --ledger /tmp/test-ledger > /tmp/validator.log 2>&1 & \
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

## test-web: Vitest translation-layer tests + Playwright smoke flows.
test-web: deps
	$(RUN) bash -c 'pnpm --filter web run test'

## shell: open an interactive shell in the dev container.
shell:
	$(RUN) bash

## clean: remove containers, named volumes and local node_modules/.next output.
clean:
	-$(COMPOSE) down -v
	rm -rf node_modules
	rm -rf packages/sdk/node_modules services/automation/node_modules web/node_modules tests/node_modules
	rm -rf web/.next
