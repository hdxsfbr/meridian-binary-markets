# AI Usage Log

Required deliverable. Kept as the work happens, not reconstructed at the end. Records where AI
helped, where it misled, and where it was overridden.

## Tools

- **Claude Code** (Opus 5) — primary development agent: requirements synthesis, spec-kit driving,
  implementation, review.
- **Claude Code** (Fable 5.1) — independent review of the pre-plan artifacts on 2026-10-05, then
  planning onward.
- **GitHub spec-kit** 1.1.1.dev0 with the Claude Code integration — `/speckit-constitution`,
  `/speckit-specify`, `/speckit-plan`, `/speckit-tasks`, `/speckit-implement`. Artifacts in
  `specs/001-binary-outcome-markets/`.

## Log

### 2026-10-05 — Requirements intake

Claude read the Gauntlet portal project page and the Peak6 partner description directly in a
browser, then downloaded the attached `Gauntlet Project - Meridian.pdf` and read all 8 pages.
Merged both sources into `docs/PRD.md` with numbered requirements FR-1…FR-10.

*Useful:* the PDF carries substantially more than the portal summary — the at-or-above tie rule,
the one-book/four-trade-path model, strike deduplication, and the devnet requirement all appear
only there. Reading both and reconciling them caught detail a single-source pass would have missed.

*Overridden:* nothing yet.

### 2026-10-05 — Architecture decisions

The four opening decisions (chain, oracle, order book, scope) were put to a human rather than
assumed, because each materially changes the work and each is explicitly graded as "justify your
choice". Decisions and reasoning recorded in `DECISIONS.md` §3–6.

*Human judgment applied:* the order book choice was deliberately **not** settled up front. Rather
than defaulting to the more impressive-sounding option, it was deferred behind a time-boxed spike
to verify Phoenix devnet availability first — the constraint that actually decides it. The spec was
then written to be implementation-neutral on that point so it survives either outcome.

### 2026-10-05 — Constitution and spec

`/speckit-constitution` produced `.specify/memory/constitution.md` v1.0.0 with seven principles.
`/speckit-specify` produced `specs/001-binary-outcome-markets/spec.md` plus its quality checklist.

*Useful:* the spec-kit quality checklist caught the right question about whether the open order
book decision should be a `[NEEDS CLARIFICATION]` marker. It should not — it is an implementation
decision, not a requirements ambiguity — so it was recorded in Assumptions and the requirements
written as behaviour instead.

*Pruned:* generated scaffolding was rewritten rather than filled in. The spec template's five
principle slots were expanded to seven, and placeholder user stories replaced with the seven real
journeys.

### 2026-10-05 — Phoenix devnet spike

Resolved the deferred order book decision. Findings in
`docs/spikes/2026-10-05-phoenix-devnet.md`, decision in `DECISIONS.md` §6, constitution amended to
v1.1.0.

*Where AI was wrong, and was corrected by evidence:* the spike existed because Claude had reasoned
that Phoenix, being a mainnet protocol, might not be available on devnet — and had used that as the
headline argument for building our own book. **That assumption was false.** Direct RPC queries
showed Phoenix deployed and live on devnet with 1,225 program accounts and ~700 market-sized
accounts. Had the decision been taken on the original reasoning rather than tested, it would have
been the right call supported by a wrong justification — which the brief, grading documented
rationale, would have exposed.

*What actually decided it* came from measurement rather than recall: `getMinimumBalanceForRent-
Exemption` on the observed Phoenix market sizes (19–53 SOL/day for ~45 markets) against an empirical
probe of the devnet faucet ceiling (10 SOL rejected, 2 SOL rate-limited). The seat constraint was
checked two ways — decoding `approval_status` from the 128-byte seat accounts on devnet, and
confirming the maker/taker rule against documentation — rather than asserted from memory.

*Method note:* every quantitative claim in the spike document is reproducible from the RPC calls
recorded in it. The decision document deliberately leads with "the assumption the spike was created
to test was wrong", because a decision log that quietly drops a disproven premise is worth less than
one that shows it.
### 2026-10-05 — Pyth devnet verification

A teammate (Zach Gardner) reported in Slack that Pyth on testnet was a dead end. Rather than
accepting or dismissing it, the claim was **measured**. Findings in
`docs/spikes/2026-10-05-pyth-devnet.md`, decision in `DECISIONS.md` §4,
constitution amended to v1.2.0.

*Where AI's prior assumption was wrong:* `DECISIONS.md` §4 had named Pyth as the primary oracle on
the strength of its feature list — first-party equity feeds, a publish timestamp, a confidence
interval — all of which are true, and none of which answer the question that mattered: *is it
actually being published to on devnet?* Claude had reasoned from documentation rather than from the
chain. This is the **second** time in two days the same error class appeared (the Phoenix spike was
the first), which is itself the useful signal: capability claims about third-party infrastructure get
verified against the live network, not recalled.

*What human input contributed:* the correction came from a person, not from AI self-review. Claude
had no reason to re-examine §4 and would not have. Worth recording plainly — the decision log would
have carried a wrong premise into implementation otherwise.

*Where AI added to the human report:* three refinements, each from direct measurement.
1. Zach said "months"; the legacy devnet feeds are **185.6M slots (~2.4–3.5 years)** behind. Material
   difference — "months" implies something that may resume.
2. Zach attributed the API key requirement to stock data licensing. Testing BTC/USD alongside META
   showed **HTTP 401 for crypto too**, so the immediate blocker is general Hermes authentication, a
   separate barrier from equity entitlement. That changes what to ask Pyth support for.
3. The pull-oracle path is **not** dead — stale leftover `PriceUpdateV2` accounts are expected litter
   in a pull model, not evidence. Avoiding that misreading is what kept the Pyth adapter in the
   design rather than deleted from it.

*Overridden by the human:* the option set (Pyth-plus-API-key / own attested oracle / Switchboard) was
presented with a recommendation; Andre chose the attested oracle plus adapter interface and directed
vendor-neutral constitutional wording. The reasoning for not blocking on a third party's support
email is his, recorded in `DECISIONS.md` §4.

*Method note:* candidate replacement data sources were probed rather than assumed. Alpha Vantage
returned same-day data and works; Stooq, which from memory is a keyless CSV endpoint, now sits behind
a JavaScript proof-of-work challenge and is unusable headless. The spike states the free-tier rate
limit as *to be confirmed against a real key* rather than quoting a remembered number — directly
because of the Phoenix lesson.

### 2026-10-05 — Pyth, continued: the human-supplied document that explained it

Andre pointed at Pyth's Core upgrade documentation
(`docs.pyth.network/price-feeds/core/upgrade/preparing`) after the findings above were already
recorded. It converted four measurements into one explanation, and changed the recommendation's
shape.

*What the human contributed that AI had not:* Claude had measured *that* Hermes returns 401 and
inferred a general authentication wall, filing equity licensing as a separate open question. The
document shows the real story — a deliberate **three-stage repricing**: 2026-06-15 extended-hours
equity feeds moved to paid Pyth Pro, 2026-07-31 regular-session equity feeds followed, 2026-08-26 all
of Hermes went behind an API key with a new base URL. The price list then settles it: free tier has
**no API access at all**, Starter at $500/mo is **crypto only**, and MAG7 equities start at
**$5,000/month**.

*The error class, named:* Claude had measured the symptom accurately and stopped. Every individual
claim it made was true and reproducible, and the conclusion drawn from them — "credentials might
arrive if Zach's email lands" — was still wrong, because it never asked *why* the wall existed. A
correct measurement is not the same as an understood cause. One documentation page the human knew to
look for outperformed four rounds of RPC and HTTP probing.

*What it changed:* the decision stands, but its justification and its second adapter both changed.
Pyth is rejected on **cost, not capability**, and "wait for a support reply" is struck as a path —
Pyth did not misplace this data, they priced it. The fallback slot reserved for Pyth became a second
independent free source, which turned out to be the better design: two sources disagreeing is a real
confidence signal, and Principle IV forbids the hardcoded constant a single source would have forced.
A constraint improved the architecture, which is worth noting because it is the opposite of the usual
direction.

*Verified, not assumed:* the new `pyth.dourolabs.app/hermes` endpoint was tested directly and returns
401 identically to the old one, so the migration is complete rather than in progress. Prices were read
from Pyth's own plans page rather than from the search summary that first surfaced them.

### 2026-10-05 — Why the Pyth repricing was missed, and the free-source survey

Andre asked directly why Claude had not found the Core upgrade information itself. The answer is
recorded here because the failure mode generalizes.

*Root cause: the right method for the previous problem.* The Phoenix spike taught a real lesson —
verify third-party capability claims against the live network rather than from documentation — and
Claude applied it again here. For Phoenix that was correct, because the answer genuinely was on chain.
For Pyth the answer was in a changelog. **Measurement establishes *whether* something works;
only documentation explains *why not*, and whether it is coming back.** Claude asked the first question
four separate ways (RPC, slot arithmetic, account decoding, HTTP probes) and never once asked the
second. `WebSearch` and `WebFetch` were available throughout and were not reached for until a human
supplied a URL. An HTTP 401 whose body is literally `unauthorized` is a signpost toward release notes,
and it was read as a data point instead.

*Correction adopted:* when an external dependency returns an auth, quota or permission error — as
opposed to absent or stale data — read the provider's changelog and pricing before concluding anything
about availability. A commercial boundary cannot be detected by probing.

*The follow-up survey.* Eight data sources were then probed empirically rather than recalled, and the
result is that **this project needs no paid data at all**. Two findings justify the exercise:

1. **A latency trap that would have landed late.** Settlement must complete within 10 minutes of the
   close, which silently disqualifies three otherwise-sensible free sources: Alpha Vantage is not
   dependable until ~5 PM ET, Massive (ex-Polygon.io) is end-of-day only, and Alpaca's free tier
   withholds the most recent 15 minutes — precisely where the closing price lives. Discovered now
   rather than mid-implementation.
2. **The two-source confidence design was tested, not assumed.** Nasdaq and Twelve Data returned AAPL's
   2026-10-05 close as 332.89 and 332.89001 — agreement to five decimal places, which is what makes
   divergence a usable signal. Claude had written this mechanism into the constitution the day before
   on reasoning alone; checking it was the minimum owed.

*Also found by probing rather than memory:* `api.nasdaq.com` serves quotes and daily OHLC for all seven
MAG7 with **no API key**, and showed no throttling across 12 rapid calls — but it is undocumented, needs
a browser-like User-Agent, and carries no SLA, so it is used as a cross-check and never as the sole
source. Polygon.io has rebranded to Massive, which a from-memory answer would have got wrong.

### 2026-10-05 — Process correction: findings are not decisions

Andre: *"you keep swerving all over the place and continually updating docs back and forth i am lost."*
Correct, and the cause was a misapplied instruction rather than bad research.

The standing rule on this project is to log decisions as they happen rather than reconstruct them at
the end. I applied that to **findings**. Over two days the oracle question was committed three times —
Pyth, then a self-attested publisher, then RedStone — each with its own `DECISIONS.md` entry, a
constitution bump, README and onboarding rewrites, and four commits. Every individual entry was
accurate. The aggregate was unreadable, because it forced a reader to follow my investigation in real
time to find out where things stood.

**The distinction I missed:** a finding is evidence, a decision is a conclusion. Only decisions belong
in `DECISIONS.md`. Evidence belongs in the spike document, which is precisely what it is for, and
intermediate evidence should not trigger a governance amendment.

**Fixed by consolidation**, not by another document: §4, §7 and §8 collapsed into a single §4 stating
the settled position, with the spike doc retained as the evidence trail and labelled as such — including
my two wrong turns, which stay on the record. `DECISIONS.md` went from 299 lines to 164 while losing no
substance.

**Adopted going forward:** finish an investigation, then write once. The research pattern — probe the
chain for capability, read changelogs and pricing for policy — was right and found real things; it was
the publishing cadence that was wrong.

### 2026-10-05 — Pre-plan review by a second model

Andre asked for an independent read of everything before `/speckit-plan`, saying he was not confident
the back-and-forth had stayed sane. A second Claude (Fable 5.1) read the PDF, PRD, constitution,
spec, decision log and spikes, and checked the one external claim the plan would have to build on.

*Where the first pass went wrong, and the review caught it:*

1. **The PRD lost a third of the PDF.** The portal brief was merged carefully; the PDF's "Smart
   Contract Functions", "Invariants", "Automation Service", "Frontend Application" and "Testing
   Requirements" pages were not. Admin settle override with an enforced time delay, pause/unpause,
   settle-only-after-close, the 30 s × 15 min retry window and the override test case are all
   explicit, graded requirements that appeared nowhere downstream. The spec's quality checklist
   passed "on the first iteration" because it checks the spec against itself, not against the source.
   Fixed: PRD FR-11, FR-12 and §5.1–5.4; spec FR-031…FR-036 with scenarios and edge cases.
2. **The confidence guard was specified on a signal the chain never sees.** Three documents said
   confidence would be derived from the disagreement across RedStone's five signers. The adapter
   program's source stores only the median; the SDK returns only aggregated values. Everything written
   about the five signers was *true at the gateway* and irrelevant on chain. The claim had been
   promoted from a spike observation to a constitutional MUST without anyone asking where the number
   would physically come from. Fixed: confidence is RedStone versus the independent fallback read, which
   the spike had already validated; the signer threshold is the attestation guard.
3. **FR-015 forbade what FR-028 requires.** "System MUST prevent" holding both tokens, and a market
   maker holds both by design. The PDF scopes the constraint to the trading UI. Rescoped.
4. **The faucet argument used against Phoenix also binds our own book on day one.** Recorded as a
   demo-scale configuration requirement rather than left for a reviewer to find.

*Smaller tidying:* the spec still called the order book decision deferred; the Pyth spike had a
section headed "Decision" that contradicted `DECISIONS.md`; several dates read 2026-10-06 because the
agent used UTC. Constitution bumped to 1.3.0.

*Method note:* the one expensive check was reading the RedStone adapter program source rather than its
documentation. The docs describe five signers accurately; only the code shows what is stored.

### 2026-10-06 — Oracle re-decided: Pyth behind a provider interface, mocked until the token arrives

Andre, reading the settle-read explanation: *"theres no oracle in solana testnet that can reliably give
us the stock info we need? This whole Pyth/Redstone shit is madness... i smell we doing something
wrong."* The answer was that nothing was wrong on our side — equity data is licensed, Pyth repriced it
in 2026, and the brief predates that — but the RedStone path carried integration risk (unpublished SDK,
program ID mismatch, median-only account) that only made sense while Pyth was unaffordable.

Andre's call: a Pyth Pro token is likely available — a peer was approved for equity feeds by asking on Pyth's developer forum within ~3 hours, and Andre has asked the same. Build against a
Pyth-shaped mock now, behind a provider interface, swap in the real receiver when the token lands, and
keep the interface open so RedStone or another source can plug in if Pyth falls through. Recorded as
`DECISIONS.md` §4 (RedStone position kept as history), constitution 1.4.0, README and onboarding
rewritten once. The mock doubles as the tested fallback Principle IV already required, so no work is
wasted if the token never arrives.

### 2026-10-06 — Wave 0: the container gate, and four problems the plan's pins didn't anticipate

Implemented tasks T001–T012 (Dockerfile, compose, Makefile, Anchor and pnpm workspaces, hello-world
`ping` program, LiteSVM test) and proved `make dev` green on a clean checkout, then again after
`make clean`. Four build-time problems surfaced that the plan's research hadn't hit yet, each root
caused rather than patched around:

1. `cargo install anchor-cli --locked` failed under rustc 1.89 on **both** the 1.2.1 and the
   fallback 1.2.0 tag, with the same `cargo-platform@0.3.3 requires rustc 1.91` error — the plan's
   "try 1.2.0" fallback instruction assumed the problem was Anchor's version; it was a transitive
   dev-dependency's own MSRV, unrelated to which Anchor tag. Fixed by precise-pinning
   `cargo-platform` to 0.3.2 in a clone of the tag before installing, which kept Rust and Anchor's
   crate deps at their planned pins. Anchor 1.2.1 then failed *again*, separately, on a
   `solana-sbpf`/`Layout::dangling_ptr` requiring an even newer rustc — that one really is
   version-specific, so Anchor is pinned to CLI 1.2.0 while `anchor-lang`/`anchor-spl` (the crates
   the program depends on) stay at 1.2.1 as planned.
2. `anchor-litesvm`'s native `litesvm` dependency aborted the Node process outright (not a catchable
   JS error) with an undefined glibc symbol — bookworm's glibc 2.36 vs. a symbol from 2.38.  Base
   image moved to `rust:1.89-trixie`.
3. With that fixed, LiteSVM could load but refused the compiled program with "invalid account data
   for instruction". Root cause: `anchor build` defaults to the newest SBPF ISA (`--arch v3`);
   `anchor-litesvm` 0.2.1 is hard-pinned to litesvm's pre-1.0 JS API, and the newest npm litesvm
   release keeping that API (0.8.0) predates SBPF v3 support. Building with `--arch v1` and
   pnpm-overriding `litesvm` to 0.8.0 (outside anchor-litesvm's own declared range, but its public
   API hadn't changed) closed the gap without moving the Anchor/Agave pins.
4. `solana-test-validator` aborted with `assertion failed: io_uring_supported()` under Docker's
   default seccomp profile on this host. `security_opt: [seccomp:unconfined]` on the `dev` service
   fixed it; recorded rather than worked around silently since it weakens the container's sandbox
   and a reviewer deserves to know why.

All four are in `DECISIONS.md` §7 with dates. None of them changed the Rust/Agave/Node/pnpm version
pins from `plan.md`; Anchor CLI is the one pin that moved (1.2.1 → 1.2.0), and the reason is recorded
precisely so it isn't re-discovered by the next person who hits the same `cargo-platform` error and
assumes it's about Anchor.

*Method note:* every one of these was found by reading the actual error and the failing crate's own
source/Cargo.toml (cargo-platform's MSRV table, litesvm's git tags for the API-breaking commit,
LiteSVM's `accounts_db.rs` for where `InvalidAccountData` is raised) rather than guessing at version
numbers and retrying.

### 2026-10-06 — Implementation Waves 0–3 (Claude Code, Fable 5.1 coordinating Sonnet agents, Codex reviewing)

Process: the 101 tasks were grouped into nine waves of file-disjoint agents. Each wave: Sonnet
agents implement, the coordinator runs the integrated build and tests, Codex (gpt-6.1, high
reasoning, read-only) reviews only the wave's new code, the coordinator filters the review and
tells Andre what was dropped and why, one Sonnet fix pass, one commit. One review cycle per wave.
Andre approves agent briefs before launch and gets a liveness line every ten minutes.

Where it went wrong, candidly:
- Wave 0's brief told the agent to compile the Anchor CLI from source although the research pass
  had already found prebuilt release binaries. Twenty minutes of build and a 1.7 GB larger image,
  corrected in the fix pass. Lesson: check the expensive steps in a brief against what was verified.
- The same brief had eight deliverables and two proof runs, then two mid-flight corrections (a
  package cache written into the repo; a program signer about to be committed). 81 minutes for one
  wave. Later waves use two or three tasks per agent and no mid-flight corrections.
- The chosen TypeScript test runtime (anchor-litesvm + litesvm JS) corrupted its heap after any
  failed transaction. The Wave 2 agent found it and worked around it by keeping one negative test,
  which was not acceptable. Program tests moved to Rust on litesvm 0.12.0 in the same wave; 60
  consecutive failures in one process now pass as a stress test.
- Agents inherit the coordinator's "announce before acting" rule and twice stopped to ask for
  permission. Briefs now state the approval explicitly.
- Codex caught a real blocker in Wave 3: a one-micro-USDC donation to a vault would have frozen
  minting through an equality assertion. Changed to "vault holds at least the backing".

Where it went right: five parallel agents in Wave 3 with zero file conflicts because the entry
point and module declarations were pre-wired by the coordinator; Codex reviews were specific enough
to hand straight to a fix agent; the integrated suite at the end of Wave 3 is 144 Rust and 127
TypeScript tests, all green, and the core promise (mint a pair for a dollar, settle on a guarded
price, redeem a pair for a dollar) is proven on the in-memory runtime.

### 2026-10-07 — Implementation Waves 4–6

Process: same loop as Waves 0–3 — Sonnet agents implement a wave's file-disjoint tasks, the
coordinator runs the integrated build and tests, Codex (gpt-6.1, high reasoning, read-only) reviews
only the wave's new code, the coordinator filters and reports what was dropped and why, one Sonnet
fix pass, one commit per wave.

Where it went wrong, candidly:
- Agents repeatedly stalled sitting on a monitor (waiting on a long-running build or test) without
  surfacing that they were stuck, needing a manual nudge to report status or continue. Not fatal,
  but it cost wall-clock time across all three waves that a better "announce you're waiting, not
  just that you started" instruction in the briefs would have saved.
- The on-chain program's keypair regenerates on a clean build (it is gitignored by design, per §7),
  and one test file had the old program ID hard-coded as a literal rather than reading it from the
  generated IDL/keypair. It passed locally and failed the moment the keypair rotated; fixed by
  reading the ID from the build artifact instead of a string.
- The first `scripts/lifecycle.ts` runs needed six separate iterations before a full day actually
  closed out: a hand-computed P&L assertion had an arithmetic error; the publisher key had no SOL
  the first time funding was checked; a chain-clock vs. wall-clock mismatch made "close in N
  seconds" markets settle before the script expected; re-running the script against an existing day
  collided with markets already created in an earlier attempt; and one quantity was passed in base
  units where the instruction expected contract-scale units (and vice versa elsewhere). Each was a
  real bug, not flakiness — all six are now preflight checks or fixed math in the script itself
  (Codex caught two of the six as review items before they were found by running the script;
  running the script surfaced the other four).
- Documentation overclaimed the Pyth proof — an early draft of `docs/risks-and-limitations.md`
  described a "genuine posted Pyth update" and an "end-to-end receiver proof" when what had actually
  happened was a real Hermes fetch plus a synthetic, never-broadcast fixture exercising the guard
  chain in a LiteSVM test. The Wave 6 Codex review caught the gap between what was tested and what
  was claimed (item 19); the doc was corrected to say exactly what was and was not proven. That
  correction briefly also lived as a mirrored §15 in `DECISIONS.md`, but a Wave 7/8 review flagged
  that section as a probe finding rather than an architectural decision, so it was removed from
  `DECISIONS.md` and `docs/risks-and-limitations.md` §1–2 is now the single place this statement
  lives.
- The devnet faucet's rate limit blocked the one thing all of the above was building toward: an
  actual posted-and-confirmed Pyth update on devnet. The publisher key had 0 SOL when the posting
  probe ran, and the faucet returned `HTTP 429` on the single airdrop attempt the probe makes by
  design (no retry loop). The fallback — a synthetic fixture built from a real Hermes-observed
  BTC/USD price — is accurate to what it proves (layout, parsing, guards) and honest about what it
  does not (a broadcast transaction, a verified Wormhole signature).

Where it went right:
- Codex caught two correctness bugs by reading, not running: the self-match gap across
  `place_order`, `sell_no_market`, and `buy_no_market` (a taker's own resting order filling against
  itself would have left the wallet holding an unwanted paired Yes-and-No position instead of just
  the side it meant to end up with — the mint already funds the pair, so nothing unpaid gets
  fabricated, the harm is the unintended paired position) and the `book_closed`-flag ambiguity in
  `close_market` (a flag alone can't distinguish "closed after trading" from "never finished being
  created," and either reading it wrong strands a live Book and its escrows). Both are now
  `DECISIONS.md` §9–10.
- Across the three waves, Codex raised 95 review items (38 in Wave 4, 25 in Wave 5, 32 in Wave 6).
  94 were applied in the immediate fix pass for the wave that raised them; the one exception (the
  cross-day market-maker quoting panel, flagged in Wave 5) was rescheduled to Wave 6 and completed
  there, so every item raised was eventually applied.
- The full lifecycle — create markets across all seven tickers, mint, trade both sides, settle,
  redeem, reclaim rent — is now proven end to end on the local validator with hand-verified P&L,
  not just unit-tested in isolation.

Current numbers: 261 Rust tests, 108 SDK tests, 107 web tests, 114 automation tests (plus 1
skipped), and 62 scripts tests.

### 2026-10-07 — Manual UI QA pass, driven by the model

Andre's instruction after the first browser session failed on the very first trade: "test all the
features via the UI, fix what you find, raise if anything is ambiguous." Claude Code (Fable 5.1)
drove the running stack itself — first through the desktop preview browser with the in-page test
wallet, then headlessly with Playwright scripts when the preview disconnected — as the taker, the
maker, a visitor, and the operator, and fixed what it found in place rather than reporting a list.

What it found and fixed, in order: Phantom could not simulate or broadcast on Localnet (the app
now simulates, surfaces the program's reason, has the wallet sign only, and broadcasts itself —
`DECISIONS.md` §15); a self-match refusal caused by simulating at `finalized` commitment; cost
basis showing $0.00 because the test validator pruned history; the portfolio not refreshing
balances after mint, redeem, quote submit, or cancel; the admin Add strike form failing silently
because the browser `Buffer` polyfill lacks `writeBigUInt64LE` (every PDA derivation threw; fixed
in the SDK with `DataView`, and the admin page now logs the raw error and shows a success notice);
the market-maker panel offering to mint and quote on markets already past their close; a settled and
an open market with the same ticker and strike rendering as identical rows; "You pay $0.00" quoted
when a book has no asks; a duplicated empty-state message; and sell copy that told a trader holding
a minted pair they held nothing to sell.

Where the earlier process fell short: the Playwright suite passed throughout, because it ran the
same wallet shim the fixes above never touched. None of the five smoke flows exercised a real
wallet's send path, finalized-versus-confirmed simulation state, history retention over time, or
the admin page's PDA derivation in a browser. The suite proved the pages rendered and the
translation layer agreed with the program; it did not prove a person could trade. Andre's
"test dat shit before wasting my time" was the right call, and the standing rule since is that the
model drives the real UI with the test wallet before handing a build over.

Raised rather than decided: whether realized P&L should show the losing leg's write-off before
the winning side is redeemed, and whether the program itself should refuse mint and order
placement after a market's close time (today only the UI hides it).

### 2026-10-07 — Devnet deployment

Andre funded the admin wallet with 5 SOL from the Solana faucet (the second request never landed)
and the two demo wallets with 20 USDC each from Circle's faucet; Claude Code did the rest: deploy,
config, four lifecycle attempts, and the fixes between them. The program deployed first try at
the committed address. Anchor's IDL upload failed afterwards, harmlessly.

The lifecycle took four attempts, each failing on something the localnet runs could not have
shown: a 1,000 USDC per-wallet floor that only made sense where the script mints its own USDC; a
burst of 45 parallel reads the public RPC refused; web3.js retries running out mid-ladder; the
maker needing 22 USDC, not 20, because the scenario's bid comes right after the mint; and both
demo wallets dipping a few thousandths of a SOL under the fee floor from the previous attempts.
Between attempts the model recovered the maker's 20 USDC from the abandoned market by cancelling
its asks and redeeming the pairs, and moved 10 USDC from the taker to the maker rather than wait
two hours for the faucet. Each fix is small and recorded in `DECISIONS.md` §17; together they are
the difference between "works on a validator we control" and "works on a shared network."

The fifth run completed end to end: seven AAPL markets, four trades matching the hand-computed
deltas, settlement at $335 by the mock oracle, redemption, vault at zero. Addresses are in
`docs/deployment.md` §2. About 0.8 SOL of rent sits in the 40 markets from the aborted runs,
reclaimable after their override delay. The real Pyth post on devnet still waits on 0.5 SOL for
the publisher; the next faucet round covers it.

### 2026-10-08 — First devnet session with a real wallet

Andre tested the devnet deployment from Phantom while Claude Code (Fable 5.1) fixed what he
found, rebuilt, and had him reload; about a dozen round trips over three hours. In order:

- The public devnet RPC rate-limited the Portfolio page into a wall of errors (about 650 account
  reads on load against a 40-per-method limit). Fixed by batching: one token-accounts call, one
  multi-account call for books, a paced and de-duplicated history sync. First load went from
  560 refused reads to none.
- The model then recommended Alchemy's free tier without checking it; Andre signed up and the
  tier turned out to block `getProgramAccounts` and account subscriptions, both of which the app
  needs. Andre: "do your research before you tell me to create stuff that is not gonna work."
  Recorded as a standing rule. Helius was verified call by call against the key before switching.
- Later refreshes crashed on cached events whose key fields had lost their class: the production
  bundle carries two copies of `@solana/web3.js`, so `instanceof PublicKey` missed. The cache now
  recognises keys by shape.
- Andre's walk through the test plan found the real bug of the night: a Buy No limit that should
  have traded rested below his own bid and left the book crossed, because `buy_no_limit` never
  matches and so never reached the self-match rule. Program guard (`WouldCross`) plus SDK routing
  of marketable No limits through the market path (`DECISIONS.md` §18); also sell-either-leg
  gating (§19), market and day labels everywhere, a 2 by 2 trade panel, grouped history rows.
- Upgraded the program on devnet once 5 SOL arrived, override-settled the 40 orphaned markets,
  and ran the automation's `reclaim` job for the first time against a real cluster. It failed on
  every market: the close instructions want the system program and the client never passed it,
  a gap the mocked unit tests could not see. Fixed; 47 markets closed, 0.8 SOL back.
- Compose quirk, also found live: a blank `KEY=   # comment` in `.env` arrives as the comment
  text. `.env.example` keeps comments off blank values now.
- The Pyth key that fetched BTC/USD last week now returns "Not entitled" for crypto too, so the
  on-chain Pyth post remains unproven. Raised to Andre, who has the Pyth contact.

Pattern worth naming: every one of tonight's bugs lived at a boundary the local validator and
mocked tests smoothed over (a shared RPC's limits, a provider's plan, a bundler's duplicate
module, a real wallet declining, a client account list never run against the chain). The
devnet session with a human at the keyboard found in three hours what the suites could not.

### 2026-10-08 — First real settlement, PRD seven on Pyth, public URL

The day the oracle story closed. In order: the Pyth key arrived entitled to three equities; the
ticker universe was made config-driven in four packages so the listed set is an on-chain update,
not a code change (`DECISIONS.md` §20); a second grant the same afternoon enabled all seven PRD
names and the devnet config was switched by one command; the program was upgraded so `Config`
accepts one to seven tickers; today's ladders were created for all seven with the maker quoting
each at-the-money strike. At 16:00:40 ET the settle job, run once from the lab machine, posted
each ticker's Pyth closing update to the devnet receiver and settled 46 markets in twelve seconds.
Andre watched the countdown hit zero, the trade pages flip to "Settlement pending", then settled,
and redeemed a winning position from his own wallet.

Also today: the web app went public on Railway from a slim production image (validated locally
before upload, after two Dockerfile misses the local build caught), with the Pyth key kept server
side behind a small price proxy. The automation worker was deployed to the same project with the
keypairs as variables, so from tomorrow the morning ladder and the close-time settlement run
unattended. A UI revamp plan was written from the brand kit and from Kalshi/Polymarket references
Andre supplied, with his three decisions recorded and a developer-copy audit attached.

Two misses worth owning: I recommended Alchemy (yesterday) and then pointed Andre at a Helius
setting (today) without checking either first; both are now covered by the "verify before
recommending" rule. And the delisted QQQ/VOO ladders tripped the settle job's retry-and-alert
path, which is the behaviour FR-5 asks for but should have been anticipated.

Evening: the UI revamp's Docs wave. A Sonnet agent wrote seven trader-facing pages and the
static route; a Codex fact-check against the program and web code returned about thirty
corrections (market-order partial execution, what each order type reserves, the oracle timing
allowance, override delay, Redeem all batching, Chance fallback) plus a missing table renderer.
A second Sonnet pass applied them with trader-level wording I supplied for the program-internal
ones. Decision recorded as `DECISIONS.md` §22.

Late evening: wave R5 (Admin restyle, responsive and accessibility pass). Sonnet built it; the
Codex review returned two findings. One was wrong: it read the publish-time guard backwards, and
the program source settles it (the price may be published up to the configured offset before the
close), so the new label stands. The other, light-mode cyan text at 1.8:1, was a one-line token
fix I applied myself. The Docs wave's first public deploy also shipped without the Docs pages
because the upload ignore list matched any folder named docs; anchored and redeployed.

Night: two Sonnet agents in parallel. One audited every PRD requirement against the code and tests
into `docs/prd-compliance.md` (real gaps: no demo video yet; a handful of invariants covered only
structurally, not by a named test). The other brought README and the operator docs in line with the
revamped UI; it also caught a false README claim that no browser test suite existed. I fixed the
stale README status banner and the deployment table's ticker list by hand.

Also tonight: the worker-served event index (`DECISIONS.md` §23). A Sonnet agent built it and
measured the cold build on devnet (612 transactions in about three minutes, once, on the worker
instead of in every browser). Codex found ten real problems, mostly about the completeness flag,
retries and ordering within a slot; a second Sonnet pass fixed all ten with tests. I added the
build-time variable to the web Dockerfile and set it on Railway.

### 2026-10-09 — First unattended day, chart, toasts

The morning job ran on its own and exposed a real limitation: three tickers' market keys for the
day had been burned by a test run two nights earlier (reclaim frees the market but not its mints).
I diagnosed it from the worker logs and the event index, recreated the three ladders by hand at
strikes shifted $5 before the close, and had Sonnet make the job skip a colliding strike instead
of abandoning the ticker (`DECISIONS.md` §25). My own scheduled check did not fire; the host cron
log did. Settlement then needed nine retries because devnet confirmations ran past 30 s, and
landed inside five minutes; noted as a timeout follow-up.

Andre asked why the chart had no history. Pyth had retired its public history endpoint in August;
I read the migration note and verified the keyed Pyth Pro History API against our key before
building on it, per the "verify before recommending" rule. Sonnet built the cached server route
and the client seed, then the TradingView Lightweight Charts swap Andre picked (`DECISIONS.md`
§26). He also asked for a confirmation after placing an order; Sonnet built toasts, Codex caught
that the toast reported the pre-send estimate instead of what executed, and a fix pass now reads
the confirmed transaction's events. I tried the Circle faucet headlessly for the maker wallet and
stopped at its captcha rather than work around it. SCALING.md, ARCHITECTURE.md and
KEY_METRICS.md were written on request, the scaling analysis by me, the other two by Sonnet from
numbers verified in the repo.

Late night: the Yes/No mints moved to Token-2022 (`DECISIONS.md` §29). I had first started the
Metaplex metadata route after misreading Andre's reply; he corrected me, that attempt is shelved
in a git stash, and the Token-2022 build went ahead instead. A Sonnet coordinator split the work
into program core, SDK/web/scripts/worker, and docs; because sub-agent reports arrive at my
session rather than the coordinator's, I relayed results between them by hand. Codex's audit
found a missing account in the cancel builders, two cases where the web could guess the wrong
token program, and a mint whose rent could strand; a fix pass added a permissionless
`reclaim_mint` instruction and a "Remove from wallet" action for losing tokens. The e2e container
had been recreated without the validator's seccomp settings, so the integration suite ran through
docker compose from the host as the Makefile intends; it passed end to end.

### 2026-10-10 — Saturday: Token-2022 landing, BTC, the demo video

The weekend was for the deliverables that need no market: the Token-2022 upgrade went to devnet
(three upgrades across the day: the migration, the wallet-friendly names, the logo metadata), the
polish list was cleared (collapsed market cards, 90 s confirmations, logo in wallets), and the
demo video was planned around the one constraint the deadline imposed: no equity feed publishes
on a weekend, so a settlement on camera needs an asset that does. BTC replaced TSLA in the listed
set (`DECISIONS.md` §30); it only became usable once a second Pyth key with a crypto grant was
found. Two bugs surfaced from that path and were fixed and deployed: an unentitled feed blanked
every price on the site, and the BTC chart glued a live tip onto Friday's equity session.

The recording itself is a Playwright harness (`web/e2e/record-demo.mts`) driving two fresh wallets
through the lifecycle with title cards, stitched by ffmpeg. Devnet confirmations ran a minute or
more each all day, so the first two BTC ladders closed before their order books and quotes were
ready; they were used as settle-job rehearsals and the real take moved to a third ladder with a
90-minute runway. Codex reviews ran on every code change as before.

Evening: the video. The first cut (2 min 44 s, silent) became a narrated cut with Andre's own
voice clone through the local Chatterbox setup (CPU, because an apt upgrade that morning left
the NVIDIA kernel module and libraries mismatched), then a showcase cut for the hiring partner:
landing, markets, a Trade page tour on a fresh BTC ladder, the maker and taker footage, a
Portfolio tour, the operator's view, the live settlement, Docs, three "under the hood" cards,
5 min 57 s. Along the way Andre caught two product problems from the recording environment:
odometer digits losing their baseline, and settled strikes mixed with open ones because several
BTC ladders shared one synthetic day; both fixed and deployed (settled strikes are now hidden
wherever any strike is open). BTC comes off the listed set tonight and TSLA returns; the BTC
tour ladder is override-settled at its Pyth close by a scheduled job, and Monday's checks are
armed. Thumbnail, title and description were produced for the YouTube upload.

## 2026-10-10 (late evening) — re-recording the transaction scenes

Andre: the cut still had shots with settled strikes mixed in and visible confirmation stalls.
Claude found the three transaction scenes predated the "hide settled strikes" fix, re-recorded
them on the existing BTC ladder before its 10:30 PM CT close (one scene failed first because the
maker form's Yes balance lags the mint; fixed with a retry), added click-to-confirmation cuts
instead of time-compression, a same-origin proxy for the event index so the recording server
resolves cost basis, and aligned the nav strip prices on the text baseline. Settled with the live
Pyth price at 10:31 PM CT, recorded the redeem scene, re-muxed (5 min 50 s).

## 2026-10-11 (after midnight CT) — second pass on the transaction scenes

Andre: title cards were blank and the maker scene still showed "Cost basis updating". The
maker scene predated the index-proxy fix, so Claude re-created two BTC strikes (trading day
2026-10-11; the 10-10 keys are burned by leftover losing tokens), re-recorded maker, taker and
redeem scenes with the recorder now waiting out the history-loading text, rendered title cards as
stills with the logo, settled at 12:16 AM CT, re-muxed (5 min 53 s), and cleaned the chain back
to the seven stock tickers.

## 2026-10-11 (Sunday) — PRD gap wave: FR-10 adjust, morning alerts, invariant tests

Andre asked for a full PRD review after the "ready" calls turned out premature. Claude read the PRD
and had a Sonnet agent audit every requirement against the code without seeing the old compliance
doc; the two were reconciled by hand into a rewritten `docs/prd-compliance.md`. Three Sonnet agents
then worked in parallel: the `remove_strike` instruction with six tests and the two invariant tests
the PRD names (program agent found and fixed an account-closing order bug during its own
verification); the morning job's missing alert; the Admin "Adjust" action. Codex reviewed the
uncommitted diff and found three real defects in the Adjust flow (no recovery after a partial
run, Adjust offered after the close, no upper bound on the new strike); one Sonnet fix pass closed
all three with tests. Program upgraded on devnet; web and worker deployed on Railway.

## 2026-10-11 (afternoon) — browser tests, latency measurement, reconciliation job

Sonnet wrote the two Playwright tests the PRD names (book from both perspectives, portfolio P&L
figure) and the confirmation-latency measurement; its first run broke four specs through shared
order-book state, and it also found two older specs reading balances through the wrong token
program. A Sonnet draft of the reconciliation job drew five serious review findings (units,
settled-market backing, ladder after settlement, read failures, snapshot consistency); Andre asked
for a design before more code. Claude wrote the five checks as exact rules, Andre approved Opus for
the rewrite, Opus implemented from the text with 25 tests, and Codex's second review found two
remaining items (Anchor's camel-cased account name, which Claude confirmed against a live market,
and a wrong surplus rule in Claude's own spec: losing tokens never explain collateral). Both fixed
by hand. Worker tests 194.

## 2026-10-11 (late afternoon) — second full PRD audit

Andre asked for one more detailed read of the PRD against the code. An Opus agent audited
adversarially (code as evidence, our own docs excluded) and found no blockers: three small fixes
(the on-chain settle guard tolerated a quote up to 60 s before the close, now 0; the settle job
had no trading-day check; `.env.example` missed eight variables) and a set of deliberate
deviations that the compliance doc now discloses (previous close from Pyth's history API, the
08:00 single job and 16:00:30 settlement, the always-included centre strike, the "at or above"
payoff wording, owner-initiated burns, admin-supplied close time). Codex reviewed the fixes and
caught one more: a blank `PYTH_API_KEY_FILE=` in the example would disable the mounted-key
fallback. Fixed; worker 196 tests, scripts 75.

