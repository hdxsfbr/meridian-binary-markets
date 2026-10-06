# Contract: frontend pages (PRD §5.4, FR-011…FR-016, FR-025…FR-028)

Next.js 16 App Router, one route per PRD page. Copy is end-user copy only; no implementation notes,
provider names, or "simulated" asides anywhere on these pages (global rule). Operator diagnostics live
on `/admin`, which is not linked from product navigation.

| Route | PRD page | Shows | Actions | Data source |
|---|---|---|---|---|
| `/` | Landing | what a contract is, the payoff line, live prices for the 7 tickers, connect wallet | connect | prices from the latest on-chain quote per ticker; markets from `Market` accounts |
| `/markets` | Markets | 7 ticker cards: price, change, count of today's open contracts, time to close | pick ticker | `getProgramAccounts` filtered by `trading_day` |
| `/trade/[ticker]` | Trade | strike list with Yes/No prices and implied probability; order book from Yes and No perspectives; countdown to 16:00 ET; trade panel | Buy Yes, Buy No, Sell Yes, Sell No (market or limit), cancel | `Book` websocket subscription (R10) |
| `/portfolio` | Portfolio | USDC balance, open positions with cost basis, settled outcomes with settlement price and payout, realized P&L; market-maker view of resting orders, exposure and fills | redeem winning, redeem pair, cancel order, mint pairs | wallet token accounts + events (R11) |
| `/history` | History | execution log for the wallet: mints, fills, cancels, settlements, redemptions | — | events (R11) |
| `/admin` | — | config, pause state, unsettled markets with the refusal reason, override form (disabled until the delay elapses) | pause/unpause, add strike, override | `Config`, `Market` accounts |

## Trade panel rules (FR-012…FR-016)

- Four buttons. Buy No and Sell No never expose the mint-and-sell mechanic in copy. Payoff line:
  "You pay $X. You win $1.00 if META closes at or above $680."
- Position gating (FR-015, SC-009): if the wallet holds No for the strike, Buy Yes is replaced by
  "Close your No position first" with a one-tap Sell No; and symmetrically. Liquidity-provider minting
  on `/portfolio` is exempt, and the panel shows a pair as "Minted pair" rather than as two positions.
- Buy No limit shows the resting Yes ask as "Pending" on the position, with the No held and the Yes
  resting until filled (FR-014).
- Implied opposite price is `$1.00 − price` everywhere a price is shown (FR-016).
- Paused state: Buy/Sell and Mint controls disabled with "Trading is paused"; Redeem controls remain
  enabled (FR-034).
- Settled contract: shows settlement price and winning side (FR-025) and a Redeem button for winners.
- Awaiting settlement (after 16:00, before the outcome): "Settlement pending" with no reason code.

## Translation layer (unit-tested, `packages/sdk/src/intent.ts`)

```ts
type Intent = { action: "buyYes" | "buyNo" | "sellYes" | "sellNo"; kind: "market" | "limit"; qty: u64; price?: u64 };
function toInstruction(intent: Intent, position: Position, book: BookSnapshot): InstructionPlan | GuidanceError;
```

Tests cover each of the four actions × market/limit, the position-gating refusals, the Buy No
market cost `qty × (1 − bestBid)`, and the partial-fill representation.

## Smoke flows (Playwright, injected test wallet)

1. connect wallet → see balance; 2. place a limit Buy Yes → appears in book without reload;
3. Buy No market → holds only No; 4. settled market → redeem → balance increases;
5. paused → trade disabled, redeem enabled.
