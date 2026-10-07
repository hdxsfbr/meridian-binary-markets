# Data Model: Binary Stock Outcome Markets

All money is `u64` in USDC micro-units (6 decimals). Prices of Yes tokens are micro-USDC per token in
`1..=999_999`. Strikes and settlement prices are micro-USD (`u64`). Timestamps are Unix seconds (`i64`).
No floats anywhere on the money path (FR-008).

## On-chain accounts (program `meridian`)

### Config — PDA `["config"]`, singleton

| Field | Type | Notes |
|---|---|---|
| admin | Pubkey | operator authority for admin instructions |
| paused | bool | FR-034; blocks mint and order placement, never redemption |
| usdc_mint | Pubkey | Circle devnet USDC by default (R6) |
| oracle_provider | enum `{ MockPyth, PythReceiver }` | DECISIONS §4; selects the parser in `settle_market` |
| oracle_program | Pubkey | owner required of the price account: this program (mock) or Pyth receiver |
| publishers | [Pubkey; 4] + len | allowlist of mock publisher signers (Principle IV) |
| max_staleness_secs | u32 | 300 |
| max_conf_bps | u16 | confidence guard: `conf × 10_000 ≤ price × max_conf_bps`; default 25 |
| min_publish_offset_secs | u32 | price `publish_time ≥ close_ts − offset`; default 60 (R4, probe may adjust) |
| override_delay_secs | u32 | 3600 minimum enforced in code regardless of config (FR-033) |
| tickers | [TickerInfo; 7] | `symbol: [u8; 8]`, `feed_id: [u8; 32]`, `enabled: bool` |
| default_book_capacity | u16 | 16 demo scale, 128 default |
| bump | u8 | |

Validation: `override_delay_secs ≥ 3600`; `max_staleness_secs ≤ 300`; `publishers.len ≥ 1` when
provider is `MockPyth`; `oracle_program` must equal the program ID when provider is `MockPyth`.

### Market — PDA `["market", ticker_symbol, trading_day_le_u32, strike_le_u64]`

| Field | Type | Notes |
|---|---|---|
| ticker | [u8; 8] | |
| strike | u64 | micro-USD, multiple of $10 for generated strikes; any value for `add_strike` |
| trading_day | u32 | YYYYMMDD, display and seeds |
| close_ts | i64 | 16:00:00 ET of trading_day, computed off chain (R9) |
| state | enum `{ Open, Settled }` | |
| outcome | enum `{ Unset, Yes, No }` | immutable once set (FR-036) |
| settlement_price | u64 | micro-USD; 0 until settled |
| settled_at | i64 | |
| settled_by_override | bool | FR-033 |
| yes_mint, no_mint | Pubkey | SPL mints, 6 decimals, authority = market PDA |
| vault | Pubkey | USDC token account owned by market PDA |
| book | Pubkey | `Pubkey::default()` until `create_book` finishes |
| book_capacity | u16 | per-side capacity `create_book` builds `book` at; set from `create_market`'s/`add_strike`'s `capacity` arg so `create_book` (which takes no `capacity` argument of its own) always builds against the value the market was created with |
| pairs_outstanding | u64 | tokens; while `Open`: `vault.amount == pairs_outstanding × 1_000_000` (FR-007). After settlement the field is frozen and informational; the live invariant becomes `vault.amount == winning_supply × 1_000_000`, and `close_market` requires the vault empty |
| bump, vault_bump | u8 | |

State transitions: `Open → Settled` via `settle_market` or `admin_settle_override`; no other
transition. `Settled` markets refuse mint, place_order, buy_no_*, sell_no_market; they allow
`redeem_pair`, `redeem_winning`, `cancel_order`, and (admin, when empty) `close_book` / `close_market`.

### Book — PDA `["book", market]`, program-owned, variable size

Header (fixed, little-endian), 120 bytes after the 8-byte discriminator:

| Field | Type |
|---|---|
| market | Pubkey |
| usdc_escrow | Pubkey |
| yes_escrow | Pubkey |
| next_order_id | u64 |
| next_seq | u64 |
| capacity | u16 |
| bid_count | u16 |
| ask_count | u16 |
| (padding) | 2 bytes |

Body: `capacity` bids then `capacity` asks, each an `Order` (64 bytes):

| Field | Type | Notes |
|---|---|---|
| id | u64 | user-facing cancel handle |
| owner | Pubkey | |
| price | u64 | micro-USDC per Yes |
| remaining | u64 | tokens |
| seq | u64 | arrival order; tie-break at equal price (FR-010) |

Invariants: bids sorted by `(price desc, seq asc)`, asks by `(price asc, seq asc)`; sum of
`price × remaining` over bids equals `usdc_escrow.amount`; sum of `remaining` over asks equals
`yes_escrow.amount`. A full side rejects a new resting order (`BookFull`) rather than evicting.

### MockPriceUpdate — PDA `["mock_price", feed_id]`, provider `MockPyth` only

| Field | Type | Notes |
|---|---|---|
| feed_id | [u8; 32] | matches `TickerInfo.feed_id` |
| price | i64 | same scale as Pyth: `price × 10^expo` |
| conf | u64 | from source disagreement (R12) |
| expo | i32 | |
| publish_time | i64 | |
| publisher | Pubkey | must be in `Config.publishers` at write time; checked again at settle |
| write_slot | u64 | |

Mirrors the fields the program reads from Pyth's `PriceUpdateV2` (`PriceFeedMessage`), so the
provider adapter returns the same `OracleQuote` from either.

### OracleQuote — in-memory, not stored

`{ price: i64, conf: u64, expo: i32, publish_time: i64 }` → normalised to `price_micro_usd: u64`
and `conf_micro_usd: u64` with checked arithmetic; negative or zero price refuses.

## Events

| Event | Fields |
|---|---|
| MarketCreated | market, ticker, strike, trading_day, close_ts |
| Minted | market, user, qty |
| PairRedeemed | market, user, qty |
| OrderPlaced | market, order_id, owner, side, price, qty |
| OrderCancelled | market, order_id, owner, remaining_refunded |
| Fill | market, maker_order_id, maker, taker, side_of_taker, price, qty, ts |
| Settled | market, price, outcome, by_override, ts |
| WinningRedeemed | market, user, side, qty, payout |
| Paused / Unpaused | admin, ts |

`Fill` is the basis for realized P&L (R11).

## Off-chain entities

### Strike ladder (service)

`{ ticker, trading_day, previous_close_micro_usd, strikes: u64[] }` where strikes are
`round10(prev × (1 ± 0.03 | 0.06 | 0.09))` plus `round10(prev)`, deduplicated, sorted (FR-002,
FR-003). Pure function, unit-tested against the META/AAPL examples in the spec.

### Price observation (service)

`{ ticker, source: "finnhub" | "nasdaq" | "pyth", price, observed_at, conf? }`. Two observations
produce one `MockPriceUpdate` write; absence of either produces no write.

### Position and P&L (web, derived)

From the wallet's `Minted`, `Fill`, `PairRedeemed`, `WinningRedeemed`, `Settled` events:
`{ market, yes_qty, no_qty, cost_basis_micro, realized_pnl_micro }`. Entry price for a No position is
`1_000_000 − yes_fill_price`.

## Validation rules carried into instructions

- `mint_pair(qty)`: `qty > 0`; transfers `qty × 1_000_000` USDC; mints `qty` Yes and `qty` No;
  `pairs_outstanding += qty`. Refused when paused or settled.
- `redeem_pair(qty)`: burns `qty` of each; returns `qty × 1_000_000`; allowed in any state, paused or
  not (FR-006, FR-034).
- `settle_market`: `now ≥ close_ts` (FR-031); state `Open` (FR-021 idempotency: a second call fails
  with `AlreadySettled`, which the service treats as success); provider guards per
  `contracts/oracle-provider.md`; outcome `Yes` iff `price ≥ strike` (FR-018).
- `admin_settle_override(price)`: admin signer; state `Open`; `now ≥ close_ts + max(override_delay,
  3600)`; sets `settled_by_override = true`.
- `redeem_winning(side, qty)`: state `Settled`; `side == outcome`; burns `qty`; pays
  `qty × 1_000_000`; `pairs_outstanding` is frozen; the post-settlement invariant is
  `vault.amount == winning_supply × 1_000_000`.
- `place_order`: not paused, not settled; price in range; `qty > 0`; escrow transferred before
  matching; at most 8 fills; remainder rests (limit) or refunds (IOC).
- `cancel_order(id)`: owner signer; refunds escrow; allowed when paused or settled.
- `pause` / `unpause`: admin signer.
- `close_book`, `close_market`: admin; settled; counts zero and escrows empty; vault empty for
  `close_market`; rent returned to the admin (DECISIONS §6).
