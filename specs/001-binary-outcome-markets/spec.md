# Feature Specification: Binary Stock Outcome Markets

**Feature Branch**: `001-binary-outcome-markets`

**Created**: 2026-10-05

**Status**: Draft

**Input**: Build the full product described in `docs/PRD.md` (FR-1…FR-10) — automated daily binary
outcome markets on the MAG7 equities, with pair minting, a central limit order book, guarded
oracle settlement, and redemption.

> Traceability: every requirement below carries the originating PRD requirement in brackets, e.g.
> `[PRD FR-5]`. The PRD is the authoritative statement of partner intent; this spec restates it as
> testable behaviour.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Binary payout is always exactly one dollar (Priority: P1)

A trader puts one dollar into a contract and receives back exactly one dollar in total across the
winning and losing sides, no matter what the stock did. They mint a Yes/No pair for $1.00, hold it
through the close, and after settlement redeem the winning token for $1.00 while the losing token
is worth $0.00. If they still hold both tokens, they can hand back the pair for their $1.00 at any
time, before or after settlement.

**Why this priority**: This is the product's one absolute promise and the partner's headline
metric — 100% of settlements pay the correct side and the dollar invariant is never violated.
Everything else is a way to express a view; this is the thing that makes the view worth money. It
is also the smallest slice that is independently valuable: with only this, a trader can take a
position and be paid correctly.

**Independent Test**: Mint a pair against a seeded market, drive a known closing price, settle, and
redeem. Verify total collateral in equals total payout out, to the base unit, across every outcome
including an exact tie.

**Acceptance Scenarios**:

1. **Given** an open contract "META at or above $680", **When** a trader deposits $1.00, **Then**
   they receive exactly 1 Yes token and 1 No token.
2. **Given** a trader holding 1 Yes and 1 No for the same contract, **When** they redeem the pair
   before settlement, **Then** they receive exactly $1.00 back and both tokens are burned.
3. **Given** a settled contract whose close was $685 against a $680 strike, **When** a Yes holder
   redeems, **Then** they receive $1.00 per token; **And** a No holder redeeming receives $0.00.
4. **Given** a settled contract whose close was exactly $680 against a $680 strike, **When**
   holders redeem, **Then** Yes pays $1.00 and No pays $0.00 — ties resolve to Yes.
5. **Given** any contract at any point in its life, **When** total collateral held is compared to
   outstanding pairs, **Then** they are equal to the base unit.
6. **Given** a settled contract, **When** a winner redeems a week later, **Then** redemption still
   succeeds — redemption never expires.

---

### User Story 2 - Markets appear every morning without anyone touching them (Priority: P2)

Before the US market opens, a full set of tradeable contracts exists for all seven stocks, with
strikes clustered around each stock's previous close, and they are visible and mintable by the
time traders arrive.

**Why this priority**: Without automated creation there is no product to trade, and the partner
grades liveness explicitly: markets created before open and settled within ten minutes of close,
every trading day. It is second only to payout correctness because a market that pays wrong is
worse than a market that is late.

**Independent Test**: Run the daily creation routine against a seeded previous-close price set and
assert the exact strike ladder produced for each ticker, including deduplication.

**Acceptance Scenarios**:

1. **Given** the previous close for META was $680, **When** the morning routine runs, **Then**
   strikes are created at $620, $640, $660, $680, $700, $720 and $740 — seven unique strikes.
2. **Given** the previous close for AAPL was $230, **When** the morning routine runs, **Then**
   after deduplication exactly five unique strikes exist: $210, $220, $230, $240, $250.
3. **Given** the daily routine has run, **When** a trader opens the application before 9:30 AM ET,
   **Then** contracts for all seven stocks are visible and minting is enabled.
4. **Given** the daily routine runs, **When** it completes, **Then** every contract exists and is
   tradeable before the market opens.
5. **Given** the previous-close price for a ticker cannot be read within quality bounds, **When**
   the morning routine runs, **Then** that ticker's markets are not created, the failure is
   reported, and the other six tickers are unaffected.

---

### User Story 3 - Four ways to trade, one order book (Priority: P2)

A trader expresses a bullish or bearish view using plain Buy Yes, Buy No, Sell Yes and Sell No
controls. They never see, and never need to understand, that all four resolve to one book in which
Yes tokens trade against dollars.

**Why this priority**: This is the central architectural idea in the brief and the main surface a
reviewer will judge. It depends on minting (US1) existing, which is why it sits below it.

**Independent Test**: With a seeded book, drive each of the four actions and assert the resulting
token balances, cash movement and resting orders, verifying that Buy No costs exactly one dollar
minus the Yes sale price.

**Acceptance Scenarios**:

1. **Given** a book with Yes offered at $0.65, **When** a trader buys Yes at market, **Then** they
   hold Yes tokens and have paid $0.65 each.
2. **Given** a book with a Yes bid at $0.65, **When** a trader buys No at market, **Then** the
   whole operation completes as a single approval, and they end holding only No tokens at an
   effective cost of $0.35 each.
3. **Given** a trader holding Yes tokens, **When** they sell Yes, **Then** the tokens leave and
   dollars arrive.
4. **Given** a trader holding No tokens, **When** they sell No, **Then** their No exposure is
   closed and the proceeds arrive, without the trader being asked to understand the mechanic.
5. **Given** a trader holding No tokens for a strike, **When** they attempt to buy Yes on that same
   strike, **Then** they are prevented and guided to close the No position first.
6. **Given** two orders at the same price, **When** they are matched, **Then** the earlier order
   fills first.
7. **Given** any resting order, **When** the book changes, **Then** every connected trader sees the
   updated book without reloading.
8. **Given** a trader placing a Buy No limit order, **When** only part of the Yes leg fills,
   **Then** the trader's holdings and the unfilled remainder are both represented accurately, and
   the UI explains the transient state.

---

### User Story 4 - Settlement is correct, timely, and happens once (Priority: P2)

Shortly after the close, every contract for the day resolves against the official closing price,
and traders can see the settlement price and which side won.

**Why this priority**: Equal in importance to the trading surface — it is the moment the product
either keeps or breaks its promise. Separated from US1 because the payout rule can be tested
independently of the automation and guard behaviour.

**Independent Test**: Drive the settlement routine against seeded prices — good, stale, low
confidence, and repeated — and assert resolution, refusal, and idempotency respectively.

**Acceptance Scenarios**:

1. **Given** the market has closed, **When** settlement runs, **Then** every contract for that day
   is resolved within ten minutes of the close.
2. **Given** a resolved contract, **When** a trader views it, **Then** they see the settlement
   price and the winning side.
3. **Given** the price available at settlement time is older than the staleness bound, **When**
   settlement runs, **Then** the contract is **not** settled, the condition is reported, and no
   payout is assigned.
4. **Given** the price available at settlement time fails the confidence/quality check, **When**
   settlement runs, **Then** settlement is refused rather than resolved on a doubtful price.
5. **Given** a contract that has already settled, **When** settlement is attempted again, **Then**
   the attempt has no effect — no second resolution and no second payout.
6. **Given** a contract that attracted no trading at all, **When** settlement runs, **Then** it
   still settles correctly and any minted pairs remain redeemable.
7. **Given** a contract that has not yet settled, **When** a trader attempts to redeem a single
   Yes or No token, **Then** the attempt is refused with a clear reason.

---

### User Story 5 - A trader can see what they own and what they made (Priority: P3)

A trader connects a wallet, sees their cash balance and open positions, and after closing or
settlement sees realized profit and loss.

**Why this priority**: Required for the product to be usable and demonstrable, but no trade
outcome depends on it.

**Independent Test**: Seed a wallet with a known fill history, open the portfolio, and verify the
reported positions and realized P&L against hand-computed values.

**Acceptance Scenarios**:

1. **Given** a connected wallet, **When** the trader opens the application, **Then** they see their
   cash balance and every open position.
2. **Given** a position closed at a known price, **When** the trader views their portfolio,
   **Then** realized P&L reflects entry price against exit price.
3. **Given** a settled contract the trader held, **When** they view it, **Then** the settlement
   price, the outcome, and the resulting payout are all shown.
4. **Given** a trader has no wallet connected, **When** they browse, **Then** they can still see
   markets and prices but cannot trade.

---

### User Story 6 - A market maker can quote both sides (Priority: P3)

A liquidity provider mints pairs, posts resting orders, and monitors exposure and fills in one
place.

**Why this priority**: Without it the books are empty and the demo is thin, but it is a
specialization of capabilities US1 and US3 already provide.

**Independent Test**: Mint pairs, post resting orders across several strikes, drive partial fills,
and verify the dashboard's exposure, fill and P&L figures.

**Acceptance Scenarios**:

1. **Given** a market maker with cash, **When** they mint pairs, **Then** they hold matching Yes
   and No quantities and their cash decreases by one dollar per pair.
2. **Given** minted inventory, **When** they post resting orders, **Then** the orders appear on the
   book at the stated prices.
3. **Given** resting orders that partially fill, **When** they open the dashboard, **Then**
   exposure, fills and P&L reflect the partial fills.

---

### User Story 7 - An operator can adjust the strike ladder (Priority: P4)

An operator adds or adjusts strikes before or during the trading day, for example when a stock
moves far enough that the morning ladder no longer brackets the price.

**Why this priority**: Explicitly required, but an operational nicety relative to everything above.

**Independent Test**: Add a strike mid-session and verify it becomes tradeable and settles with the
rest of the day's contracts.

**Acceptance Scenarios**:

1. **Given** an open trading day, **When** an operator adds a strike, **Then** a contract and book
   are created for it and it is immediately tradeable.
2. **Given** a strike added mid-session, **When** settlement runs, **Then** it settles on the same
   rule and schedule as the morning ladder.
3. **Given** a non-operator, **When** they attempt to add a strike, **Then** the attempt is refused.

---

### Edge Cases

- **Close exactly equals strike** — resolves to Yes under the at-or-above rule. [PRD §3.1]
- **Strike ladder collapses after rounding** — for lower-priced tickers, adjacent percentage
  offsets round to the same level; duplicates are removed rather than creating two identical
  markets. AAPL at $230 yields 5 unique strikes, META at $680 yields 7. [PRD §3.3]
- **Stale price at settlement** — a price older than the staleness bound must block settlement, not
  settle on it. Late settlement is a liveness miss; wrong settlement is a correctness failure.
- **Low-confidence price at settlement** — same treatment: refuse rather than resolve.
- **Repeated settlement attempt** — settling an already-settled contract is a no-op, never a second
  payout.
- **Buy Yes while holding No on the same strike** — refused and redirected to closing the No
  position first; the reverse is equally refused. [PRD FR-8]
- **Partial fill of the Yes leg of a Buy No limit order** — leaves the trader transiently holding
  both tokens; this state must be represented truthfully and explained, not hidden.
- **Redemption before settlement** — a single token cannot be redeemed before resolution, though a
  complete Yes+No pair always can.
- **Zero liquidity at close** — a contract that never traded still settles, and any minted pairs
  remain redeemable.
- **Previous close unavailable in the morning** — that ticker's ladder is skipped and reported,
  without blocking the other six.
- **Trader never redeems** — tokens stay redeemable indefinitely; there is no expiry that forfeits
  a winning position.

## Requirements *(mandatory)*

### Functional Requirements

**Market creation**

- **FR-001**: System MUST create contracts for all seven supported stocks each trading day before
  the market opens. [PRD FR-1]
- **FR-002**: System MUST derive strikes at ±3%, ±6% and ±9% from each stock's previous close,
  rounded to the nearest $10, and MUST make the rounded previous close available as a strike.
  [PRD FR-1, §3.3]
- **FR-003**: System MUST deduplicate strikes that collide after rounding, so that no two contracts
  exist for the same stock at the same strike on the same day. [PRD §3.3]
- **FR-004**: System MUST skip and report any ticker whose previous close cannot be obtained within
  quality bounds, without preventing creation for the remaining tickers.

**Minting, redemption and the invariant**

- **FR-005**: Users MUST be able to deposit exactly one dollar to mint one Yes token and one No
  token for a chosen contract. [PRD FR-2]
- **FR-006**: Users MUST be able to return a complete Yes+No pair for exactly one dollar, at any
  time, whether or not the contract has settled. [PRD FR-2]
- **FR-007**: System MUST hold collateral equal to outstanding pairs at all times, to the smallest
  representable unit, and MUST enforce this at the protocol level rather than relying on the client.
  [PRD FR-2; Constitution I]
- **FR-008**: System MUST carry all monetary values as integer base units; no value on the money
  path may be represented as a floating-point number. [Constitution I]

**Order book and trading**

- **FR-009**: System MUST maintain exactly one order book per contract, in which Yes tokens trade
  against dollars. [PRD FR-3, §3.2]
- **FR-010**: System MUST match orders by price, then by time of arrival at equal prices.
  [PRD FR-3]
- **FR-011**: System MUST reflect book changes to all connected users in real time, without a
  manual refresh. [PRD FR-3]
- **FR-012**: Users MUST be able to Buy Yes, Buy No, Sell Yes and Sell No as four first-class
  actions, each presented in the user's own terms rather than as book mechanics. [PRD FR-4, §3.2]
- **FR-013**: A Buy No market order MUST complete as a single atomic operation requiring exactly
  one user approval, and MUST NOT be capable of leaving the user holding an unintended position.
  [PRD FR-4]
- **FR-014**: A Buy No limit order MUST leave the user holding both tokens until the Yes leg fills,
  and the interface MUST represent that transient state truthfully. [PRD FR-4]
- **FR-015**: System MUST prevent a user from establishing a persistent holding of both Yes and No
  for the same contract, and MUST direct them to close the opposing position first. Holding both is
  permitted only transiently as part of minting or an unfilled Buy No limit order. [PRD FR-8]
- **FR-016**: System MUST display the implied price of the opposite side, derived from the one
  dollar relationship. [PRD §3.1]

**Settlement and redemption**

- **FR-017**: System MUST resolve every contract for the trading day within ten minutes of the
  market close. [PRD FR-5]
- **FR-018**: System MUST resolve a contract as Yes-wins when the closing price is at or above the
  strike, and No-wins otherwise; an exact match resolves as Yes-wins. [PRD FR-5, §3.1]
- **FR-019**: System MUST reject any price used for settlement that exceeds the staleness bound,
  fails the confidence/quality check, or does not originate from an accepted price publisher,
  leaving the contract unsettled and reporting the condition, rather than settling on a doubtful
  price. [PRD FR-5; Constitution IV]
- **FR-020**: System MUST provide a documented, tested fallback source for the settlement price
  when the primary source is unavailable or fails its guards. [Constitution IV]
- **FR-021**: System MUST settle each contract at most once; a repeated settlement attempt MUST
  have no effect. [Constitution IV]
- **FR-022**: Users MUST be able to redeem winning tokens for one dollar each in a single approval,
  with proceeds arriving directly in their own wallet. [PRD FR-6]
- **FR-023**: System MUST keep redemption available indefinitely after settlement. [PRD FR-6]
- **FR-024**: System MUST refuse redemption of a single token before the contract has settled.
- **FR-025**: System MUST display the settlement price and the winning side for every resolved
  contract. [PRD FR-5]

**Portfolio and operations**

- **FR-026**: Users MUST be able to connect a wallet and see their cash balance and open positions.
  [PRD FR-7]
- **FR-027**: System MUST report realized profit and loss on closed positions, computed from entry
  price against exit price. [PRD FR-7]
- **FR-028**: System MUST let a liquidity provider mint pairs, post resting orders, and view
  exposure, fills and P&L in one place. [PRD FR-9]
- **FR-029**: Operators MUST be able to add or adjust strikes before or during the trading day, and
  non-operators MUST NOT. [PRD FR-10]
- **FR-030**: System MUST never take custody of user assets; every change to a user's holdings MUST
  result from a transaction that user authorized. [PRD §2; Constitution III]

### Key Entities

- **Contract**: A binary market for one stock, one strike, one trading day. Knows its underlying
  ticker, strike level, trading day, lifecycle state (created, open, closed, settled), and once
  settled, its settlement price and winning side.
- **Outcome token pair**: The Yes and No tokens issued against a contract. Always created and
  destroyed in pairs against exactly one dollar of collateral.
- **Order**: A user's intent to buy or sell Yes tokens at a price, with a quantity, a time of
  arrival, and a remaining unfilled amount.
- **Order book**: The set of live orders for one contract, organized by price and arrival time.
- **Fill**: A match between two orders, recording price, quantity, time, and the two parties —
  the basis for realized P&L.
- **Position**: A user's net holding in one contract, plus the cost basis needed to report P&L.
- **Price observation**: A price for a ticker at a point in time, carrying the quality signals
  (age, confidence) the system guards on before using it.
- **Strike ladder**: The deduplicated set of strikes generated for one ticker on one trading day.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of settled contracts pay the correct side, verified against the official close
  for every contract across a full simulated trading day, including at-the-strike ties.
- **SC-002**: The one dollar invariant holds for 100% of contracts at every point in their life —
  collateral held always equals outstanding pairs, to the smallest representable unit.
- **SC-003**: Markets for all seven stocks exist and are tradeable before the market opens, on
  every trading day the system runs.
- **SC-004**: All of a day's contracts are settled within 10 minutes of the market close.
- **SC-005**: No contract is ever settled using a price older than 5 minutes or one that fails its
  quality check; such cases are reported as unsettled rather than resolved.
- **SC-006**: A reviewer can reproduce the complete lifecycle — create, mint, trade, settle,
  redeem — from documented scripts, with no manual intervention.
- **SC-007**: A trader can go from connecting a wallet to holding a position in under 2 minutes,
  using one approval for a market Buy Yes and one for a market Buy No.
- **SC-008**: Order book changes are visible to all connected traders within one second, without a
  manual refresh.
- **SC-009**: 0 occurrences of a user establishing a persistent simultaneous Yes and No holding in
  the same contract through the trading interface.
- **SC-010**: Repeated settlement attempts produce 0 duplicate payouts.

## Assumptions

- **Deferred implementation decision — order book mechanism.** Requirements FR-009 to FR-014 are
  deliberately stated as behaviour, not mechanism. Whether the book is built as part of this
  system or an existing on-chain order book is integrated is an implementation decision, resolved
  by a time-boxed spike before planning completes and recorded in `DECISIONS.md`. Nothing in this
  spec should be read as committing to either.
- The seven supported stocks for this version are AAPL, MSFT, GOOGL, AMZN, NVDA, META and TSLA.
- Contracts are same-day expiry only: created in the morning, settled after that day's close. No
  multi-day contracts, no early exercise.
- The settlement asset is a US dollar stablecoin on the deployment network; "one dollar" throughout
  this spec means one unit of that asset.
- The system runs against a test network with test funds throughout. No real funds are used.
- Strike percentage offsets (±3/6/9%) and the $10 rounding increment are fixed for this version,
  though the operator can add strikes manually.
- Trading hours follow the US equity session (9:30 AM – 4:00 PM ET); the system does not open
  markets on non-trading days.
- Price quality bounds — a staleness limit of 5 minutes and a confidence check — come from the
  partner brief and are treated as fixed requirements rather than tunable preferences.
- Users supply their own wallet; the system performs no identity verification and holds no user
  accounts.
- Realized P&L is computed from the user's own fills and settlements within this system; it is not
  a tax-grade cost basis across venues.

## Dependencies

- An external price source that can supply each ticker's previous close and that day's official
  close, readable at settlement time, and carrying age, confidence and origin signals the system can
  guard on. A documented fallback source is required (FR-020).
- A US dollar stablecoin on the deployment network, used as collateral and settlement asset.
- User-controlled wallets capable of signing transactions on the deployment network.
- A deployment network offering sub-second transaction finality, fast enough to support real-time
  order book trading.
