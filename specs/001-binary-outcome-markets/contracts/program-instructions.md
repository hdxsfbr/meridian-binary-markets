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

## Split note: `create_book` (Wave 2, 2026-10-06)

`create_market`/`add_strike` create the Market PDA, the Yes/No mints, the vault, and the
USDC/Yes escrows, but **not** the Book: Solana limits how much any one account's data
length may grow within a single transaction to `MAX_PERMITTED_DATA_INCREASE` (10,240
bytes), enforced identically for a CPI `system_program::create_account` and a direct
`AccountInfo::resize`. `book_space(capacity)` (`128 + 128 * capacity`) exceeds that for
capacity above ~79, and 128 (the non-demo default book capacity) needs 16,512 bytes, so
creating it inside `create_market`'s own transaction would fail outright for any
capacity most markets would actually use. `create_book()` is a separate, idempotent instruction instead: call it repeatedly (each
call is its own transaction, so each gets a fresh 10,240-byte budget) until `Market.book`
is no longer `Pubkey::default()`. It takes **no `capacity` argument**: `create_market`/
`add_strike` record the requested capacity on `Market.book_capacity` (data-model.md
"Market"), and `create_book` reads that field instead, so a call with a mismatched
capacity can't start a second, differently sized book for the same market. Calling
`create_book` again after `Market.book` is already set re-validates the existing Book
account (address, owner, data length, header) and returns `Ok(())` as a no-op rather than
erroring, so a client retrying a call whose confirmation it missed doesn't need to
special-case "already done." The test harness's `create_market` helper calls both
`create_market`/`add_strike` and then `create_book` in a loop automatically.

## Invariant checks executed in code

After every `mint_pair`, `redeem_pair`, `redeem_winning`: assert the vault inequality from
`data-model.md` (`vault.amount >= pairs_outstanding × 1_000_000` while `Open`, or
`vault.amount >= winning_mint.supply` once `Settled`) and fail with `InvariantViolated` if it does
not hold. The vault holds at least the backing it must; surplus from unsolicited transfers (e.g. a
stray direct deposit into the vault token account) is ignored by the check and is never paid out --
redemptions always pay exactly the documented amount regardless of any surplus. This is the on-chain
form of Principle I and PRD §5.2, in addition to tests.
