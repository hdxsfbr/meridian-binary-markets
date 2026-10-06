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

| Source | Result |
|---|---|
| **Alpha Vantage** | Works. `TIME_SERIES_DAILY` for IBM with the public `demo` key returned data refreshed **2026-10-05** (same day). Other symbols require a free registered key — a 20-second signup, no payment. |
| **Stooq** (free CSV, no key) | **Unusable.** Now behind a JavaScript proof-of-work browser check; returns an HTML challenge page, not CSV. A headless service cannot consume it. |
| Pyth via Hermes | Blocked, Findings 3 and 5 — $5,000/month for MAG7 equities. |
| **A second free source** (Finnhub, Twelve Data, Polygon end-of-day) | Not yet probed. Required, because two independent sources are what make the confidence guard honest — see Decision. Probe before planning closes. |
| Switchboard On-Demand | Not probed. Pull oracle on devnet, can fetch arbitrary APIs with TEE attestation — but still needs an underlying stock data source, so it moves the attestation problem without solving the data problem. |

Meridian's actual data requirement is tiny: **2 reads/day × 7 tickers = 14 requests/day** (previous
close for the 8:00 AM strike ladder, official close for 4:05 PM settlement). Any free tier that
permits a few dozen daily requests is sufficient. The specific published rate limit must be
confirmed against a real key before it is relied on — the Phoenix spike is a standing reminder not
to bank an unverified number.

## Decision

An **oracle adapter interface** — *return a price with a publish timestamp and a confidence measure,
or refuse* — with three implementations, only two of which we can exercise:

1. **`AttestedPublisher`, primary.** The automation service reads the close from a free stock data
   API, signs it, and posts it to a price account the program reads. The program applies the guards —
   staleness, confidence/quality, and a **publisher allowlist** — and fails closed.
2. **`AttestedPublisher` on a second, independent free source, as the tested fallback.** Originally
   this slot was reserved for Pyth. Finding 5 makes that impossible, and the replacement is better
   in a way worth stating plainly:

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
