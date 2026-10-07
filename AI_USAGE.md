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
