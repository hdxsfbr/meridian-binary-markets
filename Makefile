SHELL := /bin/bash

HOST_UID := $(shell id -u)
HOST_GID := $(shell id -g)
export HOST_UID
export HOST_GID

CLUSTER ?= devnet
DEMO_SCALE ?= 1
export CLUSTER
export DEMO_SCALE

COMPOSE := docker compose
RUN := $(COMPOSE) run --rm dev
RUN_PORTS := $(COMPOSE) run --rm --service-ports dev

.PHONY: dev build test-program lifecycle deploy jobs web test-web shell clean deps

## deps: install the pnpm workspace with a frozen lockfile.
deps:
	$(RUN) bash -c 'pnpm install --frozen-lockfile'

## dev: the Wave 0 gate. Build the image, install deps, build the program,
## run program tests on LiteSVM, start a local validator, deploy to it, and
## serve the web placeholder on :3000.
dev:
	mkdir -p keys
	$(COMPOSE) build dev
	$(RUN_PORTS) bash -c '\
		set -euo pipefail; \
		pnpm install --frozen-lockfile; \
		bash scripts/anchor-build.sh; \
		pnpm --filter tests run program; \
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

## test-program: build then run the LiteSVM program test suite.
test-program: build
	$(RUN) bash -c 'pnpm --filter tests run program'

## lifecycle: run the create -> mint -> trade -> settle -> redeem script.
## Wave 0: placeholder only (scripts/lifecycle.ts prints a notice).
lifecycle: deps
	$(RUN) bash -c 'CLUSTER=$(CLUSTER) DEMO_SCALE=$(DEMO_SCALE) pnpm run lifecycle'

## deploy: build and deploy the program to CLUSTER (default devnet; use
## `make dev` for a localnet deploy). Uses /run/keys/admin.json if present,
## otherwise the default Solana CLI wallet.
deploy: build
	$(RUN) bash -c '\
		set -euo pipefail; \
		if [ -f /run/keys/admin.json ]; then WALLET=/run/keys/admin.json; \
		elif [ -f ~/.config/solana/id.json ]; then WALLET=~/.config/solana/id.json; \
		else echo "no wallet found: expected /run/keys/admin.json or ~/.config/solana/id.json"; exit 1; fi; \
		anchor deploy --provider.cluster $(CLUSTER) --provider.wallet $$WALLET \
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
