# Key Decisions

A running log of the decisions made on this project, kept as they happen (not reconstructed
afterward). Feeds directly into the "clear rationale for all architecture and chain decisions;
trade-offs explained" deliverable the partner grades.

---

## 1. Adopt spec-kit for spec-driven development

**Date:** 2026-10-05
**Context:** Same approach as the sibling Cerbo partner project. Meridian is graded on documented
rationale and reproducibility, and spec-kit's artifacts (constitution, spec, plan, tasks) double as
that documentation. The project is also large enough — on-chain program, automation service and
frontend — that an explicit dependency-ordered task breakdown is worth the ceremony.
**Decision:** Initialized spec-kit 1.1.1.dev0 with the Claude Code integration (`specify init
--here --integration claude --script sh`). Workflow: /speckit-constitution → /speckit-specify (fed
from `docs/PRD.md`) → /speckit-plan → /speckit-tasks → /speckit-implement. Generated artifacts are
pruned by hand, not accepted verbatim.
**Trade-off:** Process overhead, and the generated spec overlaps the hand-written PRD — resolved by
having the spec reference PRD requirement IDs rather than duplicate the content. In exchange we get
traceability from partner requirement → spec requirement → task → commit.

## 2. Write a PRD first, from the brief plus the attached PDF

**Date:** 2026-10-05
**Context:** The portal brief and the attached `Gauntlet Project - Meridian.pdf` differ
substantially in depth. The PDF carries the material the portal summary omits: the at-or-above tie
rule, the one-book/four-trade-path model, the strike deduplication behaviour, the 0DTE framing, the
8:00/8:30/9:00 lifecycle breakdown, and the devnet requirement.
**Decision:** Merge both into `docs/PRD.md` with numbered requirements FR-1…FR-10, and treat the
PDF as authoritative wherever it is more specific. The PDF itself is committed at
`docs/Gauntlet-Project-Meridian.pdf`.
**Trade-off:** A hand-written PRD is work the spec-kit flow does not require, but it gives a single
traceable requirement set that both the spec and commit messages can reference. Nothing in the two
sources actually conflicts, so no reconciliation judgment was needed.

## 3. Solana + Anchor, not an EVM L2

**Date:** 2026-10-05
**Context:** The brief allows Solana, an EVM L2 (Arbitrum, Base), or HyperLiquid. Solana is named
as recommended; Rust is a listed required language; and the brief states that if Solana is chosen,
**devnet deployment is required to pass**. The brief also warns that EVM chains "may introduce
latency challenges for on-chain order book performance", and that HyperLiquid may not natively
support this instrument.
**Decision:** Solana with Rust and the Anchor framework. TypeScript/React/Next.js frontend,
TypeScript/Node.js automation service.
**Trade-off:** Anchor and the Solana account model carry a steeper ramp than Solidity, and
devnet-only means no mainnet-grade liquidity to demo against. Against that: sub-second finality
comes free, the chain is what the partner asked for, and PEAK6 Labs builds in this space — work on
their recommended chain is directly legible to the reviewer. Choosing an L2 would have meant
spending part of the submission justifying a choice the brief already discouraged.

## 4. Oracle: Pyth behind a provider interface — mocked today, real when the Pyth Pro token arrives

**Date:** 2026-10-06 (supersedes the RedStone position of 2026-10-05, kept below as history)
**Evidence:** [`docs/spikes/2026-10-05-pyth-devnet.md`](docs/spikes/2026-10-05-pyth-devnet.md) — all
quantitative claims there are reproducible from the recorded calls.
**Context:** The brief requires an oracle that supplies the previous day's close (for the morning
strike ladder) and the day's close at 4:00 PM ET (for settlement), is readable on-chain during the
settlement transaction, and supports both a **staleness check** and a **confidence/quality check**.
The choice must be justified. Stock prices are licensed data: during 2026 Pyth moved US equities onto
paid plans, Switchboard ceased operations, and RedStone is the only network still serving MAG7 feeds
free on Solana devnet. Two days of research on that landscape is in the spike.

**Decision — two parts, and the first matters more than the second.**

**(a) The oracle sits behind a provider interface:** *return a price with a publish timestamp and a
confidence measure, or refuse.* The program applies four guards to whatever comes back — staleness
under 5 minutes, confidence/quality, publisher attestation, and fail-closed on any failure. Config
names the active provider and its program ID; switching provider is an admin config change plus a
service restart, never a program rewrite. This is the load-bearing decision. It has now survived four
changes of price source without the spec or the architecture moving, and Constitution Principle IV
deliberately names no vendor for that reason.

**(b) The target source is Pyth, and we build against a Pyth-shaped mock until the token arrives.**

| Provider | Role | Status |
|---|---|---|
| `PythReceiver` | Target. Reads a `PriceUpdateV2` account posted to Pyth's devnet receiver program from a Hermes update | Blocked only on a Pyth Pro token for equity feeds. Pyth grants equity access to Gauntlet participants on request via its developer forum: a peer was approved within ~3 hours on 2026-10-06, and Andre's request is pending. Treated as arriving |
| `MockPyth` | Development and demo provider. Our automation service posts an account with the **same fields** (`feed_id`, `price`, `conf`, `expo`, `publish_time`), signed by an allowlisted publisher key, from a free stock API | Built first. Devnet-only by config; refused on any other cluster |
| `RedStone` / other | Plug-in if Pyth Pro falls through | Not built. The spike's RedStone findings stay valid and are the next candidate |

**Why Pyth, given yesterday's rejection.** The rejection was on *cost*, not capability, and the cost
may be covered by a token we do not pay for. With that removed, Pyth is the better engineering choice:
`pyth-solana-receiver-sdk` is published on crates.io and current (v2.0.0); the receiver program is
permissionless on devnet, so our service posts the Hermes update itself; the price account natively
carries a **confidence interval**, so the confidence guard reads a publisher-supplied value instead of
the cross-source comparison RedStone forced; and the brief's own author named Pyth. RedStone's SDK is
an unpublished, zero-star git dependency, its devnet program ID did not match its source, and its
on-chain account stores only a median (see history below). RedStone was the right answer to "free and
live today"; it is the wrong amount of integration risk if Pyth becomes available.

**Why a mock, and why it is not a cheat.** The mock is the fallback publisher Principle IV requires
anyway, wearing Pyth's account layout. The program reads mock and real accounts through the same
provider interface and applies the same four guards; tests for stale, wide-confidence and unattested
prices run against the mock and are unchanged when the real provider lands. What the mock cannot prove
is that the *real* receiver layout parses and that a *real* equity update passes the guards; that is a
single integration task, done the day the token arrives, and it is listed as such in the risks note.
The mock MUST NOT be enabled outside devnet, and the product UI never describes it (per the global
rule on implementation commentary; the oracle status view names the active provider as a diagnostic).

**Trade-off.** Until the token arrives, the demo settles on a price our own service signed. Disclosed
in the risks note, as Principle IV demands of any trust model weaker than a production network. If no
token arrives by implementation's end, the fallback plan is RedStone behind the same interface, and
the mock remains the tested fallback either way.

**Confidence band, decided 2026-10-06 in planning.** `max_conf_bps = 25`. The spike showed independent
sources agreeing on the close to the cent, so a 1% band would never trip and the guard would be
decorative, which Principle IV forbids. 25 bps is still loose for a normal day and tight enough to catch a
broken feed. Revisited with real Pyth `conf` values on the probe day; a change is logged here.

**What the plan must settle.** Which Pyth feed ID carries the regular-session close for each ticker
(Pyth publishes separate equity feeds; the spike's AAPL readings showed the base feed differing from the
official 4:00 PM print); the receiver program ID and account layout on devnet, confirmed by RPC not
docs; and the Hermes endpoint and auth header shape for Pyth Pro, so the swap is a config change.

---

**History — RedStone position, 2026-10-05, superseded the next day.** Kept because the evidence is
real and RedStone is the named plug-in if Pyth falls through.

RedStone's devnet program `REDuYsnEucMweattdv4xQCYdU1i8Q2W92kdayrpY9rA` was verified executable and
actively fed; all seven MAG7 exist in its 996-feed production package with regular-session, 24/7,
extended and pre/after variants; each feed carried five independently signed values (AAPL spread
0.0016%), served unauthenticated. The design was RedStone primary with a self-signed publisher as the
tested fallback, confidence being the divergence between the two reads.

Facts from reading the adapter source that any future RedStone integration must start from:
`write_price` runs `process_payload`, which enforces the signer threshold and stores only the
**median**, one timestamp and decimals — per-signer spread is never on chain, so confidence must come
from a second source; `write_price` is callable by any paying signer, so our service can create the
feed accounts itself; the source declares program ID `rds8J7…` while devnet carries `REDu…`, so the
live build must be confirmed before depending on its layout; there is **no RedStone SDK on crates.io**
(`redstone-finance/rust-sdk` is a git dependency, pushed 2026-09-01, zero stars). RedStone free
registration was requested 2026-10-05; the gateway served data without a key.

Other candidates, for the record: Stork returns HTTP 401 with undocumented pricing; Switchboard ceased
operations 2026-09-25 and its devnet program is still `executable`, which is why "deployed" is never
accepted as evidence here; Chainlink carries no equity feeds on Solana devnet.

## 5. Full lifecycle plus polish, rather than a thin correctness slice

**Date:** 2026-10-05
**Context:** Scope choice for the submission. Options ranged from a bulletproof mint/settle/redeem
core with minimal UI, through full lifecycle with deliberate thinness, to full lifecycle with a
genuinely usable trading surface.
**Decision:** All ten functional requirements end to end, plus a usable trading UI, a portfolio
with realized P&L, and a market-maker dashboard.
**Trade-off:** Meaningfully more time than a core-only slice, and polish is explicitly not what the
brief grades. Accepted because the deliverables include a demo video of the full lifecycle, and
because the one-book/four-trade-path abstraction is a *user-facing* idea — it cannot be
demonstrated without a UI that actually presents Buy Yes / Buy No / Sell Yes / Sell No as four
plain actions. Tests still prioritize the money path and settlement over breadth.

## 6. RESOLVED — build a minimal in-program CLOB rather than integrate Phoenix

**Date:** 2026-10-05
**Status:** **Resolved by spike.** Full workings in
[`docs/spikes/2026-10-05-phoenix-devnet.md`](docs/spikes/2026-10-05-phoenix-devnet.md).
**Context:** The brief offers both paths: use an existing on-chain CLOB on the chosen chain (e.g.
Phoenix on Solana), or build a minimal order book as part of the smart contract — which the brief
calls "more ambitious, demonstrates deeper understanding". The spike was created to test the
assumption that Phoenix might not be usably available on devnet.

**The assumption was wrong, and the spike still went the other way.** Phoenix *is* deployed and
live on devnet (1,225 program accounts, ~700 market-sized, 474 seats). Integration was a real
option. Two other constraints decided it:

1. **Rent exceeds the devnet faucet, by an order of magnitude.** Phoenix market accounts run
   84,944–232,544 bytes. Meridian needs ~45 fresh markets *every trading day* (7 tickers × 5–7
   deduplicated strikes), which is 19–53 SOL/day in rent alone. The devnet faucet caps a request
   at ~2 SOL and rate-limits per day — a 10 SOL request is rejected outright. A reviewer could not
   reproduce the lifecycle, which the deliverables require and the brief forbids working around via
   mainnet.
2. **Phoenix seats are a maker-side permission gate.** Resting (limit) orders require an approved
   Seat, granted per trader per market by the market authority; takers swapping do not. With ~45
   markets a day, an active trader needs several seats daily, each a request plus an
   authority-signed approval. That is incompatible with FR-013 (Buy No market order must be one
   atomic operation, one user approval) and sits awkwardly against a product whose first premise is
   non-custodial and KYC-free.

**Decision:** Build a minimal central limit order book inside the Meridian program — price-time
priority, partial fills, cancellation, and the atomic mint-and-sell path behind Buy No.

**Trade-off:** We now own a matching engine, which is genuine work and the main schedule risk in
the project. Accepted because: it is the path the brief itself credits as demonstrating deeper
understanding; it keeps the system self-contained and devnet-reproducible; it removes an external
dependency, a CPI surface and a permissioning service; and because same-day expiry lets us **close
books at settlement and reclaim the rent**, something Phoenix's lifecycle does not offer. A compact
book at 128 orders/side costs ~3.8 SOL/day *recycled nightly*, against Phoenix's 19–53 SOL/day
consumed permanently. Note the same faucet ceiling binds us on a reviewer's first day: 3.8 SOL is
above a single ~2 SOL airdrop, so the lifecycle scripts MUST support a demo-scale configuration that runs on one faucet grant.
**Corrected 2026-10-06 (plan analysis):** demo scale changes only the book capacity (16 orders per side,
~1.25 SOL for a full day) and never the ticker or strike count, because the PRD requires all seven
stocks every day and a demo that skips tickers does not meet the requirement. 128 per side is the
production default. Recorded here so the plan does not rediscover it.

**Consequence for the spec:** none. `specs/001-binary-outcome-markets/spec.md` deliberately states
the order book requirements (FR-009…FR-014) as *behaviour* — price-time priority, atomicity of the
Buy No path, real-time updates, settlement interaction — so it needed no rewriting when the spike
landed. The constitution's Stack & Scope Constraints should now be amended to record the closed
decision.

## 7. Docker as the toolchain, not a host install

**Date:** 2026-10-05
**Context:** Anchor builds depend on a version triple (anchor × solana-cli × rustc) that fails with
unhelpful errors when mismatched. This was demonstrated rather than theorised: a host install reported
`solana-cli 4.3.0`, then `4.1.2` once Anchor's `avm` was on `PATH`. Separately, two graded deliverables
are a **deployment guide with reproducible devnet scripts** and a lifecycle a reviewer can run **with no
manual steps**.
**Decision:** The canonical build and deploy environment is a **pinned Dockerfile / devcontainer**, and
it is a first-class deliverable rather than developer convenience. The host toolchain installed on
2026-10-05 was removed again (~870 MB) to keep the container the single source of truth. Host-level
`rustup`/`cargo` and Node remain for editor tooling.
**Trade-off:** Costs a few hours that produce no user-visible functionality, and a reviewer who hits a
Docker problem is worse off than one following a clear README — so the image MUST be verified working
before it is promoted as the recommended path. Container builds also crawl unless `target/` and the
cargo registry live in named volumes, and keypairs must be mounted read-only and never baked into a
layer. `solanafoundation/anchor` tops out at v1.0.2 against Anchor 1.2.0, so we pin our own versions
rather than pull theirs — which is the point of the exercise anyway. Accepted because reproducibility is
graded directly and version-triple breakage is a recurring, already-observed cost.

**Update, 2026-10-06 (Wave 0 review fix):** Anchor CLI is now installed from the prebuilt
`anchor-1.2.1-x86_64-unknown-linux-gnu` release binary rather than built from source, which avoids
the rustc/cargo-platform build-time mismatch entirely and keeps Anchor at the plan's first-choice
1.2.1, matching the `anchor-lang`/`anchor-spl` crates.

**Update, 2026-10-06 (Wave 0 build, base image):** `anchor-litesvm` 0.2.1's native `litesvm`
dependency (resolved to 0.3.3) is a prebuilt `.node` addon requiring the glibc symbol
`__isoc23_strtol`, only present from glibc 2.38. Debian bookworm (first choice) ships 2.36 and
aborts the process on load. The Dockerfile base moved from `rust:1.89-bookworm` to `rust:1.89-trixie`
(glibc 2.41); Rust, Agave and Anchor pins are unaffected.

**Update, 2026-10-06 (Wave 0 build, program/test compatibility):** `anchor build`'s default
`--arch v3` output (newest SBPF ISA) fails to load in every `litesvm` generation this project has
used so far -- see the Wave 2 update below for the current reason and fix (`scripts/anchor-build.sh`
builds with `--arch v1`). Separately, `solana-test-validator` asserts `io_uring_supported()` and
aborts under Docker's default seccomp profile on some hosts; `compose.yml` sets
`security_opt: [seccomp:unconfined]` on the `dev` service. None of this changes the
Rust/Anchor/Agave/Node/pnpm version pins themselves.

**Update, 2026-10-06 (Wave 2, program tests):** Four more toolchain findings, all scoped to
`programs/meridian` and `tests/program`, none changing the version pins themselves.

- **`CpiContext::new_with_signer` takes a `Pubkey`, not an `AccountInfo`.** Unlike the Anchor
  versions most examples online are written against, `anchor-lang` 1.2.1's `CpiContext::new`/
  `new_with_signer` take `program_id: Pubkey` as their first argument (`src/context.rs`). Passing
  `ctx.accounts.system_program.to_account_info()` is a compile error (`expected Pubkey, found
  AccountInfo`); use `ctx.accounts.system_program.key()`.
- **A CPI-created or `resize`d account cannot grow by more than `MAX_PERMITTED_DATA_INCREASE`
  (10,240 bytes) within one transaction**, enforced identically for `system_program::create_account`
  and `AccountInfo::resize` (the renamed `realloc`). `book_space(capacity)` (`128 + 128 * capacity`)
  exceeds that above capacity ~79, and capacity 128 (the non-demo default) needs 16,512 bytes --
  so `create_market` cannot create the Book itself in one shot for any capacity worth using.
  **Fix:** split Book creation into its own idempotent, incremental instruction, `create_book`
  (`programs/meridian/src/instructions/create_book.rs`): call it repeatedly, each call its own
  transaction (so each gets a fresh 10,240-byte budget), until `Market.book` is set. See that
  file's doc comment and `contracts/program-instructions.md`'s "Split note". `create_market`/
  `add_strike` still create the Market, both mints, the vault, and both escrows in one transaction
  (no split needed there -- `anchor build --arch v1` succeeds with every account `Box`ed).
- **Update, 2026-10-06 (program tests moved to Rust):** the pinned `anchor-litesvm` 0.2.1 /
  `litesvm` JS 0.8.0 combo used by the original TypeScript harness (`tests/program/**`) corrupted
  its native heap (`std::bad_alloc`, killing the whole test process) a small, non-deterministic
  number of operations after *any* transaction failed inside a handler touching a seeds+bump-
  validated account -- confirmed independent of `init` vs. plain `mut`, of an in-handler mutation
  before the error, and of payload distinctness. That made Waves 3-5's negative-test matrix --
  mostly rejection cases -- essentially impossible to write in that harness: at most one on-chain
  failure assertion could be spent for the entire suite. **Decision:** program tests are now Rust
  integration tests under `programs/meridian/tests/*.rs`, against the `litesvm` crate 0.12.0 --
  built on the same Solana v3 crate family as `anchor-lang` 1.2.1 and Agave 3.1.14, with no such
  heap limit (`harness_stress.rs` runs 60 deliberately failing transactions in one instance
  followed by a successful `create_market` to prove it). `anchor-litesvm` and `litesvm` (JS) are
  removed from the project entirely: `tests/program/` is deleted, and `tests/package.json`'s
  `program` script now points at `make test-program`. `scripts/anchor-build.sh` still builds with
  `--arch v1`, now because litesvm 0.12.0's loader itself rejects a default `--arch v3` `.so` with
  `InvalidAccountData` (confirmed directly), not for the old anchor-litesvm/litesvm-JS 0.8.0 reason.
  `docker compose`'s `dev` service also gained `ulimits.memlock: unlimited` and `cap_add: [IPC_LOCK]`
  (`compose.yml`) during the TS harness's lifetime after first suspecting `RLIMIT_MEMLOCK`
  exhaustion; that turned out not to be the heap-corruption's root cause, but repeated `LiteSVM`
  instance creation alone did hit the 8 MiB default without it, so the fix stayed.
- **Deployment-risk note:** `initialize_config` has no check restricting who may call it first --
  anyone can race the deploy and become `admin`. Accepted as a documented risk rather than a code
  change: the deploy script initializes `Config` in the same run as the program deploy, and a
  stronger upgrade-authority check is deferred.

## 8. Dependency pins for the build

**Date:** 2026-10-06 (planning)
**Context:** Principle II requires every major dependency to be justified here. Full workings are in
`specs/001-binary-outcome-markets/research.md` R1–R3, R14; this is the list and the one-line reason.

| Dependency | Pin | Why |
|---|---|---|
| Rust | 1.89 | `anchor-lang` 1.2.1 declares it as minimum |
| Anchor | 1.2.1 | current release (2026-10-06); Pyth receiver SDK requires `^1.0.2`; fallback 1.2.0 if the pin misbehaves on first build |
| Agave CLI | 3.1.14 | Anchor 1.2 targets the Solana v3 crate family; `stable` Docker tag; 4.x needs an unreleased Anchor feature |
| `pyth-solana-receiver-sdk` | 2.0.0 | published, current, parses `PriceUpdateV2`; the reason Pyth beat RedStone on integration risk |
| `@anchor-lang/core` | 1.2.1 | Anchor's TypeScript client at 1.x; `@coral-xyz/anchor` stopped at 0.32 |
| `@solana/web3.js` | 1.99 | what wallet adapter and the Anchor client peer on; `@solana/kit` not yet supported by wallet adapter |
| `@solana/wallet-adapter-react` | 0.15.40 | standard wallet UX on Solana; Phantom and Solflare |
| `litesvm` (Rust crate) | 0.12.0 | program tests (`programs/meridian/tests/*.rs`) need a warpable clock for settle-after-close and the override delay; Rust, not the retired `anchor-litesvm`/litesvm-JS combo (see §7 2026-10-06) |
| Next.js | 16.4 | partner-recommended frontend stack |
| Luxon, node-cron | current | ET schedule with DST; no heavier scheduler needed |
| `@pythnetwork/pyth-solana-receiver` | 0.16 | posts Hermes updates to the receiver; service-side only because it pins an old Anchor client |

**Trade-off:** Anchor 1.2.1 is a day old. Accepted because the fallback is one version back and the
container makes the switch a one-line change.

**Update, 2026-10-07 (Wave 6, Node/receiver compatibility and a transitive override):**

| Dependency | Pin | Why |
|---|---|---|
| `@pythnetwork/pyth-solana-receiver` | 0.13.0 (service), not the 0.16 above | 0.16's `package.json` declares `engines.node: ^24.0.0`; the pinned toolchain runs Node 22.23.3. 0.13.0 is the newest release that still supports Node 22 and exposes the same transaction-builder API the posting path needs. The SDK/web package stays on whatever `@solana/web3.js`-era client it already used; only the automation service's receiver client moved |
| `jito-ts>@solana/web3.js` | `^1.99.0` (root `pnpm.overrides`) | A transitive dependency pulled in by the receiver SDK's dependency tree resolves `jito-ts`, which declares an older `@solana/web3.js` range; left alone it installs a second, incompatible web3.js copy that breaks `instanceof PublicKey` checks across packages. Overridden at the workspace root rather than patched per-package |

## 9. `close_market`: two independent safeguards against stranding the Book and escrows

**Date:** 2026-10-06 (Wave 5, Codex-caught blocker)
**Context:** `close_book`/`close_market` reclaim rent by closing the Book and both escrow accounts
once a market is done trading. Two separate problems, each needing its own answer:
(a) A default/zeroed `Market.book` address is ambiguous — it describes a market whose Book was
*never finished being created* (see §7's `create_book` split) just as much as one whose Book
finished and was later closed. The address alone cannot tell the two cases apart.
(b) Even once that's resolved, `close_market` shouldn't take its own prior bookkeeping on faith for
the one fact it's about to act on — whether the Book and escrows are actually gone.
**Decision:** Two independent safeguards, not one:
(a) An explicit `book_closed` flag on `Market` records that closure specifically happened
(distinct from "never created"), resolving the address ambiguity.
(b) Independently of that flag, `close_market` re-verifies on chain that the derived Book PDA and
both escrow PDAs hold zero lamports before it proceeds, rather than trusting the flag by itself.
The test suite covers the unfinished-creation case explicitly alongside the normal closed case.
**Trade-off:** One extra zero-lamports check per close, worth it because the alternative — trusting
the flag alone — is a silent rent/fund leak that would not surface until a reviewer hit the exact
unfinished-creation edge case.

## 10. Self-match refusal on every path that matches orders

**Date:** 2026-10-06 (Wave 5, Codex-caught blocker)
**Context:** Three instructions can match a taker order against the resting book: `place_order` (a
plain limit/IOC order), `sell_no_market` (sells the No leg as an IOC taker order), and
`buy_no_market` (the only composite that matches orders — it mints a Yes/No pair and immediately
sells the Yes leg as an IOC taker order). In any of them, if the taker's own resting order is the
best price on the opposite side, the match fills against the taker's own order. In
`buy_no_market`'s case specifically, that means the Yes leg just minted transfers straight back to
the wallet it was minted to instead of out to a counterparty, leaving the wallet holding a newly
minted Yes *and* No — an unwanted paired position, not a shortfall: the mint already funded the
pair, so self-matching doesn't fabricate anything unpaid, it just leaves both legs sitting with the
one wallet instead of trading away the side the instruction promised to dispose of.
**Decision:** `reject_self_match` runs in all three instructions — `place_order`,
`sell_no_market`, and `buy_no_market` — before any funds move (mint, transfer, or escrow release),
rejecting the transaction rather than letting a same-wallet fill clear. Covered by a regression
test.
**Trade-off:** A market participant who also has a resting order on the other side of the same
market must let that resting order get out of the way first (cancel it, or let someone else fill
it) before their own taker order can match — a minor UX constraint, accepted because the
alternative silently leaves the wallet in an unintended paired position instead of completing the
trade it asked for.

## 11. `redeem_winning` requires only the winning side's token account, not both

**Date:** 2026-10-06 (Wave 4)
**Context:** A wallet that only ever bought Yes holds a Yes associated token account and no No
ATA. An early version of redemption required both outcome ATAs to exist, which fails for the
common case of a directional (non-maker) trader.
**Decision:** `redeem_winning` takes a single winning-side token account, requires no pause gate
(settlement finality should not be blocked by an operational pause), and checks only that the
vault holds at least the winning side's outstanding supply before paying out.
**Trade-off:** None of substance — this removes an unnecessary account requirement rather than
trading away a guarantee; the vault-sufficiency check still fails closed if the vault is short.

## 12. Settlement job cadence: start at 16:00:30 ET, one closing observation per ticker per day

**Date:** 2026-10-06 (Wave 4), Hermes terminal-error handling added 2026-10-07 (Wave 6)
**Context:** The brief requires settlement within 10 minutes of the 4:00 PM ET close, using a
single, consistent closing price per ticker rather than whatever the latest quote happens to be
on each retry (a real Codex-caught blocker in Wave 4: re-fetching "now" on every retry let later
trades or republishing change which price a strike settles against).
**Decision:** The settle job starts at 16:00:30 ET (a 30-second buffer past the close), fetches and
freezes one closing observation per ticker for that trading day, and settles every strike on that
ticker against that same frozen observation, retrying on a fixed 30-second cadence inside a 15-minute
window and reconciling on-chain state (in case another caller already settled) before alerting.
Hermes 401/403/429 responses are classified as terminal for the automatic attempt rather than
retried for the full window, since they signal an auth/entitlement/rate-limit wall that retrying
cannot clear, and the operator is alerted immediately instead of after 15 minutes of futile retries.
**Trade-off:** A ticker whose single frozen observation turns out to be bad (rather than stale) has
no automatic self-correction within the window — this is what `admin_settle_override` exists for.

## 13. Event-derived P&L: average cost per leg, with a losing-leg write-off at settlement

**Date:** 2026-10-06 (Wave 4, refined by Codex review before the wave closed)
**Context:** The SDK has no ledger account to read P&L from — it is derived entirely from replaying
on-chain events (Minted, Fill, PairRedeemed, Settled) per wallet. A fixed-cost model for pair
redemption produces wrong numbers under partial trading (e.g., mint a pair, sell Yes at $0.65, buy
it back at $0.40, redeem the pair: fixed-cost math reports $0.15 realized and a negative $0.10
remaining basis, which is not a coherent position). Separately, a model that never recognizes a
losing leg's write-off reports a winning redemption as pure profit even though the paired losing
leg cost money too.
**Decision:** Track **average cost per leg** (Yes and No tracked separately per wallet per
market), remove each leg's proportional current average cost on redemption rather than a fixed
amount, and **write off the losing leg's remaining basis once, at settlement**, while leaving its
token quantity in place (it is a worthless, not absent, balance). Self-fills (a wallet matching its
own maker and taker order) are handled explicitly so they do not fabricate inventory or cost.
**Trade-off:** This is a product-facing accounting decision, not just an implementation detail — a
reviewer reconstructing P&L from the raw event log by a different method (e.g., realized-only cash
flow) will get a different number mid-position, though the two methods agree once every position in
a market is fully closed out. Average-cost is the standard brokerage convention, which is why it was
chosen over FIFO/LIFO or a fixed-cost-per-redemption shortcut.

## 14. Program size (~615 KB) sets the devnet deploy budget, not the "two airdrops" the plan assumed

**Date:** 2026-10-07 (Wave 6, Codex-caught, `docs/deployment.md`); rent figures recomputed against
devnet RPC 2026-10-07 (Wave 7/8, Codex-caught)
**Context:** The compiled program binary is ~615,229 bytes. Deploying it funds two separate
accounts, measured directly against devnet RPC rather than estimated:
- **Final program-data account**, sized to the binary's exact length: `solana rent 615229
-u https://api.devnet.solana.com` → **3.12601356 SOL**. This is the permanent cost, retained for as
  long as the program stays deployed.
- **Temporary buffer account**, which briefly holds the uploaded bytes before the program-data
  account takes ownership of them. It is sized the same as the binary during upload, so it costs
  the same ~3.126 SOL — but that rent is reclaimed to the deployer once the buffer closes after
  the deploy finishes; it is not an additional permanent cost.
`solana rent 1230458` (2x 615,229 — the rough "buffer + program-data" headroom `scripts/deploy.ts`'s
own comment estimates) returns **6.25137688 SOL**, the right order of magnitude for "final and
temporary funded at once" but not the number actually observed: a clean-clone run of the plain
`anchor deploy` path (not `scripts/deploy.ts`'s more efficient path, which deployed the same binary
on just 2 SOL in the same run) failed with `insufficient lamports 1999990000, need 4282829040` —
i.e. a raw `anchor deploy` needed **~4.28 SOL** funded simultaneously, a figure between the
single exact-size allocation (3.13 SOL) and the full double-size allocation (6.25 SOL), consistent
with the buffer and program-data accounts needing to be funded concurrently for part of the deploy
before the buffer's rent is reclaimed.
**Decision:** Document and budget the deploy step as **~3.13 SOL final** (permanent program-data
rent) **+ ~3.13 SOL temporary buffer** (reclaimed once the buffer closes) **→ fund ~6.5 SOL for the
deploy itself**, cross-checked against the clean-clone finding that a raw `anchor deploy` demands
~4.28 SOL mid-deploy. On top of that, budget the lifecycle's own ~1.25 SOL/day at demo scale
(§6/`research.md` R7) — **~7–9 SOL on the deployer wallet overall** (three to five separate ~2 SOL
airdrop requests, or a manual larger grant), and record the exact-size cap (program binary must
not exceed ~615 KB without re-deriving this budget) in `docs/deployment.md`.
**Trade-off:** None — this replaces an estimate with RPC-measured numbers and a clean-clone
cross-check; the risk it forecloses is a reviewer's deploy attempt stalling partway through (as the
clean-clone run reproduced) for a reason the docs didn't quantify precisely enough.

## 15. Browser transaction path: the app simulates and broadcasts, the wallet only signs

**Date:** 2026-10-07 (manual UI QA against the local stack with Phantom)
**Context:** `@solana/wallet-adapter`'s default `sendTransaction` hands the whole transaction to the
wallet, which simulates and broadcasts on its own RPC. Phantom's Localnet mode is hard-wired to
`localhost:8899` and cannot simulate or broadcast there at all, so every trade failed with the
wallet's generic "Unexpected error" and no program message. Two related problems surfaced in the
same pass: a simulation run at `finalized` commitment saw a resting order the user had just
cancelled and refused a Sell No as a self-match, and the test validator's default history
retention (10,000 shreds) pruned the fills the portfolio derives cost basis from within minutes.
**Decision:** The web app builds the transaction, simulates it through its own RPC connection at
`confirmed` commitment, surfaces the program's error line (SelfMatch, Paused, …) as the user-facing
reason when simulation fails, asks the wallet only to sign (`signTransaction`), and broadcasts the
signed bytes itself (`sendRawTransaction`, preflight on). The adapter's `sendTransaction` remains
the fallback for wallets that expose no `signTransaction`. The app's `ConnectionProvider` runs at
`confirmed`; every `solana-test-validator` start in the `Makefile` passes
`--limit-ledger-size 100000000`. The same pass found that the browser `Buffer` polyfill lacks
`writeBigUInt64LE`, so the SDK's PDA and event encoders use `DataView` instead.
**Trade-off:** The wallet's own simulation preview is bypassed, so the wallet shows the
transaction without a balance-change estimate. In exchange every refusal is explained in the
program's own terms before the user is asked to sign, and the same code path works on localnet,
devnet, and any RPC the wallet cannot reach. Trading after a market's close is still hidden only in
the UI; the program accepts mint and order placement until settlement, which is tracked as an open
question rather than decided here.

## 16. Trading stops at the close time on-chain, not just in the UI

**Date:** 2026-10-07 (manual UI QA; decided by Andre)
**Context:** `Market::is_open()` only checked the lifecycle state, so `mint_pair`, `place_order`,
`buy_no_market`, `buy_no_limit` and `sell_no_market` kept working between a market's `close_ts` and
its settlement. The web app hid trading in that window ("Settlement pending") and the market-maker
panel was patched to stop offering those markets, but anyone calling the program directly could
still take a maker's stale resting order once the closing price was public, with no risk.
**Decision:** The five trading instructions require `Clock::now < market.close_ts` and refuse with a
new `MarketClosed` error (appended to the enum so existing codes keep their numbers).
`cancel_order`, `redeem_pair` and, after settlement, `redeem_winning` are unaffected, so a maker
can always pull a resting order after the close. `settle_market` and `admin_settle_override` keep
their existing "at or after close" rules. Covered by litesvm tests that warp the clock to the close
and past it for each path, plus a cancel-after-close test.
**Trade-off:** A market that closes but never settles (oracle refusing every retry, operator
override not yet allowed) has a frozen book for up to an hour. That is the intended behaviour:
nothing about the outcome changes in that hour, and the escrows stay refundable through cancel.

## 17. Devnet runs: manual USDC floors per demo wallet, paced transactions, batched probes

**Date:** 2026-10-07 (first devnet deployment)
**Context:** The lifecycle script on devnet demanded 1,000 USDC per demo wallet, a localnet number
that no faucet pays out (Circle's gives 20 USDC per address every two hours). The first run that
did get funded then failed because the maker mints 20 pairs and immediately posts a 2 USDC bid.
Separately, two runs on the public devnet RPC died with `429 Too Many Requests`: once on a burst of
45 parallel account reads, once mid-ladder after web3.js's own retries ran out.
**Decision:** On devnet the floors are what the scenario actually needs, A ≥ 25 USDC and B ≥ 10
USDC, funded by hand and checked before any market is created; localnet keeps minting 1,000 each.
The day-freshness probe is one `getMultipleAccounts` call per 100 addresses, and on devnet the
script pauses 750 ms between on-chain steps. Partial runs are not resumed: a run that dies leaves
its markets to be override-settled and closed for rent later, and the next run uses a fresh
synthetic day. `--tickers` is the budget lever when SOL or RPC headroom is short.
**Trade-off:** A full seven-ticker devnet run now takes several minutes longer and still depends on
a public RPC's mood; a private devnet endpoint removes that, at the cost of one more credential.
Abandoned partial runs cost about 0.02 SOL per market until reclaimed.

## 18. `buy_no_limit` never crosses the book; marketable No limits run as market orders

**Date:** 2026-10-07 (devnet UI testing with Phantom; found by Andre)
**Context:** `buy_no_limit` mints a pair and rests a Yes ask at `1 − No price`; unlike
`place_order` it never matches. A No limit at $0.55 against a resting $0.50 Yes bid therefore
posted a $0.45 ask *below* the best bid and sat there: a crossed book, pricing the strike ladder
and payoff line off an ask nobody could lift, and in this case against the user's own bid, which
the self-match rule (§10) never saw because no match was attempted.
**Decision:** The program refuses a `buy_no_limit` whose Yes ask price is at or below the best
resting bid (`WouldCross`), before anything mints. The SDK's intent planner routes a No limit that
is marketable (Yes ask ≤ best bid) through `buy_no_market` capped at the user's price, so the
user gets the fill they asked for and the self-match rule applies as on every other taking path.
Covered by a litesvm test (cross, touch, and non-crossing cases) and an SDK planner test.
**Trade-off:** `buy_no_limit` stays a pure rest-only instruction rather than growing a matching
loop; the cost is one extra client-side decision, which the SDK owns so every client gets it.

## 19. Either leg of a held pair can be sold from the trade panel

**Date:** 2026-10-07 (devnet UI testing; found by Andre)
**Context:** The trade panel gated Sell Yes / Sell No on the wallet's *net* holdings (Yes minus
pairs, No minus pairs). A wallet holding a minted pair therefore had both sell buttons disabled,
each pointing at the other: a dead end, while the program happily accepts an ask backed by Yes
tokens regardless of what else the wallet holds.
**Decision:** Sell gating uses the actual balance of the leg being sold. The pair exemption in the
Buy-side gating (FR-015, a pair holder is never told to "close" anything) is unchanged.
**Trade-off:** None beyond copy: the "paired" explanatory text is gone because the situation no
longer arises.

## 20. Listed tickers come from on-chain Config; default set is TSLA, QQQ, VOO

**Date:** 2026-10-08 (decided by Andre after the new Pyth key arrived)
**Context:** The PRD names seven stocks (AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA). The Pyth key
the project finally received is entitled to three US equity feeds, TSLA, QQQ and VOO, plus crypto
and metals; the other six names return "Not entitled". The SDK, scripts and web had the seven
baked in as a TypeScript union, so changing the set was a code change in four packages.
**Decision:** The ticker universe is data. The on-chain `Config.tickers` (up to the program's
fixed capacity) is the listed set; the SDK keeps a catalogue of known symbols and feed ids
(`FEED_IDS`, now including QQQ, VOO and SPY) and a default `TICKERS = ["TSLA", "QQQ", "VOO"]`
used only to initialise a fresh config. `init-config -- --tickers A,B,C` sets the list at init,
`init-config -- --update --tickers ...` replaces it later; the web, automation and lifecycle
script read the enabled list from Config. `Ticker` is a plain string type. Every market settles
on a real Pyth price; the three-name deviation from the PRD is disclosed here rather than padded
with crypto or metal feeds that have no 4 PM close.
**Trade-off:** Fewer markets per day for the demo (about 21 instead of 45) and two of the three
are index ETFs rather than single stocks. When Pyth grants the remaining equity feeds, listing
them is one config call and no deploy.

**Update, 2026-10-08 (later the same day):** a further key grant enabled all seven PRD feeds
(AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA; confidence under 2 bps each). Andre chose the PRD seven
as the listed set; `TICKERS` defaults to them again and the devnet config was switched by one
`init-config -- --update --tickers ...` call, as §20 intended. QQQ and VOO stay in the catalogue
and their day-20261008 ladders remain tradable by URL until they settle.

## 21. The generated IDL and program id are committed

**Date:** 2026-10-08 (preparing the Railway deployment)
**Context:** `packages/sdk/src/idl.ts` and `program-id.ts` were generated by `scripts/anchor-build.sh`
and gitignored, so a build from a clean checkout (any hosted builder) had no IDL and no program
address until someone ran the Anchor toolchain. §14 already treats `docs/deployment.md`'s table,
not `declare_id!`, as the source of truth for the deployed address.
**Decision:** Both files are tracked. They describe the program as deployed on devnet
(`3XQgqYNXPeZr5o2NUmnuPm9hk5mPrZpiEsFE62pjVkBn`); `anchor-build.sh` still regenerates them, and a
rebuild that changes the IDL shows up as a diff to review and commit alongside the program change.
**Trade-off:** A large generated file in the repo and one more thing to keep in step with the
deployed program. The alternative, running the Rust toolchain inside every web build, is far worse.

## 22. Product documentation lives in the app as a Docs tab

**Date:** 2026-10-08 (UI revamp wave R4b)
**Context:** The README and `docs/` folder are written for operators and reviewers. A trader on
the public URL had nowhere to learn what a contract is, how the four trade buttons map onto one
Yes book, how settlement and redemption work, or what the demo's limits are. Andre asked for a
Docs tab with a quick start and appropriate documentation.
**Decision:** Seven markdown pages under `web/content/docs/` (quick start, how contracts work,
trading, market making, settlement and redemption, portfolio and history, FAQ and limits) are
rendered statically at `/docs/<slug>` with a side nav and a "Docs" link in the top bar. They are
written for traders in plain language under the same copy rules as the rest of the UI: no
implementation vocabulary, and "devnet" only on the FAQ page. Every page was fact-checked against
the program and web code by a Codex review before shipping, and any future behaviour change that
affects a documented rule must update the matching page in the same commit.
**Trade-off:** Some overlap with `docs/` and the PRD. Accepted: the audiences differ, and keeping
the trader pages inside the app means the public deployment is self-explanatory without the repo.

## 23. A worker-served event index replaces per-browser chain replay for cost basis/History

**Date:** 2026-10-08
**Context:** `web/src/lib/events-cache.ts` has every browser independently page
`getSignaturesForAddress` for the whole program and fetch/decode each transaction, paced to avoid
the RPC's rate limit (contracts/automation.md's rate-limit numbers). An empty cache took about
three minutes to catch up on ~600 transactions on the private devnet RPC, and that cost only grows
with program history -- paid again by every new tab/device/wallet, independent of every other
browser doing the identical work.
**Decision:** The automation worker (already long-running, already serving `/status`) builds and
continuously maintains the same decoded event stream in memory (`services/automation/src/
events-index.ts`), persists a JSON snapshot so a restart resumes rather than re-paying for the
whole history, and serves it over the existing status server as `GET /events` (optionally
`?after=<signature>`). The browser cache (`events-cache.ts`) fetches that first when
`NEXT_PUBLIC_EVENTS_INDEX_URL` is set, validates `programId`/genesis hash before trusting it, and
merges the result in; the existing chain-based forward sync still runs afterward (cheap once the
remote fetch did most of the work) so a transaction newer than the worker's own 30s poll is never
missed, and the whole chain-replay path is kept as the fallback when the remote fetch fails or the
variable is unset. The wire format (`PublicKey` as base58, `bigint` as decimal strings) lives in
`packages/sdk/src/events-json.ts` so neither side can drift from the other.
**Trade-off:** The worker is now a second thing (besides the chain itself) whose downtime degrades
the web app -- accepted, because the degraded path is the exact chain replay that was the only
path before this. Railway's ephemeral disk means a worker redeploy pays for the full backfill
again; that is the same cost every browser paid on every empty cache before, just centralized to
one process instead of N browsers.
**Follow-up (2026-10-08, review fixes):** `complete` is derived from two separately-tracked
states -- signature *paging* reaching genesis, and a persisted `retrySignatures` queue (also
checkpointed in the snapshot) draining to empty -- so a transaction that fails to fetch/decode can
never silently report the index complete, and is retried every sync independent of the forward
cursor. Entries carry a `seq` (assigned at discovery time, increasing forward / decreasing
backfill) so sorting by `(slot, seq)` reproduces true on-chain order even when a slot holds more
than one of this program's transactions; the browser cache uses the same order when merging
remote and chain-fetched entries. A snapshot is only installed after the live genesis hash is
resolved and matches the snapshot's, and after confirming the snapshot's oldest signature still
resolves on chain (same-genesis validator resets); either check failing discards the snapshot and
rebuilds from zero. The cold backfill now runs in bounded, paced batches with a snapshot
checkpoint after each one, so an in-process restart resumes instead of losing all progress, and
`start()` retries every step (genesis resolution, snapshot load, each sync) with backoff so a
transient RPC error during startup delays rather than permanently stops the index. The browser
cache only ever trusts a remote payload that itself reports `complete: true`, and only requests
`?after=<signature>` once its own local cache already reports complete -- otherwise it requests
the full index -- so a partial/incomplete response can never be mistaken for full coverage.

## 24. Next-day markets are created by the morning job, not chained onto settlement

**Date:** 2026-10-08
**Context:** The settle job already holds each ticker's closing price at 4:00 PM ET, so tomorrow's
strike ladders could be created minutes after settlement instead of at 8:00 AM. That would give
overnight trading and a site that is never empty between the close and the next morning. The PRD
(§4, §5.3) describes an 8:00 AM morning job that reads the previous close and creates the day's
markets; it says nothing about after-hours trading, and trading starts at the 9:30 AM open.
**Decision (Andre):** Punt. Keep the two-job schedule as is. The morning job would still be needed
as the fallback, so the change adds a second code path to the job that must not fail at the close,
plus next-trading-day calendar logic, duplicate-ladder checks between the two paths, and a
price-source mismatch (on-chain settlement price in the evening versus Pyth's republished close in
the morning), all testable only once per day at a real close. Time is short and after-hours trading
is not a PRD requirement.
**Revisit:** After unattended settlement has run clean for a few days, if overnight trading becomes
something worth showing. Estimated at about an hour plus tests.

## 25. A closed market's key can never be reused, so test runs must never use a real trading day

**Date:** 2026-10-09
**Context:** The first unattended morning job created ladders for only four of seven tickers.
AAPL, MSFT and GOOGL failed on `create_market` with the system program's "account already in
use": a test run on the evening of 2026-10-07 had created markets for the real upcoming day
2026-10-09 at the standard strikes, settled them, and reclaimed them. `close_market` reclaims the
Market, Book and vault accounts, but SPL mint accounts cannot be closed, and the Yes/No mint PDAs
are derived from the market key. A later `create_market` for the same (ticker, day, strike) finds
no Market but collides on the mint. The job also aborted the whole ticker at the first collision,
so strikes that would have succeeded were never tried.
**Decision:** Three parts. (1) The morning job skips a colliding strike with a clear log line and
continues; a summary line per ticker reports created/existing/skipped. (2) Synthetic test days used
with `--day` must be dates that will never be real trading days for this deployment (a past date,
or a weekend with `--force`); never a real future date. Recorded in `docs/deployment.md` and
`docs/risks-and-limitations.md`. (3) The program is not changed: making `create_market` tolerate
pre-existing mints would need `init_if_needed` on the mints plus authority checks, an upgrade in the
middle of a trading day for a problem that only a misuse of the test flag can cause.
**Today's recovery:** the three ladders were created by hand at the standard strikes shifted by
$5 (AAPL 315–375, MSFT 485–575, GOOGL 325–385), with maker quotes at the money, before the close.
**Also fixed:** the publisher cron tick logged an error every minute under the Pyth provider; it is
now only scheduled when the provider is the test publisher.

## 26. Trade page chart: Pyth Pro History API backfill rendered with TradingView Lightweight Charts

**Date:** 2026-10-09
**Context:** The wave R3 sparkline sampled the live price poll into a session buffer, so a fresh
tab started empty and grew one point per 15 s. Andre asked why the chart had no history and
refreshed slowly. Pyth retired its public Benchmarks TradingView endpoints on 2026-08-26; the
replacement Pyth Pro History API (`https://pyth.dourolabs.app/v1/{channel}/history`, TradingView
UDF shape, Bearer key) was verified with our existing key to return one-minute candles for every
listed equity.
**Decision:** A server route (`/api/price-history`) fetches the current session's one-minute
closes with the key kept server-side, caches per ticker for 60 s with request coalescing, and
degrades to the last cached series on upstream failure. The browser seeds its session buffer from
it once per ticker and keeps appending live samples. The Trade page renders it with
`lightweight-charts` 5.x (Apache-2.0, canvas, built for price series): area series, dashed strike
price line, crosshair readout, autoscale that always includes the strike, colours read from the
theme variables so a light theme needs no chart changes. The hand-written SVG sparkline was
removed; nothing else used it.
**Trade-off:** One more dependency (about 45 KB) and one more upstream call per ticker per minute
at most. The library's attribution logo is kept, as its licence asks for a link to TradingView.

## 27. An intraday `extend` job adds strikes when the price nears the ladder's edge

**Date:** 2026-10-09
**Context:** The morning job sizes each ticker's strike ladder once, at the open, from the
previous close. A stock that runs hard intraday can trade through (or near) the top strike of
its own ladder with no next-higher market to trade into, and the only fix was the admin's manual
"Add strike" button on the Admin page. Andre wanted that covered automatically, without touching
the morning job or weakening the "closed markets' keys can never be reused" rule (§25).
**Decision:** A new `extend` job (`services/automation/src/jobs/extend.ts`, `runExtendTick`) ticks
every 5 minutes, 09:35–15:45 ET, on trading days. For each enabled ticker that already has
markets for today (a ticker with none is left alone -- morning still owns creation), it reads
the live price (`PriceProvider.currentPrice`, new on the interface: Finnhub+Nasdaq cross-check
for the mock provider, Hermes latest for Pyth) and compares it to the top/bottom strike of
today's existing ladder. If the price is within $5 (half the $10 grid `strikeLadder` rounds to)
of the top strike or above it, and that condition holds on two *consecutive* ticks, it adds one
strike $10 above the top (mirror logic for the bottom); it never removes a strike. Creation
reuses the day's existing `closeTs` (never recomputed) and morning's exact create-market/
create-book/"already-in-use"-skip shape. Capped at 2 added strikes per ticker per trading day.
The cap, the two-consecutive-*scheduled*-tick streak (keyed by trading day; a gap wider than
1.5x the 5-minute interval, a day change, or a failed observation all reset it), and a
pending-book retry set (a market whose book didn't finish is retried every tick, independently
of the cap and of edge detection, and excluded from edge detection until it clears) are all
persisted to `EXTEND_STATE_PATH` (default `./data/extend-state.json`) after every tick --
loaded back on the next one, whether that's the next cron tick after a restart or a second
manual `job extend --once` invocation minutes later. The per-day allowance is reserved before
`createMarket` runs (not after the book finishes), so a market that spends rent always consumes
its allowance even if its book fails; a genuinely failed `createMarket` (confirmed absent on
re-fetch) releases the reservation instead. The cron tick runner also guards against overlapping
ticks (an in-flight tick causes the next scheduled one to log and skip, released in `finally`).
"Add strike" on the Admin page remains the manual path for anything this heuristic doesn't cover
(e.g. a gap wider than one $10 step, or a ticker the operator wants extended ahead of the
heuristic).
**Trade-off:** None of the above eliminates the underlying heuristic's scope (still one $10 step
at a time, still capped at 2/day, still never removing a strike) -- persisting the state only
means a worker restart or a gap between manual `--once` runs no longer *silently* re-opens the
cap or forgets an in-progress streak, at the cost of one more file (atomic temp-file-plus-rename,
same pattern as `events-index.ts`'s snapshot) the worker's disk needs to survive a redeploy for;
a lost state file just means the job starts the day's cap/streak over, same as before this fix.

## 28. Landing page: motion with no new dependency, and the hero shows real data

**Date:** 2026-10-09
**Context:** Andre found the landing page boring. The first redesign pass used a synthetic
self-drawing SVG chart in the hero; he liked everything else but not the chart.
**Decision:** The landing page is a cinematic dark hero (slow aurora gradient, a headline that
cycles through the seven stocks with a strike derived from the live price), a drifting logo strip
with live prices, three "how it works" cards that reveal on scroll, trust pills and a gradient
call-to-action band. All motion is CSS keyframes or small React hooks; no animation library. The
hero chart is the real intraday session of the stock in the headline, rendered with the same
Lightweight Charts component approach as the Trade page, with a dashed strike line and a Yes/No
badge computed from the live price; a synthetic chart remains only as the fallback when no session
data exists. Every animation collapses to its end state under `prefers-reduced-motion`.
**Trade-off:** The hero now makes two data requests on load (prices and one ticker's history,
cached server-side), acceptable for the one page meant to impress.
