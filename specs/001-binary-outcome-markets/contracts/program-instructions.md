# Contract: `meridian` program instructions

Maps the PRD §5.1 required functions and the trading paths to Anchor instructions. Signers and
account roles are listed; exact account lists are generated from the IDL during implementation.

| PRD §5.1 function | Instruction | Signer | Preconditions | Effect |
|---|---|---|---|---|
| Initialize Config | `initialize_config(args)` | admin (payer) | config PDA absent | creates `Config` |
| — | `update_config(args)` | admin | — | changes provider, allowlist, thresholds, tickers, pause-independent |
| Create Strike Market | `create_market(ticker, strike, trading_day, close_ts, capacity)` | admin | `close_ts > now`; ticker enabled; market PDA absent | creates Market, two mints, vault, Book + two escrows; emits `MarketCreated` |
| Add Strike | `add_strike(…)` | admin | same as above; allowed after open and before `close_ts` | same as `create_market` (separate name so the PDF's function exists by name) |
| Mint Pair | `mint_pair(qty)` | user | not paused; `Open` | USDC in, Yes+No out; emits `Minted` |
| — | `redeem_pair(qty)` | user | any state | Yes+No in, USDC out; emits `PairRedeemed` |
| Settle Market | `settle_market()` | anyone (service in practice) | `now ≥ close_ts`; `Open`; price account passes provider guards | writes outcome; emits `Settled` |
| Admin Settle (Override) | `admin_settle_override(price)` | admin | `Open`; `now ≥ close_ts + delay` | writes outcome with `by_override`; emits `Settled` |
| Redeem | `redeem_winning(side, qty)` | user | `Settled`; `side == outcome` | burns, pays $1 per token; emits `WinningRedeemed` |
| Pause / Unpause | `pause()`, `unpause()` | admin | — | flips `Config.paused`; emits event |
| (book) | `place_order(side, price, qty, tif)` | user | not paused; `Open` | escrow, match ≤ 8 fills, rest or refund; emits `OrderPlaced`, `Fill`* |
| (book) | `cancel_order(order_id)` | owner | any state | refund escrow; emits `OrderCancelled` |
| (book) | `buy_no_market(qty, min_yes_price)` | user | not paused; `Open` | mint, sell Yes IOC, redeem unfilled pairs; user ends with only No |
| (book) | `buy_no_limit(qty, price)` | user | not paused; `Open` | mint, post Yes ask |
| (book) | `sell_no_market(qty, max_yes_price)` | user | not paused; `Open` | buy Yes IOC, redeem pairs |
| (oracle) | `mock_write_price(feed_id, price, conf, expo, publish_time)` | allowlisted publisher | provider `MockPyth`; publisher in allowlist | upserts `MockPriceUpdate` |
| (rent) | `close_book()`, `close_market()` | admin | `Settled`; empty | returns rent |

`tif` is `Limit | ImmediateOrCancel`.

## Error codes (minimum set)

`Paused`, `MarketSettled`, `MarketNotSettled`, `BeforeClose`, `AlreadySettled`, `OverrideTooEarly`,
`Unauthorized`, `PublisherNotAllowed`, `OracleOwnerMismatch`, `OracleFeedMismatch`,
`OracleStale`, `OracleTooOld` (publish before `close_ts − offset`), `OracleLowConfidence`,
`OracleBadPrice`, `OracleVerificationLevel`, `BookFull`, `PriceOutOfRange`, `ZeroQuantity`,
`WrongSide`, `InsufficientFill` (IOC min price not met), `NotEmpty`, `InvariantViolated`.

## Invariant checks executed in code

After every `mint_pair`, `redeem_pair`, `redeem_winning`: assert the vault equation from
`data-model.md` and fail with `InvariantViolated` if it does not hold. This is the on-chain form of
Principle I and PRD §5.2, in addition to tests.
