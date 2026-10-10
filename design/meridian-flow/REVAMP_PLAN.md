# Meridian UI revamp — plan (2026-10-08)

Inputs: `BRAND.md`, `tokens/design-tokens.css`, `references/trading-dashboard.png` (directional),
`instructions/CODEX_INSTRUCTIONS.md`, and `references/inspiration/` (Kalshi, Polymarket screenshots).
Constraint from the brief: restyle the existing app; no change to trade semantics, hooks or program.

## What the references teach, mapped to Meridian

| Pattern seen in Kalshi / Polymarket | Meridian equivalent |
| --- | --- |
| "Price to beat" next to "Now", with a live delta | Strike vs live Pyth price on every strike row and in the trade header |
| Countdown on every card, red when close | Countdown to 4:00 PM ET on ticker cards and trade header |
| Two coloured outcome buttons carrying the probability ("Up 39%") | Yes / No buttons showing best price and implied probability ("Yes 60¢ · 60%") |
| Payout multiple beside each outcome ("2.7x") | $1.00 / price, e.g. "1.67x" beside Yes |
| Market list as cards with 2-3 outcome rows each | Ticker card lists the 3 nearest strikes with Yes/No prices; "View all 7" expands |
| Hero card for the featured market on category page | Markets page opens with the ladder nearest the money for the most active ticker |
| Order panel: amount presets, cost, est. payout, one primary button | Trade panel: qty presets (1 / 5 / 10 / max), "You pay" and "You win if right" lines, one indigo primary |
| Chart with target line | Intraday price sparkline with the strike as a dotted line (Pyth price from `/api/prices`, sampled client-side; no history API needed) |
| Left rail of filters by horizon and asset | Not needed: one horizon (today), seven tickers; keep a top ticker strip instead |
| Live chat, leverage, perps | Out of scope |

Kept from our own reference mockup: midnight canvas, surfaces, the compact bid/size/ask order book
with monospace tabular numbers, Yes teal / No rose used as side labels with text and icons, indigo
for wallet and primary actions.

## Scope, in waves

**Wave R1 — theme and chrome (foundation).** Token layer as Tailwind theme variables from
`design-tokens.css`; Inter + IBM Plex Mono; dark default, `data-theme="light"` optional; real SVG
logo in the nav from `logos/`; nav with ticker strip, wallet button in indigo; app-wide states
(loading skeletons, empty, disconnected, paused, network error) as shared components.

**Wave R2 — Markets page.** Ticker cards per the table above: name, live price with delta since
previous close, countdown, the three nearest strikes with Yes/No prices and implied probability,
"open contracts" count. Featured ladder at the top. Settled markets collapse into a "Settled today"
strip with outcomes.

**Wave R3 — Trade page.** Header: ticker, live price, countdown, "closes at 4:00 PM ET". Strike
table with price-to-beat vs now, Yes/No with probability and payout multiple, highlighted
at-the-money row. Sparkline with strike line. Order book compact and monospace. Trade panel: Yes/No
toggle in side colours, Market/Limit, qty presets, cost / payout / locked lines, single primary
button, gated and disabled states with reasons (as today). Open orders table.

**Wave R4 — Portfolio and History.** Position rows as cards with day label, state badge, redeem
actions; realized P&L separated from side colours; maker panel restyled, exposure table as a real
table; History rows with market, amount and explorer link, grouped by day.
*Redeem all (Andre, 2026-10-08):* after settlement, a banner on every page, "You have $X to
collect", with one **Redeem all** button that batches every winning position and every held pair
into a single transaction (one signature). Self-custody stays as in FR-6; this only removes the
hunting. Needs a small SDK helper that builds the instruction list from the wallet's positions.

**Wave R4b — Docs tab.** A `Docs` entry in the nav and a `/docs` section rendered from markdown
files kept in the repo (`web/content/docs/*.md`, one per page, with a left sidebar on desktop and a
dropdown on mobile). User-facing only, written for a trader, not for a reviewer of the code:
- *Quick start*: wallet on devnet, free SOL and USDC, connect, first trade, where to see it settle.
- *How contracts work*: Yes/No, $1.00 payout, "at or above" tie rule, implied chance, 4:00 PM ET close.
- *Trading*: market vs limit, Buy/Sell Yes/No, what "You pay" and "Reserved" mean, position rule.
- *Market making*: minting pairs, quoting, exposure, cancelling.
- *Settlement and redemption*: where the closing price comes from (Pyth), checks it must pass, override, how to redeem.
- *Portfolio and history*: balances, cost basis, realized P&L, explorer links.
- *FAQ and limits*: devnet-only, no real funds, rate limits, what to do when something looks stale.
Developer docs stay in `docs/` and the README; the Docs tab links out to the repo for those.

**Wave R5 — Admin, responsive, accessibility.** (done 2026-10-08; indigo token darkened to #4f52e8 for AA on white text, light-mode cyan set to #0e7490) Admin restyled; 1440 / 1024 / 390 passes; keyboard
focus ring (cyan); contrast check (WCAG AA) on every text/background pair actually used; reduced
motion; Playwright flows updated for new labels only where copy changed.

## Decisions (Andre, 2026-10-08)
1. Dark only for now. Build the token layer so light is a `data-theme` switch away: every colour via
   CSS variables, no hard-coded hex in components, the light block from `design-tokens.css` kept.
2. Sparkline in the first pass (R3).
3. Probability = best ask, labelled "to buy Yes".
4. Strip developer-facing copy from the UI while restyling (see the audit list below).

## Review loop
Same as the build waves: Codex headless review per wave scoped to the wave's files, one Sonnet fix
pass, commit, stop for Andre. Screenshots before/after per page in `design/meridian-flow/after/`.

## Copy audit: developer language visible today (to fix in the matching wave)

| Where | Today | Proposed |
| --- | --- | --- |
| Admin config card | "Mock Pyth (devnet simulation)", "Max confidence (bps)", "Max staleness", "Min publish offset", "Override delay" | "Price source: Pyth" / "Price source: test publisher"; move the four guard numbers into a collapsed "Settlement checks" block with plain labels ("Price no older than 5 min", "Confidence within 0.25%", "Published at or after close", "Override allowed 1 h after close") |
| Portfolio | "Syncing history…", "Partial history", "Cost basis and P&L: syncing history…" | One quiet status line: "Updating your trade history…"; drop "Partial history" unless incomplete after sync, then "Older activity still loading" |
| Maker panel | "Exposure, fills and resting totals", "Exposure (Yes − No)", "Pairs held", "Fills", "Resting: x bid / y ask", "Quote resting orders", "No resting exposure yet", "No resting orders" | "Your quotes" section: "Net Yes", "Pairs", "Trades", "Open: x buys / y sells"; "Place quotes"; "No quotes yet"; "No open quotes" |
| Trade panel | "(1 fill)", "(2 fills)" on estimates | Drop the fill count; keep "You pay $0.60" (fills matter only to makers; the book shows depth) |
| Trade panel | "You hold No and have a resting order waiting to fill." | "You hold No. Your Buy No order is still open." |
| Trade panel | "This would trade against your own resting order. Cancel it first." | "This would match your own open order. Cancel it first." |
| Open orders | "Remaining", "Locked" column headers | "Open qty", "Reserved" |
| Trade header | "Implied probability" | "Chance", with "to buy Yes" sub-label on the price column |

Rule (from `~/.claude/CLAUDE.md`): no implementation commentary in product copy. "Resting",
"fill", "escrow", "mock", "devnet", "bps", "staleness" are all implementation words.

## Follow-up found during R4 (2026-10-08): history sync time grows with program history

The Portfolio/History pages rebuild cost basis from every transaction the program has ever
emitted (one `getTransaction` per signature, paced at 200 ms on the private RPC). After one full
devnet day that is about 600 transactions, so a browser with an empty cache needs roughly three
minutes before cost basis and History appear; the cache then makes later visits incremental.
Positions, balances and trading do not wait on it. Options, cheapest first: raise the pace on the
private RPC (Helius allows 10 req/s, we use 5); have the automation worker keep the event index
and serve it from its status server (`/events?wallet=…`) so the browser downloads one JSON instead
of replaying the chain; or index by wallet. Not part of the restyle waves.

## Polish list (2026-10-09, after the second settlement day)

- Settled winning rows show "Collect $X" next to Redeem winning so a winner does not read as a loss
  before redemption (the Buy No path books the sold Yes half against its $0.50 share, so the row
  shows a small negative realized P&L until the $1.00-per-token redemption lands). Andre, 2026-10-09.
- Markets cards: show only the at-the-money row by default with "N more strikes" expanding the
  ladder (Kalshi-style collapse). Offered 2026-10-09, not yet approved. **Done 2026-10-10:**
  `TickerCard` collapses to the at-the-money row with an accessible "N more strikes" / "Show fewer"
  toggle, remembered per ticker in sessionStorage; the featured ladder stays fully expanded.
- Worker: raise the transaction confirmation timeout from 30 s to about 90 s (settlement on
  2026-10-09 needed nine retries because devnet confirmations exceeded 30 s). **Done 2026-10-10:**
  set `confirmTransactionInitialTimeout: 90_000` on the `Connection` in both the automation
  service and `scripts/lib/client.ts` (the actual 30 s wait came from `@solana/web3.js`'s legacy
  `confirmTransaction` fallback that Anchor's `.rpc()` hits, which that option raises).
- Token logo in wallets: give each new mint a metadata URI pointing at a JSON file served by the
  app (name, symbol, image = the Meridian mark as PNG) so Phantom shows the logo instead of a
  "MERI" placeholder. Needs a URL we keep stable (the Railway address for the demo); program
  change in create_market plus a small web route. Andre, 2026-10-10.
