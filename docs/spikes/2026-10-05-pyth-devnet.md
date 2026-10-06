# Spike: Pyth on devnet — is it a usable settlement oracle?

**Date:** 2026-10-05
**Prompted by:** Zach Gardner, in Slack: *"Pyth on testnet is a dead end. The oracles haven't been
updated in MONTHS, and would require an api key providing access to stock data (the free trial will
not do you on this one)."*
**Question:** Can Meridian read MAG7 equity closing prices from Pyth on Solana devnet, under the
staleness and confidence guards the brief requires?
**Verdict:** **No, not reproducibly.** Zach is right, and the staleness is worse than "months" —
the legacy devnet feeds are years dead, and the live path is gated behind API credentials we do not
have. Meridian ships a **guarded oracle adapter interface** with an attested devnet publisher as
the default implementation, and a Pyth adapter behind the same interface for if credentials land.

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

Crypto returns 401 too. So the wall is **general API authentication on the public Hermes endpoint**,
not equity-specific data licensing. Both barriers plausibly exist — equity market data genuinely is
licensed, which is why Zach is right that a free trial likely will not cover it — but the one that
stops us today applies to every asset class.

This matters for who to ask and for what: the request is for Hermes API access, and *separately*
for equity data entitlement. Those may be two different conversations with Pyth.

## Finding 4 — The pull-oracle path is architecturally alive but unfed

The receiver program holds 739,407 accounts, of which 739,203 are `PriceUpdateV2` (134 bytes). The
path has been used heavily. Six decoded samples had publish times 76, 80, 94, 414, 581 and 592 days
old.

**Read that correctly.** In the pull model the *consumer* posts a freshly signed update as part of
their own transaction, so leftover stale accounts are expected litter, not evidence of a dead path.
Devnet staleness is not inherent to pull oracles. The blocker is Finding 3 and only Finding 3: we
cannot obtain the signed price blob to post.

**Consequence:** if credentials arrive, this path works on devnet today with no redesign. That is
precisely why it stays behind the adapter interface rather than being written off.

## Candidate replacement sources, probed

| Source | Result |
|---|---|
| **Alpha Vantage** | Works. `TIME_SERIES_DAILY` for IBM with the public `demo` key returned data refreshed **2026-10-05** (same day). Other symbols require a free registered key — a 20-second signup, no payment. |
| **Stooq** (free CSV, no key) | **Unusable.** Now behind a JavaScript proof-of-work browser check; returns an HTML challenge page, not CSV. A headless service cannot consume it. |
| Pyth via Hermes | Blocked, Finding 3. |
| Switchboard On-Demand | Not probed. Pull oracle on devnet, can fetch arbitrary APIs with TEE attestation — but still needs an underlying stock data source, so it moves the attestation problem without solving the data problem. |

Meridian's actual data requirement is tiny: **2 reads/day × 7 tickers = 14 requests/day** (previous
close for the 8:00 AM strike ladder, official close for 4:05 PM settlement). Any free tier that
permits a few dozen daily requests is sufficient. The specific published rate limit must be
confirmed against a real key before it is relied on — the Phoenix spike is a standing reminder not
to bank an unverified number.

## Decision

An **oracle adapter interface** with two implementations behind it:

1. **`AttestedPublisher` (default on devnet).** The automation service reads the close from a free
   stock data API, signs it, and posts it to a price account our program reads. The program applies
   the identical guards — staleness, confidence/quality, plus a **publisher allowlist** — and fails
   closed.
2. **`PythAdapter` (preferred when available).** Reads a `PriceUpdateV2` posted via the pull-oracle
   receiver. Unblocked the moment Hermes credentials exist.

Both satisfy the same interface: *return a price with a publish timestamp and a confidence measure,
or refuse.* The on-chain guard logic is written once and is identical for both. Swapping sources is
a configuration change and an adapter, not a redesign.

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
- **Confidence has no natural definition for a single-source price.** The adapter must synthesize
  one honestly — e.g. spread across two independent sources, or a published bid/ask band — rather
  than hardcoding a confident-looking constant. A fabricated confidence value would defeat the
  guard it exists to feed. To be settled in planning.

## What would change this decision

Hermes API credentials covering equity feeds. Then `PythAdapter` becomes the primary, the attested
publisher demotes to the documented fallback that Principle IV already requires us to build and
test, and nothing else moves. Zach's email to Pyth support is therefore worth following up on even
though we are no longer blocked on it.
