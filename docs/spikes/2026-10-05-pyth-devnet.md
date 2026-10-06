# Spike: Pyth on devnet — is it a usable settlement oracle?

**Date:** 2026-10-05
**Prompted by:** Zach Gardner, in Slack: *"Pyth on testnet is a dead end. The oracles haven't been
updated in MONTHS, and would require an api key providing access to stock data (the free trial will
not do you on this one)."*
**Question:** Can Meridian read MAG7 equity closing prices from Pyth on Solana devnet, under the
staleness and confidence guards the brief requires?
**Verdict:** **No, and not at any price we would pay.** Zach is right on both counts and the reality
is harder than either of us first described: the legacy devnet feeds are *years* dead, and MAG7
equity feeds are now a **$5,000/month commercial product**. This is a deliberate repricing by Pyth,
not an outage and not an access oversight. Meridian ships a **guarded oracle adapter interface** with
two independent free data sources behind it; a Pyth adapter is written as the documented production
path but cannot be exercised on this project's budget.

---

## Method

Direct Solana RPC against `api.devnet.solana.com`, plus unauthenticated HTTP against Pyth's Hermes
API. No local Solana toolchain required. Every number below is reproducible from the calls shown.

Programs checked (all three **are** deployed and executable on devnet):

| Program | ID | Role |
|---|---|---|
| Pyth legacy push oracle | `gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s` | on-chain accounts updated by publishers |
| Pyth pull-oracle receiver | `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ` | verifies & stores client-posted updates |
| Pyth (Lazer/solana-receiver) | `pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT` | — |

So "Pyth is not on devnet" would have been the wrong diagnosis. The deployment is fine; the **data
flow into it** is what is broken.

## Finding 1 — All seven MAG7 equity feeds exist

Hermes' feed-metadata endpoint is public (`HTTP 200`) and lists 1,250 equity feeds. The MAG7 are all
present, published as `Equity.Index.<SYM>/USD`:

```
AAPL   aaba35e6f33fb973bb2201d48a79ae24795affa6ba8bd50a93dcaf7da0030f36
AMZN   329635cf9e705e01ed2d842fafbb6c426d7e5630e75847740d89957222fd68b8
GOOGL  ad519718d387de4f0d7d29ea16a3730ce42e49c59fef6fba6fc9bac477645f6f
META   2cc0c022f7f37920485a5947f3cea8633783b6cb7fff6d94ee52f48687b7783d
MSFT   d9144b30a3a162a2748d384dc53387571f3ec77b9edfe31739349396ed67a63a
NVDA   a470c4ac46f44b547b2cba52338f311fb642b79375ce5f0cfd5cb5b99227b852
TSLA   e6da44bff5b8b06897a3739dd331b440d6662595bb862e37046892c568ae3fc0
```

The feeds we need are defined and identifiable. That is the extent of the good news.

## Finding 2 — Legacy devnet push feeds are abandoned, by years not months

594 legacy price accounts (3,312 bytes) exist on devnet. Comparing the newest `valid_slot` found in
them against the live chain:

| Quantity | Value |
|---|---|
| Newest `valid_slot` across all 594 accounts | 322,338,253 |
| Current devnet slot (2026-10-05) | 507,978,643 |
| Gap | **185,640,390 slots** |
| At 0.4 s/slot | **≈ 859 days (2.4 years)** |
| At 0.6 s/slot | ≈ 1,289 days (3.5 years) |

Sampled accounts also carried `pub_slot = 1`, i.e. never meaningfully published to. Nobody has run
a publisher against Pyth's legacy devnet oracle in years. This **confirms Zach and overshoots his
estimate by an order of magnitude** — worth telling him, because "months" sounds like something that
might resume, and "years" does not.

## Finding 3 — Hermes price reads require credentials, for *everything*

This is the decisive constraint, and the test refines Zach's framing.

```
GET /v2/updates/price/latest?ids[]=<META  equity feed>   ->  HTTP 401 unauthorized
GET /v2/updates/price/latest?ids[]=<BTC/USD crypto feed> ->  HTTP 401 unauthorized
GET /v2/price_feeds?asset_type=equity                    ->  HTTP 200
```

Crypto returns 401 too, so the authentication wall itself applies to every asset class. Finding 5
explains why, and supersedes the guess recorded here first — that this was merely general API auth
with equity licensing as a separate question. It is both, and both are priced.

## Finding 4 — The pull-oracle path is architecturally alive but unfed

The receiver program holds 739,407 accounts, of which 739,203 are `PriceUpdateV2` (134 bytes). The
path has been used heavily. Six decoded samples had publish times 76, 80, 94, 414, 581 and 592 days
old.

**Read that correctly.** In the pull model the *consumer* posts a freshly signed update as part of
their own transaction, so leftover stale accounts are expected litter, not evidence of a dead path.
Devnet staleness is not inherent to pull oracles. The blocker is Finding 3 and only Finding 3: we
cannot obtain the signed price blob to post.

**Consequence:** the devnet *mechanism* is sound — a funded consumer could run this path today. That
is why `PythAdapter` is written rather than deleted. Finding 5 is what makes "funded" the operative
word.

## Finding 5 — the real cause: Pyth repriced equity data, in stages, during 2026

Pointed at [`docs/pyth.network/price-feeds/core/upgrade/preparing`](https://docs.pyth.network/price-feeds/core/upgrade/preparing)
by Andre, which turned a measurement into an explanation. Pyth Core was **upgraded, not deprecated**,
and the 401s are the intended end state of a three-step migration:

| Date (2026) | Change |
|---|---|
| **Jun 15** | Pyth Core deprecates all extended-hours and session-based US equity feeds (~50 tickers, incl. AAPL, TSLA, NVDA, META) — moved to paid Pyth Pro |
| **Jul 31** | Regular-session equity feeds also require an active paid plan |
| **Aug 26, 16:00 UTC** | Core upgrade: **all** of Hermes requires a Pyth API Key. New base URL `pyth.dourolabs.app/hermes`, auth via `Authorization: Bearer $PYTH_API_KEY` |

Verified: the new endpoint returns `HTTP 401 unauthorized` unauthenticated, identically to the old
one. Both are walled; the migration is complete.

**And the price list is the actual blocker** ([app.pyth.com/plans](https://app.pyth.com/plans)):

| Plan | Price | API access | Asset classes |
|---|---|---|---|
| Free | $0/mo | **"No Pyth API access"** — view-only in Terminal, 10 s updates | — |
| Starter | $500/mo | API key | **crypto only** |
| Pro | from $2,500/mo | API key | all symbols incl. equities |
| U.S. Equities | **$5,000/mo** | API key | US equities |
| All Asset Classes | $10,000/mo | API key | everything |

So the free tier grants **no API access at all**, and the cheapest paid tier that carries MAG7
equities is **$5,000/month**. Note the asymmetry this explains: feed *metadata* is still public
(Finding 1 found all seven MAG7 feed IDs at HTTP 200) while feed *data* is a five-figure annual
product. The feeds exist and are advertised; the prices behind them are sold.

**This settles the open question about Zach's support email.** "Emailing Pyth support and asking
nicely" will not produce a free equity key, because Pyth did not lose this capability — they moved it
to a price list on purpose, in three deliberate steps, over three months. Worth telling him so he
does not block on a reply. If anyone at Peak6 already holds a Pyth Pro entitlement that is a
different and much shorter conversation, and the only one worth having.

## Candidate replacement sources, probed

Probed empirically on 2026-10-06, not recalled. Verdicts turn on one constraint that is easy to miss:
**the two reads have very different latency requirements**, and most free tiers can only serve one of
them.

| Source | Key | Limit | US equity data | Serves the 4:05 PM close? | Verdict |
|---|---|---|---|---|---|
| **Nasdaq** `api.nasdaq.com` | **none** | no throttle seen (12/12 rapid calls HTTP 200) | `/quote/<sym>/info` + `/quote/<sym>/historical` daily OHLC; all 7 MAG7 returned | Yes — primary listing venue for these tickers | **Use as cross-check** |
| **Finnhub** | free | 60/min | `/quote` is free and real-time for US stocks; returns current **and** previous close in one call | Yes | **Use as settlement primary** |
| **Twelve Data** | free | 800/day | `/quote` returns `close` + `previous_close` together | Yes (verified below) | **Use as third source** |
| **Alpha Vantage** | free | **25/day**, 5/min | `TIME_SERIES_DAILY` verified live, same-day data | **No** — reliable only ~5 PM ET | Morning read only |
| **Massive** (ex-Polygon.io) | free | 5/min | End-of-day only, 2 y history | **No** — EOD arrives too late | Morning read only |
| **Alpaca** | free | 200/min | IEX feed only, and free tier blocks the **latest 15 minutes** of history | **No** — close unreadable until ~4:15 PM | Fails the 10-min target |
| Yahoo Finance `query1` | none | — | HTTP **429** from this host; unofficial | Unreliable | Rejected |
| Stooq CSV | none | — | JavaScript proof-of-work challenge, intermittently | Unusable headless | Rejected |
| Pyth via Hermes | paid | — | $5,000/mo for MAG7 (Findings 3, 5) | n/a | Rejected on cost |

**The latency trap, stated plainly.** Settlement must land within 10 minutes of the 4:00 PM close
(PRD FR-5). A free *end-of-day* feed cannot do that — Alpha Vantage is not dependable until ~5 PM,
Massive is EOD-only, and Alpaca's free tier explicitly withholds the most recent 15 minutes, which is
precisely the window the closing price lives in. Three otherwise-reasonable sources are disqualified
by the clock alone. Had this been discovered during implementation rather than now, it would have
invalidated the settlement path late.

### The two-source design, empirically validated

The confidence-from-disagreement idea is load-bearing, so it was tested rather than assumed. Monday
2026-10-05 closes, two independent providers:

| Ticker | Nasdaq (keyless) | Twelve Data | Difference |
|---|---|---|---|
| AAPL | 332.89 | 332.89001 | **0.0000 (0.0000%)** |

Agreement to five decimal places. That is the result the design needs: in the healthy case the
disagreement band is essentially zero, so **any** material divergence is a real signal rather than
ordinary vendor noise. A threshold can therefore be set tight.

Twelve Data's `demo` key only authorizes AAPL, so the other six tickers returned `DENIED` — a key
limitation, not a data one. Nasdaq returned all seven MAG7 closes keyless: AAPL 332.89, MSFT 525.18,
GOOGL 346.47, AMZN 251.40, NVDA 238.90, META 741.90, TSLA 378.73.

### Caveats that must reach the risks note

- **No free source carries the true official closing auction print.** That is a licensed SIP product.
  Finnhub's free US data is IEX-sourced; Nasdaq's `lastSalePrice` reports `isRealTime: false` during
  the session. After the close these converge on the daily close, and the cross-check above shows
  vendors agreeing exactly — but "the official consolidated close" is not what we are reading, and the
  documentation must not imply otherwise.
- **The Nasdaq endpoint is undocumented.** It needs a browser-like `User-Agent`, publishes no rate
  limit or SLA, and could change without notice. Sound as a cross-check; must never be the only source.
- **Licence terms.** Twelve Data and Massive free tiers are individual/non-commercial. This project is
  coursework on devnet with no real funds, which fits, but it bars commercial reuse.

## Finding 6 — there IS a free Pyth-equivalent: RedStone (and Switchboard is dead)

Andre's question: *"something similar to Pyth but free — don't we need something on the blockchain?"*
Both halves were right, and chasing them found a better answer than the one recorded below.

**First, a correction to this document's own earlier option list.** It offered Switchboard On-Demand as
a candidate. **Switchboard ceased all operations on 2026-09-25** — ten days before this spike — and
told Kamino, Jito, Marginfi and Drift to migrate off. Its devnet program is still `executable`, which
is precisely the trap Pyth's legacy feeds set: **deployed ≠ operational.** Recommending it would have
repeated the exact mistake this spike exists to document.

### Surveyed, on devnet, by RPC

| Oracle | Devnet program | Status | Equity feeds | Data access |
|---|---|---|---|---|
| **RedStone** | `REDuYsnEucMweattdv4xQCYdU1i8Q2W92kdayrpY9rA` | **executable, actively fed** | **all 7 MAG7** | gateway returned 200 unauthenticated |
| Stork | `stork1JUZMKYgjNagHiK2KdMmb42iTnYe9bYUCDUk8n` | executable | yes (`AAPL_24_5` etc.) | **HTTP 401**; pricing undocumented, "contact sales" |
| Switchboard | `SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv` | executable but **network shut down 2026-09-25** | n/a | n/a |
| Pyth | `rec5EK…` | executable | yes | $5,000/mo (Findings 3, 5) |

### RedStone, verified in detail

- **Deployed on both networks**: devnet `REDuYsnEucMweattdv4xQCYdU1i8Q2W92kdayrpY9rA` and mainnet
  `REDSTBDUecGjwXd6YGPzHSvEUBHQqVRfCcjUVgPiHsr`, both `executable`.
- **Devnet is alive, unlike Pyth's.** Its three `PriceData` accounts were last written **3.2 h**
  (ETH), 3.5 h (BTC) and 14.5 h ago. Somebody is posting to RedStone on devnet right now. Compare
  Pyth's legacy devnet feeds at ~2.4 years.
- **All seven MAG7 are in the live production package** — 996 feeds total, including `AAPL`, `MSFT`,
  `GOOGL`, `AMZN`, `NVDA`, `META`, `TSLA`, each with `---24_7`, `---EXTENDED` and `---PRE_AFTER`
  session variants. That session granularity matters for a 0DTE product settling on a regular-session
  close, and is more than Pyth exposed.
- **Five independent signers per feed, each with its own ECDSA signature**, fetched 40 s old:

  | Feed | Signer values | Spread |
  |---|---|---|
  | AAPL | 333.07756596 / 333.07557902 / 333.07215923 | ~0.0016% |
  | META | 741.98756364 / 741.99084249 / 741.97925679 | ~0.0002% |

  **This is a better confidence measure than anything considered so far.** Pyth hands you one
  pre-computed confidence interval; RedStone hands you five independently signed opinions and lets the
  consuming program decide. The on-chain signer threshold is configurable
  (`getUniqueSignersThreshold`), which maps directly onto Principle IV's attestation guard — and the
  disagreement across signers satisfies the honest-confidence rule with a *cryptographically attested*
  number rather than a cross-check we assemble ourselves.

### The one unresolved risk, stated before it bites

**RedStone's documentation says the pull model requires an API key** obtained by filling in a form,
rate-limited to 1 request/second per key — while the gateway **empirically served full signed MAG7
packages unauthenticated** during this spike. Observed behaviour and documented policy disagree.

That is the Pyth trap's exact silhouette, so it gets resolved *before* commitment, not after:

1. The documented route is a form, not a price list — materially different from $5,000/month. But the
   cost is **unstated**, and this spike's governing lesson is that an unverified access assumption is
   worth nothing.
2. Until the key's terms are confirmed, the unauthenticated gateway MUST NOT be treated as a stable
   dependency. It may be unenforced policy today and enforced tomorrow.

**Required before this becomes the primary:** obtain the key, confirm it is free, and confirm equity
feeds are included. One form, and the answer either promotes RedStone or returns us to the design below.

## Decision

An **oracle adapter interface** — *return a price with a publish timestamp and a confidence measure,
or refuse* — with three implementations, only two of which we can exercise:

1. **`AttestedPublisher`, primary — Finnhub.** The automation service reads the close, signs it, and
   posts it to a price account the program reads. The program applies the guards — staleness,
   confidence/quality, and a **publisher allowlist** — and fails closed. Finnhub because its free tier
   is real-time for US stocks at 60 calls/min and its `/quote` response carries the current price *and*
   the previous close in one call, covering both daily reads from one endpoint.
2. **`AttestedPublisher` on a second, independent free source, as the tested fallback — Nasdaq's
   keyless API, with Twelve Data available as a third.** Originally this slot was reserved for Pyth.
   Finding 5 makes that impossible, and the replacement is better in a way worth stating plainly:

   > Principle IV requires the confidence measure to be **derived from something real** rather than
   > hardcoded. A single data source gives us nothing honest to put there. **Two independent sources
   > give us their disagreement**, which is a genuine uncertainty signal — exactly what the
   > confidence guard was designed to consume. When the two agree, confidence is tight and settlement
   > proceeds; when they diverge beyond a threshold, the guard trips and we fail closed rather than
   > settling on a contested price.

   So the constraint produced a better design than the plan it replaced. The fallback is now a real
   second opinion instead of a spare tyre, and it is testable, which Principle IV demands and a
   $5,000/month dependency could never have been.
3. **`PythAdapter`, written but not exercised.** Reads a `PriceUpdateV2` via the pull-oracle receiver.
   Kept because the pull-oracle path is genuinely alive (Finding 4) and because it is the honest
   production answer: a real deployment of this product buys licensed market data. Documented as the
   production path, and **labelled in the code as untested against live data** — not presented as a
   working fallback it cannot be.

The on-chain guard logic is written once and is identical for all three. Which sources feed it is
configuration.

**Read assignment**, because the two reads have different constraints:

| Read | When | Latency need | Source |
|---|---|---|---|
| Previous close → strike ladder | 8:00 AM ET | none (~16 h old) | Nasdaq historical + Alpha Vantage `TIME_SERIES_DAILY` (7 calls fits the 25/day cap) |
| Official close → settlement | ~4:05 PM ET | **under 5 min** | Finnhub `/quote` primary, Nasdaq cross-check |

**Total cost: $0.** Every requirement of this project is served by free tiers. The daily volume is
14 reads per source, against limits of 60/min (Finnhub) and 800/day (Twelve Data) — three orders of
magnitude of headroom.

## What this does NOT change

The architecture. Constitution Principle IV was written as a *property* — guarded reads, staleness
bound under 5 minutes, confidence check, fail closed, documented fallback — and the spec describes
the oracle only as "an external price source". Neither needed structural rework: Principle IV needed
its one vendor-specific sentence generalized (the v1.2.0 amendment), and FR-019 gained publisher
attestation as a third guard alongside staleness and confidence. One clause added to one
requirement, against a changed oracle vendor, a changed trust model and a new on-chain publisher —
that ratio is the whole return on stating requirements as behaviour rather than mechanism.

## Risks introduced, and how they are handled

- **We are now our own oracle on devnet, which is a weaker trust model than a real oracle network.**
  Handled by disclosure, not by pretending otherwise: this goes in the risks and limitations note as
  an explicit devnet limitation, with Pyth named as the production path. The brief requires that
  note and forbids regulatory or compliance claims, so it has a natural home.
- **A single publisher key is a single point of failure and the only writer we trust.** Mitigated by
  the on-chain publisher allowlist, so a compromised or unknown signer cannot settle markets, and by
  fail-closed guards, so an absent publisher delays settlement rather than corrupting it.
- **A free stock API could rate-limit or change shape.** Mitigated by the 14-requests/day ceiling,
  by caching the fetched close, and by the adapter boundary making the data source swappable.
- **Confidence has no natural definition for a single-source price.** Addressed by the two-source
  design in the Decision above: confidence is derived from the disagreement between two independent
  providers. The divergence threshold that trips the guard is still to be set in planning, and must be
  chosen against real observed spread between the two feeds rather than guessed.

## What would change this decision

An existing **Pyth Pro entitlement at Peak6** — the Pro tier upward carries equities, and if the
partner already pays for one, `PythAdapter` becomes primary and the attested publisher demotes to the
fallback. That is a question worth asking Myles Lewis, and it is the only cheap route to Pyth.

What would *not* change it: Pyth support replying to Zach. The data is priced, not misplaced
(Finding 5). Nothing short of a $5,000/month plan or a partner entitlement moves this.
