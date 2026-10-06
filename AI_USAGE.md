# AI Usage Log

Required deliverable. Kept as the work happens, not reconstructed at the end. Records where AI
helped, where it misled, and where it was overridden.

## Tools

- **Claude Code** (Opus 5) — primary development agent: requirements synthesis, spec-kit driving,
  implementation, review.
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
`docs/spikes/2026-10-05-pyth-devnet.md`, decision in `DECISIONS.md` §7 (superseding §4),
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
email is his, recorded in §7.

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

### 2026-10-06 — Why the Pyth repricing was missed, and the free-source survey

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
