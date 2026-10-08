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

**Wave R5 — Admin, responsive, accessibility.** Admin restyled; 1440 / 1024 / 390 passes; keyboard
focus ring (cyan); contrast check (WCAG AA) on every text/background pair actually used; reduced
motion; Playwright flows updated for new labels only where copy changed.

## Decisions to make before R1
1. Dark-only or dark + light toggle? (Recommendation: dark-only for the demo; tokens keep light ready.)
2. Sparkline: in or out for the first pass? (Recommendation: in R3 only if R1-R2 land on schedule.)
3. Probability display: show best ask as "60%" (today) or midpoint of bid/ask? (Recommendation: keep best ask; label it "to buy Yes".)

## Review loop
Same as the build waves: Codex headless review per wave scoped to the wave's files, one Sonnet fix
pass, commit, stop for Andre. Screenshots before/after per page in `design/meridian-flow/after/`.
