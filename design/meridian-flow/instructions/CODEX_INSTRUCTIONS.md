# Codex implementation brief: Meridian Flow UI revamp

## Objective
Restyle the **existing** Meridian React/Next.js application according to `../BRAND.md`, `../tokens/design-tokens.css`, and `../references/trading-dashboard.png`. The PNG is a **directional design mockup**, not a pixel-perfect requirement.

## Mandatory process
1. Inspect the repository first: pages/routes, component library, styling solution, state management, wallet + transaction plumbing, tests. Do not replace the working app wholesale.
2. Establish the shared token layer (CSS variables or equivalent theme mapping) and responsive layout primitives; keep dark theme default. Add a light theme only if existing app supports it or if straightforward.
3. Use actual SVG logo assets from `logos/`; do not regenerate logos with emojis, Unicode glyphs, CSS approximations or screenshot crops.
4. Implement/redesign navigation, Markets overview, individual stock/strike Trade view, order book, trade panel, Portfolio, History, and settlement/redeem affordances as they exist in the app. Do not invent unsupported backend capabilities.
5. Apply consistent states: loading/skeleton, empty book, zero balance, disconnected wallet, stale oracle, invalid order, pending wallet signature, network failure, market closed, settled, redeemable, already redeemed.
6. Test responsive layout (1440px / 1024px / 390px); avoid horizontal page overflow. Dense tables may scroll *within* their container on mobile.
7. Run project lint, typecheck and tests; validate flows manually or through existing E2E tests. Report results and known gaps. If browser preview is available, compare screenshots to the design reference and refine.

## Critical functional invariants — preserve intact
- MAG7: AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA.
- Contracts settle based on close being **at or above** strike for Yes; below for No.
- Exactly one underlying Yes/USDC order book per strike, with No derived from complementary pricing, not a second independent book.
- Yes payout + No payout = $1 USDC. Do not alter contracts, minting, settlement, oracle validation, or order routing in a design-only task.
- Retain Buy Yes, Buy No, Sell Yes, Sell No actions, position restrictions, mint/sell or buy/redeem mechanics as implemented. UI must not silently change trade semantics.
- Handle wallet-signing confirmation carefully; show estimated cost, number of contracts, fees if known, possible $1 payout per winning unit, and clear settlement status.
- Avoid hardcoded prices or placeholder positions in production logic. Mock numbers belong only to dev fixtures and the supplied design reference.

## UI direction
- Primary backdrop midnight `#0B1026`; surfaces `#111B35` / `#182440`; semantic borders `#293654`.
- Brand gradient `#A855F7 → #6366F1 → #22D3EE` for identity and accents.
- Buy Yes teal `#2DD4BF`, Buy No rose `#FB7185`. These are directional semantic roles, **not** generic profitability colors.
- Price rows: tabular numbers, right alignment, stable column widths; focus on readability/latency indicators.
- Wallet CTA and primary confirmation action use indigo, not overbright rainbow gradient.
- Keep navigation restrained; make strike list, probabilities, 4:00 PM ET countdown, orderbook and place-trade panel visually obvious.

## Deliverables in code
- Shared theme tokens and any necessary font setup.
- Responsive consistent app chrome.
- Existing pages re-skinned; component styles consolidated instead of repeated magic values.
- Asset imports wired to real SVGs (copy from kit to public assets as needed).
- Updated tests where presentation changes require it; no changes to business semantics.
- Before/after screenshots when possible and concise implementation notes.

## Done criteria
Feature parity retained; trading data remains sourced from existing hooks/API; no wallet or smart-contract regressions; accessible labels and keyboard navigation; no mobile overflow; checks pass or exceptions documented.
