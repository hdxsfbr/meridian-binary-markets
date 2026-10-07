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
